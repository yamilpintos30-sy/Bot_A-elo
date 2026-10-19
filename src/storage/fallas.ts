/**
 * Fallas críticas (tabla anelo_fallas): problemas que una persona tiene que
 * revisar. El panel (sección Bot Añelo) las muestra hasta que se marcan como
 * revisadas. Registrar una falla nunca interrumpe la conversación.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "../utils/logger.js";

export interface Falla {
  tipo: string; // p. ej. "comprobante_no_coincide"
  severidad: "critica" | "advertencia";
  descripcion: string;
  dominio?: string | null;
  conversationId?: string | null;
  telefono?: string | null;
  detalle?: Record<string, unknown>;
}

export interface FallasRepo {
  registrar(f: Falla): Promise<void>;
}

export class SupabaseFallas implements FallasRepo {
  constructor(
    private readonly db: SupabaseClient,
    private readonly logger: Logger,
  ) {}

  async registrar(f: Falla): Promise<void> {
    this.logger.error({ falla: f }, `FALLA ${f.severidad.toUpperCase()}: ${f.descripcion}`);
    const { error } = await this.db.from("anelo_fallas").insert({
      tipo: f.tipo,
      severidad: f.severidad,
      descripcion: f.descripcion,
      dominio: f.dominio ?? null,
      conversation_id: f.conversationId ?? null,
      telefono: f.telefono ?? null,
      detalle: f.detalle ?? {},
    });
    if (error) this.logger.error({ error: error.message }, "No se pudo registrar la falla en Supabase (quedó en el log)");
  }
}

export class MemoryFallas implements FallasRepo {
  fallas: Falla[] = [];
  async registrar(f: Falla): Promise<void> {
    this.fallas.push(f);
  }
}
