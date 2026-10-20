/**
 * Convierte a PDF lo que manda el cargador cuando NO es un PDF.
 *
 * Algunos clientes entregan los carnets como foto (p. ej. la credencial de
 * Pluspetrol en JPG). El resto del proceso (separar carnets en el sandbox,
 * verificar, cargar en SEA WHITE) trabaja con PDF, así que antes de procesar:
 *   - PDF        -> se usa tal cual.
 *   - JPG / PNG  -> una página por imagen, del tamaño de la imagen.
 *   - varias fotos en el mismo envío -> un solo PDF con una página por foto.
 * Se detecta el formato por los bytes del archivo, no por el nombre.
 */
import { PDFDocument } from "pdf-lib";

export type FormatoArchivo = "pdf" | "jpg" | "png" | "desconocido";

export function formatoDe(bytes: Buffer): FormatoArchivo {
  if (bytes.length > 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  return "desconocido";
}

export class FormatoNoSoportadoError extends Error {
  constructor(public readonly archivo: string) {
    super(`El archivo "${archivo}" no es un PDF ni una imagen JPG o PNG.`);
    this.name = "FormatoNoSoportadoError";
  }
}

/**
 * Une los archivos recibidos en un único PDF listo para procesar.
 * Si viene un solo PDF, se devuelve el mismo (sin tocarlo).
 */
export async function unirEnPdf(archivos: Array<{ nombre: string; bytes: Buffer }>): Promise<Buffer> {
  if (archivos.length === 1 && formatoDe(archivos[0]!.bytes) === "pdf") return archivos[0]!.bytes;

  const salida = await PDFDocument.create();
  for (const a of archivos) {
    const formato = formatoDe(a.bytes);
    if (formato === "pdf") {
      const origen = await PDFDocument.load(a.bytes, { ignoreEncryption: true });
      const paginas = await salida.copyPages(origen, origen.getPageIndices());
      paginas.forEach((p) => salida.addPage(p));
    } else if (formato === "jpg" || formato === "png") {
      const imagen = formato === "jpg" ? await salida.embedJpg(a.bytes) : await salida.embedPng(a.bytes);
      const pagina = salida.addPage([imagen.width, imagen.height]);
      pagina.drawImage(imagen, { x: 0, y: 0, width: imagen.width, height: imagen.height });
    } else {
      throw new FormatoNoSoportadoError(a.nombre);
    }
  }
  return Buffer.from(await salida.save());
}
