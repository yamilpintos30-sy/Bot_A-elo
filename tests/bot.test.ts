/**
 * El bot de punta a punta con dobles: catálogo, cargadores, registro y
 * sesiones en memoria; SEA WHITE y el procesador de carnets falsos.
 */
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { resolver } from "../src/bot/catalogo.js";
import { LotesPendientes, type BotDeps, type SeaWhiteService } from "../src/bot/deps.js";
import { BotEngine } from "../src/bot/engine.js";
import type { IncomingAttachment, IncomingMessage, Outbound } from "../src/bot/types.js";
import type { ProcesamientoResultado } from "../src/extraction/procesarCarnets.js";
import type { CarnetListo } from "../src/extraction/review.js";
import type { Consulta, RegistroCarga, ResumenCarga, TipoRegistro } from "../src/integrations/seawhite/types.js";
import { MemoryCargadores } from "../src/storage/cargadores.js";
import { MemoryCatalogo, type Cliente } from "../src/storage/catalogo.js";
import { MemoryRegistro } from "../src/storage/registro.js";
import { MemorySessions, NoopMessageLog } from "../src/storage/sessions.js";

const logger = pino({ level: "silent" });
const PDF = Buffer.from("%PDF-1.4\n%x\n");
const CARGADOR = "+5492914413200";
const CHOFER = "+5492995551234";
const HOY = new Date("2026-10-15T12:00:00-03:00");

const CLIENTES: Cliente[] = [
  {
    codigo: "999991",
    nombre: "TOTAL AUSTRAL (PRUEBA)",
    alias: ["total", "total austral"],
    plantas: [
      { codigo: "000001", nombre: "Planta 1", alias: ["p1"] },
      { codigo: "000002", nombre: "Planta 2", alias: [] },
    ],
  },
  { codigo: "999992", nombre: "VISTA ENERGY (PRUEBA)", alias: ["vista"], plantas: [{ codigo: "000001", nombre: "Planta 1", alias: [] }] },
];

/** SEA WHITE falso: guarda lo cargado y responde consultas como la API real. */
class FakeSeaWhite implements SeaWhiteService {
  datos = new Map<string, { id: number; vencimiento: string; pdf: Buffer }>();
  cargas: Array<{ tipo: TipoRegistro; registros: RegistroCarga[] }> = [];
  private seq = 0;
  key = (t: string, c: string, s: string, i: string) => `${t}|${c}|${s}|${i}`;

  async cargar(tipo: TipoRegistro, registros: RegistroCarga[]): Promise<ResumenCarga> {
    this.cargas.push({ tipo, registros });
    const resultados = registros.map((r) => {
      const k = this.key(tipo, r.cliente, r.subcliente, r.identificador);
      const previo = this.datos.get(k);
      const id = previo?.id ?? ++this.seq;
      this.datos.set(k, { id, vencimiento: r.vencimiento, pdf: Buffer.concat([PDF, Buffer.from(r.identificador)]) });
      return { identificador: r.identificador, ok: true, id, accion: previo ? "ACTUALIZADO" : "CREADO" };
    });
    return { total: registros.length, correctos: registros.length, errores: 0, resultados };
  }
  async consultar(tipo: TipoRegistro, c: string, s: string, i: string): Promise<Consulta> {
    const d = this.datos.get(this.key(tipo, c, s, i));
    return d
      ? { found: true, tipo, id: d.id, cliente: c, subcliente: s, identificador: i, vencimiento: d.vencimiento, fechaAlta: null, fechaModificacion: null }
      : { found: false, tipo, identificador: i };
  }
  async documentacion(tipo: TipoRegistro) {
    return tipo === "chofer"
      ? { found: true as const, tipo: "chofer" as const, nombre: "OJEDA BORIS DANIEL", licencia: "2027-03-10T00:00:00", art: "2026-10-01T00:00:00", f931: "2026-11-30T00:00:00" }
      : { found: true as const, tipo: "dominio" as const, seguro: "2027-01-01T00:00:00", vtv: null };
  }
  async descargarPdf(tipo: TipoRegistro, id: number): Promise<Buffer> {
    const d = [...this.datos.entries()].find(([k, v]) => k.startsWith(tipo) && v.id === id);
    if (!d) throw new Error("no existe");
    return d[1].pdf;
  }
}

function carnet(identificador: string, vencimiento: string, extra: Partial<CarnetListo> = {}): CarnetListo {
  return { tipo: "chofer", identificador, vencimiento, apellidoNombre: `PERSONA ${identificador}`, clienteDetectado: "TOTAL", pagina: 1, observaciones: null, vencido: false, pdf: PDF, ...extra };
}

function resultado(aceptados: CarnetListo[], rechazados: ProcesamientoResultado["rechazados"] = []): ProcesamientoResultado {
  return { aceptados, rechazados, formato: "test", notaModelo: "", manifest: { carnets: [], descartados: [] }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 }, costoUsd: 0.1, duracionMs: 1 };
}

function setup(opts: { procesar?: () => Promise<ProcesamientoResultado> } = {}) {
  const sent: Array<{ conversationId: string; out: Outbound }> = [];
  const seawhite = new FakeSeaWhite();
  const registro = new MemoryRegistro();
  const procesar = vi.fn(opts.procesar ?? (async () => resultado([carnet("33615617", "18-10-2026"), carnet("29642599", "31-10-2026", { observaciones: "Inhabilitado para conducir" })])));
  const deps: BotDeps = {
    botName: "Javier",
    timezone: "America/Argentina/Buenos_Aires",
    catalogo: new MemoryCatalogo(CLIENTES),
    cargadores: new MemoryCargadores(["2914413200"]),
    registro,
    sessions: new MemorySessions(),
    log: new NoopMessageLog(),
    seawhite,
    procesador: { procesar },
    descargarAdjunto: vi.fn(async () => PDF),
    lotes: new LotesPendientes(),
    logger,
    now: () => HOY,
  };
  const engine = new BotEngine(deps, { send: async (conversationId, out) => void sent.push({ conversationId, out }) });
  let n = 0;
  const say = async (phone: string, text: string, attachments: IncomingAttachment[] = [], conversationId = phone === CARGADOR ? "c1" : "c2") => {
    sent.length = 0;
    const msg: IncomingMessage = { id: String(++n), conversationId, accountId: "1", text, attachments, phone };
    await engine.handle(msg);
    return sent.map((s) => s.out);
  };
  return { engine, deps, seawhite, registro, procesar, say, sent };
}

const pdfAdj = (name = "carnets.pdf"): IncomingAttachment => ({ url: `https://chatwoot/${name}`, fileType: "file", contentType: "application/pdf", fileName: name });
const texts = (outs: Outbound[]) => outs.map((o) => (o.kind === "file" ? `[file ${o.filename}]` : o.text)).join("\n---\n");
const buttons = (outs: Outbound[]) => outs.flatMap((o) => (o.kind === "buttons" ? o.buttons.map((b) => b.title) : []));

describe("reconocimiento de cliente y planta", () => {
  it("entiende las formas habituales de escribirlos", () => {
    expect(resolver("Total planta 2", CLIENTES)).toMatchObject({ cliente: { codigo: "999991" }, planta: { codigo: "000002" } });
    expect(resolver("total austral p1", CLIENTES)).toMatchObject({ cliente: { codigo: "999991" }, planta: { codigo: "000001" } });
    expect(resolver("vista 1", CLIENTES)).toMatchObject({ cliente: { codigo: "999992" }, planta: { codigo: "000001" } });
    expect(resolver("999991 000002", CLIENTES)).toMatchObject({ cliente: { codigo: "999991" }, planta: { codigo: "000002" } });
    expect(resolver("cheee puedo entrar a TOTAL planta2??", CLIENTES).planta?.codigo).toBe("000002");
    expect(resolver("shell planta 2", CLIENTES)).toEqual({});
    expect(resolver("total planta 9", CLIENTES)).toMatchObject({ cliente: { codigo: "999991" }, planta: undefined });
  });
});

describe("cargador", () => {
  it("cliente + planta + PDF en un mensaje -> resumen -> Confirmar -> carga y registro", async () => {
    const { say, seawhite, registro } = setup();
    let outs = await say(CARGADOR, "Total planta 1", [pdfAdj()]);
    expect(texts(outs)).toMatch(/Procesando \*carnets\.pdf\* para \*TOTAL AUSTRAL \(PRUEBA\) – Planta 1\*/);
    expect(texts(outs)).toMatch(/2 listos para cargar/);
    expect(texts(outs)).toMatch(/Inhabilitado para conducir/);
    expect(texts(outs)).not.toMatch(/hola|gracias/i); // sin cordialidades
    expect(buttons(outs)).toEqual(["Confirmar carga", "Cancelar"]);
    expect(seawhite.cargas).toHaveLength(0); // nada se carga sin confirmar

    outs = await say(CARGADOR, "Confirmar carga");
    expect(seawhite.cargas[0]!.registros.map((r) => [r.cliente, r.subcliente, r.identificador, r.vencimiento])).toEqual([
      ["999991", "000001", "33615617", "18-10-2026"],
      ["999991", "000001", "29642599", "31-10-2026"],
    ]);
    expect(texts(outs)).toMatch(/Carga completada/);
    expect(texts(outs)).toMatch(/2 cargados \(2 nuevos\)/);
    expect(registro.carnets.map((c) => [c.identificador, c.seawhiteId, c.apellidoNombre])).toEqual([
      ["33615617", 1, "PERSONA 33615617"],
      ["29642599", 2, "PERSONA 29642599"],
    ]);
    expect(registro.cargas[0]).toMatchObject({ estado: "completada", correctos: 2 });

    // Queda listo para el próximo PDF.
    outs = await say(CARGADOR, "vista", [pdfAdj("otro.pdf")]);
    expect(texts(outs)).toMatch(/VISTA ENERGY \(PRUEBA\) – Planta 1/); // planta única: no pregunta
  });

  it("si falta cliente o planta los pide con botones", async () => {
    const { say, procesar } = setup();
    let outs = await say(CARGADOR, "", [pdfAdj()]);
    expect(texts(outs)).toMatch(/Para qué cliente/);
    expect(buttons(outs)).toEqual(["Total Austral", "Vista Energy"]);
    outs = await say(CARGADOR, "Total Austral");
    expect(buttons(outs)).toEqual(["Planta 1", "Planta 2"]);
    outs = await say(CARGADOR, "Planta 2");
    expect(procesar).toHaveBeenCalledTimes(1);
    expect(texts(outs)).toMatch(/Planta 2/);
  });

  it("planta inexistente: avisa y ofrece las plantas", async () => {
    const { say } = setup();
    const outs = await say(CARGADOR, "total planta 9");
    expect(texts(outs)).toMatch(/No encontré esa planta/);
    expect(buttons(outs)).toEqual(["Planta 1", "Planta 2"]);
  });

  it("con cliente y planta pero sin PDF, pide el PDF", async () => {
    const { say } = setup();
    const outs = await say(CARGADOR, "total p1");
    expect(texts(outs)).toMatch(/Mandá el PDF para \*TOTAL AUSTRAL \(PRUEBA\) – Planta 1\*/);
  });

  it("Cancelar no carga nada", async () => {
    const { say, seawhite } = setup();
    await say(CARGADOR, "Total planta 1", [pdfAdj()]);
    const outs = await say(CARGADOR, "Cancelar");
    expect(texts(outs)).toMatch(/cancelada/);
    expect(seawhite.cargas).toHaveLength(0);
  });

  it("con una carga pendiente, un PDF nuevo no la pisa", async () => {
    const { say, procesar } = setup();
    await say(CARGADOR, "Total planta 1", [pdfAdj()]);
    const outs = await say(CARGADOR, "vista", [pdfAdj("otro.pdf")]);
    expect(texts(outs)).toMatch(/carga pendiente de confirmar/);
    expect(procesar).toHaveBeenCalledTimes(1);
  });

  it("rechaza adjuntos que no son PDF", async () => {
    const { say } = setup();
    const outs = await say(CARGADOR, "", [{ url: "https://chatwoot/foto.jpg", fileType: "image", contentType: "image/jpeg" }]);
    expect(texts(outs)).toMatch(/Solo se aceptan archivos PDF/);
  });

  it("si no queda ningún carnet apto, no pide confirmación", async () => {
    const { say } = setup({ procesar: async () => resultado([], [{ pagina: 1, referencia: "—", motivo: "Carnet ilegible" }]) });
    const outs = await say(CARGADOR, "total p1", [pdfAdj()]);
    expect(texts(outs)).toMatch(/ningún carnet apto/);
    expect(buttons(outs)).toEqual([]);
  });

  it("si falla el procesamiento lo informa y queda listo para reintentar", async () => {
    const { say } = setup({ procesar: async () => Promise.reject(new Error("timeout de Claude")) });
    let outs = await say(CARGADOR, "total p1", [pdfAdj()]);
    expect(texts(outs)).toMatch(/No pude procesar el PDF: timeout de Claude/);
    outs = await say(CARGADOR, "total p1");
    expect(texts(outs)).toMatch(/Mandá el PDF/);
  });
});

describe("chofer", () => {
  async function conCarnets() {
    const ctx = setup();
    await ctx.say(CARGADOR, "Total planta 1", [pdfAdj()]);
    await ctx.say(CARGADOR, "Confirmar carga");
    return ctx;
  }

  it("saluda con el nombre configurado y pide el DNI", async () => {
    const { say } = setup();
    const outs = await say(CHOFER, "hola");
    expect(texts(outs)).toMatch(/Hola, soy Javier/);
    expect(outs).toHaveLength(1);
  });

  it("DNI -> plantas habilitadas + documentación -> botón para su carnet", async () => {
    const { say } = await conCarnets();
    let outs = await say(CHOFER, "cheee puedo entrar? 33.615.617");
    const t = texts(outs);
    expect(t).toMatch(/Hola, soy Javier/);
    expect(t).toMatch(/PERSONA 33615617/);
    expect(t).toMatch(/TOTAL AUSTRAL \(PRUEBA\) – Planta 1: ⚠️ habilitado hasta 18\/10\/2026 \(vence en 3 días\)/);
    expect(t).toMatch(/Licencia: ✅ 10\/03\/2027/);
    expect(t).toMatch(/ART: ❌ venció el 01\/10\/2026/);
    expect(buttons(outs)).toEqual(["📄 Sí, mandámelo", "No, gracias"]);

    outs = await say(CHOFER, "📄 Sí, mandámelo");
    const file = outs.find((o) => o.kind === "file");
    expect(file).toMatchObject({ kind: "file", filename: "33615617.pdf" });
    expect((file as Extract<Outbound, { kind: "file" }>).data.toString()).toContain("33615617"); // SU carnet
    expect(buttons(outs)).toEqual(["Otra consulta", "Eso es todo"]);
  });

  it("habilitado en varias plantas: las muestra todas y ofrece cada carnet", async () => {
    const ctx = await conCarnets();
    await ctx.say(CARGADOR, "total planta 2", [pdfAdj()]);
    await ctx.say(CARGADOR, "Confirmar carga");
    const outs = await ctx.say(CHOFER, "33615617");
    expect(texts(outs)).toMatch(/Planta 1: .*habilitado/);
    expect(texts(outs)).toMatch(/Planta 2: .*habilitado/);
    expect(buttons(outs)).toEqual(["Total P1", "Total P2", "No, gracias"]);
  });

  it("pregunta por una planta donde no tiene credencial", async () => {
    const { say } = await conCarnets();
    const outs = await say(CHOFER, "puedo entrar a vista planta 1? 33615617");
    expect(texts(outs)).toMatch(/No tenés credencial cargada para \*VISTA ENERGY \(PRUEBA\) – Planta 1\*/);
  });

  it("primero la planta y después el DNI", async () => {
    const { say } = await conCarnets();
    let outs = await say(CHOFER, "puedo entrar a total planta 1?");
    expect(texts(outs)).toMatch(/Pasame tu \*DNI\*.*TOTAL AUSTRAL \(PRUEBA\) – Planta 1/s);
    outs = await say(CHOFER, "33615617");
    expect(texts(outs)).toMatch(/Planta 1: ⚠️ habilitado/);
  });

  it("DNI sin credenciales: lo dice y muestra la documentación igual", async () => {
    const { say } = setup();
    const outs = await say(CHOFER, "30123456");
    expect(texts(outs)).toMatch(/No encontré credenciales de ingreso/);
    expect(texts(outs)).toMatch(/Licencia/);
    expect(buttons(outs)).toEqual(["Otra consulta", "Eso es todo"]);
  });

  it("un chofer que manda un PDF recibe el aviso de que es solo para consultas", async () => {
    const { say, procesar } = setup();
    const outs = await say(CHOFER, "", [pdfAdj()]);
    expect(texts(outs)).toMatch(/no se reciben archivos: es solo para consultas/);
    expect(procesar).not.toHaveBeenCalled();
  });

  it("los cargadores no consultan: un DNI es para ellos un dato de carga", async () => {
    const { say } = setup();
    const outs = await say(CARGADOR, "33615617");
    expect(texts(outs)).not.toMatch(/habilitado/);
    expect(texts(outs)).toMatch(/Mandá cliente, planta y el PDF/);
  });
});

describe("motor", () => {
  it("si respondió una persona, el bot no contesta", async () => {
    const { engine, say } = setup();
    await engine.markHandedOff("c2");
    expect(await say(CHOFER, "hola")).toEqual([]);
  });
});
