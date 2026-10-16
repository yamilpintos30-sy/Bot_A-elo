/**
 * Flujo de CONSULTA (choferes y cualquier número que no sea cargador).
 *
 *   saludo cordial con la imagen del bot
 *   -> "¿A qué planta vas?" -> cliente y subcliente, cotejados contra la tabla
 *   -> [Chofer] [Vehículo] -> DNI o patente
 *   -> vencimientos EN ESE cliente y subcliente (consulta GET a SEA WHITE, de la
 *      que se toma el ID del carnet) + licencia/ART/F.931 (o seguro/VTV)
 *   -> "¿Querés que te pase el carnet?" -> con ese ID se manda el PDF
 *   -> [Menú 😊] (de cero: pide cliente y subcliente)
 *      [🔎 Consulta] (otra consulta en el MISMO cliente y subcliente)
 *      [Eso es todo, gracias]
 *
 * El cliente y el subcliente van primero porque un mismo DNI o patente puede
 * estar cargado en varias plantas, y la API consulta por cliente + subcliente.
 */
import { findDniInText, findPatenteInText, normalizeDni, normalizePatente } from "../domain/validators.js";
import type { Documentacion, TipoRegistro } from "../integrations/seawhite/types.js";
import type { Cliente } from "../storage/catalogo.js";
import { todayInTimeZone } from "../utils/dates.js";
import { buttonTitle, normalizeText } from "../utils/text.js";
import { buscar, etiqueta, nombreCorto, resolverCliente, resolverPlanta } from "./catalogo.js";
import { BOTON_FIN, BOTON_MENU } from "./comandos.js";
import type { BotDeps, Emit } from "./deps.js";
import { CONSULTA, respuestaConsulta, type LineaPlanta } from "./texts.js";
import type { ButtonSpec, ConsultaState, IncomingMessage, Session } from "./types.js";

const MENU_TIPO: ButtonSpec[] = [{ title: "👤 Chofer", payload: "q:chofer" }, { title: "🚛 Vehículo", payload: "q:dominio" }, BOTON_FIN];
const BOTON_CONSULTA: ButtonSpec = { title: "🔎 Consulta", payload: "consulta" };
/** Cierre de cada consulta: de cero, otra en la misma planta, o terminar. */
const FIN_CONSULTA: ButtonSpec[] = [BOTON_MENU, BOTON_CONSULTA, BOTON_FIN];

/** "chofer", "dni", "vehiculo", "patente", "dominio" escritos en vez de tocar el botón. */
function opcionEscrita(texto: string): TipoRegistro | undefined {
  const t = normalizeText(texto);
  if (/^(chofer|choferes|dni|persona)$/.test(t)) return "chofer";
  if (/^(vehiculo|vehiculos|camion|patente|dominio|unidad)$/.test(t)) return "dominio";
  return undefined;
}

export class ConsultaFlow {
  constructor(private readonly deps: BotDeps) {}

  async handle(session: Session, msg: IncomingMessage, payload: string | undefined, emit: Emit): Promise<void> {
    const st: ConsultaState = (session.consulta ??= { saludado: false });
    const clientes = await this.deps.catalogo.listar();

    if (!st.saludado) {
      st.saludado = true;
      await emit({ kind: "image", caption: CONSULTA.saludo(this.deps.botName) });
    }

    // --- Botones globales del flujo ---
    if (payload === "menu") {
      // De cero: se olvida el cliente y el subcliente.
      session.consulta = { saludado: true };
      return this.pedirCliente(clientes, emit);
    }
    if (payload === "consulta") {
      st.esperando = undefined;
      st.ultimos = undefined;
      return this.conDestino(st, clientes, emit) ?? this.pedirCliente(clientes, emit);
    }
    if (payload === "carnet") return this.enviarCarnet(st, 0, emit);
    if (payload?.startsWith("carnet:")) return this.enviarCarnet(st, Number(payload.slice(7)), emit);
    if (payload === "nocarnet") return emit({ kind: "buttons", text: CONSULTA.algoMas, buttons: FIN_CONSULTA });

    // Este número no recibe archivos (sólo los cargadores).
    if (msg.attachments.length > 0) {
      await emit({ kind: "text", text: CONSULTA.sinArchivos, sinPie: true });
      if (!msg.text.trim()) return this.siguientePaso(st, clientes, emit);
    }

    // --- 1) Cliente y subcliente (siempre primero) ---
    const cambio = this.aplicarClienteSubcliente(st, msg.text, payload, clientes);
    const { cliente, planta } = buscar(clientes, st.clienteCodigo, st.plantaCodigo);
    if (!cliente || !planta) {
      // Mandó el DNI o la patente antes de la planta: se recuerda y se consulta después.
      const dniAntes = findDniInText(msg.text);
      const patenteAntes = dniAntes ? undefined : findPatenteInText(msg.text);
      if (dniAntes || patenteAntes) st.pendiente = { tipo: dniAntes ? "chofer" : "dominio", identificador: (dniAntes ?? patenteAntes)! };
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
    const destino = etiqueta(...this.par(clientes, st));

    // Había un DNI o una patente esperando a que eligiera la planta.
    if (st.pendiente) {
      const { tipo, identificador } = st.pendiente;
      st.pendiente = undefined;
      return this.consultar(st, tipo, identificador, destino, emit);
    }

    // --- 2) Chofer o vehículo ---
    const opcion = payload?.startsWith("q:") ? (payload.slice(2) as TipoRegistro) : opcionEscrita(msg.text);
    if (opcion) {
      st.esperando = opcion;
      return emit({ kind: "text", text: opcion === "chofer" ? CONSULTA.pedirDni : CONSULTA.pedirPatente });
    }

    // --- 3) DNI o patente -> consulta en el cliente y subcliente declarados ---
    const dni = st.esperando !== "dominio" ? findDniInText(msg.text) : undefined;
    const patente = !dni && st.esperando !== "chofer" ? findPatenteInText(msg.text) : undefined;
    if (dni || patente) {
      st.esperando = undefined;
      return this.consultar(st, dni ? "chofer" : "dominio", (dni ?? patente)!, destino, emit);
    }

    // Acaba de elegir (o cambiar) la planta: se ofrece qué consultar.
    if (cambio.reconocio) return emit({ kind: "buttons", text: CONSULTA.destinoOk(destino), buttons: MENU_TIPO });
    // Esperaba un DNI o una patente y lo que llegó no lo es.
    if (st.esperando === "chofer" && msg.text.trim()) return emit({ kind: "text", text: CONSULTA.dniInvalido(normalizeDni(msg.text).error ?? "DNI inválido.") });
    if (st.esperando === "dominio" && msg.text.trim()) return emit({ kind: "text", text: CONSULTA.patenteInvalida(normalizePatente(msg.text).error ?? "Patente inválida.") });
    return emit({ kind: "buttons", text: CONSULTA.destinoOk(destino), buttons: MENU_TIPO });
  }

  private par(clientes: Cliente[], st: ConsultaState) {
    const b = buscar(clientes, st.clienteCodigo, st.plantaCodigo);
    return [b.cliente, b.planta] as const;
  }

  private esSaludo(texto: string): boolean {
    return /^(hola+|buenas|buen dia|buenos dias|buenas tardes|buenas noches|hey|que tal)\b/.test(normalizeText(texto));
  }

  /**
   * Toma cliente/subcliente del botón o del texto (se puede cambiar en
   * cualquier momento escribiendo otro: "y en vista planta 1?").
   */
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

  /** Si ya hay cliente y subcliente, ofrece [Chofer] [Vehículo]; si no, undefined. */
  private conDestino(st: ConsultaState, clientes: Cliente[], emit: Emit): Promise<void> | undefined {
    const { cliente, planta } = buscar(clientes, st.clienteCodigo, st.plantaCodigo);
    if (!cliente || !planta) return undefined;
    return emit({ kind: "buttons", text: CONSULTA.destinoOk(etiqueta(cliente, planta)), buttons: MENU_TIPO });
  }

  /** Tras un aviso (p. ej. "no se reciben archivos"), retoma el paso en el que estaba. */
  private siguientePaso(st: ConsultaState, clientes: Cliente[], emit: Emit): Promise<void> {
    if (st.esperando) return emit({ kind: "text", text: st.esperando === "chofer" ? CONSULTA.pedirDni : CONSULTA.pedirPatente });
    return this.conDestino(st, clientes, emit) ?? this.pedirCliente(clientes, emit);
  }

  private pedirCliente(clientes: Cliente[], emit: Emit): Promise<void> {
    // Con pocos clientes, también se ofrecen como botones.
    if (clientes.length > 0 && clientes.length <= 3) {
      return emit({
        kind: "buttons",
        text: CONSULTA.pedirClienteSubcliente,
        buttons: clientes.map((c) => ({ title: buttonTitle(nombreCorto(c.nombre)), payload: `cli:${c.codigo}` })),
      });
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
      // Sin respuesta de SEA WHITE: se muestra lo registrado, avisando.
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

    const texto = respuestaConsulta({
      tipo,
      identificador,
      nombre,
      plantas: linea ? [linea] : [],
      sinCredencialEn: linea ? undefined : destino,
      documentacion,
      hoy,
    });

    if (seawhiteId === null) {
      return emit({ kind: "buttons", text: `${texto}\n\n${CONSULTA.algoMas}`, buttons: FIN_CONSULTA });
    }
    st.ultimos = [{ tipo, identificador, clienteCodigo, plantaCodigo, etiqueta: destino, seawhiteId }];
    await emit({ kind: "text", text: texto, sinPie: true });
    return emit({ kind: "buttons", text: CONSULTA.preguntaCarnet, buttons: [{ title: "📄 Sí, pasámelo", payload: "carnet" }, { title: "No, gracias", payload: "nocarnet" }] });
  }

  /** Manda el carnet de la ÚLTIMA consulta, con el ID que vino en ella (nunca otro DNI). */
  private async enviarCarnet(st: ConsultaState, indice: number, emit: Emit): Promise<void> {
    const c = st.ultimos?.[indice];
    if (!c || c.seawhiteId === null) return emit({ kind: "buttons", text: CONSULTA.algoMas, buttons: FIN_CONSULTA });
    try {
      const pdf = await this.deps.seawhite.descargarPdf(c.tipo, c.seawhiteId);
      // El canal espera que WhatsApp entregue el PDF antes de mandar lo siguiente.
      await emit({ kind: "file", filename: `${c.identificador}.pdf`, data: pdf, caption: `📄 Carnet – ${c.etiqueta}` });
    } catch (err) {
      this.deps.logger.error({ err }, "No se pudo traer el PDF del carnet");
      await emit({ kind: "text", text: CONSULTA.carnetNoDisponible, sinPie: true });
    }
    return emit({ kind: "buttons", text: CONSULTA.algoMas, buttons: FIN_CONSULTA });
  }
}
