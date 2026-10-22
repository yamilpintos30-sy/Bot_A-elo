/**
 * PDF de los listados grupales de logística (APIs 5 y 11): una tabla prolija
 * para reenviar o imprimir, más un resumen corto para el epígrafe del archivo.
 *
 *   Choferes: N° | DNI | Apellido y nombre | Vence | Estado
 *   Dominios: agrupados por tipo de vehículo (Camión primero, después Acoplado,
 *             en el orden en que los manda la API): N° | Dominio | Vence | Estado
 *
 * Las filas que vencen en 7 días o menos van en naranja.
 */
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import type { FilaListado, TipoRegistro } from "../integrations/seawhite/types.js";
import { diffDays, parseCalendarDate, type CalendarDate } from "../utils/dates.js";

/** Días para avisar que una habilitación está por vencer. */
export const POR_VENCER_DIAS = 7;

export interface DatosListado {
  tipo: TipoRegistro;
  cliente: string;
  subcliente: string;
  filas: FilaListado[];
  hoy: CalendarDate;
  /** "22/10/2026 12:15" */
  generado: string;
  bot: string;
}

const A4 = { ancho: 595.28, alto: 841.89 };
const MARGEN = 40;
const ALTO_FILA = 18;
const NEGRO = rgb(0.1, 0.1, 0.12);
const GRIS = rgb(0.42, 0.45, 0.5);
const NARANJA = rgb(0.8, 0.38, 0);
const FONDO = rgb(0.94, 0.95, 0.97);
const AZUL = rgb(0.06, 0.25, 0.45);

/** Helvetica sólo sabe WinAnsi: se quita lo que no entra (emojis, etc.). */
const winAnsi = (s: string) =>
  s
    .normalize("NFC")
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

const fecha = (v: string) => {
  const d = parseCalendarDate(v);
  return d ? `${String(d.day).padStart(2, "0")}/${String(d.month).padStart(2, "0")}/${d.year}` : v;
};

function estado(v: string, hoy: CalendarDate): { texto: string; alerta: boolean } {
  const d = parseCalendarDate(v);
  if (!d) return { texto: "sin fecha", alerta: true };
  const dias = diffDays(hoy, d);
  if (dias < 0) return { texto: "vencido", alerta: true };
  if (dias === 0) return { texto: "vence HOY", alerta: true };
  if (dias <= POR_VENCER_DIAS) return { texto: `vence en ${dias} día${dias === 1 ? "" : "s"}`, alerta: true };
  return { texto: "vigente", alerta: false };
}

/** Grupos de vehículos en el orden en que vienen ("Camion" -> "Camión"). */
function gruposVehiculos(filas: FilaListado[]): Array<{ titulo: string; filas: FilaListado[] }> {
  const grupos = new Map<string, FilaListado[]>();
  for (const f of filas) {
    const t = (f.tipoVehiculo ?? "Camion").trim() || "Camion";
    const titulo = t.toLowerCase() === "camion" ? "Camión" : t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
    grupos.set(titulo, [...(grupos.get(titulo) ?? []), f]);
  }
  return [...grupos.entries()].map(([titulo, filas]) => ({ titulo, filas }));
}

const plural = (titulo: string, n: number) => (n === 1 ? titulo : titulo.endsWith("n") ? `${titulo.replace(/ón$/, "on")}es` : `${titulo}s`);

/** Resumen para el epígrafe del PDF (WhatsApp). */
export function resumenListado(d: Omit<DatosListado, "generado" | "bot">): string {
  const porVencer = d.filas.filter((f) => estado(f.vencimiento, d.hoy).alerta).length;
  const titulo = d.tipo === "chofer" ? "📋 *Choferes habilitados*" : "📋 *Dominios habilitados*";
  const lineas = [titulo, `*${d.cliente} – ${d.subcliente}*`];
  if (d.tipo === "chofer") lineas.push(`👤 ${d.filas.length} chofer${d.filas.length === 1 ? "" : "es"}`);
  else {
    const grupos = gruposVehiculos(d.filas).map((g) => `${g.filas.length} ${plural(g.titulo, g.filas.length).toLowerCase()}`);
    lineas.push(`🚛 ${d.filas.length} dominio${d.filas.length === 1 ? "" : "s"}${grupos.length ? ` (${grupos.join(", ")})` : ""}`);
  }
  if (porVencer) lineas.push(`⚠️ ${porVencer} vence${porVencer === 1 ? "" : "n"} en los próximos ${POR_VENCER_DIAS} días`);
  return lineas.join("\n");
}

/** Nombre del archivo: "Choferes_CAGSA_S_A_2026-10-22.pdf". */
export function nombreArchivoListado(tipo: TipoRegistro, cliente: string, hoy: CalendarDate): string {
  const limpio = cliente
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
  const f = `${hoy.year}-${String(hoy.month).padStart(2, "0")}-${String(hoy.day).padStart(2, "0")}`;
  return `${tipo === "chofer" ? "Choferes" : "Dominios"}_${limpio}_${f}.pdf`;
}

interface Columna {
  titulo: string;
  ancho: number;
}

export async function generarListadoPdf(d: DatosListado): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(winAnsi(`${d.tipo === "chofer" ? "Choferes" : "Dominios"} habilitados - ${d.cliente}`));
  pdf.setAuthor(winAnsi(d.bot));
  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold);

  const ancho = A4.ancho - 2 * MARGEN;
  const columnas: Columna[] =
    d.tipo === "chofer"
      ? [{ titulo: "N°", ancho: 30 }, { titulo: "DNI", ancho: 75 }, { titulo: "Apellido y nombre", ancho: ancho - 30 - 75 - 75 - 95 }, { titulo: "Vence", ancho: 75 }, { titulo: "Estado", ancho: 95 }]
      : [{ titulo: "N°", ancho: 30 }, { titulo: "Dominio", ancho: 120 }, { titulo: "Vence", ancho: 100 }, { titulo: "Estado", ancho: ancho - 30 - 120 - 100 }];

  let pagina: PDFPage = pdf.addPage([A4.ancho, A4.alto]);
  let y = A4.alto - MARGEN;
  let numeroPagina = 1;

  const texto = (p: PDFPage, s: string, x: number, yy: number, font: PDFFont, size: number, color = NEGRO, maxAncho?: number) => {
    let t = winAnsi(s);
    // Si no entra en la columna, se corta y se marca con "...".
    if (maxAncho && font.widthOfTextAtSize(t, size) > maxAncho) {
      while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > maxAncho) t = t.slice(0, -1);
      t = `${t.trimEnd()}...`;
    }
    p.drawText(t, { x, y: yy, size, font, color });
  };

  const pie = (p: PDFPage, n: number) => texto(p, `${d.bot} · Generado el ${d.generado} · Página ${n}`, MARGEN, 22, normal, 8, GRIS);

  // Encabezado (sólo en la primera página).
  texto(pagina, d.tipo === "chofer" ? "Choferes habilitados" : "Dominios habilitados", MARGEN, y - 4, negrita, 18, AZUL);
  y -= 26;
  texto(pagina, `${d.cliente} – ${d.subcliente}`, MARGEN, y, negrita, 11, NEGRO, ancho);
  y -= 15;
  const resumen = resumenListado(d).split("\n").slice(2).map((l) => winAnsi(l.replace(/\*/g, "")));
  texto(pagina, resumen.join("  ·  "), MARGEN, y, normal, 9, GRIS, ancho);
  y -= 8;
  pagina.drawLine({ start: { x: MARGEN, y }, end: { x: A4.ancho - MARGEN, y }, thickness: 0.8, color: AZUL });
  y -= 18;

  const nuevaPagina = () => {
    pie(pagina, numeroPagina);
    pagina = pdf.addPage([A4.ancho, A4.alto]);
    numeroPagina += 1;
    y = A4.alto - MARGEN;
  };

  const encabezadoTabla = () => {
    pagina.drawRectangle({ x: MARGEN, y: y - 5, width: ancho, height: ALTO_FILA, color: AZUL });
    let x = MARGEN + 4;
    for (const c of columnas) {
      texto(pagina, c.titulo, x, y, negrita, 9, rgb(1, 1, 1));
      x += c.ancho;
    }
    y -= ALTO_FILA;
  };

  const tabla = (filas: FilaListado[]) => {
    encabezadoTabla();
    filas.forEach((f, i) => {
      if (y < MARGEN + 30) {
        nuevaPagina();
        encabezadoTabla();
      }
      if (i % 2 === 1) pagina.drawRectangle({ x: MARGEN, y: y - 5, width: ancho, height: ALTO_FILA, color: FONDO });
      const e = estado(f.vencimiento, d.hoy);
      const color = e.alerta ? NARANJA : NEGRO;
      const celdas = d.tipo === "chofer" ? [String(i + 1), f.identificador, f.nombre ?? "", fecha(f.vencimiento), e.texto] : [String(i + 1), f.identificador, fecha(f.vencimiento), e.texto];
      let x = MARGEN + 4;
      celdas.forEach((c, k) => {
        texto(pagina, c, x, y, k === 1 ? negrita : normal, 9, color, columnas[k]!.ancho - 8);
        x += columnas[k]!.ancho;
      });
      y -= ALTO_FILA;
    });
  };

  if (!d.filas.length) {
    texto(pagina, "No hay registros vigentes.", MARGEN, y, normal, 11, GRIS);
  } else if (d.tipo === "chofer") {
    tabla(d.filas);
  } else {
    for (const g of gruposVehiculos(d.filas)) {
      if (y < MARGEN + 80) nuevaPagina();
      texto(pagina, `${plural(g.titulo, g.filas.length)} (${g.filas.length})`, MARGEN, y, negrita, 12, AZUL);
      y -= 18;
      tabla(g.filas);
      y -= 14;
    }
  }
  pie(pagina, numeroPagina);
  return Buffer.from(await pdf.save());
}
