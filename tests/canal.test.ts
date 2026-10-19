/**
 * Orden de los mensajes: WhatsApp procesa un PDF más lento que un texto, y el
 * "¿Necesitás algo más?" llegaba antes que el carnet. El canal tiene que
 * esperar la ENTREGA del archivo antes de mandar lo siguiente.
 */
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { ChatwootChannel } from "../src/channels/chatwoot/channel.js";
import type { ChatwootClient } from "../src/channels/chatwoot/client.js";

describe("canal de Chatwoot", () => {
  it("después de mandar un PDF espera que WhatsApp lo entregue antes de seguir", async () => {
    const orden: string[] = [];
    const client = {
      sendFile: vi.fn(async () => {
        orden.push("pdf enviado");
        return "55";
      }),
      waitMessageDelivered: vi.fn(async (_c: string, id: string) => {
        orden.push(`esperando entrega ${id}`);
        return "delivered";
      }),
      sendButtons: vi.fn(async () => void orden.push("¿algo más?")),
    } as unknown as ChatwootClient;
    const canal = new ChatwootChannel(client, pino({ level: "silent" }));

    await canal.send("c1", { kind: "file", filename: "33615617.pdf", data: Buffer.from("%PDF-"), caption: "Carnet" });
    await canal.send("c1", { kind: "buttons", text: "¿Necesitás algo más?", buttons: [{ title: "Menú 😊", payload: "menu" }] });

    expect(orden).toEqual(["pdf enviado", "esperando entrega 55", "¿algo más?"]);
  });

  it("saludo como Enri: imagen con el saludo de epígrafe, espera la entrega y recién después los botones", async () => {
    const orden: string[] = [];
    const client = {
      sendImage: vi.fn(async (_c: string, caption: string, _img: Buffer, filename: string) => {
        orden.push(`imagen ${filename}: ${caption}`);
        return "77";
      }),
      waitMessageDelivered: vi.fn(async (_c: string, id: string) => {
        orden.push(`esperando entrega ${id}`);
        return "read";
      }),
      sendButtons: vi.fn(async () => void orden.push("menú")),
    } as unknown as ChatwootClient;
    const canal = new ChatwootChannel(client, pino({ level: "silent" }), "assets/javier.jpg", 0);

    await canal.send("c1", { kind: "image", caption: "¡Hola! 👋 Soy *Javier*" });
    await canal.send("c1", { kind: "buttons", text: "¿Qué querés consultar?", buttons: [{ title: "🪪 Por DNI", payload: "m:chofer" }] });

    expect(orden).toEqual(["imagen javier.jpg: ¡Hola! 👋 Soy *Javier*", "esperando entrega 77", "menú"]);
  });

  it("sin imagen configurada, el saludo sale como texto", async () => {
    const sendText = vi.fn(async () => undefined);
    const canal = new ChatwootChannel({ sendText } as unknown as ChatwootClient, pino({ level: "silent" }), "assets/no-existe.jpg", 0);
    await canal.send("c1", { kind: "image", caption: "¡Hola!" });
    expect(sendText).toHaveBeenCalledWith("c1", "¡Hola!");
  });
});
