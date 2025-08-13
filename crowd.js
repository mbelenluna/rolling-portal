import { initializeApp } from "https://www.gstatic.com/firebasejs/11.7.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.7.1/firebase-auth.js";
import { getFirestore, doc, getDoc, addDoc, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.7.1/firebase-firestore.js";
import { getStorage, ref, uploadBytes } from "https://www.gstatic.com/firebasejs/11.7.1/firebase-storage.js";

// Firebase init (same project)
const firebaseConfig = {
  apiKey: "AIzaSyBYjq_CaTEfFhfTChfJ6SnXSbgIzbbRHHc",
  authDomain: "rollingtranslationsportal.firebaseapp.com",
  projectId: "rollingtranslationsportal",
  storageBucket: "rollingtranslationsportal.firebasestorage.app",
  messagingSenderId: "492156326175",
  appId: "1:492156326175:web:14175badae2bbaada0e02a"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// State
let clientFullName = "";
let clientOrg = "";
let clientEmail = "";

// Auth guard
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }
  clientEmail = user.email || "";
  const userRef = doc(db, "users", user.uid);
  const snap = await getDoc(userRef);
  if (snap.exists()) {
    const data = snap.data();
    clientFullName = data.fullName || "";
    clientOrg = data.org || "";
  }
});

// Logout
const logoutBtn = document.getElementById("logoutBtn");
if (logoutBtn) {
  logoutBtn.addEventListener("click", () => signOut(auth).then(() => (window.location.href = "index.html")));
}

// Pricing helpers
function rateForWords(words) {
  if (words >= 300000) return 0.05; // enterprise floor in brief
  if (words >= 100000) return 0.06;
  if (words >= 10000) return 0.07;
  if (words >= 1000) return 0.09;
  return 0.10;
}

function formatUSD(n) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

const estWordsEl = document.getElementById("estWords");
const tierEl = document.getElementById("tier");
const totalEl = document.getElementById("total");
const calcBtn = document.getElementById("calcBtn");

function recalc() {
  const w = parseInt(estWordsEl.value || "0", 10);
  if (!w || w <= 0) {
    tierEl.value = "";
    totalEl.value = "";
    return;
  }
  const rate = rateForWords(w);
  const total = w * rate;
  tierEl.value = `$${rate.toFixed(2)}/word`;
  totalEl.value = formatUSD(total);
}

if (calcBtn) calcBtn.addEventListener("click", recalc);
if (estWordsEl) estWordsEl.addEventListener("input", recalc);

// Submit & Pay
const form = document.getElementById("projectRequestForm");
const conf = document.getElementById("confirmationMsg");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const nonReg = document.getElementById("nonRegulated");
  if (!nonReg.checked) {
    alert("Please confirm this is non‑regulated content.");
    return;
  }
  const sourceLang = document.getElementById("sourceLang").value;
  const targetLang = document.getElementById("targetLang").value;
  const notes = document.getElementById("notes").value;
  const file = document.getElementById("file").files[0];
  const estWords = parseInt(estWordsEl.value || "0", 10);

  if (!file) return alert("Please select a file.");

  try {
    // 1) Upload file
    const fileRef = ref(storage, `crowd/uploads/${Date.now()}_${file.name}`);
    await uploadBytes(fileRef, file);

    // 2) Save request
    const reqRef = await addDoc(collection(db, "crowdRequests"), {
      email: clientEmail,
      fullName: clientFullName,
      org: clientOrg,
      sourceLang, targetLang, notes,
      fileName: file.name,
      estWords: isNaN(estWords) ? null : estWords,
      nonRegulated: true,
      createdAt: serverTimestamp(),
      status: "pending_payment"
    });

    // 3) Send to Google Sheet (existing Apps Script)
    document.getElementById("fullnameField").value = clientFullName;
    document.getElementById("emailField").value = clientEmail || "info@rolling-translations.com";
    document.getElementById("phoneField").value = "";
    document.getElementById("sourceLangField").value = sourceLang;
    document.getElementById("targetLangField").value = targetLang;
    document.getElementById("notesField").value = notes;
    document.getElementById("fileNameField").value = file.name;
    document.getElementById("spreadsheetForm").submit();

    conf.style.display = "block";

    // 4) Redirect to payment (placeholder)
    // TODO: Replace with your backend endpoint that creates a Stripe Checkout Session.
    // Example:
    // const r = await fetch('/api/checkout', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ requestId: reqRef.id, estWords }) });
    // const { url } = await r.json();
    // window.location.href = url;

    alert("Payment step placeholder: connect Stripe Checkout and redirect here.");
  } catch (err) {
    alert("⚠️ " + err.message);
    console.error(err);
  }
});
