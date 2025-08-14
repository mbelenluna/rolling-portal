const functions = require("firebase-functions");
const cors = require("cors")({ origin: true });

// Asegúrate de tener inicializado admin y bucket antes:
const admin = require("firebase-admin");
const { Storage } = require("@google-cloud/storage");
const storage = new Storage();
const bucket = storage.bucket("rolling-crowdsourcing.appspot.com");

// Aquí van tus helpers
// const extractTextFromBuffer = ...
// const countWordsGeneric = ...
// const rateForWords = ...

exports.getQuoteForFile = functions
    .region("us-central1")
    .https.onRequest((req, res) => {
        cors(req, res, async () => {
            try {
                // Validar método
                if (req.method !== "POST") {
                    return res.status(405).send("Method Not Allowed");
                }

                const { gsPath, uid } = req.body || {};

                if (!gsPath || typeof gsPath !== "string") {
                    return res.status(400).send("Missing gsPath.");
                }
                if (!uid || !gsPath.startsWith(`crowd/uploads/${uid}/`)) {
                    return res.status(403).send("Forbidden path.");
                }

                const file = bucket.file(gsPath);
                const [buf] = await file.download();

                const text = await extractTextFromBuffer(buf, gsPath);
                let words = countWordsGeneric(text);

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

                return res.json({
                    words,
                    rate,
                    total,
                    currency: "USD"
                });

            } catch (err) {
                console.error("getQuoteForFile error:", err);
                res.status(500).send(err.message || "Internal Server Error");
            }
        });
    });
