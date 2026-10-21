/**
 * Flujo de CONSULTA (choferes y cualquier número que no sea cargador).
 *
 *   saludo con la imagen del bot -> MENÚ PRINCIPAL, dos ramas:
 *
 *   🪪 Habilitación  -> cliente y subcliente -> [Por DNI] [Por dominio] [Menú]
 *        DNI     -> credencial en esa planta + licencia/ART/F.931 -> ¿carnet?
 *        patente -> credencial en esa planta + seguro/VTV         -> ¿carnet?
 *        al terminar: [Menú 😊] vuelve al inicio (borra la planta),
 *        [🔎 Consulta] otro DNI o dominio en la MISMA planta, [Eso es todo].
 *
 *   📄 VTV y seguro  -> [VTV] [Seguro] [Menú] -> patente -> PDF -> ¿el otro también?
 *
 * La habilitación va por cliente + subcliente porque un mismo DNI o patente
 * puede estar cargado en varias plantas. VTV y seguro van sólo por dominio.
 */
import { findDniInText, findPatenteInText, normalizeDni, normalizePatente } from "../domain/validators.js";
import type { Documentacion, TipoRegistro } from "../integrations/seawhite/types.js";
import type { Cliente } from "../storage/catalogo.js";
import { todayInTimeZone } from "../utils/dates.js";
import { nombreCompleto } from "../utils/names.js";
import { normalizeText } from "../utils/text.js";
import { buscar, etiqueta, nombreCorto, resolverCliente, resolverPlanta } from "./catalogo.js";
import { BOTON_FIN, BOTON_MENU, PIE } from "./comandos.js";
import type { BotDeps, Emit } from "./deps.js";
import { pasoDestino } from "./pasoDestino.js";
import { CONSULTA, DESTINO, respuestaConsulta, type LineaPlanta } from "./texts.js";
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
/** Cierre de una consulta de habilitación: inicio, otra en la misma planta, o terminar. */
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
  if (/^(habilitacion|consulta habilitacion|credencial|vencimiento|vencimientos)$/.test(t)) return { rama: "habilitacion" };
  if (/^(vtv y seguro|consulta vtv y seguro|comprobantes)$/.test(t)) return { rama: "vehiculo" };
  if (/^(por dni|dni|chofer|choferes|persona)$/.test(t)) return { rama: "habilitacion", modo: "chofer" };
  if (/^(por dominio|dominio|patente|vehiculo|camion|unidad)$/.test(t)) return { rama: "habilitacion", modo: "dominio" };
  if (/^(vtv|consulta vtv)$/.test(t)) return { rama: "vehiculo", modo: "vtv" };
  if (/^(seguro|consulta seguro|poliza)$/.test(t)) return { rama: "vehiculo", modo: "seguro" };
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
      // Como Enri: foto del bot con el saludo (por el nombre si el teléfono está
      // en SEA WHITE). El canal espera la ENTREGA de la imagen antes de seguir.
      const nombre = await this.nombreDelContacto(session.phone);
      await emit({ kind: "image", caption: CONSULTA.saludo(this.deps.botName, nombre) });
    }

    // --- Botones y comandos ---
    if (payload === "menu") {
      // Vuelve al inicio: se olvidan DNI, dominio, cliente y subcliente.
      session.consulta = { saludado: true };
      return this.menuPrincipal(emit);
    }
    if (payload === "consulta") {
      // Otro DNI o dominio en la MISMA planta.
      st.rama = "habilitacion";
      st.modo = undefined;
      st.ultimos = undefined;
      return this.retomar(st, clientes, emit);
    }
    if (payload === "carnet") return this.enviarCarnet(st, emit);
    if (payload === "nocarnet") return this.algoMas(emit, CONSULTA.algoMas, FIN_CONSULTA);
    if (payload === "otrodoc") return this.enviarOtroDoc(session, st, emit);

    // Este número no recibe archivos (sólo los cargadores).
    if (msg.attachments.length > 0) {
      await emit({ kind: "text", text: CONSULTA.sinArchivos, sinPie: true });
      if (!msg.text.trim()) return this.retomar(st, clientes, emit);
    }

    const opcion = opcionDeBoton(payload) ?? opcionEscrita(msg.text);
    if (opcion) return this.ir(st, opcion, clientes, emit);

    // --- Menú principal: hasta elegir una rama no se toma nada más ---
    if (!st.rama) return this.menuPrincipal(emit);

    // --- Rama VTV y seguro ---
    if (st.rama === "vehiculo") {
      if (!st.modo) return this.retomar(st, clientes, emit);
      return this.pasoDocumento(session, st, st.modo as Doc, msg.text, emit);
    }

    // --- Rama habilitación: primero la planta ---
    const destino = buscar(clientes, st.clienteCodigo, st.plantaCodigo);
    if (!destino.cliente || !destino.planta) return this.pasoPlanta(st, msg, payload, clientes, emit);
    if (!st.modo) {
      const dni = findDniInText(msg.text);
      const patente = dni ? undefined : findPatenteInText(msg.text);
      if (dni || patente) {
        // DNI o patente escritos sin tocar [Por DNI] / [Por dominio]: se consulta igual.
        st.modo = dni ? "chofer" : "dominio";
        st.pendiente = { tipo: st.modo, identificador: (dni ?? patente)! };
      } else {
        // Puede estar cambiando de cliente o subcliente ("y en vista?"): se confirma como al principio.
        if (this.cambiaDestino(st, msg.text, clientes)) return this.otroDestino(st, msg, payload, clientes, emit);
        return this.retomar(st, clientes, emit);
      }
    }
    return this.pasoCredencial(st, st.modo as TipoRegistro, msg, payload, clientes, emit);
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

  /** Eligió una rama (y quizás una opción dentro de ella). */
  private ir(st: ConsultaState, opcion: Opcion, clientes: Cliente[], emit: Emit): Promise<void> {
    if (st.rama !== opcion.rama) {
      st.rama = opcion.rama;
      st.modo = undefined;
      st.pendiente = undefined;
      st.ultimos = undefined;
    }
    if (opcion.modo) return this.elegir(st, opcion.modo, clientes, emit);
    st.modo = undefined;
    return this.retomar(st, clientes, emit);
  }

  private elegir(st: ConsultaState, modo: Modo, clientes: Cliente[], emit: Emit): Promise<void> {
    st.pendiente = undefined;
    st.ultimos = undefined;
    st.ultimoDominio = undefined;
    st.otroOfrecido = undefined;
    if (modo === "vtv" || modo === "seguro") {
      st.modo = modo;
      return emit({ kind: "text", text: CONSULTA.pedirPatenteDoc(modo) });
    }
    // Habilitación: sin planta todavía, se pide primero (y después se muestran las opciones).
    const { cliente, planta } = buscar(clientes, st.clienteCodigo, st.plantaCodigo);
    if (!cliente || !planta) return this.retomar(st, clientes, emit);
    st.modo = modo;
    return this.pedirIdentificador(modo, etiqueta(cliente, planta), emit);
  }

  /** Repite la pregunta del paso en el que está (tras un aviso, con [🔎 Consulta], etc.). */
  private retomar(st: ConsultaState, clientes: Cliente[], emit: Emit): Promise<void> {
    if (!st.rama) return this.menuPrincipal(emit);
    if (st.rama === "vehiculo") {
      if (st.modo === "vtv" || st.modo === "seguro") return emit({ kind: "text", text: CONSULTA.pedirPatenteDoc(st.modo) });
      return emit({ kind: "buttons", text: CONSULTA.menuVehiculo, buttons: MENU_VEHICULO });
    }
    const { cliente, planta } = buscar(clientes, st.clienteCodigo, st.plantaCodigo);
    if (!cliente) return this.pedirCliente(st, emit);
    if (!planta) return this.pedirPlanta(st, cliente, emit);
    if (st.modo === "chofer" || st.modo === "dominio") return this.pedirIdentificador(st.modo, etiqueta(cliente, planta), emit);
    return this.menuHabilitacion(etiqueta(cliente, planta), emit);
  }

  private menuHabilitacion(destino: string, emit: Emit): Promise<void> {
    return emit({ kind: "buttons", text: CONSULTA.menuHabilitacion(destino), buttons: MENU_HABILITACION });
  }

  /** Habilitación, primer paso: cliente y subcliente (hasta tenerlos no se toma un DNI). */
  private async pasoPlanta(st: ConsultaState, msg: IncomingMessage, payload: string | undefined, clientes: Cliente[], emit: Emit): Promise<void> {
    const paso = pasoDestino(st, msg.text, payload, clientes, CONSULTA.pedirClienteSubcliente);
    if (!paso.listo) {
      for (const out of paso.salida) await emit(out);
      return;
    }
    return this.retomar(st, clientes, emit);
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
    if (!doc || !st.ultimoDominio) return this.retomar(st, [], emit);
    await this.enviarDoc(session, doc, st.ultimoDominio, emit);
    return this.algoMas(emit, CONSULTA.algoMasVehiculo, PIE);
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
    // Escribió otro cliente o subcliente: se confirma como al principio (y se sigue con el mismo DNI/dominio).
    if (this.cambiaDestino(st, msg.text, clientes)) return this.otroDestino(st, msg, payload, clientes, emit);
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

    if (!msg.text.trim()) return this.pedirIdentificador(modo, destino, emit);
    if (modo === "chofer") return emit({ kind: "text", text: CONSULTA.dniInvalido(normalizeDni(msg.text).error ?? "DNI inválido.") });
    return emit({ kind: "text", text: CONSULTA.patenteInvalida(normalizePatente(msg.text).error ?? "Patente inválida.") });
  }

  private pedirIdentificador(modo: TipoRegistro, destino: string, emit: Emit): Promise<void> {
    return emit({ kind: "text", text: modo === "chofer" ? CONSULTA.pedirDniPara(destino) : CONSULTA.pedirPatentePara(destino) });
  }

  /** ¿Escribió, en medio de la consulta, un cliente o subcliente distinto del elegido? ("y en vista planta 2?") */
  private cambiaDestino(st: ConsultaState, texto: string, clientes: Cliente[]): boolean {
    if (!texto.trim()) return false;
    const cliente = resolverCliente(texto, clientes);
    if (cliente && cliente.codigo !== st.clienteCodigo) return true;
    const actual = clientes.find((c) => c.codigo === st.clienteCodigo);
    const planta = actual ? resolverPlanta(texto, actual) : undefined;
    return planta !== undefined && planta.codigo !== st.plantaCodigo;
  }

  /** Otro cliente o subcliente: se suelta el actual y se pasa por la confirmación [Sí] [No]. */
  private otroDestino(st: ConsultaState, msg: IncomingMessage, payload: string | undefined, clientes: Cliente[], emit: Emit): Promise<void> {
    st.clienteCodigo = undefined;
    st.plantaCodigo = undefined;
    return this.pasoPlanta(st, msg, payload, clientes, emit);
  }

  private pedirCliente(st: ConsultaState, emit: Emit): Promise<void> {
    st.pidioPlanta = true;
    return emit({ kind: "text", text: CONSULTA.pedirClienteSubcliente });
  }

  private pedirPlanta(st: ConsultaState, cliente: Cliente, emit: Emit): Promise<void> {
    st.pidioPlanta = true;
    return emit({ kind: "text", text: DESTINO.elegirPlanta(nombreCorto(cliente.nombre)) });
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

    // La habilitación muestra sólo el ingreso a ESA planta (sin licencia/ART/F.931
    // ni seguro/VTV). La documentación general se consulta sólo para el nombre del chofer.
    if (tipo === "chofer" && !nombre) {
      try {
        const doc: Documentacion = await this.deps.seawhite.documentacion(tipo, identificador);
        if (doc.found && doc.tipo === "chofer") nombre = doc.nombre;
      } catch (err) {
        this.deps.logger.warn({ err }, "No se pudo consultar el nombre del chofer");
      }
    }

    const texto = respuestaConsulta({ tipo, identificador, nombre, plantas: linea ? [linea] : [], sinCredencialEn: linea ? undefined : destino, hoy });

    if (seawhiteId === null) return emit({ kind: "buttons", text: `${texto}\n\n${CONSULTA.algoMas}`, buttons: FIN_CONSULTA });
    st.ultimos = [{ tipo, identificador, clienteCodigo, plantaCodigo, etiqueta: destino, seawhiteId }];
    await emit({ kind: "text", text: texto, sinPie: true });
    return emit({ kind: "buttons", text: CONSULTA.preguntaCarnet, buttons: [{ title: "📄 Sí, pasámelo", payload: "carnet" }, { title: "No, gracias", payload: "nocarnet" }] });
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
    return this.algoMas(emit, CONSULTA.algoMas, FIN_CONSULTA);
  }

  /** "¿Necesitás algo más?" con cómo seguir en cada rama. */
  private algoMas(emit: Emit, texto: string, botones: ButtonSpec[]): Promise<void> {
    return emit({ kind: "buttons", text: texto, buttons: botones });
  }
}
