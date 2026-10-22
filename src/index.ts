/** Punto de entrada: servidor HTTP que recibe los webhooks de Chatwoot. */
import { buildContainer } from "./container.js";
import { createApp } from "./server/app.js";

async function main(): Promise<void> {
  const container = buildContainer();
  const { config, logger } = container;

  // Ninguna promesa perdida ni excepción suelta debe tumbar el proceso.
  process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "Promesa sin capturar; el bot sigue"));
  process.on("uncaughtException", (err) => logger.error({ err }, "Excepción no capturada; el bot sigue"));

  logger.info(
    { inbox: config.CHATWOOT_INBOX_ID, cargaHabilitada: config.ANELO_CARGA_HABILITADA, modelo: config.EXTRACTION_MODEL },
    "Configuración del bot Añelo",
  );

  // Precalentar el token de SEA WHITE (sólo autenticación). No bloquea el arranque.
  container.seawhite
    .ping()
    .then((ok) => logger.info({ ok }, "Conexión con SEA WHITE verificada"))
    .catch((err) => logger.warn({ err: (err as Error).message }, "No se pudo verificar SEA WHITE al arrancar"));

  // Cargas que quedaron "procesando" y ya no van a terminar (pasan a "sin confirmar"):
  //  - Las de ANTES de este arranque: vivían en la memoria del bot anterior (un
  //    deploy o un reinicio las corta). Se cierran a los 3 minutos, cuando Render
  //    ya apagó la instancia vieja (en un deploy conviven un rato).
  //  - Por las dudas, cada 30 minutos, las de más de 2 horas (procesar tarda
  //    minutos y una carga sin confirmar expira en 1 hora).
  const arranque = new Date();
  const cerrarAbandonadas = (antesDe: Date) =>
    container.deps.registro
      .cerrarAbandonadas(antesDe)
      .then((n) => n > 0 && logger.info({ cargas: n }, "Cargas cortadas por un reinicio o abandonadas: marcadas como sin confirmar"))
      .catch((err) => logger.warn({ err: (err as Error).message }, "No se pudieron cerrar las cargas abandonadas"));
  setTimeout(() => void cerrarAbandonadas(arranque), 3 * 60_000).unref();
  setInterval(() => void cerrarAbandonadas(new Date(Date.now() - 2 * 60 * 60_000)), 30 * 60_000).unref();

  // Cargadores con 1 hora sin actividad: se cierra la sesión y se despide.
  setInterval(
    () => void container.engine.cerrarInactivas().catch((err) => logger.warn({ err: (err as Error).message }, "No se pudieron cerrar las sesiones inactivas")),
    5 * 60_000,
  ).unref();

  const app = createApp(container);
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, `${config.BOT_NAME} escuchando`);
    logger.info(`Webhook: POST /webhooks/chatwoot?token=<WEBHOOK_SECRET>`);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "Apagando...");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
