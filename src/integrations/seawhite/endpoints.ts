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
  // Consultas de Vencimientos Añelo.
  { method: "GET", path: "/api/VencimientosAnelo/chofer", writes: false, description: "consulta de chofer" },
  { method: "GET", path: "/api/VencimientosAnelo/dominio", writes: false, description: "consulta de dominio" },
  { method: "GET", path: /^\/api\/VencimientosAnelo\/chofer\/\d+\/\d+\/pdf$/, writes: false, description: "PDF de chofer" },
  { method: "GET", path: /^\/api\/VencimientosAnelo\/dominio\/\d+\/\d+\/pdf$/, writes: false, description: "PDF de dominio" },
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
