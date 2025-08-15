// Cloud Functions v2 (HTTP + CORS integrado)
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

// Región por defecto para TODAS las functions
setGlobalOptions({ region: "us-central1" });

// ===== Admin SDK =====
const admin = require("firebase-admin");
admin.initializeApp({
  storageBucket: "rolling-crowdsourcing.firebasestorage.app",
});
const bucket = admin.storage().bucket();

/* ===================== Config via Params/Secrets (v2) =====================
    SECRETS (usa el prompt y pega los valores cuando te lo pida):
      firebase functions:secrets:set STRIPE_SECRET_KEY
      firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
      firebase functions:secrets:set SENDGRID_API_KEY

    STRING PARAM (minúsculas recomendado). Si no lo seteás, usa el default.
      firebase functions:config:set checkout_origin="https://mbelenluna.github.io/rolling-portal"
*/
const STRIPE_SECRET = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");
const SENDGRID_API_KEY = defineSecret("SENDGRID_API_KEY");

// Permitimos dos nombres (mayúsculas y minúsculas) para el origen, por compatibilidad:
const CHECKOUT_ORIGIN_UPPER = defineString("CHECKOUT_ORIGIN", { default: "" });
const CHECKOUT_ORIGIN_LOWER = defineString("checkout_origin", { default: "https://mbelenluna.github.io/rolling-portal" });
function getCheckoutOrigin() {
  return CHECKOUT_ORIGIN_LOWER.value() || CHECKOUT_ORIGIN_UPPER.value() || "https://mbelenluna.github.io/rolling-portal";
}

/* ===================== Helpers ===================== */

function countWordsGeneric(text) {
  if (!text) return 0;
  const cleaned = String(text).replace(/[^A-Za-z0-9’'-]+/g, " ");
  const parts = cleaned.trim().split(/\s+/);
  return parts[0] === "" ? 0 : parts.length;
}

function rateForWords(words) {
  const w = Number(words || 0);
  if (w >= 1_000_000) return 0.04;
  if (w >= 500_000) return 0.05;
  if (w >= 300_000) return 0.055;
  if (w >= 100_000) return 0.06;
  if (w >= 50_000) return 0.07;
  if (w >= 10_000) return 0.08;
  return 0.10;
}

function computeAmountCents(totalWords) {
  const MIN_USD = 1.0;
  const rate = rateForWords(totalWords || 0);
  const raw = (totalWords || 0) * rate;
  const total = Math.max(raw, MIN_USD);
  return { rate, amountCents: Math.round(total * 100) };
}

// file-type es ESM: import dinámico (evita problemas de arranque)
async function fileTypeFromBufferSafe(buf) {
  try {
    const { fileTypeFromBuffer } = await import("file-type");
    return await fileTypeFromBuffer(buf);
  } catch {
    return null;
  }
}

async function extractTextFromBuffer(buf, filename) {
  const ft = await fileTypeFromBufferSafe(buf);
  const mime = ft && ft.mime ? ft.mime : "";
  const ext = (filename.split(".").pop() || "").toLowerCase();

  // Text / CSV / JSON / SRT / VTT / MD / HTML
  if (mime.startsWith("text/") || ["txt", "csv", "srt", "vtt", "md", "html", "json"].includes(ext)) {
    let text = buf.toString("utf8");
    if (ext === "json") {
      try { text = JSON.stringify(JSON.parse(text)); } catch { }
    }
    if (ext === "srt" || ext === "vtt") {
      // quitar timestamps
      text = text.replace(/\d{2}:\d{2}:\d{2}[,\.]\d{3} --> .+\n/g, " ");
    }
    return text;
  }

  // PDF
  if (mime === "application/pdf" || ext === "pdf") {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(buf);
    return data.text || "";
  }

  // DOCX
  if (ext === "docx" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const mammoth = require("mammoth");
    const res = await mammoth.extractRawText({ buffer: buf });
    return (res && res.value) || "";
  }

  // XLS/XLSX
  if (
    ["xlsx", "xls"].includes(ext) ||
    (mime && (mime.includes("spreadsheetml") || mime.includes("ms-excel")))
  ) {
    const xlsx = require("xlsx");
    const wb = xlsx.read(buf, { type: "buffer" });
    let text = "";
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false });
      for (const row of rows) {
        const line = (row || []).filter(Boolean).join(" ");
        if (line) text += " " + line;
      }
    }
    return text;
  }

  if (ext === "doc") return ""; // .doc legado (sin OCR)
  return buf.toString("utf8");
}

/* ===================== Functions ===================== */

// 1) Conteo de palabras + cotización base
exports.getQuoteForFile = onRequest(
  { cors: ["https://mbelenluna.github.io"] },
  async (req, res) => {
    try {
      if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

      const body = req.body || {};
      const gsPath = typeof body.gsPath === "string" ? body.gsPath : null;
      const uid = typeof body.uid === "string" ? body.uid : null;
      if (!gsPath) return res.status(400).send("Missing gsPath.");
      if (!uid || !gsPath.startsWith(`crowd/uploads/${uid}/`)) {
        return res.status(403).send("Forbidden path.");
      }

      const file = bucket.file(gsPath);
      const [buf] = await file.download();
      const text = await extractTextFromBuffer(buf, gsPath);
      let words = countWordsGeneric(text);

      // Heurística PDF escaneado
      const scanned = words < 10 && gsPath.toLowerCase().endsWith(".pdf");
      if (scanned) {
        return res.json({
          words: 0, scanned: true, rate: null, total: null,
          note: "Likely scanned PDF (requires OCR)."
        });
      }

      const rate = rateForWords(words);
      const total = Math.round(words * rate * 100) / 100;
      return res.json({ words, rate, total, currency: "USD" });
    } catch (err) {
      logger.error("getQuoteForFile error", err);
      return res.status(500).send(err.message || "Internal Server Error");
    }
  }
);

// 2) Stripe Checkout (crea sesión)
exports.createCheckoutSession = onRequest(
  { cors: ["https://mbelenluna.github.io"], secrets: [STRIPE_SECRET] },
  async (req, res) => {
    try {
      if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
      const Stripe = require("stripe");

      const secret = STRIPE_SECRET.value();
      if (!secret) return res.status(500).json({ error: "Stripe secret key not configured" });

      const stripe = new Stripe(secret, { apiVersion: "2024-06-20" });
      const ORIGIN = getCheckoutOrigin();

      const { requestId, email, description } = req.body || {};
      if (!requestId) return res.status(400).json({ error: "Missing requestId" });

      const snap = await admin.firestore().collection("crowdRequests").doc(requestId).get();
      if (!snap.exists) return res.status(404).json({ error: "Request not found" });
      const data = snap.data();
      const totalWords = Number(data.totalWords || 0);

      const { rate, amountCents } = computeAmountCents(totalWords);

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: email || undefined,
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: {
              name: "Crowdsourced translation",
              description: description || `Total words: ${totalWords}`
            },
            unit_amount: amountCents
          },
          quantity: 1
        }],
        success_url: `${ORIGIN}/success?session_id={CHECKOUT_SESSION_ID}&requestId=${encodeURIComponent(requestId)}`,
        cancel_url: `${ORIGIN}/cancel?requestId=${encodeURIComponent(requestId)}`,
        payment_intent_data: {
          description: `Crowdsourced translation — ${totalWords} words @ ${rate.toFixed(2)}/word`,
          metadata: { requestId, totalWords: String(totalWords) }
        },
        metadata: { requestId, totalWords: String(totalWords) }
      });

      await admin.firestore().collection("crowdRequests").doc(requestId).set({
        stripeSessionId: session.id,
        stripeMode: "payment",
        checkoutCreatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      return res.json({ url: session.url });
    } catch (err) {
      logger.error("createCheckoutSession error", err);
      return res.status(500).json({ error: err?.message || "Server error" });
    }
  }
);

// 3) Webhook de Stripe + Email de confirmación (SendGrid)
exports.stripeWebhook = onRequest(
  { cors: false, maxInstances: 1, secrets: [STRIPE_SECRET, STRIPE_WEBHOOK_SECRET, SENDGRID_API_KEY] },
  async (req, res) => {
    try {
      const Stripe = require("stripe");
      const secret = STRIPE_SECRET.value();
      const whsec = STRIPE_WEBHOOK_SECRET.value();
      if (!secret) return res.status(500).send("Stripe not configured");
      if (!whsec) return res.status(500).send("Webhook secret not configured");

      const stripe = new Stripe(secret, { apiVersion: "2024-06-20" });

      const sig = req.headers["stripe-signature"];
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.rawBody, sig, whsec);
      } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const requestId = session?.metadata?.requestId;
        const amountTotal = session?.amount_total;
        const paymentIntentId = session?.payment_intent;

        if (requestId) {
          await admin.firestore().collection("crowdRequests").doc(requestId).set({
            status: "paid",
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            payment: {
              amountCents: amountTotal ?? null,
              currency: session?.currency ?? "usd",
              sessionId: session.id,
              paymentIntentId: paymentIntentId || null
            }
          }, { merge: true });

          // === Email de confirmación (SendGrid) ===
          try {
            const snapReq = await admin.firestore().collection("crowdRequests").doc(requestId).get();
            const data = snapReq.exists ? snapReq.data() : {};
            const toEmail =
              data?.email ||
              session?.customer_details?.email ||
              "info@rolling-translations.com"; // fallback prudente

            const nf = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
            const totalWords = Number(data?.totalWords || session?.metadata?.totalWords || 0);
            const rate = Number(data?.rate || 0);
            const estTotal = data?.estimatedTotal != null
              ? Number(data.estimatedTotal)
              : (typeof amountTotal === "number" ? amountTotal / 100 : null);

            const html = `
              <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Inter;">
                <h2 style="margin:0 0 8px 0;">Your order is confirmed ✅</h2>
                <p style="margin:0 0 14px 0;">Thank you for choosing <b>Rolling Translations</b>!</p>
                <table style="border-collapse:collapse;width:100%;max-width:560px">
                  <tr><td style="padding:8px 0;color:#64748b">Order ID</td><td style="padding:8px 0"><b>${requestId}</b></td></tr>
                  <tr><td style="padding:8px 0;color:#64748b">Languages</td><td style="padding:8px 0">${(data?.sourceLang || "—")} → ${(data?.targetLang || "—")}</td></tr>
                  <tr><td style="padding:8px 0;color:#64748b">Total words</td><td style="padding:8px 0">${totalWords || "—"}</td></tr>
                  <tr><td style="padding:8px 0;color:#64748b">Rate</td><td style="padding:8px 0">${rate ? `$${rate.toFixed(2)}/word` : "—"}</td></tr>
                  <tr><td style="padding:8px 0;color:#64748b">Amount</td><td style="padding:8px 0"><b>${estTotal != null ? nf.format(estTotal) : "—"}</b></td></tr>
                </table>
                <p style="margin:16px 0 8px 0;">
                  We’ll start processing your request and email you with updates shortly.
                </p>
                <p style="margin:0 0 14px 0;">
                  Questions or requests in the meantime? Write us at
                  <a href="mailto:info@rolling-translations.com">info@rolling-translations.com</a>.
                </p>
                <p style="margin:18px 0 0 0;color:#64748b;font-size:13px">
                  — Rolling Translations
                </p>
              </div>
            `;

            const sgMail = require("@sendgrid/mail");
            sgMail.setApiKey(SENDGRID_API_KEY.value());

            // Cliente
            await sgMail.send({
              to: toEmail,
              from: { email: "info@rolling-translations.com", name: "Rolling Translations" },
              subject: `Order ${requestId} confirmed — Rolling Translations`,
              html,
            });

            // Copia interna (opcional)
            try {
              await sgMail.send({
                to: "info@rolling-translations.com",
                from: { email: "info@rolling-translations.com", name: "Rolling Translations" },
                subject: `New paid order ${requestId}`,
                html,
              });
            } catch (e) {
              logger.warn("SendGrid internal copy failed", e);
            }
          } catch (mailErr) {
            logger.error("SendGrid send failed", mailErr);
            // No devolvemos 500 para que Stripe no reintente por un fallo de email.
          }
        }
      }

      return res.json({ received: true });
    } catch (err) {
      logger.error("Webhook handler error", err);
      return res.status(500).send("Webhook handler error");
    }
  }
);

// 4) Ping de salud
exports.ping = onRequest({ cors: true }, (req, res) => res.send("ok"));
