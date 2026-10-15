/**
 * Flujo de CONSULTA (choferes y cualquier número que no sea cargador).
 *
 *   saludo -> DNI o patente (con o sin "¿puedo entrar a shell planta 2?")
 *     -> en qué plantas está habilitado + licencia, ART y F.931 (o seguro y VTV)
 *     -> "¿Necesitás el carnet?" [botones] -> se manda SU carnet en PDF
 *
 * Las plantas salen del registro propio (anelo_carnets): la API de SEA WHITE
 * pide cliente y planta para consultar, y el chofer no conoce esos códigos.
 * El vencimiento y el id del carnet se vuelven a pedir a SEA WHITE en cada
 * consulta: es la fuente de verdad.
 */
import { findDniInText, findPatenteInText } from "../domain/validators.js";
import type { Documentacion, TipoRegistro } from "../integrations/seawhite/types.js";
import type { Cliente } from "../storage/catalogo.js";
import type { CarnetRegistrado } from "../storage/registro.js";
import { todayInTimeZone } from "../utils/dates.js";
import { buttonTitle } from "../utils/text.js";
import { buscar, etiqueta, nombreCorto, resolver } from "./catalogo.js";
import type { BotDeps, Emit } from "./deps.js";
import { CONSULTA, respuestaConsulta, type LineaPlanta } from "./texts.js";
import type { ButtonSpec, CarnetConsultado, ConsultaState, IncomingMessage, Session } from "./types.js";

const NO_GRACIAS: ButtonSpec = { title: "No, gracias", payload: "fin" };
const OTRA: ButtonSpec = { title: "Otra consulta", payload: "otra" };
const ES_TODO: ButtonSpec = { title: "Eso es todo", payload: "fin" };

export class ConsultaFlow {
  constructor(private readonly deps: BotDeps) {}

  async handle(session: Session, msg: IncomingMessage, payload: string | undefined, emit: Emit): Promise<void> {
    const st: ConsultaState = (session.consulta ??= { saludado: false });
    const primerMensaje = !st.saludado;
    if (primerMensaje) {
      st.saludado = true;
      await emit({ kind: "text", text: CONSULTA.saludo(this.deps.botName) });
    }

    // Botones.
    if (payload?.startsWith("carnet:")) return this.enviarCarnet(st, Number(payload.slice(7)), emit);
    if (payload === "fin") {
      session.consulta = { saludado: false };
      return emit({ kind: "text", text: CONSULTA.despedida });
    }
    if (payload === "otra") return emit({ kind: "text", text: CONSULTA.otraConsulta });

    // Este número no recibe archivos (sólo los cargadores).
    if (msg.attachments.length > 0) {
      await emit({ kind: "text", text: CONSULTA.sinArchivos });
      if (!msg.text) return;
    }

    const clientes = await this.deps.catalogo.listar();
    const mencion = resolver(msg.text, clientes);
    const dni = findDniInText(msg.text);
    const patente = dni ? undefined : findPatenteInText(msg.text);

    if (!dni && !patente) {
      // ¿Eligió la planta del carnet escribiéndola? ("el de total")
      if (st.ultimos?.length && mencion.cliente) {
        const i = st.ultimos.findIndex((c) => c.clienteCodigo === mencion.cliente!.codigo && (!mencion.planta || c.plantaCodigo === mencion.planta.codigo));
        if (i >= 0) return this.enviarCarnet(st, i, emit);
      }
      if (mencion.cliente) {
        // "¿puedo entrar a shell planta 2?" sin DNI: se recuerda la planta y se pide el DNI.
        st.clienteCodigo = mencion.cliente.codigo;
        st.plantaCodigo = mencion.planta?.codigo;
        return emit({ kind: "text", text: CONSULTA.pedirDniPara(etiqueta(mencion.cliente, mencion.planta)) });
      }
      if (primerMensaje) return; // el saludo ya pide el DNI
      return emit({ kind: "text", text: CONSULTA.pedirDni });
    }

    const filtro = mencion.cliente ? { clienteCodigo: mencion.cliente.codigo, plantaCodigo: mencion.planta?.codigo } : { clienteCodigo: st.clienteCodigo, plantaCodigo: st.plantaCodigo };
    st.clienteCodigo = undefined;
    st.plantaCodigo = undefined;
    return this.consultar(st, dni ? "chofer" : "dominio", (dni ?? patente)!, filtro, clientes, emit);
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

    // SEA WHITE es la fuente de verdad: vencimiento e id actuales.
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

    if (carnets.length === 0) return emit({ kind: "buttons", text: texto, buttons: [OTRA, ES_TODO] });
    await emit({ kind: "text", text: texto });
    if (carnets.length === 1) {
      return emit({ kind: "buttons", text: CONSULTA.preguntaCarnet, buttons: [{ title: "📄 Sí, mandámelo", payload: "carnet:0" }, NO_GRACIAS] });
    }
    // Varias plantas: un botón por carnet (hasta 2 + "No, gracias"); si hay más, que escriba cuál.
    const botones = carnets.slice(0, 2).map((c, i) => ({ title: buttonTitle(this.tituloCarnet(c, clientes)), payload: `carnet:${i}` }));
    const texto2 = carnets.length > 2 ? `${CONSULTA.elegirCarnet}\nTambién podés escribir el cliente y la planta.` : CONSULTA.elegirCarnet;
    return emit({ kind: "buttons", text: texto2, buttons: [...botones, NO_GRACIAS] });
  }

  private tituloCarnet(c: CarnetConsultado, clientes: Cliente[]): string {
    const b = buscar(clientes, c.clienteCodigo, c.plantaCodigo);
    const cliente = b.cliente ? nombreCorto(b.cliente.nombre).split(" ")[0] : c.clienteCodigo;
    const planta = b.planta?.nombre.replace(/planta\s*/i, "P") ?? c.plantaCodigo;
    return `${cliente} ${planta}`;
  }

  /** Manda el carnet de la ÚLTIMA consulta (nunca otro DNI que el consultado). */
  private async enviarCarnet(st: ConsultaState, indice: number, emit: Emit): Promise<void> {
    const c = st.ultimos?.[indice];
    if (!c || c.seawhiteId === null) return emit({ kind: "text", text: CONSULTA.otraConsulta });
    try {
      const pdf = await this.deps.seawhite.descargarPdf(c.tipo, c.seawhiteId);
      await emit({ kind: "file", filename: `${c.identificador}.pdf`, data: pdf, caption: `📄 Carnet ${c.etiqueta}` });
    } catch (err) {
      this.deps.logger.error({ err }, "No se pudo traer el PDF del carnet");
      await emit({ kind: "text", text: CONSULTA.carnetNoDisponible });
    }
    return emit({ kind: "buttons", text: CONSULTA.algoMas, buttons: [OTRA, ES_TODO] });
  }
}
