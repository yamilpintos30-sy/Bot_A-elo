/**
 * Formateo de nombres (copiado de Enri). La API SeaLink devuelve la razón social como
 * "APELLIDO, NOMBRES"; para el saludo se usa el nombre completo presentable:
 * "MENTASTI, PEDRO CARLOS" -> "Pedro Carlos Mentasti".
 */

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Nombre completo presentable: "MENTASTI, PEDRO CARLOS" -> "Pedro Carlos Mentasti". */
export function nombreCompleto(razonSocial: string | null | undefined): string {
  const raw = (razonSocial ?? "").trim();
  if (!raw) return "";
  const comma = raw.indexOf(",");
  const full = comma >= 0 ? `${raw.slice(comma + 1).trim()} ${raw.slice(0, comma).trim()}` : raw;
  const words = full.split(/\s+/).filter((w) => /^[a-záéíóúüñ.'-]+$/i.test(w));
  if (words.length === 0) return "";
  return words.map(titleCase).join(" ");
}
