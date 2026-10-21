/**
 * RESGUARDO de los comprobantes de VTV y seguro antes de mandarlos.
 *
 * Un comprobante se entrega SÓLO si coinciden las tres patentes:
 *   1. la que pidió el chofer por WhatsApp,
 *   2. la del nombre del archivo que devuelve SEA WHITE (AAA111.pdf),
 *   3. la que figura ADENTRO del PDF (la lee la IA: puede ser un escaneo).
 * Además, si el documento es claramente del otro tipo (pidió VTV y es un
 * seguro, o al revés), tampoco se entrega.
 * Si algo no coincide, el flujo responde que no está disponible y registra
 * una falla crítica para el panel.
 */
import { normalizePatente } from "../domain/validators.js";
import type { Logger } from "../utils/logger.js";
import { emptyUsage, type ClaudeRunner } from "./claudeRunner.js";

export type TipoComprobante = "vtv" | "seguro";

export interface ResultadoVerificacion {
  ok: boolean;
  /** Motivo legible cuando no pasa (va al panel como falla crítica). */
  motivo?: string;
  patentePedida: string;
  patenteArchivo: string | null;
  patentesEnPdf: string[];
  tipoDetectado: string | null;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["patentes", "tipoDocumento"],
  properties: {
    patentes: { type: "array", items: { type: "string" } },
    tipoDocumento: { type: "string", enum: ["vtv", "seguro", "otro", "ilegible"] },
  },
};

const PROMPT = `Este PDF debería ser un comprobante de un vehículo (una VTV o una póliza/certificado de seguro).
Leelo y devolvé:
- patentes: TODAS las patentes (dominios) de vehículos que aparecen escritas en el documento, tal como figuran. Si no se lee ninguna con seguridad, lista vacía.
- tipoDocumento: "vtv" si es una verificación técnica vehicular, "seguro" si es una póliza o certificado de seguro, "otro" si es otra cosa, "ilegible" si no se puede leer.
No inventes ni completes patentes.`;

/** "AF 498 ZJ" -> "AF498ZJ" (o null si no es una patente). */
function patente(valor: string | null | undefined): string | null {
  if (!valor) return null;
  const r = normalizePatente(valor);
  return r.ok ? r.value : null;
}

export class VerificadorComprobantes {
  constructor(
    private readonly runner: ClaudeRunner,
    private readonly opts: { model: string; effort: "low" | "medium" | "high" | "xhigh" | "max" },
    private readonly logger: Logger,
  ) {}

  async verificar(pdf: Buffer, tipo: TipoComprobante, patentePedida: string, nombreArchivo: string | null): Promise<ResultadoVerificacion> {
    const pedida = patente(patentePedida) ?? patentePedida.toUpperCase();
    const delArchivo = patente(nombreArchivo?.replace(/\.pdf$/i, ""));
    const base = { patentePedida: pedida, patenteArchivo: delArchivo, patentesEnPdf: [] as string[], tipoDetectado: null as string | null };

    // 2) Nombre del archivo: tiene que venir y coincidir.
    if (!delArchivo) return { ...base, ok: false, motivo: `SEA WHITE no informó el nombre del archivo (no se puede verificar que sea de ${pedida}).` };
    if (delArchivo !== pedida) return { ...base, ok: false, motivo: `El archivo se llama ${nombreArchivo} y la patente pedida es ${pedida}.` };

    // 3) Contenido: la IA lee las patentes que figuran en el PDF.
    let leido: { patentes: string[]; tipoDocumento: string };
    try {
      const message = await this.runner.run(
        {
          model: this.opts.model,
          max_tokens: 4000,
          thinking: { type: "adaptive" },
          output_config: { effort: this.opts.effort, format: { type: "json_schema", schema: SCHEMA } },
          messages: [
            {
              role: "user",
              content: [
                { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
                { type: "text", text: PROMPT },
              ],
            },
          ],
        },
        emptyUsage(),
        "consulta: resguardo VTV/seguro",
      );
      const texto = message.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      leido = JSON.parse(texto) as typeof leido;
    } catch (err) {
      this.logger.error({ err: (err as Error).message, tipo, pedida }, "No se pudo leer el comprobante para verificarlo");
      return { ...base, ok: false, motivo: `No se pudo leer el contenido del PDF para verificarlo: ${(err as Error).message}` };
    }

    const enPdf = [...new Set((leido.patentes ?? []).map((p) => patente(p)).filter((p): p is string => Boolean(p)))];
    const resultado = { ...base, patentesEnPdf: enPdf, tipoDetectado: leido.tipoDocumento ?? null };
    if (!enPdf.includes(pedida)) {
      return { ...resultado, ok: false, motivo: enPdf.length ? `Adentro del PDF figura ${enPdf.join(", ")}, no ${pedida}.` : `No se encontró la patente ${pedida} adentro del PDF.` };
    }
    const otro = tipo === "vtv" ? "seguro" : "vtv";
    if (leido.tipoDocumento === otro) {
      return { ...resultado, ok: false, motivo: `Se pidió ${tipo.toUpperCase()} y el documento es ${otro === "vtv" ? "una VTV" : "un seguro"}.` };
    }
    return { ...resultado, ok: true };
  }
}
