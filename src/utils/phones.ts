/**
 * Normalización de teléfonos argentinos para comparar números de WhatsApp.
 *
 * Chatwoot entrega "+5492914413200"; en el .txt de cargadores alguien puede
 * escribir "2914413200", "0291 15 441-3200" o "+54 9 291 441 3200". Todos se
 * reducen a los 10 dígitos nacionales (característica + número, sin 0 ni 15)
 * para que la comparación no dependa de cómo se escribió.
 */

/** Devuelve los 10 dígitos nacionales, o null si no parece un celular argentino. */
export function nationalPhone(input: string): string | null {
  let d = (input ?? "").replace(/\D/g, "");
  if (d.startsWith("549")) d = d.slice(3);
  else if (d.startsWith("54")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  // "291 15 4413200": el 15 va después de la característica (2 a 4 dígitos).
  if (d.length === 12) {
    for (const areaLen of [2, 3, 4]) {
      if (d.slice(areaLen, areaLen + 2) === "15") {
        d = d.slice(0, areaLen) + d.slice(areaLen + 2);
        break;
      }
    }
  }
  return /^\d{10}$/.test(d) ? d : null;
}

/** ¿Los dos textos son el mismo teléfono? */
export function samePhone(a: string, b: string): boolean {
  const na = nationalPhone(a);
  return na !== null && na === nationalPhone(b);
}

/**
 * Lee el contenido de un .txt de teléfonos (uno por línea; se toleran comas,
 * punto y coma y comentarios con #). Devuelve los válidos sin repetir y las
 * líneas que no se pudieron interpretar, para avisarle a quien lo subió.
 */
export function parsePhoneList(content: string): { phones: string[]; invalid: string[] } {
  const phones = new Set<string>();
  const invalid: string[] = [];
  for (const raw of content.split(/[\r\n,;]+/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const n = nationalPhone(line);
    if (n) phones.add(n);
    else invalid.push(line);
  }
  return { phones: [...phones], invalid };
}
