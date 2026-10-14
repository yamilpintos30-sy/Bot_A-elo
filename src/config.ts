/**
 * Configuración del bot Añelo.
 *
 * Todas las variables de entorno se validan acá con Zod. Están separadas por
 * sección para que cada parte del sistema exija SOLO lo que usa: la prueba del
 * extractor (`npm run extraer`) necesita la API key de Claude, pero no Chatwoot
 * ni Supabase; el servidor completo exige todo.
 *
 * Este bot es independiente del bot Enri: no comparte variables, servicio de
 * Render, base de Supabase ni webhook. Ver README.
 */
import "dotenv/config";
import { z } from "zod";

const booleanFromEnv = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? undefined : ["1", "true", "yes", "si", "sí"].includes(v.toLowerCase())));

// --- Secciones ---------------------------------------------------------------

export const generalSchema = z.object({
  BOT_NAME: z.string().default("Bot Añelo"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  TIMEZONE: z.string().default("America/Argentina/Buenos_Aires"),
});

export const claudeSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY es obligatorio"),
  /** Modelo que separa los carnets en el sandbox y verifica el resultado. */
  EXTRACTION_MODEL: z.string().default("claude-opus-5-5"),
  /** Esfuerzo del modelo al separar carnets. Alto: un error acá termina cargado en SEA WHITE. */
  EXTRACTION_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  /** Fallback automático del lado del servidor ante un "refusal" (beta; se apaga solo si la API lo rechaza). */
  CLAUDE_FALLBACKS: booleanFromEnv.default(true),
});

export const seawhiteSchema = z.object({
  SEALINK_BASE_URL: z.string().url().default("https://api.seawhite.com.ar:9443"),
  SEALINK_EMAIL: z.string().min(1, "SEALINK_EMAIL es obligatorio"),
  SEALINK_PASSWORD: z.string().min(1, "SEALINK_PASSWORD es obligatorio"),
  SEALINK_SERVIDOR: z.string().default("1"),
  SEALINK_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  /**
   * Interruptor general de la CARGA en SEA WHITE. Apagado por defecto: hasta
   * que se ponga en true, el bot puede separar carnets y consultar, pero
   * ningún POST sale a la red.
   */
  ANELO_CARGA_HABILITADA: booleanFromEnv.default(false),
  /**
   * Modo prueba: con true, la carga SOLO acepta el cliente de prueba (no hay
   * ambiente de prueba en SEA WHITE; las pruebas quedan en producción bajo un
   * cliente ficticio que nunca se confunde con uno real).
   */
  ANELO_MODO_PRUEBA: booleanFromEnv.default(true),
  ANELO_CLIENTE_PRUEBA: z.string().regex(/^\d{6}$/).default("999999"),
});

export const chatwootSchema = z.object({
  CHATWOOT_BASE_URL: z.string().url().default("https://app.chatwoot.com"),
  CHATWOOT_API_TOKEN: z.string().min(1, "CHATWOOT_API_TOKEN es obligatorio"),
  CHATWOOT_ACCOUNT_ID: z.coerce.number().int().positive(),
  /**
   * Inbox de ESTE bot (OBLIGATORIO). Los webhooks de Chatwoot son a nivel
   * cuenta: sin este filtro el bot contestaría los chats de Enri.
   */
  CHATWOOT_INBOX_ID: z.string().regex(/^\d+$/, "CHATWOOT_INBOX_ID debe ser el número del inbox de este bot"),
  /** Token propio de este bot para validar el webhook (distinto del de Enri). */
  WEBHOOK_SECRET: z.string().min(16, "WEBHOOK_SECRET debe tener al menos 16 caracteres"),
});

export const supabaseSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

export const panelSchema = z.object({
  /** Contraseña del panel. Vacía = el panel no se publica. */
  ADMIN_PASSWORD: z.string().min(8, "ADMIN_PASSWORD debe tener al menos 8 caracteres").optional(),
});

export type GeneralConfig = z.infer<typeof generalSchema>;
export type ClaudeConfig = z.infer<typeof claudeSchema>;
export type SeaWhiteConfig = z.infer<typeof seawhiteSchema>;
export type ChatwootConfig = z.infer<typeof chatwootSchema>;
export type SupabaseConfig = z.infer<typeof supabaseSchema>;
export type PanelConfig = z.infer<typeof panelSchema>;

const fullSchema = generalSchema
  .extend(claudeSchema.shape)
  .extend(seawhiteSchema.shape)
  .extend(chatwootSchema.shape)
  .extend(supabaseSchema.shape)
  .extend(panelSchema.shape);

export type AppConfig = z.infer<typeof fullSchema>;

// --- Carga -------------------------------------------------------------------

/** Variables vacías ("SUPABASE_URL=") se tratan como no definidas. */
function envSource(overrides: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(([, v]) => v !== undefined && String(v).trim() !== ""),
  ) as Record<string, string>;
}

/** Valida un esquema y lanza un error legible con todo lo que falta. */
export function parseConfig<S extends z.ZodType>(schema: S, overrides: Record<string, string | undefined> = {}): z.infer<S> {
  const parsed = schema.safeParse(envSource(overrides));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuración inválida. Revisá el archivo .env:\n${issues}`);
  }
  return parsed.data;
}

/** Configuración completa (servidor). */
export function loadConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return parseConfig(fullSchema, overrides);
}
