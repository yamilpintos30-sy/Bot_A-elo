/**
 * Webhook de Chatwoot.
 *
 * Orden de los controles (nada pasa al bot sin superar los anteriores):
 *   1. Token propio en la URL (?token=WEBHOOK_SECRET), distinto del de Enri.
 *   2. Filtro de inbox ESTRICTO: sólo el inbox de este bot (146313). Si el
 *      evento no trae inbox o trae otro, se ignora. Así nunca contesta un chat
 *      de Enri (134690) ni del widget web.
 *   3. Salientes: eco propio -> se ignora; si no, escribió una persona -> el bot
 *      se calla en ese chat (handoff).
 *   4. Mensajes repetidos (Chatwoot reintenta) -> se ignoran.
 * Se responde 200 enseguida y se procesa en segundo plano, en orden por chat.
 */
import { Router, type Request, type Response } from "express";
import type { BotEngine } from "../bot/engine.js";
import type { IncomingMessage } from "../bot/types.js";
import type { EchoGuard } from "../channels/chatwoot/echoGuard.js";
import { extractInboxId, parseChatwootWebhook } from "../channels/chatwoot/parseWebhook.js";
import type { ChatwootWebhookPayload } from "../channels/chatwoot/types.js";
import type { Logger } from "../utils/logger.js";
import { MessageDebouncer } from "./debounce.js";

export interface WebhookOptions {
  secret: string;
  inboxId: string;
  engine: BotEngine;
  echo: EchoGuard;
  logger: Logger;
  debounceMs: number;
  /** Estados de conversación en los que el bot responde. */
  activeStatuses?: string[];
  /**
   * Después de arrancar, durante este tiempo un saliente que no se reconoce NO
   * calla al bot: en un deploy (o un reinicio por cambiar una variable en Render)
   * la versión vieja sigue contestando un rato, y sus mensajes le llegan a ésta,
   * que no los tiene registrados (pasó el 22 y el 28-oct en el chat 211).
   */
  graciaArranqueMs?: number;
}

class RecentIds {
  private readonly ids = new Set<string>();
  seen(id: string): boolean {
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    if (this.ids.size > 2000) this.ids.delete(this.ids.values().next().value!);
    return false;
  }
}

export function createWebhookRouter(opts: WebhookOptions): Router {
  const { engine, echo, logger } = opts;
  const arranque = Date.now();
  const gracia = opts.graciaArranqueMs ?? 3 * 60_000;
  const router = Router();
  const recent = new RecentIds();
  const activos = new Set((opts.activeStatuses ?? ["open", "pending"]).map((s) => s.toLowerCase()));

  // En orden por conversación: un PDF que tarda 2 minutos no puede ser
  // adelantado por el mensaje siguiente del mismo chat.
  const queues = new Map<string, Promise<void>>();
  const enqueue = (conversationId: string, task: () => Promise<void>) => {
    const run = (queues.get(conversationId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(task)
      .catch((err) => logger.error({ err, conversationId }, "Error procesando el mensaje"));
    queues.set(conversationId, run);
    void run.finally(() => {
      if (queues.get(conversationId) === run) queues.delete(conversationId);
    });
  };

  const debouncer = new MessageDebouncer(opts.debounceMs, (merged: IncomingMessage) => enqueue(merged.conversationId, () => engine.handle(merged)));
  process.once("SIGTERM", () => debouncer.flushAll());

  router.post("/webhooks/chatwoot", (req: Request, res: Response) => {
    const token = (req.query.token as string | undefined) ?? req.header("x-webhook-token");
    if (token !== opts.secret) {
      logger.warn({ ip: req.ip }, "Webhook rechazado: token inválido");
      res.status(401).json({ ok: false });
      return;
    }
    res.status(200).json({ ok: true });

    const payload = req.body as ChatwootWebhookPayload;
    const inbox = extractInboxId(payload);
    if (inbox !== opts.inboxId) {
      logger.debug({ inbox }, "Webhook ignorado: no es el inbox de este bot");
      return;
    }

    const event = parseChatwootWebhook(payload);
    switch (event.kind) {
      case "ignore":
        logger.debug({ reason: event.reason }, "Webhook ignorado");
        return;
      case "outgoing":
        if (event.senderType === "agent_bot" || echo.isEcho(event.conversationId, event.messageId, event.text)) return;
        // Botones o lista: lo manda un bot (desde Chatwoot una persona no puede), aunque
        // sea la otra instancia. Y recién arrancado, puede ser la instancia vieja.
        if (event.contentType === "input_select" || Date.now() - arranque < gracia) {
          logger.info({ conversationId: event.conversationId, contentType: event.contentType }, "Saliente no registrado (otra instancia del bot): no se calla");
          return;
        }
        logger.info({ conversationId: event.conversationId }, "Respondió una persona: el bot se calla en este chat");
        debouncer.clear(event.conversationId);
        enqueue(event.conversationId, () => engine.markHandedOff(event.conversationId));
        return;
      case "status_changed":
        if (event.status === "resolved") {
          debouncer.clear(event.conversationId);
          enqueue(event.conversationId, () => engine.reset(event.conversationId));
        }
        return;
      case "message": {
        const m = event.message;
        if (recent.seen(m.id)) return;
        if (m.conversationStatus && !activos.has(m.conversationStatus.toLowerCase())) return;
        debouncer.push(m);
      }
    }
  });

  return router;
}
