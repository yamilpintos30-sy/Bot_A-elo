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
      waitDelivered: vi.fn(async (_c: string, id: string) => {
        orden.push(`esperando entrega ${id}`);
        return true;
      }),
      sendButtons: vi.fn(async () => void orden.push("¿algo más?")),
    } as unknown as ChatwootClient;
    const canal = new ChatwootChannel(client, pino({ level: "silent" }));

    await canal.send("c1", { kind: "file", filename: "33615617.pdf", data: Buffer.from("%PDF-"), caption: "Carnet" });
    await canal.send("c1", { kind: "buttons", text: "¿Necesitás algo más?", buttons: [{ title: "Menú 😊", payload: "menu" }] });

    expect(orden).toEqual(["pdf enviado", "esperando entrega 55", "¿algo más?"]);
  });
});
