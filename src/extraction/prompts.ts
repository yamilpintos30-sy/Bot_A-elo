/**
 * Instrucciones para el extractor (sandbox) y para la verificación.
 *
 * Criterio del proyecto: los documentos llegan en formatos que cambian según la
 * empresa que los emite, así que acá NO hay un parser ni listas de palabras:
 * se explica QUÉ dato se busca y POR QUÉ, y el modelo lo encuentra en el
 * formato que sea.
 */

export const EXTRACCION_PROMPT = `Recibiste un PDF con documentación de ingreso a plantas e instalaciones petroleras. Lo emiten distintas empresas para distintos clientes, así que el formato cambia. No supongas un formato: miralo. Puede ser de dos clases:

A) CARNETS: credenciales individuales, una por persona o por vehículo (una por página o varias en grilla).
B) LISTADO: una tabla o estado general (por ejemplo, la captura de un portal) con varias personas y/o vehículos, cada uno con su fecha de vencimiento, SIN carnet individual.

Usá la herramienta de ejecución de código: el archivo está cargado en el contenedor.

QUÉ GENERAR
1. Un PDF por REGISTRO (cada persona o vehículo):
   - Si son CARNETS: el PDF contiene SOLO ese carnet, recortado a su recuadro con un margen chico. Rasterizá el recorte (unos 200 dpi, JPEG de buena calidad) y armá el PDF con esa imagen; no uses un recorte vectorial (CropBox), que deja adentro los datos de otras personas. Menos de 300 KB.
   - Si es un LISTADO: el PDF es el DOCUMENTO COMPLETO (todas sus páginas), como constancia, con la fila de ese registro MARCADA en la página donde está: un recuadro rojo de trazo fino ALREDEDOR de la fila, con un pequeño margen, y una flecha roja en el margen izquierdo de la página que apunte a ella. La marca no debe tapar ningún texto (sin relleno ni trazo encima de las letras): quien la mire tiene que poder leer la fila marcada igual que en el original. Dibujala como contenido de la página sobre el PDF original, sin rasterizarlo de nuevo, para no perder la calidad del documento (si el original es una imagen, queda con su resolución). Además, por cada registro del listado, guardá <IDENTIFICADOR>.fila.png: un recorte AMPLIADO (unas 3 veces, para que se lea con claridad) de esa fila sola, de borde a borde de la tabla, tomado del original sin la marca. Sirve para la verificación y no se carga.
   - Nombre: <IDENTIFICADOR>.pdf (el DNI, o el CUIL si es lo único que figura, o la patente en mayúsculas sin espacios). Si no se puede leer el identificador, no generes el PDF y anotalo en "descartados".
2. Un archivo manifest.json con esta forma:
{
  "formato": "descripción breve del formato (emisor, clase CARNETS o LISTADO, disposición)",
  "modo": "carnets" o "listado",
  "carnets": [
    {
      "archivo": "30123456.pdf",
      "tipo": "chofer" (persona) o "dominio" (vehículo),
      "identificador": "DNI solo con números; si sólo figura el CUIL/CUIT, el CUIL completo de 11 números (el sistema extrae el DNI); o la patente en mayúsculas sin espacios",
      "apellidoNombre": "APELLIDO, NOMBRE" o null si es un vehículo,
      "vencimiento": "dd-MM-yyyy",
      "clienteDetectado": "empresa para la que se emitió la credencial o el estado",
      "pagina": número de página (desde 1),
      "motivoVencimiento": "qué documento vence en esa fecha" o null,
      "observaciones": "situación anormal que haya que avisar" o null,
      "recorte": "30123456.fila.png" (sólo en un listado) o null
    }
  ],
  "descartados": [ { "pagina": n, "motivo": "por qué no se pudo procesar" } ]
}
   Incluí en "carnets" TODOS los registros del documento, de personas y de vehículos: la selección de qué se carga se hace después.

CRITERIOS
- vencimiento: la fecha HASTA la que el registro habilita el ingreso o el acceso a la planta. En un carnet es su vencimiento o vigencia; en un listado, la fecha asociada al estado o al próximo vencimiento que le impediría el acceso. Las fechas de emisión, impresión o habilitación para conducir no son el vencimiento. Formato dd-MM-yyyy (ejemplo: 31-12-2027).
- clienteDetectado: la empresa o el operador PARA QUIEN se emitió la credencial o el estado, es decir, el dueño de la planta. No es la contratista a la que pertenece la persona ni la empresa de control.
- motivoVencimiento: qué documento o requisito vence en esa fecha, en pocas palabras (por ejemplo, el que figure como motivo de no acceso asociado a la fecha), o null si no figura.
- observaciones: sólo una situación ANORMAL que hoy impida o condicione el acceso (por ejemplo, un estado distinto del habilitado, o una restricción). No repitas el estado normal ni qué documento vence en la fecha (eso va en motivoVencimiento). Si no hay nada anormal, null.
- Si el mismo DNI o la misma patente aparece más de una vez, generá un solo registro (el de vencimiento más lejano) y explicalo en "descartados".
- Nunca inventes ni completes datos. Si un dato no se lee con seguridad, poné null o descartá el registro explicando por qué.

CÓMO TRABAJAR
- Usá pocos pasos: entendé la disposición y resolvé todo el PDF con un solo script, no registro por registro.
- Si el PDF tiene texto, preferí ubicar cada registro y leer sus datos con el texto y sus coordenadas. Mirá imágenes solo cuando haga falta para entender la disposición o leer algo que no está como texto.
- Si el PDF es una imagen (captura o escaneo) ya lo estás viendo entero arriba: leé los datos de ahí y, si la letra es chica, mirá pocos recortes ampliados que abarquen muchas filas (por ejemplo uno por tabla), nunca fila por fila. Para ubicar las filas en el contenedor usá el análisis de la imagen (líneas, bandas de texto), no más miradas.
- No vuelvas a abrir los PDF generados para controlarlos: hay una verificación independiente después.
- Todo lo que imprimís o mirás en el contenedor se relee en cada paso siguiente y el contexto es limitado: imprimí resúmenes cortos (unas decenas de líneas como mucho), nunca volcados completos de texto, palabras o coordenadas del PDF, y si mirás una imagen que sea a baja resolución y una sola vez.

SALIDA
Guardá los PDF y el manifest.json en el directorio de salida del contenedor: usá la variable de entorno OUTPUT_DIR si existe y, si no, /tmp/outputs. Al final respondé con una línea: cuántos registros generaste y cuántos descartaste.`;

export const VERIFICACION_PROMPT = `Cada documento de arriba corresponde a UN registro (una persona o un vehículo). Puede ser:
- un carnet recortado, o
- un listado completo con UNA fila marcada (recuadro rojo y flecha roja): en ese caso el registro es la fila MARCADA, no las demás, o
- la imagen ampliada de UNA fila de un listado (una tabla de estados): el registro es esa fila; la persona puede figurar sólo con su CUIL y la fecha de la fila es su vencimiento.
Leelos de forma independiente y, para cada uno, informá:
- indice: el número de documento indicado arriba.
- tipo: "chofer" si es de una persona, "dominio" si es de un vehículo, "ilegible" si no se puede leer.
- identificador: el DNI (solo números; si sólo figura el CUIL, el CUIL completo) o la patente (mayúsculas, sin espacios), o null si no se lee con seguridad.
- vencimiento: la fecha hasta la que el registro habilita el ingreso o el acceso, en formato dd-MM-yyyy. Las fechas de emisión, impresión o habilitación para conducir no son el vencimiento. null si no se lee con seguridad.
- unSoloCarnet: true si el documento identifica exactamente UN registro (un solo carnet completo, un listado con exactamente una fila marcada, o una sola fila).
No completes ni supongas datos: si algo no se lee con claridad, devolvé null.`;

/** Primera página, para decidir el camino: carnets (sandbox) o listado (lectura directa). */
export const CLASIFICACION_PROMPT = `La imagen es la primera página de un PDF con documentación de ingreso a plantas petroleras. Decí de qué clase es:
- "carnets": credenciales individuales, una por persona o por vehículo (una por página o varias en grilla).
- "listado": una tabla o estado general (por ejemplo, la captura de un portal) con varias personas y/o vehículos, cada uno con su fecha, sin carnet individual.`;

/** Lectura de un listado, en franjas de imagen: los datos y la altura aproximada de cada fila. */
export const LECTURA_LISTADO_PROMPT = `Las imágenes de arriba son franjas consecutivas (de arriba hacia abajo) de un LISTADO de documentación de ingreso a plantas petroleras: una tabla o estado general con personas y/o vehículos, cada uno con su fecha, sin carnet individual. El formato depende de quién lo emite: miralo, no lo supongas.

Cada fila de una tabla de personas o de vehículos es un REGISTRO. Informá TODOS, de personas y de vehículos (la selección de qué se carga se hace después). Para cada uno:
- recorte: el número de la franja donde está la fila.
- yCentro: a qué altura está el centro de la fila en esa franja, en píxeles desde el borde de arriba (aproximado alcanza).
- tipo: "chofer" (persona) o "dominio" (vehículo).
- identificador: el DNI solo con números; si sólo figura el CUIL/CUIT, el CUIL completo de 11 números (el sistema extrae el DNI); en un vehículo, la patente en mayúsculas sin espacios.
- apellidoNombre: "APELLIDO, NOMBRE" o null si es un vehículo.
- vencimiento: la fecha HASTA la que el registro habilita el acceso a la planta, en formato dd-MM-yyyy; en un listado suele ser la fecha asociada al estado o al próximo vencimiento que le impediría el acceso.
- motivoVencimiento: qué documento o requisito vence en esa fecha, en pocas palabras (por ejemplo, el que figure como motivo de no acceso asociado a la fecha), o null si no figura.
- observaciones: sólo una situación ANORMAL que hoy impida o condicione el acceso (por ejemplo, un estado distinto del habilitado, o una restricción). No repitas el estado normal ni qué documento vence en la fecha (eso va en motivoVencimiento). Si no hay nada anormal, null.

Además:
- formato: descripción breve (emisor, qué tablas tiene).
- clienteDetectado: la empresa u operador PARA QUIEN es el estado, es decir, el dueño de la planta; no la contratista a la que pertenecen las personas ni la empresa de control. null si no figura.
- descartados: filas que no se pudieron leer, con el motivo.

Si una fila aparece cortada entre dos franjas, informala una sola vez, en la franja donde se ve su texto. Nunca inventes ni completes datos: si un dato no se lee con seguridad, poné null.`;
