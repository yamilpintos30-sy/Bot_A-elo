/**
 * Marca de constancia sobre el documento original: recuadro rojo alrededor de
 * la fila y flecha roja en el margen. Se dibuja como contenido de la página
 * (queda fija, no es una anotación que se pueda borrar) y sin rasterizar, así
 * el documento conserva su calidad. No tapa texto: solo trazos, sin relleno.
 */
import { PDFDocument, popGraphicsState, pushGraphicsState, rgb } from "pdf-lib";
import type { PageViewport } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Banda, Region } from "./filas.js";

const ROJO = rgb(0.86, 0.08, 0.08);

export interface Marca {
  /** Página (desde 1). */
  pagina: number;
  /** Viewport con el que se renderizó la página: pasa de píxeles a puntos PDF. */
  viewport: PageViewport;
  region: Region;
  banda: Banda;
  /** Píxeles por punto del render (dpi / 72), para que el trazo no dependa de la resolución. */
  escala: number;
  /** Margen arriba y abajo de la fila, en píxeles: menos que la mitad del espacio con las filas vecinas. */
  margenVertical: number;
}

export async function marcarFila(original: Buffer, m: Marca): Promise<Buffer> {
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  const page = doc.getPage(m.pagina - 1);

  // El contenido original queda entre q/Q: si deja una transformación activa,
  // no desplaza la marca.
  const inicio = doc.context.register(doc.context.contentStream([pushGraphicsState()]));
  const fin = doc.context.register(doc.context.contentStream([popGraphicsState()]));
  page.node.wrapContentStreams(inicio, fin);

  const pdf = (x: number, y: number) => {
    const [px, py] = m.viewport.convertToPdfPoint(x, y) as [number, number];
    return { x: px, y: py };
  };
  const pt = m.escala; // 1 punto en píxeles del render
  const margen = 3 * pt;

  // Recuadro alrededor de la fila.
  const a = pdf(m.region.x0 - margen, m.banda.y0 - m.margenVertical);
  const b = pdf(m.region.x1 + margen, m.banda.y1 + m.margenVertical);
  page.drawRectangle({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
    borderColor: ROJO,
    borderWidth: 1.5,
  });

  // Flecha en el margen izquierdo (o en el derecho si no hay lugar), apuntando a la fila.
  const yc = (m.banda.y0 + m.banda.y1) / 2;
  const largo = 40 * pt;
  const anchoPagina = m.viewport.width;
  const izquierda = m.region.x0 - margen >= largo * 0.6;
  const punta = izquierda ? m.region.x0 - margen - 2 * pt : m.region.x1 + margen + 2 * pt;
  const sentido = izquierda ? 1 : -1;
  const cola = izquierda ? Math.max(2 * pt, punta - largo) : Math.min(anchoPagina - 2 * pt, punta + largo);
  const cabeza = 9 * pt;
  const linea = (x1: number, y1: number, x2: number, y2: number) => page.drawLine({ start: pdf(x1, y1), end: pdf(x2, y2), thickness: 2.2, color: ROJO });
  linea(cola, yc, punta, yc);
  linea(punta - sentido * cabeza, yc - cabeza * 0.6, punta, yc);
  linea(punta - sentido * cabeza, yc + cabeza * 0.6, punta, yc);

  return Buffer.from(await doc.save({ useObjectStreams: true }));
}
