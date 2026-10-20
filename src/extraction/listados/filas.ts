/**
 * Ubicación de filas en la imagen de una página (sin IA).
 *
 * Claude lee el listado y dice "esta fila está más o menos a esta altura";
 * acá se encuentran las bandas de texto reales de la página y se ajusta esa
 * altura a la banda exacta. Así el recuadro rojo cae justo sobre la fila y el
 * recorte que se verifica es exactamente esa fila (si el ajuste es dudoso, el
 * registro no se carga).
 */

/** Imagen en escala de grises: un byte por píxel, 0 = negro. */
export interface Gris {
  ancho: number;
  alto: number;
  px: Uint8Array;
}

export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Franja horizontal con texto: [y0, y1). */
export interface Banda {
  y0: number;
  y1: number;
}

/** RGBA (canvas) -> gris. */
export function aGris(rgba: Uint8ClampedArray | Uint8Array, ancho: number, alto: number): Gris {
  const px = new Uint8Array(ancho * alto);
  for (let i = 0, j = 0; i < px.length; i++, j += 4) px[i] = (rgba[j]! * 299 + rgba[j + 1]! * 587 + rgba[j + 2]! * 114) / 1000;
  return { ancho, alto, px };
}

/** Rectángulo que contiene todo lo que no es fondo blanco (null si la página está en blanco). */
export function regionConContenido(g: Gris, umbral = 235): Region | null {
  let x0 = g.ancho, y0 = g.alto, x1 = -1, y1 = -1;
  for (let y = 0; y < g.alto; y++) {
    const fila = y * g.ancho;
    for (let x = 0; x < g.ancho; x++) {
      if (g.px[fila + x]! < umbral) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/**
 * Bandas de texto dentro de la región: alturas donde hay "tinta" oscura en una
 * parte apreciable del ancho. Los trazos finos verticales (bordes de tabla,
 * marcas al inicio de cada fila) no alcanzan el mínimo y no unen filas vecinas;
 * las líneas grises claras entre filas quedan por encima del umbral.
 */
export function bandasDeTexto(g: Gris, r: Region, umbral = 160, fraccionMinima = 0.006): Banda[] {
  const minimo = Math.max(3, Math.round((r.x1 - r.x0) * fraccionMinima));
  const bandas: Banda[] = [];
  let inicio = -1;
  for (let y = r.y0; y < r.y1; y++) {
    let tinta = 0;
    const fila = y * g.ancho;
    for (let x = r.x0; x < r.x1; x++) if (g.px[fila + x]! < umbral) tinta++;
    if (tinta >= minimo) {
      if (inicio < 0) inicio = y;
    } else if (inicio >= 0) {
      bandas.push({ y0: inicio, y1: y });
      inicio = -1;
    }
  }
  if (inicio >= 0) bandas.push({ y0: inicio, y1: r.y1 });
  return bandas;
}

/** Distancia típica entre filas consecutivas (mediana entre centros). */
export function pasoTipico(bandas: Banda[]): number {
  const pasos = bandas.slice(1).map((b, i) => centro(b) - centro(bandas[i]!)).sort((a, b) => a - b);
  return pasos.length ? pasos[Math.floor(pasos.length / 2)]! : 0;
}

export const centro = (b: Banda) => (b.y0 + b.y1) / 2;

/**
 * Corta la región en franjas de como mucho `altoMaximo` píxeles, siempre entre
 * dos bandas (nunca por la mitad de una fila), para mandarle a Claude imágenes
 * con la letra a buen tamaño.
 */
export function cortarEnFranjas(bandas: Banda[], r: Region, altoMaximo: number): Array<{ y0: number; y1: number }> {
  const franjas: Array<{ y0: number; y1: number }> = [];
  let y0 = r.y0;
  let ultimoCorte = -1;
  for (let i = 0; i < bandas.length; i++) {
    const b = bandas[i]!;
    if (b.y1 - y0 > altoMaximo && ultimoCorte > y0) {
      franjas.push({ y0, y1: ultimoCorte });
      y0 = ultimoCorte;
    }
    const siguiente = bandas[i + 1];
    ultimoCorte = siguiente ? Math.round((b.y1 + siguiente.y0) / 2) : r.y1;
  }
  // Lo que quede (o una banda sola más alta que el máximo) va en franjas de altura fija.
  while (r.y1 - y0 > altoMaximo) {
    franjas.push({ y0, y1: y0 + altoMaximo });
    y0 += altoMaximo;
  }
  if (r.y1 > y0) franjas.push({ y0, y1: r.y1 });
  return franjas;
}

/**
 * Banda que corresponde a la altura aproximada que dio Claude: la que la
 * contiene o, si no, la más cercana a menos de `distanciaMaxima`. null si no
 * hay ninguna lo bastante cerca.
 */
export function ajustarABanda(bandas: Banda[], y: number, distanciaMaxima: number): Banda | null {
  const contiene = bandas.find((b) => y >= b.y0 && y < b.y1);
  if (contiene) return contiene;
  let mejor: Banda | null = null;
  let distancia = Infinity;
  for (const b of bandas) {
    const d = Math.min(Math.abs(y - b.y0), Math.abs(y - b.y1));
    if (d < distancia) {
      distancia = d;
      mejor = b;
    }
  }
  return distancia <= distanciaMaxima ? mejor : null;
}
