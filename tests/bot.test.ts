/**
 * El bot de punta a punta con dobles: catálogo, cargadores, registro y
 * sesiones en memoria; SEA WHITE y el procesador de carnets falsos.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { PDFDocument } from "pdf-lib";
import { resolver, sugerir } from "../src/bot/catalogo.js";
import { LotesPendientes, type BotDeps, type SeaWhiteService } from "../src/bot/deps.js";
import { BotEngine } from "../src/bot/engine.js";
import type { IncomingAttachment, IncomingMessage, Outbound } from "../src/bot/types.js";
import type { OnEtapa, ProcesamientoResultado } from "../src/extraction/procesarCarnets.js";
import type { CarnetListo } from "../src/extraction/review.js";
import type { Consulta, RegistroCarga, ResumenCarga, TipoRegistro } from "../src/integrations/seawhite/types.js";
import { MemoryListaTelefonos } from "../src/storage/cargadores.js";
import { MemoryFallas } from "../src/storage/fallas.js";
import type { ResultadoVerificacion } from "../src/extraction/verificadorComprobantes.js";
import { MemoryCatalogo, type Cliente } from "../src/storage/catalogo.js";
import { MemoryRegistro } from "../src/storage/registro.js";
import { MemorySessions, NoopMessageLog } from "../src/storage/sessions.js";

const logger = pino({ level: "silent" });
const PDF = Buffer.from("%PDF-1.4\n%x\n");
const CARGADOR = "+5492914413200";
const CHOFER = "+5492995551234";
/** Números habilitados para consultar (la app es cerrada). */
const CONSULTORES = ["2995551234", "2994440000"];
const HOY = new Date("2026-10-15T12:00:00-03:00");

const CLIENTES: Cliente[] = [
  {
    codigo: "999991",
    nombre: "TOTAL AUSTRAL",
    alias: ["total", "total austral"],
    plantas: [
      { codigo: "000001", nombre: "Planta 1", alias: ["p1"] },
      { codigo: "000002", nombre: "Planta 2", alias: [] },
    ],
  },
  { codigo: "999992", nombre: "VISTA ENERGY", alias: ["vista"], plantas: [{ codigo: "000001", nombre: "Planta 1", alias: [] }] },
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
  /** Comprobantes de VTV/seguro: "vtv:AF498ZJ" -> PDF. */
  docs = new Map<string, Buffer>([
    ["vtv:AF498ZJ", Buffer.concat([PDF, Buffer.from("VTV AF498ZJ")])],
    ["seguro:AF498ZJ", Buffer.concat([PDF, Buffer.from("SEGURO AF498ZJ")])],
    ["vtv:AG536VG", Buffer.concat([PDF, Buffer.from("VTV AG536VG")])],
  ]);
  /** Sólo el teléfono del chofer de prueba está "registrado" en SEA WHITE. */
  async nombrePorTelefono(telefono: string): Promise<string | null> {
    return telefono === "+5492995551234" ? "OJEDA, BORIS DANIEL" : null;
  }
  async documentoVehiculo(tipo: "vtv" | "seguro", dominio: string) {
    const pdf = this.docs.get(`${tipo}:${dominio}`);
    return pdf ? { pdf, nombreArchivo: `${dominio}.pdf` } : null;
  }
  async descargarPdf(tipo: TipoRegistro, id: number): Promise<Buffer> {
    const d = [...this.datos.entries()].find(([k, v]) => k.startsWith(tipo) && v.id === id);
    if (!d) throw new Error("no existe");
    return d[1].pdf;
  }
}

function carnet(identificador: string, vencimiento: string, extra: Partial<CarnetListo> = {}): CarnetListo {
  return { tipo: "chofer", identificador, vencimiento, apellidoNombre: `PERSONA ${identificador}`, clienteDetectado: "TOTAL", pagina: 1, observaciones: null, motivoVencimiento: null, vencido: false, pdf: PDF, ...extra };
}

function resultado(aceptados: CarnetListo[], rechazados: ProcesamientoResultado["rechazados"] = []): ProcesamientoResultado {
  return { aceptados, rechazados, formato: "test", notaModelo: "", manifest: { carnets: [], descartados: [] }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 }, costoUsd: 0.1, duracionMs: 1 };
}

type ProcesarFn = (pdf: Buffer, f: string, onEtapa?: OnEtapa) => Promise<ProcesamientoResultado>;

function setup(opts: { procesar?: ProcesarFn; verificacion?: Partial<ResultadoVerificacion> } = {}) {
  const sent: Array<{ conversationId: string; out: Outbound }> = [];
  const seawhite = new FakeSeaWhite();
  const registro = new MemoryRegistro();
  const porDefecto: ProcesarFn = async (_pdf, _f, onEtapa) => {
    await onEtapa?.("separando");
    await onEtapa?.("verificando");
    return resultado([carnet("33615617", "18-10-2026"), carnet("29642599", "31-10-2026", { observaciones: "Inhabilitado para conducir" })]);
  };
  const procesar = vi.fn(opts.procesar ?? porDefecto);
  const fallas = new MemoryFallas();
  const deps: BotDeps = {
    botName: "Javier",
    timezone: "America/Argentina/Buenos_Aires",
    catalogo: new MemoryCatalogo(CLIENTES),
    cargadores: new MemoryListaTelefonos(["2914413200"]),
    consultores: new MemoryListaTelefonos(CONSULTORES),
    registro,
    sessions: new MemorySessions(),
    log: new NoopMessageLog(),
    seawhite,
    procesador: { procesar },
    descargarAdjunto: vi.fn(async () => PDF),
    // Resguardo falso: aprueba salvo que el test pida otra cosa.
    verificador: {
      verificar: vi.fn(async (_pdf: Buffer, _t: "vtv" | "seguro", patente: string, nombreArchivo: string | null) => ({
        ok: true,
        patentePedida: patente,
        patenteArchivo: nombreArchivo?.replace(/\.pdf$/, "") ?? null,
        patentesEnPdf: [patente],
        tipoDetectado: _t,
        ...opts.verificacion,
      })),
    },
    fallas,
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
  return { engine, deps, seawhite, registro, procesar, say, sent, fallas };
}

const pdfAdj = (name = "carnets.pdf"): IncomingAttachment => ({ url: `https://chatwoot/${name}`, fileType: "file", contentType: "application/pdf", fileName: name });
const texts = (outs: Outbound[]) => outs.map((o) => (o.kind === "file" ? `[file ${o.filename}]` : o.kind === "image" ? `[imagen] ${o.caption}` : o.text)).join("\n---\n");
const buttons = (outs: Outbound[]) => outs.flatMap((o) => (o.kind === "buttons" ? o.buttons.map((b) => b.title) : []));

describe("¿Quisiste decir...? (sugerencia de cliente y subcliente)", () => {
  // Como quedan en la base: el panel arma alias con el nombre completo (y la primera palabra si es larga).
  const REALES: Cliente[] = [
    ...CLIENTES,
    { codigo: "999993", nombre: "TANGO ENERGY", alias: ["tango energy", "tango"], plantas: [{ codigo: "000001", nombre: "Planta 1", alias: [] }] },
    { codigo: "999994", nombre: "PAN AMERICAN ENERGY", alias: ["pan american energy"], plantas: [{ codigo: "000001", nombre: "SLB", alias: [] }] },
    { codigo: "999995", nombre: "PLUSPETROL", alias: ["pluspetrol"], plantas: [{ codigo: "000001", nombre: "Planta 1", alias: [] }] },
  ];
  const sug = (t: string) => {
    const r = sugerir(t, REALES);
    return r ? `${r.cliente!.codigo}/${r.planta?.codigo ?? "-"}` : null;
  };

  it("abreviaturas, palabras pegadas y errores de tipeo (casos reales)", () => {
    expect(sug("Pan  SLB")).toBe("999994/000001");
    expect(sug("panamelic slb")).toBe("999994/000001");
    expect(sug("pan american slb")).toBe("999994/000001");
    expect(sug("tatal planta 1")).toBe("999991/000001");
    expect(sug("tango plnta 1")).toBe("999993/000001");
    expect(sug("plus petrol 1")).toBe("999995/000001");
  });

  it("el subcliente con nombre propio también es una pista ('slb' solo)", () => {
    expect(sug("slb")).toBe("999994/000001");
  });

  it("no adivina: nada parecido, o 'planta 1' sola (la tienen todos)", () => {
    expect(sug("shell planta 2")).toBeNull();
    expect(sug("planta 1")).toBeNull();
    expect(sug("hola")).toBeNull();
  });

  it("mismo cliente con dos subclientes parejos: sugiere sólo el cliente", () => {
    expect(sug("tatal")).toBe("999991/-");
  });
});

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


/** Carga: [Menú] -> cliente -> operadora -> tipo (todo por menús). Queda esperando el PDF. */
async function elegirCarga(say: Awaited<ReturnType<typeof setup>>["say"], tipo: string, cliente = "Total Austral", operadora = "Planta 1") {
  await say(CARGADOR, "Menú 😊");
  await say(CARGADOR, cliente);
  await say(CARGADOR, "✅ Sí"); // "Elegiste X. ¿Es correcto?"
  await say(CARGADOR, operadora);
  return say(CARGADOR, tipo);
}

/** Carga completa por el flujo del cargador (para preparar datos de los tests de consulta). */
const MENU_POST_CARGA = ["Choferes (Total)", "Dominios (Total)", "🔄 Cambiar cliente"];

async function cargar(say: Awaited<ReturnType<typeof setup>>["say"], tipo: "👤 Choferes" | "🚛 Dominios", cliente = "Total Austral", operadora = "Planta 1") {
  await elegirCarga(say, tipo, cliente, operadora);
  await say(CARGADOR, "", [pdfAdj()]);
  return say(CARGADOR, "Confirmar carga");
}

describe("cargador", () => {
  it("cliente (menú) -> operadora (menú) -> tipo -> PDF con avisos de progreso -> Confirmar -> carga", async () => {
    const { say, seawhite, registro } = setup();

    let outs = await say(CARGADOR, "hola, qué tal");
    expect(texts(outs)).toBe("¡Hola! 👋\n¿Qué *cliente* vas a cargar?");
    expect(buttons(outs)).toEqual(["Total Austral", "Vista Energy"]);

    outs = await say(CARGADOR, "Total Austral");
    expect(texts(outs)).toBe("Elegiste *TOTAL AUSTRAL*. ¿Es correcto?");
    expect(buttons(outs)).toEqual(["✅ Sí", "✏️ No"]);

    outs = await say(CARGADOR, "✅ Sí");
    expect(texts(outs)).toBe("*TOTAL AUSTRAL*\n¿Qué *operadora*?");
    expect(buttons(outs)).toEqual(["Planta 1", "Planta 2"]);

    outs = await say(CARGADOR, "Planta 1");
    expect(texts(outs)).toBe("*TOTAL AUSTRAL – Planta 1*\n¿Qué documentación vas a cargar?");
    expect(buttons(outs)).toEqual(["👤 Choferes", "🚛 Dominios", "Eso es todo, gracias"]);

    outs = await say(CARGADOR, "👤 Choferes");
    expect(texts(outs)).toMatch(/Mandá el PDF \(o las fotos\) con los carnets de personas/);

    outs = await say(CARGADOR, "", [pdfAdj()]);
    const t = texts(outs);
    expect(t).toMatch(/Recibí \*carnets\.pdf\*\. Estoy procesando el documento/);
    expect(t).toMatch(/Carnets separados\. Estoy verificando/);
    expect(t).toMatch(/2 listos para cargar \(2 personas\)/);
    expect(t).toMatch(/Inhabilitado para conducir/);
    expect(buttons(outs)).toEqual(["Confirmar carga", "Cancelar"]);
    expect(seawhite.cargas).toHaveLength(0); // nada se carga sin confirmar

    outs = await say(CARGADOR, "Confirmar carga");
    expect(seawhite.cargas).toHaveLength(1);
    expect(seawhite.cargas[0]!.tipo).toBe("chofer");
    expect(seawhite.cargas[0]!.registros.map((r) => [r.cliente, r.subcliente, r.identificador, r.vencimiento, r.razonSocial])).toEqual([
      ["999991", "000001", "33615617", "18-10-2026", "PERSONA 33615617"],
      ["999991", "000001", "29642599", "31-10-2026", "PERSONA 29642599"],
    ]);
    expect(texts(outs)).toMatch(/Guardando 2 carnets en el sistema/);
    expect(texts(outs)).toMatch(/Carga completada.*2 cargados \(2 nuevos\)/s);
    // Otra carga del mismo cliente y operadora, o terminar.
    expect(buttons(outs)).toEqual(MENU_POST_CARGA);
    expect(registro.carnets.map((c) => [c.identificador, c.seawhiteId])).toEqual([
      ["33615617", 1],
      ["29642599", 2],
    ]);
  });

  it("razón social: nombre y apellido (el carnet dice APELLIDO, NOMBRE); los dominios no la llevan", async () => {
    const { say, seawhite } = setup({
      procesar: async () => resultado([carnet("33615617", "18-10-2026", { apellidoNombre: "PEREZ, JUAN CARLOS" }), carnet("AF498ZJ", "31-12-2026", { tipo: "dominio", apellidoNombre: null })]),
    });
    await elegirCarga(say, "👤 Choferes");
    await say(CARGADOR, "", [pdfAdj()]);
    await say(CARGADOR, "Confirmar carga");
    await say(CARGADOR, "🚛 Cargar dominios");
    await say(CARGADOR, "Confirmar carga");
    expect(seawhite.cargas.map((c) => [c.tipo, c.registros[0]!.razonSocial])).toEqual([
      ["chofer", "JUAN CARLOS PEREZ"],
      ["dominio", null],
    ]);
  });

  it("otra carga: mismo cliente y operadora con [Choferes]/[Dominios]; para cambiar de cliente, Eso es todo", async () => {
    const { say, procesar } = setup();
    await elegirCarga(say, "👤 Choferes");
    await say(CARGADOR, "", [pdfAdj()]);
    await say(CARGADOR, "Confirmar carga");
    let outs = await say(CARGADOR, "🚛 Dominios");
    expect(texts(outs)).toMatch(/\*TOTAL AUSTRAL – Planta 1\* – dominios.*Mandá el PDF/s); // no vuelve a preguntar cliente
    await say(CARGADOR, "Eso es todo, gracias");
    outs = await say(CARGADOR, "hola");
    expect(texts(outs)).toMatch(/¿Qué \*cliente\* vas a cargar\?/);
    expect(buttons(outs)).toEqual(["Total Austral", "Vista Energy"]);
    expect(procesar).toHaveBeenCalledTimes(1);
  });

  it("después de una carga, [🔄 Cambiar cliente] vuelve a elegir cliente y operadora", async () => {
    const { say, seawhite } = setup();
    await elegirCarga(say, "👤 Choferes");
    await say(CARGADOR, "", [pdfAdj()]);
    await say(CARGADOR, "Confirmar carga");
    let outs = await say(CARGADOR, "🔄 Cambiar cliente");
    expect(texts(outs)).toBe("¿Qué *cliente* vas a cargar?");
    expect(buttons(outs)).toEqual(["Total Austral", "Vista Energy"]);
    await say(CARGADOR, "Vista Energy");
    await say(CARGADOR, "✅ Sí");
    await say(CARGADOR, "Planta 1");
    outs = await say(CARGADOR, "🚛 Dominios");
    expect(texts(outs)).toMatch(/\*VISTA ENERGY – Planta 1\* – dominios/);
    await say(CARGADOR, "", [pdfAdj()]);
    await say(CARGADOR, "Cargar choferes"); // el PDF de prueba es de personas
    await say(CARGADOR, "Confirmar carga");
    expect(seawhite.cargas.map((c) => c.registros[0]!.cliente)).toEqual(["999991", "999992"]);
  });

  it("después de elegir el cliente se confirma: con [No] vuelve la lista de clientes", async () => {
    const { say } = setup();
    await say(CARGADOR, "hola");
    let outs = await say(CARGADOR, "Vista Energy");
    expect(texts(outs)).toBe("Elegiste *VISTA ENERGY*. ¿Es correcto?");
    outs = await say(CARGADOR, "✏️ No");
    expect(texts(outs)).toBe("¿Qué *cliente* vas a cargar?");
    expect(buttons(outs)).toEqual(["Total Austral", "Vista Energy"]);
    await say(CARGADOR, "Total Austral");
    outs = await say(CARGADOR, "✅ Sí");
    expect(texts(outs)).toBe("*TOTAL AUSTRAL*\n¿Qué *operadora*?");
    // Escribir otra cosa en vez de contestar repite la pregunta.
    await say(CARGADOR, "Menú 😊");
    await say(CARGADOR, "Vista Energy");
    outs = await say(CARGADOR, "eh?");
    expect(texts(outs)).toBe("Elegiste *VISTA ENERGY*. ¿Es correcto?");
  });

  it("cliente con una sola operadora: igual se elige del menú", async () => {
    const { say } = setup();
    await say(CARGADOR, "hola");
    await say(CARGADOR, "Vista Energy");
    const outs = await say(CARGADOR, "✅ Sí");
    expect(texts(outs)).toBe("*VISTA ENERGY*\n¿Qué *operadora*?");
    expect(buttons(outs)).toEqual(["Planta 1"]);
  });

  it("escribir el cliente en vez de tocar el menú: se repite el menú (no se escribe nada)", async () => {
    const { say } = setup();
    await say(CARGADOR, "hola");
    const outs = await say(CARGADOR, "total planta 1");
    expect(texts(outs)).toMatch(/¿Qué \*cliente\* vas a cargar\?/);
    expect(buttons(outs)).toEqual(["Total Austral", "Vista Energy"]);
  });

  it("el archivo mandado antes de terminar de elegir se guarda y se procesa al completar", async () => {
    const { say, procesar } = setup();
    let outs = await say(CARGADOR, "", [pdfAdj()]);
    expect(texts(outs)).toMatch(/Guardé el archivo\. Primero elegí cliente, operadora y qué documentación es/);
    expect(buttons(outs)).toEqual(["Total Austral", "Vista Energy"]);
    await say(CARGADOR, "Total Austral");
    await say(CARGADOR, "✅ Sí");
    await say(CARGADOR, "Planta 1");
    expect(procesar).not.toHaveBeenCalled();
    outs = await say(CARGADOR, "👤 Choferes");
    expect(procesar).toHaveBeenCalledTimes(1);
    expect(buttons(outs)).toEqual(["Confirmar carga", "Cancelar"]);
  });

  it("más de 10 clientes: el menú va de a páginas con [➡️ Ver más] y [⬅️ Anteriores]", async () => {
    const { say, deps } = setup();
    const muchos = Array.from({ length: 19 }, (_, i) => ({
      codigo: String(i + 1).padStart(4, "0"),
      nombre: `CLIENTE ${String(i + 1).padStart(2, "0")}`,
      alias: [],
      plantas: [{ codigo: "0000", nombre: "OPERADORAS TODAS", alias: [] }],
    }));
    deps.catalogo = new MemoryCatalogo(muchos);
    let outs = await say(CARGADOR, "hola");
    expect(buttons(outs)).toEqual([...Array.from({ length: 8 }, (_, i) => `Cliente ${String(i + 1).padStart(2, "0")}`), "➡️ Ver más"]);
    outs = await say(CARGADOR, "➡️ Ver más");
    expect(buttons(outs)).toEqual(["⬅️ Anteriores", ...Array.from({ length: 8 }, (_, i) => `Cliente ${String(i + 9).padStart(2, "0")}`), "➡️ Ver más"]);
    outs = await say(CARGADOR, "➡️ Ver más");
    expect(buttons(outs)).toEqual(["⬅️ Anteriores", "Cliente 17", "Cliente 18", "Cliente 19"]);
    await say(CARGADOR, "Cliente 18");
    outs = await say(CARGADOR, "✅ Sí");
    expect(texts(outs)).toBe("*CLIENTE 18*\n¿Qué *operadora*?");
    expect(buttons(outs)).toEqual(["OPERADORAS TODAS"]);
  });

  it("códigos de 4 dígitos (0001 / 0000) llegan tal cual a SEA WHITE", async () => {
    const { say, seawhite, deps } = setup();
    deps.catalogo = new MemoryCatalogo([{ codigo: "0001", nombre: "HALLIBURTON ARGENTINA SRL", alias: ["halliburton"], plantas: [{ codigo: "0000", nombre: "OPERADORAS TODAS", alias: [] }] }]);
    await elegirCarga(say, "👤 Choferes", "Halliburton", "OPERADORAS TODAS");
    await say(CARGADOR, "", [pdfAdj()]);
    await say(CARGADOR, "Confirmar carga");
    expect(seawhite.cargas[0]!.registros.map((r) => [r.cliente, r.subcliente])).toEqual([
      ["0001", "0000"],
      ["0001", "0000"],
    ]);
  });

  it("FILTRO DE TIPO: eligió dominios y el PDF es de choferes -> avisa y no carga", async () => {
    const { say, seawhite } = setup();
    await elegirCarga(say, "🚛 Dominios");
    let outs = await say(CARGADOR, "", [pdfAdj()]);
    expect(texts(outs)).toMatch(/Elegiste cargar \*dominios\*, pero el PDF tiene 2 carnets de personas/);
    expect(buttons(outs)).toEqual(["Cargar choferes", "Cancelar"]);

    outs = await say(CARGADOR, "Confirmar carga"); // no hay nada de dominio para confirmar
    expect(seawhite.cargas).toHaveLength(0);

    outs = await say(CARGADOR, "Cargar choferes");
    expect(buttons(outs)).toEqual(["Confirmar carga", "Cancelar"]);
    await say(CARGADOR, "Confirmar carga");
    expect(seawhite.cargas[0]!.tipo).toBe("chofer");
  });

  it("FILTRO DE TIPO: PDF mezclado -> carga sólo el tipo elegido y avisa el resto", async () => {
    const { say, seawhite } = setup({
      procesar: async () => resultado([carnet("33615617", "18-10-2026"), carnet("AF498ZJ", "31-12-2026", { tipo: "dominio", apellidoNombre: null, pagina: 2 })]),
    });
    await elegirCarga(say, "👤 Choferes");
    let outs = await say(CARGADOR, "", [pdfAdj()]);
    expect(texts(outs)).toMatch(/⚠️ También hay 1 vehículo: ahora van solo las personas\. Al terminar te ofrezco cargarlo\./);
    expect(texts(outs)).toMatch(/1 listo para cargar \(1 persona\)/);
    outs = await say(CARGADOR, "Confirmar carga");
    expect(seawhite.cargas.map((c) => [c.tipo, c.registros.map((r) => r.identificador)])).toEqual([["chofer", ["33615617"]]]);
    // Botón para cargar los vehículos del MISMO documento (sin reprocesar).
    expect(texts(outs)).toMatch(/también tiene 1 carnets de vehículos/);
    expect(buttons(outs)).toEqual(["🚛 Cargar dominios", "Menú 😊", "Eso es todo, gracias"]);
    // Resultado y pregunta en UN mensaje (separados, WhatsApp los desordenaba).
    const ultimo = outs.at(-1) as Extract<Outbound, { kind: "buttons" }>;
    expect(ultimo.text).toMatch(/Carga completada[\s\S]*también tiene 1 carnets de vehículos/);
    outs = await say(CARGADOR, "🚛 Cargar dominios");
    expect(buttons(outs)).toEqual(["Confirmar carga", "Cancelar"]);
    // Las personas ya se cargaron: no se vuelve a avisar que "también hay personas".
    expect(texts(outs)).not.toMatch(/También hay/);
    outs = await say(CARGADOR, "Confirmar carga");
    expect(seawhite.cargas.map((c) => [c.tipo, c.registros.map((r) => r.identificador)])).toEqual([
      ["chofer", ["33615617"]],
      ["dominio", ["AF498ZJ"]],
    ]);
    // Ya no se ofrece nada más: resultado + "¿Querés cargar más…?" en un mensaje.
    expect(buttons(outs)).not.toContain("👤 Cargar choferes");
    expect((outs.at(-1) as Extract<Outbound, { kind: "buttons" }>).text).toMatch(/Carga completada[\s\S]*Querés cargar más documentación de este cliente, o cambiar de cliente/);
  });

  it("LISTADO mezclado: los dos avisos salen igual eligiendo Choferes o Dominios", async () => {
    for (const [boton, aviso] of [
      ["👤 Choferes", /También hay 1 vehículo: ahora van solo las personas/],
      ["🚛 Dominios", /También hay 1 persona: ahora van solo los vehículos\. Al terminar te ofrezco cargarla\./],
    ] as const) {
      const { say } = setup({
        procesar: async (_pdf, _f, onEtapa) => {
          await onEtapa?.("verificando", "listado");
          const r = resultado([carnet("33919536", "31-10-2026"), carnet("AG105UX", "12-03-2027", { tipo: "dominio", apellidoNombre: null })]);
          return { ...r, manifest: { modo: "listado", carnets: [], descartados: [] } };
        },
      });
      await elegirCarga(say, boton);
      const t = texts(await say(CARGADOR, "", [pdfAdj("PAE SLB - Estatus.pdf")]));
      expect(t).toMatch(/📋 Es un listado de estado/);
      expect(t).toMatch(aviso);
    }
  });

  it("LISTADO de estado: avisa que no tiene carnet individual y habla de registros", async () => {
    const { say, seawhite } = setup({
      procesar: async (_pdf, _f, onEtapa) => {
        await onEtapa?.("separando");
        await onEtapa?.("verificando", "listado");
        const r = resultado([carnet("33919536", "31-10-2026"), carnet("AG105UX", "12-03-2027", { tipo: "dominio", apellidoNombre: null })]);
        return { ...r, manifest: { modo: "listado", carnets: [], descartados: [] } };
      },
    });
    await elegirCarga(say, "👤 Choferes");
    let outs = await say(CARGADOR, "", [pdfAdj("PAE SLB - Estatus.pdf")]);
    expect(texts(outs)).toMatch(/Estoy procesando el documento/);
    expect(texts(outs)).toMatch(/📋 Es un listado de estado: cada uno se sube con el documento completo y su fila marcada/);
    expect(texts(outs)).toMatch(/⚠️ También hay 1 vehículo: ahora van solo las personas/);
    expect(texts(outs)).not.toMatch(/Carnets separados/);
    outs = await say(CARGADOR, "Confirmar carga");
    expect(texts(outs)).toMatch(/Guardando 1 registro en el sistema/);
    expect(texts(outs)).toMatch(/también tiene 1 registros de vehículos/);
    await say(CARGADOR, "🚛 Cargar dominios");
    await say(CARGADOR, "Confirmar carga");
    expect(seawhite.cargas.map((c) => c.tipo)).toEqual(["chofer", "dominio"]);
  });

  it("PDF mezclado: Menú después de cargar un tipo descarta el otro", async () => {
    const { say, seawhite } = setup({
      procesar: async () => resultado([carnet("33615617", "18-10-2026"), carnet("AF498ZJ", "31-12-2026", { tipo: "dominio", apellidoNombre: null, pagina: 2 })]),
    });
    await elegirCarga(say, "🚛 Dominios");
    await say(CARGADOR, "", [pdfAdj()]);
    await say(CARGADOR, "Confirmar carga");
    const outs = await say(CARGADOR, "Menú 😊");
    expect(buttons(outs)).toEqual(["Total Austral", "Vista Energy"]);
    expect(seawhite.cargas.map((c) => c.tipo)).toEqual(["dominio"]);
  });

  it("Cancelar no carga nada y vuelve al menú", async () => {
    const { say, seawhite } = setup();
    await elegirCarga(say, "👤 Choferes");
    await say(CARGADOR, "", [pdfAdj()]);
    const outs = await say(CARGADOR, "Cancelar");
    expect(texts(outs)).toMatch(/cancelada/);
    expect(buttons(outs)).toEqual(MENU_POST_CARGA);
    expect(seawhite.cargas).toHaveLength(0);
  });

  it("AVISOS: 'No habilitados hoy', un renglón por registro; los habilitados no aparecen", async () => {
    const { say } = setup({
      procesar: async () =>
        resultado([
          carnet("33919536", "31-10-2026", { motivoVencimiento: "Seguro ART" }), // habilitado: sin aviso
          carnet("33615450", "23-09-2026", { vencido: true, motivoVencimiento: "Licencia de conducir" }),
          carnet("44444444", "04-09-2026", { vencido: true, motivoVencimiento: "Trámite incompleto", observaciones: "Inhabilitado (trámite incompleto)" }),
          carnet("24157723", "29-10-2027", { observaciones: "Inhabilitado para conducir" }), // habilitado con una restricción
        ]),
    });
    await elegirCarga(say, "👤 Choferes");
    const outs = await say(CARGADOR, "", [pdfAdj()]);
    const t = texts(outs);
    expect(t).toMatch(
      /⚠️ No habilitados hoy:\n• PERSONA 33615450 \(33615450\): habilitado hasta el 23\/09\/2026 \(licencia de conducir\)\n• PERSONA 44444444 \(44444444\): inhabilitado \(trámite incompleto\)/,
    );
    expect(t).toMatch(/⚠️ Avisos:\n• PERSONA 24157723 \(24157723\): Inhabilitado para conducir/);
    expect(t).not.toMatch(/33919536\): /); // el habilitado no aparece
    expect(t.match(/44444444\): /g)).toHaveLength(1); // un solo renglón por registro
  });

  it("REGISTRO: Cancelar o 'Eso es todo' con la carga pendiente -> cancelada (no queda 'procesando')", async () => {
    const { say, registro } = setup();
    await elegirCarga(say, "👤 Choferes");
    await say(CARGADOR, "", [pdfAdj()]);
    await say(CARGADOR, "Cancelar");
    await elegirCarga(say, "👤 Choferes");
    await say(CARGADOR, "", [pdfAdj("otro.pdf")]);
    await say(CARGADOR, "Eso es todo, gracias");
    expect(registro.cargas.map((c) => [c.archivo, c.estado])).toEqual([
      ["carnets.pdf", "cancelada"],
      ["otro.pdf", "cancelada"],
    ]);
  });

  it("REGISTRO: si la carga pendiente expiró -> sin_confirmar", async () => {
    const { say, registro, deps } = setup();
    await elegirCarga(say, "👤 Choferes");
    await say(CARGADOR, "", [pdfAdj()]);
    deps.lotes = new LotesPendientes(-1); // el lote ya no existe (expiró o el bot se reinició)
    const outs = await say(CARGADOR, "Confirmar carga");
    expect(texts(outs)).toMatch(/expiró/);
    expect(registro.cargas[0]!.estado).toBe("sin_confirmar");
  });

  it("REGISTRO: documento mezclado -> un registro por tipo cargado", async () => {
    const { say, registro } = setup({
      procesar: async () => resultado([carnet("33615617", "18-10-2026"), carnet("AF498ZJ", "31-12-2026", { tipo: "dominio", apellidoNombre: null, pagina: 2 })]),
    });
    await elegirCarga(say, "👤 Choferes");
    await say(CARGADOR, "", [pdfAdj()]);
    await say(CARGADOR, "Confirmar carga");
    await say(CARGADOR, "🚛 Cargar dominios");
    await say(CARGADOR, "Confirmar carga");
    expect(registro.cargas.map((c) => [c.estado, (c.detalle as { tipo?: string }).tipo])).toEqual([
      ["completada", "chofer"],
      ["completada", "dominio"],
    ]);
  });

  it("REGISTRO: las que quedaron 'procesando' por un reinicio se cierran como sin_confirmar", async () => {
    const registro = new MemoryRegistro();
    await registro.crearCarga({ conversationId: "c1", telefono: null, clienteCodigo: "999991", plantaCodigo: "000001", archivo: "a.pdf" });
    expect(await registro.cerrarAbandonadas(new Date(Date.now() + 1000))).toBe(1);
    expect(registro.cargas[0]!.estado).toBe("sin_confirmar");
  });

  it("con una carga pendiente de confirmar no acepta otra", async () => {
    const { say, procesar } = setup();
    await elegirCarga(say, "👤 Choferes");
    await say(CARGADOR, "", [pdfAdj()]);
    const outs = await say(CARGADOR, "vista", [pdfAdj("otro.pdf")]);
    expect(texts(outs)).toMatch(/carga pendiente de confirmar/);
    expect(procesar).toHaveBeenCalledTimes(1);
  });

  it("carga que falla entera (p. ej. SEA WHITE caído): el motivo una sola vez y NO ofrece el otro tipo", async () => {
    const { say, seawhite } = setup({
      procesar: async () => resultado([carnet("33919536", "31-10-2026"), carnet("33615450", "31-10-2026"), carnet("AG105UX", "12-03-2027", { tipo: "dominio", apellidoNombre: null })]),
    });
    seawhite.cargar = async () => {
      throw new Error("SEA WHITE no responde (HTTP 503).");
    };
    await elegirCarga(say, "👤 Choferes");
    await say(CARGADOR, "", [pdfAdj()]);
    const outs = await say(CARGADOR, "Confirmar carga");
    const t = texts(outs);
    expect(t).toMatch(/La carga falló.*0 cargados.*❌ 2 con error: SEA WHITE no responde/s);
    expect(t.match(/SEA WHITE no responde/g)).toHaveLength(1); // una sola vez, no por cada registro
    expect(t).not.toMatch(/también tiene/); // no ofrece los vehículos: fallarían por lo mismo
    expect(buttons(outs)).toEqual(MENU_POST_CARGA);
  });

  it("el MISMO archivo de nuevo mientras espera el Confirmar se ignora (sin mensaje)", async () => {
    const { say, procesar, seawhite } = setup();
    await elegirCarga(say, "👤 Choferes");
    await say(CARGADOR, "", [pdfAdj()]);
    expect(await say(CARGADOR, "", [pdfAdj()])).toEqual([]); // mismo carnets.pdf: nada
    expect(procesar).toHaveBeenCalledTimes(1);
    await say(CARGADOR, "Confirmar carga"); // y la confirmación sigue funcionando
    expect(seawhite.cargas).toHaveLength(1);
  });

  it("rechaza adjuntos que no son PDF ni fotos (audio, video)", async () => {
    const { say } = setup();
    await say(CARGADOR, "👤 Choferes");
    const outs = await say(CARGADOR, "", [{ url: "https://chatwoot/nota.ogg", fileType: "audio", contentType: "audio/ogg" }]);
    expect(texts(outs)).toMatch(/Solo se aceptan archivos PDF o fotos/);
  });

  it("FOTOS de carnets: se convierten a PDF (varias fotos -> un solo PDF) y se procesan igual", async () => {
    const { say, deps, procesar } = setup();
    const jpg = readFileSync("assets/javier.jpg");
    deps.descargarAdjunto = vi.fn(async () => jpg);
    await elegirCarga(say, "👤 Choferes");
    const foto = (n: string): IncomingAttachment => ({ url: `https://chatwoot/${n}`, fileType: "image", contentType: "image/jpeg", fileName: n });
    const outs = await say(CARGADOR, "", [foto("carnet1.jpg"), foto("carnet2.jpg")]);
    expect(texts(outs)).toMatch(/Recibí \*2 archivos\*/);
    const [pdf, nombre] = procesar.mock.calls[0]! as unknown as [Buffer, string];
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(2); // una página por foto
    expect(nombre).toBe("2 archivos.pdf");
    expect(buttons(outs)).toEqual(["Confirmar carga", "Cancelar"]);
  });

  it("un archivo que dice ser foto pero no lo es: avisa y no procesa", async () => {
    const { say, deps, procesar } = setup();
    deps.descargarAdjunto = vi.fn(async () => Buffer.from("esto no es una imagen"));
    await elegirCarga(say, "👤 Choferes");
    const outs = await say(CARGADOR, "", [{ url: "https://chatwoot/x.jpg", fileType: "image", fileName: "x.jpg" }]);
    expect(texts(outs)).toMatch(/"x\.jpg" no es un PDF ni una foto JPG o PNG/);
    expect(procesar).not.toHaveBeenCalled();
  });

  it("si no queda ningún carnet apto lo informa y vuelve al menú", async () => {
    const { say } = setup({ procesar: async () => resultado([], [{ pagina: 1, referencia: "—", motivo: "Carnet ilegible" }]) });
    await elegirCarga(say, "👤 Choferes");
    const outs = await say(CARGADOR, "", [pdfAdj()]);
    expect(texts(outs)).toMatch(/ningún carnet apto.*Carnet ilegible/s);
    expect(buttons(outs)).toEqual(MENU_POST_CARGA);
  });

  it("si falla el procesamiento lo informa y vuelve al menú", async () => {
    const { say } = setup({ procesar: async () => Promise.reject(new Error("timeout de Claude")) });
    await elegirCarga(say, "👤 Choferes");
    const outs = await say(CARGADOR, "", [pdfAdj()]);
    expect(texts(outs)).toMatch(/No pude procesar el PDF: timeout de Claude/);
    expect(buttons(outs)).toEqual(MENU_POST_CARGA);
  });

  it("los cargadores no consultan: un DNI les abre el menú de carga", async () => {
    const { say } = setup();
    const outs = await say(CARGADOR, "33615617");
    expect(texts(outs)).not.toMatch(/habilitado/);
    expect(buttons(outs)).toEqual(["Total Austral", "Vista Energy"]);
  });
});

describe("chofer", () => {
  const MENU = ["🪪 Habilitación", "📄 VTV y seguro", "Eso es todo, gracias"];
  const MENU_HAB = ["🪪 Por DNI", "🚛 Por dominio", "Menú 😊"];
  const MENU_VEH = ["📄 VTV", "🛡️ Seguro", "Menú 😊"];
  const FIN_CONSULTA = ["Menú 😊", "🔎 Consulta", "Eso es todo, gracias"];

  /** Saludo -> Habilitación -> planta: queda en [Por DNI] [Por dominio] [Menú]. */
  async function enPlanta(say: Awaited<ReturnType<typeof setup>>["say"], planta = "Total planta 1") {
    await say(CHOFER, "hola");
    await say(CHOFER, "🪪 Habilitación");
    await say(CHOFER, planta);
    return say(CHOFER, "✅ Sí");
  }
  /** Saludo -> VTV y seguro -> la opción elegida. */
  async function enVehiculo(say: Awaited<ReturnType<typeof setup>>["say"], opcion: "📄 VTV" | "🛡️ Seguro") {
    await say(CHOFER, "hola");
    await say(CHOFER, "📄 VTV y seguro");
    return say(CHOFER, opcion);
  }

  it("saluda con imagen y muestra el menú principal de dos ramas", async () => {
    const { say } = setup();
    const outs = await say(CHOFER, "hola");
    // Mismo saludo que Enri; el teléfono del chofer está en SEA WHITE: lo saluda por el nombre.
    expect(outs[0]).toEqual({ kind: "image", caption: "¡Hola, Boris Daniel Ojeda! 👋 Soy *Javier*, el asistente virtual de *SEA WHITE S.A.*" });
    expect(texts(outs)).toMatch(/Habilitación.*VTV y seguro/s);
    expect(buttons(outs)).toEqual(MENU);
  });

  it("si el teléfono no está en SEA WHITE, saluda sin nombre (como Enri)", async () => {
    const { say } = setup();
    const outs = await say("+5492994440000", "hola", [], "c9");
    expect(outs[0]).toEqual({ kind: "image", caption: "¡Hola! 👋 Soy *Javier*, el asistente virtual de *SEA WHITE S.A.*" });
  });

  it("Habilitación -> cliente y subcliente -> Por DNI -> DNI -> credencial en ESA planta -> su carnet -> Menú/Consulta/Eso es todo", async () => {
    const { say } = setup();
    await cargar(say, "👤 Choferes");
    await say(CHOFER, "hola");

    let outs = await say(CHOFER, "🪪 Habilitación");
    expect(texts(outs)).toMatch(/Escribí \*cliente y subcliente\* para la consulta/);
    expect(texts(outs) + buttons(outs).join()).not.toMatch(/Total Austral|Vista Energy/); // sin opciones

    await say(CHOFER, "Total planta 1");
    outs = await say(CHOFER, "✅ Sí");
    expect(texts(outs)).toMatch(/✅ \*TOTAL AUSTRAL – Planta 1\*.*DNI.*dominio/s);
    expect(buttons(outs)).toEqual(MENU_HAB);

    outs = await say(CHOFER, "🪪 Por DNI");
    expect(texts(outs)).toMatch(/Pasame el \*DNI\*/);

    outs = await say(CHOFER, "33.615.617");
    const t = texts(outs);
    expect(t).toMatch(/PERSONA 33615617/);
    expect(t).toMatch(/TOTAL AUSTRAL – Planta 1: ⚠️ habilitado hasta 18\/10\/2026 \(vence en 3 días\)/);
    expect(t).not.toMatch(/Documentación|Licencia|ART|F\.931/); // la habilitación muestra sólo el ingreso a planta
    expect(buttons(outs)).toEqual(["📄 Sí, pasámelo", "No, gracias"]);

    outs = await say(CHOFER, "📄 Sí, pasámelo");
    const iFile = outs.findIndex((o) => o.kind === "file");
    expect((outs[iFile] as Extract<Outbound, { kind: "file" }>).data.toString()).toContain("33615617"); // SU carnet
    const iAlgoMas = outs.findIndex((o) => o.kind === "buttons" && /Necesitás algo más/.test(o.text));
    expect(iAlgoMas).toBeGreaterThan(iFile); // el carnet primero
    expect(texts(outs)).toMatch(/en este cliente y subcliente, tocá \*Consulta\*; para volver al inicio, \*Menú\*/);
    expect(buttons(outs)).toEqual(FIN_CONSULTA);
  });

  it("[🔎 Consulta] sigue en la misma planta; [Menú 😊] vuelve al inicio y borra la planta", async () => {
    const { say } = setup({ procesar: async () => resultado([carnet("AF498ZJ", "31-12-2026", { tipo: "dominio", apellidoNombre: null })]) });
    await cargar(say, "🚛 Dominios");
    await enPlanta(say);
    await say(CHOFER, "🪪 Por DNI");
    let outs = await say(CHOFER, "30123456"); // sin credencial
    expect(buttons(outs)).toEqual(FIN_CONSULTA);

    outs = await say(CHOFER, "🔎 Consulta");
    expect(texts(outs)).toMatch(/✅ \*TOTAL AUSTRAL – Planta 1\*/);
    expect(buttons(outs)).toEqual(MENU_HAB);

    outs = await say(CHOFER, "🚛 Por dominio"); // misma planta: va directo a la patente
    expect(texts(outs)).toMatch(/Pasame la \*patente\*/);
    outs = await say(CHOFER, "AF498ZJ");
    expect(texts(outs)).toMatch(/Patente \*AF498ZJ\*.*Planta 1: ✅ habilitado hasta 31\/12\/2026/s);
    expect(texts(outs)).not.toMatch(/Documentación|Seguro:|VTV:/); // sólo el ingreso a planta

    outs = await say(CHOFER, "Menú 😊");
    expect(buttons(outs)).toEqual(MENU);
    outs = await say(CHOFER, "🪪 Habilitación"); // la planta se borró: la vuelve a pedir
    expect(texts(outs)).toMatch(/Escribí \*cliente y subcliente\* para la consulta/);
  });

  it("[Menú 😊] desde las opciones de habilitación vuelve al menú principal", async () => {
    const { say } = setup();
    await enPlanta(say);
    const outs = await say(CHOFER, "Menú 😊");
    expect(buttons(outs)).toEqual(MENU);
  });

  it("en el menú principal no toma un DNI suelto: hay que elegir la rama", async () => {
    const { say } = setup();
    await cargar(say, "👤 Choferes");
    let outs = await say(CHOFER, "cheee puedo entrar? 33615617");
    expect(buttons(outs)).toEqual(MENU);
    expect(texts(outs)).not.toMatch(/PERSONA 33615617/);
    // Dentro de habilitación, antes de la planta, tampoco.
    await say(CHOFER, "🪪 Habilitación");
    outs = await say(CHOFER, "33615617");
    expect(texts(outs)).toMatch(/Escribí \*cliente y subcliente\* para la consulta/);
    expect(texts(outs)).not.toMatch(/No se encontró|PERSONA 33615617/);
  });

  it("con la planta elegida, un DNI escrito sin tocar [Por DNI] se consulta igual", async () => {
    const { say } = setup();
    await cargar(say, "👤 Choferes");
    await enPlanta(say);
    const outs = await say(CHOFER, "33615617");
    expect(texts(outs)).toMatch(/PERSONA 33615617.*Planta 1: ⚠️ habilitado/s);
  });

  it("VTV y seguro -> VTV -> patente -> PDF -> ofrece el seguro -> lo manda -> Menú / Eso es todo", async () => {
    const { say } = setup();
    await say(CHOFER, "hola");
    let outs = await say(CHOFER, "📄 VTV y seguro");
    expect(texts(outs)).toMatch(/Qué comprobante necesitás/);
    expect(buttons(outs)).toEqual(MENU_VEH);
    expect(texts(outs)).not.toMatch(/planta/); // esta rama no pide planta

    outs = await say(CHOFER, "📄 VTV");
    expect(texts(outs)).toMatch(/Pasame la \*patente\*.*te mando la \*VTV\*/s);

    outs = await say(CHOFER, "af 498 zj");
    const file = outs.find((o) => o.kind === "file") as Extract<Outbound, { kind: "file" }>;
    expect(file).toMatchObject({ filename: "VTV_AF498ZJ.pdf", caption: "📄 VTV – AF498ZJ" });
    expect(file.data.toString()).toContain("VTV AF498ZJ");
    expect(texts(outs)).toMatch(/Querés también el \*seguro\* de \*AF498ZJ\*/);
    expect(buttons(outs)).toEqual(["🛡️ Sí, el seguro", "Menú 😊", "Eso es todo, gracias"]);

    outs = await say(CHOFER, "🛡️ Sí, el seguro");
    expect(outs.find((o) => o.kind === "file")).toMatchObject({ filename: "SEGURO_AF498ZJ.pdf" });
    expect(texts(outs)).toMatch(/Para otra patente o para consultar la habilitación, tocá \*Menú\*/);
    expect(buttons(outs)).toEqual(["Menú 😊", "Eso es todo, gracias"]);
  });

  it("NO ENCONTRADO: no ofrece el otro comprobante; pide revisar la patente y sigue esperando otra", async () => {
    const { say } = setup();
    await enVehiculo(say, "🛡️ Seguro");
    let outs = await say(CHOFER, "AG536VG"); // no tiene seguro cargado
    expect(texts(outs)).toMatch(/No encontré el seguro del dominio \*AG536VG\*/);
    expect(texts(outs)).toMatch(/Revisá la patente y escribila de nuevo/);
    expect(texts(outs)).not.toMatch(/Querés también/);
    expect(buttons(outs)).not.toContain("📄 Sí, la VTV");
    expect(outs.some((o) => o.kind === "file")).toBe(false);
    // Sigue en Seguro: la siguiente patente se busca directo.
    outs = await say(CHOFER, "AF498ZJ");
    expect(outs.find((o) => o.kind === "file")).toMatchObject({ filename: "SEGURO_AF498ZJ.pdf" });
  });

  it("NO ENCONTRADO (VTV, el caso real 'Aaa222'): tampoco ofrece el seguro", async () => {
    const { say } = setup();
    await enVehiculo(say, "📄 VTV");
    const outs = await say(CHOFER, "Aaa222");
    expect(texts(outs)).toMatch(/No encontré la VTV del dominio \*AAA222\*\.[\s\S]*Revisá la patente/);
    expect(texts(outs)).not.toMatch(/Querés también el \*seguro\*/);
    expect(buttons(outs)).not.toContain("🛡️ Sí, el seguro");
  });

  it("RESGUARDO: si las patentes no coinciden NO manda el PDF, dice que no está disponible y registra falla crítica", async () => {
    const { say, fallas } = setup({ verificacion: { ok: false, motivo: "Adentro del PDF figura AG536VG, no AF498ZJ.", patentesEnPdf: ["AG536VG"] } });
    await enVehiculo(say, "📄 VTV");
    const outs = await say(CHOFER, "AF498ZJ");
    expect(outs.some((o) => o.kind === "file")).toBe(false);
    expect(texts(outs)).toMatch(/Por el momento no tengo disponible la VTV de \*AF498ZJ\*/);
    expect(fallas.fallas).toHaveLength(1);
    expect(fallas.fallas[0]).toMatchObject({ tipo: "comprobante_no_coincide", severidad: "critica", dominio: "AF498ZJ", telefono: CHOFER });
    expect(fallas.fallas[0]!.descripcion).toMatch(/VTV de AF498ZJ NO entregado: Adentro del PDF figura AG536VG/);
    expect(texts(outs)).not.toMatch(/Querés también/); // si no se entregó, no se ofrece el otro
  });

  it("VTV con una patente inválida: avisa", async () => {
    const { say } = setup();
    await enVehiculo(say, "📄 VTV");
    const outs = await say(CHOFER, "hola che");
    expect(texts(outs)).toMatch(/patente no parece válida/);
  });

  it("CONFIRMACIÓN: cambiar de cliente a mitad de la consulta también se confirma con [Sí] [No]", async () => {
    const { say } = setup();
    await enPlanta(say);
    await say(CHOFER, "🪪 Por DNI");
    let outs = await say(CHOFER, "y en vista planta 1?");
    expect(texts(outs)).toMatch(/Encontré \*Vista Energy – Planta 1\*\. ¿Es correcto\?/);
    expect(buttons(outs)).toEqual(["✅ Sí", "✏️ No"]);
    outs = await say(CHOFER, "✅ Sí");
    expect(texts(outs)).toMatch(/✅ \*VISTA ENERGY – Planta 1\*.*Pasame el \*DNI\*/s); // sigue en Por DNI, en la nueva
  });

  it("consulta SOLO la planta declarada: el mismo DNI en otra planta no cuenta", async () => {
    const { say } = setup();
    await cargar(say, "👤 Choferes");
    await enPlanta(say, "Total planta 2");
    await say(CHOFER, "🪪 Por DNI");
    const outs = await say(CHOFER, "33615617");
    expect(texts(outs)).toMatch(/No tenés credencial cargada para \*TOTAL AUSTRAL – Planta 2\*/);
    expect(buttons(outs)).toEqual(FIN_CONSULTA);
  });

  it("cliente con varias plantas pide el subcliente; con una sola no", async () => {
    const { say } = setup();
    await say(CHOFER, "hola");
    await say(CHOFER, "🪪 Habilitación");
    let outs = await say(CHOFER, "Total Austral");
    expect(texts(outs)).toMatch(/Qué \*subcliente\* de \*Total Austral\*/);
    expect(buttons(outs)).not.toContain("Planta 1");
    await say(CHOFER, "Planta 2");
    outs = await say(CHOFER, "✅ Sí");
    expect(texts(outs)).toMatch(/✅ \*TOTAL AUSTRAL – Planta 2\*/);
    expect(buttons(outs)).toEqual(MENU_HAB);

    await say(CHOFER, "Menú 😊");
    await say(CHOFER, "🪪 Habilitación");
    await say(CHOFER, "vista");
    outs = await say(CHOFER, "✅ Sí");
    expect(texts(outs)).toMatch(/✅ \*VISTA ENERGY – Planta 1\*/);
  });

  it("cliente o subcliente inexistentes: lo dice sin listar opciones", async () => {
    const { say } = setup();
    await say(CHOFER, "hola");
    await say(CHOFER, "🪪 Habilitación");
    let outs = await say(CHOFER, "Shell planta 2");
    expect(texts(outs)).toMatch(/No se encontró ese \*cliente y subcliente\*/);
    expect(texts(outs)).not.toMatch(/Total Austral|Vista Energy/);
    outs = await say(CHOFER, "total planta 9");
    expect(texts(outs)).toMatch(/No encontré ese subcliente en \*Total Austral\*/);
    expect(texts(outs)).not.toMatch(/Planta 2/);
  });

  it("mal escrito: '¿Quisiste decir...?' -> Sí -> opciones de habilitación en esa planta", async () => {
    const { say } = setup();
    await say(CHOFER, "hola");
    await say(CHOFER, "🪪 Habilitación");
    let outs = await say(CHOFER, "tatal planta 1");
    expect(texts(outs)).toMatch(/Quisiste decir \*Total Austral – Planta 1\*/);
    expect(buttons(outs)).toEqual(["✅ Sí", "✏️ No"]);
    outs = await say(CHOFER, "si");
    expect(texts(outs)).toMatch(/✅ \*TOTAL AUSTRAL – Planta 1\*/);
    expect(buttons(outs)).toEqual(MENU_HAB);
  });

  it("DNI inválido después de elegir Por DNI", async () => {
    const { say } = setup();
    await enPlanta(say);
    await say(CHOFER, "🪪 Por DNI");
    const outs = await say(CHOFER, "123");
    expect(texts(outs)).toMatch(/El DNI tiene que tener 7 u 8 números/);
  });

  it("si manda un PDF se le avisa que es sólo para consultas y sigue donde estaba", async () => {
    const { say, procesar } = setup();
    await say(CHOFER, "hola");
    let outs = await say(CHOFER, "", [pdfAdj()]);
    expect(texts(outs)).toMatch(/no se reciben archivos: es solo para consultas/);
    expect(buttons(outs)).toEqual(MENU); // seguía en el menú principal
    await say(CHOFER, "🪪 Habilitación");
    outs = await say(CHOFER, "", [pdfAdj()]);
    expect(texts(outs)).toMatch(/Escribí \*cliente y subcliente\* para la consulta/); // seguía en la planta
    expect(procesar).not.toHaveBeenCalled();
  });
});

async function enPlantaPie(say: Awaited<ReturnType<typeof setup>>["say"]) {
  await say(CHOFER, "hola");
  await say(CHOFER, "🪪 Habilitación");
  await say(CHOFER, "Total planta 1");
  return say(CHOFER, "✅ Sí");
}

describe("pie y cierre (como Enri)", () => {
  it("un texto suelto cierra con [Menú 😊] [Eso es todo, gracias] en el mismo mensaje", async () => {
    const { say } = setup();
    await enPlantaPie(say);
    const outs = await say(CHOFER, "🪪 Por DNI");
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ kind: "buttons", text: expect.stringMatching(/Pasame el \*DNI\*/), buttons: [{ title: "Menú 😊" }, { title: "Eso es todo, gracias" }] });
  });

  it("'Eso es todo, gracias' despide, cierra y la próxima vez arranca de cero", async () => {
    const { say } = setup();
    await say(CHOFER, "hola");
    let outs = await say(CHOFER, "Eso es todo, gracias");
    expect(texts(outs)).toMatch(/Gracias por comunicarte con SEA WHITE/);
    expect(buttons(outs)).toEqual([]);
    outs = await say(CHOFER, "gracias!"); // cortesía tras el cierre: silencio
    expect(outs).toEqual([]);
    outs = await say(CHOFER, "hola");
    expect(outs[0]!.kind).toBe("image");
  });

  it("escrito también cierra ('chau', 'nada más')", async () => {
    const { say } = setup();
    await say(CHOFER, "hola");
    expect(texts(await say(CHOFER, "nada más"))).toMatch(/Gracias por comunicarte/);
  });

  it("el cargador que cierra con una carga sin confirmar la cancela", async () => {
    const { say, seawhite } = setup();
    await elegirCarga(say, "👤 Choferes");
    await say(CARGADOR, "", [pdfAdj()]);
    const outs = await say(CARGADOR, "Eso es todo, gracias");
    expect(texts(outs)).toMatch(/carga pendiente se canceló: no se cargó nada/);
    await say(CARGADOR, "Confirmar carga");
    expect(seawhite.cargas).toHaveLength(0);
  });

  it("el cargador vuelve a elegir el cliente con [Menú 😊]", async () => {
    const { say } = setup();
    await say(CARGADOR, "👤 Choferes");
    const outs = await say(CARGADOR, "Menú 😊");
    expect(buttons(outs)).toEqual(["Total Austral", "Vista Energy"]);
  });
});

describe("app cerrada: sólo responde a los números de las listas", () => {
  it("un número no habilitado: recibe el aviso UNA vez y después no se le responde más", async () => {
    const { say } = setup();
    const outs = await say("+5491155550000", "hola", [], "c-desconocido");
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ kind: "text" });
    expect(texts(outs)).toBe(
      "Este servicio es de uso exclusivo para personal autorizado de Sea White S.A.\n" +
        "El número de teléfono desde el cual se está comunicando no se encuentra habilitado para utilizar este servicio.\n" +
        "Si considera que debería tener acceso, comuníquese con el administrador del sistema.\n" +
        "*Sea White S.A.*",
    );
    expect(buttons(outs)).toEqual([]); // sin botones
    expect(await say("+5491155550000", "33615617", [], "c-desconocido")).toEqual([]);
    expect(await say("+5491155550000", "", [pdfAdj()], "c-desconocido")).toEqual([]);
    expect(await say("+5491155550000", "hola??", [], "c-desconocido")).toEqual([]);
  });

  it("si la lista de consultas no se puede leer, por seguridad tampoco responde", async () => {
    const { say, deps } = setup();
    deps.consultores = { contiene: async () => Promise.reject(new Error("Supabase caído")), listar: async () => [], reemplazar: async () => undefined };
    expect(await say(CHOFER, "hola")).toEqual([]);
  });

  it("los cargadores no necesitan estar en la lista de consultas", async () => {
    const { say, deps } = setup();
    deps.consultores = new MemoryListaTelefonos([]);
    const outs = await say(CARGADOR, "hola");
    expect(buttons(outs)).toEqual(["Total Austral", "Vista Energy"]);
  });

  it("un número agregado a la lista rige desde el mensaje siguiente (aunque ya haya recibido el aviso)", async () => {
    const { say, deps } = setup();
    expect(texts(await say("+5491155550000", "hola", [], "c-nuevo"))).toMatch(/no se encuentra habilitado/);
    await deps.consultores.reemplazar([...CONSULTORES, "1155550000"]);
    const outs = await say("+5491155550000", "hola", [], "c-nuevo");
    expect(outs[0]!.kind).toBe("image"); // saludo
  });
});

describe("motor", () => {
  it("si respondió una persona, el bot no contesta", async () => {
    const { engine, say } = setup();
    await engine.markHandedOff("c2");
    expect(await say(CHOFER, "hola")).toEqual([]);
  });
});
