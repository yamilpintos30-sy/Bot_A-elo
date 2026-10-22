/**
 * Flujo de CONSULTA (choferes: números de la lista de consultas).
 *
 *   saludo con la imagen del bot -> MENÚ PRINCIPAL, dos ramas:
 *
 *   🪪 Habilitación -> [Por DNI] [Por dominio] [Menú]
 *        -> DNI o patente
 *        -> clientes donde está habilitado (API 1 / 7 de SEA WHITE) -> elige uno
 *        -> su operadora (API 2 / 8): si hay una sola, directo; si no, se elige
 *        -> habilitación y vencimiento -> ¿carnet? -> PDF
 *        al terminar: [Menú 😊] vuelve al inicio, [🔎 Consulta] otro DNI o dominio,
 *        [Eso es todo]. Con varios clientes, también [🏢 Otro cliente].
 *
 *   📄 VTV y seguro -> [VTV] [Seguro] [Menú] -> patente -> PDF -> ¿el otro también?
 *
 * Los clientes salen de SEA WHITE, no de la tabla del bot: sólo aparecen
 * aquellos donde ese DNI o esa patente tienen habilitación vigente.
 */
import { findDniInText, findPatenteInText, normalizeDni, normalizePatente } from "../domain/validators.js";
import type { CodigoNombre, Documentacion, TipoRegistro } from "../integrations/seawhite/types.js";
import { todayInTimeZone } from "../utils/dates.js";
import { nombreCompleto } from "../utils/names.js";
import { normalizeText } from "../utils/text.js";
import { nombreCorto } from "./catalogo.js";
import { BOTON_FIN, BOTON_MENU, PIE } from "./comandos.js";
import type { BotDeps, Emit } from "./deps.js";
import { aclaracionLista, emitirMenu, titulos, variasListas } from "./menuListas.js";
import { CONSULTA, respuestaConsulta, type LineaPlanta } from "./texts.js";
import type { ButtonSpec, ConsultaState, IncomingMessage, Session } from "./types.js";

type Modo = NonNullable<ConsultaState["modo"]>;
type Rama = NonNullable<ConsultaState["rama"]>;
type Doc = "vtv" | "seguro";

/** Menú principal: las dos ramas + cerrar. */
const MENU_PRINCIPAL: ButtonSpec[] = [
  { title: "🪪 Habilitación", payload: "r:habilitacion" },
  { title: "📄 VTV y seguro", payload: "r:vehiculo" },
  BOTON_FIN,
];
const MENU_HABILITACION: ButtonSpec[] = [{ title: "🪪 Por DNI", payload: "m:chofer" }, { title: "🚛 Por dominio", payload: "m:dominio" }, BOTON_MENU];
const MENU_VEHICULO: ButtonSpec[] = [{ title: "📄 VTV", payload: "m:vtv" }, { title: "🛡️ Seguro", payload: "m:seguro" }, BOTON_MENU];
const BOTON_CONSULTA: ButtonSpec = { title: "🔎 Consulta", payload: "consulta" };
const BOTON_OTRO_CLIENTE: ButtonSpec = { title: "🏢 Otro cliente", payload: "otrocli" };
/** Cierre de una consulta de habilitación: inicio, otro DNI/dominio, o terminar. */
const FIN_CONSULTA: ButtonSpec[] = [BOTON_MENU, BOTON_CONSULTA, BOTON_FIN];

const ramaDe = (m: Modo): Rama => (m === "vtv" || m === "seguro" ? "vehiculo" : "habilitacion");

interface Opcion {
  rama: Rama;
  modo?: Modo;
}

function opcionDeBoton(payload: string | undefined): Opcion | undefined {
  if (payload === "r:habilitacion" || payload === "r:vehiculo") return { rama: payload.slice(2) as Rama };
  if (payload?.startsWith("m:")) {
    const modo = payload.slice(2) as Modo;
    return { rama: ramaDe(modo), modo };
  }
  return undefined;
}

/** Opciones escritas en vez de tocar el botón. */
function opcionEscrita(texto: string): Opcion | undefined {
  const t = normalizeText(texto);
  if (/^(habilitacion|habilitaciones|consulta habilitacion|credencial|vencimiento|vencimientos)$/.test(t)) return { rama: "habilitacion" };
  if (/^(vtv y seguro|vtv y seguros|consulta vtv y seguro|comprobantes)$/.test(t)) return { rama: "vehiculo" };
  if (/^(por dni|dni|chofer|choferes|persona)$/.test(t)) return { rama: "habilitacion", modo: "chofer" };
  if (/^(por dominio|dominio|patente|vehiculo|camion|unidad)$/.test(t)) return { rama: "habilitacion", modo: "dominio" };
  if (/^(vtv|consulta vtv)$/.test(t)) return { rama: "vehiculo", modo: "vtv" };
  if (/^(seguro|consulta seguro|poliza)$/.test(t)) return { rama: "vehiculo", modo: "seguro" };
  return undefined;
}

const otroDoc = (d: Doc): Doc => (d === "vtv" ? "seguro" : "vtv");

/** Cliente o operadora escritos en vez de tocar la opción: sólo si coincide con UNO de la lista. */
function elegidoPorTexto(texto: string, opciones: CodigoNombre[]): CodigoNombre | undefined {
  const t = normalizeText(texto);
  if (t.length < 3) return undefined;
  const coinciden = opciones.filter((o) => normalizeText(o.nombre).includes(t) || o.codigo === texto.trim());
  return coinciden.length === 1 ? coinciden[0] : undefined;
}

export class ConsultaFlow {
  constructor(private readonly deps: BotDeps) {}

  async handle(session: Session, msg: IncomingMessage, payload: string | undefined, emit: Emit): Promise<void> {
    const st: ConsultaState = (session.consulta ??= { saludado: false });
    if (!st.saludado) {
      st.saludado = true;
      // Como Enri: foto del bot con el saludo (por el nombre si el teléfono está
      // en SEA WHITE). El canal espera la ENTREGA de la imagen antes de seguir.
      const nombre = await this.nombreDelContacto(session.phone);
      await emit({ kind: "image", caption: CONSULTA.saludo(this.deps.botName, nombre) });
    }

    // --- Botones y comandos ---
    if (payload === "menu") {
      session.consulta = { saludado: true };
      return this.menuPrincipal(emit);
    }
    if (payload === "consulta") {
      // Otro DNI o dominio: vuelve a [Por DNI] [Por dominio].
      session.consulta = { saludado: true, rama: "habilitacion" };
      return this.retomar(session.consulta, emit);
    }
    if (payload === "otrocli") return this.menuClientesHabilitados(st, emit);
    if (payload === "carnet") return this.enviarCarnet(st, emit);
    if (payload === "nocarnet") return this.algoMas(emit, CONSULTA.algoMas, FIN_CONSULTA);
    if (payload === "otrodoc") return this.enviarOtroDoc(session, st, emit);
    if (payload?.startsWith("hc:")) return this.elegirCliente(st, payload.slice(3), emit);
    if (payload?.startsWith("hs:")) return this.elegirOperadora(st, payload.slice(3), emit);

    // Este número no recibe archivos (sólo los cargadores).
    if (msg.attachments.length > 0) {
      await emit({ kind: "text", text: CONSULTA.sinArchivos, sinPie: true });
      if (!msg.text.trim()) return this.retomar(st, emit);
    }

    const opcion = opcionDeBoton(payload) ?? opcionEscrita(msg.text);
    if (opcion) return this.ir(st, opcion, emit);

    // --- Menú principal: hasta elegir una rama no se toma nada más ---
    if (!st.rama) return this.menuPrincipal(emit);

    // --- Rama VTV y seguro ---
    if (st.rama === "vehiculo") {
      if (!st.modo) return this.retomar(st, emit);
      return this.pasoDocumento(session, st, st.modo as Doc, msg.text, emit);
    }

    // --- Rama habilitación ---
    return this.pasoHabilitacion(st, msg, emit);
  }

  /**
   * Nombre del chofer por su teléfono (consulta de sólo lectura a SEA WHITE),
   * como Enri: "MENTASTI, PEDRO CARLOS" -> "Pedro Carlos Mentasti". Si falla o
   * no existe, el saludo queda genérico: nunca bloquea la conversación.
   */
  private async nombreDelContacto(phone: string | null): Promise<string | null> {
    if (!phone) return null;
    try {
      const razonSocial = await this.deps.seawhite.nombrePorTelefono(phone);
      return nombreCompleto(razonSocial) || null;
    } catch (err) {
      this.deps.logger.warn({ err }, "No se pudo identificar el contacto por teléfono (saludo genérico)");
      return null;
    }
  }

  // --- Menú y elección -----------------------------------------------------------

  private menuPrincipal(emit: Emit): Promise<void> {
    return emit({ kind: "buttons", text: CONSULTA.menuPrincipal, buttons: MENU_PRINCIPAL });
  }

  /** Eligió una rama (y quizás una opción dentro de ella): empieza de cero en esa opción. */
  private ir(st: ConsultaState, opcion: Opcion, emit: Emit): Promise<void> {
    st.rama = opcion.rama;
    st.modo = opcion.modo;
    this.olvidarHabilitacion(st);
    st.ultimoDominio = undefined;
    st.otroOfrecido = undefined;
    return this.retomar(st, emit);
  }

  private olvidarHabilitacion(st: ConsultaState): void {
    st.identificador = undefined;
    st.habilitados = undefined;
    st.clienteCodigo = undefined;
    st.clienteNombre = undefined;
    st.subclientes = undefined;
    st.plantaCodigo = undefined;
    st.plantaNombre = undefined;
    st.ultimos = undefined;
  }

  /** Repite la pregunta del paso en el que está (tras un aviso, un adjunto, etc.). */
  private retomar(st: ConsultaState, emit: Emit): Promise<void> {
    if (!st.rama) return this.menuPrincipal(emit);
    if (st.rama === "vehiculo") {
      if (st.modo === "vtv" || st.modo === "seguro") return emit({ kind: "text", text: CONSULTA.pedirPatenteDoc(st.modo) });
      return emit({ kind: "buttons", text: CONSULTA.menuVehiculo, buttons: MENU_VEHICULO });
    }
    if (st.modo !== "chofer" && st.modo !== "dominio") return emit({ kind: "buttons", text: CONSULTA.menuHabilitacion, buttons: MENU_HABILITACION });
    if (st.habilitados?.length && !st.clienteCodigo) return this.menuClientesHabilitados(st, emit);
    if (st.clienteCodigo && st.subclientes?.length && !st.plantaCodigo) return this.menuOperadoras(st, emit);
    return this.pedirIdentificador(st.modo, emit);
  }

  private pedirIdentificador(modo: TipoRegistro, emit: Emit): Promise<void> {
    return emit({ kind: "text", text: modo === "chofer" ? CONSULTA.pedirDni : CONSULTA.pedirPatente });
  }

  // --- Habilitación ----------------------------------------------------------------

  private async pasoHabilitacion(st: ConsultaState, msg: IncomingMessage, emit: Emit): Promise<void> {
    // DNI o patente escritos (también sin haber tocado [Por DNI] / [Por dominio]).
    const dni = st.modo !== "dominio" ? findDniInText(msg.text) : undefined;
    const patente = !dni && st.modo !== "chofer" ? findPatenteInText(msg.text) : undefined;
    if (dni || patente) {
      st.modo = dni ? "chofer" : "dominio";
      return this.buscarClientes(st, st.modo, (dni ?? patente)!, emit);
    }

    // Eligiendo cliente u operadora: puede escribir el nombre en vez de tocarlo.
    if (st.habilitados?.length && !st.clienteCodigo) {
      const c = elegidoPorTexto(msg.text, st.habilitados);
      return c ? this.elegirCliente(st, c.codigo, emit) : this.menuClientesHabilitados(st, emit);
    }
    if (st.clienteCodigo && st.subclientes?.length && !st.plantaCodigo) {
      const s = elegidoPorTexto(msg.text, st.subclientes);
      return s ? this.elegirOperadora(st, s.codigo, emit) : this.menuOperadoras(st, emit);
    }

    if (st.modo !== "chofer" && st.modo !== "dominio") return this.retomar(st, emit);
    if (!msg.text.trim()) return this.pedirIdentificador(st.modo, emit);
    if (st.modo === "chofer") return emit({ kind: "text", text: CONSULTA.dniInvalido(normalizeDni(msg.text).error ?? "DNI inválido.") });
    return emit({ kind: "text", text: CONSULTA.patenteInvalida(normalizePatente(msg.text).error ?? "Patente inválida.") });
  }

  /** DNI o patente -> clientes donde está habilitado (API 1 / 7). */
  private async buscarClientes(st: ConsultaState, tipo: TipoRegistro, identificador: string, emit: Emit): Promise<void> {
    this.olvidarHabilitacion(st);
    st.identificador = identificador;
    let clientes: CodigoNombre[];
    try {
      await emit({ kind: "text", text: CONSULTA.buscandoHabilitaciones(tipo, identificador), sinPie: true });
      clientes = await this.deps.seawhite.clientesHabilitados(tipo, identificador);
    } catch (err) {
      this.deps.logger.warn({ err }, "SEA WHITE no respondió los clientes habilitados");
      return this.algoMas(emit, `${CONSULTA.consultaNoDisponible}\n\n${CONSULTA.algoMas}`, FIN_CONSULTA);
    }
    // Sin habilitaciones vigentes: sigue esperando otro DNI o patente.
    if (!clientes.length) return emit({ kind: "text", text: CONSULTA.sinHabilitaciones(tipo, identificador) });
    st.habilitados = [...clientes].sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    return this.menuClientesHabilitados(st, emit);
  }

  /** Clientes donde está habilitado: botones, una lista o varias (menuListas.ts). */
  private menuClientesHabilitados(st: ConsultaState, emit: Emit): Promise<void> {
    const clientes = st.habilitados ?? [];
    const tipo = st.modo === "dominio" ? "dominio" : "chofer";
    if (!clientes.length || !st.identificador) return this.retomar({ ...st, habilitados: undefined }, emit);
    st.clienteCodigo = undefined;
    st.clienteNombre = undefined;
    st.subclientes = undefined;
    st.plantaCodigo = undefined;
    st.plantaNombre = undefined;
    const opciones = titulos(clientes, (c) => nombreCorto(c.nombre)).map((b, i) => ({ ...b, payload: `hc:${clientes[i]!.codigo}` }));
    const encabezado = CONSULTA.elegirClienteHabilitado(tipo, st.identificador, clientes.length);
    return emitirMenu(emit, opciones, {
      una: (lista) => (lista ? `${encabezado}\n${aclaracionLista}` : encabezado),
      varias: (listas) => `${encabezado}\n${variasListas(listas)}`,
    });
  }

  /** Eligió el cliente -> sus operadoras (API 2 / 8). Con una sola, se consulta directo. */
  private async elegirCliente(st: ConsultaState, codigo: string, emit: Emit): Promise<void> {
    const cliente = st.habilitados?.find((c) => c.codigo === codigo);
    const tipo = st.modo === "dominio" ? "dominio" : "chofer";
    if (!cliente || !st.identificador) return this.retomar(st, emit);
    st.clienteCodigo = cliente.codigo;
    st.clienteNombre = cliente.nombre;
    let subclientes: CodigoNombre[];
    try {
      subclientes = await this.deps.seawhite.subclientesHabilitados(tipo, st.identificador, cliente.codigo);
    } catch (err) {
      this.deps.logger.warn({ err }, "SEA WHITE no respondió los subclientes habilitados");
      return this.algoMas(emit, `${CONSULTA.consultaNoDisponible}\n\n${CONSULTA.algoMas}`, FIN_CONSULTA);
    }
    if (subclientes.length === 1) return this.elegirOperadora(st, subclientes[0]!.codigo, emit, subclientes);
    if (!subclientes.length) {
      // No debería pasar (la API 1/7 lo listó en este cliente): se informa sin credencial.
      return this.consultar(st, tipo, st.identificador, cliente.codigo, null, emit);
    }
    st.subclientes = subclientes;
    return this.menuOperadoras(st, emit);
  }

  private menuOperadoras(st: ConsultaState, emit: Emit): Promise<void> {
    const subs = st.subclientes ?? [];
    const opciones = titulos(subs, (s) => s.nombre).map((b, i) => ({ ...b, payload: `hs:${subs[i]!.codigo}` }));
    const encabezado = CONSULTA.elegirOperadoraHabilitada(st.clienteNombre ?? "");
    return emitirMenu(emit, opciones, {
      una: (lista) => (lista ? `${encabezado}\n${aclaracionLista}` : encabezado),
      varias: (listas) => `${encabezado}\n${variasListas(listas)}`,
    });
  }

  private elegirOperadora(st: ConsultaState, codigo: string, emit: Emit, lista = st.subclientes): Promise<void> {
    const sub = lista?.find((s) => s.codigo === codigo);
    if (!sub || !st.identificador || !st.clienteCodigo) return this.retomar(st, emit);
    st.plantaCodigo = sub.codigo;
    st.plantaNombre = sub.nombre;
    return this.consultar(st, st.modo === "dominio" ? "dominio" : "chofer", st.identificador, st.clienteCodigo, sub.codigo, emit);
  }

  /** Habilitación en ese cliente y operadora (GET chofer/dominio): vencimiento y ¿carnet? */
  private async consultar(st: ConsultaState, tipo: TipoRegistro, identificador: string, clienteCodigo: string, plantaCodigo: string | null, emit: Emit): Promise<void> {
    const hoy = todayInTimeZone(this.deps.timezone, this.deps.now());
    const destino = [st.clienteNombre, st.plantaNombre].filter(Boolean).join(" – ");
    st.ultimos = undefined;

    let linea: LineaPlanta | undefined;
    let seawhiteId: number | null = null;
    let nombre: string | null = null;
    let fallo = false;
    if (plantaCodigo) {
      try {
        const c = await this.deps.seawhite.consultar(tipo, clienteCodigo, plantaCodigo, identificador);
        if (c.found) {
          linea = { destino, vencimiento: c.vencimiento, enSeaWhite: true, observaciones: null };
          seawhiteId = c.id;
          nombre = c.nombre ? nombreCompleto(c.nombre) || c.nombre : null;
        }
      } catch (err) {
        fallo = true;
        this.deps.logger.warn({ err }, "SEA WHITE no respondió la consulta de vencimiento");
      }
    }

    // Datos propios del registro (nombre y observaciones del carnet), si existen.
    try {
      const reg = (await this.deps.registro.buscarCarnets(tipo, identificador)).find((r) => r.clienteCodigo === clienteCodigo && r.plantaCodigo === plantaCodigo);
      nombre ??= reg?.apellidoNombre ?? null;
      if (linea && reg?.observaciones) linea.observaciones = reg.observaciones;
      if (fallo && reg) linea = { destino, vencimiento: reg.vencimiento, enSeaWhite: true, observaciones: reg.observaciones };
    } catch (err) {
      this.deps.logger.warn({ err }, "No se pudo leer el registro de carnets");
    }

    // El nombre del chofer, si no vino en la consulta (documentación general, sólo lectura).
    if (tipo === "chofer" && !nombre) {
      try {
        const doc: Documentacion = await this.deps.seawhite.documentacion(tipo, identificador);
        if (doc.found && doc.tipo === "chofer") nombre = doc.nombre;
      } catch (err) {
        this.deps.logger.warn({ err }, "No se pudo consultar el nombre del chofer");
      }
    }

    const texto = respuestaConsulta({ tipo, identificador, nombre, plantas: linea ? [linea] : [], sinCredencialEn: linea ? undefined : destino, hoy });
    const otroCliente = (st.habilitados?.length ?? 0) > 1 ? [BOTON_OTRO_CLIENTE] : [];

    if (seawhiteId === null) return emit({ kind: "buttons", text: `${texto}\n\n${CONSULTA.algoMas}`, buttons: otroCliente.length ? [BOTON_MENU, BOTON_CONSULTA, ...otroCliente] : FIN_CONSULTA });
    st.ultimos = [{ tipo, identificador, clienteCodigo, plantaCodigo: plantaCodigo!, etiqueta: destino, seawhiteId }];
    await emit({ kind: "text", text: texto, sinPie: true });
    return emit({
      kind: "buttons",
      text: CONSULTA.preguntaCarnet,
      buttons: [{ title: "📄 Sí, pasámelo", payload: "carnet" }, { title: "No, gracias", payload: "nocarnet" }, ...otroCliente],
    });
  }

  /** Manda el carnet de la ÚLTIMA consulta, con el ID que vino en ella (nunca otro DNI). */
  private async enviarCarnet(st: ConsultaState, emit: Emit): Promise<void> {
    const c = st.ultimos?.[0];
    if (!c || c.seawhiteId === null) return this.algoMas(emit, CONSULTA.algoMas, FIN_CONSULTA);
    try {
      const pdf = await this.deps.seawhite.descargarPdf(c.tipo, c.seawhiteId);
      await emit({ kind: "file", filename: `${c.identificador}.pdf`, data: pdf, caption: `📄 Carnet – ${c.etiqueta}` });
    } catch (err) {
      this.deps.logger.error({ err }, "No se pudo traer el PDF del carnet");
      await emit({ kind: "text", text: CONSULTA.carnetNoDisponible, sinPie: true });
    }
    return this.algoMas(emit, CONSULTA.algoMas, (st.habilitados?.length ?? 0) > 1 ? [BOTON_MENU, BOTON_CONSULTA, BOTON_OTRO_CLIENTE] : FIN_CONSULTA);
  }

  // --- VTV y seguro (sólo por dominio) ----------------------------------------------

  private async pasoDocumento(session: Session, st: ConsultaState, doc: Doc, texto: string, emit: Emit): Promise<void> {
    const patente = findPatenteInText(texto);
    if (!patente) {
      if (texto.trim()) return emit({ kind: "text", text: CONSULTA.patenteInvalida(normalizePatente(texto).error ?? "Patente inválida.") });
      return emit({ kind: "text", text: CONSULTA.pedirPatenteDoc(doc) });
    }
    st.ultimoDominio = patente;
    st.otroOfrecido = false;
    const resultado = await this.enviarDoc(session, doc, patente, emit);
    // No lo encontró: que revise la patente (sigue esperando otra). No se ofrece el otro comprobante.
    if (resultado === "no_encontrado") return emit({ kind: "text", text: CONSULTA.revisarPatente });
    // Estaba pero no se pudo entregar: tampoco se ofrece el otro.
    if (resultado !== "enviado") return this.algoMas(emit, CONSULTA.algoMasVehiculo, PIE);
    // Recién con el comprobante entregado se ofrece el otro del mismo vehículo.
    st.otroOfrecido = true;
    const otro = otroDoc(doc);
    return emit({
      kind: "buttons",
      text: CONSULTA.ofrecerOtro(otro, patente),
      buttons: [{ title: otro === "vtv" ? "📄 Sí, la VTV" : "🛡️ Sí, el seguro", payload: "otrodoc" }, BOTON_MENU, BOTON_FIN],
    });
  }

  private async enviarOtroDoc(session: Session, st: ConsultaState, emit: Emit): Promise<void> {
    const doc = st.modo === "vtv" || st.modo === "seguro" ? otroDoc(st.modo) : undefined;
    if (!doc || !st.ultimoDominio) return this.retomar(st, emit);
    await this.enviarDoc(session, doc, st.ultimoDominio, emit);
    return this.algoMas(emit, CONSULTA.algoMasVehiculo, PIE);
  }

  /**
   * Trae el comprobante y lo entrega SÓLO si el resguardo confirma que la
   * patente pedida, la del nombre del archivo y la de adentro del PDF son la
   * misma. Si no, responde que no está disponible y registra una falla crítica.
   */
  private async enviarDoc(session: Session, doc: Doc, dominio: string, emit: Emit): Promise<"enviado" | "no_encontrado" | "no_disponible"> {
    try {
      await emit({ kind: "text", text: CONSULTA.buscandoDoc(doc, dominio), sinPie: true });
      const encontrado = await this.deps.seawhite.documentoVehiculo(doc, dominio);
      if (!encontrado) {
        await emit({ kind: "text", text: CONSULTA.docNoEncontrado(doc, dominio), sinPie: true });
        return "no_encontrado";
      }

      const v = await this.deps.verificador.verificar(encontrado.pdf, doc, dominio, encontrado.nombreArchivo);
      if (!v.ok) {
        await this.deps.fallas.registrar({
          tipo: "comprobante_no_coincide",
          severidad: "critica",
          descripcion: `${doc === "vtv" ? "VTV" : "Seguro"} de ${dominio} NO entregado: ${v.motivo ?? "no se pudo verificar"}`,
          dominio,
          conversationId: session.conversationId,
          telefono: session.phone,
          detalle: { documento: doc, ...v },
        });
        await emit({ kind: "text", text: CONSULTA.docNoVerificado(doc, dominio), sinPie: true });
        return "no_disponible";
      }
      // El canal espera que WhatsApp entregue el PDF antes de mandar lo siguiente.
      await emit({ kind: "file", filename: `${doc.toUpperCase()}_${dominio}.pdf`, data: encontrado.pdf, caption: CONSULTA.docCaption(doc, dominio) });
      return "enviado";
    } catch (err) {
      this.deps.logger.error({ err }, "No se pudo traer el comprobante del vehículo");
      await emit({ kind: "text", text: CONSULTA.docNoDisponible, sinPie: true });
      return "no_disponible";
    }
  }

  /** "¿Necesitás algo más?" con cómo seguir en cada rama. */
  private algoMas(emit: Emit, texto: string, botones: ButtonSpec[]): Promise<void> {
    return emit({ kind: "buttons", text: texto, buttons: botones });
  }
}
