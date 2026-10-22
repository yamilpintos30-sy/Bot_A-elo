/**
 * Validación y normalización de identificadores.
 *
 * Se usan en dos lugares: lo que escribe la gente por WhatsApp y lo que extrae
 * la IA de los carnets. En el segundo caso son el control "sin IA" que decide
 * si un carnet puede cargarse en SEA WHITE.
 *
 * Formatos que exige la API de Vencimientos Añelo:
 *   - DNI: sólo números, sin puntos (ej. 30123456)
 *   - Dominio: mayúsculas, sin espacios (ej. AA123BB)
 */

export interface ValidationResult {
  ok: boolean;
  /** Valor normalizado listo para enviar a la API. */
  value: string;
  /** Explicación amigable cuando `ok` es false. */
  error?: string;
}

/**
 * DNI dentro de un CUIT/CUIL ("20-38925270-1" -> "38925270"). Se valida el
 * dígito verificador para no confundir un CUIT con cualquier número de 11
 * cifras. Devuelve undefined si no es un CUIT válido.
 */
export function dniFromCuit(digits: string): string | undefined {
  if (!/^(20|23|24|25|26|27|30|33|34)\d{9}$/.test(digits)) return undefined;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, peso, i) => acc + peso * Number(digits[i]), 0);
  const resto = suma % 11;
  const verificador = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;
  if (verificador !== Number(digits[10])) return undefined;
  return digits.slice(2, 10).replace(/^0+/, "");
}

/** DNI: acepta "30.123.456", "30123456", "dni 30123456" y el CUIT/CUIL que lo contiene. */
export function normalizeDni(input: string): ValidationResult {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 0) {
    return { ok: false, value: "", error: "No encontré un número de DNI. Escribilo sólo con números, sin puntos. Ejemplo: 30123456" };
  }
  if (digits.length === 11) {
    const desdeCuit = dniFromCuit(digits);
    if (desdeCuit) return { ok: true, value: desdeCuit };
    return { ok: false, value: digits, error: "Ese número de 11 cifras no es un CUIT/CUIL válido. Mandame el DNI (7 u 8 números, sin puntos)." };
  }
  if (digits.length < 7 || digits.length > 8) {
    return { ok: false, value: digits, error: "El DNI tiene que tener 7 u 8 números, sin puntos. Ejemplo: 30123456" };
  }
  return { ok: true, value: digits };
}

/**
 * DNI escrito dentro de una frase ("puedo entrar? 33.615.617"). Devuelve los
 * dígitos sólo si hay UN único número de 7 u 8 cifras (o un CUIT/CUIL válido).
 * Ignora los códigos de 6 cifras (cliente/planta) y números más largos.
 */
export function findDniInText(input: string): string | undefined {
  const cuits = new Set(
    (input.match(/(?<!\d)\d{2}[\s.\-]?\d{8}[\s.\-]?\d(?!\d)/g) ?? []).map((m) => dniFromCuit(m.replace(/\D/g, ""))).filter(Boolean) as string[],
  );
  if (cuits.size === 1) return [...cuits][0];
  const found = new Set((input.match(/(?<![\d.\-])\d{1,2}\.?\d{3}\.?\d{3}(?!\d|[.\-]\d)/g) ?? []).map((m) => m.replace(/\D/g, "")));
  const dnis = [...found].filter((d) => d.length >= 7);
  return dnis.length === 1 ? dnis[0] : undefined;
}

/** Patente dentro de una frase (AA123BB, ABC123, 1234ABC). Sólo si hay UNA. */
export function findPatenteInText(input: string): string | undefined {
  const pattern = /(?<![A-Z0-9])([A-Z]{2}[\s-]?\d{3}[\s-]?[A-Z]{2}|[A-Z]{3}[\s-]?\d{3}|\d{3,4}[\s-]?[A-Z]{3})(?![A-Z0-9])/g;
  const found = new Set((input.toUpperCase().match(pattern) ?? []).map((m) => m.replace(/[\s-]/g, "")));
  return found.size === 1 ? [...found][0] : undefined;
}

/** ¿El texto es un DNI (o el CUIT/CUIL que lo contiene) y nada más? */
export function looksLikeDni(input: string): boolean {
  const cleaned = input.replace(/[\s.\-]/g, "").replace(/^(dni|cuit|cuil):?/i, "");
  if (/^\d{7,8}$/.test(cleaned)) return true;
  return cleaned.length === 11 && dniFromCuit(cleaned) !== undefined;
}

/**
 * Patente/dominio: acepta "AA 123 BB", "aa-123-bb", "ABC123", "2367FUT".
 * Devuelve mayúsculas sin espacios, puntos ni guiones.
 */
export function normalizePatente(input: string): ValidationResult {
  const cleaned = input
    .toUpperCase()
    .replace(/^(PATENTE|DOMINIO)\s*:?\s*/i, "")
    .replace(/[\s.\-_/]/g, "");
  if (cleaned.length === 0) {
    return { ok: false, value: "", error: "No encontré la patente. Escribila toda junta, sin espacios ni guiones. Ejemplo: AA123BB" };
  }
  if (!/^[A-Z0-9]{6,8}$/.test(cleaned) || !/\d/.test(cleaned) || !/[A-Z]/.test(cleaned)) {
    return { ok: false, value: cleaned, error: "Esa patente no parece válida. Escribila con letras y números, sin espacios. Ejemplo: AA123BB o ABC123" };
  }
  return { ok: true, value: cleaned };
}

/** ¿El texto parece ser una patente y nada más? */
export function looksLikePatente(input: string): boolean {
  const cleaned = input.toUpperCase().replace(/^(PATENTE|DOMINIO)\s*:?\s*/i, "").replace(/[\s.\-_/]/g, "");
  return /^[A-Z0-9]{6,8}$/.test(cleaned) && /\d/.test(cleaned) && /[A-Z]/.test(cleaned);
}

/**
 * Código de cliente o subcliente: sólo números, y se respetan los ceros a la
 * izquierda tal como vienen (hoy 4 dígitos: 0001, 0000; antes eran 6).
 */
export function isCodigoValido(codigo: string): boolean {
  return /^\d{1,10}$/.test(codigo);
}

/** "PEREZ, JUAN CARLOS" -> "JUAN CARLOS PEREZ" (razón social del chofer para la API). Sin coma, queda igual. */
export function nombreYApellido(apellidoNombre: string | null | undefined): string | null {
  const t = (apellidoNombre ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const [apellido, nombre] = t.split(",").map((x) => x.trim());
  return apellido && nombre ? `${nombre} ${apellido}` : t.replace(/,/g, "").trim();
}
