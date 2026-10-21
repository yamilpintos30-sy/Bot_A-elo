/**
 * Reconoce cliente y planta en lo que escribe la gente: "shell planta 2",
 * "Total P1", "vista 1", "999991 000001".
 *
 * Los nombres y alias salen de las tablas del panel (no hay listas fijas en el
 * código): para que el bot entienda una forma nueva de escribir un cliente, se
 * agrega el alias en el panel.
 */
import type { Cliente, Planta } from "../storage/catalogo.js";
import { containsWords, normalizeText } from "../utils/text.js";

export interface Resolucion {
  cliente?: Cliente;
  planta?: Planta;
}

/** Nombre "de uso" de un cliente: sin "(PRUEBA)", "S.A.", etc. */
function nombreBase(nombre: string): string {
  return normalizeText(nombre.replace(/\(.*?\)/g, " "))
    .replace(/\b(s a u|s a|sa|sau|srl|sucursal argentina|argentina)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Número de una planta ("Planta 1" -> 1, código "000003" -> 3). */
function numeroPlanta(p: Planta): number[] {
  const nums = new Set<number>();
  const m = normalizeText(p.nombre).match(/\d+/);
  if (m) nums.add(Number(m[0]));
  nums.add(Number(p.codigo));
  return [...nums];
}

export function resolverCliente(texto: string, clientes: Cliente[]): Cliente | undefined {
  const t = normalizeText(texto);
  const codigos: string[] = t.match(/\b\d{6}\b/g) ?? [];
  const porCodigo = clientes.find((c) => codigos.includes(c.codigo));
  if (porCodigo) return porCodigo;

  // Gana la coincidencia más larga ("total austral" sobre "total").
  let mejor: { c: Cliente; largo: number } | undefined;
  for (const c of clientes) {
    for (const cand of [nombreBase(c.nombre), ...c.alias.map(normalizeText)]) {
      if (cand && containsWords(t, cand) && (!mejor || cand.length > mejor.largo)) mejor = { c, largo: cand.length };
    }
  }
  return mejor?.c;
}

export function resolverPlanta(texto: string, cliente: Cliente): Planta | undefined {
  const t = normalizeText(texto);
  // Códigos: el de planta es el de 6 dígitos que no es el del cliente.
  const codigos = (t.match(/\b\d{6}\b/g) ?? []).filter((c) => c !== cliente.codigo);
  const porCodigo = cliente.plantas.find((p) => codigos.includes(p.codigo));
  if (porCodigo) return porCodigo;

  for (const p of cliente.plantas) {
    for (const cand of [normalizeText(p.nombre), ...p.alias.map(normalizeText)]) {
      if (cand && containsWords(t, cand)) return p;
    }
  }
  // "planta 2", "pta 2", "p2", "planta2"
  const m = t.match(/\b(?:planta|pta|pl|p)\s*(\d{1,3})\b/);
  if (m) {
    const n = Number(m[1]);
    const p = cliente.plantas.find((x) => numeroPlanta(x).includes(n));
    if (p) return p;
  }
  // Una sola planta y el texto termina en un número suelto ("vista 1").
  const suelto = t.match(/\b(\d{1,3})$/);
  if (suelto) return cliente.plantas.find((x) => numeroPlanta(x).includes(Number(suelto[1])));
  return undefined;
}

// --- "¿Quisiste decir...?" ------------------------------------------------------------

/** Distancia de edición (letras cambiadas, de más o de menos). */
function distancia(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Errores de tipeo tolerados según el largo: "tatal" -> "total" sí, "shell" -> "total" no. */
const tolerancia = (largo: number) => (largo <= 3 ? 0 : largo <= 5 ? 1 : largo <= 9 ? 2 : 3);

/** Palabras que nombran al cliente o la planta (sin números ni "planta", "pta"...). */
function palabras(texto: string): string[] {
  return normalizeText(texto)
    .split(" ")
    .filter((w) => w && !/\d/.test(w) && !/^(planta|pta|pl|p|subcliente|cliente|de|la|el|en)$/.test(w));
}

/**
 * Qué tan parecido es el texto a un nombre: compara el nombre con cada tramo
 * del texto de la misma cantidad de palabras (y la primera palabra del nombre
 * sola: "tatal" por "total austral"). Devuelve el error relativo o null si no
 * se parece lo suficiente.
 */
function parecido(texto: string[], nombre: string): number | null {
  const nom = nombre.split(" ").filter(Boolean);
  if (!nom.length) return null;
  const opciones = [nom.join(" ")];
  if (nom.length > 1 && nom[0]!.length >= 4) opciones.push(nom[0]!);
  let mejor: number | null = null;
  for (const op of opciones) {
    const k = op.split(" ").length;
    for (let i = 0; i + k <= texto.length; i++) {
      const tramo = texto.slice(i, i + k).join(" ");
      const d = distancia(tramo, op);
      if (d <= tolerancia(op.length)) {
        const relativo = d / op.length;
        if (mejor === null || relativo < mejor) mejor = relativo;
      }
    }
  }
  return mejor;
}

/** El candidato más parecido; si dos distintos empatan, ninguno (no se adivina). */
function masParecido<T>(texto: string[], candidatos: Array<{ item: T; nombres: string[] }>): T | undefined {
  let mejor: { item: T; error: number } | undefined;
  let empate = false;
  for (const { item, nombres } of candidatos) {
    const errores = nombres.map((n) => parecido(texto, n)).filter((e): e is number => e !== null);
    if (!errores.length) continue;
    const error = Math.min(...errores);
    if (!mejor || error < mejor.error) {
      mejor = { item, error };
      empate = false;
    } else if (error === mejor.error && item !== mejor.item) {
      empate = true;
    }
  }
  return mejor && !empate ? mejor.item : undefined;
}

/** Planta que se parece a lo escrito ("loma canpana" -> "Loma Campana"). */
export function sugerirPlanta(texto: string, cliente: Cliente): Planta | undefined {
  const exacta = resolverPlanta(texto, cliente);
  if (exacta) return exacta;
  return masParecido(
    palabras(texto),
    cliente.plantas.map((p) => ({ item: p, nombres: [normalizeText(p.nombre), ...p.alias.map(normalizeText)].filter((n) => !/^planta \d+$/.test(n)) })),
  );
}

/**
 * Sugerencia cuando lo escrito no coincide con ningún cliente pero se parece
 * a uno ("tatal planta 1" -> Total Austral – Planta 1). Nunca se aplica sola:
 * el bot pregunta "¿Quisiste decir...?".
 */
export function sugerir(texto: string, clientes: Cliente[]): Resolucion | undefined {
  const cliente = masParecido(
    palabras(texto),
    clientes.map((c) => ({ item: c, nombres: [nombreBase(c.nombre), ...c.alias.map(normalizeText)] })),
  );
  return cliente ? { cliente, planta: sugerirPlanta(texto, cliente) } : undefined;
}

export function resolver(texto: string, clientes: Cliente[]): Resolucion {
  const cliente = resolverCliente(texto, clientes);
  return cliente ? { cliente, planta: resolverPlanta(texto, cliente) } : {};
}

/** "TOTAL AUSTRAL (PRUEBA) – Planta 1" */
export function etiqueta(cliente: Cliente | undefined, planta: Planta | undefined, clienteCodigo?: string, plantaCodigo?: string): string {
  const c = cliente?.nombre ?? `Cliente ${clienteCodigo ?? "?"}`;
  const p = planta?.nombre ?? `Planta ${plantaCodigo ?? "?"}`;
  return `${c} – ${p}`;
}

/** Nombre corto para botones ("TOTAL AUSTRAL (PRUEBA)" -> "Total Austral"). */
export function nombreCorto(nombre: string): string {
  return nombreBase(nombre)
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function buscar(clientes: Cliente[], clienteCodigo?: string, plantaCodigo?: string): Resolucion {
  const cliente = clientes.find((c) => c.codigo === clienteCodigo);
  return { cliente, planta: cliente?.plantas.find((p) => p.codigo === plantaCodigo) };
}
