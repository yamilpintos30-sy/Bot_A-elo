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
  /** `sinPie`: no agregar [Menú] [Eso es todo] (p. ej. la despedida). */
  | { kind: "text"; text: string; sinPie?: boolean }
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
  /** Archivos recibidos y todavía no procesados (PDF o fotos de carnets). */
  archivos?: Array<{ url: string; fileName: string }>;
  /** Formato viejo (un solo PDF): se sigue leyendo por las sesiones guardadas. */
  pdf?: { url: string; fileName: string };
  /** Id del lote procesado y pendiente de confirmar (en memoria). */
  loteId?: string;
  /** Ya se cargó un tipo y se ofrece cargar el otro tipo del mismo documento. */
  ofreciendoOtro?: boolean;
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
  /**
   * Cliente y subcliente declarados AL PRINCIPIO: toda consulta es para esa
   * planta (un DNI o una patente pueden estar en varias). [Menú] los borra;
   * [Consulta] los conserva.
   */
  clienteCodigo?: string;
  plantaCodigo?: string;
  /** Ya se le pidió la planta (para avisar "no encontré ese cliente" sólo después). */
  pidioPlanta?: boolean;
  /**
   * Opción elegida en el menú principal:
   *   chofer / dominio -> credencial de ingreso (con cliente y subcliente) por DNI o patente
   *   vtv / seguro     -> comprobante del vehículo por patente (sin cliente)
   */
  modo?: "chofer" | "dominio" | "vtv" | "seguro";
  /** VTV/seguro: dominio consultado y si ya se ofreció el otro comprobante. */
  ultimoDominio?: string;
  otroOfrecido?: boolean;
  /** DNI o patente que mandó ANTES de decir la planta: se consulta apenas la elija. */
  pendiente?: { tipo: "chofer" | "dominio"; identificador: string };
  /** Carnet de la última consulta (su ID de SEA WHITE se usa para mandar el PDF). */
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
