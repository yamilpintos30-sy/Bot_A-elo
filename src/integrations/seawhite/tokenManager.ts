/**
 * Token JWT de la API de SEA WHITE. Es el mismo login que usa Enri (confirmado
 * por el ingeniero), pero cada bot pide y guarda SU PROPIO token: no comparten
 * memoria ni proceso.
 *
 * Se confía en `valido_hasta_utc` con un margen y se re-autentica ante un 401.
 */
import type { Logger } from "../../utils/logger.js";
import { assertAllowedEndpoint } from "./endpoints.js";
import { authResponseSchema, SeaWhiteError } from "./types.js";

export interface TokenManagerOptions {
  baseUrl: string;
  email: string;
  password: string;
  servidor: string;
  timeoutMs: number;
  logger: Logger;
  /** Margen (ms) antes del vencimiento real para renovar de forma proactiva. */
  safetyMarginMs?: number;
  fetchImpl?: typeof fetch;
}

const LOGIN_PATH = "/api/autenticacion/validar";

export class SeaWhiteTokenManager {
  private token: string | null = null;
  private validUntil = 0;
  private inFlight: Promise<string> | null = null;
  private readonly safetyMarginMs: number;

  constructor(private readonly opts: TokenManagerOptions) {
    this.safetyMarginMs = opts.safetyMarginMs ?? 5 * 60 * 1000;
  }

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.validUntil - this.safetyMarginMs) return this.token;
    return this.refresh();
  }

  /** Nueva autenticación (p. ej. tras un 401). Evita logins concurrentes. */
  async refresh(): Promise<string> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.authenticate().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  invalidate(): void {
    this.token = null;
    this.validUntil = 0;
  }

  private async authenticate(): Promise<string> {
    const { baseUrl, email, password, servidor, timeoutMs, logger } = this.opts;
    assertAllowedEndpoint("POST", LOGIN_PATH);
    const doFetch = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${baseUrl}${LOGIN_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Servidor: servidor, correo: email, clave: password }),
        signal: controller.signal,
      });
      if (res.status === 401) throw new SeaWhiteError("Credenciales de SEA WHITE inválidas (401). Revisá SEALINK_EMAIL / SEALINK_PASSWORD.", 401);
      if (!res.ok) throw new SeaWhiteError(`Error autenticando en SEA WHITE: HTTP ${res.status}`, res.status);
      const data = authResponseSchema.parse(await res.json());
      this.token = data.token;
      const parsed = data.valido_hasta_utc ? Date.parse(data.valido_hasta_utc) : NaN;
      this.validUntil = Number.isFinite(parsed) ? parsed : Date.now() + (data.expira_en_minutos ?? 480) * 60 * 1000;
      logger.info({ validUntil: new Date(this.validUntil).toISOString() }, "Token de SEA WHITE obtenido");
      return this.token;
    } catch (err) {
      if (err instanceof SeaWhiteError) throw err;
      throw new SeaWhiteError(`No se pudo autenticar en SEA WHITE: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
