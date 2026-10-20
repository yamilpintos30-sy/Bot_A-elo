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

// --- Cierre ("Eso es todo, gracias") ------------------------------------------------

export const DESPEDIDA = {
  consulta: "¡Gracias por comunicarte con SEA WHITE! Cuando necesites consultar un vencimiento, escribime. Saludos.",
  cargador: "Listo. Cuando tengas otra carga, escribime.",
  cargaCancelada: "Listo. La carga pendiente se canceló: no se cargó nada. Cuando tengas otra carga, escribime.",
};

// --- Cargadores ------------------------------------------------------------------

/** "choferes" / "dominios" y su emoji, para los textos del cargador. */
export const TIPO = {
  chofer: { plural: "choferes", emoji: "👤", carnets: "carnets de personas" },
  dominio: { plural: "dominios", emoji: "🚛", carnets: "carnets de vehículos" },
} as const;

export const CARGA = {
  menu: "¿Qué documentación vas a cargar?",
  otraCarga: "¿Querés cargar otra documentación?",
  pedirClienteSubcliente: (tipo: "chofer" | "dominio") =>
    `${TIPO[tipo].emoji} Carga de *${TIPO[tipo].plural}*.\nIndicá *cliente y subcliente*. Ejemplo: *Total Planta 1*`,
  clienteNoEncontrado: (clientes: string[]) => `❌ No encontré ese cliente. Clientes disponibles:\n${clientes.map((c) => `• ${c}`).join("\n")}\nVolvé a escribir cliente y subcliente.`,
  elegirPlanta: (cliente: string) => `¿Qué subcliente de ${cliente}?`,
  listaOpciones: (titulo: string, opciones: string[]) => `${titulo}\nEscribí una de estas opciones:\n${opciones.map((o) => `• ${o}`).join("\n")}`,
  plantaNoEncontrada: (cliente: string, plantas: string[]) => `❌ No encontré ese subcliente en ${cliente}. Subclientes: ${plantas.join(", ")}.`,
  encontrado: (destino: string, tipo: "chofer" | "dominio") => `✅ Cliente y subcliente encontrados: *${destino}*.\n📄 Mandá el PDF (o las fotos) con los ${TIPO[tipo].carnets}.`,
  soloPdf: "Solo se aceptan archivos PDF o fotos (JPG o PNG) de los carnets.",
  recibido: (archivo: string) => `📥 Recibí *${archivo}*. Estoy separando los carnets; puede tardar uno o dos minutos.`,
  formatoNoSoportado: (archivo: string) => `❌ "${archivo}" no es un PDF ni una foto JPG o PNG. Mandá el PDF o una foto del carnet.`,
  verificando: "🔎 Carnets separados. Estoy verificando los datos de cada uno.",
  sigue: "⏳ Sigue en proceso, aguardá un momento por favor.",
  noDescarga: "❌ No pude descargar el archivo. Mandalo de nuevo.",
  falloProceso: (motivo: string) => `❌ No pude procesar el PDF: ${motivo}\nMandalo de nuevo.`,
  pendiente: "Hay una carga pendiente de confirmar. Confirmala o cancelala antes de mandar otra.",
  cancelada: "❌ Carga cancelada. No se cargó nada.",
  expirada: "⚠️ La carga pendiente expiró. Mandá el PDF de nuevo.",
  cargando: (n: number) => `📤 Guardando ${n} carnet${n === 1 ? "" : "s"} en el sistema…`,
  /** Filtro de tipo: eligió un tipo y el PDF trae TODO del otro. */
  tipoIncorrecto: (elegido: "chofer" | "dominio", otro: "chofer" | "dominio", n: number) =>
    `⚠️ Elegiste cargar *${TIPO[elegido].plural}*, pero el PDF tiene ${n} ${TIPO[otro].carnets} (${TIPO[otro].plural}).\nNo se cargó nada. ¿Qué hago?`,
};

/** Filtro de tipo: el PDF trae carnets del tipo elegido y también del otro. */
export function avisoTipoMezclado(elegido: "chofer" | "dominio", otros: CarnetListo[]): string {
  const otro = elegido === "chofer" ? "dominio" : "chofer";
  return [
    `⚠️ El PDF también tiene ${otros.length} ${TIPO[otro].carnets}, que NO se van a cargar porque elegiste *${TIPO[elegido].plural}*:`,
    ...otros.map((c) => `• pág. ${c.pagina}: ${c.apellidoNombre ? `${c.apellidoNombre} (${c.identificador})` : c.identificador}`),
  ].join("\n");
}

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
  /** Mismo saludo que Enri (con el nombre si se identificó el teléfono). */
  saludo: (bot: string, nombre?: string | null) =>
    nombre ? `¡Hola, ${nombre}! 👋 Soy *${bot}*, el asistente virtual de *SEA WHITE S.A.*` : `¡Hola! 👋 Soy *${bot}*, el asistente virtual de *SEA WHITE S.A.*`,
  pedirClienteSubcliente: "¿A qué planta vas a ingresar? Escribí *cliente y subcliente*.\nEjemplo: *Total Planta 1*",
  elegirPlanta: (cliente: string) => `¿Qué subcliente (planta) de ${cliente}?`,
  clienteNoEncontrado: (clientes: string[]) => `❌ No encontré ese cliente. Clientes disponibles:\n${clientes.map((c) => `• ${c}`).join("\n")}\nVolvé a escribir cliente y subcliente.`,
  plantaNoEncontrada: (cliente: string, plantas: string[]) => `❌ No encontré ese subcliente en ${cliente}. Subclientes: ${plantas.join(", ")}.`,
  destinoOk: (destino: string) => `✅ *${destino}*.\n¿Qué documentación querés consultar?`,
  menuPrincipal: [
    "¿Qué querés consultar?",
    "🪪 *Por DNI*: credencial de ingreso a planta y vencimientos del chofer.",
    "🚛 *Por dominio*: credencial de ingreso a planta y vencimientos del vehículo.",
    "📄 *VTV* y 🛡️ *Seguro*: te mando el comprobante del vehículo.",
  ].join("\n"),
  menu: "¿Qué documentación querés consultar?",
  pedirDni: "👤 Pasame el *DNI* del chofer (solo números, sin puntos).",
  pedirPatente: "🚛 Pasame la *patente* (dominio) del vehículo. Ejemplo: AA123BB",
  pedirDniPara: (destino: string) => `✅ *${destino}*.\n👤 Pasame el *DNI* del chofer (solo números, sin puntos).`,
  pedirPatentePara: (destino: string) => `✅ *${destino}*.\n🚛 Pasame la *patente* (dominio) del vehículo. Ejemplo: AA123BB`,
  pedirPatenteDoc: (doc: "vtv" | "seguro") => `🚛 Pasame la *patente* (dominio) del vehículo y te mando ${doc === "vtv" ? "la *VTV*" : "el *seguro*"}. Ejemplo: AA123BB`,
  docCaption: (doc: "vtv" | "seguro", dominio: string) => `${doc === "vtv" ? "📄 VTV" : "🛡️ Seguro"} – ${dominio}`,
  docNoEncontrado: (doc: "vtv" | "seguro", dominio: string) => `❌ No encontré ${doc === "vtv" ? "la VTV" : "el seguro"} del dominio *${dominio}*.`,
  docNoDisponible: "No pude traer el comprobante en este momento. Probá de nuevo en unos minutos.",
  buscandoDoc: (doc: "vtv" | "seguro", dominio: string) => `🔎 Buscando ${doc === "vtv" ? "la VTV" : "el seguro"} de *${dominio}*…`,
  /** El resguardo no lo validó: no se entrega (y queda como falla crítica en el panel). */
  docNoVerificado: (doc: "vtv" | "seguro", dominio: string) => `Por el momento no tengo disponible ${doc === "vtv" ? "la VTV" : "el seguro"} de *${dominio}*.`,
  ofrecerOtro: (otro: "vtv" | "seguro", dominio: string) => `¿Querés también ${otro === "vtv" ? "la *VTV*" : "el *seguro*"} de *${dominio}*?`,
  dniInvalido: (error: string) => `❌ ${error}`,
  patenteInvalida: (error: string) => `❌ ${error}`,
  sinArchivos: "📵 En este número no se reciben archivos: es solo para consultas de vencimientos.",
  preguntaCarnet: "¿Querés que te pase el carnet?",
  /** Momento oportuno para aclarar cómo consultar otro DNI o dominio. */
  algoMas: "¿Necesitás algo más?\nPara consultar otro DNI o dominio, tocá *Menú*.",
  carnetNoDisponible: "No pude traer el carnet en este momento. Probá de nuevo en unos minutos.",
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
