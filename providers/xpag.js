// Adaptador XPag (SPEI México) — según https://xpag.global/docs (cashin, webhooks, consult-transaction).
//  - Crear cobro:  POST {base}/cashin  { currency:"MXN", amount, external_id, webhook_url, name, description }
//    -> { ok, clabe, reference, bank_name, beneficiary, transaction_id, request_number, status }
//    CLABE dinámica: válida 24 h, un solo pago; un valor distinto del pedido es devuelto (estornado) por XPag.
//  - Webhook: POST con header X-Webhook-Signature = HMAC-SHA256 hex del cuerpo CRUDO, clave = client_secret.
//    Se acredita SOLO con status "confirmed" | "completed" y type "cashin". El e2e es único por pago.
//  - Consulta: GET {base}/consult-transaction?external_id=...  (para reconciliar si no llegó el webhook)
// Auth: X-Client-Id / X-Client-Secret. Con XPAG_MODE=mock no se llama a XPag (CLABE de prueba).
import crypto from "node:crypto";

const env = process.env;
export const NAME = env.XPAG_MODE === "mock" ? "xpag-mock" : "xpag";
const base = () => (env.XPAG_BASE_URL || "https://api.xpag.global").replace(/\/+$/, "");
const headers = () => ({
  "Content-Type": "application/json",
  "X-Client-Id": env.XPAG_CLIENT_ID || "",
  "X-Client-Secret": env.XPAG_CLIENT_SECRET || "",
});

async function call(method, path, body) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(base() + path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) {
      const err = new Error(`XPag ${path}: ${data.error_code || r.status} ${data.error || ""}`.trim());
      err.code = data.error_code || String(r.status);
      throw err;
    }
    return data;
  } finally { clearTimeout(t); }
}

// Devuelve: { chargeId, clabe, bank, beneficiary, reference, expiresAt }
export async function createSpeiCharge({ orderId, amount, name, description }) {
  if (env.XPAG_MODE === "mock") {
    return { chargeId: "MOCK-" + orderId, clabe: "000000000000000000", bank: "BANCO DE PRUEBA",
             beneficiary: "LEVE VITA DIGITAL (PRUEBA)", reference: orderId, expiresAt: "" };
  }
  if (!env.XPAG_CLIENT_ID || !env.XPAG_CLIENT_SECRET) throw new Error("XPag: faltan XPAG_CLIENT_ID / XPAG_CLIENT_SECRET");
  const d = await call("POST", "/cashin", {
    currency: "MXN",
    amount: Number(amount),
    external_id: orderId,                       // nuestro pedido; vuelve íntegro en el webhook
    webhook_url: `${env.PUBLIC_BASE_URL}/webhooks/xpag`,
    name: name || "Cliente",
    description: String(description || "Pedido " + orderId).slice(0, 60),
  });
  if (!d.clabe) throw new Error("XPag: la respuesta no trajo CLABE");
  return {
    chargeId: d.transaction_id || d.request_number || null,
    clabe: d.clabe,
    bank: d.bank_name || "STP",
    beneficiary: d.beneficiary || "",
    reference: orderId,                          // así el webhook (external_id) encuentra el pedido
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), // validez de la CLABE dinámica: 24 h
  };
}

function validSignature(raw, sig) {
  const secret = env.XPAG_CLIENT_SECRET || "";
  if (!secret || !sig || !raw) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(String(sig), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Valida la firma y normaliza a { txId, chargeId, reference, clabe, amount, status: 'paid'|'pending'|'expired'|'refunded' }
export async function parseWebhook(req) {
  if (env.XPAG_MODE !== "mock" && !validSignature(req.rawBody, req.get("x-webhook-signature"))) {
    throw new Error("firma inválida");
  }
  const b = req.body || {};
  if (String(b.type || "").toLowerCase() !== "cashin") return { status: "pending" }; // saques/otros: se ignoran
  const st = String(b.status || "").toLowerCase();
  const status = (st === "confirmed" || st === "completed") ? "paid"
               : (st === "failed" || st === "expired") ? "expired"
               : (st === "med" ? "refunded" : "pending");
  return {
    txId: b.e2e || null,                         // único por pago (idempotencia)
    chargeId: b.transaction_id || b.request_number || null,
    reference: b.external_id || null,
    clabe: b.receiverClabe || b.clabe || null,
    amount: Number(b.amount || 0),
    status,
  };
}

// Reconciliación manual: estado real de un pedido por external_id
export async function consult(orderId) {
  return call("GET", `/consult-transaction?external_id=${encodeURIComponent(orderId)}`);
}
