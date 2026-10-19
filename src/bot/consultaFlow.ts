/**
 * Flujo de CONSULTA (choferes y cualquier número que no sea cargador).
 *
 *   saludo cordial con la imagen del bot -> MENÚ PRINCIPAL:
 *     🪪 Por DNI      -> cliente y subcliente -> DNI     -> credencial + licencia/ART/F.931 -> ¿carnet?
 *     🚛 Por dominio  -> cliente y subcliente -> patente -> credencial + seguro/VTV        -> ¿carnet?
 *     📄 VTV          -> patente -> PDF de la VTV    -> ¿querés también el seguro?
 *     🛡️ Seguro       -> patente -> PDF del seguro   -> ¿querés también la VTV?
 *
 *   Al terminar: [Menú 😊] borra DNI, dominio, cliente y subcliente (para
 *   consultar otro), [🔎 Consulta] repite por DNI o dominio en la MISMA planta,
 *   [Eso es todo, gracias] cierra.
 *
 * La credencial va por cliente + subcliente porque un mismo DNI o patente
 * puede estar cargado en varias plantas. VTV y seguro van sólo por dominio.
 */
import { findDniInText, findPatenteInText, normalizeDni, normalizePatente } from "../domain/validators.js";
import type { Documentacion, TipoRegistro } from "../integrations/seawhite/types.js";
import type { Cliente } from "../storage/catalogo.js";
import { todayInTimeZone } from "../utils/dates.js";
import { buttonTitle, normalizeText } from "../utils/text.js";
import { buscar, etiqueta, nombreCorto, resolverCliente, resolverPlanta } from "./catalogo.js";
import { BOTON_FIN, BOTON_MENU, PIE } from "./comandos.js";
import type { BotDeps, Emit } from "./deps.js";
import { CONSULTA, respuestaConsulta, type LineaPlanta } from "./texts.js";
import type { ButtonSpec, ConsultaState, IncomingMessage, Session } from "./types.js";

type Modo = NonNullable<ConsultaState["modo"]>;
type Doc = "vtv" | "seguro";

/** Menú principal: 4 opciones + cerrar (WhatsApp lo muestra como lista). */
const MENU_PRINCIPAL: ButtonSpec[] = [
  { title: "🪪 Por DNI", payload: "m:chofer" },
  { title: "🚛 Por dominio", payload: "m:dominio" },
  { title: "📄 VTV", payload: "m:vtv" },
  { title: "🛡️ Seguro", payload: "m:seguro" },
  BOTON_FIN,
];
/** [🔎 Consulta]: otra credencial en la misma planta. */
const MENU_CREDENCIAL: ButtonSpec[] = [MENU_PRINCIPAL[0]!, MENU_PRINCIPAL[1]!, BOTON_FIN];
const BOTON_CONSULTA: ButtonSpec = { title: "🔎 Consulta", payload: "consulta" };
/** Cierre de una consulta de credencial: de cero, otra en la misma planta, o terminar. */
const FIN_CONSULTA: ButtonSpec[] = [BOTON_MENU, BOTON_CONSULTA, BOTON_FIN];

/** Opciones escritas en vez de tocar el botón. */
function opcionEscrita(texto: string): Modo | undefined {
  const t = normalizeText(texto);
  if (/^(por dni|dni|chofer|choferes|persona)$/.test(t)) return "chofer";
  if (/^(por dominio|dominio|patente|vehiculo|camion|unidad)$/.test(t)) return "dominio";
  if (/^(vtv|consulta vtv)$/.test(t)) return "vtv";
  if (/^(seguro|consulta seguro|poliza)$/.test(t)) return "seguro";
  return undefined;
}

const otroDoc = (d: Doc): Doc => (d === "vtv" ? "seguro" : "vtv");

export class ConsultaFlow {
  constructor(private readonly deps: BotDeps) {}

  async handle(session: Session, msg: IncomingMessage, payload: string | undefined, emit: Emit): Promise<void> {
    const st: ConsultaState = (session.consulta ??= { saludado: false });
    const clientes = await this.deps.catalogo.listar();
    const primerMensaje = !st.saludado;
    if (primerMensaje) {
      st.saludado = true;
      await emit({ kind: "image", caption: CONSULTA.saludo(this.deps.botName) });
    }

    // --- Botones y comandos ---
    if (payload === "menu") {
      // De cero: se olvidan DNI, dominio, cliente y subcliente.
      session.consulta = { saludado: true };
      return this.menuPrincipal(emit);
    }
    if (payload === "consulta") {
      // Otra credencial en la MISMA planta.
      st.modo = undefined;
      st.ultimos = undefined;
      const { cliente, planta } = buscar(clientes, st.clienteCodigo, st.plantaCodigo);
      if (cliente && planta) return emit({ kind: "buttons", text: CONSULTA.destinoOk(etiqueta(cliente, planta)), buttons: MENU_CREDENCIAL });
      return this.menuPrincipal(emit);
    }
    if (payload === "carnet") return this.enviarCarnet(st, emit);
    if (payload === "nocarnet") return this.algoMas(emit, FIN_CONSULTA);
    if (payload === "otrodoc") return this.enviarOtroDoc(session, st, emit);

    const elegido = payload?.startsWith("m:") ? (payload.slice(2) as Modo) : opcionEscrita(msg.text);
    if (elegido) return this.elegir(st, elegido, clientes, emit);

    // Este número no recibe archivos (sólo los cargadores).
    if (msg.attachments.length > 0) {
      await emit({ kind: "text", text: CONSULTA.sinArchivos, sinPie: true });
      if (!msg.text.trim()) return this.retomar(st, clientes, emit);
    }

    // --- Sin opción elegida: se deduce lo que se pueda o se muestra el menú ---
    if (!st.modo) {
      const dni = findDniInText(msg.text);
      const patente = dni ? undefined : findPatenteInText(msg.text);
      if (dni || patente) {
        // DNI o patente escritos de entrada: credencial (se piden cliente y subcliente si faltan).
        st.modo = dni ? "chofer" : "dominio";
        st.pendiente = { tipo: st.modo, identificador: (dni ?? patente)! };
      } else {
        // "¿puedo entrar a total planta 1?": se recuerda la planta para después.
        this.aplicarClienteSubcliente(st, msg.text, payload, clientes);
        return this.menuPrincipal(emit);
      }
    }

    if (st.modo === "vtv" || st.modo === "seguro") return this.pasoDocumento(session, st, st.modo, msg.text, emit);
    return this.pasoCredencial(st, st.modo, msg, payload, clientes, emit);
  }

  // --- Menú y elección -----------------------------------------------------------

  private menuPrincipal(emit: Emit): Promise<void> {
    return emit({ kind: "buttons", text: CONSULTA.menuPrincipal, buttons: MENU_PRINCIPAL });
  }

  private async elegir(st: ConsultaState, modo: Modo, clientes: Cliente[], emit: Emit): Promise<void> {
    st.modo = modo;
    st.pendiente = undefined;
    st.ultimos = undefined;
    st.ultimoDominio = undefined;
    st.otroOfrecido = undefined;
    if (modo === "vtv" || modo === "seguro") return emit({ kind: "text", text: CONSULTA.pedirPatenteDoc(modo) });
    const { cliente, planta } = buscar(clientes, st.clienteCodigo, st.plantaCodigo);
    if (cliente && planta) return this.pedirIdentificador(modo, etiqueta(cliente, planta), emit);
    if (cliente) return this.pedirPlanta(cliente, emit);
    return this.pedirCliente(clientes, emit);
  }

  /** Tras un aviso (p. ej. "no se reciben archivos"), retoma el paso en el que estaba. */
  private retomar(st: ConsultaState, clientes: Cliente[], emit: Emit): Promise<void> {
    if (!st.modo) return this.menuPrincipal(emit);
    if (st.modo === "vtv" || st.modo === "seguro") return emit({ kind: "text", text: CONSULTA.pedirPatenteDoc(st.modo) });
    return this.elegir(st, st.modo, clientes, emit);
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
    await this.enviarDoc(session, doc, patente, emit);
    // Se ofrece el otro comprobante del mismo vehículo.
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
    if (!doc || !st.ultimoDominio) return this.menuPrincipal(emit);
    await this.enviarDoc(session, doc, st.ultimoDominio, emit);
    return this.algoMas(emit, PIE);
  }

  /**
   * Trae el comprobante y lo entrega SÓLO si el resguardo confirma que la
   * patente pedida, la del nombre del archivo y la de adentro del PDF son la
   * misma. Si no, responde que no está disponible y registra una falla crítica.
   */
  private async enviarDoc(session: Session, doc: Doc, dominio: string, emit: Emit): Promise<void> {
    try {
      await emit({ kind: "text", text: CONSULTA.buscandoDoc(doc, dominio), sinPie: true });
      const encontrado = await this.deps.seawhite.documentoVehiculo(doc, dominio);
      if (!encontrado) return emit({ kind: "text", text: CONSULTA.docNoEncontrado(doc, dominio), sinPie: true });

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
        return emit({ kind: "text", text: CONSULTA.docNoVerificado(doc, dominio), sinPie: true });
      }
      // El canal espera que WhatsApp entregue el PDF antes de mandar lo siguiente.
      return emit({ kind: "file", filename: `${doc.toUpperCase()}_${dominio}.pdf`, data: encontrado.pdf, caption: CONSULTA.docCaption(doc, dominio) });
    } catch (err) {
      this.deps.logger.error({ err }, "No se pudo traer el comprobante del vehículo");
      return emit({ kind: "text", text: CONSULTA.docNoDisponible, sinPie: true });
    }
  }

  // --- Credencial de ingreso (por cliente y subcliente) -------------------------------

  private async pasoCredencial(st: ConsultaState, modo: TipoRegistro, msg: IncomingMessage, payload: string | undefined, clientes: Cliente[], emit: Emit): Promise<void> {
    const cambio = this.aplicarClienteSubcliente(st, msg.text, payload, clientes);
    const { cliente, planta } = buscar(clientes, st.clienteCodigo, st.plantaCodigo);

    if (!cliente || !planta) {
      // Mandó el DNI o la patente antes de la planta: se recuerda y se consulta después.
      const id = modo === "chofer" ? findDniInText(msg.text) : findPatenteInText(msg.text);
      if (id) st.pendiente = { tipo: modo, identificador: id };
    }
    if (!cliente) {
      const escribioOtraCosa = msg.text.trim() && !cambio.reconocio && !st.pendiente && !this.esSaludo(msg.text);
      if (escribioOtraCosa) await emit({ kind: "text", text: CONSULTA.clienteNoEncontrado(clientes.map((c) => nombreCorto(c.nombre))), sinPie: true });
      return this.pedirCliente(clientes, emit);
    }
    if (!planta) {
      if (cambio.subclienteInvalido) {
        await emit({ kind: "text", text: CONSULTA.plantaNoEncontrada(nombreCorto(cliente.nombre), cliente.plantas.map((p) => p.nombre)), sinPie: true });
      } else if (cliente.plantas.length === 1) {
        st.plantaCodigo = cliente.plantas[0]!.codigo;
      }
      if (!st.plantaCodigo) return this.pedirPlanta(cliente, emit);
    }
    const b = buscar(clientes, st.clienteCodigo, st.plantaCodigo);
    const destino = etiqueta(b.cliente, b.planta);

    // Había un DNI o una patente esperando a que eligiera la planta.
    if (st.pendiente) {
      const { tipo, identificador } = st.pendiente;
      st.pendiente = undefined;
      return this.consultar(st, tipo, identificador, destino, emit);
    }
    const id = modo === "chofer" ? findDniInText(msg.text) : findPatenteInText(msg.text);
    if (id) return this.consultar(st, modo, id, destino, emit);

    // Acaba de elegir la planta: se pide el DNI o la patente.
    if (cambio.reconocio || !msg.text.trim()) return this.pedirIdentificador(modo, destino, emit);
    if (modo === "chofer") return emit({ kind: "text", text: CONSULTA.dniInvalido(normalizeDni(msg.text).error ?? "DNI inválido.") });
    return emit({ kind: "text", text: CONSULTA.patenteInvalida(normalizePatente(msg.text).error ?? "Patente inválida.") });
  }

  private pedirIdentificador(modo: TipoRegistro, destino: string, emit: Emit): Promise<void> {
    return emit({ kind: "text", text: modo === "chofer" ? CONSULTA.pedirDniPara(destino) : CONSULTA.pedirPatentePara(destino) });
  }

  private esSaludo(texto: string): boolean {
    return /^(hola+|buenas|buen dia|buenos dias|buenas tardes|buenas noches|hey|que tal)\b/.test(normalizeText(texto));
  }

  /** Toma cliente/subcliente del botón o del texto ("total planta 1", "y en vista?"). */
  private aplicarClienteSubcliente(st: ConsultaState, texto: string, payload: string | undefined, clientes: Cliente[]): { reconocio: boolean; subclienteInvalido: boolean } {
    if (payload?.startsWith("cli:")) {
      st.clienteCodigo = payload.slice(4);
      st.plantaCodigo = undefined;
      return { reconocio: true, subclienteInvalido: false };
    }
    if (payload?.startsWith("pla:")) {
      st.plantaCodigo = payload.slice(4);
      return { reconocio: true, subclienteInvalido: false };
    }
    if (!texto.trim()) return { reconocio: false, subclienteInvalido: false };
    const cliente = resolverCliente(texto, clientes);
    if (cliente) {
      if (cliente.codigo !== st.clienteCodigo) st.plantaCodigo = undefined;
      st.clienteCodigo = cliente.codigo;
    }
    const actual = clientes.find((c) => c.codigo === st.clienteCodigo);
    const planta = actual ? resolverPlanta(texto, actual) : undefined;
    if (planta) st.plantaCodigo = planta.codigo;
    // Nombró el cliente y algo que parece un subcliente que no existe ("total planta 9").
    const subclienteInvalido = Boolean(cliente && !planta && /\b(planta|pta|pl|subcliente)\b|\bp\s*\d/.test(normalizeText(texto)));
    if (subclienteInvalido) st.plantaCodigo = undefined;
    return { reconocio: Boolean(cliente || planta), subclienteInvalido };
  }

  private pedirCliente(clientes: Cliente[], emit: Emit): Promise<void> {
    // Con pocos clientes, también se ofrecen como botones.
    if (clientes.length > 0 && clientes.length <= 3) {
      return emit({ kind: "buttons", text: CONSULTA.pedirClienteSubcliente, buttons: clientes.map((c) => ({ title: buttonTitle(nombreCorto(c.nombre)), payload: `cli:${c.codigo}` })) });
    }
    return emit({ kind: "text", text: CONSULTA.pedirClienteSubcliente });
  }

  private pedirPlanta(cliente: Cliente, emit: Emit): Promise<void> {
    const titulo = CONSULTA.elegirPlanta(nombreCorto(cliente.nombre));
    if (cliente.plantas.length <= 3) {
      return emit({ kind: "buttons", text: titulo, buttons: cliente.plantas.map((p) => ({ title: buttonTitle(p.nombre), payload: `pla:${p.codigo}` })) });
    }
    return emit({ kind: "text", text: `${titulo}\n${cliente.plantas.map((p) => `• ${p.nombre}`).join("\n")}` });
  }

  /** Consulta en el cliente y subcliente declarados; guarda el ID del carnet. */
  private async consultar(st: ConsultaState, tipo: TipoRegistro, identificador: string, destino: string, emit: Emit): Promise<void> {
    const hoy = todayInTimeZone(this.deps.timezone, this.deps.now());
    const clienteCodigo = st.clienteCodigo!;
    const plantaCodigo = st.plantaCodigo!;
    st.ultimos = undefined;

    let linea: LineaPlanta | undefined;
    let seawhiteId: number | null = null;
    let fallo = false;
    try {
      const c = await this.deps.seawhite.consultar(tipo, clienteCodigo, plantaCodigo, identificador);
      if (c.found) {
        linea = { destino, vencimiento: c.vencimiento, enSeaWhite: true, observaciones: null };
        seawhiteId = c.id;
      }
    } catch (err) {
      fallo = true;
      this.deps.logger.warn({ err }, "SEA WHITE no respondió la consulta de vencimiento");
    }

    // Datos propios del registro (nombre y observaciones del carnet), si existen.
    let nombre: string | null = null;
    try {
      const reg = (await this.deps.registro.buscarCarnets(tipo, identificador)).find((r) => r.clienteCodigo === clienteCodigo && r.plantaCodigo === plantaCodigo);
      nombre = reg?.apellidoNombre ?? null;
      if (linea && reg?.observaciones) linea.observaciones = reg.observaciones;
      if (fallo && reg) linea = { destino, vencimiento: reg.vencimiento, enSeaWhite: true, observaciones: reg.observaciones };
    } catch (err) {
      this.deps.logger.warn({ err }, "No se pudo leer el registro de carnets");
    }

    let documentacion: Documentacion | null = null;
    try {
      documentacion = await this.deps.seawhite.documentacion(tipo, identificador);
    } catch (err) {
      this.deps.logger.warn({ err }, "No se pudo consultar la documentación general");
    }
    nombre ??= documentacion?.found && documentacion.tipo === "chofer" ? documentacion.nombre : null;

    const texto = respuestaConsulta({ tipo, identificador, nombre, plantas: linea ? [linea] : [], sinCredencialEn: linea ? undefined : destino, documentacion, hoy });

    if (seawhiteId === null) return emit({ kind: "buttons", text: `${texto}\n\n${CONSULTA.algoMas}`, buttons: FIN_CONSULTA });
    st.ultimos = [{ tipo, identificador, clienteCodigo, plantaCodigo, etiqueta: destino, seawhiteId }];
    await emit({ kind: "text", text: texto, sinPie: true });
    return emit({ kind: "buttons", text: CONSULTA.preguntaCarnet, buttons: [{ title: "📄 Sí, pasámelo", payload: "carnet" }, { title: "No, gracias", payload: "nocarnet" }] });
  }

  /** Manda el carnet de la ÚLTIMA consulta, con el ID que vino en ella (nunca otro DNI). */
  private async enviarCarnet(st: ConsultaState, emit: Emit): Promise<void> {
    const c = st.ultimos?.[0];
    if (!c || c.seawhiteId === null) return this.algoMas(emit, FIN_CONSULTA);
    try {
      const pdf = await this.deps.seawhite.descargarPdf(c.tipo, c.seawhiteId);
      await emit({ kind: "file", filename: `${c.identificador}.pdf`, data: pdf, caption: `📄 Carnet – ${c.etiqueta}` });
    } catch (err) {
      this.deps.logger.error({ err }, "No se pudo traer el PDF del carnet");
      await emit({ kind: "text", text: CONSULTA.carnetNoDisponible, sinPie: true });
    }
    return this.algoMas(emit, FIN_CONSULTA);
  }

  /** "¿Necesitás algo más? Para consultar otro DNI o dominio, tocá Menú." */
  private algoMas(emit: Emit, botones: ButtonSpec[]): Promise<void> {
    return emit({ kind: "buttons", text: CONSULTA.algoMas, buttons: botones });
  }
}
