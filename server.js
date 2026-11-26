// Backend del embudo Typebot — "Carpintería Fácil" México (SPEI vía XPag)
// - Crea pedidos (ebook con monto libre 100–500 MXN, upsell fijo 49 MXN)
// - Pide al proveedor (XPag) los datos SPEI: CLABE, banco, beneficiario, referencia
// - Recibe el webhook del proveedor, valida y marca el pedido como pagado
// - Reanuda el bloque Webhook del Typebot y libera la descarga protegida
// - Envía InitiateCheckout / Purchase a Meta (Conversions API)
// Node 20+. Base de datos: SQLite (better-sqlite3).

import express from "express";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as provider from "./providers/xpag.js";

const env = process.env;
const app = express();
// Guardamos el cuerpo crudo: muchos proveedores firman el cuerpo exacto (HMAC)
app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// ---------- Reglas de producto ----------
const PRODUCTS = {
  ebook:  { name: "Carpinteria Facil", min: Number(env.EBOOK_MIN || 100), max: Number(env.EBOOK_MAX || 500),
            file: env.EBOOK_PATH || "./private/Carpinteria-Facil-100-Proyectos.pdf", blockId: env.TYPEBOT_WEBHOOK_BLOCK_EBOOK },
  upsell: { name: "Carpinteria que Deja Dinero", min: Number(env.UPSELL_PRICE || 49), max: Number(env.UPSELL_PRICE || 49),
            file: env.UPSELL_PATH || "./private/Carpinteria-que-Deja-Dinero.pdf", blockId: env.TYPEBOT_WEBHOOK_BLOCK_UPSELL },
};

// ---------- Base de datos ----------
const db = new Database(env.DB_PATH || "./data.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, product TEXT, parent_id TEXT, result_id TEXT,
  country TEXT, currency TEXT DEFAULT 'MXN', amount REAL, paid_amount REAL,
  name TEXT, email TEXT, phone TEXT, consent INTEGER DEFAULT 0,
  status TEXT DEFAULT 'created',      -- created | awaiting_payment | paid | underpaid | expired | refunded
  provider_charge_id TEXT, provider_tx_id TEXT UNIQUE, clabe TEXT, reference TEXT, bank TEXT, beneficiary TEXT, expires_at TEXT,
  download_token TEXT UNIQUE, downloads INTEGER DEFAULT 0,
  utm TEXT, fbc TEXT, typebot_resumed INTEGER DEFAULT 0, capi_sent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT, result_id TEXT, name TEXT, data TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS webhook_log (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, ok INTEGER, note TEXT, payload TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS spend (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, label TEXT DEFAULT '', spend REAL DEFAULT 0, impressions INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_orders_ref ON orders(reference);
CREATE INDEX IF NOT EXISTS idx_orders_clabe ON orders(clabe);
`);
const q = {
  insert: db.prepare(`INSERT INTO orders (id,product,parent_id,result_id,country,amount,name,email,phone,consent,utm,fbc)
    VALUES (@id,@product,@parent_id,@result_id,@country,@amount,@name,@email,@phone,@consent,@utm,@fbc)`),
  setCharge: db.prepare(`UPDATE orders SET status='awaiting_payment', provider_charge_id=@charge_id, clabe=@clabe, reference=@reference,
    bank=@bank, beneficiary=@beneficiary, expires_at=@expires_at, updated_at=datetime('now') WHERE id=@id`),
  get: db.prepare(`SELECT * FROM orders WHERE id=?`),
  byToken: db.prepare(`SELECT * FROM orders WHERE download_token=?`),
  byTx: db.prepare(`SELECT * FROM orders WHERE provider_tx_id=?`),
  byCharge: db.prepare(`SELECT * FROM orders WHERE provider_charge_id=?`),
  byRef: db.prepare(`SELECT * FROM orders WHERE reference=? ORDER BY created_at DESC LIMIT 1`),
  byClabe: db.prepare(`SELECT * FROM orders WHERE clabe=? AND status='awaiting_payment' ORDER BY created_at DESC LIMIT 1`),
  paid: db.prepare(`UPDATE orders SET status='paid', paid_amount=?, provider_tx_id=COALESCE(provider_tx_id,?), download_token=COALESCE(download_token,?), updated_at=datetime('now') WHERE id=?`),
  status: db.prepare(`UPDATE orders SET status=?, paid_amount=COALESCE(?,paid_amount), updated_at=datetime('now') WHERE id=?`),
  inc: db.prepare(`UPDATE orders SET downloads=downloads+1 WHERE id=?`),
  flag: (c) => db.prepare(`UPDATE orders SET ${c}=1 WHERE id=?`),
  event: db.prepare(`INSERT INTO events (order_id,result_id,name,data) VALUES (?,?,?,?)`),
  log: db.prepare(`INSERT INTO webhook_log (source,ok,note,payload) VALUES (?,?,?,?)`),
};

const shortId = () => "CF" + crypto.randomBytes(4).toString("hex").toUpperCase();
const token = () => crypto.randomBytes(24).toString("base64url");
const sha256 = (s) => crypto.createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");
const safeEq = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const botKey = (req, res, next) => safeEq(req.get("x-api-key"), env.BOT_API_KEY) ? next() : res.status(401).json({ error: "unauthorized" });

// ---------- 1) Crear pedido + cobro SPEI ----------
app.post("/api/orders", botKey, async (req, res) => {
  const b = req.body || {};
  const product = b.product === "upsell" ? "upsell" : "ebook";
  const P = PRODUCTS[product];
  const amount = Math.round(Number(String(b.amount || "").replace(/[^\d.]/g, "")));
  // El monto lo valida el servidor: nadie puede cambiarlo desde el bot
  if (!Number.isFinite(amount) || amount < P.min || amount > P.max) return res.status(400).json({ error: "invalid_amount", min: P.min, max: P.max });
  if (product === "upsell") {
    const parent = q.get.get(b.parentOrderId || "");
    if (!parent || parent.status !== "paid") return res.status(400).json({ error: "parent_not_paid" });
  }
  const id = shortId();
  q.insert.run({ id, product, parent_id: b.parentOrderId || null, result_id: b.resultId || null, country: b.country || "MX", amount,
    name: b.name || null, email: b.email || null, phone: b.phone || null, consent: /s[ií]/i.test(String(b.consent || "")) ? 1 : 0,
    utm: JSON.stringify({ s: b.utm_source, m: b.utm_medium, c: b.utm_campaign, ct: b.utm_content, t: b.utm_term,
      cid: b.campaign_id, aid: b.adset_id, adid: b.ad_id, pl: b.placement, tt: b.ttclid, ttp: b.ttp }),
    fbc: b.fbclid ? `fb.1.${Date.now()}.${b.fbclid}` : null });
  try {
    const ch = await provider.createSpeiCharge({ orderId: id, amount, currency: "MXN", name: b.name, email: b.email, description: P.name });
    q.setCharge.run({ id, charge_id: ch.chargeId || null, clabe: ch.clabe, reference: ch.reference || id, bank: ch.bank || "",
      beneficiary: ch.beneficiary || "", expires_at: ch.expiresAt || null });
    q.event.run(id, b.resultId || null, "order_created", JSON.stringify({ product, amount }));
    res.json({ orderId: id, clabe: ch.clabe, bank: ch.bank || "", beneficiary: ch.beneficiary || "", reference: ch.reference || id,
      amount: String(amount), expiresAt: ch.expiresAt || "" });
  } catch (e) {
    q.status.run("error", null, id);
    q.event.run(id, b.resultId || null, "charge_error", String(e.message || e).slice(0, 500));
    res.status(502).json({ error: "provider_error" });
  }
});

// ---------- 2) Eventos del embudo ----------
const EV = new Set(["demo_viewed", "offer_viewed", "checkout_started", "upsell_viewed"]);
app.post("/api/events", botKey, (req, res) => {
  const { name, orderId, resultId } = req.body || {};
  if (!EV.has(name)) return res.status(400).json({ error: "invalid_event" });
  q.event.run(orderId || null, resultId || null, name, "{}");
  if (name === "checkout_started" && orderId) { sendCapi(orderId, "InitiateCheckout").catch(() => {}); sendTikTok(orderId, "InitiateCheckout").catch(() => {}); }
  res.json({ ok: true });
});

// ---------- 3) Estado (el bot solo entrega si paid === "true") ----------
app.get("/api/orders/:id/status", botKey, (req, res) => {
  const o = q.get.get(req.params.id);
  if (!o) return res.status(404).json({ status: "not_found", paid: "false" });
  res.json({ status: o.status, paid: o.status === "paid" ? "true" : "false",
    downloadUrl: o.status === "paid" ? `${env.PUBLIC_BASE_URL}/d/${o.download_token}` : "" });
});

// ---------- 4) Webhook del proveedor (XPag) ----------
app.post("/webhooks/xpag", async (req, res) => {
  let ev;
  try {
    ev = await provider.parseWebhook(req); // valida autenticidad y normaliza: {ok, txId, chargeId, reference, clabe, amount, status}
  } catch (e) {
    q.log.run("xpag", 0, "invalid: " + String(e.message || e).slice(0, 200), JSON.stringify(req.body).slice(0, 20000));
    return res.status(401).json({ error: "invalid_webhook" });
  }
  q.log.run("xpag", 1, ev.status, JSON.stringify(req.body).slice(0, 20000));
  const o = (ev.txId && q.byTx.get(ev.txId)) || (ev.chargeId && q.byCharge.get(ev.chargeId)) ||
            (ev.reference && q.byRef.get(ev.reference)) || (ev.clabe && q.byClabe.get(ev.clabe));
  if (!o) return res.json({ ok: true, note: "order_not_found" });
  await applyPayment(o, ev);
  res.json({ ok: true });
});

async function applyPayment(o, ev) {
  if (o.status === "paid" && ev.status !== "refunded") return; // idempotente
  if (ev.status === "refunded") { q.status.run("refunded", null, o.id); q.event.run(o.id, o.result_id, "refunded", "{}"); return; }
  if (ev.status !== "paid") { if (ev.status === "expired") q.status.run("expired", null, o.id); return; }
  const P = PRODUCTS[o.product];
  const paid = Number(ev.amount || 0);
  // Regla del monto mínimo: el ebook se libera con cualquier pago desde 100 MXN; el upsell con su precio
  if (paid < P.min) { q.status.run("underpaid", paid, o.id); q.event.run(o.id, o.result_id, "underpaid", JSON.stringify({ paid })); return; }
  q.paid.run(paid, ev.txId || null, token(), o.id);
  q.event.run(o.id, o.result_id, "purchase_approved", JSON.stringify({ paid, tx: ev.txId }));
  const fresh = q.get.get(o.id);
  await Promise.allSettled([resumeTypebot(fresh), sendCapi(o.id, "Purchase"), sendTikTok(o.id, "CompletePayment")]);
}

// ---------- 5) Descarga protegida ----------
app.get("/d/:token", (req, res) => {
  const o = q.byToken.get(req.params.token);
  if (!o || o.status !== "paid") return res.status(403).send("Enlace no válido o pago no confirmado.");
  if (o.downloads >= Number(env.MAX_DOWNLOADS || 10)) return res.status(429).send("Límite de descargas alcanzado. Escríbenos a " + (env.SUPPORT_EMAIL || "soporte") + ".");
  const file = path.resolve(PRODUCTS[o.product].file);
  if (!fs.existsSync(file)) return res.status(500).send("Archivo no disponible.");
  q.inc.run(o.id);
  res.download(file, path.basename(file));
});

// ---------- Pruebas (solo con TEST_MODE=1) ----------
app.post("/api/test/pay/:id", (req, res) => {
  if (env.TEST_MODE !== "1" || !safeEq(req.get("x-admin-key"), env.ADMIN_KEY)) return res.status(404).end();
  const o = q.get.get(req.params.id);
  if (!o) return res.status(404).json({ error: "not_found" });
  applyPayment(o, { status: "paid", amount: Number(req.body?.amount ?? o.amount), txId: "TEST-" + o.id }).then(() => res.json(q.get.get(o.id)));
});

// ---------- Integraciones ----------
async function resumeTypebot(o) {
  const blockId = PRODUCTS[o.product].blockId;
  if (!env.TYPEBOT_API_TOKEN || !env.TYPEBOT_ID || !blockId || !o.result_id) return;
  const url = `${env.TYPEBOT_BASE_URL || "https://app.typebot.com"}/api/v1/typebots/${env.TYPEBOT_ID}/blocks/${blockId}/results/${o.result_id}/executeWebhook`;
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.TYPEBOT_API_TOKEN}` },
    body: JSON.stringify({ orderId: o.id, status: o.status }) });
  if (r.ok) q.flag("typebot_resumed").run(o.id);
}

async function sendCapi(orderId, eventName) {
  if (!env.META_PIXEL_ID || !env.META_CAPI_TOKEN) return;
  const o = q.get.get(orderId);
  if (!o || (eventName === "Purchase" && o.capi_sent)) return;
  const user_data = { country: [sha256("mx")] };
  if (o.email) user_data.em = [sha256(o.email)];
  if (o.phone) { let ph = String(o.phone).replace(/\D/g, "").replace(/^0+/, ""); if (ph.length === 10) ph = "52" + ph; if (ph.length >= 10) user_data.ph = [sha256(ph)]; }
  if (o.name) { const parts = String(o.name).trim().toLowerCase().split(/\s+/); user_data.fn = [sha256(parts[0])]; if (parts.length > 1) user_data.ln = [sha256(parts[parts.length - 1])]; }
  user_data.external_id = [sha256(o.email || o.id)];
  if (o.fbc) user_data.fbc = o.fbc;
  const value = eventName === "Purchase" ? (o.paid_amount || o.amount) : o.amount;
  const body = { data: [{ event_name: eventName, event_time: Math.floor(Date.now() / 1000), action_source: "website",
    event_id: `${o.id}-${eventName}`, event_source_url: env.FUNNEL_URL, user_data,
    custom_data: { currency: "MXN", value, content_name: PRODUCTS[o.product].name, order_id: o.id } }],
    ...(env.META_TEST_EVENT_CODE ? { test_event_code: env.META_TEST_EVENT_CODE } : {}) };
  const r = await fetch(`https://graph.facebook.com/${env.META_API_VERSION || "v21.0"}/${env.META_PIXEL_ID}/events?access_token=${env.META_CAPI_TOKEN}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.ok && eventName === "Purchase") q.flag("capi_sent").run(o.id);
}

// TikTok Events API (server-side). Requiere TIKTOK_PIXEL_CODE y TIKTOK_EVENTS_TOKEN.
async function sendTikTok(orderId, eventName) {
  if (!env.TIKTOK_PIXEL_CODE || !env.TIKTOK_EVENTS_TOKEN) return;
  const o = q.get.get(orderId);
  if (!o) return;
  let u = {}; try { u = JSON.parse(o.utm || "{}"); } catch {}
  const user = { external_id: sha256(o.email || o.id) };
  if (o.email) user.email = sha256(o.email);
  if (o.phone) { let ph = String(o.phone).replace(/\D/g, "").replace(/^0+/, ""); if (ph.length === 10) ph = "52" + ph; if (ph.length >= 10) user.phone_number = sha256("+" + ph); }
  if (u.tt) user.ttclid = u.tt;
  if (u.ttp) user.ttp = u.ttp;
  const value = eventName === "CompletePayment" ? (o.paid_amount || o.amount) : o.amount;
  const body = { event_source: "web", event_source_id: env.TIKTOK_PIXEL_CODE,
    ...(env.TIKTOK_TEST_EVENT_CODE ? { test_event_code: env.TIKTOK_TEST_EVENT_CODE } : {}),
    data: [{ event: eventName, event_time: Math.floor(Date.now() / 1000), event_id: `${o.id}-${eventName}`, user,
      page: { url: env.FUNNEL_URL },
      properties: { currency: "MXN", value, content_type: "product", content_name: PRODUCTS[o.product].name, content_id: o.product,
        contents: [{ content_id: o.product, content_name: PRODUCTS[o.product].name, quantity: 1, price: value }] } }] };
  const r = await fetch("https://business-api.tiktok.com/open_api/v1.3/event/track/",
    { method: "POST", headers: { "Content-Type": "application/json", "Access-Token": env.TIKTOK_EVENTS_TOKEN }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  q.event.run(o.id, o.result_id || null, "tiktok_" + eventName, JSON.stringify({ ok: j.code === 0, code: j.code, msg: String(j.message || "").slice(0, 120) }));
}

app.get("/api/report", botKey, (_req, res) => res.json({
  events: db.prepare(`SELECT name, COUNT(*) n FROM events WHERE created_at > datetime('now','-7 days') GROUP BY name`).all(),
  orders: db.prepare(`SELECT product, status, COUNT(*) n, SUM(paid_amount) total FROM orders WHERE created_at > datetime('now','-7 days') GROUP BY product, status`).all(),
}));
app.get("/api/abandoned", botKey, (_req, res) => res.json(db.prepare(`SELECT id, product, name, email, phone, amount, clabe, reference, created_at FROM orders
  WHERE consent=1 AND status='awaiting_payment' AND created_at < datetime('now','-1 hour') AND created_at > datetime('now','-3 days')`).all()));

// ---------- Panel de métricas (admin) ----------
// Gasto/impresiones/clics se cargan a mano desde el Administrador de anuncios; el resto sale de los datos del embudo.
const adminKey = (req, res, next) => env.ADMIN_KEY && safeEq(req.get("x-admin-key"), env.ADMIN_KEY) ? next() : res.status(401).json({ error: "unauthorized" });
const here = path.dirname(fileURLToPath(import.meta.url));
app.get("/admin", (_req, res) => res.sendFile(path.join(here, "admin.html")));
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));
const tzMod = (req) => { const t = Math.max(-12, Math.min(14, Number(req.query.tz ?? -3))); return `${t >= 0 ? "+" : ""}${Math.trunc(t)} hours`; };
const todayStr = (mod) => db.prepare(`SELECT date('now', ?) d`).get(mod).d;

app.get("/admin/api/metrics", adminKey, (req, res) => {
  const mod = tzMod(req);
  const to = isDay(req.query.to) ? req.query.to : todayStr(mod);
  const from = isDay(req.query.from) ? req.query.from : to;
  const evs = db.prepare(`SELECT name, COUNT(*) n, COUNT(DISTINCT COALESCE(result_id, order_id, id)) u FROM events
    WHERE date(created_at, ?) BETWEEN ? AND ? GROUP BY name`).all(mod, from, to);
  const orders = db.prepare(`SELECT product, status, COUNT(*) n, COALESCE(SUM(amount),0) amount, COALESCE(SUM(paid_amount),0) paid FROM orders
    WHERE date(created_at, ?) BETWEEN ? AND ? GROUP BY product, status`).all(mod, from, to);
  const delivery = db.prepare(`SELECT COUNT(*) paid, SUM(CASE WHEN downloads>0 THEN 1 ELSE 0 END) downloaded,
    SUM(typebot_resumed) resumed, SUM(capi_sent) capi FROM orders WHERE status='paid' AND date(created_at, ?) BETWEEN ? AND ?`).get(mod, from, to);
  const sp = db.prepare(`SELECT COALESCE(SUM(spend),0) spend, COALESCE(SUM(impressions),0) impressions, COALESCE(SUM(clicks),0) clicks FROM spend WHERE day BETWEEN ? AND ?`).get(from, to);
  const daily = db.prepare(`SELECT date(created_at, ?) day, COUNT(*) n, COALESCE(SUM(paid_amount),0) paid FROM orders
    WHERE status='paid' AND product='ebook' AND date(created_at, ?) BETWEEN ? AND ? GROUP BY day ORDER BY day`).all(mod, mod, from, to);
  const byCreative = db.prepare(`SELECT COALESCE(NULLIF(json_extract(utm,'$.ct'),''),'(sin utm)') ct, COUNT(*) created,
    SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) paid, COALESCE(SUM(CASE WHEN status='paid' THEN paid_amount END),0) revenue
    FROM orders WHERE product='ebook' AND date(created_at, ?) BETWEEN ? AND ? GROUP BY ct ORDER BY paid DESC, created DESC`).all(mod, from, to);
  const spendByLabel = db.prepare(`SELECT label, COALESCE(SUM(spend),0) spend, COALESCE(SUM(impressions),0) impressions, COALESCE(SUM(clicks),0) clicks FROM spend
    WHERE day BETWEEN ? AND ? GROUP BY label`).all(from, to);
  res.json({ from, to, events: evs, orders, delivery, spend: sp, daily, byCreative, spendByLabel });
});

app.get("/admin/api/orders", adminKey, (req, res) => {
  const mod = tzMod(req);
  const to = isDay(req.query.to) ? req.query.to : todayStr(mod);
  const from = isDay(req.query.from) ? req.query.from : to;
  const rows = db.prepare(`SELECT id, product, status, amount, paid_amount, name, email, phone, consent, downloads, typebot_resumed, capi_sent,
    download_token, utm, created_at, updated_at FROM orders WHERE date(created_at, ?) BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 300`).all(mod, from, to);
  res.json(rows.map((o) => ({ ...o, downloadUrl: o.status === "paid" && o.download_token ? `${env.PUBLIC_BASE_URL}/d/${o.download_token}` : "", download_token: undefined })));
});

app.get("/admin/api/spend", adminKey, (_req, res) => res.json(db.prepare(`SELECT id, day, label, spend, impressions, clicks FROM spend ORDER BY day DESC, id DESC LIMIT 200`).all()));
app.post("/admin/api/spend", adminKey, (req, res) => {
  const b = req.body || {}; const num = (v) => Math.max(0, Number(String(v ?? 0).replace(",", ".")) || 0);
  if (!isDay(b.day)) return res.status(400).json({ error: "invalid_day" });
  const r = db.prepare(`INSERT INTO spend (day,label,spend,impressions,clicks) VALUES (?,?,?,?,?)`)
    .run(b.day, String(b.label || "").slice(0, 80), num(b.spend), Math.round(num(b.impressions)), Math.round(num(b.clicks)));
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.delete("/admin/api/spend/:id", adminKey, (req, res) => { db.prepare(`DELETE FROM spend WHERE id=?`).run(Number(req.params.id) || 0); res.json({ ok: true }); });

app.get("/health", (_req, res) => res.json({ ok: true, provider: provider.NAME }));
app.listen(env.PORT || 3000, () => console.log("Backend en el puerto " + (env.PORT || 3000) + " · proveedor " + provider.NAME));
