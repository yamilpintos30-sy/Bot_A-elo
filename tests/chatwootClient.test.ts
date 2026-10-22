/**
 * Envío de botones a Chatwoot: `fetch` falso, ningún test sale a la red.
 */
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { ChatwootClient } from "../src/channels/chatwoot/client.js";
import { EchoGuard } from "../src/channels/chatwoot/echoGuard.js";

function cliente() {
  const cuerpos: unknown[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    cuerpos.push(JSON.parse(String(init?.body)));
    return Response.json({ id: 1 });
  }) as unknown as typeof fetch;
  const c = new ChatwootClient({ baseUrl: "https://cw.test", apiToken: "t", accountId: 1, logger: pino({ level: "silent" }), echo: new EchoGuard(), fetchImpl });
  return { c, cuerpos };
}

describe("botones de Chatwoot", () => {
  it("botones comunes: título y valor, sin descripción", async () => {
    const { c, cuerpos } = cliente();
    await c.sendButtons("9", "¿Qué querés?", [{ title: "🪪 Por DNI", payload: "m:chofer" }]);
    expect(cuerpos[0]).toMatchObject({ content_type: "input_select", content_attributes: { items: [{ title: "🪪 Por DNI", value: "m:chofer" }] } });
    expect((cuerpos[0] as { content_attributes: { items: object[] } }).content_attributes.items[0]).not.toHaveProperty("description");
  });

  it("opciones de lista con descripción (el DNI debajo del nombre), cortada a 72", async () => {
    const { c, cuerpos } = cliente();
    await c.sendButtons("9", "¿Cuál es?", [{ title: "Perez Juan", payload: "hn:30111222", description: `DNI 30111222 ${"x".repeat(100)}` }]);
    const item = (cuerpos[0] as { content_attributes: { items: Array<{ description: string }> } }).content_attributes.items[0]!;
    expect(item).toMatchObject({ title: "Perez Juan", value: "hn:30111222" });
    expect(item.description).toHaveLength(72);
  });
});
