/** Traduce lo que el bot quiere enviar (Outbound) a llamadas de Chatwoot. */
import type { Channel } from "../../bot/engine.js";
import type { Outbound } from "../../bot/types.js";
import { splitForButtons, splitForWhatsApp } from "../../utils/text.js";
import type { ChatwootClient } from "./client.js";

export class ChatwootChannel implements Channel {
  constructor(private readonly client: ChatwootClient) {}

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
        await this.client.sendButtons(conversationId, parts[parts.length - 1]!, out.buttons);
        return;
      }
      case "file":
        await this.client.sendFile(conversationId, out.filename, out.data, out.caption);
        return;
    }
  }
}
