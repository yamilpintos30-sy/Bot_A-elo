/**
 * Prueba del extractor con un PDF local. NO toca SEA WHITE ni Chatwoot.
 *
 *   npm run extraer -- "ruta/al/archivo.pdf" [carpeta-de-salida]
 *
 * Guarda en la carpeta de salida (por defecto salida-extraccion/<nombre>/):
 *   - un PDF por carnet aceptado (<DNI>.pdf / <PATENTE>.pdf)
 *   - resumen.json con aceptados, rechazados, costo y lo que devolvió el modelo
 * Esa carpeta está en .gitignore: tiene datos personales.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { claudeSchema, generalSchema, parseConfig } from "../config.js";
import { ProcesadorCarnets } from "../extraction/procesarCarnets.js";
import { logger } from "../utils/logger.js";

async function main(): Promise<void> {
  const [input, outArg] = process.argv.slice(2);
  if (!input) {
    console.error('Uso: npm run extraer -- "ruta/al/archivo.pdf" [carpeta-de-salida]');
    process.exit(1);
  }
  const config = parseConfig(generalSchema.extend(claudeSchema.shape));
  const pdf = await readFile(input);
  const outDir = path.resolve(outArg ?? path.join("salida-extraccion", path.basename(input, path.extname(input))));
  await mkdir(outDir, { recursive: true });

  console.log(`\nProcesando "${path.basename(input)}" con ${config.EXTRACTION_MODEL} (esfuerzo ${config.EXTRACTION_EFFORT})...\n`);
  const r = await new ProcesadorCarnets(config, logger).procesar(pdf, path.basename(input));

  for (const c of r.aceptados) {
    await writeFile(path.join(outDir, `${c.identificador}.pdf`), c.pdf);
  }
  await writeFile(
    path.join(outDir, "resumen.json"),
    JSON.stringify(
      {
        archivo: path.basename(input),
        formato: r.formato,
        aceptados: r.aceptados.map(({ pdf, ...c }) => ({ ...c, kb: Math.round(pdf.length / 1024) })),
        rechazados: r.rechazados,
        notaModelo: r.notaModelo,
        usage: r.usage,
        costoUsd: Number(r.costoUsd.toFixed(4)),
        segundos: Math.round(r.duracionMs / 1000),
      },
      null,
      2,
    ),
  );

  console.log(`Formato detectado: ${r.formato ?? "—"}\n`);
  console.log(`ACEPTADOS (${r.aceptados.length}):`);
  console.table(
    r.aceptados.map((c) => ({
      pág: c.pagina,
      tipo: c.tipo,
      id: c.identificador,
      nombre: c.apellidoNombre ?? "",
      vence: c.vencimiento + (c.vencido ? " (VENCIDO)" : ""),
      cliente: c.clienteDetectado ?? "",
      obs: c.observaciones ?? "",
      kb: Math.round(c.pdf.length / 1024),
    })),
  );
  if (r.rechazados.length > 0) {
    console.log(`\nRECHAZADOS (${r.rechazados.length}):`);
    console.table(r.rechazados);
  }
  console.log(`\nCosto aproximado: US$ ${r.costoUsd.toFixed(3)} · ${Math.round(r.duracionMs / 1000)} s · ${r.usage.requests} pedidos a Claude`);
  console.log(`Salida: ${outDir}\n`);
}

main().catch((err) => {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
