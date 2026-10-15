/**
 * Forma (parcial) del payload de los webhooks de Chatwoot. Sólo se tipa lo que
 * se usa. Los campos alternativos existen porque Chatwoot no es consistente
 * entre canales y versiones (aprendido en Enri).
 */

export interface ChatwootAttachment {
  id?: number;
  file_type?: string;
  data_url?: string;
  file_url?: string;
  thumb_url?: string;
  url?: string;
  content_type?: string;
  file_name?: string;
  extension?: string | null;
}

export interface ChatwootContact {
  id?: number;
  name?: string;
  phone_number?: string;
  type?: string; // "contact" | "user" | "agent_bot"
}

export interface ChatwootWebhookPayload {
  event?: string;
  id?: number;
  content?: string | null;
  message_type?: "incoming" | "outgoing" | "activity" | "template" | number;
  content_type?: string;
  content_attributes?: { attachments?: ChatwootAttachment[] } & Record<string, unknown>;
  private?: boolean;
  attachments?: ChatwootAttachment[];
  sender?: ChatwootContact;
  conversation?: {
    id?: number;
    status?: string;
    inbox_id?: number;
    meta?: {
      assignee?: { id?: number; name?: string } | null;
      sender?: ChatwootContact | null;
    };
  };
  account?: { id?: number };
  inbox?: { id?: number };
  /** En conversation_status_changed la conversación viene "aplanada": inbox_id al primer nivel. */
  inbox_id?: number;
  status?: string;
}
