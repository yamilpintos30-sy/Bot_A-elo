/**
 * Registro de cargas y carnets (tablas anelo_cargas / anelo_carnets).
 *
 * anelo_carnets guarda lo que la API de SEA WHITE no tiene (el nombre) y el id
 * de SEA WHITE de cada carnet. Con eso:
 *   - un chofer que sólo da su DNI ve TODAS las plantas donde está cargado;
 *   - el botón "Ver carnet" pide el PDF con ese id.
 * SEA WHITE sigue siendo la fuente de verdad del vencimiento: la consulta lo
 * vuelve a pedir allá.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TipoRegistro } from "../integrations/seawhite/types.js";
import { check } from "./supabase.js";

export interface CarnetRegistrado {
  clienteCodigo: string;
  plantaCodigo: string;
  tipo: TipoRegistro;
  identificador: string;
  apellidoNombre: string | null;
  /** dd-MM-yyyy */
  vencimiento: string;
  observaciones: string | null;
  /** Qué documento vence en esa fecha (para la lista de no habilitados del panel). */
  motivoVencimiento?: string | null;
  seawhiteId: number | null;
}

export interface NuevaCarga {
  conversationId: string;
  telefono: string | null;
  clienteCodigo: string;
  plantaCodigo: string;
  archivo: string;
}

export interface CargaTerminada {
  /**
   * cancelada: tocó Cancelar o cerró la conversación con la carga pendiente.
   * sin_confirmar: nunca confirmó (expiró, o el bot se reinició en el medio).
   */
  estado: "completada" | "con_errores" | "fallida" | "cancelada" | "sin_confirmar";
  total: number;
  correctos: number;
  errores: number;
  costoUsd: number | null;
  detalle: Record<string, unknown>;
}

export interface RegistroRepo {
  crearCarga(c: NuevaCarga): Promise<number | null>;
  terminarCarga(id: number | null, r: CargaTerminada): Promise<void>;
  /** Cargas que siguen "procesando" desde antes de `antesDe`: quedaron colgadas (reinicio). Devuelve cuántas cerró. */
  cerrarAbandonadas(antesDe: Date): Promise<number>;
  guardarCarnets(cargaId: number | null, carnets: CarnetRegistrado[]): Promise<void>;
  buscarCarnets(tipo: TipoRegistro, identificador: string): Promise<CarnetRegistrado[]>;
}

/** dd-MM-yyyy <-> yyyy-MM-dd (columna date). */
const toDb = (d: string) => d.split("-").reverse().join("-");
const fromDb = (d: string) => d.slice(0, 10).split("-").reverse().join("-");

export class SupabaseRegistro implements RegistroRepo {
  constructor(private readonly db: SupabaseClient) {}

  async crearCarga(c: NuevaCarga): Promise<number | null> {
    const row = check(
      await this.db
        .from("anelo_cargas")
        .insert({ conversation_id: c.conversationId, telefono: c.telefono, cliente_codigo: c.clienteCodigo, planta_codigo: c.plantaCodigo, archivo: c.archivo, estado: "procesando" })
        .select("id")
        .single(),
      "crear carga",
    ) as { id: number };
    return row.id;
  }

  async terminarCarga(id: number | null, r: CargaTerminada): Promise<void> {
    if (id === null) return;
    check(
      await this.db
        .from("anelo_cargas")
        .update({ estado: r.estado, total: r.total, correctos: r.correctos, errores: r.errores, costo_usd: r.costoUsd, detalle: r.detalle, finished_at: new Date().toISOString() })
        .eq("id", id),
      "terminar carga",
    );
  }

  async cerrarAbandonadas(antesDe: Date): Promise<number> {
    const filas = check(
      await this.db
        .from("anelo_cargas")
        .update({ estado: "sin_confirmar", finished_at: new Date().toISOString() })
        .eq("estado", "procesando")
        .lt("created_at", antesDe.toISOString())
        .select("id"),
      "cerrar cargas abandonadas",
    ) as Array<{ id: number }>;
    return filas.length;
  }

  async guardarCarnets(cargaId: number | null, carnets: CarnetRegistrado[]): Promise<void> {
    if (carnets.length === 0) return;
    const now = new Date().toISOString();
    const filas = carnets.map((c) => ({
      cliente_codigo: c.clienteCodigo,
      planta_codigo: c.plantaCodigo,
      tipo: c.tipo,
      identificador: c.identificador,
      apellido_nombre: c.apellidoNombre,
      vencimiento: toDb(c.vencimiento),
      observaciones: c.observaciones,
      motivo_vencimiento: c.motivoVencimiento ?? null,
      seawhite_id: c.seawhiteId,
      carga_id: cargaId,
      updated_at: now,
    }));
    const guardar = (rows: Array<Record<string, unknown>>) =>
      this.db.from("anelo_carnets").upsert(rows, { onConflict: "cliente_codigo,planta_codigo,tipo,identificador" });
    let r = await guardar(filas);
    // Sin la migración 0005 la columna no existe: se guarda igual, sin el motivo
    // (este registro es el que usa la consulta y el botón "Ver carnet").
    if (r.error && /motivo_vencimiento/.test(r.error.message)) r = await guardar(filas.map(({ motivo_vencimiento: _m, ...resto }) => resto));
    check(r, "guardar carnets");
  }

  async buscarCarnets(tipo: TipoRegistro, identificador: string): Promise<CarnetRegistrado[]> {
    const rows = check(
      await this.db
        .from("anelo_carnets")
        .select("cliente_codigo, planta_codigo, tipo, identificador, apellido_nombre, vencimiento, observaciones, seawhite_id")
        .eq("tipo", tipo)
        .eq("identificador", identificador)
        .order("vencimiento", { ascending: false }),
      "buscar carnets",
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      clienteCodigo: String(r.cliente_codigo),
      plantaCodigo: String(r.planta_codigo),
      tipo: r.tipo as TipoRegistro,
      identificador: String(r.identificador),
      apellidoNombre: (r.apellido_nombre as string | null) ?? null,
      vencimiento: fromDb(String(r.vencimiento)),
      observaciones: (r.observaciones as string | null) ?? null,
      seawhiteId: (r.seawhite_id as number | null) ?? null,
    }));
  }
}

export class MemoryRegistro implements RegistroRepo {
  carnets: CarnetRegistrado[] = [];
  cargas: Array<NuevaCarga & Partial<CargaTerminada> & { id: number; creada?: Date }> = [];

  async crearCarga(c: NuevaCarga): Promise<number> {
    const id = this.cargas.length + 1;
    this.cargas.push({ ...c, id, creada: new Date() });
    return id;
  }
  async terminarCarga(id: number | null, r: CargaTerminada): Promise<void> {
    const c = this.cargas.find((x) => x.id === id);
    if (c) Object.assign(c, r);
  }
  async cerrarAbandonadas(antesDe: Date): Promise<number> {
    const viejas = this.cargas.filter((c) => !c.estado && (c.creada ?? new Date(0)) < antesDe);
    for (const c of viejas) c.estado = "sin_confirmar";
    return viejas.length;
  }
  async guardarCarnets(_cargaId: number | null, carnets: CarnetRegistrado[]): Promise<void> {
    for (const c of carnets) {
      const i = this.carnets.findIndex((x) => x.clienteCodigo === c.clienteCodigo && x.plantaCodigo === c.plantaCodigo && x.tipo === c.tipo && x.identificador === c.identificador);
      if (i >= 0) this.carnets[i] = c;
      else this.carnets.push(c);
    }
  }
  async buscarCarnets(tipo: TipoRegistro, identificador: string): Promise<CarnetRegistrado[]> {
    return this.carnets.filter((c) => c.tipo === tipo && c.identificador === identificador);
  }
}
