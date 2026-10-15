/**
 * Flujo de CARGA (números de la lista de cargadores).
 *
 *   cliente + planta + PDF (juntos o en cualquier orden)
 *     -> procesar (separar carnets, verificar, revisar)
 *     -> resumen + [Confirmar carga] [Cancelar]
 *     -> cargar en SEA WHITE -> resultado
 *     -> listo para el próximo PDF
 *
 * Sin saludos ni cordialidades: cada mensaje del bot es un dato o un pedido
 * puntual. Si cliente o planta no se reconocen, se ofrecen con botones.
 */
import { isPdf } from "../integrations/seawhite/aneloClient.js";
import type { RegistroCarga, ResumenCarga, TipoRegistro } from "../integrations/seawhite/types.js";
import type { Cliente } from "../storage/catalogo.js";
import type { CarnetRegistrado } from "../storage/registro.js";
import { buttonTitle, normalizeText } from "../utils/text.js";
import { buscar, etiqueta, nombreCorto, resolverCliente, resolverPlanta } from "./catalogo.js";
import type { BotDeps, Emit, LotePendiente } from "./deps.js";
import { CARGA, resultadoCarga, resumenParaConfirmar, sinCarnetsAptos } from "./texts.js";
import type { ButtonSpec, CargadorState, IncomingAttachment, IncomingMessage, Session } from "./types.js";

const CONFIRMAR: ButtonSpec = { title: "Confirmar carga", payload: "confirmar" };
const CANCELAR: ButtonSpec = { title: "Cancelar", payload: "cancelar" };

function esPdfAdjunto(a: IncomingAttachment): boolean {
  return /pdf/i.test(a.contentType ?? "") || /\.pdf$/i.test(a.fileName ?? "") || /\.pdf(\?|$)/i.test(a.url);
}

function nombreArchivo(a: IncomingAttachment): string {
  if (a.fileName) return a.fileName;
  const fromUrl = decodeURIComponent(a.url.split("?")[0]?.split("/").pop() ?? "");
  return /\.pdf$/i.test(fromUrl) ? fromUrl : "documento.pdf";
}

export class CargadorFlow {
  constructor(private readonly deps: BotDeps) {}

  async handle(session: Session, msg: IncomingMessage, payload: string | undefined, emit: Emit): Promise<void> {
    const st: CargadorState = (session.cargador ??= { etapa: "esperando_datos" });

    if (st.etapa === "esperando_confirmacion") {
      if (payload === "confirmar") return this.confirmar(session, st, emit);
      if (payload === "cancelar") {
        this.deps.lotes.borrar(st.loteId);
        session.cargador = { etapa: "esperando_datos" };
        return emit({ kind: "text", text: CARGA.cancelada });
      }
      if (!this.deps.lotes.obtener(st.loteId)) {
        // Expiró (o se reinició el bot): se descarta y el mensaje actual se procesa como uno nuevo.
        session.cargador = { etapa: "esperando_datos" };
        await emit({ kind: "text", text: CARGA.expirada });
        return this.handle(session, msg, payload, emit);
      }
      return emit({ kind: "buttons", text: CARGA.pendiente, buttons: [CONFIRMAR, CANCELAR] });
    }

    const clientes = await this.deps.catalogo.listar();
    const hayDatoNuevo = this.aplicarMensaje(st, msg, payload, clientes);

    // Adjuntos que no son PDF.
    const pdfs = msg.attachments.filter(esPdfAdjunto);
    if (msg.attachments.length > 0 && pdfs.length === 0) await emit({ kind: "text", text: CARGA.soloPdf });
    if (pdfs.length > 1) await emit({ kind: "text", text: CARGA.unPdfPorVez });
    if (pdfs[0]) st.pdf = { url: pdfs[0].url, fileName: nombreArchivo(pdfs[0]) };

    const { cliente, planta } = buscar(clientes, st.clienteCodigo, st.plantaCodigo);

    if (!cliente) {
      if (!hayDatoNuevo && !pdfs[0] && msg.attachments.length === 0) await emit({ kind: "text", text: CARGA.instrucciones });
      return this.pedirCliente(clientes, emit);
    }
    if (!planta) {
      // Una sola planta: no hace falta preguntar.
      if (cliente.plantas.length === 1) st.plantaCodigo = cliente.plantas[0]!.codigo;
      else {
        if (this.mencionaPlanta(msg.text)) {
          await emit({ kind: "text", text: CARGA.plantaNoEncontrada(cliente.nombre, cliente.plantas.map((p) => p.nombre)) });
        }
        return this.pedirPlanta(cliente, emit);
      }
    }
    const elegido = buscar(clientes, st.clienteCodigo, st.plantaCodigo);
    const destino = etiqueta(elegido.cliente, elegido.planta);
    if (!st.pdf) return emit({ kind: "text", text: CARGA.pedirPdf(destino) });

    return this.procesar(session, st, destino, emit);
  }

  /** Toma cliente/planta del botón o del texto. Devuelve si reconoció algo. */
  private aplicarMensaje(st: CargadorState, msg: IncomingMessage, payload: string | undefined, clientes: Cliente[]): boolean {
    if (payload?.startsWith("cli:")) {
      st.clienteCodigo = payload.slice(4);
      st.plantaCodigo = undefined;
      return true;
    }
    if (payload?.startsWith("pla:")) {
      st.plantaCodigo = payload.slice(4);
      return true;
    }
    if (!msg.text) return false;
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

  private mencionaPlanta(texto: string): boolean {
    return /\b(planta|pta|pl)\b|\bp\s*\d/.test(normalizeText(texto));
  }

  private async pedirCliente(clientes: Cliente[], emit: Emit): Promise<void> {
    if (clientes.length > 0 && clientes.length <= 3) {
      return emit({ kind: "buttons", text: CARGA.elegirCliente, buttons: clientes.map((c) => ({ title: buttonTitle(nombreCorto(c.nombre)), payload: `cli:${c.codigo}` })) });
    }
    return emit({ kind: "text", text: CARGA.listaOpciones(CARGA.elegirCliente, clientes.map((c) => nombreCorto(c.nombre))) });
  }

  private async pedirPlanta(cliente: Cliente, emit: Emit): Promise<void> {
    const titulo = CARGA.elegirPlanta(nombreCorto(cliente.nombre));
    if (cliente.plantas.length <= 3) {
      return emit({ kind: "buttons", text: titulo, buttons: cliente.plantas.map((p) => ({ title: buttonTitle(p.nombre), payload: `pla:${p.codigo}` })) });
    }
    return emit({ kind: "text", text: CARGA.listaOpciones(titulo, cliente.plantas.map((p) => p.nombre)) });
  }

  private async procesar(session: Session, st: CargadorState, destino: string, emit: Emit): Promise<void> {
    const pdfRef = st.pdf!;
    const clienteCodigo = st.clienteCodigo!;
    const plantaCodigo = st.plantaCodigo!;
    // Pase lo que pase, el próximo mensaje arranca de cero (o va a la confirmación).
    session.cargador = { etapa: "esperando_datos" };

    await emit({ kind: "text", text: CARGA.procesando(pdfRef.fileName, destino) });

    let pdf: Buffer;
    try {
      pdf = await this.deps.descargarAdjunto(pdfRef.url);
    } catch (err) {
      this.deps.logger.error({ err }, "No se pudo descargar el PDF del cargador");
      return emit({ kind: "text", text: CARGA.noDescarga });
    }
    if (!isPdf(pdf)) return emit({ kind: "text", text: CARGA.noEsPdf });

    const cargaId = await this.deps.registro
      .crearCarga({ conversationId: session.conversationId, telefono: session.phone, clienteCodigo, plantaCodigo, archivo: pdfRef.fileName })
      .catch((err) => {
        this.deps.logger.warn({ err }, "No se pudo registrar la carga (se sigue igual)");
        return null;
      });

    let resultado: LotePendiente["resultado"];
    try {
      resultado = await this.deps.procesador.procesar(pdf, pdfRef.fileName);
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      this.deps.logger.error({ err: motivo }, "Falló el procesamiento del PDF");
      await this.deps.registro.terminarCarga(cargaId, { estado: "fallida", total: 0, correctos: 0, errores: 0, costoUsd: null, detalle: { error: motivo } }).catch(() => undefined);
      return emit({ kind: "text", text: CARGA.falloProceso(motivo) });
    }

    if (resultado.aceptados.length === 0) {
      await this.deps.registro
        .terminarCarga(cargaId, { estado: "fallida", total: 0, correctos: 0, errores: resultado.rechazados.length, costoUsd: resultado.costoUsd, detalle: { rechazados: resultado.rechazados, formato: resultado.formato } })
        .catch(() => undefined);
      return emit({ kind: "text", text: sinCarnetsAptos(destino, resultado.rechazados) });
    }

    const loteId = this.deps.lotes.guardar({ cargaId, clienteCodigo, plantaCodigo, destino, archivo: pdfRef.fileName, resultado });
    session.cargador = { etapa: "esperando_confirmacion", clienteCodigo, plantaCodigo, loteId };
    return emit({ kind: "buttons", text: resumenParaConfirmar(destino, resultado.aceptados, resultado.rechazados), buttons: [CONFIRMAR, CANCELAR] });
  }

  private async confirmar(session: Session, st: CargadorState, emit: Emit): Promise<void> {
    const lote = this.deps.lotes.obtener(st.loteId);
    this.deps.lotes.borrar(st.loteId);
    session.cargador = { etapa: "esperando_datos" };
    if (!lote) return emit({ kind: "text", text: CARGA.expirada });

    const { aceptados } = lote.resultado;
    await emit({ kind: "text", text: CARGA.cargando(aceptados.length) });

    const resumen: ResumenCarga = { total: 0, correctos: 0, errores: 0, resultados: [] };
    for (const tipo of ["chofer", "dominio"] as TipoRegistro[]) {
      const delTipo = aceptados.filter((c) => c.tipo === tipo);
      if (delTipo.length === 0) continue;
      const registros: RegistroCarga[] = delTipo.map((c) => ({
        cliente: lote.clienteCodigo,
        subcliente: lote.plantaCodigo,
        identificador: c.identificador,
        vencimiento: c.vencimiento,
        pdf: c.pdf,
      }));
      let parcial: ResumenCarga;
      try {
        parcial = await this.deps.seawhite.cargar(tipo, registros);
      } catch (err) {
        const mensaje = err instanceof Error ? err.message : String(err);
        this.deps.logger.error({ err: mensaje, tipo }, "La carga en SEA WHITE falló");
        parcial = { total: registros.length, correctos: 0, errores: registros.length, resultados: registros.map((r) => ({ identificador: r.identificador, ok: false, mensaje })) };
      }
      resumen.total += parcial.total;
      resumen.correctos += parcial.correctos;
      resumen.errores += parcial.errores;
      resumen.resultados.push(...parcial.resultados);
    }

    // Registro propio: sólo lo que SEA WHITE confirmó, con su id (para "Ver carnet").
    const okPorId = new Map(resumen.resultados.filter((r) => r.ok).map((r) => [r.identificador, r]));
    const carnets: CarnetRegistrado[] = aceptados
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
        detalle: { resultados: resumen.resultados, rechazados: lote.resultado.rechazados, formato: lote.resultado.formato },
      })
      .catch((err) => this.deps.logger.warn({ err }, "No se pudo cerrar el registro de la carga"));

    return emit({ kind: "text", text: resultadoCarga(lote.destino, resumen) });
  }
}
