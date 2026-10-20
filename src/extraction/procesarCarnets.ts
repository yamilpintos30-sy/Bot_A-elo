/**
 * Punto de entrada del procesamiento de un PDF de carnets:
 *   extracción (sandbox) -> verificación independiente -> revisión sin IA.
 * No toca SEA WHITE: devuelve qué carnets están listos para cargar y cuáles no.
 */
import type { ClaudeConfig } from "../config.js";
import { todayInTimeZone } from "../utils/dates.js";
import type { Logger } from "../utils/logger.js";
import { CarnetExtractor } from "./carnetExtractor.js";
import { ClaudeRunner, emptyUsage, estimateCostUsd, type UsageTotals } from "./claudeRunner.js";
import type { Manifest } from "./manifest.js";
import { reviewCarnets, type ReviewResult } from "./review.js";
import { CarnetVerifier } from "./verifier.js";

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
    this.timezone = config.TIMEZONE;
  }

  /** `onEtapa` avisa en qué paso está (el bot lo usa para mantener informado al cargador). */
  async procesar(pdf: Buffer, filename: string, onEtapa?: (etapa: EtapaProceso) => Promise<void> | void): Promise<ProcesamientoResultado> {
    const started = Date.now();
    const usage = emptyUsage();
    await onEtapa?.("separando");
    const extraccion = await this.extractor.extract(pdf, filename, usage);
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
}
