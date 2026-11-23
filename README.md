# Backend del funnel Carpintería Fácil (México · SPEI vía XPag)

Express + SQLite. Crea el pedido, pide a XPag una CLABE por pedido, recibe el webhook de pago,
libera la descarga SOLO con pago confirmado y reanuda el bot de Typebot.

## Reglas de negocio
- Ebook: el cliente elige cualquier monto entre 100 y 500 MXN (EBOOK_MIN / EBOOK_MAX). Se libera con un pago confirmado a partir de 100 MXN.
- Upsell: 49 MXN fijo (UPSELL_PRICE), solo si el ebook ya está pagado.
- El monto se valida en el servidor; el bot nunca decide si algo está pagado.

## XPag (https://xpag.global/docs)
- Cobro: POST https://api.xpag.global/cashin (currency MXN, amount, external_id = pedido, webhook_url = PUBLIC_BASE_URL/webhooks/xpag).
- Webhook: se valida X-Webhook-Signature (HMAC-SHA256 del cuerpo crudo con el Client Secret). Se acredita solo con status confirmed/completed. El e2e evita acreditar dos veces.
- Credenciales: panel XPag › Integración / API → XPAG_CLIENT_ID y XPAG_CLIENT_SECRET en el .env (nunca en el código).
- Sandbox: XPAG_CLIENT_ID=xpagsandbox_00000000 y XPAG_CLIENT_SECRET=202620262026202620262026; POST /sandbox/simulate simula paid/failed/expired.
- Pendiente de comprobar: el valor mínimo por cobro SPEI no está en la documentación (el upsell es de 49 MXN).

## Puesta en marcha
1. `npm install`, copiar `.env.example` a `.env` y completarlo (BOT_API_KEY, XPAG_*, TYPEBOT_API_TOKEN, META_*; TEST_MODE=0 en producción).
2. Poner los PDFs en `./private/` (rutas EBOOK_PATH y UPSELL_PATH).
3. Publicar con HTTPS y poner esa URL en PUBLIC_BASE_URL y en el bloque "00 · Inicio" del bot (api_base); la misma BOT_API_KEY en los bloques HTTP (header x-api-key).
4. Probar primero con XPAG_MODE=mock o con las claves de sandbox; pasar a las claves reales al final.
