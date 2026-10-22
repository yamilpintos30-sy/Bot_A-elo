/**
 * Menú de opciones para WhatsApp, del tamaño que haga falta:
 *   - hasta 3 opciones: botones;
 *   - hasta 10: una lista (el botón dice "Choose an item", fijo de Chatwoot);
 *   - más de 10: varias listas seguidas de hasta 10 (el tope de WhatsApp),
 *     numeradas ("📋 Lista 2 de 4 de clientes"). Todas valen a la vez: el motor
 *     acumula los botones de toda la respuesta. Se mandan EN ORDEN: cada una
 *     espera la entrega de la anterior (WhatsApp mandaba la 2 antes que la 1).
 */
import { buttonTitle } from "../utils/text.js";
import type { Emit } from "./deps.js";
import type { ButtonSpec } from "./types.js";

/** Máximo de opciones por lista de WhatsApp. */
export const MAX_OPCIONES = 10;
/** Descripción de una opción de lista (tope de WhatsApp). */
const MAX_DESCRIPCION = 72;

export interface TextosMenu {
  /** Todas entran en un mensaje. `lista`: van como lista (más de 3), hay que aclarar que se toca el botón. */
  una: (lista: boolean) => string;
  /** Van en varias listas: encabezado del primer mensaje. */
  varias: (listas: number) => string;
  /** Qué hay en las listas, en plural: "📋 Lista 1 de 3 de *clientes*". */
  deQue: string;
  /**
   * Botón para irse ([Eso es todo, gracias]): con 1 o 2 opciones va en el mismo
   * mensaje; si no hay lugar (3 botones o una lista), en un mensaje aparte con
   * este texto, después de que se entregue el menú.
   */
  cierre?: { boton: ButtonSpec; texto: string };
}

export const aclaracionLista = "👇 Tocá el botón de abajo para ver la lista.";
export const variasListas = (listas: number) => `👇 Están en ${listas} listas por orden alfabético: tocá el botón de la que corresponda.`;
export const numeroDeLista = (n: number, total: number, deQue: string) => `📋 Lista ${n} de ${total} de ${deQue}`;

export async function emitirMenu(emit: Emit, opciones: ButtonSpec[], textos: TextosMenu): Promise<void> {
  // Con más de 3 opciones, o alguna con descripción, WhatsApp la muestra como lista.
  const esLista = opciones.length > 3 || opciones.some((o) => o.description);
  const { cierre } = textos;
  // Hay lugar para el botón de cierre en el mismo mensaje (hasta 3 botones).
  if (cierre && !esLista && opciones.length < 3) return emit({ kind: "buttons", text: textos.una(false), buttons: [...opciones, cierre.boton] });
  if (opciones.length <= MAX_OPCIONES) {
    await emit({ kind: "buttons", text: textos.una(esLista), buttons: opciones, esperarEntrega: Boolean(cierre) });
  } else {
    const tandas: ButtonSpec[][] = [];
    for (let i = 0; i < opciones.length; i += MAX_OPCIONES) tandas.push(opciones.slice(i, i + MAX_OPCIONES));
    for (const [i, tanda] of tandas.entries()) {
      const numero = numeroDeLista(i + 1, tandas.length, textos.deQue);
      await emit({
        kind: "buttons",
        text: i === 0 ? `${textos.varias(tandas.length)}\n\n${numero}` : numero,
        buttons: tanda,
        esperarEntrega: i < tandas.length - 1 || Boolean(cierre),
      });
    }
  }
  if (cierre) await emit({ kind: "buttons", text: cierre.texto, buttons: [cierre.boton] });
}

/**
 * Títulos de botón (20 caracteres) sin repetidos: si dos quedan iguales al
 * cortarlos, se les antepone el código para distinguirlos. Si un nombre no
 * entra, el completo va como descripción (segunda línea de la opción de lista).
 */
export function titulos<T extends { codigo: string }>(items: T[], nombre: (i: T) => string, completo: (i: T) => string = nombre): ButtonSpec[] {
  const base = items.map((i) => buttonTitle(nombre(i)));
  return items.map((i, n) => {
    const title = base.filter((b) => b === base[n]).length > 1 ? buttonTitle(`${i.codigo} ${nombre(i)}`) : base[n]!;
    const cortado = title !== nombre(i) && !title.endsWith(nombre(i));
    return { title, payload: "", ...(cortado ? { description: completo(i).slice(0, MAX_DESCRIPCION) } : {}) };
  });
}
