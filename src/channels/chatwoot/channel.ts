/** Traduce lo que el bot quiere enviar (Outbound) a llamadas de Chatwoot. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Channel } from "../../bot/engine.js";
import type { Outbound } from "../../bot/types.js";
import type { Logger } from "../../utils/logger.js";
import { splitForButtons, splitForWhatsApp } from "../../utils/text.js";
import type { ChatwootClient } from "./client.js";

export class ChatwootChannel implements Channel {
  /** undefined = todavía no se intentó leer; null = no hay imagen (saludo sólo texto). */
  private welcomeImage: Buffer | null | undefined;

  constructor(
    private readonly client: ChatwootClient,
    private readonly logger: Logger,
    private readonly welcomeImagePath?: string,
    /** WELCOME_IMAGE_DELAY_MS: colchón después de confirmar la entrega. */
    private readonly pausaMs = 800,
  ) {}

  async send(conversationId: string, out: Outbound): Promise<void> {
    switch (out.kind) {
      case "text":
        for (const part of splitForWhatsApp(out.text)) await this.client.sendText(conversationId, part);
        return;
      case "buttons": {
        // El texto que acompaña a los botones tiene tope (1024): si es largo,
        // se manda en partes y los botones van con la última.
        const parts = splitForWhatsApp(out.text).flatMap((p, i, all) => (i === all.length - 1 ? splitForButtons(p) : [p]));
        for (const part of parts.slice(0, -1)) await this.client.sendText(conversationId, part);
        const id = await this.client.sendButtons(conversationId, parts[parts.length - 1]!, out.buttons);
        // Le sigue otro mensaje con botones (p. ej. la lista 2 después de la 1):
        // WhatsApp los desordenaba, así que se espera la entrega de éste.
        if (out.esperarEntrega) await this.esperarEntrega(conversationId, id);
        return;
      }
      case "file": {
        // Igual que con la imagen del saludo: WhatsApp procesa el PDF más lento
        // que un texto, y el "¿Necesitás algo más?" llegaba ANTES que el carnet.
        // Se espera la confirmación de entrega antes de seguir.
        const id = await this.client.sendFile(conversationId, out.filename, out.data, out.caption, out.mime);
        await this.esperarEntrega(conversationId, id);
        return;
      }
      case "image": {
        const image = await this.loadWelcomeImage();
        if (!image) {
          await this.client.sendText(conversationId, out.caption);
          return;
        }
        const id = await this.client.sendImage(conversationId, out.caption, image, path.basename(this.welcomeImagePath!));
        // Que la imagen llegue antes que los botones que siguen.
        await this.esperarEntrega(conversationId, id);
        return;
      }
    }
  }

  /**
   * Igual que Enri: garantizar el orden adjunto -> mensaje siguiente esperando
   * la confirmación de ENTREGA (delivered/read). Si no se pudo confirmar, pausa
   * larga de seguridad (5 s) en vez del colchón corto.
   */
  private async esperarEntrega(conversationId: string, messageId: string | null): Promise<void> {
    const status = messageId ? await this.client.waitMessageDelivered(conversationId, messageId) : "sin-id";
    const confirmada = status === "delivered" || status === "read";
    const pausa = confirmada ? this.pausaMs : Math.max(this.pausaMs, 5000);
    if (!confirmada) this.logger.warn({ conversationId, status, pausa }, "Entrega del mensaje sin confirmar; pausa de seguridad");
    if (pausa > 0) await new Promise((r) => setTimeout(r, pausa));
  }

  private async loadWelcomeImage(): Promise<Buffer | null> {
    if (this.welcomeImage !== undefined) return this.welcomeImage;
    if (!this.welcomeImagePath) return (this.welcomeImage = null);
    try {
      this.welcomeImage = await readFile(this.welcomeImagePath);
    } catch {
      this.logger.warn({ path: this.welcomeImagePath }, "No hay imagen de bienvenida; el saludo sale sólo con texto");
      this.welcomeImage = null;
    }
    return this.welcomeImage;
  }
}
