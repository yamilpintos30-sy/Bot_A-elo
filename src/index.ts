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
    { inbox: config.CHATWOOT_INBOX_ID, cargaHabilitada: config.ANELO_CARGA_HABILITADA, modoPrueba: config.ANELO_MODO_PRUEBA, modelo: config.EXTRACTION_MODEL },
    "Configuración del bot Añelo",
  );

  // Precalentar el token de SEA WHITE (sólo autenticación). No bloquea el arranque.
  container.seawhite
    .ping()
    .then((ok) => logger.info({ ok }, "Conexión con SEA WHITE verificada"))
    .catch((err) => logger.warn({ err: (err as Error).message }, "No se pudo verificar SEA WHITE al arrancar"));

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
