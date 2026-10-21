/** Armado de dependencias ("composition root"): todo lo real se instancia acá, una vez. */
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LotesPendientes, type BotDeps } from "./bot/deps.js";
import { BotEngine } from "./bot/engine.js";
import { ChatwootChannel } from "./channels/chatwoot/channel.js";
import { ChatwootClient } from "./channels/chatwoot/client.js";
import { EchoGuard } from "./channels/chatwoot/echoGuard.js";
import { loadConfig, type AppConfig } from "./config.js";
import { ClaudeRunner } from "./extraction/claudeRunner.js";
import { ProcesadorCarnets } from "./extraction/procesarCarnets.js";
import { VerificadorComprobantes } from "./extraction/verificadorComprobantes.js";
import { AneloClient } from "./integrations/seawhite/aneloClient.js";
import { SupabaseListaTelefonos } from "./storage/cargadores.js";
import { SupabaseCatalogo } from "./storage/catalogo.js";
import { SupabaseFallas } from "./storage/fallas.js";
import { SupabaseRegistro } from "./storage/registro.js";
import { SupabaseMessageLog, SupabaseSessions } from "./storage/sessions.js";
import { createSupabase } from "./storage/supabase.js";
import { logger, type Logger } from "./utils/logger.js";

export interface Container {
  config: AppConfig;
  logger: Logger;
  supabase: SupabaseClient;
  seawhite: AneloClient;
  echo: EchoGuard;
  engine: BotEngine;
  deps: BotDeps;
}

export function buildContainer(config: AppConfig = loadConfig()): Container {
  const supabase = createSupabase(config);
  const echo = new EchoGuard();

  const chatwoot = new ChatwootClient({
    baseUrl: config.CHATWOOT_BASE_URL,
    apiToken: config.CHATWOOT_API_TOKEN,
    accountId: config.CHATWOOT_ACCOUNT_ID,
    logger,
    echo,
  });

  const seawhite = new AneloClient({
    baseUrl: config.SEALINK_BASE_URL,
    email: config.SEALINK_EMAIL,
    password: config.SEALINK_PASSWORD,
    servidor: config.SEALINK_SERVIDOR,
    timeoutMs: config.SEALINK_TIMEOUT_MS,
    cargaHabilitada: config.ANELO_CARGA_HABILITADA,
    modoPrueba: config.ANELO_MODO_PRUEBA,
    prefijoPrueba: config.ANELO_PREFIJO_PRUEBA,
    logger,
  });

  // Un solo cliente de Claude para separar carnets y verificar comprobantes.
  const claude = new ClaudeRunner(config.ANTHROPIC_API_KEY, logger, config.CLAUDE_FALLBACKS);

  const deps: BotDeps = {
    botName: config.BOT_NAME,
    timezone: config.TIMEZONE,
    catalogo: new SupabaseCatalogo(supabase),
    cargadores: new SupabaseListaTelefonos(supabase, "anelo_cargadores"),
    consultores: new SupabaseListaTelefonos(supabase, "anelo_consultores"),
    registro: new SupabaseRegistro(supabase),
    sessions: new SupabaseSessions(supabase),
    log: new SupabaseMessageLog(supabase, logger),
    seawhite,
    procesador: new ProcesadorCarnets(config, logger, claude),
    descargarAdjunto: (url) => chatwoot.downloadAttachment(url),
    verificador: new VerificadorComprobantes(claude, { model: config.VERIFY_MODEL, effort: config.VERIFY_EFFORT }, logger),
    fallas: new SupabaseFallas(supabase, logger),
    lotes: new LotesPendientes(),
    logger,
    now: () => new Date(),
  };

  const channel = new ChatwootChannel(chatwoot, logger, config.WELCOME_IMAGE ? path.resolve(process.cwd(), config.WELCOME_IMAGE) : undefined, config.WELCOME_IMAGE_DELAY_MS);
  const engine = new BotEngine(deps, channel, config.HANDOFF_SILENCE_MINUTES);
  return { config, logger, supabase, seawhite, echo, engine, deps };
}
