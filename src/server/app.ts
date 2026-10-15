/** App Express (separada de index.ts para poder testearla). */
import express, { type Express } from "express";
import type { Container } from "../container.js";
import { createWebhookRouter } from "./webhook.js";

export function createApp(c: Pick<Container, "config" | "engine" | "echo" | "logger">): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "2mb" }));

  app.get("/", (_req, res) => {
    res.type("html").send(`<h1>${c.config.BOT_NAME} — Vencimientos Añelo (SEA WHITE)</h1><p>El servicio está funcionando.</p>`);
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "seawhite-bot-anelo",
      inbox: c.config.CHATWOOT_INBOX_ID,
      cargaHabilitada: c.config.ANELO_CARGA_HABILITADA,
      modoPrueba: c.config.ANELO_MODO_PRUEBA,
      time: new Date().toISOString(),
    });
  });

  app.use(
    createWebhookRouter({
      secret: c.config.WEBHOOK_SECRET,
      inboxId: c.config.CHATWOOT_INBOX_ID,
      engine: c.engine,
      echo: c.echo,
      logger: c.logger,
      debounceMs: c.config.DEBOUNCE_SECONDS * 1000,
      activeStatuses: c.config.BOT_ACTIVE_STATUSES.split(",").map((s) => s.trim()).filter(Boolean),
    }),
  );
  return app;
}
