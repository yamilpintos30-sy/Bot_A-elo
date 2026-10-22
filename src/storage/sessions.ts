/** Sesiones de conversación (tabla anelo_sessions) y registro de mensajes (anelo_messages). */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Rol, Session } from "../bot/types.js";
import type { Logger } from "../utils/logger.js";
import { check } from "./supabase.js";

export interface SessionStore {
  get(conversationId: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  delete(conversationId: string): Promise<void>;
  /**
   * Sesiones de CARGADORES inactivas desde entre `desde` y `hasta` (sin una
   * persona atendiendo): se borran y se devuelven. El borrado es condicional
   * (mismo updated_at), así que si hay dos instancias (deploy) sólo una la toma.
   */
  tomarInactivas(desde: Date, hasta: Date): Promise<Session[]>;
}

export class SupabaseSessions implements SessionStore {
  constructor(private readonly db: SupabaseClient) {}

  async get(conversationId: string): Promise<Session | null> {
    const row = check(
      await this.db.from("anelo_sessions").select("context, handed_off_until, updated_at").eq("conversation_id", conversationId).maybeSingle(),
      "leer sesión",
    ) as { context: Session; handed_off_until: string | null; updated_at: string } | null;
    if (!row) return null;
    return { ...row.context, conversationId, handedOffUntil: row.handed_off_until, updatedAt: row.updated_at };
  }

  async save(s: Session): Promise<void> {
    check(
      await this.db.from("anelo_sessions").upsert(
        { conversation_id: s.conversationId, telefono: s.phone, state: s.rol, context: s, handed_off_until: s.handedOffUntil, updated_at: s.updatedAt },
        { onConflict: "conversation_id" },
      ),
      "guardar sesión",
    );
  }

  async delete(conversationId: string): Promise<void> {
    check(await this.db.from("anelo_sessions").delete().eq("conversation_id", conversationId), "borrar sesión");
  }

  async tomarInactivas(desde: Date, hasta: Date): Promise<Session[]> {
    const ahora = new Date().toISOString();
    const filas = check(
      await this.db
        .from("anelo_sessions")
        .select("conversation_id, context, handed_off_until, updated_at")
        .eq("state", "cargador")
        .gte("updated_at", desde.toISOString())
        .lt("updated_at", hasta.toISOString())
        .or(`handed_off_until.is.null,handed_off_until.lt.${ahora}`),
      "buscar sesiones inactivas",
    ) as Array<{ conversation_id: string; context: Session; handed_off_until: string | null; updated_at: string }>;
    const tomadas: Session[] = [];
    for (const f of filas ?? []) {
      const borradas = check(
        await this.db.from("anelo_sessions").delete().eq("conversation_id", f.conversation_id).eq("updated_at", f.updated_at).select("conversation_id"),
        "cerrar sesión inactiva",
      ) as unknown[] | null;
      if (borradas && borradas.length > 0) tomadas.push({ ...f.context, conversationId: f.conversation_id, handedOffUntil: f.handed_off_until, updatedAt: f.updated_at });
    }
    return tomadas;
  }
}

export class MemorySessions implements SessionStore {
  private readonly map = new Map<string, Session>();
  async get(id: string): Promise<Session | null> {
    const s = this.map.get(id);
    return s ? structuredClone(s) : null;
  }
  async save(s: Session): Promise<void> {
    this.map.set(s.conversationId, structuredClone(s));
  }
  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }
  async tomarInactivas(desde: Date, hasta: Date): Promise<Session[]> {
    const ahora = Date.now();
    const tomadas: Session[] = [];
    for (const s of [...this.map.values()]) {
      const t = new Date(s.updatedAt).getTime();
      const atendida = s.handedOffUntil !== null && new Date(s.handedOffUntil).getTime() > ahora;
      if (s.rol === "cargador" && t >= desde.getTime() && t < hasta.getTime() && !atendida) {
        this.map.delete(s.conversationId);
        tomadas.push(structuredClone(s));
      }
    }
    return tomadas;
  }
}

export interface MessageLog {
  log(entry: { conversationId: string; phone: string | null; direction: "in" | "out"; rol: Rol; content: string; meta?: Record<string, unknown> }): Promise<void>;
}

/** Nunca interrumpe la conversación: los errores sólo se loguean. */
export class SupabaseMessageLog implements MessageLog {
  constructor(
    private readonly db: SupabaseClient,
    private readonly logger: Logger,
  ) {}
  async log(e: Parameters<MessageLog["log"]>[0]): Promise<void> {
    const { error } = await this.db
      .from("anelo_messages")
      .insert({ conversation_id: e.conversationId, telefono: e.phone, direction: e.direction, rol: e.rol, content: e.content, meta: e.meta ?? {} });
    if (error) this.logger.warn({ error: error.message }, "No se pudo registrar el mensaje");
  }
}

export class NoopMessageLog implements MessageLog {
  async log(): Promise<void> {}
}
