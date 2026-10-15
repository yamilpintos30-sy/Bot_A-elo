/**
 * Flujo de CONSULTA (choferes y cualquier número que no sea cargador).
 *
 *   saludo cordial con la imagen del bot + menú [Chofer] [Vehículo]
 *   -> Chofer: pide el DNI   |  Vehículo: pide la patente
 *   -> vencimientos: plantas donde está habilitado + licencia/ART/F.931 (o seguro/VTV)
 *      (de la consulta a SEA WHITE se guarda el ID del carnet de cada planta)
 *   -> "¿Querés que te pase el carnet?" -> con ese ID se pide el PDF y se envía
 *
 * Atajo: si escribe directamente un DNI o una patente, se consulta sin pasar por el menú.
 */
import { findDniInText, findPatenteInText, normalizeDni, normalizePatente } from "../domain/validators.js";
import type { Documentacion, TipoRegistro } from "../integrations/seawhite/types.js";
import type { Cliente } from "../storage/catalogo.js";
import type { CarnetRegistrado } from "../storage/registro.js";
import { todayInTimeZone } from "../utils/dates.js";
import { buttonTitle, normalizeText } from "../utils/text.js";
import { buscar, etiqueta, nombreCorto, resolver } from "./catalogo.js";
import { BOTON_FIN, BOTON_MENU } from "./comandos.js";
import type { BotDeps, Emit } from "./deps.js";
import { CONSULTA, respuestaConsulta, type LineaPlanta } from "./texts.js";
import type { ButtonSpec, CarnetConsultado, ConsultaState, IncomingMessage, Session } from "./types.js";

const MENU: ButtonSpec[] = [{ title: "👤 Chofer", payload: "q:chofer" }, { title: "🚛 Vehículo", payload: "q:dominio" }, BOTON_FIN];

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

    // Atajo: DNI o patente escritos directamente (o según lo que eligió en el menú).
    const dni = st.esperando !== "dominio" ? findDniInText(msg.text) : undefined;
    const patente = !dni && st.esperando !== "chofer" ? findPatenteInText(msg.text) : undefined;
    const mencion = resolver(msg.text, clientes);

    if (!st.saludado) {
      st.saludado = true;
      await emit({ kind: "image", caption: CONSULTA.saludo(this.deps.botName) });
      if (!dni && !patente) {
        if (msg.attachments.length > 0) await emit({ kind: "text", text: CONSULTA.sinArchivos });
        if (mencion.cliente) this.recordarPlanta(st, mencion.cliente.codigo, mencion.planta?.codigo);
        return this.menu(emit);
      }
    }

    // Botones.
    if (payload?.startsWith("carnet:")) return this.enviarCarnet(st, Number(payload.slice(7)), emit);
    if (payload === "menu") {
      st.esperando = undefined;
      return this.menu(emit);
    }
    const opcion = payload?.startsWith("q:") ? (payload.slice(2) as TipoRegistro) : opcionEscrita(msg.text);
    if (opcion) {
      st.esperando = opcion;
      return emit({ kind: "text", text: opcion === "chofer" ? CONSULTA.pedirDni : CONSULTA.pedirPatente });
    }

    // Este número no recibe archivos (sólo los cargadores).
    if (msg.attachments.length > 0) {
      await emit({ kind: "text", text: CONSULTA.sinArchivos });
      if (!dni && !patente) return this.menu(emit);
    }

    if (dni || patente) {
      const filtro = mencion.cliente ? { clienteCodigo: mencion.cliente.codigo, plantaCodigo: mencion.planta?.codigo } : { clienteCodigo: st.clienteCodigo, plantaCodigo: st.plantaCodigo };
      st.esperando = undefined;
      st.clienteCodigo = undefined;
      st.plantaCodigo = undefined;
      return this.consultar(st, dni ? "chofer" : "dominio", (dni ?? patente)!, filtro, clientes, emit);
    }

    // ¿Eligió el carnet escribiendo la planta? ("el de total")
    if (st.ultimos?.length && mencion.cliente) {
      const i = st.ultimos.findIndex((c) => c.clienteCodigo === mencion.cliente!.codigo && (!mencion.planta || c.plantaCodigo === mencion.planta.codigo));
      if (i >= 0) return this.enviarCarnet(st, i, emit);
    }
    // "¿puedo entrar a shell planta 2?" sin DNI: se recuerda la planta.
    if (mencion.cliente) {
      this.recordarPlanta(st, mencion.cliente.codigo, mencion.planta?.codigo);
      if (st.esperando) return emit({ kind: "text", text: st.esperando === "chofer" ? CONSULTA.pedirDni : CONSULTA.pedirPatente });
      return emit({ kind: "buttons", text: CONSULTA.pedirDatoPara(etiqueta(mencion.cliente, mencion.planta)), buttons: MENU });
    }
    // Estaba esperando un DNI o una patente y lo que llegó no lo es.
    if (st.esperando === "chofer" && msg.text.trim()) return emit({ kind: "text", text: CONSULTA.dniInvalido(normalizeDni(msg.text).error ?? "DNI inválido.") });
    if (st.esperando === "dominio" && msg.text.trim()) return emit({ kind: "text", text: CONSULTA.patenteInvalida(normalizePatente(msg.text).error ?? "Patente inválida.") });
    return this.menu(emit);
  }

  private menu(emit: Emit): Promise<void> {
    return emit({ kind: "buttons", text: CONSULTA.menu, buttons: MENU });
  }

  private recordarPlanta(st: ConsultaState, clienteCodigo: string, plantaCodigo?: string): void {
    st.clienteCodigo = clienteCodigo;
    st.plantaCodigo = plantaCodigo;
  }

  private async consultar(
    st: ConsultaState,
    tipo: TipoRegistro,
    identificador: string,
    filtro: { clienteCodigo?: string; plantaCodigo?: string },
    clientes: Cliente[],
    emit: Emit,
  ): Promise<void> {
    const hoy = todayInTimeZone(this.deps.timezone, this.deps.now());
    let registrados: CarnetRegistrado[] = [];
    try {
      registrados = await this.deps.registro.buscarCarnets(tipo, identificador);
    } catch (err) {
      this.deps.logger.error({ err }, "No se pudo leer el registro de carnets");
    }

    // Si preguntó por una planta, sólo esa (y se avisa si no está).
    let sinCredencialEn: string | undefined;
    if (filtro.clienteCodigo) {
      const coinciden = registrados.filter((r) => r.clienteCodigo === filtro.clienteCodigo && (!filtro.plantaCodigo || r.plantaCodigo === filtro.plantaCodigo));
      if (coinciden.length === 0) {
        const b = buscar(clientes, filtro.clienteCodigo, filtro.plantaCodigo);
        sinCredencialEn = filtro.plantaCodigo ? etiqueta(b.cliente, b.planta) : (b.cliente?.nombre ?? filtro.clienteCodigo);
      } else registrados = coinciden;
    }

    // Vencimientos desde SEA WHITE; de esa misma respuesta se toma el ID del
    // carnet, que después se usa para pedir el PDF.
    const plantas: LineaPlanta[] = [];
    const carnets: CarnetConsultado[] = [];
    for (const r of registrados) {
      const b = buscar(clientes, r.clienteCodigo, r.plantaCodigo);
      const destino = etiqueta(b.cliente, b.planta, r.clienteCodigo, r.plantaCodigo);
      let vencimiento: string | null = r.vencimiento;
      let seawhiteId: number | null = r.seawhiteId;
      let enSeaWhite = true;
      try {
        const c = await this.deps.seawhite.consultar(tipo, r.clienteCodigo, r.plantaCodigo, identificador);
        if (c.found) {
          vencimiento = c.vencimiento;
          seawhiteId = c.id;
        } else enSeaWhite = false;
      } catch (err) {
        // Sin SEA WHITE se muestra lo registrado (degrada, pero responde).
        this.deps.logger.warn({ err }, "SEA WHITE no respondió la consulta; se usa el registro propio");
      }
      plantas.push({ destino, vencimiento, enSeaWhite, observaciones: r.observaciones });
      if (enSeaWhite && seawhiteId !== null) {
        carnets.push({ tipo, identificador, clienteCodigo: r.clienteCodigo, plantaCodigo: r.plantaCodigo, etiqueta: destino, seawhiteId });
      }
    }

    let documentacion: Documentacion | null = null;
    try {
      documentacion = await this.deps.seawhite.documentacion(tipo, identificador);
    } catch (err) {
      this.deps.logger.warn({ err }, "No se pudo consultar la documentación general");
    }

    const nombre = registrados.find((r) => r.apellidoNombre)?.apellidoNombre ?? (documentacion?.found && documentacion.tipo === "chofer" ? documentacion.nombre : null);
    const texto = respuestaConsulta({ tipo, identificador, nombre, plantas, sinCredencialEn, documentacion, hoy });
    st.ultimos = carnets;

    // Sin carnet para ofrecer: la respuesta cierra con [Menú] [Eso es todo] (pie automático).
    if (carnets.length === 0) return emit({ kind: "text", text: `${texto}\n\n${CONSULTA.algoMas}` });
    await emit({ kind: "text", text: texto, sinPie: true });
    if (carnets.length === 1) {
      return emit({ kind: "buttons", text: CONSULTA.preguntaCarnet, buttons: [{ title: "📄 Sí, pasámelo", payload: "carnet:0" }, BOTON_MENU, BOTON_FIN] });
    }
    // Varias plantas: un botón por carnet (hasta 2 + "No, gracias"); si hay más, que escriba cuál.
    const botones = carnets.slice(0, 2).map((c, i) => ({ title: buttonTitle(this.tituloCarnet(c, clientes)), payload: `carnet:${i}` }));
    const pregunta = carnets.length > 2 ? `${CONSULTA.elegirCarnet}\nTambién podés escribir el cliente y la planta.` : CONSULTA.elegirCarnet;
    return emit({ kind: "buttons", text: pregunta, buttons: [...botones, BOTON_FIN] });
  }

  private tituloCarnet(c: CarnetConsultado, clientes: Cliente[]): string {
    const b = buscar(clientes, c.clienteCodigo, c.plantaCodigo);
    const cliente = b.cliente ? nombreCorto(b.cliente.nombre).split(" ")[0] : c.clienteCodigo;
    const planta = b.planta?.nombre.replace(/planta\s*/i, "P") ?? c.plantaCodigo;
    return `${cliente} ${planta}`;
  }

  /** Manda el carnet de la ÚLTIMA consulta, con el ID que vino en ella (nunca otro DNI). */
  private async enviarCarnet(st: ConsultaState, indice: number, emit: Emit): Promise<void> {
    const c = st.ultimos?.[indice];
    if (!c || c.seawhiteId === null) return this.menu(emit);
    try {
      const pdf = await this.deps.seawhite.descargarPdf(c.tipo, c.seawhiteId);
      await emit({ kind: "file", filename: `${c.identificador}.pdf`, data: pdf, caption: `📄 Carnet ${c.etiqueta}` });
    } catch (err) {
      this.deps.logger.error({ err }, "No se pudo traer el PDF del carnet");
      await emit({ kind: "text", text: CONSULTA.carnetNoDisponible });
    }
    return emit({ kind: "text", text: CONSULTA.algoMas });
  }
}
