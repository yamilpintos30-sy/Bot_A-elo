/**
 * Verificación independiente de los carnets recortados.
 *
 * Una SEGUNDA llamada, sin acceso a lo que dijo la extracción, lee cada PDF
 * recortado y devuelve DNI/patente y vencimiento. `review.ts` compara las dos
 * lecturas: si no coinciden, el carnet no se carga. Así un error de lectura o
 * un recorte equivocado (el PDF de Pérez con los datos de otro) no llega a
 * SEA WHITE.
 */
import type { Logger } from "../utils/logger.js";
import type { ClaudeRunner, UsageTotals } from "./claudeRunner.js";
import { VERIFICACION_JSON_SCHEMA, verificacionSchema, type VerificacionDocumento } from "./manifest.js";
import { VERIFICACION_PROMPT } from "./prompts.js";
import type { ExtractionOptions } from "./carnetExtractor.js";
import { formatoDe } from "./aPdf.js";

/** Documentos por pedido: carnets chicos, pero se acota para no armar pedidos enormes. */
const POR_PEDIDO = 15;

export class CarnetVerifier {
  constructor(
    private readonly runner: ClaudeRunner,
    private readonly opts: ExtractionOptions,
    private readonly logger: Logger,
  ) {}

  /** Devuelve la lectura independiente de cada archivo, por nombre. */
  /**
   * Devuelve la lectura independiente de cada archivo, por nombre. En un
   * listado se lee la imagen ampliada de la fila (`recortes`) y no la página
   * entera: el documento completo tiene letra chica y se repetiría por cada registro.
   */
  async verify(archivos: Map<string, Buffer>, usage: UsageTotals, recortes: Map<string, Buffer> = new Map()): Promise<Map<string, VerificacionDocumento>> {
    const entries = [...archivos.entries()];
    const result = new Map<string, VerificacionDocumento>();

    for (let start = 0; start < entries.length; start += POR_PEDIDO) {
      const chunk = entries.slice(start, start + POR_PEDIDO);
      const content: Array<Record<string, unknown>> = [];
      chunk.forEach(([nombre, pdf], i) => {
        content.push({ type: "text", text: `Documento ${i + 1}:` });
        const img = recortes.get(nombre);
        const formato = img ? formatoDe(img) : null;
        if (img && (formato === "png" || formato === "jpg")) {
          const media = formato === "png" ? "image/png" : "image/jpeg";
          content.push({ type: "image", source: { type: "base64", media_type: media, data: img.toString("base64") } });
        } else {
          content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } });
        }
      });
      content.push({ type: "text", text: VERIFICACION_PROMPT });

      const message = await this.runner.run(
        {
          model: this.opts.model,
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          output_config: { effort: this.opts.effort, format: { type: "json_schema", schema: VERIFICACION_JSON_SCHEMA as unknown as Record<string, unknown> } },
          messages: [{ role: "user", content: content as never }],
        },
        usage,
      );

      const text = message.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      const parsed = verificacionSchema.safeParse(safeJsonParse(text));
      if (!parsed.success) {
        this.logger.warn({ err: parsed.error.message }, "La verificación devolvió un formato inesperado; esos carnets quedan sin verificar");
        continue;
      }
      for (const doc of parsed.data.documentos) {
        const entry = chunk[doc.indice - 1];
        if (entry) result.set(entry[0], doc);
      }
    }
    return result;
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
