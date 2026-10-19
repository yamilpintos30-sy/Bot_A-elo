/**
 * Dependencias de los flujos del bot. Son interfaces para poder testear todo
 * con dobles (sin Claude, sin SEA WHITE, sin Chatwoot, sin Supabase).
 */
import type { EtapaProceso, ProcesamientoResultado } from "../extraction/procesarCarnets.js";
import type { Consulta, Documentacion, RegistroCarga, ResumenCarga, TipoRegistro } from "../integrations/seawhite/types.js";
import type { CargadoresRepo } from "../storage/cargadores.js";
import type { CatalogoRepo } from "../storage/catalogo.js";
import type { RegistroRepo } from "../storage/registro.js";
import type { MessageLog, SessionStore } from "../storage/sessions.js";
import type { Logger } from "../utils/logger.js";
import type { Outbound } from "./types.js";

/** Lo que el bot usa de la API de SEA WHITE (AneloClient lo implementa). */
export interface SeaWhiteService {
  consultar(tipo: TipoRegistro, cliente: string, subcliente: string, identificador: string): Promise<Consulta>;
  documentacion(tipo: TipoRegistro, identificador: string): Promise<Documentacion>;
  descargarPdf(tipo: TipoRegistro, id: number): Promise<Buffer>;
  /** Comprobante de VTV o seguro por dominio; null si no existe. */
  documentoVehiculo(tipo: "vtv" | "seguro", dominio: string): Promise<Buffer | null>;
  cargar(tipo: TipoRegistro, registros: RegistroCarga[]): Promise<ResumenCarga>;
}

export interface Procesador {
  procesar(pdf: Buffer, filename: string, onEtapa?: (etapa: EtapaProceso) => Promise<void> | void): Promise<ProcesamientoResultado>;
}

export interface BotDeps {
  botName: string;
  timezone: string;
  catalogo: CatalogoRepo;
  cargadores: CargadoresRepo;
  registro: RegistroRepo;
  sessions: SessionStore;
  log: MessageLog;
  seawhite: SeaWhiteService;
  procesador: Procesador;
  descargarAdjunto: (url: string) => Promise<Buffer>;
  lotes: LotesPendientes;
  logger: Logger;
  now: () => Date;
}

/** Envía un mensaje al chat en el momento (los flujos avisan "procesando..." antes de terminar). */
export type Emit = (out: Outbound) => Promise<void>;

/** Lote procesado que espera el botón Confirmar. */
export interface LotePendiente {
  /** Tipo que eligió el cargador en el menú (chofer o dominio). */
  tipo: TipoRegistro;
  cargaId: number | null;
  clienteCodigo: string;
  plantaCodigo: string;
  destino: string;
  archivo: string;
  resultado: ProcesamientoResultado;
}

/**
 * Lotes pendientes de confirmar, en memoria: tienen los PDF recortados, que no
 * tiene sentido guardar en la base. Si el bot se reinicia antes de confirmar,
 * se pide el PDF de nuevo (expiran solos en 1 hora).
 */
export class LotesPendientes {
  private readonly lotes = new Map<string, { lote: LotePendiente; expira: number }>();
  private seq = 0;

  constructor(
    private readonly ttlMs = 60 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  guardar(lote: LotePendiente): string {
    this.limpiar();
    const id = `lote-${++this.seq}-${this.now()}`;
    this.lotes.set(id, { lote, expira: this.now() + this.ttlMs });
    return id;
  }

  obtener(id: string | undefined): LotePendiente | undefined {
    if (!id) return undefined;
    const e = this.lotes.get(id);
    if (!e || e.expira < this.now()) {
      this.lotes.delete(id ?? "");
      return undefined;
    }
    return e.lote;
  }

  borrar(id: string | undefined): void {
    if (id) this.lotes.delete(id);
  }

  private limpiar(): void {
    const ahora = this.now();
    for (const [id, e] of this.lotes) if (e.expira < ahora) this.lotes.delete(id);
  }
}
