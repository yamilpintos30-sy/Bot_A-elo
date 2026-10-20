/**
 * Punto de entrada del procesamiento de un PDF de carnets:
 *   clasificación -> extracción (sandbox para carnets, lectura directa para
 *   listados) -> verificación independiente -> revisión sin IA.
 * No toca SEA WHITE: devuelve qué carnets están listos para cargar y cuáles no.
 */
import type { ClaudeConfig } from "../config.js";
import { todayInTimeZone } from "../utils/dates.js";
import type { Logger } from "../utils/logger.js";
import { CarnetExtractor, ExtractionError, type ExtractionResult } from "./carnetExtractor.js";
import { ClaudeError, ClaudeRunner, emptyUsage, estimateCostUsd, type UsageTotals } from "./claudeRunner.js";
import type { Manifest } from "./manifest.js";
import { reviewCarnets, type ReviewResult } from "./review.js";
import { CarnetVerifier } from "./verifier.js";
import { LectorListados } from "./listados/lectorListados.js";

export type EtapaProceso = "separando" | "verificando";

export interface ProcesamientoResultado extends ReviewResult {
  formato: string | null;
  notaModelo: string;
  manifest: Manifest;
  usage: UsageTotals;
  costoUsd: number;
  duracionMs: number;
}

export class ProcesadorCarnets {
  private readonly extractor: CarnetExtractor;
  private readonly verifier: CarnetVerifier;
  private readonly listados: LectorListados;
  private readonly timezone: string;

  constructor(
    config: ClaudeConfig & { TIMEZONE: string },
    private readonly logger: Logger,
    runner?: ClaudeRunner,
  ) {
    const r = runner ?? new ClaudeRunner(config.ANTHROPIC_API_KEY, logger, config.CLAUDE_FALLBACKS);
    const opts = { model: config.EXTRACTION_MODEL, effort: config.EXTRACTION_EFFORT };
    this.extractor = new CarnetExtractor(r, opts, logger);
    this.verifier = new CarnetVerifier(r, opts, logger);
    this.listados = new LectorListados(r, { model: config.EXTRACTION_MODEL, effort: "medium" }, { model: config.VERIFY_MODEL, effort: config.VERIFY_EFFORT }, logger);
    this.timezone = config.TIMEZONE;
  }

  /** `onEtapa` avisa en qué paso está (el bot lo usa para mantener informado al cargador). */
  async procesar(pdf: Buffer, filename: string, onEtapa?: (etapa: EtapaProceso) => Promise<void> | void): Promise<ProcesamientoResultado> {
    const started = Date.now();
    const usage = emptyUsage();
    await onEtapa?.("separando");
    const extraccion = await this.extraer(pdf, filename, usage);
    await onEtapa?.("verificando");
    const verificacion = await this.verifier.verify(extraccion.archivos, usage, extraccion.recortes);
    const review = reviewCarnets({
      manifest: extraccion.manifest,
      archivos: extraccion.archivos,
      verificacion,
      hoy: todayInTimeZone(this.timezone),
    });
    const resultado: ProcesamientoResultado = {
      ...review,
      formato: extraccion.manifest.formato ?? null,
      notaModelo: extraccion.notaModelo,
      manifest: extraccion.manifest,
      usage,
      costoUsd: estimateCostUsd(usage),
      duracionMs: Date.now() - started,
    };
    this.logger.info(
      { aceptados: review.aceptados.length, rechazados: review.rechazados.length, costoUsd: resultado.costoUsd.toFixed(3), segundos: Math.round(resultado.duracionMs / 1000) },
      "PDF de carnets procesado",
    );
    return resultado;
  }

  /**
   * Un listado (tabla de estados) se lee directo, sin sandbox: es mucho más
   * barato y estable. Si el render falla (un PDF que pdf.js no abre), se sigue por el sandbox, que acepta cualquier cosa.
   */
  private async extraer(pdf: Buffer, filename: string, usage: UsageTotals): Promise<ExtractionResult> {
    try {
      if ((await this.listados.clasificar(pdf, usage)) === "listado") return await this.listados.extraer(pdf, filename, usage);
    } catch (err) {
      // Errores de Claude o de una lectura ya hecha: no se repite todo en el sandbox (costo).
      if (err instanceof ClaudeError || err instanceof ExtractionError) throw err;
      this.logger.warn({ err: (err as Error).message }, "No se pudo leer como listado; se procesa en el sandbox");
    }
    return this.extractor.extract(pdf, filename, usage);
  }
}
