/**
 * Llamadas a Claude compartidas por el extractor y la verificación.
 *
 * - Siempre por streaming: el sandbox puede tardar minutos y una llamada sin
 *   streaming corta por timeout HTTP.
 * - Fallback del lado del servidor (beta "server-side-fallback"): si el modelo
 *   rechaza por política, la API reintenta con otro modelo. Si la API deja de
 *   aceptar el parámetro, se desactiva solo y se reintenta sin él (mismo
 *   criterio que en Enri: una beta retirada no puede tirar el bot).
 * - Acumula el uso de tokens para informar el costo de cada procesamiento.
 */
import Anthropic from "@anthropic-ai/sdk";
import { registrarConsumo } from "../storage/consumo.js";
import type { Logger } from "../utils/logger.js";

export type BetaParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
}

/** Precios de Claude Opus 5.5 (US$ por millón de tokens) para estimar costos en los logs. */
const PRECIO_ENTRADA = 4;
const PRECIO_SALIDA = 20;

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
}

/** Costo aproximado en US$ (sin contar horas de contenedor, que tienen cupo gratis mensual). */
export function estimateCostUsd(u: UsageTotals): number {
  const entrada = u.inputTokens + u.cacheWriteTokens * 1.25 + u.cacheReadTokens * 0.1;
  return (entrada * PRECIO_ENTRADA + u.outputTokens * PRECIO_SALIDA) / 1_000_000;
}

export class ClaudeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeError";
  }
}

export class ClaudeRunner {
  readonly client: Anthropic;
  private fallbacksAvailable: boolean;

  constructor(
    apiKey: string,
    private readonly logger: Logger,
    useFallbacks: boolean,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 2, timeout: 15 * 60_000 });
    this.fallbacksAvailable = useFallbacks;
  }

  /** Ejecuta un pedido, suma su uso a `usage` y lo anota como consumo de `funcion` (pestaña Costos del panel). */
  async run(params: BetaParams, usage: UsageTotals, funcion = "otro"): Promise<BetaMessage> {
    const withFallbacks = this.fallbacksAvailable;
    const full: BetaParams = withFallbacks
      ? { ...params, betas: [...(params.betas ?? []), "server-side-fallback-2026-07-01"], fallbacks: "default" }
      : params;
    try {
      const message = await this.client.beta.messages.stream(full).finalMessage();
      registrarConsumo(funcion, message.model, message.usage);
      usage.requests += 1;
      usage.inputTokens += message.usage.input_tokens;
      usage.outputTokens += message.usage.output_tokens;
      usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;
      if (message.stop_reason === "refusal") {
        throw new ClaudeError("El modelo se negó a procesar el documento (refusal).");
      }
      return message;
    } catch (err) {
      if (withFallbacks && err instanceof Anthropic.BadRequestError && /fallback|beta/i.test(err.message)) {
        this.logger.warn({ err: err.message }, "La API rechazó el parámetro de fallbacks (beta); se desactiva y se reintenta sin él");
        this.fallbacksAvailable = false;
        return this.run(params, usage);
      }
      if (err instanceof ClaudeError) throw err;
      if (err instanceof Anthropic.AuthenticationError) throw new ClaudeError("La API key de Claude es inválida (ANTHROPIC_API_KEY).");
      if (err instanceof Anthropic.RateLimitError) throw new ClaudeError("Claude está limitando pedidos en este momento (rate limit). Probá de nuevo en unos minutos.");
      if (err instanceof Anthropic.APIError) throw new ClaudeError(`Error de la API de Claude (${err.status}): ${err.message}`);
      throw new ClaudeError(`Error inesperado llamando a Claude: ${(err as Error).message}`);
    }
  }
}
