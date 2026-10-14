/**
 * Extractor de carnets sin llamar a Claude: lectura de salidas del sandbox,
 * manifest, continuación de turnos pausados, limpieza de archivos y la
 * revisión final (verificación cruzada, repetidos, rechazos).
 */
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { CarnetExtractor, collectOutputFileIds, ExtractionError, parseManifest, safeName } from "../src/extraction/carnetExtractor.js";
import { emptyUsage, type ClaudeRunner } from "../src/extraction/claudeRunner.js";
import type { Manifest, VerificacionDocumento } from "../src/extraction/manifest.js";
import { reviewCarnets } from "../src/extraction/review.js";

const logger = pino({ level: "silent" });
const PDF = Buffer.from("%PDF-1.4\n%carnet\n");
const HOY = { year: 2026, month: 10, day: 14 };

describe("salidas del sandbox", () => {
  it("encuentra los archivos generados en cualquier parte de la respuesta", () => {
    const content = [
      { type: "text", text: "listo" },
      { type: "bash_code_execution_tool_result", content: { type: "bash_code_execution_result", content: [{ type: "bash_code_execution_output", file_id: "f1" }] } },
      { type: "otro", nested: [{ type: "bash_code_execution_output", file_id: "f2" }, { type: "container_upload", file_id: "entrada" }] },
    ];
    expect(collectOutputFileIds(content)).toEqual(["f1", "f2"]);
  });

  it("valida el manifest", () => {
    const ok = parseManifest(Buffer.from(JSON.stringify({ carnets: [{ archivo: "1.pdf", tipo: "chofer", identificador: "30123456", vencimiento: "31-10-2026", pagina: 1 }] })));
    expect(ok.carnets).toHaveLength(1);
    expect(ok.descartados).toEqual([]);
    expect(() => parseManifest(Buffer.from("{no es json"))).toThrow(ExtractionError);
    expect(() => parseManifest(Buffer.from(JSON.stringify({ carnets: [{ tipo: "camion" }] })))).toThrow(/forma esperada/);
  });

  it("limpia nombres de archivo con rutas", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("C:\\x\\30123456.pdf")).toBe("30123456.pdf");
    expect(safeName("..")).toBe("archivo");
  });
});

describe("CarnetExtractor (Claude falso)", () => {
  function fakeRunner(responses: unknown[], files: Record<string, { filename: string; bytes: Buffer }>) {
    const deleted: string[] = [];
    const run = vi.fn(async () => responses.shift());
    const runner = {
      run,
      client: {
        files: {
          upload: vi.fn(async () => ({ id: "entrada" })),
          retrieveMetadata: vi.fn(async (id: string) => ({ filename: files[id]!.filename })),
          download: vi.fn(async (id: string) => new Response(new Uint8Array(files[id]!.bytes))),
          delete: vi.fn(async (id: string) => {
            deleted.push(id);
          }),
        },
      },
    } as unknown as ClaudeRunner;
    return { runner, run, deleted };
  }

  const manifest = { formato: "grilla", carnets: [{ archivo: "30123456.pdf", tipo: "chofer", identificador: "30123456", vencimiento: "31-10-2026", pagina: 1 }] };
  const output = (id: string) => ({ type: "bash_code_execution_tool_result", content: { type: "bash_code_execution_result", content: [{ type: "bash_code_execution_output", file_id: id }] } });

  it("retoma los turnos pausados, descarga las salidas y borra todo", async () => {
    const { runner, run, deleted } = fakeRunner(
      [
        { stop_reason: "pause_turn", container: { id: "cont-1" }, content: [output("pdf1")] },
        { stop_reason: "end_turn", container: { id: "cont-1" }, content: [output("man"), { type: "text", text: "1 carnet, 0 descartados" }] },
      ],
      { pdf1: { filename: "30123456.pdf", bytes: PDF }, man: { filename: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest)) } },
    );
    const r = await new CarnetExtractor(runner, { model: "m", effort: "high" }, logger).extract(PDF, "x.pdf", emptyUsage());

    expect(run).toHaveBeenCalledTimes(2);
    const second = run.mock.calls[1] as unknown as [{ container?: string; messages: Array<{ role: string }> }];
    expect(second[0].container).toBe("cont-1");
    expect(second[0].messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect([...r.archivos.keys()]).toEqual(["30123456.pdf"]);
    expect(r.manifest.carnets[0]!.identificador).toBe("30123456");
    expect(r.notaModelo).toBe("1 carnet, 0 descartados");
    expect(deleted.sort()).toEqual(["entrada", "man", "pdf1"]);
  });

  it("si falta el manifest falla, y aun así borra los archivos", async () => {
    const { runner, deleted } = fakeRunner([{ stop_reason: "end_turn", content: [output("pdf1")] }], { pdf1: { filename: "30123456.pdf", bytes: PDF } });
    await expect(new CarnetExtractor(runner, { model: "m", effort: "high" }, logger).extract(PDF, "x.pdf", emptyUsage())).rejects.toThrow(/manifest.json/);
    expect(deleted.sort()).toEqual(["entrada", "pdf1"]);
  });
});

describe("revisión final", () => {
  const carnet = (archivo: string, identificador: string, vencimiento: string, pagina = 1, extra = {}) => ({
    archivo,
    tipo: "chofer" as const,
    identificador,
    vencimiento,
    pagina,
    apellidoNombre: "PEREZ, JUAN",
    clienteDetectado: "TOTAL AUSTRAL",
    ...extra,
  });
  const verif = (identificador: string | null, vencimiento: string | null, extra: Partial<VerificacionDocumento> = {}): VerificacionDocumento => ({
    indice: 1,
    tipo: "chofer",
    identificador,
    vencimiento,
    unSoloCarnet: true,
    ...extra,
  });

  function run(manifest: Manifest, verificacion: Record<string, VerificacionDocumento>, archivos: Record<string, Buffer> = {}) {
    const files = new Map(Object.entries(archivos));
    for (const c of manifest.carnets) if (!(c.archivo in archivos)) files.set(c.archivo, PDF);
    return reviewCarnets({ manifest, archivos: files, verificacion: new Map(Object.entries(verificacion)), hoy: HOY });
  }

  it("acepta cuando las dos lecturas coinciden (aunque escriban la fecha distinto)", () => {
    const r = run({ carnets: [carnet("a.pdf", "33.615.617", "18/10/2026")], descartados: [] }, { "a.pdf": verif("33615617", "18-10-2026") });
    expect(r.rechazados).toEqual([]);
    expect(r.aceptados[0]).toMatchObject({ identificador: "33615617", vencimiento: "18-10-2026", vencido: false, apellidoNombre: "PEREZ, JUAN" });
  });

  it("rechaza si la verificación lee otro DNI, otra fecha o más de un carnet", () => {
    const r = run(
      {
        carnets: [carnet("a.pdf", "33615617", "18-10-2026", 1), carnet("b.pdf", "29642599", "31-10-2026", 1), carnet("c.pdf", "40778877", "20-10-2026", 1)],
        descartados: [],
      },
      {
        "a.pdf": verif("33615618", "18-10-2026"),
        "b.pdf": verif("29642599", "05-10-2026"),
        "c.pdf": verif("40778877", "20-10-2026", { unSoloCarnet: false }),
      },
    );
    expect(r.aceptados).toEqual([]);
    expect(r.rechazados.map((x) => x.motivo)).toEqual([
      expect.stringMatching(/DNI \(leyó 33615618\)/),
      expect.stringMatching(/vencimiento \(leyó 05-10-2026\)/),
      expect.stringMatching(/exactamente un carnet/),
    ]);
  });

  it("rechaza datos inválidos, PDF faltante y sin verificación", () => {
    const r = run(
      {
        carnets: [carnet("a.pdf", "12", "18-10-2026"), carnet("b.pdf", "29642599", "31-02-2026"), carnet("c.pdf", "40778877", "20-10-2026"), carnet("d.pdf", "28063068", "31-10-2026")],
        descartados: [{ pagina: 3, motivo: "Carnet ilegible" }],
      },
      { "c.pdf": verif("40778877", "20-10-2026") },
      { "c.pdf": Buffer.from("no soy pdf") },
    );
    expect(r.aceptados).toEqual([]);
    expect(r.rechazados.map((x) => x.motivo)).toEqual([
      "Carnet ilegible",
      expect.stringMatching(/DNI/),
      expect.stringMatching(/vencimiento/),
      expect.stringMatching(/no es un PDF/),
      expect.stringMatching(/verificación independiente/),
    ]);
  });

  it("con repetidos se queda con el de vencimiento más lejano", () => {
    const r = run(
      { carnets: [carnet("a.pdf", "24579700", "31-10-2026", 1), carnet("b.pdf", "24579700", "30-11-2026", 2)], descartados: [] },
      { "a.pdf": verif("24579700", "31-10-2026"), "b.pdf": verif("24579700", "30-11-2026") },
    );
    expect(r.aceptados).toHaveLength(1);
    expect(r.aceptados[0]).toMatchObject({ pagina: 2, vencimiento: "30-11-2026" });
    expect(r.rechazados[0]!.motivo).toMatch(/Repetido/);
  });

  it("marca los vencidos y conserva las observaciones (se cargan igual)", () => {
    const r = run(
      { carnets: [carnet("a.pdf", "33673568", "08-10-2026", 1, { observaciones: "Inhabilitado para conducir" })], descartados: [] },
      { "a.pdf": verif("33673568", "08-10-2026") },
    );
    expect(r.aceptados[0]).toMatchObject({ vencido: true, observaciones: "Inhabilitado para conducir" });
  });

  it("vehículos: compara la patente normalizada", () => {
    const r = run(
      { carnets: [{ ...carnet("p.pdf", "AF 498 ZJ", "31-12-2026"), tipo: "dominio", apellidoNombre: null }], descartados: [] },
      { "p.pdf": verif("AF498ZJ", "31-12-2026", { tipo: "dominio" }) },
    );
    expect(r.aceptados[0]).toMatchObject({ tipo: "dominio", identificador: "AF498ZJ" });
  });
});
