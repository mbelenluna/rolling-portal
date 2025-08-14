// Cloud Functions v2 (HTTP + CORS integrado)
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");

// Región por defecto para TODAS las functions
setGlobalOptions({ region: "us-central1" });

// Admin SDK (Storage via Admin)
const admin = require("firebase-admin");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const xlsx = require("xlsx");
const fileTypeLib = require("file-type");

// Stripe
const Stripe = require("stripe");
const functionsBase = require("firebase-functions"); // para runtime config (v1/v2)
const CFG = (functionsBase.config && functionsBase.config()) ? functionsBase.config() : {};

const STRIPE_SECRET_FROM_CFG = (CFG.stripe && CFG.stripe.secret_key) || null;
const WEBHOOK_SECRET_FROM_CFG = (CFG.stripe && CFG.stripe.webhook_secret) || null;
const ORIGIN_FROM_CFG = (CFG.checkout && CFG.checkout.origin) || null;


// === Inicializar Admin apuntando al bucket NUEVO (.firebasestorage.app)
admin.initializeApp({
    storageBucket: "rolling-crowdsourcing.firebasestorage.app",
});
const bucket = admin.storage().bucket();

/* ===================== Helpers ===================== */

// Contador de palabras simple (sin unicode properties)
function countWordsGeneric(text) {
    if (!text) return 0;
    const cleaned = String(text).replace(/[^A-Za-z0-9’'-]+/g, " ");
    const parts = cleaned.trim().split(/\s+/);
    return parts[0] === "" ? 0 : parts.length;
}

// ⚠️ MISMA tabla de tarifas que en el frontend (tramos grandes)
function rateForWords(words) {
    const w = Number(words || 0);
    if (w >= 1000000) return 0.04;
    if (w >= 500000) return 0.05;
    if (w >= 300000) return 0.055;
    if (w >= 100000) return 0.06;
    if (w >= 50000) return 0.07;
    if (w >= 10000) return 0.08;
    return 0.10;
}

function computeAmountCents(totalWords) {
    const MIN_USD = 1.0;
    const rate = rateForWords(totalWords || 0);
    const raw = (totalWords || 0) * rate;
    const total = Math.max(raw, MIN_USD);
    return { rate, amountCents: Math.round(total * 100) };
}

async function fileTypeFromBufferSafe(buf) {
    try { return await fileTypeLib.fileTypeFromBuffer(buf); }
    catch { return null; }
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
            // quitar timestamps de subtítulos
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

    // .doc legado (no fiable)
    if (ext === "doc") return "";

    // Fallback
    return buf.toString("utf8");
}

/* ===================== Function HTTP (v2) ===================== */
/**
 * HTTP onRequest con CORS integrado.
 * Frontend permitido: GitHub Pages de Belu.
 */

// === 1) getQuoteForFile (tu función existente, con tarifas alineadas) ===
exports.getQuoteForFile = onRequest(
    { cors: ["https://mbelenluna.github.io"] },
    async (req, res) => {
        try {
            if (req.method !== "POST") {
                return res.status(405).send("Method Not Allowed");
            }

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

            // Heurística: PDF sin texto detectable -> probablemente escaneado
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
            const total = Math.round(words * rate * 100) / 100;

            return res.json({ words, rate, total, currency: "USD" });

        } catch (err) {
            logger.error("getQuoteForFile error", err);
            return res.status(500).send(err.message || "Internal Server Error");
        }
    }
);

// === 2) createCheckoutSession (Stripe Checkout) ===
exports.createCheckoutSession = onRequest(
    // You can relax to { cors: true } temporarily if needed for testing
    { cors: ["https://mbelenluna.github.io"] },
    async (req, res) => {
        try {
            if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

            // --- robust config reads ---
            const STRIPE_SECRET =
                STRIPE_SECRET_FROM_CFG ||
                process.env.STRIPE_SECRET_KEY ||
                process.env.stripe_secret_key;

            if (!STRIPE_SECRET) {
                return res.status(500).json({ error: "Stripe secret key not configured" });
            }

            const stripe = new Stripe(STRIPE_SECRET, { apiVersion: "2024-06-20" });

            const { requestId, totalWords = 0, email, description } = req.body || {};
            if (!requestId) return res.status(400).json({ error: "Missing requestId" });

            const { rate, amountCents } = computeAmountCents(Number(totalWords || 0));

            const ORIGIN =
                ORIGIN_FROM_CFG ||
                process.env.CHECKOUT_ORIGIN ||
                process.env.checkout_origin ||
                "https://mbelenluna.github.io";

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

// === 3) stripeWebhook (marca como pagado) ===
// Importante: Stripe requiere RAW body para firmar. onRequest v2 expone req.rawBody.
exports.stripeWebhook = onRequest(
    { cors: false, maxInstances: 1 },
    async (req, res) => {
        try {
            const STRIPE_SECRET =
                process.env.STRIPE_SECRET_KEY ||
                process.env.stripe_secret_key;
            if (!STRIPE_SECRET) return res.status(500).send("Stripe not configured");

            const stripe = new Stripe(STRIPE_SECRET, { apiVersion: "2024-06-20" });

            const sig = req.headers["stripe-signature"];
            const whsec =
                process.env.STRIPE_WEBHOOK_SECRET ||
                process.env.stripe_webhook_secret;

            if (!sig || !whsec) {
                return res.status(400).send("Missing webhook signature or secret");
            }

            let event;
            try {
                event = stripe.webhooks.constructEvent(req.rawBody, sig, whsec);
            } catch (err) {
                return res.status(400).send(`Webhook Error: ${err.message}`);
            }

            if (event.type === "checkout.session.completed") {
                const session = event.data.object;
                const requestId = session?.metadata?.requestId;
                const amountTotal = session?.amount_total; // cents
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
                }
            }

            return res.json({ received: true });
        } catch (err) {
            logger.error("Webhook handler error", err);
            return res.status(500).send("Webhook handler error");
        }
    }
);