/**
 * Todos los textos que manda el bot, en un solo lugar.
 *
 *   - Cargadores: sólo datos, sin saludos ni cordialidades (pedido del equipo).
 *   - Choferes: trato de atención al público de una empresa, como Enri.
 */
import type { CarnetListo, CarnetRechazado } from "../extraction/review.js";
import type { ResumenCarga } from "../integrations/seawhite/types.js";
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

// --- Número no habilitado (app cerrada) ----------------------------------------------

/** Se manda UNA vez por conversación; después, silencio. */
export const NO_HABILITADO = [
  "Este servicio es de uso exclusivo para personal autorizado de Sea White S.A.",
  "El número de teléfono desde el cual se está comunicando no se encuentra habilitado para utilizar este servicio.",
  "Si considera que debería tener acceso, comuníquese con el administrador del sistema.",
  "*Sea White S.A.*",
].join("\n");

// --- Cierre ("Eso es todo, gracias") ------------------------------------------------

export const DESPEDIDA = {
  consulta: "¡Gracias por comunicarte con SEA WHITE! Cuando necesites consultar un vencimiento, escribime. Saludos.",
  cargador: "Listo. Cuando tengas otra carga, escribime.",
  cargaCancelada: "Listo. La carga pendiente se canceló: no se cargó nada. Cuando tengas otra carga, escribime.",
};

// --- Cargadores ------------------------------------------------------------------

/** "choferes" / "dominios" y su emoji, para los textos del cargador. */
export const TIPO = {
  chofer: { plural: "choferes", emoji: "👤", carnets: "carnets de personas", registros: "registros de personas" },
  dominio: { plural: "dominios", emoji: "🚛", carnets: "carnets de vehículos", registros: "registros de vehículos" },
} as const;

/** En un listado de estado no hay carnets: se habla de "registros". */
const deTipo = (tipo: "chofer" | "dominio", listado: boolean) => (listado ? TIPO[tipo].registros : TIPO[tipo].carnets);
const unidad = (n: number, listado: boolean) => `${listado ? "registro" : "carnet"}${n === 1 ? "" : "s"}`;

/** Cliente y subcliente (carga y consulta): solo texto, sin listas de opciones. */
export const DESTINO = {
  elegirPlanta: (cliente: string) => `¿Qué *subcliente* de *${cliente}*?`,
  clienteNoEncontrado: "❌ No se encontró ese *cliente y subcliente*. Escribilos de nuevo.",
  /** Coincidencia exacta: igual se confirma con [Sí] [No]. */
  confirmar: (destino: string) => `🔎 Encontré *${destino}*. ¿Es correcto?`,
  plantaNoEncontrada: (cliente: string) => `❌ No encontré ese subcliente en *${cliente}*. Escribilo de nuevo.`,
  quisisteDecir: (destino: string) => `🤔 ¿Quisiste decir *${destino}*?\nSi no, escribí el *cliente y subcliente* correctos.`,
  reescribir: "Dale, escribí el *cliente y subcliente* correctos.",
};

export const CARGA = {
  /** Paso 1: cliente (menú, de la tabla de clientes). */
  elegirCliente: (hola: boolean) => `${hola ? "¡Hola! 👋\n" : ""}¿Qué *cliente* vas a cargar?`,
  /** Paso 2: operadora (subcliente) del cliente elegido. */
  elegirOperadora: (cliente: string) => `*${cliente}*\n¿Qué *operadora*?`,
  /** Paso 3: tipo de documentación. */
  elegirTipo: (destino: string) => `*${destino}*\n¿Qué documentación vas a cargar?`,
  menu: "¿Qué documentación vas a cargar?",
  otraCarga: "¿Querés cargar otra documentación?",
  /** Mandó el archivo antes de terminar de elegir: se guarda y se sigue con lo que falta. */
  archivoEnEspera: "📎 Guardé el archivo. Primero elegí cliente, operadora y qué documentación es.",
  encontrado: (destino: string, tipo: "chofer" | "dominio") => `${TIPO[tipo].emoji} *${destino}* – ${TIPO[tipo].plural}\n📄 Mandá el PDF (o las fotos) con los ${TIPO[tipo].carnets}.`,
  soloPdf: "Solo se aceptan archivos PDF o fotos (JPG o PNG) de los carnets.",
  /** Todavía no se sabe si son carnets o un listado: texto neutro. */
  recibido: (archivo: string) => `📥 Recibí *${archivo}*. Estoy procesando el documento; puede tardar uno o dos minutos.`,
  formatoNoSoportado: (archivo: string) => `❌ "${archivo}" no es un PDF ni una foto JPG o PNG. Mandá el PDF o una foto del carnet.`,
  verificando: "🔎 Carnets separados. Estoy verificando los datos de cada uno.",
  verificandoListado:
    "📋 Es un listado de estado: cada uno se sube con el documento completo y su fila marcada. Verificando…",
  sigue: "⏳ Sigue en proceso, aguardá un momento por favor.",
  noDescarga: "❌ No pude descargar el archivo. Mandalo de nuevo.",
  falloProceso: (motivo: string) => `❌ No pude procesar el PDF: ${motivo}\nMandalo de nuevo.`,
  pendiente: "Hay una carga pendiente de confirmar. Confirmala o cancelala antes de mandar otra.",
  cancelada: "❌ Carga cancelada. No se cargó nada.",
  expirada: "⚠️ La carga pendiente expiró. Mandá el PDF de nuevo.",
  cargando: (n: number, listado = false) => `📤 Guardando ${n} ${unidad(n, listado)} en el sistema…`,
  /** Filtro de tipo: eligió un tipo y el PDF trae TODO del otro. */
  tipoIncorrecto: (elegido: "chofer" | "dominio", otro: "chofer" | "dominio", n: number, listado = false) =>
    `⚠️ Elegiste cargar *${TIPO[elegido].plural}*, pero el PDF tiene ${n} ${deTipo(otro, listado)} (${TIPO[otro].plural}).\nNo se cargó nada. ¿Qué hago?`,
};

/** Filtro de tipo: el PDF trae carnets del tipo elegido y también del otro. */
export function avisoTipoMezclado(elegido: "chofer" | "dominio", otros: CarnetListo[]): string {
  // "⚠️ También hay 8 personas: ahora van solo los vehículos. Al terminar te ofrezco cargarlas."
  const n = otros.length;
  return elegido === "dominio"
    ? `⚠️ También hay ${n} persona${n === 1 ? "" : "s"}: ahora van solo los vehículos. Al terminar te ofrezco cargarla${n === 1 ? "" : "s"}.`
    : `⚠️ También hay ${n} vehículo${n === 1 ? "" : "s"}: ahora van solo las personas. Al terminar te ofrezco cargarlo${n === 1 ? "" : "s"}.`;
}

/** Después de cargar un tipo, ofrecer el otro tipo del MISMO documento. */
export function ofrecerOtroTipo(otro: "chofer" | "dominio", cantidad: number, listado = false): string {
  return `El documento también tiene ${cantidad} ${deTipo(otro, listado)}. ¿Querés cargarlos ahora?`;
}

function lineaRechazo(r: CarnetRechazado): string {
  const donde = r.pagina ? `pág. ${r.pagina}` : "";
  const quien = r.referencia && r.referencia !== "—" ? r.referencia : "";
  return `• ${[donde, quien].filter(Boolean).join(" – ") || "—"}: ${r.motivo}`;
}

/** "Licencia de conducir" -> "licencia de conducir"; las siglas ("VTV/RIEDES") quedan igual. */
function minusculaInicial(texto: string): string {
  return /^\p{Lu}\p{Ll}/u.test(texto) ? texto.charAt(0).toLowerCase() + texto.slice(1) : texto;
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

  // Lo que importa es si está habilitado: un renglón por registro, sólo los que no lo están hoy.
  // Si hay una situación anormal (inhabilitado), se dice eso; si no, hasta cuándo estuvo habilitado.
  const noHabilitados = aceptados
    .filter((c) => c.vencido)
    .map((c) => {
      const motivo = c.motivoVencimiento ? ` (${minusculaInicial(c.motivoVencimiento)})` : "";
      return `• ${nombreCarnet(c)}: ${c.observaciones ? minusculaInicial(c.observaciones) : `habilitado hasta el ${fecha(c.vencimiento)}${motivo}`}`;
    });
  // Habilitados pero con algo para mirar (por ejemplo, una restricción del carnet).
  const avisos = aceptados.filter((c) => !c.vencido && c.observaciones).map((c) => `• ${nombreCarnet(c)}: ${c.observaciones}`);
  if (noHabilitados.length) lineas.push("", "⚠️ No habilitados hoy:", ...noHabilitados);
  if (avisos.length) lineas.push("", "⚠️ Avisos:", ...avisos);
  if (rechazados.length) lineas.push("", `❌ ${rechazados.length} no se van a cargar:`, ...rechazados.map(lineaRechazo));
  lineas.push("", "¿Confirmás la carga?");
  return lineas.join("\n");
}

/** Cuando no quedó ningún carnet apto: no hay nada que confirmar. */
export function sinCarnetsAptos(destino: string, rechazados: CarnetRechazado[], listado = false): string {
  return [`📋 *${destino}*`, `❌ No quedó ningún ${listado ? "registro" : "carnet"} apto para cargar.`, ...rechazados.map(lineaRechazo), "", "Revisá el PDF y mandalo de nuevo."].join("\n");
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
  if (errores.length) {
    // Si todos fallaron por lo mismo (p. ej. un candado o SEA WHITE caído), el motivo va una sola vez.
    const motivos = new Set(errores.map((e) => e.mensaje ?? "sin detalle"));
    if (errores.length > 1 && motivos.size === 1) lineas.push("", `❌ ${errores.length} con error: ${[...motivos][0]}`);
    else lineas.push("", `❌ ${errores.length} con error:`, ...errores.map((e) => `• ${e.identificador}: ${e.mensaje ?? "sin detalle"}`));
  }
  return lineas.join("\n");
}

// --- Choferes --------------------------------------------------------------------

export const CONSULTA = {
  /** Mismo saludo que Enri (con el nombre si se identificó el teléfono). */
  saludo: (bot: string, nombre?: string | null) =>
    nombre ? `¡Hola, ${nombre}! 👋 Soy *${bot}*, el asistente virtual de *SEA WHITE S.A.*` : `¡Hola! 👋 Soy *${bot}*, el asistente virtual de *SEA WHITE S.A.*`,
  pedirClienteSubcliente: "Escribí *cliente y subcliente* para la consulta.",
  /** Menú principal: dos ramas. */
  menuPrincipal: [
    "¿Qué querés consultar?",
    "🪪 *Habilitación*: credencial de ingreso y vencimiento en un cliente y subcliente, por DNI o por dominio.",
    "📄 *VTV y seguro*: te mando el comprobante del vehículo.",
  ].join("\n"),
  /** Rama habilitación, con el cliente y subcliente elegidos. */
  menuHabilitacion: (destino: string) => `✅ *${destino}*.\n¿Consultás por *DNI* (chofer) o por *dominio* (vehículo)?`,
  /** Rama VTV y seguro. */
  menuVehiculo: "¿Qué comprobante necesitás?",
  pedirDniPara: (destino: string) => `✅ *${destino}*.\n👤 Pasame el *DNI* del chofer (solo números, sin puntos).`,
  pedirPatentePara: (destino: string) => `✅ *${destino}*.\n🚛 Pasame la *patente* (dominio) del vehículo. Ejemplo: AA123BB`,
  pedirPatenteDoc: (doc: "vtv" | "seguro") => `🚛 Pasame la *patente* (dominio) del vehículo y te mando ${doc === "vtv" ? "la *VTV*" : "el *seguro*"}. Ejemplo: AA123BB`,
  docCaption: (doc: "vtv" | "seguro", dominio: string) => `${doc === "vtv" ? "📄 VTV" : "🛡️ Seguro"} – ${dominio}`,
  docNoEncontrado: (doc: "vtv" | "seguro", dominio: string) => `❌ No encontré ${doc === "vtv" ? "la VTV" : "el seguro"} del dominio *${dominio}*.`,
  /** Después de "no encontré": sigue esperando otra patente. */
  revisarPatente: "Revisá la patente y escribila de nuevo.",
  docNoDisponible: "No pude traer el comprobante en este momento. Probá de nuevo en unos minutos.",
  buscandoDoc: (doc: "vtv" | "seguro", dominio: string) => `🔎 Buscando ${doc === "vtv" ? "la VTV" : "el seguro"} de *${dominio}*…`,
  /** El resguardo no lo validó: no se entrega (y queda como falla crítica en el panel). */
  docNoVerificado: (doc: "vtv" | "seguro", dominio: string) => `Por el momento no tengo disponible ${doc === "vtv" ? "la VTV" : "el seguro"} de *${dominio}*.`,
  ofrecerOtro: (otro: "vtv" | "seguro", dominio: string) => `¿Querés también ${otro === "vtv" ? "la *VTV*" : "el *seguro*"} de *${dominio}*?`,
  dniInvalido: (error: string) => `❌ ${error}`,
  patenteInvalida: (error: string) => `❌ ${error}`,
  sinArchivos: "📵 En este número no se reciben archivos: es solo para consultas de vencimientos.",
  preguntaCarnet: "¿Querés que te pase el carnet?",
  /** Momento oportuno para aclarar cómo seguir. */
  algoMas: "¿Necesitás algo más?\nPara otro DNI o dominio en este cliente y subcliente, tocá *Consulta*; para volver al inicio, *Menú*.",
  algoMasVehiculo: "¿Necesitás algo más?\nPara otra patente o para consultar la habilitación, tocá *Menú*.",
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
  /** Cliente y subcliente por el que preguntó y donde NO tiene credencial. */
  sinCredencialEn?: string;
  hoy: CalendarDate;
}): string {
  const { tipo, identificador, nombre, plantas, hoy } = opts;
  const quien = tipo === "chofer" ? `👤 *${nombre ?? "DNI"}* – DNI ${identificador}` : `🚛 Patente *${identificador}*`;
  const lineas = [quien];

  if (opts.sinCredencialEn) lineas.push("", `❌ No tenés credencial cargada para *${opts.sinCredencialEn}*.`);

  if (plantas.length > 0) {
    lineas.push("", "🪪 *Habilitación*");
    for (const p of plantas) {
      lineas.push(`• ${p.destino}: ${p.enSeaWhite ? estadoCredencial(p.vencimiento, hoy) : "⚪ sin datos vigentes en el sistema"}`);
      if (p.observaciones) lineas.push(`   ⚠️ ${p.observaciones}`);
    }
  } else if (!opts.sinCredencialEn) {
    lineas.push("", `🪪 No encontré credenciales de ingreso cargadas para ${tipo === "chofer" ? "ese DNI" : "esa patente"}.`);
  }
  return lineas.join("\n");
}
