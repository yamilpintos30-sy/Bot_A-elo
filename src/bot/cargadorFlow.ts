/**
 * Flujo de CARGA (números de la lista de cargadores).
 *
 *   ¿Qué cliente?      -> menú con los clientes de la tabla (de a páginas si son más de 10)
 *   ¿Qué operadora?    -> menú con los subclientes de ese cliente
 *   ¿Qué documentación? -> [Choferes] [Dominios]
 *   -> mandar el PDF -> procesar, avisando el progreso (separar carnets, verificar)
 *   -> FILTRO DE TIPO: si eligió choferes y el PDF trae vehículos (o al revés), avisa
 *   -> resumen + [Confirmar carga] [Cancelar]
 *   -> guardar en SEA WHITE -> resultado -> otra carga (mismo cliente u otro)
 *
 * Nada se escribe: cliente y operadora se eligen de menús.
 */
import { nombreYApellido } from "../domain/validators.js";
import { FormatoNoSoportadoError, unirEnPdf } from "../extraction/aPdf.js";
import type { RegistroCarga, ResumenCarga, TipoRegistro } from "../integrations/seawhite/types.js";
import type { CarnetListo } from "../extraction/review.js";
import type { Cliente } from "../storage/catalogo.js";
import type { CarnetRegistrado } from "../storage/registro.js";
import { buttonTitle, normalizeText } from "../utils/text.js";
import { buscar, etiqueta, nombreCorto } from "./catalogo.js";
import { BOTON_FIN, BOTON_MENU } from "./comandos.js";
import type { BotDeps, Emit, LotePendiente } from "./deps.js";
import { avisoTipoMezclado, CARGA, ofrecerOtroTipo, resultadoCarga, resumenParaConfirmar, sinCarnetsAptos, TIPO } from "./texts.js";
import type { ButtonSpec, CargadorState, IncomingAttachment, IncomingMessage, Session } from "./types.js";

const MENU_TIPO: ButtonSpec[] = [{ title: "👤 Choferes", payload: "tipo:chofer" }, { title: "🚛 Dominios", payload: "tipo:dominio" }, BOTON_FIN];
/** Después de una carga: otra del mismo cliente y operadora, o terminar (para cambiar de cliente, "Eso es todo"). */
const MENU_OTRA: ButtonSpec[] = MENU_TIPO;
/** WhatsApp muestra hasta 10 opciones por menú: con más clientes, de a páginas. */
const MAX_OPCIONES = 10;
const POR_PAGINA = 8;

/** Títulos de botón únicos (si dos nombres se cortan igual, se les antepone el código). */
function titulos<T extends { codigo: string; nombre: string }>(items: T[], nombre: (i: T) => string): ButtonSpec[] {
  const base = items.map((i) => buttonTitle(nombre(i)));
  return items.map((i, n) => ({ title: base.filter((b) => b === base[n]).length > 1 ? buttonTitle(`${i.codigo} ${nombre(i)}`) : base[n]!, payload: "" }));
}
const CONFIRMAR: ButtonSpec = { title: "Confirmar carga", payload: "confirmar" };
const CANCELAR: ButtonSpec = { title: "Cancelar", payload: "cancelar" };

/** Cada cuánto se avisa "sigue en proceso" mientras se procesa un PDF. */
const AVISO_PROGRESO_MS = 60_000;

const otroTipo = (t: TipoRegistro): TipoRegistro => (t === "chofer" ? "dominio" : "chofer");

/** PDF o foto (JPG/PNG): las fotos de carnets se convierten a PDF antes de procesar. */
function esDocumentoAdjunto(a: IncomingAttachment): boolean {
  const tipo = `${a.contentType ?? ""} ${a.fileName ?? ""} ${a.url.split("?")[0] ?? ""}`.toLowerCase();
  return a.fileType === "image" || /pdf|image\/(jpe?g|png)|\.(pdf|jpe?g|png)\b/.test(tipo);
}

function nombreArchivo(a: IncomingAttachment): string {
  if (a.fileName) return a.fileName;
  const fromUrl = decodeURIComponent(a.url.split("?")[0]?.split("/").pop() ?? "");
  if (/\.(pdf|jpe?g|png)$/i.test(fromUrl)) return fromUrl;
  return a.fileType === "image" ? "foto.jpg" : "documento.pdf";
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
    const nuevo = !session.cargador;
    const st: CargadorState = (session.cargador ??= { etapa: "esperando_datos" });

    if (st.etapa === "esperando_confirmacion") return this.enConfirmacion(session, st, payload, emit, msg);

    const clientes = await this.deps.catalogo.listar();

    // [Menú 😊] / [🔄 Otro cliente]: de cero, desde el cliente.
    if (payload === "menu" || payload === "otrocliente") {
      session.cargador = { etapa: "esperando_datos" };
      return this.menuClientes(clientes, 0, emit, false);
    }
    if (payload?.startsWith("cpag:")) return this.menuClientes(clientes, Number(payload.slice(5)) || 0, emit, false);

    // Adjuntos: PDF o fotos de carnets (varias fotos juntas se unen en un solo PDF).
    // Se guardan aunque todavía falte elegir algo.
    if (st.pdf && !st.archivos) st.archivos = [st.pdf];
    const docs = msg.attachments.filter(esDocumentoAdjunto);
    if (msg.attachments.length > docs.length) await emit({ kind: "text", text: CARGA.soloPdf });
    if (docs.length > 0) st.archivos = [...(st.archivos ?? []), ...docs.map((a) => ({ url: a.url, fileName: nombreArchivo(a) }))];

    // Lo que eligió en este mensaje.
    if (payload?.startsWith("cli:")) {
      if (clientes.some((c) => c.codigo === payload.slice(4))) {
        st.clienteCodigo = payload.slice(4);
        st.plantaCodigo = undefined;
        st.tipo = undefined;
      }
    } else if (payload?.startsWith("pla:")) {
      st.plantaCodigo = payload.slice(4);
      st.tipo = undefined;
    } else if (payload?.startsWith("tipo:")) {
      st.tipo = payload.slice(5) as TipoRegistro;
    } else {
      const tipo = tipoEscrito(msg.text);
      if (tipo && st.plantaCodigo) st.tipo = tipo;
    }

    const { cliente, planta } = buscar(clientes, st.clienteCodigo, st.plantaCodigo);
    const listo = Boolean(cliente && planta && st.tipo);
    if (docs.length > 0 && !listo) await emit({ kind: "text", text: CARGA.archivoEnEspera });

    // 1) Cliente.
    if (!cliente) {
      st.clienteCodigo = undefined;
      return this.menuClientes(clientes, 0, emit, nuevo);
    }
    // 2) Operadora.
    if (!planta) {
      st.plantaCodigo = undefined;
      return this.menuOperadoras(cliente, emit);
    }
    const destino = etiqueta(cliente, planta);
    // 3) Qué documentación.
    if (!st.tipo) return emit({ kind: "buttons", text: CARGA.elegirTipo(destino), buttons: MENU_TIPO });
    // 4) PDF.
    if (!st.archivos?.length) return emit({ kind: "text", text: CARGA.encontrado(destino, st.tipo) });
    return this.procesar(session, st, destino, emit);
  }

  /** Menú de clientes: todos si entran; si no, de a páginas con [⬅️ Anteriores] [➡️ Ver más]. */
  private menuClientes(clientes: Cliente[], pagina: number, emit: Emit, hola: boolean): Promise<void> {
    const opciones = titulos(clientes, (c) => nombreCorto(c.nombre)).map((b, i) => ({ ...b, payload: `cli:${clientes[i]!.codigo}` }));
    let botones = opciones;
    if (opciones.length > MAX_OPCIONES) {
      const paginas = Math.ceil(opciones.length / POR_PAGINA);
      const p = Math.min(Math.max(pagina, 0), paginas - 1);
      botones = [
        ...(p > 0 ? [{ title: "⬅️ Anteriores", payload: `cpag:${p - 1}` }] : []),
        ...opciones.slice(p * POR_PAGINA, (p + 1) * POR_PAGINA),
        ...(p < paginas - 1 ? [{ title: "➡️ Ver más", payload: `cpag:${p + 1}` }] : []),
      ];
    }
    if (!botones.length) return emit({ kind: "text", text: "No hay clientes cargados. Cargalos desde el panel (Clientes y subclientes)." });
    return emit({ kind: "buttons", text: CARGA.elegirCliente(hola), buttons: botones });
  }

  /** Menú de operadoras (subclientes) del cliente: aunque haya una sola, se elige del menú. */
  private menuOperadoras(cliente: Cliente, emit: Emit): Promise<void> {
    const plantas = cliente.plantas.slice(0, MAX_OPCIONES - 1);
    if (!plantas.length) return emit({ kind: "buttons", text: `*${cliente.nombre}* no tiene operadoras cargadas.`, buttons: [BOTON_MENU, BOTON_FIN] });
    const botones = titulos(plantas, (p) => p.nombre).map((b, i) => ({ ...b, payload: `pla:${plantas[i]!.codigo}` }));
    return emit({ kind: "buttons", text: CARGA.elegirOperadora(cliente.nombre), buttons: botones });
  }

  // --- Procesamiento ---------------------------------------------------------------

  private async procesar(session: Session, st: CargadorState, destino: string, emit: Emit): Promise<void> {
    const archivos = st.archivos!;
    const nombre = archivos.length === 1 ? archivos[0]!.fileName : `${archivos.length} archivos`;
    const tipo = st.tipo!;
    const clienteCodigo = st.clienteCodigo!;
    const plantaCodigo = st.plantaCodigo!;
    // Pase lo que pase, el próximo mensaje sigue con el mismo cliente y operadora (o va a la confirmación).
    session.cargador = { etapa: "esperando_datos", clienteCodigo, plantaCodigo };

    await emit({ kind: "text", text: CARGA.recibido(nombre) });

    let descargados: Array<{ nombre: string; bytes: Buffer }>;
    try {
      descargados = await Promise.all(archivos.map(async (a) => ({ nombre: a.fileName, bytes: await this.deps.descargarAdjunto(a.url) })));
    } catch (err) {
      this.deps.logger.error({ err }, "No se pudo descargar el archivo del cargador");
      return this.conMenu(emit, CARGA.noDescarga);
    }
    // Lo que no es PDF (fotos de carnets) se convierte a PDF; varias fotos van en un solo PDF.
    let pdf: Buffer;
    try {
      pdf = await unirEnPdf(descargados);
    } catch (err) {
      if (err instanceof FormatoNoSoportadoError) return this.conMenu(emit, CARGA.formatoNoSoportado(err.archivo));
      this.deps.logger.error({ err }, "No se pudo armar el PDF con los archivos recibidos");
      return this.conMenu(emit, CARGA.formatoNoSoportado(nombre));
    }
    const nombrePdf = /\.pdf$/i.test(nombre) ? nombre : `${nombre.replace(/\.[a-z]+$/i, "")}.pdf`;

    const cargaId = await this.deps.registro
      .crearCarga({ conversationId: session.conversationId, telefono: session.phone, clienteCodigo, plantaCodigo, archivo: nombre })
      .catch((err) => {
        this.deps.logger.warn({ err }, "No se pudo registrar la carga (se sigue igual)");
        return null;
      });

    // Mientras procesa, cada tanto avisa que sigue trabajando.
    const timer = setInterval(() => void emit({ kind: "text", text: CARGA.sigue }).catch(() => undefined), this.avisoProgresoMs);
    let resultado: LotePendiente["resultado"];
    try {
      resultado = await this.deps.procesador.procesar(pdf, nombrePdf, async (etapa, modo) => {
        if (etapa === "verificando") await emit({ kind: "text", text: modo === "listado" ? CARGA.verificandoListado : CARGA.verificando });
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
      return this.conMenu(emit, sinCarnetsAptos(destino, resultado.rechazados, esListado(resultado)));
    }

    const lote: LotePendiente = { tipo, cargaId, clienteCodigo, plantaCodigo, destino, archivo: nombre, resultado };
    const loteId = this.deps.lotes.guardar(lote);
    session.cargador = { etapa: "esperando_confirmacion", tipo, clienteCodigo, plantaCodigo, loteId, cargaId };
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
        text: CARGA.tipoIncorrecto(lote.tipo, otro, otros.length, esListado(lote.resultado)),
        buttons: [{ title: buttonTitle(`Cargar ${TIPO[otro].plural}`), payload: "cambiar" }, CANCELAR],
      });
    }
    // Aviso del otro tipo sólo si todavía no se cargó (si ya se cargó, no hay nada que ofrecer).
    const otroYaCargado = lote.tiposCargados?.includes(otroTipo(lote.tipo)) ?? false;
    if (otros.length > 0 && !otroYaCargado) await emit({ kind: "text", text: avisoTipoMezclado(lote.tipo, otros) });
    return emit({ kind: "buttons", text: resumenParaConfirmar(lote.destino, delTipo, lote.resultado.rechazados), buttons: [CONFIRMAR, CANCELAR] });
  }

  private async enConfirmacion(session: Session, st: CargadorState, payload: string | undefined, emit: Emit, msg?: IncomingMessage): Promise<void> {
    const lote = this.deps.lotes.obtener(st.loteId);
    if (!lote) {
      // Expiró (o el bot se reinició): no se cargó nada y queda registrado así.
      if (!st.ofreciendoOtro) await this.cerrarRegistro(st.cargaId, "sin_confirmar", null);
      session.cargador = { etapa: "esperando_datos", clienteCodigo: st.clienteCodigo, plantaCodigo: st.plantaCodigo };
      return this.conMenu(emit, CARGA.expirada);
    }
    // Ya se cargó un tipo: se ofrece cargar el otro tipo del mismo documento.
    if (st.ofreciendoOtro) {
      if (payload === "cargarotro") {
        st.ofreciendoOtro = false;
        // Registro aparte para el segundo tipo (el primero ya quedó cerrado).
        lote.cargaId = await this.deps.registro
          .crearCarga({ conversationId: session.conversationId, telefono: session.phone, clienteCodigo: lote.clienteCodigo, plantaCodigo: lote.plantaCodigo, archivo: lote.archivo })
          .catch((err) => {
            this.deps.logger.warn({ err }, "No se pudo registrar la carga (se sigue igual)");
            return null;
          });
        st.cargaId = lote.cargaId;
        return this.mostrarResumen(lote, emit);
      }
      if (payload === "menu" || payload === "cancelar") {
        this.deps.lotes.borrar(st.loteId);
        session.cargador = { etapa: "esperando_datos" };
        return this.menuClientes(await this.deps.catalogo.listar(), 0, emit, false);
      }
      return this.ofrecerOtro(lote, emit);
    }
    if (payload === "cancelar") {
      this.deps.lotes.borrar(st.loteId);
      await this.cerrarRegistro(lote.cargaId, "cancelada", lote.resultado.costoUsd);
      session.cargador = { etapa: "esperando_datos", clienteCodigo: lote.clienteCodigo, plantaCodigo: lote.plantaCodigo };
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
      session.cargador = { etapa: "esperando_datos", clienteCodigo: lote.clienteCodigo, plantaCodigo: lote.plantaCodigo };
      return this.confirmar(session, lote, emit);
    }
    // Cualquier otra cosa: se repite la pregunta pendiente con SUS botones
    // (si el PDF era del otro tipo, vuelve el aviso con "Cargar ..." / "Cancelar").
    if (!hayDelTipo) return this.mostrarResumen(lote, emit);
    // El MISMO archivo otra vez (reenviado o mandado de nuevo mientras se procesaba): se ignora,
    // el resumen con [Confirmar carga] ya está en el chat.
    const repetido = msg && !msg.text.trim() && msg.attachments.length > 0 && msg.attachments.every((a) => nombreArchivo(a) === lote.archivo);
    if (repetido) {
      this.deps.logger.info({ archivo: lote.archivo }, "Mismo archivo mientras espera la confirmación: se ignora");
      return;
    }
    return emit({ kind: "buttons", text: CARGA.pendiente, buttons: [CONFIRMAR, CANCELAR] });
  }

  /** Cierra el registro de una carga que no llegó a SEA WHITE (cancelada o sin confirmar). */
  async cerrarRegistro(cargaId: number | null | undefined, estado: "cancelada" | "sin_confirmar", costoUsd: number | null): Promise<void> {
    if (cargaId == null) return;
    await this.deps.registro
      .terminarCarga(cargaId, { estado, total: 0, correctos: 0, errores: 0, costoUsd, detalle: {} })
      .catch((err) => this.deps.logger.warn({ err, estado }, "No se pudo cerrar el registro de la carga"));
  }

  /**
   * Botón para cargar el otro tipo del mismo documento. `antes`: texto que va en
   * el MISMO mensaje (el resultado de la carga), para que WhatsApp no los desordene.
   */
  private ofrecerOtro(lote: LotePendiente, emit: Emit, antes?: string): Promise<void> {
    const cantidad = lote.resultado.aceptados.filter((c) => c.tipo === lote.tipo).length;
    const boton = lote.tipo === "dominio" ? "🚛 Cargar dominios" : "👤 Cargar choferes";
    const pregunta = ofrecerOtroTipo(lote.tipo, cantidad, esListado(lote.resultado));
    return emit({ kind: "buttons", text: antes ? `${antes}\n\n${pregunta}` : pregunta, buttons: [{ title: boton, payload: "cargarotro" }, BOTON_MENU, BOTON_FIN] });
  }

  private async confirmar(session: Session, lote: LotePendiente, emit: Emit): Promise<void> {
    const aCargar: CarnetListo[] = lote.resultado.aceptados.filter((c) => c.tipo === lote.tipo);
    await emit({ kind: "text", text: CARGA.cargando(aCargar.length, esListado(lote.resultado)) });

    const registros: RegistroCarga[] = aCargar.map((c) => ({
      cliente: lote.clienteCodigo,
      subcliente: lote.plantaCodigo,
      identificador: c.identificador,
      vencimiento: c.vencimiento,
      razonSocial: c.tipo === "chofer" ? nombreYApellido(c.apellidoNombre) : null,
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
        motivoVencimiento: c.motivoVencimiento,
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

    // Documento mezclado: si quedó el otro tipo sin cargar, se ofrece con un botón
    // (sin volver a procesar el PDF).
    const cargados = [...(lote.tiposCargados ?? []), lote.tipo];
    const otro = otroTipo(lote.tipo);
    if (!cargados.includes(otro) && lote.resultado.aceptados.some((c) => c.tipo === otro)) {
      // Sin registro hasta que toque "Cargar ..." (si no lo carga, no queda nada abierto).
      const siguiente: LotePendiente = { ...lote, tipo: otro, tiposCargados: cargados, cargaId: null };
      const loteId = this.deps.lotes.guardar(siguiente);
      session.cargador = { etapa: "esperando_confirmacion", tipo: otro, clienteCodigo: lote.clienteCodigo, plantaCodigo: lote.plantaCodigo, loteId, ofreciendoOtro: true };
      return this.ofrecerOtro(siguiente, emit, resultadoCarga(lote.destino, resumen));
    }
    return this.conMenu(emit, resultadoCarga(lote.destino, resumen));
  }

  /**
   * Mensaje final de un paso + el menú para la próxima carga, en UN mensaje:
   * separados, WhatsApp a veces entregaba primero la pregunta y después el resultado.
   */
  private async conMenu(emit: Emit, texto: string): Promise<void> {
    return emit({ kind: "buttons", text: `${texto}\n\n${CARGA.otraCarga}`, buttons: MENU_OTRA });
  }
}

/** Listado de estado (sin carnet individual): cambia cómo se le habla al cargador. */
const esListado = (r: LotePendiente["resultado"]) => r.manifest.modo === "listado";
