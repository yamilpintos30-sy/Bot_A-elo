/**
 * Clientes y plantas (tablas anelo_clientes / anelo_plantas), con caché corta:
 * se consultan en cada mensaje y casi nunca cambian.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { check } from "./supabase.js";

export interface Planta {
  codigo: string;
  nombre: string;
  alias: string[];
}

export interface Cliente {
  codigo: string;
  nombre: string;
  alias: string[];
  plantas: Planta[];
}

export interface CatalogoRepo {
  listar(): Promise<Cliente[]>;
}

const CACHE_MS = 60_000;

export class SupabaseCatalogo implements CatalogoRepo {
  private cache: { at: number; data: Cliente[] } | null = null;

  constructor(private readonly db: SupabaseClient) {}

  async listar(): Promise<Cliente[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.data;
    const rows = check(
      await this.db
        .from("anelo_clientes")
        .select("codigo, nombre, alias, anelo_plantas(codigo, nombre, alias, activo)")
        .eq("activo", true)
        .order("nombre"),
      "clientes",
    ) as Array<{ codigo: string; nombre: string; alias: string[] | null; anelo_plantas: Array<{ codigo: string; nombre: string; alias: string[] | null; activo: boolean }> | null }>;
    const data = rows.map((c) => ({
      codigo: c.codigo,
      nombre: c.nombre,
      alias: c.alias ?? [],
      plantas: (c.anelo_plantas ?? [])
        .filter((p) => p.activo)
        .map((p) => ({ codigo: p.codigo, nombre: p.nombre, alias: p.alias ?? [] }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { numeric: true })),
    }));
    this.cache = { at: Date.now(), data };
    return data;
  }

  invalidate(): void {
    this.cache = null;
  }
}

export class MemoryCatalogo implements CatalogoRepo {
  constructor(public clientes: Cliente[]) {}
  async listar(): Promise<Cliente[]> {
    return this.clientes;
  }
}
