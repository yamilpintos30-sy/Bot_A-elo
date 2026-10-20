/**
 * Contratos del extractor de carnets.
 *
 * - `Manifest`: lo que Opus devuelve desde el sandbox (manifest.json) junto con
 *   un PDF por carnet.
 * - `Verificacion`: la segunda lectura, independiente, de cada PDF recortado.
 *
 * Ambos se validan con Zod: nada de lo que dice la IA se usa sin pasar por acá
 * y por la revisión de `review.ts`.
 */
import { z } from "zod";

export const carnetManifestSchema = z.object({
  /** Nombre del PDF recortado dentro de las salidas del sandbox. */
  archivo: z.string().min(1),
  tipo: z.enum(["chofer", "dominio"]),
  /** DNI (chofer) o patente (dominio), tal como se lee en el carnet. */
  identificador: z.string().nullable(),
  apellidoNombre: z.string().nullable().optional(),
  /** dd-MM-yyyy: fecha hasta la que el carnet habilita el INGRESO. */
  vencimiento: z.string().nullable(),
  /** Empresa/cliente PARA QUIEN se emitió la credencial (no la contratista). */
  clienteDetectado: z.string().nullable().optional(),
  pagina: z.number().int().min(1),
  /** Datos relevantes que no se cargan pero hay que avisar (p. ej. "Inhabilitado para conducir"). */
  observaciones: z.string().nullable().optional(),
  /** Listado: imagen ampliada de la fila marcada, sólo para la verificación (no se carga). */
  recorte: z.string().nullable().optional(),
});
export type CarnetManifest = z.infer<typeof carnetManifestSchema>;

export const manifestSchema = z.object({
  /** Descripción breve del formato detectado (para el registro). */
  formato: z.string().optional(),
  /** "carnets" (credenciales individuales) o "listado" (tabla de estados: cada registro lleva el documento completo con su fila marcada). */
  modo: z.enum(["carnets", "listado"]).optional(),
  carnets: z.array(carnetManifestSchema),
  /** Carnets o páginas que no se pudieron procesar, con el motivo. */
  descartados: z.array(z.object({ pagina: z.number().int().nullable().optional(), motivo: z.string() })).default([]),
});
export type Manifest = z.infer<typeof manifestSchema>;

/** Esquema de salida estructurada de la verificación (JSON Schema para la API). */
export const VERIFICACION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["documentos"],
  properties: {
    documentos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["indice", "tipo", "identificador", "vencimiento", "unSoloCarnet"],
        properties: {
          indice: { type: "integer" },
          tipo: { type: "string", enum: ["chofer", "dominio", "ilegible"] },
          identificador: { type: ["string", "null"] },
          vencimiento: { type: ["string", "null"] },
          unSoloCarnet: { type: "boolean" },
        },
      },
    },
  },
} as const;

export const verificacionSchema = z.object({
  documentos: z.array(
    z.object({
      indice: z.number().int(),
      tipo: z.enum(["chofer", "dominio", "ilegible"]),
      identificador: z.string().nullable(),
      vencimiento: z.string().nullable(),
      unSoloCarnet: z.boolean(),
    }),
  ),
});
export type VerificacionDocumento = z.infer<typeof verificacionSchema>["documentos"][number];
