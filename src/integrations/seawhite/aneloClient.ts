/**
 * Cliente de la API Vencimientos Añelo de SEA WHITE.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  Consultas: libres (sólo lectura).                                         ║
 * ║  Carga (POST): EXCEPCIÓN AUTORIZADA a la Regla Nº 1, con 4 candados:       ║
 * ║    1. Lista blanca por método + ruta (endpoints.ts).                       ║
 * ║    2. Interruptor general ANELO_CARGA_HABILITADA (apagado por defecto).    ║
 * ║    3. Modo prueba: sólo clientes de prueba (9999xx) mientras esté activo.  ║
 * ║    4. Cada registro se valida acá de nuevo antes de salir a la red.        ║
 * ║  La confirmación de la persona por WhatsApp la exige la capa del bot.      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Una carga NO se reintenta sola (salvo un 401, que la API rechaza antes de
 * procesar): si se corta la red a mitad de camino no sabemos si se grabó. La
 * API hace "upsert" por Cliente + Subcliente + DNI/Dominio, así que repetir una
 * carga a mano es seguro (vuelve como ACTUALIZADO).
 */
import { normalizeDni, normalizePatente, isCodigoValido } from "../../domain/validators.js";
import { formatApi, parseCalendarDate } from "../../utils/dates.js";
import type { Logger } from "../../utils/logger.js";
import { assertAllowedEndpoint, type HttpMethod } from "./endpoints.js";
import { SeaWhiteTokenManager } from "./tokenManager.js";
import {
  cargaResponseSchema,
  consultaResponseSchema,
  documentacionCamionSchema,
  documentacionChoferSchema,
  SeaWhiteError,
  type Consulta,
  type Documentacion,
  type RegistroCarga,
  type ResumenCarga,
  type TipoRegistro,
} from "./types.js";

/** Máximo de registros por llamada según la API (si se supera, rechaza el lote entero). */
export const MAX_REGISTROS_POR_LOTE = 30;

export interface AneloClientOptions {
  baseUrl: string;
  email: string;
  password: string;
  servidor: string;
  timeoutMs: number;
  cargaHabilitada: boolean;
  modoPrueba: boolean;
  /** Prefijo de los códigos de cliente de prueba (ej. "9999"). */
  prefijoPrueba: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export class AneloClient {
  private readonly tokens: SeaWhiteTokenManager;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: AneloClientOptions) {
    this.doFetch = opts.fetchImpl ?? fetch;
    this.tokens = new SeaWhiteTokenManager({ ...opts, fetchImpl: this.doFetch });
  }

  // --- Consultas (sólo lectura) ----------------------------------------------

  async consultar(tipo: TipoRegistro, cliente: string, subcliente: string, identificador: string): Promise<Consulta> {
    const campo = tipo === "chofer" ? "Chofer" : "Dominio";
    const query = new URLSearchParams({ Servidor: this.opts.servidor, Cliente: cliente, Subcliente: subcliente, [campo]: identificador });
    const res = await this.request("GET", `/api/VencimientosAnelo/${tipo}`, { query });
    const body = consultaResponseSchema.safeParse(await this.safeJson(res));

    if (res.status === 404 || (body.success && !body.data.ok)) {
      return { found: false, tipo, identificador, mensaje: body.success ? body.data.mensaje : undefined };
    }
    if (!res.ok) throw new SeaWhiteError(`SEA WHITE respondió HTTP ${res.status} a la consulta de ${tipo}`, res.status);
    if (!body.success || body.data.id === undefined || !body.data.vencimiento) {
      throw new SeaWhiteError(`Respuesta inesperada de SEA WHITE en la consulta de ${tipo}: ${body.success ? "faltan id o vencimiento" : body.error.message}`);
    }
    const d = body.data;
    return {
      found: true,
      tipo,
      id: d.id!,
      cliente: d.cliente ?? cliente,
      subcliente: d.subcliente ?? subcliente,
      identificador: (tipo === "chofer" ? d.chofer : d.dominio) ?? identificador,
      vencimiento: d.vencimiento!,
      fechaAlta: d.fechaAlta ?? null,
      fechaModificacion: d.fechaModificacion ?? null,
    };
  }

  /**
   * Documentación general (licencia, ART y F.931 del chofer; seguro y VTV del
   * camión). Mismas consultas de sólo lectura que usa Enri.
   */
  async documentacion(tipo: TipoRegistro, identificador: string): Promise<Documentacion> {
    const path = tipo === "chofer" ? "/api/vencimientos/chofer" : "/api/vencimientos/camion";
    const payload: Record<string, string> = tipo === "chofer" ? { Nro_Documento: identificador } : { Dominio: identificador };
    const res = await this.request("POST", path, { json: { Servidor: this.opts.servidor, ...payload } });
    const raw = await this.safeJson(res);
    if (res.status === 404) return { found: false };
    if (!res.ok) throw new SeaWhiteError(`SEA WHITE respondió HTTP ${res.status} a la consulta de documentación`, res.status);
    if (tipo === "chofer") {
      const b = documentacionChoferSchema.safeParse(raw);
      if (!b.success || !b.data.ok) return { found: false };
      return { found: true, tipo, nombre: b.data.Razon_Social?.trim() || null, licencia: b.data.Licencia_Vto ?? null, art: b.data.ART_Vto ?? null, f931: b.data.F931_Vto ?? null };
    }
    const b = documentacionCamionSchema.safeParse(raw);
    if (!b.success || !b.data.ok) return { found: false };
    return { found: true, tipo, seguro: b.data.Vto_Seguro ?? null, vtv: b.data.Vto_Vtv ?? null };
  }

  /**
   * PDF del comprobante de VTV o de seguro de un vehículo (sólo lectura).
   * Devuelve null si no existe (404): la API contempla que haya VTV y no
   * seguro, o al revés.
   */
  async documentoVehiculo(tipo: "vtv" | "seguro", dominio: string): Promise<Buffer | null> {
    const res = await this.request("GET", `/api/DocumentosVehiculos/${tipo}/${encodeURIComponent(dominio)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new SeaWhiteError(`SEA WHITE respondió HTTP ${res.status} al pedir la ${tipo} de ${dominio}`, res.status);
    const pdf = Buffer.from(await res.arrayBuffer());
    if (!isPdf(pdf)) throw new SeaWhiteError(`SEA WHITE no devolvió un PDF válido para la ${tipo} de ${dominio}`);
    return pdf;
  }

  /** PDF del carnet. Requiere el `id` que devuelve `consultar`. */
  async descargarPdf(tipo: TipoRegistro, id: number): Promise<Buffer> {
    const res = await this.request("GET", `/api/VencimientosAnelo/${tipo}/${this.opts.servidor}/${id}/pdf`);
    if (!res.ok) throw new SeaWhiteError(`SEA WHITE respondió HTTP ${res.status} al pedir el PDF de ${tipo} ${id}`, res.status);
    const pdf = Buffer.from(await res.arrayBuffer());
    if (!isPdf(pdf)) throw new SeaWhiteError(`SEA WHITE no devolvió un PDF válido para ${tipo} ${id}`);
    return pdf;
  }

  // --- Carga (EXCEPCIÓN AUTORIZADA) --------------------------------------------

  /**
   * Carga los registros en lotes de hasta 30. Valida TODO antes de enviar el
   * primer lote: si un solo registro es inválido, no sale nada.
   */
  async cargar(tipo: TipoRegistro, registros: RegistroCarga[]): Promise<ResumenCarga> {
    this.assertCargaPermitida(registros);
    const validados = registros.map((r) => this.validarRegistro(tipo, r));

    const resumen: ResumenCarga = { total: validados.length, correctos: 0, errores: 0, resultados: [] };
    for (let i = 0; i < validados.length; i += MAX_REGISTROS_POR_LOTE) {
      const lote = validados.slice(i, i + MAX_REGISTROS_POR_LOTE);
      const resultados = await this.enviarLote(tipo, lote);
      for (const r of resultados) {
        resumen.resultados.push(r);
        if (r.ok) resumen.correctos += 1;
        else resumen.errores += 1;
      }
    }
    this.opts.logger.info({ tipo, total: resumen.total, correctos: resumen.correctos, errores: resumen.errores }, "Carga en SEA WHITE terminada");
    return resumen;
  }

  private assertCargaPermitida(registros: RegistroCarga[]): void {
    if (!this.opts.cargaHabilitada) {
      throw new SeaWhiteError("La carga en SEA WHITE está deshabilitada (ANELO_CARGA_HABILITADA=false).");
    }
    if (registros.length === 0) throw new SeaWhiteError("No hay registros para cargar.");
    if (this.opts.modoPrueba) {
      const ajenos = registros.filter((r) => !r.cliente.startsWith(this.opts.prefijoPrueba));
      if (ajenos.length > 0) {
        throw new SeaWhiteError(
          `Modo prueba activo: sólo se puede cargar en clientes de prueba (${this.opts.prefijoPrueba}xx); se intentó ${[...new Set(ajenos.map((r) => r.cliente))].join(", ")}.`,
        );
      }
    }
  }

  private validarRegistro(tipo: TipoRegistro, r: RegistroCarga): RegistroCarga {
    if (!isCodigoValido(r.cliente) || !isCodigoValido(r.subcliente)) {
      throw new SeaWhiteError(`Código de cliente/subcliente inválido (${r.cliente}/${r.subcliente}): deben ser 6 dígitos.`);
    }
    const id = tipo === "chofer" ? normalizeDni(r.identificador) : normalizePatente(r.identificador);
    if (!id.ok || id.value !== r.identificador) {
      throw new SeaWhiteError(`Identificador inválido para ${tipo}: "${r.identificador}".`);
    }
    const fecha = parseCalendarDate(r.vencimiento);
    if (!fecha || formatApi(fecha) !== r.vencimiento) {
      throw new SeaWhiteError(`Vencimiento inválido para ${r.identificador}: "${r.vencimiento}" (debe ser dd-MM-yyyy).`);
    }
    if (!isPdf(r.pdf)) throw new SeaWhiteError(`El archivo de ${r.identificador} no es un PDF válido.`);
    return r;
  }

  private async enviarLote(tipo: TipoRegistro, lote: RegistroCarga[]): Promise<ResumenCarga["resultados"]> {
    const campo = tipo === "chofer" ? "Chofer" : "Dominio";
    const buildForm = () => {
      const form = new FormData();
      form.append("Servidor", this.opts.servidor);
      lote.forEach((r, i) => {
        form.append(`Registros[${i}].Cliente`, r.cliente);
        form.append(`Registros[${i}].Subcliente`, r.subcliente);
        form.append(`Registros[${i}].${campo}`, r.identificador);
        form.append(`Registros[${i}].Vencimiento`, r.vencimiento);
        // Convención de la API: <DNI>.pdf o <DOMINIO>.pdf
        form.append(`Registros[${i}].Archivo`, new Blob([new Uint8Array(r.pdf)], { type: "application/pdf" }), `${r.identificador}.pdf`);
      });
      return form;
    };

    let res: Response;
    try {
      res = await this.request("POST", `/api/VencimientosAnelo/${tipo}`, { body: buildForm });
    } catch (err) {
      // Sin respuesta: no sabemos si se grabó. Se informa como error para revisar.
      const mensaje = `Sin respuesta de SEA WHITE (${(err as Error).message}). Verificá con una consulta antes de reintentar.`;
      return lote.map((r) => ({ identificador: r.identificador, ok: false, mensaje }));
    }

    const parsed = cargaResponseSchema.safeParse(await this.safeJson(res));
    if (!parsed.success) {
      const mensaje = `Respuesta inesperada de SEA WHITE (HTTP ${res.status}). Verificá con una consulta.`;
      return lote.map((r) => ({ identificador: r.identificador, ok: false, mensaje }));
    }
    const body = parsed.data;
    if (!body.resultados || body.resultados.length === 0) {
      // Error general (p. ej. lote rechazado entero). Sin detalle por registro
      // no se puede afirmar que algo se grabó: se informa como error.
      const mensaje = body.mensaje ?? (body.ok ? "SEA WHITE no informó el resultado de cada registro. Verificá con una consulta." : `SEA WHITE rechazó el lote (HTTP ${res.status}).`);
      return lote.map((r) => ({ identificador: r.identificador, ok: false, mensaje }));
    }

    // Cada resultado trae el DNI/dominio (en el error parcial no trae cliente):
    // se cruza por identificador; si falta, por posición.
    return lote.map((r, i) => {
      const match = body.resultados!.find((x) => (tipo === "chofer" ? x.chofer : x.dominio) === r.identificador) ?? body.resultados![i];
      if (!match) return { identificador: r.identificador, ok: false, mensaje: "SEA WHITE no informó el resultado de este registro." };
      return { identificador: r.identificador, ok: match.ok, accion: match.accion, id: match.id, mensaje: match.mensaje };
    });
  }

  // --- HTTP ------------------------------------------------------------------

  /** Verifica conectividad y credenciales (sólo lectura). */
  async ping(): Promise<boolean> {
    const res = await this.request("GET", "/api/autenticacion/me");
    return res.ok;
  }

  private async request(
    method: HttpMethod,
    path: string,
    opts: { query?: URLSearchParams; body?: () => FormData; json?: Record<string, string> } = {},
    retryOn401 = true,
  ): Promise<Response> {
    const { writes } = assertAllowedEndpoint(method, path);
    if (writes && !this.opts.cargaHabilitada) {
      throw new SeaWhiteError("La carga en SEA WHITE está deshabilitada (ANELO_CARGA_HABILITADA=false).");
    }
    const token = await this.tokens.getToken();
    const url = `${this.opts.baseUrl}${path}${opts.query ? `?${opts.query.toString()}` : ""}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (opts.json) headers["Content-Type"] = "application/json";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    let res: Response;
    try {
      // El FormData se arma de nuevo en cada intento: un body ya enviado no se puede reusar.
      const body = opts.json ? JSON.stringify(opts.json) : opts.body?.();
      res = await this.doFetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      throw new SeaWhiteError(`No se pudo conectar con SEA WHITE (${method} ${path}): ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 && retryOn401) {
      this.opts.logger.warn({ method, path }, "SEA WHITE respondió 401; se renueva el token y se reintenta una vez");
      this.tokens.invalidate();
      await this.tokens.refresh();
      return this.request(method, path, opts, false);
    }
    return res;
  }

  private async safeJson(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text.slice(0, 500) };
    }
  }
}

/** ¿Los bytes son un PDF? (cabecera "%PDF-") */
export function isPdf(bytes: Buffer): boolean {
  return bytes.length > 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}
