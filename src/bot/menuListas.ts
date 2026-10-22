/**
 * Menú de opciones para WhatsApp, del tamaño que haga falta:
 *   - hasta 3 opciones: botones;
 *   - hasta 10: una lista (el botón dice "Choose an item", fijo de Chatwoot);
 *   - más de 10: varias listas seguidas de hasta 10 (el tope de WhatsApp),
 *     numeradas con su rango ("Lista 2 de 4: X a Y"). Todas valen a la vez:
 *     el motor acumula los botones de toda la respuesta.
 */
import { buttonTitle } from "../utils/text.js";
import type { Emit } from "./deps.js";
import type { ButtonSpec } from "./types.js";

/** Máximo de opciones por lista de WhatsApp. */
export const MAX_OPCIONES = 10;

export interface TextosMenu {
  /** Todas entran en un mensaje. `lista`: van como lista (más de 3), hay que aclarar que se toca el botón. */
  una: (lista: boolean) => string;
  /** Van en varias listas: encabezado del primer mensaje. */
  varias: (listas: number) => string;
}

export const aclaracionLista = "👇 Tocá el botón de abajo para ver la lista.";
export const variasListas = (listas: number) => `👇 Están en ${listas} listas por orden alfabético: tocá el botón de la que corresponda.`;
export const rangoLista = (n: number, total: number, desde: string, hasta: string) => `📋 Lista ${n} de ${total}: *${desde}* a *${hasta}*`;

export async function emitirMenu(emit: Emit, opciones: ButtonSpec[], textos: TextosMenu): Promise<void> {
  // Con más de 3 opciones, o alguna con descripción, WhatsApp la muestra como lista.
  const esLista = opciones.length > 3 || opciones.some((o) => o.description);
  if (opciones.length <= MAX_OPCIONES) return emit({ kind: "buttons", text: textos.una(esLista), buttons: opciones });
  const tandas: ButtonSpec[][] = [];
  for (let i = 0; i < opciones.length; i += MAX_OPCIONES) tandas.push(opciones.slice(i, i + MAX_OPCIONES));
  for (const [i, tanda] of tandas.entries()) {
    const rango = rangoLista(i + 1, tandas.length, tanda[0]!.title, tanda.at(-1)!.title);
    await emit({ kind: "buttons", text: i === 0 ? `${textos.varias(tandas.length)}\n\n${rango}` : rango, buttons: tanda });
  }
}

/**
 * Títulos de botón (20 caracteres) sin repetidos: si dos quedan iguales al
 * cortarlos, se les antepone el código para distinguirlos.
 */
export function titulos<T extends { codigo: string }>(items: T[], nombre: (i: T) => string): ButtonSpec[] {
  const base = items.map((i) => buttonTitle(nombre(i)));
  return items.map((i, n) => ({ title: base.filter((b) => b === base[n]).length > 1 ? buttonTitle(`${i.codigo} ${nombre(i)}`) : base[n]!, payload: "" }));
}
