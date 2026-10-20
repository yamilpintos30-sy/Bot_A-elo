/**
 * Render de páginas PDF a imagen, en el proceso (sin Claude ni sandbox):
 * pdf.js (el motor de PDF de Firefox) dibuja sobre un canvas.
 */
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { getDocument, type PDFDocumentProxy, type PageViewport } from "pdfjs-dist/legacy/build/pdf.mjs";
import { aGris, type Gris, type Region } from "./filas.js";

export interface PaginaRenderizada {
  numero: number;
  canvas: Canvas;
  gris: Gris;
  /** Para pasar de píxeles a coordenadas PDF (`convertToPdfPoint`). */
  viewport: PageViewport;
}

export async function abrirPdf(pdf: Buffer): Promise<PDFDocumentProxy> {
  // pdf.js se queda con el buffer: se le pasa una copia.
  return getDocument({ data: new Uint8Array(pdf), verbosity: 0, isEvalSupported: false }).promise;
}

export async function renderizarPagina(doc: PDFDocumentProxy, numero: number, dpi: number): Promise<PaginaRenderizada> {
  const page = await doc.getPage(numero);
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx as never, viewport, canvas: canvas as never }).promise;
  const datos = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return { numero, canvas, gris: aGris(datos, canvas.width, canvas.height), viewport };
}

/** Recorte de una región como PNG, escalado para que el ancho no pase de `anchoMaximo`. */
export function recortePng(canvas: Canvas, r: Region, anchoMaximo: number): { png: Buffer; escala: number } {
  const ancho = r.x1 - r.x0;
  const alto = r.y1 - r.y0;
  const escala = Math.min(1, anchoMaximo / ancho);
  const salida = createCanvas(Math.max(1, Math.round(ancho * escala)), Math.max(1, Math.round(alto * escala)));
  const ctx = salida.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, salida.width, salida.height);
  ctx.drawImage(canvas, r.x0, r.y0, ancho, alto, 0, 0, salida.width, salida.height);
  return { png: salida.toBuffer("image/png"), escala };
}
