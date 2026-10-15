/** Utilidades de texto (copiadas y adaptadas de Enri). */

/**
 * Minúsculas, sin tildes, sin emojis ni símbolos, sin espacios repetidos.
 * Clave para los botones: "📄 Ver carnet" debe coincidir con "ver carnet".
 */
export function normalizeText(input: string): string {
  return (input ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** ¿`needle` aparece en `haystack` como palabras completas? (ambos normalizados) */
export function containsWords(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/** WhatsApp limita cada mensaje a 4096 caracteres; se parte por párrafos. */
export function splitForWhatsApp(text: string, maxLength = 4000): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\n/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxLength && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * WhatsApp rechaza botones si el texto que los acompaña supera 1024
 * caracteres. Parte el texto en [cabeza, cola] para que la cola entre con los
 * botones; corta entre párrafos, después entre líneas y por último entre palabras.
 */
export function splitForButtons(text: string, maxLength = 1000): string[] {
  if (text.length <= maxLength) return [text];
  const minTailStart = text.length - maxLength;
  for (const sep of ["\n\n", "\n", " "]) {
    let idx = text.indexOf(sep, Math.max(1, minTailStart - sep.length));
    while (idx !== -1) {
      const head = text.slice(0, idx).trimEnd();
      const tail = text.slice(idx + sep.length).trimStart();
      if (head && tail && tail.length <= maxLength) return [head, tail];
      idx = text.indexOf(sep, idx + 1);
    }
  }
  return [text.slice(0, minTailStart), text.slice(minTailStart)];
}

/** Título de botón de WhatsApp: máximo 20 caracteres. */
export function buttonTitle(text: string): string {
  return text.length <= 20 ? text : `${text.slice(0, 19).trimEnd()}…`;
}
