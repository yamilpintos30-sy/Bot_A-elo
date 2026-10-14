/**
 * Fechas "de calendario" (año, mes, día), sin horas ni zonas horarias.
 *
 * La API de Vencimientos Añelo usa el formato dd-MM-yyyy (ej. 31-12-2027) tanto
 * para cargar como en las respuestas. Los carnets traen dd/mm/aaaa. Todo se
 * normaliza a CalendarDate y se compara contra "hoy" en la zona horaria del bot.
 */

export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** ¿Existe esa fecha en el calendario? (descarta 31-02, 00-13, etc.) */
function isRealDate(d: CalendarDate): boolean {
  if (d.year < 2000 || d.year > 2100 || d.month < 1 || d.month > 12 || d.day < 1) return false;
  const lastDay = new Date(Date.UTC(d.year, d.month, 0)).getUTCDate();
  return d.day <= lastDay;
}

/**
 * Interpreta "dd-MM-yyyy", "dd/MM/yyyy" o "yyyy-MM-dd(...)". Devuelve null si
 * el texto no es una fecha real.
 */
export function parseCalendarDate(value: string | null | undefined): CalendarDate | null {
  if (!value) return null;
  const v = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  const latam = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(v);
  let d: CalendarDate | null = null;
  if (iso) d = { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  else if (latam) d = { year: Number(latam[3]), month: Number(latam[2]), day: Number(latam[1]) };
  return d && isRealDate(d) ? d : null;
}

/** Formato que exige la API para el vencimiento: "31-12-2027". */
export function formatApi(d: CalendarDate): string {
  return `${String(d.day).padStart(2, "0")}-${String(d.month).padStart(2, "0")}-${d.year}`;
}

/** "31 de diciembre de 2027" (para mostrar por WhatsApp). */
export function formatLong(d: CalendarDate): string {
  return `${d.day} de ${MESES[d.month - 1]} de ${d.year}`;
}

/** Día de hoy (fecha de calendario) en la zona horaria indicada. */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function toDayNumber(d: CalendarDate): number {
  return Math.round(Date.UTC(d.year, d.month - 1, d.day) / 86_400_000);
}

/** b - a en días (positivo si b es posterior a a). */
export function diffDays(a: CalendarDate, b: CalendarDate): number {
  return toDayNumber(b) - toDayNumber(a);
}
