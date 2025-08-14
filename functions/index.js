// Cloud Functions v2 (HTTP + CORS integrado)
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");

// Región por defecto para TODAS las functions
setGlobalOptions({ region: "us-central1" });

// Admin SDK (Storage via Admin)
const admin = require("firebase-admin");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const xlsx = require("xlsx");
const fileTypeLib = require("file-type");

// Inicializar Admin apuntando al bucket NUEVO (.firebasestorage.app)
admin.initializeApp({
    storageBucket: "rolling-crowdsourcing.firebasestorage.app",
});
const bucket = admin.storage().bucket();

/* ===================== Helpers ===================== */

// Contador de palabras simple (sin unicode properties para evitar errores de lint)
function countWordsGeneric(text) {
    if (!text) return 0;
    // Reemplaza caracteres no alfanuméricos por espacios
    const cleaned = String(text).replace(/[^A-Za-z0-9’'-]+/g, " ");
    const parts = cleaned.trim().split(/\s+/);
    return parts[0] === "" ? 0 : parts.length;
}

function rateForWords(words) {
    if (words >= 300000) return 0.05;
    if (words >= 100000) return 0.06;
    if (words >= 10000) return 0.07;
    if (words >= 1000) return 0.09;
    return 0.10;
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
 * HTTP onRequest con CORS integrado. Permitimos SOLO tu frontend de GitHub Pages.
 * Frontend: fetch("https://us-central1-rolling-crowdsourcing.cloudfunctions.net/getQuoteForFile", { method:"POST", ... })
 */
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
            console.error("getQuoteForFile error:", err);
            return res.status(500).send(err.message || "Internal Server Error");
        }
    }
);
