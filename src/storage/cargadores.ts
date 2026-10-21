/**
 * Listas de números habilitados (se reemplazan enteras al subir el .txt desde el panel):
 *   - anelo_cargadores:  pueden CARGAR documentación.
 *   - anelo_consultores: pueden CONSULTAR (choferes). La app es cerrada: a un
 *     número que no está en ninguna de las dos listas no se le responde.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { nationalPhone } from "../utils/phones.js";
import { check } from "./supabase.js";

export interface ListaTelefonos {
  contiene(phone: string | null | undefined): Promise<boolean>;
  listar(): Promise<string[]>;
  reemplazar(phones: string[]): Promise<void>;
}

export type TablaTelefonos = "anelo_cargadores" | "anelo_consultores";

const CACHE_MS = 30_000;

export class SupabaseListaTelefonos implements ListaTelefonos {
  private cache: { at: number; set: Set<string> } | null = null;

  constructor(
    private readonly db: SupabaseClient,
    private readonly tabla: TablaTelefonos,
  ) {}

  async contiene(phone: string | null | undefined): Promise<boolean> {
    const n = phone ? nationalPhone(phone) : null;
    if (!n) return false;
    if (!this.cache || Date.now() - this.cache.at > CACHE_MS) {
      this.cache = { at: Date.now(), set: new Set(await this.listar()) };
    }
    return this.cache.set.has(n);
  }

  async listar(): Promise<string[]> {
    const rows = check(await this.db.from(this.tabla).select("telefono").order("telefono"), this.tabla) as Array<{ telefono: string }>;
    return rows.map((r) => r.telefono);
  }

  async reemplazar(phones: string[]): Promise<void> {
    check(await this.db.from(this.tabla).delete().neq("telefono", ""), `borrar ${this.tabla}`);
    if (phones.length > 0) {
      check(await this.db.from(this.tabla).insert(phones.map((telefono) => ({ telefono }))), `guardar ${this.tabla}`);
    }
    this.cache = null;
  }
}

export class MemoryListaTelefonos implements ListaTelefonos {
  constructor(private phones: string[] = []) {}
  async contiene(phone: string | null | undefined): Promise<boolean> {
    const n = phone ? nationalPhone(phone) : null;
    return n !== null && this.phones.includes(n);
  }
  async listar(): Promise<string[]> {
    return [...this.phones];
  }
  async reemplazar(phones: string[]): Promise<void> {
    this.phones = [...phones];
  }
}
