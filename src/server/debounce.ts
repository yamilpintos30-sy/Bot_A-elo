/**
 * Buffer corto de mensajes: junta lo que la persona manda seguido y lo procesa
 * como un solo mensaje. Caso típico del cargador: "Total planta 1" y el PDF en
 * dos mensajes separados por un segundo; sin el buffer el bot contestaría
 * "mandá el PDF" justo cuando el PDF ya estaba llegando.
 *
 * Un DNI o una patente solos se procesan al instante (son la respuesta a una
 * pregunta puntual).
 */
import type { IncomingMessage } from "../bot/types.js";
import { looksLikeDni, looksLikePatente } from "../domain/validators.js";

interface Pending {
  messages: IncomingMessage[];
  timer: NodeJS.Timeout;
}

export class MessageDebouncer {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly waitMs: number,
    private readonly onFlush: (merged: IncomingMessage) => void,
  ) {}

  push(message: IncomingMessage): void {
    const instantaneo = message.attachments.length === 0 && (looksLikeDni(message.text) || looksLikePatente(message.text));
    const existing = this.pending.get(message.conversationId);
    if (this.waitMs <= 0 || (instantaneo && !existing)) {
      this.onFlush(message);
      return;
    }
    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(message);
      if (instantaneo) return this.flush(message.conversationId);
      existing.timer = setTimeout(() => this.flush(message.conversationId), this.waitMs);
      return;
    }
    this.pending.set(message.conversationId, { messages: [message], timer: setTimeout(() => this.flush(message.conversationId), this.waitMs) });
  }

  /** Vacía todo ya (apagado del proceso: nada queda sin responder). */
  flushAll(): void {
    for (const id of [...this.pending.keys()]) this.flush(id);
  }

  clear(conversationId: string): void {
    const p = this.pending.get(conversationId);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(conversationId);
    }
  }

  private flush(conversationId: string): void {
    const p = this.pending.get(conversationId);
    if (!p) return;
    this.pending.delete(conversationId);
    clearTimeout(p.timer);
    const last = p.messages[p.messages.length - 1]!;
    this.onFlush({
      ...last,
      text: p.messages.map((m) => m.text.trim()).filter(Boolean).join("\n"),
      attachments: p.messages.flatMap((m) => m.attachments),
    });
  }
}
