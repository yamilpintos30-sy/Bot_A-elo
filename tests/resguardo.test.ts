/**
 * RESGUARDO de VTV y seguro: se entrega sólo si coinciden la patente pedida,
 * la del nombre del archivo y la que figura adentro del PDF (leída por la IA).
 * La IA es un doble: devuelve lo que "leyó" en el PDF.
 */
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { ClaudeRunner } from "../src/extraction/claudeRunner.js";
import { VerificadorComprobantes } from "../src/extraction/verificadorComprobantes.js";

const PDF = Buffer.from("%PDF-1.4\n%x\n");
const logger = pino({ level: "silent" });

function verificador(leido: { patentes: string[]; tipoDocumento: string } | Error) {
  const run = vi.fn(async () => {
    if (leido instanceof Error) throw leido;
    return { content: [{ type: "text", text: JSON.stringify(leido) }] };
  });
  return { v: new VerificadorComprobantes({ run } as unknown as ClaudeRunner, { model: "m", effort: "low" }, logger), run };
}

describe("resguardo de comprobantes", () => {
  it("las tres coinciden: se entrega (tolera espacios y minúsculas)", async () => {
    const { v } = verificador({ patentes: ["AF 498 ZJ"], tipoDocumento: "vtv" });
    const r = await v.verificar(PDF, "vtv", "af498zj", "AF498ZJ.pdf");
    expect(r).toMatchObject({ ok: true, patentePedida: "AF498ZJ", patenteArchivo: "AF498ZJ", patentesEnPdf: ["AF498ZJ"] });
  });

  it("el nombre del archivo es de otra patente: no se entrega (y ni se lee el PDF)", async () => {
    const { v, run } = verificador({ patentes: ["AF498ZJ"], tipoDocumento: "vtv" });
    const r = await v.verificar(PDF, "vtv", "AF498ZJ", "AG536VG.pdf");
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/se llama AG536VG\.pdf y la patente pedida es AF498ZJ/);
    expect(run).not.toHaveBeenCalled();
  });

  it("sin nombre de archivo no se puede verificar: no se entrega", async () => {
    const { v } = verificador({ patentes: ["AF498ZJ"], tipoDocumento: "vtv" });
    const r = await v.verificar(PDF, "vtv", "AF498ZJ", null);
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/no informó el nombre del archivo/);
  });

  it("adentro del PDF figura otra patente: no se entrega", async () => {
    const { v } = verificador({ patentes: ["AG536VG"], tipoDocumento: "vtv" });
    const r = await v.verificar(PDF, "vtv", "AF498ZJ", "AF498ZJ.pdf");
    expect(r).toMatchObject({ ok: false, patentesEnPdf: ["AG536VG"] });
    expect(r.motivo).toMatch(/Adentro del PDF figura AG536VG, no AF498ZJ/);
  });

  it("adentro del PDF no se lee ninguna patente: no se entrega", async () => {
    const { v } = verificador({ patentes: [], tipoDocumento: "ilegible" });
    const r = await v.verificar(PDF, "seguro", "AF498ZJ", "AF498ZJ.pdf");
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/No se encontró la patente AF498ZJ adentro del PDF/);
  });

  it("pidió VTV y el documento es un seguro: no se entrega", async () => {
    const { v } = verificador({ patentes: ["AF498ZJ"], tipoDocumento: "seguro" });
    const r = await v.verificar(PDF, "vtv", "AF498ZJ", "AF498ZJ.pdf");
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/Se pidió VTV y el documento es un seguro/);
  });

  it("si la IA falla, no se entrega (ante la duda, no)", async () => {
    const { v } = verificador(new Error("timeout"));
    const r = await v.verificar(PDF, "vtv", "AF498ZJ", "AF498ZJ.pdf");
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/No se pudo leer el contenido del PDF/);
  });
});
