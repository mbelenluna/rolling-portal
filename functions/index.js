/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const { setGlobalOptions } = require("firebase-functions");
const { onRequest } = require("firebase-functions/https");
const logger = require("firebase-functions/logger");
import * as admin from "firebase-admin";
import * as functions from "firebase-functions";
import pdf from "pdf-parse";
import mammoth from "mammoth";
import xlsx from "xlsx";
import { fileTypeFromBuffer } from "file-type";

admin.initializeApp();
const db = admin.firestore();
const bucket = admin.storage().bucket();

// --- helpers ---
function countWordsGeneric(text) {
    if (!text) return 0;
    // Heuristic: count CJK chars as words; otherwise split on word-ish tokens
    const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
    const latin = (text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, ""))
        .trim()
        .match(/[A-Za-zÀ-ÖØ-öø-ÿ0-9]+(?:['’-][A-Za-z0-9]+)*/g);
    return cjk + (latin ? latin.length : 0);
}

function rateForWords(words) {
    if (words >= 300000) return 0.05;
    if (words >= 100000) return 0.06;
    if (words >= 10000) return 0.07;
    if (words >= 1000) return 0.09;
    return 0.10;
}

async function extractTextFromBuffer(buf, filename = "") {
    const ft = await fileTypeFromBuffer(buf);
    const mime = ft?.mime || "";

    // Quick routes by mime/extension
    const ext = (filename.split(".").pop() || "").toLowerCase();

    // Plain text / csv / json / srt / vtt
    if (mime.startsWith("text/") || ["txt", "csv", "srt", "vtt", "md", "html", "json"].includes(ext)) {
        let text = buf.toString("utf8");
        if (ext === "json") {
            try {
                const obj = JSON.parse(text);
                text = JSON.stringify(obj); // flatten; you can cherry-pick keys if needed
            } catch { }
        }
        if (ext === "srt" || ext === "vtt") {
            text = text.replace(/\d{2}:\d{2}:\d{2}[,\.]\d{3} --> .+\n/g, ""); // drop timestamps
        }
        return text;
    }

    // PDF (text-based; scans will return little/none)
    if (mime === "application/pdf" || ext === "pdf") {
        const data = await pdf(buf);
        return data.text || "";
    }

    // DOCX
    if (ext === "docx" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        const { value } = await mammoth.extractRawText({ buffer: buf });
        return value || "";
    }

    // XLS/XLSX
    if (["xlsx", "xls"].includes(ext) || mime.includes("spreadsheetml") || mime.includes("ms-excel")) {
        const wb = xlsx.read(buf, { type: "buffer" });
        let text = "";
        for (const sheetName of wb.SheetNames) {
            const sheet = wb.Sheets[sheetName];
            const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false });
            for (const row of rows) text += " " + row.filter(Boolean).join(" ");
        }
        return text;
    }

    // Unsupported legacy .doc: recommend resaving as .docx
    if (ext === "doc") {
        return ""; // we’ll treat as 0 and ask user to upload DOCX/PDF/TXT
    }

    // Fallback: try utf8
    return buf.toString("utf8");
}

// === Callable function: getQuoteForFile ===
// data: { gsPath: "crowd/uploads/<uid>/<file>", langPair?: "en>es" }
export const getQuoteForFile = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Sign in required.");
    }
    const gsPath = data?.gsPath;
    if (!gsPath || typeof gsPath !== "string") {
        throw new functions.https.HttpsError("invalid-argument", "Missing gsPath.");
    }

    // security: only allow access to own path
    const uid = context.auth.uid;
    if (!gsPath.startsWith(`crowd/uploads/${uid}/`)) {
        throw new functions.https.HttpsError("permission-denied", "Forbidden path.");
    }

    // download from Storage
    const file = bucket.file(gsPath);
    const [buf] = await file.download();

    // extract & count
    const text = await extractTextFromBuffer(buf, gsPath);
    let words = countWordsGeneric(text);

    // if it looks like a scanned PDF (very few chars), ask for estimate
    const scanned = words < 10 && gsPath.toLowerCase().endsWith(".pdf");
    if (scanned) {
        return { words: 0, scanned: true, rate: null, total: null, note: "PDF appears to be a scan (OCR required)." };
    }

    // quote
    const rate = rateForWords(words);
    const total = Math.round(words * rate * 100) / 100;

    return { words, rate, total, currency: "USD" };
});

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
setGlobalOptions({ maxInstances: 10 });

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });
