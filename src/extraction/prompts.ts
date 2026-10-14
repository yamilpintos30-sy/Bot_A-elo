/**
 * Instrucciones para el extractor (sandbox) y para la verificación.
 *
 * Criterio del proyecto: los carnets llegan en formatos que cambian según la
 * empresa que los emite, así que acá NO hay un parser ni listas de palabras:
 * se explica QUÉ dato se busca y POR QUÉ, y el modelo lo encuentra en el
 * formato que sea.
 */

export const EXTRACCION_PROMPT = `Recibiste un PDF con credenciales de ingreso a plantas e instalaciones petroleras (carnets). Las emiten distintas empresas de control para distintos clientes, así que el formato cambia: puede haber un carnet por página o varios en grilla, de personas o de vehículos, con los campos en lugares y con nombres distintos. No supongas un formato: miralo.

Tu tarea es separar CADA carnet en su propio PDF y extraer sus datos. Usá la herramienta de ejecución de código: el archivo está cargado en el contenedor.

QUÉ GENERAR
1. Un PDF por carnet que contenga SOLO ese carnet, recortado a su recuadro con un margen chico.
   - Rasterizá el recorte (unos 200 dpi, JPEG de buena calidad) y armá el PDF con esa imagen. No uses un recorte vectorial (CropBox): deja dentro del archivo el contenido del resto de la página, es decir, los datos de otras personas.
   - Cada PDF debe pesar menos de 300 KB; si se pasa, bajá la calidad o la resolución sin que deje de leerse.
   - Nombre: <DNI>.pdf para personas y <PATENTE>.pdf para vehículos (patente en mayúsculas, sin espacios). Si no se puede leer el identificador, no generes el PDF y anotalo en "descartados".
2. Un archivo manifest.json con esta forma:
{
  "formato": "descripción breve del formato (emisor, disposición)",
  "carnets": [
    {
      "archivo": "30123456.pdf",
      "tipo": "chofer" (persona) o "dominio" (vehículo),
      "identificador": "DNI solo con números, o patente en mayúsculas sin espacios",
      "apellidoNombre": "APELLIDO, NOMBRE" o null si es un vehículo,
      "vencimiento": "dd-MM-yyyy",
      "clienteDetectado": "empresa para la que se emitió la credencial",
      "pagina": número de página (desde 1),
      "observaciones": "dato importante que haya que avisar" o null
    }
  ],
  "descartados": [ { "pagina": n, "motivo": "por qué no se pudo procesar" } ]
}

CRITERIOS
- vencimiento: la fecha HASTA la que la credencial habilita el ingreso o el acceso a la planta. Si el carnet trae otras fechas (emisión, impresión, habilitación para conducir u otras), esas no son el vencimiento. Formato dd-MM-yyyy (ejemplo: 31-12-2027).
- clienteDetectado: la empresa o el operador PARA QUIEN se emitió la credencial, es decir, el dueño de la planta. No es la contratista a la que pertenece la persona ni la empresa de control que imprimió el carnet.
- observaciones: anotá lo que cambie si la persona o el vehículo puede trabajar, por ejemplo que esté inhabilitado para conducir. Si no hay nada relevante, null.
- Si el mismo DNI o la misma patente aparece más de una vez, generá un solo PDF (el de vencimiento más lejano) y explicalo en "descartados".
- Nunca inventes ni completes datos. Si un dato no se lee con seguridad, poné null o descartá el carnet explicando por qué.

SALIDA
Guardá los PDF y el manifest.json en el directorio de salida del contenedor: usá la variable de entorno OUTPUT_DIR si existe y, si no, /tmp/outputs. Antes de terminar, abrí cada PDF generado y confirmá que contiene un solo carnet completo y legible. Al final respondé con una línea: cuántos carnets generaste y cuántos descartaste.`;

export const VERIFICACION_PROMPT = `Cada documento de arriba debería ser UNA credencial de ingreso recortada (carnet de una persona o de un vehículo). Leelos de forma independiente y, para cada uno, informá:
- indice: el número de documento indicado arriba.
- tipo: "chofer" si es de una persona, "dominio" si es de un vehículo, "ilegible" si no se puede leer.
- identificador: el DNI (solo números) o la patente (mayúsculas, sin espacios), o null si no se lee con seguridad.
- vencimiento: la fecha hasta la que la credencial habilita el ingreso o el acceso, en formato dd-MM-yyyy. Las fechas de emisión, impresión o habilitación para conducir no son el vencimiento. null si no se lee con seguridad.
- unSoloCarnet: true si el documento contiene exactamente un carnet completo, sin partes de otros carnets.
No completes ni supongas datos: si algo no se lee con claridad, devolvé null.`;
