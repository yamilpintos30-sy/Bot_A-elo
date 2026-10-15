/**
 * Flujo de CARGA (números de la lista de cargadores).
 *
 *   cualquier mensaje -> menú [Choferes] [Dominios]
 *   -> "Indicá cliente y subcliente" -> se cotejan contra la tabla de clientes
 *   -> "✅ encontrados, mandá el PDF"
 *   -> procesar, avisando el progreso (separar carnets, verificar)
 *   -> FILTRO DE TIPO: si eligió choferes y el PDF trae vehículos (o al revés), avisa
 *   -> resumen + [Confirmar carga] [Cancelar]
 *   -> guardar en SEA WHITE -> resultado -> menú otra vez
 *
 * Sin cordialidades: cada mensaje es un dato o un pedido puntual.
 */
import { isPdf } from "../integrations/seawhite/aneloClient.js";
import type { RegistroCarga, ResumenCarga, TipoRegistro } from "../integrations/seawhite/types.js";
import type { CarnetListo } from "../extraction/review.js";
import type { Cliente } from "../storage/catalogo.js";
import type { CarnetRegistrado } from "../storage/registro.js";
import { buttonTitle, normalizeText } from "../utils/text.js";
import { buscar, etiqueta, nombreCorto, resolverCliente, resolverPlanta } from "./catalogo.js";
import { BOTON_FIN } from "./comandos.js";
import type { BotDeps, Emit, LotePendiente } from "./deps.js";
import { avisoTipoMezclado, CARGA, resultadoCarga, resumenParaConfirmar, sinCarnetsAptos, TIPO } from "./texts.js";
import type { ButtonSpec, CargadorState, IncomingAttachment, IncomingMessage, Session } from "./types.js";

const MENU: ButtonSpec[] = [{ title: "👤 Choferes", payload: "tipo:chofer" }, { title: "🚛 Dominios", payload: "tipo:dominio" }, BOTON_FIN];
const CONFIRMAR: ButtonSpec = { title: "Confirmar carga", payload: "confirmar" };
const CANCELAR: ButtonSpec = { title: "Cancelar", payload: "cancelar" };

/** Cada cuánto se avisa "sigue en proceso" mientras se procesa un PDF. */
const AVISO_PROGRESO_MS = 60_000;

const otroTipo = (t: TipoRegistro): TipoRegistro => (t === "chofer" ? "dominio" : "chofer");

function esPdfAdjunto(a: IncomingAttachment): boolean {
  return /pdf/i.test(a.contentType ?? "") || /\.pdf$/i.test(a.fileName ?? "") || /\.pdf(\?|$)/i.test(a.url);
}

function nombreArchivo(a: IncomingAttachment): string {
  if (a.fileName) return a.fileName;
  const fromUrl = decodeURIComponent(a.url.split("?")[0]?.split("/").pop() ?? "");
  return /\.pdf$/i.test(fromUrl) ? fromUrl : "documento.pdf";
}

/** "chofer", "choferes", "dominio", "dominios" escritos en vez de tocar el botón. */
function tipoEscrito(texto: string): TipoRegistro | undefined {
  const t = normalizeText(texto);
  if (/^choferes?$/.test(t)) return "chofer";
  if (/^dominios?$/.test(t)) return "dominio";
  return undefined;
}

export class CargadorFlow {
  constructor(
    private readonly deps: BotDeps,
    private readonly avisoProgresoMs = AVISO_PROGRESO_MS,
  ) {}

  async handle(session: Session, msg: IncomingMessage, payload: string | undefined, emit: Emit): Promise<void> {
    const st: CargadorState = (session.cargador ??= { etapa: "esperando_datos" });

    if (st.etapa === "esperando_confirmacion") return this.enConfirmacion(session, st, payload, emit);

    // [Menú 😊]: vuelve a elegir qué cargar.
    if (payload === "menu") {
      session.cargador = { etapa: "esperando_datos" };
      return emit({ kind: "buttons", text: CARGA.menu, buttons: MENU });
    }

    // Adjuntos.
    const pdfs = msg.attachments.filter(esPdfAdjunto);
    if (msg.attachments.length > 0 && pdfs.length === 0) await emit({ kind: "text", text: CARGA.soloPdf });
    if (pdfs.length > 1) await emit({ kind: "text", text: CARGA.unPdfPorVez });
    if (pdfs[0]) st.pdf = { url: pdfs[0].url, fileName: nombreArchivo(pdfs[0]) };

    // 1) Menú: choferes o dominios.
    const tipo = payload?.startsWith("tipo:") ? (payload.slice(5) as TipoRegistro) : tipoEscrito(msg.text);
    if (tipo) {
      session.cargador = { etapa: "esperando_datos", tipo, pdf: st.pdf };
      return emit({ kind: "text", text: CARGA.pedirClienteSubcliente(tipo) });
    }
    if (!st.tipo) return emit({ kind: "buttons", text: CARGA.menu, buttons: MENU });

    // 2) Cliente y subcliente, cotejados contra la tabla.
    const clientes = await this.deps.catalogo.listar();
    const reconocio = this.aplicarClienteSubcliente(st, msg, payload, clientes);
    const elegido = buscar(clientes, st.clienteCodigo, st.plantaCodigo);

    if (!elegido.cliente) {
      if (msg.text.trim() && !reconocio) return emit({ kind: "text", text: CARGA.clienteNoEncontrado(clientes.map((c) => nombreCorto(c.nombre))) });
      return emit({ kind: "text", text: CARGA.pedirClienteSubcliente(st.tipo) });
    }
    if (!elegido.planta) {
      const cliente = elegido.cliente;
      if (this.mencionaSubcliente(msg.text, cliente)) {
        await emit({ kind: "text", text: CARGA.plantaNoEncontrada(nombreCorto(cliente.nombre), cliente.plantas.map((p) => p.nombre)) });
      } else if (cliente.plantas.length === 1) {
        st.plantaCodigo = cliente.plantas[0]!.codigo;
      }
      if (!st.plantaCodigo) return this.pedirPlanta(cliente, emit);
    }
    const destino = etiqueta(...this.par(clientes, st));

    // 3) PDF.
    if (!st.pdf) return emit({ kind: "text", text: CARGA.encontrado(destino, st.tipo) });
    if (reconocio) await emit({ kind: "text", text: `✅ Cliente y subcliente encontrados: *${destino}*.` });
    return this.procesar(session, st, destino, emit);
  }

  private par(clientes: Cliente[], st: CargadorState) {
    const b = buscar(clientes, st.clienteCodigo, st.plantaCodigo);
    return [b.cliente, b.planta] as const;
  }

  /** Toma cliente/subcliente del botón o del texto. Devuelve si reconoció algo nuevo. */
  private aplicarClienteSubcliente(st: CargadorState, msg: IncomingMessage, payload: string | undefined, clientes: Cliente[]): boolean {
    if (payload?.startsWith("pla:")) {
      st.plantaCodigo = payload.slice(4);
      return true;
    }
    if (!msg.text.trim()) return false;
    const cliente = resolverCliente(msg.text, clientes);
    if (cliente) {
      if (cliente.codigo !== st.clienteCodigo) st.plantaCodigo = undefined;
      st.clienteCodigo = cliente.codigo;
    }
    const actual = clientes.find((c) => c.codigo === st.clienteCodigo);
    const planta = actual ? resolverPlanta(msg.text, actual) : undefined;
    if (planta) st.plantaCodigo = planta.codigo;
    return Boolean(cliente || planta);
  }

  /** ¿El texto nombra un subcliente (que no se encontró)? Ej. "total planta 9". */
  private mencionaSubcliente(texto: string, cliente: Cliente): boolean {
    const t = normalizeText(texto);
    const sinCliente = [cliente.codigo, normalizeText(cliente.nombre), ...cliente.alias.map(normalizeText)].reduce((acc, a) => acc.replace(a, " "), t).trim();
    return /\b(planta|pta|pl)\b|\bp\s*\d|\d/.test(sinCliente);
  }

  private async pedirPlanta(cliente: Cliente, emit: Emit): Promise<void> {
    const titulo = CARGA.elegirPlanta(nombreCorto(cliente.nombre));
    if (cliente.plantas.length <= 3) {
      return emit({ kind: "buttons", text: titulo, buttons: cliente.plantas.map((p) => ({ title: buttonTitle(p.nombre), payload: `pla:${p.codigo}` })) });
    }
    return emit({ kind: "text", text: CARGA.listaOpciones(titulo, cliente.plantas.map((p) => p.nombre)) });
  }

  // --- Procesamiento ---------------------------------------------------------------

  private async procesar(session: Session, st: CargadorState, destino: string, emit: Emit): Promise<void> {
    const pdfRef = st.pdf!;
    const tipo = st.tipo!;
    const clienteCodigo = st.clienteCodigo!;
    const plantaCodigo = st.plantaCodigo!;
    // Pase lo que pase, el próximo mensaje arranca del menú (o va a la confirmación).
    session.cargador = { etapa: "esperando_datos" };

    await emit({ kind: "text", text: CARGA.recibido(pdfRef.fileName) });

    let pdf: Buffer;
    try {
      pdf = await this.deps.descargarAdjunto(pdfRef.url);
    } catch (err) {
      this.deps.logger.error({ err }, "No se pudo descargar el PDF del cargador");
      return this.conMenu(emit, CARGA.noDescarga);
    }
    if (!isPdf(pdf)) return this.conMenu(emit, CARGA.noEsPdf);

    const cargaId = await this.deps.registro
      .crearCarga({ conversationId: session.conversationId, telefono: session.phone, clienteCodigo, plantaCodigo, archivo: pdfRef.fileName })
      .catch((err) => {
        this.deps.logger.warn({ err }, "No se pudo registrar la carga (se sigue igual)");
        return null;
      });

    // Mientras procesa, cada tanto avisa que sigue trabajando.
    const timer = setInterval(() => void emit({ kind: "text", text: CARGA.sigue }).catch(() => undefined), this.avisoProgresoMs);
    let resultado: LotePendiente["resultado"];
    try {
      resultado = await this.deps.procesador.procesar(pdf, pdfRef.fileName, async (etapa) => {
        if (etapa === "verificando") await emit({ kind: "text", text: CARGA.verificando });
      });
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      this.deps.logger.error({ err: motivo }, "Falló el procesamiento del PDF");
      await this.deps.registro.terminarCarga(cargaId, { estado: "fallida", total: 0, correctos: 0, errores: 0, costoUsd: null, detalle: { error: motivo } }).catch(() => undefined);
      return this.conMenu(emit, CARGA.falloProceso(motivo));
    } finally {
      clearInterval(timer);
    }

    if (resultado.aceptados.length === 0) {
      await this.deps.registro
        .terminarCarga(cargaId, { estado: "fallida", total: 0, correctos: 0, errores: resultado.rechazados.length, costoUsd: resultado.costoUsd, detalle: { rechazados: resultado.rechazados, formato: resultado.formato } })
        .catch(() => undefined);
      return this.conMenu(emit, sinCarnetsAptos(destino, resultado.rechazados));
    }

    const lote: LotePendiente = { tipo, cargaId, clienteCodigo, plantaCodigo, destino, archivo: pdfRef.fileName, resultado };
    const loteId = this.deps.lotes.guardar(lote);
    session.cargador = { etapa: "esperando_confirmacion", tipo, clienteCodigo, plantaCodigo, loteId };
    return this.mostrarResumen(lote, emit);
  }

  /**
   * Resumen para confirmar, con el FILTRO DE TIPO: sólo se ofrece cargar los
   * carnets del tipo elegido. Si el PDF es todo del otro tipo, no hay nada que
   * confirmar: se avisa y se ofrece cargarlo como el otro tipo.
   */
  private async mostrarResumen(lote: LotePendiente, emit: Emit): Promise<void> {
    const delTipo = lote.resultado.aceptados.filter((c) => c.tipo === lote.tipo);
    const otros = lote.resultado.aceptados.filter((c) => c.tipo !== lote.tipo);
    if (delTipo.length === 0) {
      const otro = otroTipo(lote.tipo);
      return emit({
        kind: "buttons",
        text: CARGA.tipoIncorrecto(lote.tipo, otro, otros.length),
        buttons: [{ title: buttonTitle(`Cargar ${TIPO[otro].plural}`), payload: "cambiar" }, CANCELAR],
      });
    }
    if (otros.length > 0) await emit({ kind: "text", text: avisoTipoMezclado(lote.tipo, otros) });
    return emit({ kind: "buttons", text: resumenParaConfirmar(lote.destino, delTipo, lote.resultado.rechazados), buttons: [CONFIRMAR, CANCELAR] });
  }

  private async enConfirmacion(session: Session, st: CargadorState, payload: string | undefined, emit: Emit): Promise<void> {
    const lote = this.deps.lotes.obtener(st.loteId);
    if (!lote) {
      session.cargador = { etapa: "esperando_datos" };
      return this.conMenu(emit, CARGA.expirada);
    }
    if (payload === "cancelar") {
      this.deps.lotes.borrar(st.loteId);
      session.cargador = { etapa: "esperando_datos" };
      return this.conMenu(emit, CARGA.cancelada);
    }
    if (payload === "cambiar") {
      // Cargarlo como el otro tipo (el que realmente tiene el PDF).
      lote.tipo = otroTipo(lote.tipo);
      st.tipo = lote.tipo;
      return this.mostrarResumen(lote, emit);
    }
    const hayDelTipo = lote.resultado.aceptados.some((c) => c.tipo === lote.tipo);
    if (payload === "confirmar" && hayDelTipo) {
      this.deps.lotes.borrar(st.loteId);
      session.cargador = { etapa: "esperando_datos" };
      return this.confirmar(lote, emit);
    }
    // Cualquier otra cosa: se repite la pregunta pendiente con SUS botones
    // (si el PDF era del otro tipo, vuelve el aviso con "Cargar ..." / "Cancelar").
    if (!hayDelTipo) return this.mostrarResumen(lote, emit);
    return emit({ kind: "buttons", text: CARGA.pendiente, buttons: [CONFIRMAR, CANCELAR] });
  }

  private async confirmar(lote: LotePendiente, emit: Emit): Promise<void> {
    const aCargar: CarnetListo[] = lote.resultado.aceptados.filter((c) => c.tipo === lote.tipo);
    await emit({ kind: "text", text: CARGA.cargando(aCargar.length) });

    const registros: RegistroCarga[] = aCargar.map((c) => ({
      cliente: lote.clienteCodigo,
      subcliente: lote.plantaCodigo,
      identificador: c.identificador,
      vencimiento: c.vencimiento,
      pdf: c.pdf,
    }));
    let resumen: ResumenCarga;
    try {
      resumen = await this.deps.seawhite.cargar(lote.tipo, registros);
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : String(err);
      this.deps.logger.error({ err: mensaje, tipo: lote.tipo }, "La carga en SEA WHITE falló");
      resumen = { total: registros.length, correctos: 0, errores: registros.length, resultados: registros.map((r) => ({ identificador: r.identificador, ok: false, mensaje })) };
    }

    // Registro propio: sólo lo que SEA WHITE confirmó, con su id (para "Ver carnet").
    const okPorId = new Map(resumen.resultados.filter((r) => r.ok).map((r) => [r.identificador, r]));
    const carnets: CarnetRegistrado[] = aCargar
      .filter((c) => okPorId.has(c.identificador))
      .map((c) => ({
        clienteCodigo: lote.clienteCodigo,
        plantaCodigo: lote.plantaCodigo,
        tipo: c.tipo,
        identificador: c.identificador,
        apellidoNombre: c.apellidoNombre,
        vencimiento: c.vencimiento,
        observaciones: c.observaciones,
        seawhiteId: okPorId.get(c.identificador)?.id ?? null,
      }));
    await this.deps.registro.guardarCarnets(lote.cargaId, carnets).catch((err) => this.deps.logger.error({ err }, "No se pudo guardar el registro de carnets"));
    await this.deps.registro
      .terminarCarga(lote.cargaId, {
        estado: resumen.errores === 0 ? "completada" : resumen.correctos === 0 ? "fallida" : "con_errores",
        total: resumen.total,
        correctos: resumen.correctos,
        errores: resumen.errores,
        costoUsd: lote.resultado.costoUsd,
        detalle: { tipo: lote.tipo, resultados: resumen.resultados, rechazados: lote.resultado.rechazados, formato: lote.resultado.formato },
      })
      .catch((err) => this.deps.logger.warn({ err }, "No se pudo cerrar el registro de la carga"));

    return this.conMenu(emit, resultadoCarga(lote.destino, resumen));
  }

  /** Mensaje final de un paso + el menú para la próxima carga. */
  private async conMenu(emit: Emit, texto: string): Promise<void> {
    await emit({ kind: "text", text: texto });
    return emit({ kind: "buttons", text: CARGA.otraCarga, buttons: MENU });
  }
}
