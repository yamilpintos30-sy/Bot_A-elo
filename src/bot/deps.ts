/**
 * Dependencias de los flujos del bot. Son interfaces para poder testear todo
 * con dobles (sin Claude, sin SEA WHITE, sin Chatwoot, sin Supabase).
 */
import type { OnEtapa, ProcesamientoResultado } from "../extraction/procesarCarnets.js";
import type { CodigoNombre, Consulta, Documentacion, FilaListado, RegistroCarga, ResumenCarga, TipoRegistro } from "../integrations/seawhite/types.js";
import type { ResultadoVerificacion } from "../extraction/verificadorComprobantes.js";
import type { ListaTelefonos } from "../storage/cargadores.js";
import type { FallasRepo } from "../storage/fallas.js";
import type { CatalogoRepo } from "../storage/catalogo.js";
import type { RegistroRepo } from "../storage/registro.js";
import type { MessageLog, SessionStore } from "../storage/sessions.js";
import type { Logger } from "../utils/logger.js";
import type { Outbound } from "./types.js";

/** Lo que el bot usa de la API de SEA WHITE (AneloClient lo implementa). */
export interface SeaWhiteService {
  consultar(tipo: TipoRegistro, cliente: string, subcliente: string, identificador: string): Promise<Consulta>;
  /** Clientes donde ese DNI o dominio tiene habilitación VIGENTE (APIs 1 y 7 del manual). */
  clientesHabilitados(tipo: TipoRegistro, identificador: string): Promise<CodigoNombre[]>;
  /** Subclientes (operadoras) vigentes de ese DNI o dominio en un cliente (APIs 2 y 8). */
  subclientesHabilitados(tipo: TipoRegistro, identificador: string, cliente: string): Promise<CodigoNombre[]>;
  /** Logística: choferes por nombre (API 6, sin filtro de vigencia). `codigo` = DNI. */
  buscarChoferes(texto: string): Promise<CodigoNombre[]>;
  /** Logística: clientes con algún chofer (API 3) o dominio (API 9) vigente. */
  clientesConVigentes(tipo: TipoRegistro): Promise<CodigoNombre[]>;
  /** Logística: subclientes de un cliente con algún chofer (API 4) o dominio (API 10) vigente. */
  subclientesConVigentes(tipo: TipoRegistro, cliente: string): Promise<CodigoNombre[]>;
  /** Logística: todos los choferes (API 5) o dominios (API 11) vigentes de un cliente y subcliente. */
  listadoVigentes(tipo: TipoRegistro, cliente: string, subcliente: string): Promise<FilaListado[]>;
  documentacion(tipo: TipoRegistro, identificador: string): Promise<Documentacion>;
  descargarPdf(tipo: TipoRegistro, id: number): Promise<Buffer>;
  /** Razón social del chofer por su teléfono (para el saludo); null si no está. */
  nombrePorTelefono(telefono: string): Promise<string | null>;
  /** Comprobante de VTV o seguro por dominio (con el nombre del archivo); null si no existe. */
  documentoVehiculo(tipo: "vtv" | "seguro", dominio: string): Promise<{ pdf: Buffer; nombreArchivo: string | null } | null>;
  cargar(tipo: TipoRegistro, registros: RegistroCarga[]): Promise<ResumenCarga>;
}

export interface Procesador {
  procesar(pdf: Buffer, filename: string, onEtapa?: OnEtapa): Promise<ProcesamientoResultado>;
}

export interface BotDeps {
  botName: string;
  timezone: string;
  catalogo: CatalogoRepo;
  /** Pueden cargar documentación. */
  cargadores: ListaTelefonos;
  /** Pueden consultar (choferes). Si un número no está en ninguna lista, no se le responde. */
  consultores: ListaTelefonos;
  /** Logística: consultas individuales (también por nombre) y listados grupales en PDF. */
  logistica: ListaTelefonos;
  registro: RegistroRepo;
  sessions: SessionStore;
  log: MessageLog;
  seawhite: SeaWhiteService;
  procesador: Procesador;
  descargarAdjunto: (url: string) => Promise<Buffer>;
  /** Resguardo de VTV/seguro: verifica las tres patentes antes de entregar. */
  verificador: { verificar(pdf: Buffer, tipo: "vtv" | "seguro", patente: string, nombreArchivo: string | null): Promise<ResultadoVerificacion> };
  fallas: FallasRepo;
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
  /** Tipos ya cargados de este documento (en un documento mezclado se cargan de a uno). */
  tiposCargados?: TipoRegistro[];
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
