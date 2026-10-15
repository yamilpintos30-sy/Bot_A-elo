/**
 * Todos los textos que manda el bot, en un solo lugar.
 *
 *   - Cargadores: sólo datos, sin saludos ni cordialidades (pedido del equipo).
 *   - Choferes: trato de atención al público de una empresa, como Enri.
 */
import type { CarnetListo, CarnetRechazado } from "../extraction/review.js";
import type { Documentacion, ResumenCarga } from "../integrations/seawhite/types.js";
import { diffDays, parseCalendarDate, type CalendarDate } from "../utils/dates.js";

// --- Formato de fechas -----------------------------------------------------------

/** "18/10/2026" a partir de dd-MM-yyyy, ISO o dd/MM/yyyy. */
export function fecha(valor: string | null | undefined): string {
  const d = parseCalendarDate(valor);
  return d ? `${String(d.day).padStart(2, "0")}/${String(d.month).padStart(2, "0")}/${d.year}` : "sin dato";
}

/** "✅ 18/10/2026" o "❌ venció el 08/10/2026" (o "⚠️ vence en 3 días"). */
export function estadoFecha(valor: string | null | undefined, hoy: CalendarDate): string {
  const d = parseCalendarDate(valor);
  if (!d) return "⚪ sin dato";
  const dias = diffDays(hoy, d);
  if (dias < 0) return `❌ venció el ${fecha(valor)}`;
  if (dias === 0) return `⚠️ vence HOY (${fecha(valor)})`;
  if (dias <= 7) return `⚠️ ${fecha(valor)} (vence en ${dias} día${dias === 1 ? "" : "s"})`;
  return `✅ ${fecha(valor)}`;
}

/** Estado de una credencial de ingreso: "✅ habilitado hasta 18/10/2026", "❌ vencido el …". */
export function estadoCredencial(valor: string | null | undefined, hoy: CalendarDate): string {
  const d = parseCalendarDate(valor);
  if (!d) return "⚪ sin fecha de vencimiento";
  const dias = diffDays(hoy, d);
  if (dias < 0) return `❌ vencido el ${fecha(valor)}`;
  if (dias === 0) return `⚠️ habilitado solo HOY (${fecha(valor)})`;
  if (dias <= 7) return `⚠️ habilitado hasta ${fecha(valor)} (vence en ${dias} día${dias === 1 ? "" : "s"})`;
  return `✅ habilitado hasta ${fecha(valor)}`;
}

/** ¿La credencial está vigente hoy? */
export function vigente(valor: string | null | undefined, hoy: CalendarDate): boolean {
  const d = parseCalendarDate(valor);
  return d !== null && diffDays(hoy, d) >= 0;
}

// --- Cargadores ------------------------------------------------------------------

export const CARGA = {
  instrucciones: "Mandá cliente, planta y el PDF (en el mismo mensaje o por separado).\nEjemplo: *Total planta 1* + PDF",
  elegirCliente: "¿Para qué cliente es?",
  elegirPlanta: (cliente: string) => `¿Qué planta de ${cliente}?`,
  listaOpciones: (titulo: string, opciones: string[]) => `${titulo}\nEscribí una de estas opciones:\n${opciones.map((o) => `• ${o}`).join("\n")}`,
  plantaNoEncontrada: (cliente: string, plantas: string[]) => `No encontré esa planta en ${cliente}. Plantas: ${plantas.join(", ")}.`,
  pedirPdf: (destino: string) => `📄 Mandá el PDF para *${destino}*.`,
  soloPdf: "Solo se aceptan archivos PDF.",
  unPdfPorVez: "Mandá un PDF por vez. Proceso el primero.",
  procesando: (archivo: string, destino: string) => `⏳ Procesando *${archivo}* para *${destino}*. Tarda 1 o 2 minutos.`,
  noDescarga: "❌ No pude descargar el PDF. Mandalo de nuevo.",
  noEsPdf: "❌ El archivo no es un PDF válido. Mandalo de nuevo.",
  falloProceso: (motivo: string) => `❌ No pude procesar el PDF: ${motivo}\nMandalo de nuevo.`,
  pendiente: "Hay una carga pendiente de confirmar. Confirmala o cancelala antes de mandar otra.",
  cancelada: "❌ Carga cancelada. No se cargó nada.",
  expirada: "⚠️ La carga pendiente expiró. Mandá el PDF de nuevo.",
  cargando: (n: number) => `⏳ Cargando ${n} carnet${n === 1 ? "" : "s"} en SEA WHITE…`,
};

function lineaRechazo(r: CarnetRechazado): string {
  const donde = r.pagina ? `pág. ${r.pagina}` : "";
  const quien = r.referencia && r.referencia !== "—" ? r.referencia : "";
  return `• ${[donde, quien].filter(Boolean).join(" – ") || "—"}: ${r.motivo}`;
}

function nombreCarnet(c: CarnetListo): string {
  return c.apellidoNombre ? `${c.apellidoNombre} (${c.identificador})` : c.identificador;
}

/** Resumen previo a confirmar. */
export function resumenParaConfirmar(destino: string, aceptados: CarnetListo[], rechazados: CarnetRechazado[]): string {
  const personas = aceptados.filter((c) => c.tipo === "chofer").length;
  const vehiculos = aceptados.length - personas;
  const partes = [personas ? `${personas} persona${personas === 1 ? "" : "s"}` : "", vehiculos ? `${vehiculos} vehículo${vehiculos === 1 ? "" : "s"}` : ""].filter(Boolean);
  const lineas = [`📋 *${destino}*`, `✅ ${aceptados.length} listo${aceptados.length === 1 ? "" : "s"} para cargar (${partes.join(", ")})`];

  const avisos = aceptados.flatMap((c) => [
    ...(c.vencido ? [`• ${nombreCarnet(c)}: vencido el ${fecha(c.vencimiento)}`] : []),
    ...(c.observaciones ? [`• ${nombreCarnet(c)}: ${c.observaciones}`] : []),
  ]);
  if (avisos.length) lineas.push("", "⚠️ Avisos:", ...avisos);
  if (rechazados.length) lineas.push("", `❌ ${rechazados.length} no se van a cargar:`, ...rechazados.map(lineaRechazo));
  lineas.push("", "¿Confirmás la carga?");
  return lineas.join("\n");
}

/** Cuando no quedó ningún carnet apto: no hay nada que confirmar. */
export function sinCarnetsAptos(destino: string, rechazados: CarnetRechazado[]): string {
  return [`📋 *${destino}*`, "❌ No quedó ningún carnet apto para cargar.", ...rechazados.map(lineaRechazo), "", "Revisá el PDF y mandalo de nuevo."].join("\n");
}

/** Resultado final de la carga en SEA WHITE. */
export function resultadoCarga(destino: string, resumen: ResumenCarga): string {
  const ok = resumen.resultados.filter((r) => r.ok);
  const nuevos = ok.filter((r) => r.accion === "CREADO").length;
  const actualizados = ok.filter((r) => r.accion === "ACTUALIZADO").length;
  const detalle = [nuevos ? `${nuevos} nuevo${nuevos === 1 ? "" : "s"}` : "", actualizados ? `${actualizados} actualizado${actualizados === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
  const errores = resumen.resultados.filter((r) => !r.ok);
  const titulo = errores.length === 0 ? "✅ *Carga completada*" : ok.length === 0 ? "❌ *La carga falló*" : "⚠️ *Carga completada con errores*";
  const lineas = [titulo, destino, `${ok.length} cargado${ok.length === 1 ? "" : "s"}${detalle ? ` (${detalle})` : ""}`];
  if (errores.length) lineas.push("", `❌ ${errores.length} con error:`, ...errores.map((e) => `• ${e.identificador}: ${e.mensaje ?? "sin detalle"}`));
  return lineas.join("\n");
}

// --- Choferes --------------------------------------------------------------------

export const CONSULTA = {
  saludo: (bot: string) =>
    `👋 Hola, soy ${bot}, el asistente de SEA WHITE para el ingreso a planta.\nPasame tu *DNI* (o la *patente* del vehículo) y te digo en qué plantas estás habilitado.`,
  pedirDni: "Para consultar necesito tu *DNI* (solo números) o la *patente* del vehículo.",
  pedirDniPara: (destino: string) => `Pasame tu *DNI* (o la patente) y te digo si estás habilitado para *${destino}*.`,
  sinArchivos: "📵 En este número no se reciben archivos: es solo para consultas.\nPasame tu *DNI* o la *patente* y te digo en qué plantas estás habilitado.",
  preguntaCarnet: "¿Necesitás el carnet?",
  elegirCarnet: "¿De qué planta necesitás el carnet?",
  algoMas: "¿Necesitás algo más?",
  otraConsulta: "Pasame el *DNI* o la *patente* que querés consultar.",
  despedida: "👍 Listo. Cuando necesites, escribime.",
  carnetNoDisponible: "No pude traer el carnet en este momento. Probá de nuevo en unos minutos.",
  errorConsulta: "No pude consultar en este momento. Probá de nuevo en unos minutos.",
};

export interface LineaPlanta {
  destino: string;
  vencimiento: string | null;
  /** false = figura en el registro del bot pero SEA WHITE no lo encontró. */
  enSeaWhite: boolean;
  observaciones: string | null;
}

/** Respuesta a una consulta de DNI o patente. */
export function respuestaConsulta(opts: {
  tipo: "chofer" | "dominio";
  identificador: string;
  nombre: string | null;
  plantas: LineaPlanta[];
  /** Planta por la que preguntó y donde NO tiene credencial. */
  sinCredencialEn?: string;
  documentacion: Documentacion | null;
  hoy: CalendarDate;
}): string {
  const { tipo, identificador, nombre, plantas, documentacion, hoy } = opts;
  const quien = tipo === "chofer" ? `👤 *${nombre ?? "DNI"}* – DNI ${identificador}` : `🚛 Patente *${identificador}*`;
  const lineas = [quien];

  if (opts.sinCredencialEn) lineas.push("", `❌ No tenés credencial cargada para *${opts.sinCredencialEn}*.`);

  if (plantas.length > 0) {
    lineas.push("", "🏭 *Ingreso a planta*");
    for (const p of plantas) {
      lineas.push(`• ${p.destino}: ${p.enSeaWhite ? estadoCredencial(p.vencimiento, hoy) : "⚪ sin datos vigentes en el sistema"}`);
      if (p.observaciones) lineas.push(`   ⚠️ ${p.observaciones}`);
    }
  } else if (!opts.sinCredencialEn) {
    lineas.push("", `🏭 No encontré credenciales de ingreso a planta cargadas para ${tipo === "chofer" ? "ese DNI" : "esa patente"}.`);
  }

  if (documentacion?.found) {
    lineas.push("", "📄 *Documentación*");
    if (documentacion.tipo === "chofer") {
      lineas.push(`• Licencia: ${estadoFecha(documentacion.licencia, hoy)}`, `• ART: ${estadoFecha(documentacion.art, hoy)}`, `• F.931: ${estadoFecha(documentacion.f931, hoy)}`);
    } else {
      lineas.push(`• Seguro: ${estadoFecha(documentacion.seguro, hoy)}`, `• VTV: ${estadoFecha(documentacion.vtv, hoy)}`);
    }
  }
  return lineas.join("\n");
}
