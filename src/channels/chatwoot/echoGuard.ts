/**
 * Anti-eco: ¿un mensaje saliente lo mandó este bot o una persona?
 *
 * Este bot usa el MISMO usuario/token de Chatwoot que Enri (el plan tiene un
 * solo asiento), así que NO sirve el criterio de Enri ("todo lo que manda el
 * usuario del token es eco"): una persona respondiendo desde Chatwoot con ese
 * usuario se confundiría con el bot. En su lugar se registra lo que manda
 * ESTE proceso:
 *   1. El ID de cada mensaje creado (la API lo devuelve al enviar).
 *   2. El texto, ANTES de enviar: el webhook del eco puede llegar antes de que
 *      termine la llamada que devuelve el ID.
 * Lo que no coincide con ninguno es una persona (o la app de WhatsApp del
 * celular, porque el número tiene coexistencia): el bot se calla en ese chat.
 */

const WINDOW_MS = 5 * 60_000;
const MAX_IDS = 5000;

function normalize(text: string): string {
  return (text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export class EchoGuard {
  private readonly ids = new Set<string>();
  private readonly texts = new Map<string, Array<{ norm: string; at: number }>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Antes de enviar: registra el texto (o el nombre de archivo) que se va a mandar. */
  recordText(conversationId: string, text: string): void {
    const norm = normalize(text);
    if (!norm) return;
    const at = this.now();
    const list = (this.texts.get(conversationId) ?? []).filter((e) => e.at >= at - WINDOW_MS);
    list.push({ norm, at });
    this.texts.set(conversationId, list.slice(-50));
  }

  /** Después de enviar: registra el ID que devolvió Chatwoot. */
  recordId(messageId: string | number | undefined): void {
    if (messageId === undefined || messageId === null) return;
    this.ids.add(String(messageId));
    if (this.ids.size > MAX_IDS) {
      const first = this.ids.values().next().value;
      if (first !== undefined) this.ids.delete(first);
    }
  }

  isEcho(conversationId: string, messageId: string | undefined, text: string): boolean {
    if (messageId && this.ids.has(messageId)) return true;
    const norm = normalize(text);
    if (!norm) return false;
    const cutoff = this.now() - WINDOW_MS;
    return (this.texts.get(conversationId) ?? []).some((e) => e.at >= cutoff && e.norm === norm);
  }
}
