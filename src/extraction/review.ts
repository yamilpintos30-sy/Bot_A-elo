/**
 * Revisión final de los carnets extraídos, SIN IA (función pura, testeable).
 *
 * Un carnet queda listo para cargar sólo si:
 *   1. Su PDF existe, es un PDF real y no supera el tamaño máximo.
 *   2. El DNI o la patente tiene un formato válido.
 *   3. El vencimiento es una fecha real.
 *   4. La lectura independiente (verifier) coincide en tipo, identificador y
 *      vencimiento, y confirma que el recorte tiene un solo carnet.
 *   5. No está repetido en el mismo PDF (si lo está, queda el de vencimiento más lejano).
 * Lo demás se rechaza con el motivo, para informárselo a quien cargó.
 */
import { isPdf } from "../integrations/seawhite/aneloClient.js";
import type { TipoRegistro } from "../integrations/seawhite/types.js";
import { normalizeDni, normalizePatente } from "../domain/validators.js";
import { diffDays, formatApi, parseCalendarDate, type CalendarDate } from "../utils/dates.js";
import type { CarnetManifest, Manifest, VerificacionDocumento } from "./manifest.js";

/** Tope por carnet: el sandbox apunta a <300 KB; esto es la red de seguridad. */
export const MAX_PDF_BYTES = 1_500_000;
/** En un listado cada registro lleva el documento COMPLETO (la constancia): se admite más. */
export const MAX_LISTADO_BYTES = 10_000_000;

export interface CarnetListo {
  tipo: TipoRegistro;
  identificador: string;
  /** dd-MM-yyyy, listo para la API. */
  vencimiento: string;
  apellidoNombre: string | null;
  clienteDetectado: string | null;
  pagina: number;
  observaciones: string | null;
  /** Qué documento vence en esa fecha (para el aviso de vencido). */
  motivoVencimiento: string | null;
  /** true si la fecha ya pasó (se carga igual: refleja el estado real, pero se avisa). */
  vencido: boolean;
  pdf: Buffer;
}

export interface CarnetRechazado {
  pagina: number | null;
  referencia: string;
  motivo: string;
}

export interface ReviewResult {
  aceptados: CarnetListo[];
  rechazados: CarnetRechazado[];
}

export interface ReviewInput {
  manifest: Manifest;
  archivos: Map<string, Buffer>;
  verificacion: Map<string, VerificacionDocumento>;
  hoy: CalendarDate;
}

function normalizarId(tipo: TipoRegistro, valor: string | null | undefined): string | null {
  if (!valor) return null;
  const r = tipo === "chofer" ? normalizeDni(valor) : normalizePatente(valor);
  return r.ok ? r.value : null;
}

function referencia(c: CarnetManifest): string {
  return c.apellidoNombre ? `${c.apellidoNombre} (${c.identificador ?? "sin identificador"})` : (c.identificador ?? c.archivo);
}

export function reviewCarnets(input: ReviewInput): ReviewResult {
  const { manifest, archivos, verificacion, hoy } = input;
  const rechazados: CarnetRechazado[] = manifest.descartados.map((d) => ({ pagina: d.pagina ?? null, referencia: "—", motivo: d.motivo }));
  const candidatos: CarnetListo[] = [];

  for (const c of manifest.carnets) {
    const rechazar = (motivo: string) => rechazados.push({ pagina: c.pagina, referencia: referencia(c), motivo });

    const pdf = archivos.get(c.archivo);
    if (!pdf) {
      rechazar("No se generó el PDF del carnet.");
      continue;
    }
    if (!isPdf(pdf)) {
      rechazar("El archivo generado no es un PDF válido.");
      continue;
    }
    const tope = manifest.modo === "listado" ? MAX_LISTADO_BYTES : MAX_PDF_BYTES;
    if (pdf.length > tope) {
      rechazar(`El PDF pesa demasiado (${Math.round(pdf.length / 1024)} KB).`);
      continue;
    }

    const identificador = normalizarId(c.tipo, c.identificador);
    if (!identificador) {
      rechazar(c.tipo === "chofer" ? "El DNI no se pudo leer o no es válido." : "La patente no se pudo leer o no es válida.");
      continue;
    }

    const fecha = parseCalendarDate(c.vencimiento);
    if (!fecha) {
      rechazar("El vencimiento no se pudo leer o no es una fecha válida.");
      continue;
    }

    const v = verificacion.get(c.archivo);
    if (!v) {
      rechazar("No se pudo hacer la verificación independiente del carnet.");
      continue;
    }
    const vId = normalizarId(c.tipo, v.identificador);
    const vFecha = parseCalendarDate(v.vencimiento);
    const diferencias: string[] = [];
    if (v.tipo !== c.tipo) diferencias.push(`tipo (${v.tipo})`);
    if (vId !== identificador) diferencias.push(`${c.tipo === "chofer" ? "DNI" : "patente"} (leyó ${v.identificador ?? "nada"})`);
    if (!vFecha || formatApi(vFecha) !== formatApi(fecha)) diferencias.push(`vencimiento (leyó ${v.vencimiento ?? "nada"})`);
    if (!v.unSoloCarnet) diferencias.push("el recorte no tiene exactamente un carnet");
    if (diferencias.length > 0) {
      rechazar(`La verificación no coincide: ${diferencias.join(", ")}.`);
      continue;
    }

    candidatos.push({
      tipo: c.tipo,
      identificador,
      vencimiento: formatApi(fecha),
      apellidoNombre: c.apellidoNombre?.trim() || null,
      clienteDetectado: c.clienteDetectado?.trim() || null,
      pagina: c.pagina,
      observaciones: c.observaciones?.trim() || null,
      motivoVencimiento: c.motivoVencimiento?.trim() || null,
      vencido: diffDays(hoy, fecha) < 0,
      pdf,
    });
  }

  // Repetidos: queda el de vencimiento más lejano.
  const porClave = new Map<string, CarnetListo>();
  for (const c of candidatos) {
    const clave = `${c.tipo}:${c.identificador}`;
    const previo = porClave.get(clave);
    if (!previo) {
      porClave.set(clave, c);
      continue;
    }
    const [queda, sale] = diffDays(parseCalendarDate(previo.vencimiento)!, parseCalendarDate(c.vencimiento)!) > 0 ? [c, previo] : [previo, c];
    porClave.set(clave, queda);
    rechazados.push({ pagina: sale.pagina, referencia: sale.apellidoNombre ?? sale.identificador, motivo: `Repetido en el PDF: se usa el de la página ${queda.pagina} (vence ${queda.vencimiento}).` });
  }

  return { aceptados: [...porClave.values()], rechazados };
}
