/**
 * Números habilitados para CARGAR documentación (tabla anelo_cargadores).
 * Se reemplaza entero al subir el .txt desde el panel.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { nationalPhone } from "../utils/phones.js";
import { check } from "./supabase.js";

export interface CargadoresRepo {
  esCargador(phone: string | null | undefined): Promise<boolean>;
  listar(): Promise<string[]>;
  reemplazar(phones: string[]): Promise<void>;
}

const CACHE_MS = 30_000;

export class SupabaseCargadores implements CargadoresRepo {
  private cache: { at: number; set: Set<string> } | null = null;

  constructor(private readonly db: SupabaseClient) {}

  async esCargador(phone: string | null | undefined): Promise<boolean> {
    const n = phone ? nationalPhone(phone) : null;
    if (!n) return false;
    if (!this.cache || Date.now() - this.cache.at > CACHE_MS) {
      this.cache = { at: Date.now(), set: new Set(await this.listar()) };
    }
    return this.cache.set.has(n);
  }

  async listar(): Promise<string[]> {
    const rows = check(await this.db.from("anelo_cargadores").select("telefono").order("telefono"), "cargadores") as Array<{ telefono: string }>;
    return rows.map((r) => r.telefono);
  }

  async reemplazar(phones: string[]): Promise<void> {
    check(await this.db.from("anelo_cargadores").delete().neq("telefono", ""), "borrar cargadores");
    if (phones.length > 0) {
      check(await this.db.from("anelo_cargadores").insert(phones.map((telefono) => ({ telefono }))), "guardar cargadores");
    }
    this.cache = null;
  }
}

export class MemoryCargadores implements CargadoresRepo {
  constructor(private phones: string[] = []) {}
  async esCargador(phone: string | null | undefined): Promise<boolean> {
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
