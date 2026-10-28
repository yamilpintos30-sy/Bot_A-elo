/**
 * Webhook: token propio, filtro de inbox ESTRICTO (nunca atender chats de Enri)
 * y anti-eco (eco propio vs. persona que responde).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pino from "pino";
import { EchoGuard } from "../src/channels/chatwoot/echoGuard.js";
import { createWebhookRouter } from "../src/server/webhook.js";
import type { BotEngine } from "../src/bot/engine.js";

const logger = pino({ level: "silent" });
const SECRET = "secreto-del-bot-anelo-1234";
let server: Server | undefined;

afterEach(() => server?.close());

async function start(opts: { gracia?: number } = {}) {
  const engine = { handle: vi.fn(async () => undefined), markHandedOff: vi.fn(async () => undefined), reset: vi.fn(async () => undefined) };
  const echo = new EchoGuard();
  const app = express();
  app.use(express.json());
  app.use(createWebhookRouter({ secret: SECRET, inboxId: "146313", engine: engine as unknown as BotEngine, echo, logger, debounceMs: 0, graciaArranqueMs: opts.gracia ?? 0 }));
  server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const post = (body: unknown, token = SECRET) =>
    fetch(`http://127.0.0.1:${port}/webhooks/chatwoot?token=${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  return { engine, echo, post, settle };
}

const incoming = (inboxId: number | undefined, extra: Record<string, unknown> = {}) => ({
  event: "message_created",
  id: Math.floor(Math.random() * 1e9),
  message_type: "incoming",
  content: "hola",
  account: { id: 182533 },
  conversation: { id: 77, status: "open", ...(inboxId !== undefined ? { inbox_id: inboxId } : {}), meta: { sender: { phone_number: "+5492995551234" } } },
  ...extra,
});

describe("webhook", () => {
  it("rechaza un token inválido", async () => {
    const { post, engine, settle } = await start();
    expect((await post(incoming(146313), "otro")).status).toBe(401);
    await settle();
    expect(engine.handle).not.toHaveBeenCalled();
  });

  it("atiende SOLO su inbox: ignora el de Enri, el widget y los eventos sin inbox", async () => {
    const { post, engine, settle } = await start();
    await post(incoming(134690)); // Enri
    await post(incoming(131972)); // widget web
    await post(incoming(undefined)); // sin inbox
    await settle();
    expect(engine.handle).not.toHaveBeenCalled();

    await post(incoming(146313));
    await settle();
    expect(engine.handle).toHaveBeenCalledTimes(1);
  });

  it("ignora mensajes repetidos (reintentos de Chatwoot)", async () => {
    const { post, engine, settle } = await start();
    const m = incoming(146313);
    await post(m);
    await post(m);
    await settle();
    expect(engine.handle).toHaveBeenCalledTimes(1);
  });

  it("el eco de un mensaje propio no silencia al bot; una persona sí", async () => {
    const { post, engine, echo, settle } = await start();
    echo.recordText("77", "Pasame tu DNI");
    const saliente = (content: string, id = 1) => ({ event: "message_created", id, message_type: "outgoing", content, account: { id: 182533 }, conversation: { id: 77, inbox_id: 146313 }, sender: { id: 5, type: "user" } });

    await post(saliente("Pasame tu DNI"));
    echo.recordId(99);
    await post(saliente("texto que no coincide", 99)); // eco por ID
    await settle();
    expect(engine.markHandedOff).not.toHaveBeenCalled();

    await post(saliente("Hola, te atiendo yo", 100)); // persona (mismo usuario del token)
    await settle();
    expect(engine.markHandedOff).toHaveBeenCalledWith("77");
  });

  it("un saliente con botones o lista no calla al bot (lo manda un bot, aunque sea otra instancia)", async () => {
    const { post, engine, settle } = await start();
    await post({ event: "message_created", id: 5, message_type: "outgoing", content: "¿Qué operadora vas a cargar?", content_type: "input_select", account: { id: 182533 }, conversation: { id: 77, inbox_id: 146313 }, sender: { id: 5, type: "user" } });
    await settle();
    expect(engine.markHandedOff).not.toHaveBeenCalled();
  });

  it("recién arrancado (deploy o reinicio), un saliente desconocido no calla al bot", async () => {
    const { post, engine, settle } = await start({ gracia: 60_000 });
    await post({ event: "message_created", id: 6, message_type: "outgoing", content: "📋 Lista 2 de 2 de operadoras", account: { id: 182533 }, conversation: { id: 77, inbox_id: 146313 }, sender: { id: 5, type: "user" } });
    await settle();
    expect(engine.markHandedOff).not.toHaveBeenCalled();
  });

  it("una conversación resuelta se resetea", async () => {
    const { post, engine, settle } = await start();
    // Forma real: la conversación viene aplanada, con inbox_id al primer nivel.
    await post({ event: "conversation_status_changed", id: 77, status: "resolved", inbox_id: 146313 });
    await post({ event: "conversation_status_changed", id: 78, status: "resolved", inbox_id: 134690 }); // de Enri
    await settle();
    expect(engine.reset).toHaveBeenCalledTimes(1);
    expect(engine.reset).toHaveBeenCalledWith("77");
  });
});
