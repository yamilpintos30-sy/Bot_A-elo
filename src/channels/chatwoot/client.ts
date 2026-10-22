/**
 * Cliente de la API de Chatwoot: texto, botones, archivos y descarga de adjuntos.
 *
 * Botones: content_type "input_select". En inboxes de WhatsApp Cloud Chatwoot
 * los convierte en botones nativos (hasta 3). Cuando la persona toca uno,
 * vuelve como mensaje con el TÍTULO del botón.
 *
 * Todo envío se registra en EchoGuard (texto antes, ID después).
 */
import type { ButtonSpec } from "../../bot/types.js";
import type { Logger } from "../../utils/logger.js";
import type { EchoGuard } from "./echoGuard.js";

export interface ChatwootClientOptions {
  baseUrl: string;
  apiToken: string;
  accountId: number;
  logger: Logger;
  echo: EchoGuard;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Máximo que se acepta descargar de un adjunto (los PDF de carnets pesan pocos MB). */
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;

export class ChatwootClient {
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: ChatwootClientOptions) {
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  async sendText(conversationId: string, content: string): Promise<void> {
    this.opts.echo.recordText(conversationId, content);
    const created = await this.post(`/conversations/${conversationId}/messages`, { content, message_type: "outgoing", private: false });
    this.opts.echo.recordId(created.id);
  }

  async sendButtons(conversationId: string, text: string, buttons: ButtonSpec[]): Promise<void> {
    this.opts.echo.recordText(conversationId, text);
    const created = await this.post(`/conversations/${conversationId}/messages`, {
      content: text,
      content_type: "input_select",
      content_attributes: { items: buttons.map((b) => ({ title: b.title, value: b.payload, ...(b.description ? { description: b.description.slice(0, 72) } : {}) })) },
      message_type: "outgoing",
      private: false,
    });
    this.opts.echo.recordId(created.id);
  }

  /** Archivo PDF con epígrafe. Devuelve el id del mensaje (para esperar su entrega). */
  async sendFile(conversationId: string, filename: string, data: Buffer, caption = ""): Promise<string | null> {
    this.opts.echo.recordText(conversationId, caption || filename);
    const form = new FormData();
    form.append("content", caption);
    form.append("message_type", "outgoing");
    form.append("attachments[]", new Blob([new Uint8Array(data)], { type: "application/pdf" }), filename);
    const created = await this.send(`/conversations/${conversationId}/messages`, form);
    this.opts.echo.recordId(created.id);
    return created.id !== undefined ? String(created.id) : null;
  }

  /**
   * Imagen de bienvenida con el saludo como epígrafe (como Enri). Devuelve el
   * id del mensaje creado, para poder esperar su entrega.
   */
  async sendImage(conversationId: string, caption: string, image: Buffer, filename: string): Promise<string | null> {
    this.opts.echo.recordText(conversationId, caption);
    // Tipo MIME según la extensión del archivo configurado (jpg, png, webp).
    const ext = filename.toLowerCase().split(".").pop() ?? "jpg";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
    const form = new FormData();
    form.append("content", caption);
    form.append("message_type", "outgoing");
    form.append("attachments[]", new Blob([new Uint8Array(image)], { type: mime }), filename);
    const created = await this.send(`/conversations/${conversationId}/messages`, form);
    this.opts.echo.recordId(created.id);
    return created.id !== undefined ? String(created.id) : null;
  }

  /**
   * Espera a que WhatsApp confirme la ENTREGA del mensaje (status delivered/read).
   * Copiado de Enri: es la única garantía real de orden. "sent" sólo significa
   * que Chatwoot lo despachó, pero Meta puede seguir procesando la imagen y
   * entregarla después que un mensaje posterior (visto en producción).
   * Devuelve el último estado observado ("timeout..." si venció el plazo).
   */
  async waitMessageDelivered(conversationId: string, messageId: string, timeoutMs = 15_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/api/v1/accounts/${this.opts.accountId}/conversations/${conversationId}/messages`;
    let last = "";
    let erroresSeguidos = 0;
    while (Date.now() < deadline) {
      try {
        const res = await this.fetchWithTimeout(url, { headers: { api_access_token: this.opts.apiToken } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { payload?: Array<{ id?: number; status?: string }> };
        erroresSeguidos = 0;
        const status = data.payload?.find((m) => String(m.id) === messageId)?.status ?? "";
        if (status !== last) {
          this.opts.logger.info({ conversationId, messageId, status }, "Estado del adjunto enviado");
          last = status;
        }
        if (status === "delivered" || status === "read" || status === "failed") return status;
      } catch (err) {
        // Un error transitorio NO abandona la espera (abandonarla revivía la
        // carrera imagen/botones en Enri); recién tras varios seguidos se corta.
        erroresSeguidos += 1;
        this.opts.logger.warn({ err, conversationId, erroresSeguidos }, "No se pudo consultar el estado del mensaje; se reintenta");
        if (erroresSeguidos >= 4) return "unknown";
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    this.opts.logger.warn({ conversationId, messageId, last }, "El adjunto no confirmó entrega dentro del plazo");
    return `timeout:${last || "sin-estado"}`;
  }

  /**
   * Descarga un adjunto recibido. Las URLs de Chatwoot suelen ser públicas
   * (firmadas); si responden 401/403 se reintenta con el token.
   */
  async downloadAttachment(url: string): Promise<Buffer> {
    let res = await this.fetchWithTimeout(url, {});
    if (res.status === 401 || res.status === 403) {
      res = await this.fetchWithTimeout(url, { headers: { api_access_token: this.opts.apiToken } });
    }
    if (!res.ok) throw new Error(`No se pudo descargar el adjunto (HTTP ${res.status})`);
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_DOWNLOAD_BYTES) throw new Error(`El archivo es demasiado grande (${Math.round(length / 1024 / 1024)} MB)`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_DOWNLOAD_BYTES) throw new Error("El archivo es demasiado grande");
    return data;
  }

  async setStatus(conversationId: string, status: "open" | "pending" | "resolved"): Promise<void> {
    await this.post(`/conversations/${conversationId}/toggle_status`, { status });
  }

  // ---------------------------------------------------------------------------

  private post(path: string, body: unknown): Promise<{ id?: number }> {
    return this.send(path, JSON.stringify(body), { "Content-Type": "application/json" });
  }

  /** Un reintento ante errores transitorios (red o 5xx), como en Enri. */
  private async send(path: string, body: string | FormData, headers: Record<string, string> = {}): Promise<{ id?: number }> {
    try {
      return await this.sendOnce(path, body, headers);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/HTTP 5\d\d|fetch|network|abort|ECONN|ETIMEDOUT/i.test(msg)) throw err;
      this.opts.logger.warn({ path, err: msg }, "Chatwoot falló; se reintenta una vez");
      await new Promise((r) => setTimeout(r, 800));
      return this.sendOnce(path, body, headers);
    }
  }

  private async sendOnce(path: string, body: string | FormData, headers: Record<string, string>): Promise<{ id?: number }> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/api/v1/accounts/${this.opts.accountId}${path}`;
    const res = await this.fetchWithTimeout(url, { method: "POST", headers: { ...headers, api_access_token: this.opts.apiToken }, body });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Chatwoot respondió HTTP ${res.status} en ${path}: ${text.slice(0, 300)}`);
    }
    return ((await res.json().catch(() => ({}))) ?? {}) as { id?: number };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000);
    try {
      return await this.doFetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
