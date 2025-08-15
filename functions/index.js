// ===== Cloud Functions for Firebase v2 (Node.js 22) =====
const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

// Admin SDK
const admin = require("firebase-admin");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const xlsx = require("xlsx");
const fileTypeLib = require("file-type");

// Stripe + SendGrid
const Stripe = require("stripe");
const sgMail = require("@sendgrid/mail");

// ===== Global options & init =====
setGlobalOptions({ region: "us-central1" });

// Initialize Admin with your *new* GCS bucket (firebasestorage.app)
if (!admin.apps.length) {
  admin.initializeApp({
    storageBucket: "rolling-crowdsourcing.firebasestorage.app",
  });
}
const bucket = admin.storage().bucket();

// ===== Parameters / Secrets =====
// Secrets: set with `firebase functions:secrets:set NAME`
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");
const SENDGRID_API_KEY = defineSecret("SENDGRID_API_KEY");

// Config param (lowercase): set with `firebase functions:config:set checkout_origin="https://mbelenluna.github.io/rolling-portal"`
const CHECKOUT_ORIGIN = defineString("checkout_origin");

// Allowed CORS origins for your frontend(s)
const ALLOWED_ORIGINS = [
  "https://mbelenluna.github.io",
  "https://mbelenluna.github.io/rolling-portal",
  "https://rolling-translations.com",
  "https://www.rolling-translations.com",
];

// ===== Helpers: quoting / parsing =====
const MIN_TOTAL_USD = 1.0;

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
  const w = Number(totalWords || 0);
  const rate = rateForWords(w);
  const raw = w * rate;
  const totalUsd = Math.max(raw, MIN_TOTAL_USD);
  return {
    rate,
    amountUsd: totalUsd,
    amountCents: Math.round(totalUsd * 100),
  };
}

// Simple word counter (safe without unicode props)
function countWordsGeneric(text) {
  if (!text) return 0;
  const cleaned = String(text).replace(/[^A-Za-z0-9’'-]+/g, " ");
  const parts = cleaned.trim().split(/\s+/);
  return parts[0] === "" ? 0 : parts.length;
}

async function fileTypeFromBufferSafe(buf) {
  try { return await fileTypeLib.fileTypeFromBuffer(buf); }
  catch { return null; }
}

async function extractTextFromBuffer(buf, filename) {
  const ft = await fileTypeFromBufferSafe(buf);
  const mime = ft && ft.mime ? ft.mime : "";
  const ext = (filename.split(".").pop() || "").toLowerCase();

  // Text-like
  if (mime.startsWith("text/") || ["txt", "csv", "srt", "vtt", "md", "html", "json"].includes(ext)) {
    let text = buf.toString("utf8");
    if (ext === "json") {
      try { text = JSON.stringify(JSON.parse(text)); } catch { }
    }
    if (ext === "srt" || ext === "vtt") {
      text = text.replace(/\d{2}:\d{2}:\d{2}[,\.]\d{3} --> .+\n/g, " ");
    }
    return text;
  }

  // PDF
  if (mime === "application/pdf" || ext === "pdf") {
    const data = await pdfParse(buf);
    return data.text || "";
  }

  // DOCX
  if (ext === "docx" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const res = await mammoth.extractRawText({ buffer: buf });
    return (res && res.value) || "";
  }

  // XLS/XLSX
  if (
    ["xlsx", "xls"].includes(ext) ||
    (mime && (mime.includes("spreadsheetml") || mime.includes("ms-excel")))
  ) {
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

  // Legacy .doc → ignore text
  if (ext === "doc") return "";

  // Fallback
  return buf.toString("utf8");
}

// ===== 1) Auto-quote HTTP (CORS) =====
exports.getQuoteForFile = onRequest(
  {
    cors: ALLOWED_ORIGINS,
    region: "us-central1",
  },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        return res.status(405).send("Method Not Allowed");
      }

      const { gsPath, uid } = req.body || {};
      if (!gsPath) return res.status(400).send("Missing gsPath.");
      if (!uid || !gsPath.startsWith(`crowd/uploads/${uid}/`)) {
        return res.status(403).send("Forbidden path.");
      }

      const file = bucket.file(gsPath);
      const [buf] = await file.download();

      const text = await extractTextFromBuffer(buf, gsPath);
      let words = countWordsGeneric(text);

      // Heuristic: scanned PDF (no visible text)
      const scanned = words < 10 && gsPath.toLowerCase().endsWith(".pdf");
      if (scanned) {
        return res.json({
          words: 0,
          scanned: true,
          rate: null,
          total: null,
          note: "Likely scanned PDF (requires OCR)."
        });
      }

      const rate = rateForWords(words);
      const total = Math.round(Math.max(words * rate, MIN_TOTAL_USD) * 100) / 100;

      return res.json({ words, rate, total, currency: "USD" });
    } catch (err) {
      logger.error("getQuoteForFile error", err);
      return res.status(500).send(err.message || "Internal Server Error");
    }
  }
);

// ===== 2) Stripe Checkout session creator =====
exports.createCheckoutSession = onRequest(
  {
    cors: ALLOWED_ORIGINS,
    region: "us-central1",
    secrets: [STRIPE_SECRET_KEY],
  },
  async (req, res) => {
    try {
      if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

      const stripeSecret = STRIPE_SECRET_KEY.value();
      if (!stripeSecret) {
        return res.status(500).json({ error: "Stripe secret key not configured" });
      }
      const stripe = new Stripe(stripeSecret, { apiVersion: "2024-06-20" });

      const { requestId, totalWords = 0, email, description } = req.body || {};
      if (!requestId) return res.status(400).json({ error: "Missing requestId" });

      // Optionally, fetch Firestore doc to cross-check
      let wordsServer = Number(totalWords || 0);
      try {
        const snap = await admin.firestore().collection("crowdRequests").doc(requestId).get();
        if (snap.exists) {
          const d = snap.data() || {};
          if (Number(d.totalWords) > 0) wordsServer = Number(d.totalWords);
          else if (Number(d.estWords) > 0) wordsServer = Number(d.estWords);
        }
      } catch (_) { }

      const { rate, amountCents } = computeAmountCents(wordsServer);

      const origin = CHECKOUT_ORIGIN.value() || "https://mbelenluna.github.io/rolling-portal";

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: email || undefined,
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: {
              name: "Crowdsourced translation",
              description: description || `Total words: ${wordsServer}`
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        }],
        success_url: `${origin.replace(/\/+$/, '')}/success.html?session_id={CHECKOUT_SESSION_ID}&requestId=${encodeURIComponent(requestId)}`,
        cancel_url: `${origin.replace(/\/+$/, '')}/cancel.html?requestId=${encodeURIComponent(requestId)}`,
        payment_intent_data: {
          description: `Crowdsourced translation — ${wordsServer} words @ ${rate.toFixed(2)}/word`,
          metadata: { requestId, totalWords: String(wordsServer) }
        },
        metadata: { requestId, totalWords: String(wordsServer) }
      });

      await admin.firestore().collection("crowdRequests").doc(requestId).set({
        stripeSessionId: session.id,
        stripeMode: "payment",
        checkoutCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "pending_payment",
      }, { merge: true });

      return res.json({ url: session.url });
    } catch (err) {
      logger.error("createCheckoutSession error", err);
      return res.status(500).json({ error: err?.message || "Server error" });
    }
  }
);

// ===== 3) Stripe Webhook (verifies signature) =====
exports.stripeWebhook = onRequest(
  {
    region: "us-central1",
    // Stripe (server-to-server) doesn't need CORS
    secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SENDGRID_API_KEY],
  },
  async (req, res) => {
    try {
      const stripeSecret = STRIPE_SECRET_KEY.value();
      const webhookSecret = STRIPE_WEBHOOK_SECRET.value();
      if (!stripeSecret || !webhookSecret) {
        logger.error("Missing Stripe secrets");
        return res.status(500).send("Secrets not configured");
      }
      const stripe = new Stripe(stripeSecret, { apiVersion: "2024-06-20" });

      const sig = req.headers["stripe-signature"];
      let event;

      try {
        // IMPORTANT: use the raw body for verification
        event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
      } catch (err) {
        logger.error("Webhook signature verification failed", err);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const paymentIntentId = session.payment_intent;
        const requestId = session.metadata && session.metadata.requestId;
        const totalWords = session.metadata && Number(session.metadata.totalWords || 0);
        const amountTotal = typeof session.amount_total === "number" ? session.amount_total : null;

        if (!requestId) {
          logger.warn("checkout.session.completed without requestId in metadata");
        } else {
          try {
            await admin.firestore().collection("crowdRequests").doc(requestId).set({
              status: "paid",
              paidAt: admin.firestore.FieldValue.serverTimestamp(),
              paymentIntentId: paymentIntentId || null,
              amountPaid: amountTotal != null ? amountTotal / 100 : null,
            }, { merge: true });
          } catch (e) {
            logger.error("Failed to update Firestore on payment", e);
          }

          // ==== Send emails with SendGrid ====
          try {
            sgMail.setApiKey(SENDGRID_API_KEY.value());

            // Retrieve doc for more details
            let docData = {};
            try {
              const snap = await admin.firestore().collection("crowdRequests").doc(requestId).get();
              if (snap.exists) docData = snap.data() || {};
            } catch (_) { }

            const clientEmail = docData.email || session.customer_details?.email || "";
            const clientName = docData.fullName || "Client";
            const sourceLang = docData.sourceLang || "—";
            const targetLang = docData.targetLang || "—";
            const nf = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
            const amountStr = amountTotal != null ? nf.format(amountTotal / 100) : "—";

            const html = `
              <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Inter;">
                <h2 style="margin:0 0 8px 0;">Your order is confirmed ✅</h2>
                <p style="margin:0 0 14px 0;">Thank you for choosing <b>Rolling Translations</b>!</p>
                <table style="border-collapse:collapse;width:100%;max-width:560px">
                  <tr><td style="padding:8px 0;color:#64748b">Order ID</td><td style="padding:8px 0"><b>${requestId}</b></td></tr>
                  <tr><td style="padding:8px 0;color:#64748b">Languages</td><td style="padding:8px 0">${sourceLang} → ${targetLang}</td></tr>
                  <tr><td style="padding:8px 0;color:#64748b">Total words</td><td style="padding:8px 0">${Number.isFinite(totalWords) ? totalWords : (docData.totalWords ?? docData.estWords ?? "—")}</td></tr>
                  <tr><td style="padding:8px 0;color:#64748b">Amount paid</td><td style="padding:8px 0"><b>${amountStr}</b></td></tr>
                </table>
                <p style="margin:16px 0 8px 0;">
                  We’ll start processing your request and email you with updates shortly.
                </p>
                <p style="margin:0 0 14px 0;">
                  Questions? <a href="mailto:info@rolling-translations.com">info@rolling-translations.com</a>.
                </p>
                <p style="margin:18px 0 0 0;color:#64748b;font-size:13px">— Rolling Translations</p>
              </div>
            `;

            const msgs = [];
            if (clientEmail) {
              msgs.push({
                to: clientEmail,
                from: { email: "info@rolling-translations.com", name: "Rolling Translations" },
                subject: `Order ${requestId} confirmed — Rolling Translations`,
                html,
              });
            }
            // Internal copy
            msgs.push({
              to: "info@rolling-translations.com",
              from: { email: "info@rolling-translations.com", name: "Rolling Translations" },
              subject: `New paid order — ${requestId}`,
              html,
            });

            if (msgs.length) await sgMail.send(msgs);
          } catch (mailErr) {
            logger.error("SendGrid send failed", mailErr?.response?.body || mailErr?.message || mailErr);
          }
        }
      }

      // Must return 200 to Stripe quickly
      res.json({ received: true });
    } catch (err) {
      logger.error("stripeWebhook error", err);
      return res.status(500).send("Webhook handler error");
    }
  }
);

// ===== 4) Firestore trigger: email on new request (pre-payment receipt) =====
exports.emailOnRequestCreated = onDocumentCreated(
  {
    document: "crowdRequests/{requestId}",
    region: "us-central1",
    secrets: [SENDGRID_API_KEY],
  },
  async (event) => {
    const data = event.data?.data() || {};
    const requestId = event.params.requestId;

    try {
      const clientEmail = data.email || data.clientEmail || "";
      const clientName = data.fullName || data.fullname || "Client";
      const sourceLang = data.sourceLang || "—";
      const targetLang = data.targetLang || "—";
      const totalWords = Number(data.totalWords ?? data.estWords ?? data.words ?? 0);
      const rate = Number(data.rate ?? 0);
      const estTotal = typeof data.estimatedTotal === "number" ? Number(data.estimatedTotal) : null;

      const nf = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
      const amountStr = estTotal != null ? nf.format(estTotal) : "—";
      const rateStr = rate ? `$${rate.toFixed(2)}/word` : "—";

      const htmlClient = `
        <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Inter;">
          <h2 style="margin:0 0 10px 0;">We received your request ✅</h2>
          <p style="margin:0 0 12px 0;">Hi ${clientName}, thanks for choosing <b>Rolling Translations</b>!</p>
          <table style="border-collapse:collapse;width:100%;max-width:560px">
            <tr><td style="padding:6px 0;color:#64748b">Order ID</td><td style="padding:6px 0"><b>${requestId}</b></td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Languages</td><td style="padding:6px 0">${sourceLang} → ${targetLang}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Total words</td><td style="padding:6px 0">${totalWords || "—"}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Rate</td><td style="padding:6px 0">${rateStr}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Estimate</td><td style="padding:6px 0"><b>${amountStr}</b></td></tr>
          </table>
          <p style="margin:14px 0 0 0;">To complete your order, please finish the payment you just started. We'll email you once it's confirmed.</p>
          <p style="margin:14px 0 0 0;">Questions? <a href="mailto:info@rolling-translations.com">info@rolling-translations.com</a>.</p>
          <p style="margin:18px 0 0 0;color:#64748b;font-size:13px">— Rolling Translations</p>
        </div>
      `;

      const htmlInternal = `
        <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Inter;">
          <h3 style="margin:0 0 10px 0;">New crowdsourcing request</h3>
          <table style="border-collapse:collapse;width:100%;max-width:560px">
            <tr><td style="padding:6px 0;color:#64748b">Order ID</td><td style="padding:6px 0"><b>${requestId}</b></td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Client</td><td style="padding:6px 0">${clientName} &lt;${clientEmail || "—"}&gt;</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Languages</td><td style="padding:6px 0">${sourceLang} → ${targetLang}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Words</td><td style="padding:6px 0">${totalWords || "—"}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Rate</td><td style="padding:6px 0">${rateStr}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Estimate</td><td style="padding:6px 0"><b>${amountStr}</b></td></tr>
          </table>
        </div>
      `;

      sgMail.setApiKey(SENDGRID_API_KEY.value());

      const messages = [];
      if (clientEmail) {
        messages.push({
          to: clientEmail,
          from: { email: "info@rolling-translations.com", name: "Rolling Translations" },
          subject: `We received your request — ${requestId}`,
          html: htmlClient,
        });
      }
      messages.push({
        to: "info@rolling-translations.com",
        from: { email: "info@rolling-translations.com", name: "Rolling Translations" },
        subject: `New crowdsourcing request — ${requestId}`,
        html: htmlInternal,
      });

      if (messages.length) await sgMail.send(messages);
      logger.info("Emails sent for new request", { requestId });
    } catch (err) {
      logger.error("emailOnRequestCreated error", err?.response?.body || err?.message || err);
    }
  }
);
