/**
 * Listados de estado (por ejemplo, la captura del portal de PAE): una tabla con
 * muchas personas y vehículos y sin carnet individual.
 *
 * No pasan por el sandbox (ahí el modelo mira la imagen muchas veces y sale
 * caro). En cambio:
 *   1. Se renderiza cada página acá y se corta en franjas legibles.
 *   2. Claude las lee UNA vez y devuelve cada fila con su altura aproximada.
 *   3. Se ajusta cada fila a su banda de texto real (filas.ts).
 *   4. Por registro: el documento completo con la fila marcada (constancia) y
 *      un recorte de la fila sola para la verificación independiente.
 */
import { z } from "zod";
import type { Logger } from "../../utils/logger.js";
import { ExtractionError, safeName, type ExtractionOptions, type ExtractionResult } from "../carnetExtractor.js";
import type { ClaudeRunner, UsageTotals } from "../claudeRunner.js";
import type { CarnetManifest, Manifest } from "../manifest.js";
import { CLASIFICACION_PROMPT, LECTURA_LISTADO_PROMPT } from "../prompts.js";
import { ajustarABanda, bandasDeTexto, cortarEnFranjas, pasoTipico, regionConContenido, type Banda, type Region } from "./filas.js";
import { marcarFila } from "./marcar.js";
import { abrirPdf, recortePng, renderizarPagina, type PaginaRenderizada } from "./render.js";

const DPI = 300;
/** Franjas que Claude ve sin achicar (menos de ~1,15 megapíxeles). */
const ANCHO_FRANJA = 1500;
const ALTO_FRANJA = 760;
const ANCHO_RECORTE = 1568;
const MAX_PAGINAS = 20;
const FRANJAS_POR_PEDIDO = 20;

export type ClaseDocumento = "carnets" | "listado";

const CLASIFICACION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["clase"],
  properties: { clase: { type: "string", enum: ["carnets", "listado"] } },
} as const;

const LECTURA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["formato", "clienteDetectado", "filas", "descartados"],
  properties: {
    formato: { type: "string" },
    clienteDetectado: { type: ["string", "null"] },
    filas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["recorte", "yCentro", "tipo", "identificador", "apellidoNombre", "vencimiento", "motivoVencimiento", "observaciones"],
        properties: {
          recorte: { type: "integer" },
          yCentro: { type: "number" },
          tipo: { type: "string", enum: ["chofer", "dominio"] },
          identificador: { type: ["string", "null"] },
          apellidoNombre: { type: ["string", "null"] },
          vencimiento: { type: ["string", "null"] },
          motivoVencimiento: { type: ["string", "null"] },
          observaciones: { type: ["string", "null"] },
        },
      },
    },
    descartados: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["motivo"], properties: { motivo: { type: "string" } } },
    },
  },
} as const;

const lecturaSchema = z.object({
  formato: z.string(),
  clienteDetectado: z.string().nullable(),
  filas: z.array(
    z.object({
      recorte: z.number().int(),
      yCentro: z.number(),
      tipo: z.enum(["chofer", "dominio"]),
      identificador: z.string().nullable(),
      apellidoNombre: z.string().nullable(),
      vencimiento: z.string().nullable(),
      motivoVencimiento: z.string().nullable(),
      observaciones: z.string().nullable(),
    }),
  ),
  descartados: z.array(z.object({ motivo: z.string() })),
});
type Fila = z.infer<typeof lecturaSchema>["filas"][number];

interface Franja {
  pagina: number;
  /** Altura de la franja en la página renderizada. */
  y0: number;
  /** Píxeles de la imagen enviada por píxel de la página renderizada. */
  escala: number;
  png: Buffer;
}

interface PaginaLista {
  render: PaginaRenderizada;
  region: Region;
  bandas: Banda[];
  paso: number;
}

export class LectorListados {
  constructor(
    private readonly runner: ClaudeRunner,
    /** Lectura del listado. */
    private readonly opts: ExtractionOptions,
    /** Clasificación (pedido chico: modelo y esfuerzo de verificación). */
    private readonly clasificacion: ExtractionOptions,
    private readonly logger: Logger,
  ) {}

  /** Mira la primera página y dice si es un PDF de carnets o un listado. */
  async clasificar(pdf: Buffer, usage: UsageTotals): Promise<ClaseDocumento> {
    const doc = await abrirPdf(pdf);
    try {
      const pagina = await renderizarPagina(doc, 1, 100);
      const { png } = recortePng(pagina.canvas, { x0: 0, y0: 0, x1: pagina.canvas.width, y1: pagina.canvas.height }, 1200);
      const msg = await this.runner.run(
        {
          model: this.clasificacion.model,
          max_tokens: 2000,
          output_config: { effort: this.clasificacion.effort, format: { type: "json_schema", schema: CLASIFICACION_SCHEMA as unknown as Record<string, unknown> } },
          messages: [{ role: "user", content: [imagen(png), { type: "text", text: CLASIFICACION_PROMPT }] }],
        },
        usage,
        "carga: reconocer el documento",
      );
      const r = z.object({ clase: z.enum(["carnets", "listado"]) }).safeParse(json(msg));
      return r.success ? r.data.clase : "carnets";
    } finally {
      await doc.destroy();
    }
  }

  async extraer(pdf: Buffer, filename: string, usage: UsageTotals): Promise<ExtractionResult> {
    const doc = await abrirPdf(pdf);
    try {
      if (doc.numPages > MAX_PAGINAS) throw new ExtractionError(`El listado tiene ${doc.numPages} páginas (máximo ${MAX_PAGINAS}).`);

      // 1. Render y franjas.
      const paginas = new Map<number, PaginaLista>();
      const franjas: Franja[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const render = await renderizarPagina(doc, n, DPI);
        const region = regionConContenido(render.gris);
        if (!region) continue;
        const bandas = bandasDeTexto(render.gris, region);
        paginas.set(n, { render, region, bandas, paso: pasoTipico(bandas) });
        const escala = Math.min(1, ANCHO_FRANJA / (region.x1 - region.x0));
        for (const f of cortarEnFranjas(bandas, region, Math.floor(ALTO_FRANJA / escala))) {
          const { png } = recortePng(render.canvas, { x0: region.x0, x1: region.x1, y0: f.y0, y1: f.y1 }, ANCHO_FRANJA);
          franjas.push({ pagina: n, y0: f.y0, escala, png });
        }
      }
      if (!franjas.length) throw new ExtractionError("El documento está en blanco.");

      // 2. Lectura.
      const filas: Array<Fila & { franja: Franja }> = [];
      const descartados: Manifest["descartados"] = [];
      let formato = "";
      let clienteDetectado: string | null = null;
      for (let inicio = 0; inicio < franjas.length; inicio += FRANJAS_POR_PEDIDO) {
        const lote = franjas.slice(inicio, inicio + FRANJAS_POR_PEDIDO);
        const content: Array<Record<string, unknown>> = [];
        lote.forEach((f, i) => content.push({ type: "text", text: `Franja ${i + 1} (página ${f.pagina}):` }, imagen(f.png)));
        content.push({ type: "text", text: LECTURA_LISTADO_PROMPT });
        const msg = await this.runner.run(
          {
            model: this.opts.model,
            max_tokens: 32000,
            thinking: { type: "adaptive" },
            output_config: { effort: this.opts.effort, format: { type: "json_schema", schema: LECTURA_SCHEMA as unknown as Record<string, unknown> } },
            messages: [{ role: "user", content: content as never }],
          },
          usage,
          "carga: leer listado",
        );
        const r = lecturaSchema.safeParse(json(msg));
        if (!r.success) throw new ExtractionError(`La lectura del listado devolvió un formato inesperado: ${r.error.message}`);
        formato ||= r.data.formato;
        clienteDetectado ??= r.data.clienteDetectado;
        for (const f of r.data.filas) {
          const franja = lote[f.recorte - 1];
          if (franja) filas.push({ ...f, franja });
          else descartados.push({ pagina: null, motivo: `${f.identificador ?? "Una fila"}: franja inexistente en la lectura.` });
        }
        descartados.push(...r.data.descartados.map((d) => ({ pagina: null, motivo: d.motivo })));
      }

      // 3. Ubicación exacta de cada fila (dos registros en la misma fila = dudoso: no se cargan).
      const ubicadas = filas.map((f) => {
        const pg = paginas.get(f.franja.pagina)!;
        const y = f.franja.y0 + f.yCentro / f.franja.escala;
        return { fila: f, pg, banda: ajustarABanda(pg.bandas, y, Math.max(4, pg.paso * 0.6)) };
      });
      const porBanda = new Map<string, number>();
      for (const u of ubicadas) {
        if (!u.banda) continue;
        const k = clave(u.fila.franja.pagina, u.banda);
        porBanda.set(k, (porBanda.get(k) ?? 0) + 1);
      }

      // 4. Constancia marcada y recorte para verificar.
      const carnets: CarnetManifest[] = [];
      const archivos = new Map<string, Buffer>();
      const recortes = new Map<string, Buffer>();
      for (const { fila, pg, banda } of ubicadas) {
        const ref = fila.apellidoNombre ? `${fila.apellidoNombre} (${fila.identificador ?? "?"})` : (fila.identificador ?? "una fila");
        const pagina = fila.franja.pagina;
        if (!fila.identificador) {
          descartados.push({ pagina, motivo: `${ref}: no se leyó el identificador.` });
          continue;
        }
        if (!banda) {
          descartados.push({ pagina, motivo: `${ref}: no se pudo ubicar la fila en el documento.` });
          continue;
        }
        if ((porBanda.get(clave(pagina, banda)) ?? 0) > 1) {
          descartados.push({ pagina, motivo: `${ref}: dos registros quedaron en la misma fila; no se marca para no confundirlos.` });
          continue;
        }
        const archivo = nombreUnico(`${safeName(fila.identificador.toUpperCase())}.pdf`, archivos);
        const espacio = espacioAlrededor(pg.bandas, banda);
        const margenVertical = Math.max(1, Math.min(3 * (DPI / 72), espacio * 0.45));
        archivos.set(archivo, await marcarFila(pdf, { pagina, viewport: pg.render.viewport, region: pg.region, banda, escala: DPI / 72, margenVertical }));
        const margen = Math.max(1, Math.min(8, Math.floor(espacio * 0.45)));
        recortes.set(archivo, recortePng(pg.render.canvas, { x0: pg.region.x0, x1: pg.region.x1, y0: banda.y0 - margen, y1: banda.y1 + margen }, ANCHO_RECORTE).png);
        carnets.push({
          archivo,
          tipo: fila.tipo,
          identificador: fila.identificador,
          apellidoNombre: fila.apellidoNombre,
          vencimiento: fila.vencimiento,
          clienteDetectado,
          pagina,
          observaciones: fila.observaciones,
          motivoVencimiento: fila.motivoVencimiento,
          recorte: `${archivo}.fila.png`,
        });
      }

      const manifest: Manifest = { formato: `LISTADO: ${formato}`, modo: "listado", carnets, descartados };
      this.logger.info({ archivo: filename, registros: carnets.length, descartados: descartados.length, franjas: franjas.length }, "Listado leído");
      return { manifest, archivos, recortes, notaModelo: "" };
    } finally {
      await doc.destroy();
    }
  }
}

const clave = (pagina: number, b: Banda) => `${pagina}:${b.y0}`;

/** Píxeles libres entre la banda y la vecina más cercana (arriba o abajo). */
function espacioAlrededor(bandas: Banda[], b: Banda): number {
  const i = bandas.indexOf(b);
  const arriba = i > 0 ? b.y0 - bandas[i - 1]!.y1 : Infinity;
  const abajo = i < bandas.length - 1 ? bandas[i + 1]!.y0 - b.y1 : Infinity;
  const e = Math.min(arriba, abajo);
  return Number.isFinite(e) ? e : 20;
}

function nombreUnico(nombre: string, usados: Map<string, Buffer>): string {
  if (!usados.has(nombre)) return nombre;
  const base = nombre.replace(/\.pdf$/i, "");
  for (let i = 2; ; i++) if (!usados.has(`${base}-${i}.pdf`)) return `${base}-${i}.pdf`;
}

function imagen(png: Buffer) {
  return { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: png.toString("base64") } };
}

function json(msg: { content: Array<{ type: string }> }): unknown {
  const text = msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
