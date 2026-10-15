/**
 * Tipos de la API Vencimientos Añelo (ver "API_Vencimientos_Anelo_BOT.pdf",
 * versión del 2026-10-13). Las respuestas se validan con Zod: si SEA WHITE
 * cambia el formato, el bot lo detecta en vez de informar algo equivocado.
 */
import { z } from "zod";

export type TipoRegistro = "chofer" | "dominio";

export class SeaWhiteError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SeaWhiteError";
  }
}

export const authResponseSchema = z.object({
  token: z.string().min(1),
  valido_hasta_utc: z.string().optional(),
  expira_en_minutos: z.number().optional(),
});

/** Respuesta de GET /api/VencimientosAnelo/{chofer|dominio}. */
export const consultaResponseSchema = z.object({
  ok: z.boolean(),
  id: z.number().optional(),
  cliente: z.string().optional(),
  subcliente: z.string().optional(),
  chofer: z.string().optional(),
  dominio: z.string().optional(),
  vencimiento: z.string().optional(),
  nombreArchivoOriginal: z.string().nullable().optional(),
  fechaAlta: z.string().nullable().optional(),
  fechaModificacion: z.string().nullable().optional(),
  mensaje: z.string().optional(),
});
export type ConsultaResponse = z.infer<typeof consultaResponseSchema>;

/** Un resultado por registro dentro de la respuesta de carga. */
export const resultadoCargaSchema = z.object({
  ok: z.boolean(),
  cliente: z.string().optional(),
  subcliente: z.string().optional(),
  chofer: z.string().optional(),
  dominio: z.string().optional(),
  id: z.number().optional(),
  accion: z.string().optional(), // "CREADO" | "ACTUALIZADO"
  archivo: z.string().optional(),
  mensaje: z.string().optional(),
});
export type ResultadoCarga = z.infer<typeof resultadoCargaSchema>;

/** Respuesta de POST /api/VencimientosAnelo/{chofer|dominio}. */
export const cargaResponseSchema = z.object({
  ok: z.boolean(),
  total: z.number().optional(),
  procesadosCorrectamente: z.number().optional(),
  errores: z.number().optional(),
  resultados: z.array(resultadoCargaSchema).optional(),
  mensaje: z.string().optional(),
});
export type CargaResponse = z.infer<typeof cargaResponseSchema>;

/** Registro listo para cargar (ya validado). */
export interface RegistroCarga {
  cliente: string;
  subcliente: string;
  /** DNI (chofer) o patente (dominio), normalizado. */
  identificador: string;
  /** Formato de la API: dd-MM-yyyy. */
  vencimiento: string;
  pdf: Buffer;
}

/** Resultado normalizado de una consulta. */
export type Consulta =
  | {
      found: true;
      tipo: TipoRegistro;
      id: number;
      cliente: string;
      subcliente: string;
      identificador: string;
      vencimiento: string;
      fechaAlta: string | null;
      fechaModificacion: string | null;
    }
  | { found: false; tipo: TipoRegistro; identificador: string; mensaje?: string };

/** Respuesta de POST /api/vencimientos/chofer (consulta de documentación, igual que Enri). */
export const documentacionChoferSchema = z.object({
  ok: z.boolean(),
  Razon_Social: z.string().nullable().optional(),
  Licencia_Vto: z.string().nullable().optional(),
  F931_Vto: z.string().nullable().optional(),
  ART_Vto: z.string().nullable().optional(),
});

/** Respuesta de POST /api/vencimientos/camion. */
export const documentacionCamionSchema = z.object({
  ok: z.boolean(),
  Vto_Seguro: z.string().nullable().optional(),
  Vto_Vtv: z.string().nullable().optional(),
});

/** Documentación general (fechas tal como vienen de la API, o null). */
export type Documentacion =
  | { found: true; tipo: "chofer"; nombre: string | null; licencia: string | null; art: string | null; f931: string | null }
  | { found: true; tipo: "dominio"; seguro: string | null; vtv: string | null }
  | { found: false };

/** Resultado normalizado de una carga (todos los lotes juntos). */
export interface ResumenCarga {
  total: number;
  correctos: number;
  errores: number;
  resultados: Array<{ identificador: string; ok: boolean; accion?: string; id?: number; mensaje?: string }>;
}
