import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";
const pretty = process.env.NODE_ENV !== "production";

export const logger = pino({
  level,
  ...(pretty
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : {}),
});

export type Logger = typeof logger;
