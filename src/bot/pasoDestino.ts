/**
 * Paso "cliente y subcliente", igual para la carga y para la consulta.
 *
 * Solo se pregunta por texto: no se muestran botones ni listas de clientes o
 * plantas (van a ser muchísimas). Si lo escrito no coincide pero se parece a
 * algo que existe, se pregunta "¿Quisiste decir ...?" con [Sí] [No]; nunca se
 * aplica una sugerencia sin que la confirme.
 */
import { findDniInText, findPatenteInText } from "../domain/validators.js";
import type { Cliente } from "../storage/catalogo.js";
import { normalizeText } from "../utils/text.js";
import { buscar, nombreCorto, resolverCliente, resolverPlanta, sugerir, sugerirPlanta } from "./catalogo.js";
import { DESTINO } from "./texts.js";
import type { ButtonSpec, Outbound } from "./types.js";

/** Lo que el paso necesita del estado de cada flujo (CargadorState y ConsultaState lo tienen). */
export interface EstadoDestino {
  clienteCodigo?: string;
  plantaCodigo?: string;
  /** "¿Quisiste decir ...?" pendiente de respuesta. */
  sugerencia?: { clienteCodigo: string; plantaCodigo?: string };
  /** Ya se le pidió (para decir "no encontré ese cliente" recién después). */
  pidioPlanta?: boolean;
}

export type ResultadoDestino =
  /** Cliente y subcliente elegidos. `reconocio`: los dio en este mensaje. */
  | { listo: true; reconocio: boolean }
  | { listo: false; salida: Outbound[] };

const SI: ButtonSpec = { title: "✅ Sí", payload: "sug:si" };
const NO: ButtonSpec = { title: "✏️ No", payload: "sug:no" };

function siNo(texto: string): "si" | "no" | undefined {
  const t = normalizeText(texto);
  if (/^(si|s|dale|ok|correcto|exacto|eso|esa|ese|si esa|si ese)$/.test(t)) return "si";
  if (/^(no|nop|nope|no es|no esa|no ese)$/.test(t)) return "no";
  return undefined;
}

/** Saludos, DNI o patentes no son un intento de escribir el cliente. */
function esIntento(texto: string): boolean {
  const t = normalizeText(texto);
  if (!t || /^(hola+|buenas|buen dia|buenos dias|buenas tardes|buenas noches|hey|que tal)\b/.test(t)) return false;
  return !findDniInText(texto) && !findPatenteInText(texto);
}

/** Lo que queda del texto sin el nombre del cliente: si hay algo, intentó nombrar el subcliente. */
function nombraSubcliente(texto: string, cliente: Cliente): boolean {
  let t = normalizeText(texto);
  for (const n of [cliente.codigo, normalizeText(cliente.nombre.replace(/\(.*?\)/g, " ")), ...cliente.alias.map(normalizeText)]) {
    if (n) t = t.replace(n, " ");
  }
  return /\w/.test(t.replace(/\b(de|en|la|el|cliente|subcliente)\b/g, " "));
}

export function pasoDestino(st: EstadoDestino, texto: string, payload: string | undefined, clientes: Cliente[], pregunta: string): ResultadoDestino {
  const pedir = (text: string): ResultadoDestino => {
    st.pidioPlanta = true;
    return { listo: false, salida: [{ kind: "text", text }] };
  };
  /**
   * Pregunta [Sí] [No] por un cliente y subcliente: SIEMPRE, sea coincidencia
   * exacta ("Encontré X. ¿Es correcto?") o parecida ("¿Quisiste decir X?").
   * Hasta el Sí no queda elegido nada.
   */
  const confirmar = (clienteCodigo: string, plantaCodigo: string | undefined, parecido: boolean): ResultadoDestino => {
    const { cliente, planta } = buscar(clientes, clienteCodigo, plantaCodigo);
    st.sugerencia = { clienteCodigo, plantaCodigo };
    st.clienteCodigo = undefined;
    st.plantaCodigo = undefined;
    const nombre = `${nombreCorto(cliente!.nombre)}${planta ? ` – ${planta.nombre}` : ""}`;
    return { listo: false, salida: [{ kind: "buttons", text: parecido ? DESTINO.quisisteDecir(nombre) : DESTINO.confirmar(nombre), buttons: [SI, NO] }] };
  };

  // 1. Respuesta a la confirmación.
  let confirmado = false;
  if (st.sugerencia) {
    const sug = st.sugerencia;
    st.sugerencia = undefined;
    const resp = payload === "sug:si" ? "si" : payload === "sug:no" ? "no" : siNo(texto);
    if (resp === "no") return pedir(DESTINO.reescribir);
    if (resp === "si") {
      st.clienteCodigo = sug.clienteCodigo;
      st.plantaCodigo = sug.plantaCodigo;
      confirmado = true;
      texto = ""; // ya se usó
    }
    // Otra cosa: se toma como un nuevo intento.
  }
  const antes = `${st.clienteCodigo}/${st.plantaCodigo}`;

  // 2. Coincidencia exacta (nombre, alias o código).
  if (texto.trim()) {
    const cliente = resolverCliente(texto, clientes);
    if (cliente) {
      if (cliente.codigo !== st.clienteCodigo) st.plantaCodigo = undefined;
      st.clienteCodigo = cliente.codigo;
    }
    const actual = clientes.find((c) => c.codigo === st.clienteCodigo);
    const planta = actual ? resolverPlanta(texto, actual) : undefined;
    if (planta) st.plantaCodigo = planta.codigo;
  }

  // 3. Sin cliente: sugerencia o volver a pedir.
  const { cliente } = buscar(clientes, st.clienteCodigo, st.plantaCodigo);
  if (!cliente) {
    if (!esIntento(texto)) return pedir(pregunta);
    const s = sugerir(texto, clientes);
    if (s?.cliente) return confirmar(s.cliente.codigo, s.planta?.codigo, true);
    return pedir(st.pidioPlanta ? DESTINO.clienteNoEncontrado : pregunta);
  }

  // 4. Cliente sin subcliente.
  if (!st.plantaCodigo) {
    if (cliente.plantas.length === 1) {
      st.plantaCodigo = cliente.plantas[0]!.codigo;
    } else if (texto.trim() && nombraSubcliente(texto, cliente)) {
      const p = sugerirPlanta(texto, cliente);
      if (p) return confirmar(cliente.codigo, p.codigo, true);
      return pedir(DESTINO.plantaNoEncontrada(nombreCorto(cliente.nombre)));
    } else {
      return pedir(DESTINO.elegirPlanta(nombreCorto(cliente.nombre)));
    }
  }

  // 5. Cliente y subcliente completos. Si cambiaron en este mensaje y no vienen
  //    de un Sí, se confirman antes de seguir.
  const cambio = `${st.clienteCodigo}/${st.plantaCodigo}` !== antes;
  if (cambio && !confirmado) return confirmar(st.clienteCodigo!, st.plantaCodigo, false);
  return { listo: true, reconocio: cambio || confirmado };
}
