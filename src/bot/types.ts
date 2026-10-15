/**
 * Tipos centrales del bot Añelo.
 *
 * Hay dos flujos independientes según quién escribe:
 *   - cargador: número de la lista de cargadores -> sube PDF de carnets.
 *   - consulta: cualquier otro número (choferes) -> consulta vencimientos y pide su carnet.
 */

/** Adjunto que llega por el webhook de Chatwoot. */
export interface IncomingAttachment {
  url: string;
  /** "image" | "file" | "audio" | ... según Chatwoot. */
  fileType?: string;
  contentType?: string;
  fileName?: string;
}

export interface IncomingMessage {
  id: string;
  conversationId: string;
  accountId: string;
  text: string;
  attachments: IncomingAttachment[];
  /** Teléfono del contacto tal como lo entrega Chatwoot (+549...). */
  phone?: string;
  name?: string;
  conversationStatus?: string;
}

/** Botón de WhatsApp: máximo 3 por mensaje y 20 caracteres de título. */
export interface ButtonSpec {
  title: string;
  payload: string;
}

/** Lo que el bot quiere enviar, en orden. El canal lo traduce a Chatwoot. */
export type Outbound =
  | { kind: "text"; text: string }
  | { kind: "buttons"; text: string; buttons: ButtonSpec[] }
  | { kind: "file"; filename: string; data: Buffer; caption?: string }
  /** Imagen de bienvenida (avatar del bot) con epígrafe. Sin imagen configurada, sale como texto. */
  | { kind: "image"; caption: string };

export type Rol = "cargador" | "consulta";

/** Estado del flujo de carga (cargadores). */
export interface CargadorState {
  etapa: "esperando_datos" | "esperando_confirmacion";
  /** Qué eligió cargar en el menú: carnets de personas (chofer) o de vehículos (dominio). */
  tipo?: "chofer" | "dominio";
  clienteCodigo?: string;
  plantaCodigo?: string;
  /** PDF recibido y todavía no procesado. */
  pdf?: { url: string; fileName: string };
  /** Id del lote procesado y pendiente de confirmar (en memoria). */
  loteId?: string;
}

/** Una credencial encontrada en la última consulta (para el botón "Ver carnet"). */
export interface CarnetConsultado {
  tipo: "chofer" | "dominio";
  identificador: string;
  clienteCodigo: string;
  plantaCodigo: string;
  etiqueta: string;
  seawhiteId: number | null;
}

/** Estado del flujo de consultas (choferes). */
export interface ConsultaState {
  saludado: boolean;
  /** Qué eligió consultar en el menú: espera un DNI (chofer) o una patente (dominio). */
  esperando?: "chofer" | "dominio";
  /** Cliente/planta que mencionó antes de dar el DNI ("¿puedo entrar a shell planta 2?"). */
  clienteCodigo?: string;
  plantaCodigo?: string;
  ultimos?: CarnetConsultado[];
}

export interface Session {
  conversationId: string;
  phone: string | null;
  rol: Rol;
  cargador?: CargadorState;
  consulta?: ConsultaState;
  /** Botones del último mensaje: la respuesta llega como el TÍTULO del botón. */
  botones: ButtonSpec[];
  /** Si es futuro, una persona tomó la conversación y el bot no responde. */
  handedOffUntil: string | null;
  updatedAt: string;
}
