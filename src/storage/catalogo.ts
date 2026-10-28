/**
 * Operadoras (clientes) y pozos (subclientes) para el menú de carga.
 *
 * Desde el 27-oct-2026 salen SIEMPRE de la API de SEA WHITE
 * ("Instructivo_BOT_Operadoras_Pozos_SeaWhite.pdf"):
 *   GET /api/VencimientosAnelo/operadoras
 *   GET /api/VencimientosAnelo/pozos
 * Las tablas anelo_clientes / anelo_plantas del panel ya no se leen.
 *
 * Las dos listas son independientes: cualquier pozo vale para cualquier
 * operadora, así que cada operadora lleva la lista completa de pozos.
 * Caché corta (se consulta en cada mensaje y casi nunca cambia). Si la API no
 * responde, se sigue con la última lista buena; si nunca hubo una, error.
 */
import type { CodigoNombre } from "../integrations/seawhite/types.js";
import type { Logger } from "../utils/logger.js";

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

/** Lo que el catálogo necesita de SEA WHITE (AneloClient lo implementa). */
export interface FuenteCatalogo {
  operadoras(): Promise<CodigoNombre[]>;
  pozos(): Promise<CodigoNombre[]>;
}

/** SEA WHITE no devolvió las operadoras y no hay una lista anterior para usar. */
export class CatalogoNoDisponibleError extends Error {}

const CACHE_MS = 60_000;

/**
 * Formas cortas con las que la gente nombra a la operadora:
 * "TOTAL AUSTRAL S.A." -> ["total austral", "total"] (la primera palabra si es distintiva).
 */
export function aliasDe(nombre: string): string[] {
  const base = nombre
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(s\.?\s?a\.?\s?u?\.?|s\.?r\.?l\.?|sucursal argentina|argentina)\b/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const primera = base.split(" ")[0] ?? "";
  return [...new Set([base, primera.length >= 4 ? primera : ""].filter(Boolean))];
}

const porNombre = (a: { nombre: string }, b: { nombre: string }) => a.nombre.localeCompare(b.nombre, "es", { numeric: true });

export class ApiCatalogo implements CatalogoRepo {
  private cache: { at: number; data: Cliente[] } | null = null;

  constructor(
    private readonly fuente: FuenteCatalogo,
    private readonly logger: Logger,
    private readonly cacheMs = CACHE_MS,
  ) {}

  async listar(): Promise<Cliente[]> {
    if (this.cache && Date.now() - this.cache.at < this.cacheMs) return this.cache.data;
    try {
      const [operadoras, pozos] = await Promise.all([this.fuente.operadoras(), this.fuente.pozos()]);
      const plantas: Planta[] = pozos.map((p) => ({ codigo: p.codigo, nombre: p.nombre || p.codigo, alias: [] })).sort(porNombre);
      const data: Cliente[] = operadoras
        .map((o) => ({ codigo: o.codigo, nombre: o.nombre || o.codigo, alias: aliasDe(o.nombre), plantas }))
        .sort(porNombre);
      this.cache = { at: Date.now(), data };
      return data;
    } catch (err) {
      if (this.cache) {
        this.logger.warn({ err }, "SEA WHITE no devolvió operadoras/pozos: se usa la última lista");
        return this.cache.data;
      }
      throw new CatalogoNoDisponibleError(`No se pudieron traer las operadoras y pozos de SEA WHITE: ${(err as Error).message}`);
    }
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
