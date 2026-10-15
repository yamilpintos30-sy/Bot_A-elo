/**
 * Traduce el payload de Chatwoot a eventos del bot.
 *
 *   - message_created + incoming          -> mensaje del contacto.
 *   - message_created + outgoing          -> eco del bot o una PERSONA escribiendo
 *                                            (lo decide el webhook con EchoGuard).
 *   - conversation_status_changed         -> para resetear la sesión.
 *   - todo lo demás                       -> ignorar.
 */
import type { IncomingAttachment, IncomingMessage } from "../../bot/types.js";
import type { ChatwootAttachment, ChatwootWebhookPayload } from "./types.js";

export type ChatwootEvent =
  | { kind: "message"; message: IncomingMessage }
  | { kind: "outgoing"; conversationId: string; messageId?: string; text: string; senderType?: string }
  | { kind: "status_changed"; conversationId: string; status: string }
  | { kind: "ignore"; reason: string };

/** inbox_id del evento (los webhooks de Chatwoot son a nivel cuenta). */
export function extractInboxId(payload: ChatwootWebhookPayload): string | undefined {
  const id = payload.conversation?.inbox_id ?? payload.inbox?.id ?? payload.inbox_id;
  return id === undefined || id === null ? undefined : String(id);
}

function toAttachment(a: ChatwootAttachment): IncomingAttachment {
  return {
    url: a.data_url ?? a.file_url ?? a.url ?? a.thumb_url ?? "",
    fileType: a.file_type,
    contentType: a.content_type,
    fileName: a.file_name,
  };
}

function collectAttachments(payload: ChatwootWebhookPayload): IncomingAttachment[] {
  const direct = payload.attachments;
  const list = Array.isArray(direct) && direct.length > 0 ? direct : (payload.content_attributes?.attachments ?? []);
  return (Array.isArray(list) ? list : []).map(toAttachment).filter((a) => a.url.length > 0);
}

function direction(payload: ChatwootWebhookPayload): "incoming" | "outgoing" | "" {
  const mt = payload.message_type;
  if (mt === "incoming" || mt === 0) return "incoming";
  if (mt === "outgoing" || mt === 1) return "outgoing";
  return "";
}

export function parseChatwootWebhook(payload: ChatwootWebhookPayload): ChatwootEvent {
  const event = payload.event ?? "";

  if (event === "conversation_status_changed") {
    const conversationId = payload.id ?? payload.conversation?.id;
    const status = payload.status ?? payload.conversation?.status;
    if (!conversationId || !status) return { kind: "ignore", reason: "status_changed sin id/estado" };
    return { kind: "status_changed", conversationId: String(conversationId), status };
  }

  if (event !== "message_created") return { kind: "ignore", reason: `evento ${event || "desconocido"}` };
  if (payload.private) return { kind: "ignore", reason: "nota privada" };

  const conversationId = payload.conversation?.id;
  const accountId = payload.account?.id;
  if (!conversationId || !accountId) return { kind: "ignore", reason: "falta conversation.id o account.id" };

  const text = (payload.content ?? "").trim();
  const attachments = collectAttachments(payload);
  const dir = direction(payload);

  if (dir === "outgoing") {
    if (!text && attachments.length === 0) return { kind: "ignore", reason: "saliente sin contenido" };
    return {
      kind: "outgoing",
      conversationId: String(conversationId),
      messageId: payload.id !== undefined ? String(payload.id) : undefined,
      text,
      senderType: payload.sender?.type,
    };
  }
  if (dir !== "incoming") return { kind: "ignore", reason: "message_type desconocido" };
  if (!text && attachments.length === 0) return { kind: "ignore", reason: "mensaje vacío" };

  // conversation.meta.sender es el contacto en ambas direcciones.
  const contact = payload.conversation?.meta?.sender ?? payload.sender;
  return {
    kind: "message",
    message: {
      id: String(payload.id ?? `${conversationId}-${Date.now()}`),
      conversationId: String(conversationId),
      accountId: String(accountId),
      text,
      attachments,
      phone: contact?.phone_number,
      name: contact?.name,
      conversationStatus: payload.conversation?.status,
    },
  };
}
