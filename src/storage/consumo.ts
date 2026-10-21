/**
 * Consumo de Claude del bot Añelo (tabla anelo_consumo): una fila por llamada, con
 * qué función la hizo, el modelo que respondió y los tokens. El panel lo pasa a
 * dólares (pestaña Costos).
 *
 * Nunca frena al bot: se guarda en segundo plano y, si falla, sólo se loguea.
 * Sin Supabase (o en los tests) no hace nada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "../utils/logger.js";

const TABLA = "anelo_consumo";

/** Lo que importa del `usage` de una respuesta de Claude. */
export interface UsoClaude {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  /** En el sandbox trae code_execution_requests; en las demás llamadas, otros campos o nada. */
  server_tool_use?: object | null;
}

export interface FilaConsumo {
  funcion: string;
  modelo: string;
  entrada: number;
  escritura_5m: number;
  escritura_1h: number;
  lectura: number;
  salida: number;
  sandbox: number;
}

/** Fila a guardar. Si la respuesta no separa la escritura en caché por duración, va como 5 minutos. */
export function filaConsumo(funcion: string, modelo: string, u: UsoClaude): FilaConsumo {
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? null;
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? null;
  return {
    funcion,
    modelo,
    entrada: u.input_tokens ?? 0,
    escritura_5m: w5 ?? (w1 === null ? (u.cache_creation_input_tokens ?? 0) : 0),
    escritura_1h: w1 ?? 0,
    lectura: u.cache_read_input_tokens ?? 0,
    salida: u.output_tokens ?? 0,
    sandbox: (u.server_tool_use as { code_execution_requests?: number | null } | null | undefined)?.code_execution_requests ?? 0,
  };
}

let destino: { db: SupabaseClient; logger: Logger } | null = null;

/** Se llama una vez al arrancar. */
export function configurarConsumo(db: SupabaseClient | null | undefined, logger: Logger): void {
  destino = db ? { db, logger } : null;
}

/** Anota una llamada a Claude (en segundo plano). */
export function registrarConsumo(funcion: string, modelo: string, usage: UsoClaude | null | undefined): void {
  if (!destino || !usage) return;
  const { db, logger } = destino;
  const fila = filaConsumo(funcion, modelo, usage);
  void Promise.resolve(db.from(TABLA).insert(fila)).then(
    ({ error }) => {
      if (error) logger.warn({ err: error.message, funcion }, "No se pudo registrar el consumo de Claude");
    },
    (err: unknown) => logger.warn({ err: (err as Error).message, funcion }, "No se pudo registrar el consumo de Claude"),
  );
}
