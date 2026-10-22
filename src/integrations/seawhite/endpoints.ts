/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  REGLA Nº 1 DEL PROYECTO: EL SERVIDOR DE SEA WHITE SE CONSULTA, NO SE      ║
 * ║  EDITA. ÚNICA EXCEPCIÓN, autorizada por Yamil el 2026-10-13 y sólo para    ║
 * ║  este bot: los dos POST de carga de Vencimientos Añelo (chofer y dominio). ║
 * ║                                                                            ║
 * ║  La lista blanca es por MÉTODO + RUTA. Cualquier otra combinación lanza    ║
 * ║  error ANTES de salir a la red. NO agregar endpoints de alta,              ║
 * ║  modificación ni borrado sin una nueva autorización explícita de Yamil.    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */
import { SeaWhiteError } from "./types.js";

export type HttpMethod = "GET" | "POST";

interface AllowedEndpoint {
  method: HttpMethod;
  /** Ruta exacta o patrón (para las rutas con {servidor}/{id}). */
  path: string | RegExp;
  /** true = escribe en SEA WHITE (sólo los dos POST de carga autorizados). */
  writes: boolean;
  description: string;
}

export const SEAWHITE_ALLOWED_ENDPOINTS: readonly AllowedEndpoint[] = [
  // Autenticación (sólo valida credenciales y devuelve un token).
  { method: "POST", path: "/api/autenticacion/validar", writes: false, description: "login (token JWT)" },
  { method: "GET", path: "/api/autenticacion/me", writes: false, description: "verificar token" },
  // Documentación general del chofer/camión (las mismas consultas que usa Enri).
  // Son POST porque la API recibe los filtros en el cuerpo, pero SÓLO CONSULTAN.
  { method: "POST", path: "/api/vencimientos/chofer", writes: false, description: "licencia, ART y F.931 del chofer" },
  { method: "POST", path: "/api/vencimientos/camion", writes: false, description: "seguro y VTV del camión" },
  // Nombre del chofer por su teléfono, para saludarlo como Enri (anexo del manual, sólo consulta).
  { method: "POST", path: "/api/vencimientos/chofer/telefono", writes: false, description: "nombre del chofer por teléfono" },
  // Comprobantes de VTV y seguro por dominio ("Manual_API_DocumentosVehiculos_BOT.pdf").
  // Sólo lectura: devuelve el PDF. Dominio en mayúsculas, sin ".pdf".
  { method: "GET", path: /^\/api\/DocumentosVehiculos\/(vtv|seguro)\/[A-Z0-9]{6,8}$/, writes: false, description: "PDF de VTV o seguro" },
  // Consultas de Vencimientos Añelo.
  { method: "GET", path: "/api/VencimientosAnelo/chofer", writes: false, description: "consulta de chofer" },
  { method: "GET", path: "/api/VencimientosAnelo/dominio", writes: false, description: "consulta de dominio" },
  { method: "GET", path: /^\/api\/VencimientosAnelo\/chofer\/\d+\/\d+\/pdf$/, writes: false, description: "PDF de chofer" },
  { method: "GET", path: /^\/api\/VencimientosAnelo\/dominio\/\d+\/\d+\/pdf$/, writes: false, description: "PDF de dominio" },
  // "Manual_BOT_Endpoints_Vencimientos_Anelo_Con_JSON.pdf" (sólo lectura): en qué clientes
  // y subclientes tiene habilitación vigente un DNI (1 y 2) o un dominio (7 y 8).
  { method: "GET", path: /^\/api\/VencimientosAnelo\/clientes\/\d{7,8}$/, writes: false, description: "clientes de un DNI (API 1)" },
  { method: "GET", path: /^\/api\/VencimientosAnelo\/subclientes\/\d{7,8}\/\d{1,10}$/, writes: false, description: "subclientes de un DNI y cliente (API 2)" },
  { method: "GET", path: /^\/api\/VencimientosAnelo\/clientes-dominio\/[A-Z0-9]{6,8}$/, writes: false, description: "clientes de un dominio (API 7)" },
  { method: "GET", path: /^\/api\/VencimientosAnelo\/subclientes-dominio\/[A-Z0-9]{6,8}\/\d{1,10}$/, writes: false, description: "subclientes de un dominio y cliente (API 8)" },
  // Logística (mismo manual, sólo lectura): listados grupales y búsqueda por nombre.
  { method: "GET", path: "/api/VencimientosAnelo/clientes-habilitados", writes: false, description: "clientes con choferes vigentes (API 3)" },
  { method: "GET", path: /^\/api\/VencimientosAnelo\/subclientes-habilitados\/\d{1,10}$/, writes: false, description: "subclientes con choferes vigentes (API 4)" },
  { method: "GET", path: /^\/api\/VencimientosAnelo\/choferes-habilitados\/\d{1,10}\/\d{1,10}$/, writes: false, description: "choferes vigentes de un cliente y subcliente (API 5)" },
  { method: "GET", path: /^\/api\/VencimientosAnelo\/buscar-choferes\/[A-Za-z0-9%._~-]{3,150}$/, writes: false, description: "buscar choferes por nombre (API 6)" },
  { method: "GET", path: "/api/VencimientosAnelo/clientes-habilitados-dominio", writes: false, description: "clientes con dominios vigentes (API 9)" },
  { method: "GET", path: /^\/api\/VencimientosAnelo\/subclientes-habilitados-dominio\/\d{1,10}$/, writes: false, description: "subclientes con dominios vigentes (API 10)" },
  { method: "GET", path: /^\/api\/VencimientosAnelo\/dominios-habilitados\/\d{1,10}\/\d{1,10}$/, writes: false, description: "dominios vigentes de un cliente y subcliente (API 11)" },
  // EXCEPCIÓN AUTORIZADA (2026-10-13): carga de vencimientos.
  { method: "POST", path: "/api/VencimientosAnelo/chofer", writes: true, description: "CARGA de vencimientos de chofer" },
  { method: "POST", path: "/api/VencimientosAnelo/dominio", writes: true, description: "CARGA de vencimientos de dominio" },
];

function matches(endpoint: AllowedEndpoint, method: HttpMethod, path: string): boolean {
  if (endpoint.method !== method) return false;
  return typeof endpoint.path === "string" ? endpoint.path === path : endpoint.path.test(path);
}

/**
 * Verifica que (método, ruta) esté en la lista blanca. Devuelve si la llamada
 * escribe, para que el cliente aplique los controles extra de la carga.
 */
export function assertAllowedEndpoint(method: HttpMethod, path: string): { writes: boolean } {
  const found = SEAWHITE_ALLOWED_ENDPOINTS.find((e) => matches(e, method, path));
  if (!found) {
    throw new SeaWhiteError(`BLOQUEADO: ${method} ${path} no está en la lista blanca. El servidor de SEA WHITE sólo admite las consultas y las dos cargas autorizadas.`);
  }
  return { writes: found.writes };
}
