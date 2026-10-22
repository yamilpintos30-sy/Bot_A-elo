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
  /** Registro de la carga (anelo_cargas): se cierra aunque el lote ya no exista. */
  cargaId?: number | null;
  /** Ya se cargó un tipo y se ofrece cargar el otro tipo del mismo documento. */
  ofreciendoOtro?: boolean;
  /** El cliente elegido del menú ya se confirmó con [Sí] (hasta eso no se pasa a la operadora). */
  clienteConfirmado?: boolean;
  /** "¿Quisiste decir ...?" pendiente (cliente y subcliente). */
  sugerencia?: { clienteCodigo: string; plantaCodigo?: string };
  pidioPlanta?: boolean;
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

/** Estado del flujo de consultas (choferes). Sesiones viejas pueden traer campos que ya no se usan. */
export interface ConsultaState {
  saludado: boolean;
  /**
   * Rama elegida en el menú principal:
   *   habilitacion -> por DNI o por dominio -> clientes donde está habilitado -> elegir uno
   *   vehiculo     -> VTV o seguro por patente
   */
  rama?: "habilitacion" | "vehiculo";
  /**
   *   chofer / dominio -> habilitación por DNI o por patente
   *   vtv / seguro     -> comprobante del vehículo por patente
   */
  modo?: "chofer" | "dominio" | "vtv" | "seguro";
  /** Habilitación: DNI o patente consultado y los clientes donde está habilitado (API 1 / 7). */
  identificador?: string;
  habilitados?: Array<{ codigo: string; nombre: string }>;
  /** Cliente elegido de esa lista, y sus subclientes (API 2 / 8) si hay que elegir uno. */
  clienteCodigo?: string;
  clienteNombre?: string;
  subclientes?: Array<{ codigo: string; nombre: string }>;
  plantaCodigo?: string;
  plantaNombre?: string;
  /** VTV/seguro: dominio consultado y si ya se ofreció el otro comprobante. */
  ultimoDominio?: string;
  otroOfrecido?: boolean;
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
  /** Número no habilitado al que ya se le mandó el aviso: no se le responde más. */
  avisoNoHabilitado?: boolean;
  updatedAt: string;
}
