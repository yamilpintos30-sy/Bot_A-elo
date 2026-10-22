/**
 * Botones de pie y comandos globales, igual que en Enri:
 *   - Toda respuesta cierra con [🏠 Menú principal] [Eso es todo, gracias].
 *   - "Eso es todo, gracias" (tocado o escrito) despide y cierra la conversación.
 *   - "menú" vuelve al menú del rol.
 *   - Un "gracias"/"ok" suelto después del cierre NO reabre la conversación.
 */
import { normalizeText } from "../utils/text.js";
import type { ButtonSpec } from "./types.js";

export const BOTON_MENU: ButtonSpec = { title: "🏠 Menú principal", payload: "menu" };
export const BOTON_FIN: ButtonSpec = { title: "Eso es todo, gracias", payload: "fin" };
export const PIE: ButtonSpec[] = [BOTON_MENU, BOTON_FIN];

// Mismos criterios que Enri: "gracias" o "salir" SOLOS no cierran (un
// "gracias" de cortesía en medio de una consulta borraba la conversación).
const FIN = new Set(["fin", "eso es todo gracias", "eso es todo", "nada mas", "listo gracias", "no gracias", "chau"]);
const MENU = new Set(["menu", "menu principal", "inicio", "volver", "atras"]);

export function detectarComando(texto: string): "fin" | "menu" | undefined {
  const t = normalizeText(texto);
  if (!t || t.length > 40) return undefined;
  if (FIN.has(t)) return "fin";
  if (MENU.has(t)) return "menu";
  return undefined;
}

const CORTESIA = new Set([
  "gracias", "graciass", "muchas", "mil", "muchisimas", "ok", "oka", "okey", "okis", "dale", "genial", "perfecto", "listo",
  "bueno", "buenisimo", "barbaro", "joya", "excelente", "igualmente", "saludos", "saludo", "chau", "chao", "adios", "bien",
  "de", "nada", "a", "vos", "usted", "ti", "tambien", "que", "sigas", "siga", "abrazo", "si", "no",
]);

/** true si el mensaje es SOLO cortesía (o un emoji/sticker suelto, que llega sin texto). */
export function esSoloCortesia(texto: string): boolean {
  return normalizeText(texto)
    .split(" ")
    .filter(Boolean)
    .every((w) => CORTESIA.has(w));
}
