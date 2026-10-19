/**
 * Candados de la API de SEA WHITE: lista blanca, interruptor de carga, modo
 * prueba, validación previa, lotes de 30 y lectura de respuestas.
 * `fetch` es falso: ningún test sale a la red.
 */
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { AneloClient, MAX_REGISTROS_POR_LOTE } from "../src/integrations/seawhite/aneloClient.js";
import { assertAllowedEndpoint } from "../src/integrations/seawhite/endpoints.js";
import type { RegistroCarga } from "../src/integrations/seawhite/types.js";

const logger = pino({ level: "silent" });
const PDF = Buffer.from("%PDF-1.4\n%prueba\n");

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** fetch falso: login siempre OK; el resto lo decide `handler`. */
function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", url: String(input), body: init?.body };
    calls.push(call);
    if (call.url.endsWith("/api/autenticacion/validar")) {
      return Response.json({ token: "tkn", valido_hasta_utc: new Date(Date.now() + 3_600_000).toISOString() });
    }
    return handler(call);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function client(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof AneloClient>[0]> = {}) {
  return new AneloClient({
    baseUrl: "https://api.test",
    email: "bot@test",
    password: "x",
    servidor: "1",
    timeoutMs: 5000,
    cargaHabilitada: true,
    modoPrueba: true,
    prefijoPrueba: "9999",
    logger,
    fetchImpl,
    ...overrides,
  });
}

function registro(dni: string, extra: Partial<RegistroCarga> = {}): RegistroCarga {
  return { cliente: "999991", subcliente: "000001", identificador: dni, vencimiento: "31-12-2027", pdf: PDF, ...extra };
}

const okCarga = (dnis: string[]) =>
  Response.json({
    ok: true,
    total: dnis.length,
    procesadosCorrectamente: dnis.length,
    errores: 0,
    resultados: dnis.map((d, i) => ({ ok: true, chofer: d, id: i + 1, accion: "CREADO" })),
  });

describe("lista blanca de SEA WHITE", () => {
  it("permite las consultas y las dos cargas autorizadas", () => {
    expect(assertAllowedEndpoint("GET", "/api/VencimientosAnelo/chofer").writes).toBe(false);
    expect(assertAllowedEndpoint("GET", "/api/VencimientosAnelo/dominio/1/5/pdf").writes).toBe(false);
    expect(assertAllowedEndpoint("POST", "/api/VencimientosAnelo/chofer").writes).toBe(true);
    expect(assertAllowedEndpoint("POST", "/api/VencimientosAnelo/dominio").writes).toBe(true);
    // Documentación general: POST, pero sólo consulta (igual que Enri).
    expect(assertAllowedEndpoint("POST", "/api/vencimientos/chofer").writes).toBe(false);
    expect(assertAllowedEndpoint("POST", "/api/vencimientos/camion").writes).toBe(false);
  });

  it("bloquea cualquier otra ruta o método", () => {
    expect(() => assertAllowedEndpoint("POST", "/api/VencimientosAnelo/chofer/1/8/pdf")).toThrow(/BLOQUEADO/);
    expect(() => assertAllowedEndpoint("POST", "/api/vencimientos/chofer/alta")).toThrow(/BLOQUEADO/);
    expect(() => assertAllowedEndpoint("GET", "/api/vencimientos/chofer")).toThrow(/BLOQUEADO/);
    expect(() => assertAllowedEndpoint("GET", "/api/VencimientosAnelo/chofer/1/8/pdf/../borrar")).toThrow(/BLOQUEADO/);
    expect(() => assertAllowedEndpoint("POST", "/api/VencimientosAnelo/borrar")).toThrow(/BLOQUEADO/);
  });
});

describe("candados de la carga", () => {
  it("con la carga deshabilitada no sale nada a la red", async () => {
    const f = fakeFetch(() => okCarga([]));
    await expect(client(f.fn, { cargaHabilitada: false }).cargar("chofer", [registro("30123456")])).rejects.toThrow(/deshabilitada/);
    expect(f.calls).toHaveLength(0);
  });

  it("en modo prueba rechaza un cliente real sin salir a la red", async () => {
    const f = fakeFetch(() => okCarga([]));
    await expect(client(f.fn).cargar("chofer", [registro("30123456", { cliente: "000001" })])).rejects.toThrow(/Modo prueba/);
    expect(f.calls).toHaveLength(0);
  });

  it("sin modo prueba acepta clientes reales", async () => {
    const f = fakeFetch(() => okCarga(["30123456"]));
    const r = await client(f.fn, { modoPrueba: false }).cargar("chofer", [registro("30123456", { cliente: "000001" })]);
    expect(r.correctos).toBe(1);
  });

  it("si un registro es inválido no se envía ninguno", async () => {
    const f = fakeFetch(() => okCarga([]));
    const malos: RegistroCarga[][] = [
      [registro("30123456"), registro("30.123.456")], // identificador sin normalizar
      [registro("30123456", { vencimiento: "31/12/2027" })], // formato de fecha
      [registro("30123456", { vencimiento: "31-02-2027" })], // fecha inexistente
      [registro("30123456", { subcliente: "12" })], // código inválido
      [registro("30123456", { pdf: Buffer.from("no soy un pdf") })],
    ];
    for (const lote of malos) {
      await expect(client(f.fn).cargar("chofer", lote)).rejects.toThrow();
    }
    expect(f.calls.filter((c) => c.method === "POST" && c.url.includes("VencimientosAnelo"))).toHaveLength(0);
  });

  it("parte en lotes de 30 y arma el formulario como pide la API", async () => {
    const dnis = Array.from({ length: 45 }, (_, i) => String(30000000 + i));
    const f = fakeFetch(async (call) => {
      const form = call.body as FormData;
      const n = [...form.keys()].filter((k) => k.endsWith(".Chofer")).length;
      return okCarga(dnis.filter((d) => [...form.values()].includes(d)).slice(0, n));
    });
    const r = await client(f.fn).cargar("chofer", dnis.map((d) => registro(d)));

    const posts = f.calls.filter((c) => c.method === "POST" && c.url.endsWith("/api/VencimientosAnelo/chofer"));
    expect(posts).toHaveLength(2);
    const first = posts[0]!.body as FormData;
    expect(first.get("Servidor")).toBe("1");
    expect(first.get("Registros[0].Cliente")).toBe("999991");
    expect(first.get("Registros[0].Subcliente")).toBe("000001");
    expect(first.get("Registros[0].Chofer")).toBe("30000000");
    expect(first.get("Registros[0].Vencimiento")).toBe("31-12-2027");
    expect((first.get("Registros[0].Archivo") as File).name).toBe("30000000.pdf");
    expect([...first.keys()].filter((k) => k.endsWith(".Chofer"))).toHaveLength(MAX_REGISTROS_POR_LOTE);
    expect(r).toMatchObject({ total: 45, correctos: 45, errores: 0 });
  });

  it("dominio usa el campo Dominio", async () => {
    const f = fakeFetch(() => Response.json({ ok: true, total: 1, procesadosCorrectamente: 1, errores: 0, resultados: [{ ok: true, dominio: "AA123BB", id: 5, accion: "CREADO" }] }));
    const r = await client(f.fn).cargar("dominio", [registro("AA123BB")]);
    const form = f.calls.find((c) => c.method === "POST" && c.url.endsWith("/dominio"))!.body as FormData;
    expect(form.get("Registros[0].Dominio")).toBe("AA123BB");
    expect(r.resultados[0]).toMatchObject({ identificador: "AA123BB", ok: true, accion: "CREADO", id: 5 });
  });

  it("informa el error parcial registro por registro (cruza por DNI)", async () => {
    const f = fakeFetch(() =>
      Response.json({
        ok: false,
        total: 2,
        procesadosCorrectamente: 1,
        errores: 1,
        resultados: [
          { ok: false, chofer: "30999888", mensaje: "El archivo PDF es obligatorio." },
          { ok: true, chofer: "30123456", id: 8, accion: "ACTUALIZADO" },
        ],
      }),
    );
    const r = await client(f.fn).cargar("chofer", [registro("30123456"), registro("30999888")]);
    expect(r).toMatchObject({ correctos: 1, errores: 1 });
    expect(r.resultados).toEqual([
      { identificador: "30123456", ok: true, accion: "ACTUALIZADO", id: 8, mensaje: undefined },
      { identificador: "30999888", ok: false, accion: undefined, id: undefined, mensaje: "El archivo PDF es obligatorio." },
    ]);
  });

  it("si se corta la red NO reintenta la carga y lo informa como error", async () => {
    const f = fakeFetch(() => {
      throw new Error("socket hang up");
    });
    const r = await client(f.fn).cargar("chofer", [registro("30123456")]);
    expect(f.calls.filter((c) => c.method === "POST" && c.url.includes("VencimientosAnelo"))).toHaveLength(1);
    expect(r.resultados[0]).toMatchObject({ ok: false });
    expect(r.resultados[0]!.mensaje).toMatch(/Verificá con una consulta/);
  });

  it("un error general sin detalle no se informa como cargado", async () => {
    const f = fakeFetch(() => Response.json({ ok: false, mensaje: "Se superó el máximo de registros." }, { status: 400 }));
    const r = await client(f.fn).cargar("chofer", [registro("30123456")]);
    expect(r.resultados[0]).toEqual({ identificador: "30123456", ok: false, mensaje: "Se superó el máximo de registros." });
  });

  it("ante un 401 renueva el token y reintenta una sola vez", async () => {
    let n = 0;
    const f = fakeFetch(() => (++n === 1 ? new Response("", { status: 401 }) : okCarga(["30123456"])));
    const r = await client(f.fn).cargar("chofer", [registro("30123456")]);
    expect(r.correctos).toBe(1);
    expect(f.calls.filter((c) => c.url.endsWith("/api/autenticacion/validar"))).toHaveLength(2);
  });
});

describe("consultas", () => {
  it("devuelve los datos del chofer", async () => {
    const f = fakeFetch(() =>
      Response.json({ ok: true, id: 8, cliente: "000001", subcliente: "000002", chofer: "30123456", vencimiento: "31-12-2027", nombreArchivoOriginal: "30123456.pdf", fechaAlta: "2026-10-08T09:00:00", fechaModificacion: null }),
    );
    const r = await client(f.fn).consultar("chofer", "000001", "000002", "30123456");
    expect(r).toMatchObject({ found: true, id: 8, vencimiento: "31-12-2027", identificador: "30123456" });
    const url = new URL(f.calls.at(-1)!.url);
    expect(url.pathname).toBe("/api/VencimientosAnelo/chofer");
    expect(Object.fromEntries(url.searchParams)).toEqual({ Servidor: "1", Cliente: "000001", Subcliente: "000002", Chofer: "30123456" });
  });

  it("si no existe devuelve found=false con el mensaje", async () => {
    const f = fakeFetch(() => Response.json({ ok: false, mensaje: "No se encontró el vencimiento del chofer." }, { status: 404 }));
    const r = await client(f.fn).consultar("chofer", "000001", "000002", "30123456");
    expect(r).toEqual({ found: false, tipo: "chofer", identificador: "30123456", mensaje: "No se encontró el vencimiento del chofer." });
  });

  it("VTV y seguro: devuelve el PDF, o null si no existe (404)", async () => {
    const f = fakeFetch((call) =>
      call.url.endsWith("/vtv/AF498ZJ")
        ? new Response(PDF, { headers: { "Content-Type": "application/pdf" } })
        : Response.json({ mensaje: "No se encontró el documento solicitado.", tipo: "SEGURO", dominio: "AF498ZJ" }, { status: 404 }),
    );
    const c = client(f.fn, { cargaHabilitada: false });
    expect((await c.documentoVehiculo("vtv", "AF498ZJ"))?.subarray(0, 5).toString()).toBe("%PDF-");
    expect(await c.documentoVehiculo("seguro", "AF498ZJ")).toBeNull();
    expect(f.calls.filter((x) => x.url.includes("DocumentosVehiculos")).map((x) => [x.method, new URL(x.url).pathname])).toEqual([
      ["GET", "/api/DocumentosVehiculos/vtv/AF498ZJ"],
      ["GET", "/api/DocumentosVehiculos/seguro/AF498ZJ"],
    ]);
  });

  it("VTV y seguro: la lista blanca sólo acepta GET con tipo y dominio válidos", () => {
    expect(assertAllowedEndpoint("GET", "/api/DocumentosVehiculos/vtv/AF498ZJ").writes).toBe(false);
    expect(() => assertAllowedEndpoint("POST", "/api/DocumentosVehiculos/vtv/AF498ZJ")).toThrow(/BLOQUEADO/);
    expect(() => assertAllowedEndpoint("GET", "/api/DocumentosVehiculos/otro/AF498ZJ")).toThrow(/BLOQUEADO/);
    expect(() => assertAllowedEndpoint("GET", "/api/DocumentosVehiculos/vtv/AF498ZJ.pdf")).toThrow(/BLOQUEADO/);
  });

  it("las consultas funcionan aunque la carga esté deshabilitada", async () => {
    const f = fakeFetch(() => new Response(PDF, { headers: { "Content-Type": "application/pdf" } }));
    const pdf = await client(f.fn, { cargaHabilitada: false }).descargarPdf("dominio", 5);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(new URL(f.calls.at(-1)!.url).pathname).toBe("/api/VencimientosAnelo/dominio/1/5/pdf");
  });
});
