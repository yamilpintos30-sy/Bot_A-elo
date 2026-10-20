/** Conversión a PDF de lo que manda el cargador cuando no es un PDF (fotos de carnets). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { formatoDe, FormatoNoSoportadoError, unirEnPdf } from "../src/extraction/aPdf.js";

const JPG = readFileSync("assets/javier.jpg");
// PNG de 1x1 (válido).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

async function paginas(pdf: Buffer): Promise<number> {
  return (await PDFDocument.load(pdf)).getPageCount();
}

describe("fotos de carnets a PDF", () => {
  it("detecta el formato por los bytes, no por el nombre", () => {
    expect(formatoDe(JPG)).toBe("jpg");
    expect(formatoDe(PNG)).toBe("png");
    expect(formatoDe(Buffer.from("%PDF-1.4"))).toBe("pdf");
    expect(formatoDe(Buffer.from("hola"))).toBe("desconocido");
  });

  it("un PDF solo se devuelve tal cual", async () => {
    const pdf = Buffer.from(await (await PDFDocument.create()).save());
    expect(await unirEnPdf([{ nombre: "a.pdf", bytes: pdf }])).toBe(pdf);
  });

  it("una foto JPG se convierte en un PDF de una página del tamaño de la imagen", async () => {
    const pdf = await unirEnPdf([{ nombre: "carnet.jpg", bytes: JPG }]);
    expect(formatoDe(pdf)).toBe("pdf");
    expect(await paginas(pdf)).toBe(1);
  });

  it("varias fotos (JPG y PNG) y un PDF van en un solo PDF, en orden", async () => {
    const otro = await PDFDocument.create();
    otro.addPage();
    otro.addPage();
    const pdf = await unirEnPdf([
      { nombre: "1.jpg", bytes: JPG },
      { nombre: "2.png", bytes: PNG },
      { nombre: "3.pdf", bytes: Buffer.from(await otro.save()) },
    ]);
    expect(await paginas(pdf)).toBe(4);
  });

  it("un formato que no es PDF ni foto se rechaza con el nombre del archivo", async () => {
    await expect(unirEnPdf([{ nombre: "audio.ogg", bytes: Buffer.from("OggS....") }])).rejects.toThrow(FormatoNoSoportadoError);
    await expect(unirEnPdf([{ nombre: "audio.ogg", bytes: Buffer.from("OggS....") }])).rejects.toThrow(/audio\.ogg/);
  });
});
