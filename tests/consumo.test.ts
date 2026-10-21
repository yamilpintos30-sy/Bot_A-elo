/**
 * Consumo de Claude (pestaña Costos del panel): cada llamada que pasa por el
 * ClaudeRunner queda anotada en anelo_consumo con su función, y si la base
 * falla el bot sigue igual.
 */
import { afterEach, describe, expect, it } from "vitest";
import pino from "pino";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ClaudeRunner, emptyUsage } from "../src/extraction/claudeRunner.js";
import { configurarConsumo } from "../src/storage/consumo.js";

const logger = pino({ level: "silent" });

function claudeFalso() {
  const mensaje = {
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 400, cache_creation_input_tokens: 0, server_tool_use: { code_execution_requests: 1 } },
  };
  return { beta: { messages: { stream: () => ({ finalMessage: async () => mensaje }) } } } as unknown as Anthropic;
}

function baseFalsa(falla = false) {
  const inserts: Array<{ tabla: string; fila: Record<string, unknown> }> = [];
  const db = {
    from: (tabla: string) => ({
      insert: async (fila: Record<string, unknown>) => {
        inserts.push({ tabla, fila });
        return { error: falla ? { message: "caída" } : null };
      },
    }),
  } as unknown as SupabaseClient;
  return { db, inserts };
}

afterEach(() => configurarConsumo(null, logger));

describe("consumo de Claude", () => {
  it("cada llamada queda anotada en anelo_consumo con su función, modelo y tokens", async () => {
    const { db, inserts } = baseFalsa();
    configurarConsumo(db, logger);
    const runner = new ClaudeRunner("k", logger, false, claudeFalso());
    await runner.run({ model: "claude-opus-5-5", max_tokens: 10, messages: [] }, emptyUsage(), "consulta: resguardo VTV/seguro");
    await new Promise((r) => setTimeout(r, 0)); // se guarda en segundo plano
    expect(inserts).toEqual([
      {
        tabla: "anelo_consumo",
        fila: { funcion: "consulta: resguardo VTV/seguro", modelo: "claude-opus-5-5", entrada: 120, escritura_5m: 0, escritura_1h: 0, lectura: 400, salida: 30, sandbox: 1 },
      },
    ]);
  });

  it("si la base falla, la llamada a Claude responde igual", async () => {
    const { db } = baseFalsa(true);
    configurarConsumo(db, logger);
    const runner = new ClaudeRunner("k", logger, false, claudeFalso());
    const msg = await runner.run({ model: "claude-opus-5-5", max_tokens: 10, messages: [] }, emptyUsage(), "carga: verificar datos");
    expect(msg.model).toBe("claude-opus-5-5");
  });

  it("sin Supabase configurado no anota nada (CLI y tests)", async () => {
    const runner = new ClaudeRunner("k", logger, false, claudeFalso());
    await expect(runner.run({ model: "claude-opus-5-5", max_tokens: 10, messages: [] }, emptyUsage())).resolves.toBeTruthy();
  });
});
