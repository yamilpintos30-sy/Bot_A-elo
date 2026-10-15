/**
 * Verifica qué quedó grabado en SEA WHITE después de las pruebas de carga.
 * SÓLO LECTURA: usa las consultas GET de Vencimientos Añelo con la carga
 * deshabilitada a la fuerza (aunque el .env diga otra cosa).
 *
 *   npm run verificar -- [cliente] [subcliente]     (por defecto 999991 000001)
 *
 * Toma la lista de DNI y patentes esperados de las salidas del extractor
 * (salida-extraccion/) y deja un informe en datos-prueba/verificacion-seawhite.md
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseConfig, seawhiteSchema } from "../config.js";
import { AneloClient } from "../integrations/seawhite/aneloClient.js";
import type { TipoRegistro } from "../integrations/seawhite/types.js";
import { logger } from "../utils/logger.js";

interface Esperado {
  tipo: TipoRegistro;
  identificador: string;
  nombre: string | null;
  vencimiento: string;
  origen: string;
}

async function esperados(): Promise<Esperado[]> {
  const base = path.resolve("salida-extraccion");
  const lista: Esperado[] = [];
  const vistos = new Set<string>();
  for (const dir of await readdir(base)) {
    const resumen = JSON.parse(await readFile(path.join(base, dir, "resumen.json"), "utf8")) as {
      archivo: string;
      aceptados: Array<{ tipo: TipoRegistro; identificador: string; apellidoNombre: string | null; vencimiento: string; clienteDetectado: string | null }>;
    };
    for (const c of resumen.aceptados) {
      // Las pruebas se cargaron en Total: sólo los carnets de Total.
      if (!/total/i.test(c.clienteDetectado ?? "")) continue;
      const clave = `${c.tipo}:${c.identificador}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      lista.push({ tipo: c.tipo, identificador: c.identificador, nombre: c.apellidoNombre, vencimiento: c.vencimiento, origen: resumen.archivo });
    }
  }
  return lista;
}

async function main(): Promise<void> {
  const [cliente = "999991", subcliente = "000001"] = process.argv.slice(2);
  const config = parseConfig(seawhiteSchema);
  const client = new AneloClient({
    baseUrl: config.SEALINK_BASE_URL,
    email: config.SEALINK_EMAIL,
    password: config.SEALINK_PASSWORD,
    servidor: config.SEALINK_SERVIDOR,
    timeoutMs: config.SEALINK_TIMEOUT_MS,
    cargaHabilitada: false, // SÓLO LECTURA, siempre.
    modoPrueba: true,
    prefijoPrueba: "9999",
    logger,
  });

  const lista = await esperados();
  const filas: string[] = [];
  let encontrados = 0;
  let coinciden = 0;
  let conPdf = 0;
  for (const e of lista) {
    const r = await client.consultar(e.tipo, cliente, subcliente, e.identificador);
    if (!r.found) {
      filas.push(`| ${e.tipo} | ${e.identificador} | ${e.nombre ?? ""} | ${e.vencimiento} | ❌ NO ESTÁ | | | |`);
      continue;
    }
    encontrados++;
    const ok = r.vencimiento === e.vencimiento;
    if (ok) coinciden++;
    let pdf = "❌";
    try {
      const bytes = await client.descargarPdf(e.tipo, r.id);
      pdf = `✅ ${Math.round(bytes.length / 1024)} KB`;
      conPdf++;
    } catch {
      pdf = "❌ no se pudo bajar";
    }
    const alta = r.fechaModificacion ? `${r.fechaAlta ?? ""} (mod. ${r.fechaModificacion})` : (r.fechaAlta ?? "");
    filas.push(`| ${e.tipo} | ${e.identificador} | ${e.nombre ?? ""} | ${e.vencimiento} | ${r.id} | ${r.vencimiento}${ok ? "" : " ⚠️ distinto"} | ${alta} | ${pdf} |`);
  }

  const informe = [
    `# Verificación de cargas de prueba en SEA WHITE`,
    ``,
    `- Fecha de la verificación: ${new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })}`,
    `- API: ${config.SEALINK_BASE_URL} · Servidor=${config.SEALINK_SERVIDOR} · Cliente=${cliente} · Subcliente=${subcliente}`,
    `- Método: sólo consultas GET /api/VencimientosAnelo/{chofer|dominio} y /{servidor}/{id}/pdf (no se escribió nada).`,
    ``,
    `**Resultado:** ${encontrados} de ${lista.length} registros encontrados · ${coinciden} con el vencimiento esperado · ${conPdf} con PDF descargable.`,
    ``,
    `| Tipo | DNI / Dominio | Nombre (del carnet) | Vencimiento esperado | ID SEA WHITE | Vencimiento grabado | Alta | PDF |`,
    `|---|---|---|---|---|---|---|---|`,
    ...filas,
  ].join("\n");

  await mkdir("datos-prueba", { recursive: true });
  await writeFile(path.join("datos-prueba", "verificacion-seawhite.md"), informe);
  console.log(`\n${informe}\n\nInforme guardado en datos-prueba/verificacion-seawhite.md\n`);
}

main().catch((err) => {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
