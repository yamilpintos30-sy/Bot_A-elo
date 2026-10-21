/**
 * Separación de carnets con Claude en el sandbox de ejecución de código.
 *
 * Flujo:
 *   1. Se sube el PDF a la Files API (expira solo en 1 hora).
 *   2. Opus lo ve (bloque "document") y lo procesa con código en un contenedor
 *      aislado (bloque "container_upload"): recorta cada carnet a su propio PDF
 *      y escribe manifest.json.
 *   3. Se descargan las salidas y se borran todos los archivos de la Files API:
 *      son datos personales y no tienen por qué quedar guardados.
 *
 * El resultado NO se carga directo: pasa por la verificación independiente
 * (verifier.ts) y por los controles sin IA (review.ts).
 */
import { toFile } from "@anthropic-ai/sdk";
import type { Logger } from "../utils/logger.js";
import { ClaudeError, type BetaMessage, type BetaParams, type ClaudeRunner, type UsageTotals } from "./claudeRunner.js";
import { manifestSchema, type Manifest } from "./manifest.js";
import { EXTRACCION_PROMPT } from "./prompts.js";

/** Cuántas veces se retoma un turno pausado (el sandbox corta cada ~10 pasos). */
const MAX_CONTINUACIONES = 8;

export interface ExtractionOptions {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface ExtractionResult {
  manifest: Manifest;
  /** PDFs recortados, por nombre de archivo. */
  archivos: Map<string, Buffer>;
  /** Listado: imagen ampliada de la fila de cada registro, por nombre del PDF (sólo para verificar). */
  recortes: Map<string, Buffer>;
  /** Última respuesta de texto del modelo (para el registro). */
  notaModelo: string;
}

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

export class CarnetExtractor {
  constructor(
    private readonly runner: ClaudeRunner,
    private readonly opts: ExtractionOptions,
    private readonly logger: Logger,
  ) {}

  async extract(pdf: Buffer, filename: string, usage: UsageTotals): Promise<ExtractionResult> {
    const files = this.runner.client.files;
    const uploaded = await files.upload({
      file: await toFile(pdf, safeName(filename), { type: "application/pdf" }),
      expires_in_seconds: 3600,
    });
    const toDelete = [uploaded.id];

    try {
      const messages: BetaParams["messages"] = [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "file", file_id: uploaded.id } },
            { type: "container_upload", file_id: uploaded.id },
            { type: "text", text: "Procesá este PDF de carnets siguiendo las instrucciones." },
          ],
        },
      ];

      const responses: BetaMessage[] = [];
      let containerId: string | undefined;
      for (let i = 0; ; i++) {
        const response = await this.runner.run(
          {
            model: this.opts.model,
            max_tokens: 64000,
            thinking: { type: "adaptive" },
            output_config: { effort: this.opts.effort },
            tools: [{ type: "code_execution_20260521", name: "code_execution" }],
            // Costo: el sandbox trabaja en varios pasos y en cada uno relee todo
            // el contexto (PDF incluido). Las instrucciones fijas van en `system`
            // con su propio punto de caché (iguales para todos los PDF) y el
            // caché automático cubre lo que crece en cada paso.
            system: [{ type: "text", text: EXTRACCION_PROMPT, cache_control: { type: "ephemeral" } }],
            cache_control: { type: "ephemeral" },
            messages,
            ...(containerId ? { container: containerId } : {}),
          },
          usage,
          "carga: separar carnets (sandbox)",
        );
        responses.push(response);
        containerId = response.container?.id ?? containerId;
        const u = response.usage;
        if (u) this.logger.debug({ paso: i + 1, stop: response.stop_reason, entrada: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), salida: u.output_tokens }, "Paso de extracción");
        if (response.stop_reason !== "pause_turn") break;
        if (i >= MAX_CONTINUACIONES) throw new ExtractionError("El procesamiento del PDF no terminó dentro del límite de pasos.");
        // Turno pausado: se reenvía tal cual y el servidor lo retoma.
        messages.push({ role: "assistant", content: response.content });
      }

      const last = responses[responses.length - 1]!;
      if (last.stop_reason === "max_tokens") throw new ExtractionError("La respuesta del modelo se cortó (max_tokens).");

      const fileIds = [...new Set(responses.flatMap((r) => collectOutputFileIds(r.content)))];
      toDelete.push(...fileIds);
      const archivos = new Map<string, Buffer>();
      for (const id of fileIds) {
        const meta = await files.retrieveMetadata(id);
        const res = await files.download(id);
        archivos.set(safeName(meta.filename), Buffer.from(await res.arrayBuffer()));
      }

      const manifestBytes = archivos.get("manifest.json");
      if (!manifestBytes) {
        throw new ExtractionError(`El modelo no devolvió manifest.json (archivos recibidos: ${[...archivos.keys()].join(", ") || "ninguno"}).`);
      }
      archivos.delete("manifest.json");
      const manifest = parseManifest(manifestBytes);
      // Las imágenes de las filas no se cargan: se separan de los PDF.
      const recortes = new Map<string, Buffer>();
      for (const c of manifest.carnets) {
        const img = c.recorte ? archivos.get(safeName(c.recorte)) : undefined;
        if (img) recortes.set(c.archivo, img);
      }
      for (const nombre of [...archivos.keys()]) if (!nombre.toLowerCase().endsWith(".pdf")) archivos.delete(nombre);

      const notaModelo = last.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      this.logger.info({ carnets: manifest.carnets.length, descartados: manifest.descartados.length, archivos: archivos.size, pasos: responses.length }, "Extracción de carnets terminada");
      return { manifest, archivos, recortes, notaModelo };
    } catch (err) {
      if (err instanceof ExtractionError || err instanceof ClaudeError) throw err;
      throw new ExtractionError(`No se pudo procesar el PDF: ${(err as Error).message}`);
    } finally {
      // Limpieza: los archivos tienen datos personales.
      await Promise.all(toDelete.map((id) => files.delete(id).catch((e: unknown) => this.logger.warn({ id, err: (e as Error).message }, "No se pudo borrar un archivo de la Files API"))));
    }
  }
}

/**
 * Busca los archivos generados en el sandbox. Se recorre la respuesta entera
 * (y no sólo un tipo de bloque) porque la forma exacta de los resultados de la
 * herramienta cambia entre versiones.
 */
export function collectOutputFileIds(content: unknown): string[] {
  const ids: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (typeof obj.file_id === "string" && typeof obj.type === "string" && obj.type.endsWith("_output")) ids.push(obj.file_id);
      Object.values(obj).forEach(walk);
    }
  };
  walk(content);
  return ids;
}

export function parseManifest(bytes: Buffer): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ExtractionError("manifest.json no es un JSON válido.");
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new ExtractionError(`manifest.json no tiene la forma esperada: ${parsed.error.message}`);
  return parsed.data;
}

/** Nombre de archivo sin rutas (evita "../" en nombres que vienen de afuera). */
export function safeName(name: string): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  return base && base !== "." && base !== ".." ? base : "archivo";
}
