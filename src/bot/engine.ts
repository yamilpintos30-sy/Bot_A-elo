/**
 * Motor del bot: decide qué flujo atiende cada mensaje y guarda la sesión.
 *
 *   - El rol se decide EN CADA MENSAJE con la lista de cargadores: si se sube
 *     un .txt nuevo, rige desde el mensaje siguiente.
 *   - Los botones de WhatsApp vuelven como texto con su TÍTULO: se traducen a
 *     su payload con los botones del último mensaje de la sesión.
 *   - Si una persona tomó la conversación (handoff), el bot no responde.
 */
import { normalizeText } from "../utils/text.js";
import { CargadorFlow } from "./cargadorFlow.js";
import { ConsultaFlow } from "./consultaFlow.js";
import type { BotDeps } from "./deps.js";
import type { IncomingMessage, Outbound, Session } from "./types.js";

/** Canal de salida (Chatwoot en producción; un array en los tests). */
export interface Channel {
  send(conversationId: string, out: Outbound): Promise<void>;
}

/** Inactividad tras la cual la conversación arranca de cero. */
const SESSION_TTL_MS = 60 * 60_000;

export class BotEngine {
  private readonly cargador: CargadorFlow;
  private readonly consulta: ConsultaFlow;

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
    const session = await this.loadSession(msg, now);
    if (session.handedOffUntil && new Date(session.handedOffUntil) > now) {
      deps.logger.info({ conversationId: msg.conversationId }, "Conversación atendida por una persona: el bot no responde");
      return;
    }

    const esCargador = await deps.cargadores.esCargador(msg.phone).catch((err) => {
      deps.logger.error({ err }, "No se pudo leer la lista de cargadores; se atiende como consulta");
      return false;
    });
    session.rol = esCargador ? "cargador" : "consulta";

    const payload = this.payloadDeBoton(session, msg.text);
    session.botones = [];
    void deps.log.log({ conversationId: msg.conversationId, phone: session.phone, direction: "in", rol: session.rol, content: msg.text, meta: { attachments: msg.attachments.length, payload } });

    const emit = async (out: Outbound) => {
      if (out.kind === "buttons") session.botones = out.buttons;
      await this.channel.send(msg.conversationId, out);
      const content = out.kind === "file" ? `[archivo] ${out.filename}` : out.kind === "image" ? `[imagen] ${out.caption}` : out.text;
      void deps.log.log({ conversationId: msg.conversationId, phone: session.phone, direction: "out", rol: session.rol, content });
    };

    try {
      if (session.rol === "cargador") await this.cargador.handle(session, msg, payload, emit);
      else await this.consulta.handle(session, msg, payload, emit);
    } finally {
      session.updatedAt = deps.now().toISOString();
      await deps.sessions.save(session).catch((err) => deps.logger.error({ err }, "No se pudo guardar la sesión"));
    }
  }

  /** Una persona respondió desde Chatwoot o desde el celular: el bot se calla un rato. */
  async markHandedOff(conversationId: string): Promise<void> {
    const session = (await this.deps.sessions.get(conversationId)) ?? this.newSession(conversationId, null);
    session.handedOffUntil = new Date(this.deps.now().getTime() + this.handoffMinutes * 60_000).toISOString();
    session.updatedAt = this.deps.now().toISOString();
    await this.deps.sessions.save(session);
  }

  /** Conversación resuelta en Chatwoot: el próximo mensaje arranca de cero. */
  async reset(conversationId: string): Promise<void> {
    await this.deps.sessions.delete(conversationId);
  }

  private async loadSession(msg: IncomingMessage, now: Date): Promise<Session> {
    const saved = await this.deps.sessions.get(msg.conversationId).catch((err) => {
      this.deps.logger.error({ err }, "No se pudo leer la sesión; se arranca una nueva");
      return null;
    });
    const fresh = this.newSession(msg.conversationId, msg.phone ?? null);
    if (!saved) return fresh;
    const vieja = now.getTime() - new Date(saved.updatedAt).getTime() > SESSION_TTL_MS;
    // Sesión vieja: se conserva sólo el handoff vigente.
    if (vieja) return { ...fresh, handedOffUntil: saved.handedOffUntil };
    return { ...saved, phone: saved.phone ?? msg.phone ?? null };
  }

  private newSession(conversationId: string, phone: string | null): Session {
    return { conversationId, phone, rol: "consulta", botones: [], handedOffUntil: null, updatedAt: this.deps.now().toISOString() };
  }

  private payloadDeBoton(session: Session, text: string): string | undefined {
    const t = normalizeText(text);
    if (!t) return undefined;
    return session.botones.find((b) => normalizeText(b.title) === t || b.payload === text.trim())?.payload;
  }
}
