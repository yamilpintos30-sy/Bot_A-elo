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
