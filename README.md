# Bot Añelo — SEA WHITE S.A.

Bot de WhatsApp de **Vencimientos Añelo**, en el número +54 9 291 571-9564 (inbox de Chatwoot `146313`).

- **Cargadores** (lista que se sube en un .txt): mandan el PDF con los carnets. El bot pregunta el cliente y la planta, separa cada carnet con IA y, después de que la persona confirma, lo carga en SEA WHITE.
- **Resto de las personas:** consultan un vencimiento por DNI o patente, con cliente y planta, y pueden pedir su carnet en PDF.

## Convivencia con Enri (no se mezclan nunca)

| | Enri | Bot Añelo |
|---|---|---|
| Inbox de Chatwoot | 134690 | **146313** |
| Repo | Seawhite_Bot | Bot_Anelo |
| Servicio de Render | seawhite-bot | propio |
| Supabase | su proyecto | **proyecto propio** |
| WEBHOOK_SECRET y webhook | propios | **propios** |

- **El filtro de inbox es estricto.** Si un evento no trae `inbox_id`, o trae otro, se ignora.
- **Enri tiene que tener cargado `CHATWOOT_INBOX_ID=134690`** antes de activar este bot.
- **No hay código compartido.** Lo que sirvió de Enri se copió.

## Regla Nº 1 y su única excepción

El servidor de SEA WHITE se **consulta**. La única escritura permitida la autorizó Yamil el 2026-10-13: los dos `POST /api/VencimientosAnelo/{chofer|dominio}`. Tiene cuatro candados, todos en [src/integrations/seawhite/](src/integrations/seawhite/):

1. **Lista blanca por método y ruta.** Cualquier otra llamada se bloquea antes de salir a la red.
2. **`ANELO_CARGA_HABILITADA`.** Arranca en `false`, y así ningún POST sale a la red.
3. **`ANELO_MODO_PRUEBA`.** Arranca en `true`, y solo deja cargar en el cliente de prueba `999999`.
4. **Validación de cada registro antes de enviar.** Si uno es inválido, no se envía ninguno.

## Separación de carnets

Está en [src/extraction/](src/extraction/) y tiene tres pasos:

1. **Extracción.** Claude Opus 5.5 trabaja en el sandbox de ejecución de código. Mira el PDF, recorta cada carnet a su propio PDF (rasterizado, para que no queden datos de otras personas) y escribe `manifest.json`. No hay parser fijo: los formatos cambian según la empresa que emite el carnet.
2. **Verificación independiente.** Una segunda lectura de cada recorte, sin ver lo que dijo la primera.
3. **Revisión sin IA.** Solo pasa lo que tiene PDF válido, DNI o patente válidos y fecha real, y además coincide con la verificación. Se descartan los repetidos.

Los archivos subidos a la API de Claude se borran al terminar.

### Probar con un PDF local

No toca SEA WHITE ni Chatwoot.

```bash
cp .env.example .env        # completar ANTHROPIC_API_KEY
npm install
npm run extraer -- "../Documentos bot 2/ejemplos documentacion/Total - Unidades PW.pdf"
```

La salida queda en `salida-extraccion/` (está en .gitignore porque tiene datos personales).

## Estado

| Etapa | Estado |
|---|---|
| 1. Base: configuración, cliente de SEA WHITE con candados, tests | ✅ |
| 2. Extractor de carnets | ✅ probado con los 4 PDF de ejemplo: 52 de 52 correctos, ~US$ 0,03 por carnet |
| 4. WhatsApp: webhook, filtro de inbox, anti-eco, flujo del chofer (Javier) | ✅ código y tests · ⏳ prueba real |
| 5. Flujo del cargador con botón Confirmar (modo prueba 9999xx) | ✅ código y tests · ⏳ prueba real |
| 3. Panel: contexto, análisis, cargadores (.txt), clientes y plantas, registro | ⏳ |
| 6. Barra de pestañas en el panel de Enri | ⏳ |

## Cómo funciona por WhatsApp

**Cargadores** (tabla `anelo_cargadores`):
1. Cualquier mensaje abre el menú **[👤 Choferes] [🚛 Dominios]**.
2. Piden cliente y subcliente, que se cotejan contra la tabla de clientes: "✅ encontrados, mandá el PDF".
3. Mientras se procesa el PDF, el bot avisa el progreso: recibido, separando y verificando. Si tarda, manda "sigue en proceso".
4. **Filtro de tipo:** si eligió choferes y el PDF trae vehículos (o al revés), avisa y no carga nada. Ofrece cargarlo como el otro tipo. Si el PDF viene mezclado, carga solo el tipo elegido y lista el resto.
5. Resumen, **[Confirmar carga] [Cancelar]**, carga en SEA WHITE, resultado y vuelve al menú.

**Choferes** (cualquier otro número):
1. Saludo cordial con la imagen de Javier (`WELCOME_IMAGE`, por defecto `assets/javier.jpg`; sin imagen, sale solo texto).
2. **Primero cliente y subcliente** ("¿A qué planta vas?"), cotejados contra la tabla: un mismo DNI o patente puede estar cargado en varias plantas, y la API consulta por cliente + subcliente.
3. **[👤 Chofer] [🚛 Vehículo]**: pide el DNI o la patente. Si los mandó antes de decir la planta, los recuerda y los consulta apenas la elige.
4. Vencimiento en **esa** planta (GET a SEA WHITE, del que se toma el **ID del carnet**), más licencia, ART y F.931 (o seguro y VTV).
5. "¿Querés que te pase el carnet?" → con ese ID trae el PDF y lo manda. El bot espera que WhatsApp lo entregue antes de seguir.
6. Al terminar: **[Menú 😊]** vuelve a pedir cliente y subcliente; **[🔎 Consulta]** hace otra consulta en el mismo cliente y subcliente; **[Eso es todo, gracias]** cierra.
7. Si manda un archivo, se le avisa que el número es solo para consultas.

## Comandos

```bash
npm test            # tests
npm run typecheck   # chequeo de tipos
npm run extraer -- <pdf>
```
