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

  it("carga en cualquier cliente de la tabla (sin modo prueba)", async () => {
    const f = fakeFetch(() => okCarga(["30123456"]));
    const r = await client(f.fn).cargar("chofer", [registro("30123456", { cliente: "0005", subcliente: "0000" })]);
    expect(r.correctos).toBe(1);
  });

  it("si un registro es inválido no se envía ninguno", async () => {
    const f = fakeFetch(() => okCarga([]));
    const malos: RegistroCarga[][] = [
      [registro("30123456"), registro("30.123.456")], // identificador sin normalizar
      [registro("30123456", { vencimiento: "31/12/2027" })], // formato de fecha
      [registro("30123456", { vencimiento: "31-02-2027" })], // fecha inexistente
      [registro("30123456", { subcliente: "00A1" })], // código inválido (sólo números)
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

  it("chofer: manda la razón social (Razon_Social) y los códigos de 4 dígitos tal cual", async () => {
    const f = fakeFetch(() => okCarga(["30123456"]));
    await client(f.fn).cargar("chofer", [registro("30123456", { cliente: "0001", subcliente: "0000", razonSocial: "JUAN CARLOS PEREZ" })]);
    const form = f.calls.find((c) => c.method === "POST" && c.url.endsWith("/chofer"))!.body as FormData;
    expect(form.get("Registros[0].Cliente")).toBe("0001");
    expect(form.get("Registros[0].Subcliente")).toBe("0000");
    expect(form.get("Registros[0].Razon_Social")).toBe("JUAN CARLOS PEREZ");
  });

  it("dominio usa el campo Dominio (y no lleva razón social)", async () => {
    const f = fakeFetch(() => Response.json({ ok: true, total: 1, procesadosCorrectamente: 1, errores: 0, resultados: [{ ok: true, dominio: "AA123BB", id: 5, accion: "CREADO" }] }));
    const r = await client(f.fn).cargar("dominio", [registro("AA123BB")]);
    const form = f.calls.find((c) => c.method === "POST" && c.url.endsWith("/dominio"))!.body as FormData;
    expect(form.get("Registros[0].Dominio")).toBe("AA123BB");
    expect(form.get("Registros[0].Razon_Social")).toBeNull();
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
    expect((await c.documentoVehiculo("vtv", "AF498ZJ"))?.pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(await c.documentoVehiculo("seguro", "AF498ZJ")).toBeNull();
    expect(f.calls.filter((x) => x.url.includes("DocumentosVehiculos")).map((x) => [x.method, new URL(x.url).pathname])).toEqual([
      ["GET", "/api/DocumentosVehiculos/vtv/AF498ZJ"],
      ["GET", "/api/DocumentosVehiculos/seguro/AF498ZJ"],
    ]);
  });

  it("VTV y seguro: devuelve el nombre del archivo para el resguardo", async () => {
    const f = fakeFetch(() => new Response(PDF, { headers: { "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=AF498ZJ.pdf; filename*=UTF-8''AF498ZJ.pdf" } }));
    const r = await client(f.fn, { cargaHabilitada: false }).documentoVehiculo("vtv", "AF498ZJ");
    expect(r?.nombreArchivo).toBe("AF498ZJ.pdf");
  });

  it("VTV y seguro: la lista blanca sólo acepta GET con tipo y dominio válidos", () => {
    expect(assertAllowedEndpoint("GET", "/api/DocumentosVehiculos/vtv/AF498ZJ").writes).toBe(false);
    expect(() => assertAllowedEndpoint("POST", "/api/DocumentosVehiculos/vtv/AF498ZJ")).toThrow(/BLOQUEADO/);
    expect(() => assertAllowedEndpoint("GET", "/api/DocumentosVehiculos/otro/AF498ZJ")).toThrow(/BLOQUEADO/);
    expect(() => assertAllowedEndpoint("GET", "/api/DocumentosVehiculos/vtv/AF498ZJ.pdf")).toThrow(/BLOQUEADO/);
  });

  it("la consulta trae el nombre del chofer (razon_Social, como en el documento)", async () => {
    const f = fakeFetch(() =>
      Response.json({ ok: true, id: 107, cliente: "0001", subcliente: "0000", chofer: "92791217", razon_Social: "Abner Pintos Stoletny", vencimiento: "2026-10-31" }),
    );
    const r = await client(f.fn).consultar("chofer", "0001", "0000", "92791217");
    expect(r).toMatchObject({ found: true, id: 107, nombre: "Abner Pintos Stoletny" });
  });

  it("API 1 / 7: clientes donde está habilitado un DNI o un dominio (JSON del manual)", async () => {
    const f = fakeFetch((call) => {
      const path = new URL(call.url).pathname;
      if (path === "/api/VencimientosAnelo/clientes/38303667") {
        return Response.json({ ok: true, dni: "38303667", cantidad: 1, clientes: [{ cliente: "000015", razon_social: "ALFA TRANSPORTES S.A." }] });
      }
      if (path === "/api/VencimientosAnelo/clientes-dominio/AAA111") {
        return Response.json({ ok: true, dominio: "AAA111", cantidad: 0, clientes: [] });
      }
      return new Response("no", { status: 500 });
    });
    const c = client(f.fn, { cargaHabilitada: false });
    expect(await c.clientesHabilitados("chofer", "38303667")).toEqual([{ codigo: "000015", nombre: "ALFA TRANSPORTES S.A." }]);
    expect(await c.clientesHabilitados("dominio", "AAA111")).toEqual([]); // sin coincidencias: 200 con lista vacía
  });

  it("API 2 / 8: subclientes de un DNI o dominio en un cliente (JSON del manual)", async () => {
    const f = fakeFetch((call) => {
      const path = new URL(call.url).pathname;
      const subclientes = [{ subcliente: "000003", razon_social: "DEPOSITO CENTRAL" }];
      if (path === "/api/VencimientosAnelo/subclientes/38303667/000015") return Response.json({ ok: true, dni: "38303667", cliente: "000015", cantidad: 1, subclientes });
      if (path === "/api/VencimientosAnelo/subclientes-dominio/AAA111/000015") return Response.json({ ok: true, dominio: "AAA111", cliente: "000015", cantidad: 1, subclientes });
      return new Response("no", { status: 500 });
    });
    const c = client(f.fn);
    expect(await c.subclientesHabilitados("chofer", "38303667", "000015")).toEqual([{ codigo: "000003", nombre: "DEPOSITO CENTRAL" }]);
    expect(await c.subclientesHabilitados("dominio", "AAA111", "000015")).toEqual([{ codigo: "000003", nombre: "DEPOSITO CENTRAL" }]);
  });

  it("API 1: un error de SEA WHITE no se toma como 'sin habilitaciones'", async () => {
    const f = fakeFetch(() => Response.json({ ok: false, mensaje: "falla" }, { status: 500 }));
    await expect(client(f.fn).clientesHabilitados("chofer", "38303667")).rejects.toThrow(/HTTP 500/);
  });

  it("API 1/2/7/8: sólo GET, y con DNI o patente válidos en la ruta", () => {
    expect(assertAllowedEndpoint("GET", "/api/VencimientosAnelo/clientes/38303667")).toEqual({ writes: false });
    expect(assertAllowedEndpoint("GET", "/api/VencimientosAnelo/subclientes/38303667/000015")).toEqual({ writes: false });
    expect(assertAllowedEndpoint("GET", "/api/VencimientosAnelo/clientes-dominio/AA123BB")).toEqual({ writes: false });
    expect(assertAllowedEndpoint("GET", "/api/VencimientosAnelo/subclientes-dominio/AA123BB/0001")).toEqual({ writes: false });
    expect(() => assertAllowedEndpoint("POST", "/api/VencimientosAnelo/clientes/38303667")).toThrow(/BLOQUEADO/);
    expect(() => assertAllowedEndpoint("GET", "/api/VencimientosAnelo/clientes/../../x")).toThrow(/BLOQUEADO/);
  });

  it("logística: APIs 3 a 6 y 9 a 11 con los JSON del manual", async () => {
    const f = fakeFetch((call) => {
      const path = new URL(call.url).pathname;
      const clientes = [{ cliente: "000015", razon_social: "ALFA TRANSPORTES S.A." }];
      const subclientes = [{ subcliente: "000003", razon_social: "DEPOSITO CENTRAL" }];
      switch (path) {
        case "/api/VencimientosAnelo/clientes-habilitados":
        case "/api/VencimientosAnelo/clientes-habilitados-dominio":
          return Response.json({ ok: true, cantidad: 1, clientes });
        case "/api/VencimientosAnelo/subclientes-habilitados/000015":
        case "/api/VencimientosAnelo/subclientes-habilitados-dominio/000015":
          return Response.json({ ok: true, cliente: "000015", cantidad: 1, subclientes });
        case "/api/VencimientosAnelo/choferes-habilitados/000015/000003":
          return Response.json({ ok: true, cantidad: 1, choferes: [{ chofer: "28345678", razon_social: "GOMEZ JUAN", vencimiento: "15-12-2026" }] });
        case "/api/VencimientosAnelo/dominios-habilitados/000015/000003":
          return Response.json({ ok: true, cantidad: 2, dominios: [{ dominio: "AA123BB", tipo: "Camion", vencimiento: "15-12-2026" }, { dominio: "AC789EF", tipo: "Acoplado", vencimiento: "30-03-2027" }] });
        case "/api/VencimientosAnelo/buscar-choferes/G%C3%93MEZ%20JUAN":
          return Response.json({ ok: true, busqueda: "GÓMEZ JUAN", cantidad: 1, choferes: [{ chofer: "28345678", razon_social: "GOMEZ JUAN" }] });
        default:
          return new Response(`no: ${path}`, { status: 500 });
      }
    });
    const c = client(f.fn, { cargaHabilitada: false });
    const alfa = [{ codigo: "000015", nombre: "ALFA TRANSPORTES S.A." }];
    const deposito = [{ codigo: "000003", nombre: "DEPOSITO CENTRAL" }];
    expect(await c.clientesConVigentes("chofer")).toEqual(alfa);
    expect(await c.clientesConVigentes("dominio")).toEqual(alfa);
    expect(await c.subclientesConVigentes("chofer", "000015")).toEqual(deposito);
    expect(await c.subclientesConVigentes("dominio", "000015")).toEqual(deposito);
    expect(await c.listadoVigentes("chofer", "000015", "000003")).toEqual([{ identificador: "28345678", nombre: "GOMEZ JUAN", tipoVehiculo: null, vencimiento: "15-12-2026" }]);
    expect(await c.listadoVigentes("dominio", "000015", "000003")).toEqual([
      { identificador: "AA123BB", nombre: null, tipoVehiculo: "Camion", vencimiento: "15-12-2026" },
      { identificador: "AC789EF", nombre: null, tipoVehiculo: "Acoplado", vencimiento: "30-03-2027" },
    ]);
    // Búsqueda: se limpian los símbolos y los espacios van codificados en la URL.
    expect(await c.buscarChoferes("  gómez, juan!! ".toUpperCase())).toEqual([{ codigo: "28345678", nombre: "GOMEZ JUAN" }]);
    expect(await c.buscarChoferes("go")).toEqual([]); // menos de 3 letras: ni sale a la red
  });

  it("logística: sólo GET en la lista blanca, con códigos numéricos", () => {
    for (const p of [
      "/api/VencimientosAnelo/clientes-habilitados",
      "/api/VencimientosAnelo/subclientes-habilitados/000015",
      "/api/VencimientosAnelo/choferes-habilitados/000015/000003",
      "/api/VencimientosAnelo/buscar-choferes/GOMEZ%20JUAN",
      "/api/VencimientosAnelo/clientes-habilitados-dominio",
      "/api/VencimientosAnelo/subclientes-habilitados-dominio/000015",
      "/api/VencimientosAnelo/dominios-habilitados/000015/000003",
    ]) {
      expect(assertAllowedEndpoint("GET", p)).toEqual({ writes: false });
      expect(() => assertAllowedEndpoint("POST", p)).toThrow(/BLOQUEADO/);
    }
    expect(() => assertAllowedEndpoint("GET", "/api/VencimientosAnelo/choferes-habilitados/../x")).toThrow(/BLOQUEADO/);
    expect(() => assertAllowedEndpoint("GET", "/api/VencimientosAnelo/buscar-choferes/a/b")).toThrow(/BLOQUEADO/);
  });

  it("las consultas funcionan aunque la carga esté deshabilitada", async () => {
    const f = fakeFetch(() => new Response(PDF, { headers: { "Content-Type": "application/pdf" } }));
    const pdf = await client(f.fn, { cargaHabilitada: false }).descargarPdf("dominio", 5);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(new URL(f.calls.at(-1)!.url).pathname).toBe("/api/VencimientosAnelo/dominio/1/5/pdf");
  });
});
