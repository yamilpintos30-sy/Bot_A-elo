/**
 * Las tablas del bot Añelo viven en el MISMO proyecto de Supabase que Enri
 * (decisión de costos, 2026-10-15) y la service_role key da acceso a todo.
 * Este test garantiza que el código del bot Añelo sólo nombra tablas anelo_*:
 * nunca lee ni escribe las de Enri (bot_*).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? archivos(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("aislamiento de Enri en Supabase", () => {
  it("el código sólo usa tablas anelo_*", () => {
    const usadas = new Map<string, string>();
    for (const f of archivos(path.resolve("src"))) {
      for (const m of readFileSync(f, "utf8").matchAll(/\.from\(\s*["'`]([^"'`]+)["'`]/g)) usadas.set(m[1]!, path.relative(".", f));
    }
    expect(usadas.size).toBeGreaterThan(0);
    const ajenas = [...usadas].filter(([tabla]) => !tabla.startsWith("anelo_"));
    expect(ajenas).toEqual([]);
  });

  it("el SQL del bot sólo crea o modifica tablas anelo_*", () => {
    const dir = path.resolve("supabase/migrations");
    const sql = readdirSync(dir).map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
    const tablas = [...sql.matchAll(/(?:create table if not exists|alter table|insert into|(?<!do )update|delete from)\s+(?:public\.)?(\w+)/gi)].map((m) => m[1]!);
    expect(tablas.length).toBeGreaterThan(0);
    expect(tablas.filter((t) => !t.startsWith("anelo_"))).toEqual([]);
  });
});
