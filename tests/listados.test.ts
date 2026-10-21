/**
 * Listados: ubicación de filas sin IA y lector con un Claude falso sobre un PDF
 * sintético (filas = barras oscuras en posiciones conocidas).
 */
import { describe, expect, it } from "vitest";
import pino from "pino";
import { PDFDocument, rgb } from "pdf-lib";
import { emptyUsage, type ClaudeRunner } from "../src/extraction/claudeRunner.js";
import { ajustarABanda, bandasDeTexto, cortarEnFranjas, type Gris } from "../src/extraction/listados/filas.js";
import { LectorListados } from "../src/extraction/listados/lectorListados.js";
import { abrirPdf, renderizarPagina } from "../src/extraction/listados/render.js";

const logger = pino({ level: "silent" });

function gris(ancho: number, alto: number, pintar: (x: number, y: number) => boolean): Gris {
  const px = new Uint8Array(ancho * alto).fill(255);
  for (let y = 0; y < alto; y++) for (let x = 0; x < ancho; x++) if (pintar(x, y)) px[y * ancho + x] = 40;
  return { ancho, alto, px };
}

describe("filas (sin IA)", () => {
  const filas = [
    [20, 30],
    [50, 60],
    [80, 90],
  ];
  // Texto en tres filas + una línea vertical fina que las atraviesa (como el borde de una tabla).
  const g = gris(400, 120, (x, y) => (x === 5 || x === 6 ? y >= 15 && y < 95 : x > 20 && x < 300 && filas.some(([a, b]) => y >= a! && y < b!)));
  const region = { x0: 0, y0: 0, x1: 400, y1: 120 };

  it("encuentra una banda por fila aunque una línea vertical las una", () => {
    expect(bandasDeTexto(g, region)).toEqual([
      { y0: 20, y1: 30 },
      { y0: 50, y1: 60 },
      { y0: 80, y1: 90 },
    ]);
  });

  it("ajusta la altura aproximada a la banda real, y no inventa si está lejos", () => {
    const bandas = bandasDeTexto(g, region);
    expect(ajustarABanda(bandas, 24, 10)).toEqual({ y0: 20, y1: 30 });
    expect(ajustarABanda(bandas, 64, 10)).toEqual({ y0: 50, y1: 60 });
    expect(ajustarABanda(bandas, 110, 10)).toBeNull();
  });

  it("corta las franjas entre filas, nunca por la mitad de una", () => {
    const bandas = bandasDeTexto(g, region);
    const franjas = cortarEnFranjas(bandas, region, 50);
    for (const f of franjas) for (const b of bandas) expect(b.y0 >= f.y1 || b.y1 <= f.y0 || (b.y0 >= f.y0 && b.y1 <= f.y1)).toBe(true);
    expect(franjas[0]!.y0).toBe(0);
    expect(franjas.at(-1)!.y1).toBe(120);
  });
});

describe("LectorListados (Claude falso)", () => {
  // Filas en puntos PDF (desde arriba): 100, 130, 160; 8 pt de alto.
  const FILAS_PT = [100, 130, 160];
  async function pdfSintetico(): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    for (const y of FILAS_PT) page.drawRectangle({ x: 100, y: 792 - y - 8, width: 400, height: 8, color: rgb(0.2, 0.2, 0.2) });
    return Buffer.from(await doc.save());
  }

  /** Altura (px de la franja) del centro de cada fila, como la daría Claude, con un error de `desvio`. */
  function yCentro(i: number, desvio = 0): number {
    const k = 300 / 72;
    const regionY0 = Math.floor(FILAS_PT[0]! * k);
    const escala = Math.min(1, 1500 / (400 * k));
    return ((FILAS_PT[i]! + 4) * k - regionY0) * escala + desvio;
  }

  function lector(filas: Array<Record<string, unknown>>): LectorListados {
    const respuestas = [{ clase: "listado" }, { formato: "prueba", clienteDetectado: "PAE", filas, descartados: [] }];
    const runner = {
      run: async () => ({ content: [{ type: "text", text: JSON.stringify(respuestas.shift()) }], usage: {} }),
    } as unknown as ClaudeRunner;
    return new LectorListados(runner, { model: "m", effort: "medium" }, { model: "v", effort: "low" }, logger);
  }

  const fila = (i: number, identificador: string, desvio = 0) => ({
    recorte: 1,
    yCentro: yCentro(i, desvio),
    tipo: "dominio",
    identificador,
    apellidoNombre: null,
    vencimiento: "31-12-2026",
    motivoVencimiento: null,
    observaciones: null,
  });

  it("marca cada registro en su fila (documento completo) y arma el recorte para verificar", async () => {
    const pdf = await pdfSintetico();
    const l = lector([fila(0, "AA111AA", 6), fila(1, "BB222BB", -5), fila(2, "CC333CC")]);
    expect(await l.clasificar(pdf, emptyUsage())).toBe("listado");
    const r = await l.extraer(pdf, "listado.pdf", emptyUsage());

    expect(r.manifest.modo).toBe("listado");
    expect(r.manifest.carnets.map((c) => c.archivo)).toEqual(["AA111AA.pdf", "BB222BB.pdf", "CC333CC.pdf"]);
    expect(r.manifest.carnets.every((c) => c.clienteDetectado === "PAE")).toBe(true);
    for (const [nombre, marcado] of r.archivos) {
      const doc = await PDFDocument.load(marcado);
      expect(doc.getPageCount()).toBe(1); // el documento completo, no un recorte
      expect(r.recortes.get(nombre)!.subarray(1, 4).toString("latin1")).toBe("PNG");
    }

    // La marca roja cae sobre la fila correcta: se renderiza la constancia de BB222BB.
    const render = await renderizarPagina(await abrirPdf(r.archivos.get("BB222BB.pdf")!), 1, 72);
    const ctx = render.canvas.getContext("2d");
    const rojoEn = (yPt: number) => {
      const fila = ctx.getImageData(0, Math.round(yPt), render.canvas.width, 1).data;
      for (let i = 0; i < fila.length; i += 4) if (fila[i]! > 180 && fila[i + 1]! < 80 && fila[i + 2]! < 80) return true;
      return false;
    };
    expect(rojoEn(130 + 4)).toBe(true); // flecha a la altura de la fila 2
    expect(rojoEn(100 + 4)).toBe(false);
    expect(rojoEn(160 + 4)).toBe(false);
  });

  it("dos registros en la misma fila o una fila que no existe: no se cargan", async () => {
    const pdf = await pdfSintetico();
    const l = lector([fila(0, "AA111AA"), fila(0, "ZZ999ZZ", 3), { ...fila(2, "CC333CC"), yCentro: 2000 }, fila(1, "BB222BB")]);
    await l.clasificar(pdf, emptyUsage());
    const r = await l.extraer(pdf, "listado.pdf", emptyUsage());
    expect(r.manifest.carnets.map((c) => c.identificador)).toEqual(["BB222BB"]);
    expect(r.manifest.descartados.map((d) => d.motivo).join("\n")).toMatch(/AA111AA: dos registros[\s\S]*ZZ999ZZ: dos registros[\s\S]*CC333CC: no se pudo ubicar/);
  });
});
