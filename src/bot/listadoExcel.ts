/**
 * Excel de los listados grupales de logística (APIs 5 y 11): el mismo contenido
 * que el PDF (listadoPdf.ts), en una planilla para filtrar, ordenar o copiar.
 *
 *   Choferes: N° | DNI | Apellido y nombre | Vence | Estado
 *   Dominios: agrupados por tipo de vehículo (Camión, Acoplado…), cada grupo
 *             con su título y su tabla: N° | Dominio | Vence | Estado
 *
 * "Vence" es una fecha de verdad (se puede ordenar). Las filas que vencen en
 * 7 días o menos van en naranja, como en el PDF.
 */
import ExcelJS from "exceljs";
import { parseCalendarDate } from "../utils/dates.js";
import { estado, gruposVehiculos, plural, resumenListado, type DatosListado } from "./listadoPdf.js";
import type { FilaListado } from "../integrations/seawhite/types.js";

export const MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const AZUL = "FF0F4073";
const NARANJA = "FFCC6100";
const GRIS = "FF6B7280";
const FONDO = "FFF0F2F7";

/** "15-12-2026" -> fecha de Excel (sin hora ni zona). */
function fechaExcel(v: string): Date | string {
  const d = parseCalendarDate(v);
  return d ? new Date(Date.UTC(d.year, d.month - 1, d.day)) : v;
}

export async function generarListadoExcel(d: DatosListado): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  libro.creator = d.bot;
  libro.created = new Date();
  const hoja = libro.addWorksheet(d.tipo === "chofer" ? "Choferes" : "Dominios", {
    pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const columnas =
    d.tipo === "chofer"
      ? [
          { titulo: "N°", ancho: 6 },
          { titulo: "DNI", ancho: 13 },
          { titulo: "Apellido y nombre", ancho: 42 },
          { titulo: "Vence", ancho: 13 },
          { titulo: "Estado", ancho: 18 },
        ]
      : [
          { titulo: "N°", ancho: 6 },
          { titulo: "Dominio", ancho: 14 },
          { titulo: "Vence", ancho: 13 },
          { titulo: "Estado", ancho: 18 },
        ];
  hoja.columns = columnas.map((c) => ({ width: c.ancho }));
  const ultimaColumna = columnas.length;

  // Encabezado: título, cliente – operadora y el resumen (igual que el PDF).
  const titulo = hoja.addRow([d.tipo === "chofer" ? "Choferes habilitados" : "Dominios habilitados"]);
  titulo.font = { bold: true, size: 16, color: { argb: AZUL } };
  hoja.addRow([`${d.cliente} – ${d.subcliente}`]).font = { bold: true, size: 12 };
  const resumen = resumenListado(d)
    .split("\n")
    .slice(2)
    .map((l) => l.replace(/\*/g, "").replace(/^[^\p{L}\p{N}]+/u, "").trim())
    .join("  ·  ");
  hoja.addRow([resumen]).font = { color: { argb: GRIS } };
  for (const n of [1, 2, 3]) hoja.mergeCells(n, 1, n, ultimaColumna);
  hoja.addRow([]);

  const encabezadoTabla = () => {
    const fila = hoja.addRow(columnas.map((c) => c.titulo));
    fila.eachCell((celda) => {
      celda.font = { bold: true, color: { argb: "FFFFFFFF" } };
      celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL } };
      celda.alignment = { vertical: "middle" };
    });
    return fila.number;
  };

  const tabla = (filas: FilaListado[]) => {
    const inicio = encabezadoTabla();
    filas.forEach((f, i) => {
      const e = estado(f.vencimiento, d.hoy);
      const valores = d.tipo === "chofer" ? [i + 1, f.identificador, f.nombre ?? "", fechaExcel(f.vencimiento), e.texto] : [i + 1, f.identificador, fechaExcel(f.vencimiento), e.texto];
      const fila = hoja.addRow(valores);
      fila.eachCell((celda, col) => {
        celda.font = { bold: col === 2, color: e.alerta ? { argb: NARANJA } : undefined };
        if (i % 2 === 1) celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FONDO } };
      });
      const colVence = d.tipo === "chofer" ? 4 : 3;
      fila.getCell(colVence).numFmt = "dd/mm/yyyy";
      fila.getCell(1).alignment = { horizontal: "left" };
    });
    return { inicio, fin: inicio + filas.length };
  };

  if (!d.filas.length) {
    hoja.addRow(["No hay registros vigentes."]).font = { color: { argb: GRIS } };
  } else if (d.tipo === "chofer") {
    const { inicio, fin } = tabla(d.filas);
    // Filtros en el encabezado y el encabezado fijo al bajar.
    hoja.autoFilter = { from: { row: inicio, column: 1 }, to: { row: fin, column: ultimaColumna } };
    hoja.views = [{ state: "frozen", ySplit: inicio }];
  } else {
    for (const g of gruposVehiculos(d.filas)) {
      const subtitulo = hoja.addRow([`${plural(g.titulo, g.filas.length)} (${g.filas.length})`]);
      subtitulo.font = { bold: true, size: 12, color: { argb: AZUL } };
      tabla(g.filas);
      hoja.addRow([]);
    }
  }

  hoja.addRow([]);
  hoja.addRow([`${d.bot} · Generado el ${d.generado}`]).font = { size: 9, color: { argb: GRIS } };

  return Buffer.from(await libro.xlsx.writeBuffer());
}
