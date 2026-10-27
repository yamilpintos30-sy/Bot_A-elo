/**
 * Motor del bot: decide qué flujo atiende cada mensaje y guarda la sesión.
 *
 *   - El rol se decide EN CADA MENSAJE con las listas del panel: cargadores
 *     (cargan) y consultores (consultan). App cerrada: a un número que no está
 *     en ninguna no se le responde. Un .txt nuevo rige desde el mensaje siguiente.
 *   - Los botones de WhatsApp vuelven como texto con su TÍTULO: se traducen a
 *     su payload con los botones de la última respuesta (todos sus mensajes).
 *   - Como en Enri: toda respuesta cierra con [🏠 Menú principal] [Eso es todo, gracias];
 *     "Eso es todo" despide y cierra; un "gracias" suelto después del cierre no
 *     reabre la conversación.
 *   - Si una persona tomó la conversación (handoff), el bot no responde.
 */
import { normalizeText } from "../utils/text.js";
import { CargadorFlow } from "./cargadorFlow.js";
import { detectarComando, esHolaLogistica, esSoloCortesia, PIE } from "./comandos.js";
import { ConsultaFlow } from "./consultaFlow.js";
import type { BotDeps } from "./deps.js";
import { DESPEDIDA, NO_HABILITADO, PASAR_A_LOGISTICA } from "./texts.js";
import type { IncomingMessage, Outbound, Perfil, Session } from "./types.js";

/** Canal de salida (Chatwoot en producción; un array en los tests). */
export interface Channel {
  send(conversationId: string, out: Outbound): Promise<void>;
}

/** Inactividad tras la cual la conversación arranca de cero. */
const SESSION_TTL_MS = 60 * 60_000;
/**
 * Cierre por inactividad (cargadores): sólo se despiden las sesiones que
 * vencieron hace menos de esto. Si el bot estuvo apagado más tiempo, las más
 * viejas no reciben una despedida tardía (igual arrancan de cero).
 */
const VENTANA_CIERRE_MS = 30 * 60_000;
/** Durante cuánto tiempo tras el cierre un "gracias" suelto no reabre la conversación. */
const CORTESIA_TRAS_CIERRE_MS = 2 * 60 * 60_000;
/**
 * Un texto se retiene este tiempo por si es el ÚLTIMO de la respuesta (entonces
 * sale con los botones de pie, en el mismo mensaje). Si llega otro mensaje o
 * pasa el plazo (p. ej. "Recibí el PDF" antes de 2 minutos de proceso), sale solo.
 */
const RETENCION_MS = 1500;

export class BotEngine {
  private readonly cargador: CargadorFlow;
  private readonly consulta: ConsultaFlow;
  private readonly cerradas = new Map<string, number>();

  constructor(
    private readonly deps: BotDeps,
    private readonly channel: Channel,
    private readonly handoffMinutes = 120,
  ) {
    this.cargador = new CargadorFlow(deps);
    this.consulta = new ConsultaFlow(deps);
  }

  async handle(msg: IncomingMessage): Promise<void> {
    const { deps } = this;
    const now = deps.now();
    const saved = await deps.sessions.get(msg.conversationId).catch((err) => {
      deps.logger.error({ err }, "No se pudo leer la sesión; se arranca una nueva");
      return null;
    });

    // "Gracias" / "ok" / 👍 en respuesta a la despedida: silencio (como Enri).
    const cerrada = this.cerradas.get(msg.conversationId);
    if (!saved && cerrada !== undefined && now.getTime() - cerrada <= CORTESIA_TRAS_CIERRE_MS && msg.attachments.length === 0 && esSoloCortesia(msg.text)) {
      deps.logger.info({ conversationId: msg.conversationId }, "Cortesía tras el cierre: no se reabre la conversación");
      return;
    }
    this.cerradas.delete(msg.conversationId);

    const session = this.prepararSesion(saved, msg, now);
    if (session.handedOffUntil && new Date(session.handedOffUntil) > now) {
      deps.logger.info({ conversationId: msg.conversationId }, "Conversación atendida por una persona: el bot no responde");
      return;
    }

    const esCargador = await deps.cargadores.contiene(msg.phone).catch((err) => {
      deps.logger.error({ err }, "No se pudo leer la lista de cargadores");
      return false;
    });
    // App cerrada: si no carga ni está en la lista de los que pueden consultar, se
    // le avisa UNA vez que no está habilitado y después no se le responde más.
    // Si la lista no se puede leer, silencio (no se le dice "no habilitado" a
    // alguien que quizás sí lo está).
    // Si está en más de una lista gana la más completa: carga > logística > choferes.
    let perfil: Perfil = "chofer";
    if (!esCargador) {
      // Si la lista de logística no se puede leer (p. ej. falta la tabla), se sigue
      // con la de choferes: no puede dejar sin respuesta a los choferes.
      const esLogistica = await deps.logistica.contiene(msg.phone).catch((err) => {
        deps.logger.error({ err }, "No se pudo leer la lista de logística");
        return null;
      });
      if (esLogistica) perfil = "logistica";
      else {
        const puedeConsultar = await deps.consultores.contiene(msg.phone).catch((err) => {
          deps.logger.error({ err }, "No se pudo leer la lista de consultores; por seguridad no se responde");
          return null;
        });
        if (puedeConsultar === null) return;
        // Sin poder leer logística, no se le dice "no habilitado" a alguien que quizás lo está.
        if (!puedeConsultar) return esLogistica === null ? undefined : this.noHabilitado(session, msg);
      }
    }
    session.avisoNoHabilitado = undefined;

    // Cargador que escribe "hola logística": entra al menú de logística y sigue ahí
    // hasta "Eso es todo, gracias". Con una carga abierta, primero tiene que cerrarla.
    let forzarMenu = false;
    if (!esCargador) session.modoLogistica = undefined;
    else if (!session.modoLogistica && msg.attachments.length === 0 && esHolaLogistica(msg.text)) {
      if (session.cargador) {
        const salida = this.salida(msg.conversationId, session);
        session.botones = [];
        await salida.emit({ kind: "text", text: PASAR_A_LOGISTICA });
        await salida.terminar();
        session.updatedAt = deps.now().toISOString();
        await deps.sessions.save(session).catch((err) => deps.logger.error({ err }, "No se pudo guardar la sesión"));
        return;
      }
      session.modoLogistica = true;
      session.consulta = undefined;
      forzarMenu = true;
    }
    const comoCargador = esCargador && !session.modoLogistica;
    if (esCargador && session.modoLogistica) perfil = "logistica";
    session.rol = comoCargador ? "cargador" : "consulta";
    session.perfil = comoCargador ? undefined : perfil;

    // Varios toques que llegaron juntos (WhatsApp/Chatwoot los demoró y el buffer los
    // unió en un texto de varios renglones): vale el ÚLTIMO, como si se hubiera tocado solo.
    if (msg.attachments.length === 0) {
      const ultimo = this.ultimoToque(session, msg.text);
      if (ultimo !== undefined) msg = { ...msg, text: ultimo };
    }
    const payload = forzarMenu ? "menu" : (this.payloadDeBoton(session, msg.text) ?? (msg.attachments.length === 0 ? detectarComando(msg.text) : undefined));
    session.botones = [];
    void deps.log.log({ conversationId: msg.conversationId, phone: session.phone, direction: "in", rol: session.rol, content: msg.text, meta: { attachments: msg.attachments.length, payload } });

    const salida = this.salida(msg.conversationId, session);
    try {
      if (payload === "fin") return await this.cerrar(session, salida.emit);
      if (session.rol === "cargador") await this.cargador.handle(session, msg, payload, salida.emit);
      else await this.consulta.handle(session, msg, payload, salida.emit);
    } finally {
      await salida.terminar();
      if (this.cerradas.has(msg.conversationId)) {
        await deps.sessions.delete(msg.conversationId).catch((err) => deps.logger.error({ err }, "No se pudo borrar la sesión"));
      } else {
        session.updatedAt = deps.now().toISOString();
        await deps.sessions.save(session).catch((err) => deps.logger.error({ err }, "No se pudo guardar la sesión"));
      }
    }
  }

  /** Número no habilitado: el aviso una sola vez (queda marcado en la sesión) y después silencio. */
  private async noHabilitado(session: Session, msg: IncomingMessage): Promise<void> {
    if (session.avisoNoHabilitado) {
      this.deps.logger.info({ conversationId: msg.conversationId }, "Número no habilitado (ya avisado): no se responde");
      return;
    }
    this.deps.logger.info({ conversationId: msg.conversationId }, "Número no habilitado: se manda el aviso una única vez");
    session.avisoNoHabilitado = true;
    const salida = this.salida(msg.conversationId, session);
    await salida.emit({ kind: "text", text: NO_HABILITADO, sinPie: true });
    await salida.terminar();
    session.updatedAt = this.deps.now().toISOString();
    await this.deps.sessions.save(session).catch((err) => this.deps.logger.error({ err }, "No se pudo guardar la sesión"));
  }

  /** "Eso es todo, gracias": despedida y conversación cerrada (la próxima arranca de cero). */
  private async cerrar(session: Session, emit: (o: Outbound) => Promise<void>): Promise<void> {
    let texto = session.rol === "cargador" ? DESPEDIDA.cargador : DESPEDIDA.consulta;
    if (session.cargador?.loteId) {
      const lote = this.deps.lotes.obtener(session.cargador.loteId);
      this.deps.lotes.borrar(session.cargador.loteId);
      await this.cargador.cerrarRegistro(lote?.cargaId ?? session.cargador.cargaId, "cancelada", lote?.resultado.costoUsd ?? null);
      texto = DESPEDIDA.cargaCancelada;
    }
    this.cerradas.set(session.conversationId, this.deps.now().getTime());
    await emit({ kind: "text", text: texto, sinPie: true });
  }

  /**
   * Salida con botones de pie: el último texto de la respuesta se manda junto
   * con [🏠 Menú principal] [Eso es todo, gracias], en el mismo mensaje.
   */
  private salida(conversationId: string, session: Session) {
    let retenido: Extract<Outbound, { kind: "text" }> | null = null;
    let timer: NodeJS.Timeout | null = null;
    let cadena = Promise.resolve();

    const enviar = (out: Outbound) => {
      // Se acumulan: con dos mensajes con botones en la misma respuesta, valen los de ambos.
      if (out.kind === "buttons") session.botones = [...session.botones, ...out.buttons];
      cadena = cadena.then(async () => {
        await this.channel.send(conversationId, out);
        const content = out.kind === "file" ? `[archivo] ${out.filename}` : out.kind === "image" ? `[imagen] ${out.caption}` : out.text;
        void this.deps.log.log({ conversationId, phone: session.phone, direction: "out", rol: session.rol, content });
      });
      return cadena;
    };
    const soltar = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      const r = retenido;
      retenido = null;
      return r ? enviar(r) : cadena;
    };

    return {
      emit: async (out: Outbound) => {
        await soltar();
        if (out.kind === "text" && !out.sinPie) {
          retenido = out;
          timer = setTimeout(() => void soltar().catch(() => undefined), RETENCION_MS);
          return;
        }
        await enviar(out);
      },
      terminar: async () => {
        if (timer) clearTimeout(timer);
        timer = null;
        const r = retenido;
        retenido = null;
        if (r) await enviar({ kind: "buttons", text: r.text, buttons: PIE });
        await cadena;
      },
    };
  }

  /** Una persona respondió desde Chatwoot o desde el celular: el bot se calla un rato. */
  async markHandedOff(conversationId: string): Promise<void> {
    const session = (await this.deps.sessions.get(conversationId)) ?? this.newSession(conversationId, null);
    session.handedOffUntil = new Date(this.deps.now().getTime() + this.handoffMinutes * 60_000).toISOString();
    session.updatedAt = this.deps.now().toISOString();
    await this.deps.sessions.save(session);
  }

  /** Conversación resuelta en Chatwoot: el próximo mensaje arranca de cero. */
  /**
   * Cargadores con 1 hora sin actividad: se cierra la sesión (cliente libre para
   * la próxima carga), se cancela la carga pendiente y se despide. Al volver a
   * escribir arranca de cero con el saludo. Lo llama un temporizador (index.ts).
   */
  async cerrarInactivas(): Promise<number> {
    const { deps } = this;
    const hasta = new Date(deps.now().getTime() - SESSION_TTL_MS);
    const sesiones = await deps.sessions.tomarInactivas(new Date(hasta.getTime() - VENTANA_CIERRE_MS), hasta);
    for (const s of sesiones) {
      let texto = DESPEDIDA.inactividad;
      const st = s.cargador;
      if (st?.loteId || st?.cargaId) {
        const lote = st.loteId ? deps.lotes.obtener(st.loteId) : undefined;
        if (st.loteId) deps.lotes.borrar(st.loteId);
        if (lote || st.etapa === "esperando_confirmacion") {
          await this.cargador.cerrarRegistro(lote?.cargaId ?? st.cargaId, "cancelada", lote?.resultado.costoUsd ?? null);
          texto = DESPEDIDA.inactividadConCarga;
        }
      }
      this.cerradas.set(s.conversationId, deps.now().getTime());
      await this.channel
        .send(s.conversationId, { kind: "text", text: texto, sinPie: true })
        .catch((err) => deps.logger.warn({ err, conversationId: s.conversationId }, "No se pudo mandar la despedida por inactividad"));
      deps.logger.info({ conversationId: s.conversationId }, "Sesión de carga cerrada por 1 hora sin actividad");
    }
    return sesiones.length;
  }

  async reset(conversationId: string): Promise<void> {
    await this.deps.sessions.delete(conversationId);
  }

  private prepararSesion(saved: Session | null, msg: IncomingMessage, now: Date): Session {
    const fresh = this.newSession(msg.conversationId, msg.phone ?? null);
    if (!saved) return fresh;
    // Sesión vieja: se conserva sólo el handoff vigente.
    if (now.getTime() - new Date(saved.updatedAt).getTime() > SESSION_TTL_MS) return { ...fresh, handedOffUntil: saved.handedOffUntil };
    return { ...saved, phone: saved.phone ?? msg.phone ?? null };
  }

  private newSession(conversationId: string, phone: string | null): Session {
    return { conversationId, phone, rol: "consulta", botones: [], handedOffUntil: null, updatedAt: this.deps.now().toISOString() };
  }

  /**
   * Texto de varios renglones donde cada renglón es un botón o un comando: el último
   * renglón. undefined si no es eso (un mensaje normal de varios renglones se respeta).
   */
  private ultimoToque(session: Session, text: string): string | undefined {
    const renglones = text.split("\n").map((r) => r.trim()).filter(Boolean);
    if (renglones.length < 2) return undefined;
    const esToque = (r: string) => this.payloadDeBoton(session, r) !== undefined || detectarComando(r) !== undefined;
    return renglones.every(esToque) ? renglones.at(-1) : undefined;
  }

  private payloadDeBoton(session: Session, text: string): string | undefined {
    const t = normalizeText(text);
    if (!t) return undefined;
    return [...session.botones, ...PIE].find((b) => normalizeText(b.title) === t || b.payload === text.trim())?.payload;
  }
}
