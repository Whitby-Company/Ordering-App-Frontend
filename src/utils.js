// Pure, dependency-free helpers shared across the app.
// Extracted from App.jsx (no logic changes) to keep the main file smaller.

// ---- Dates ----
export function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
// Today's date as ISO yyyy-mm-dd (local).
export function todayISODate() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}
// ISO yyyy-mm-dd -> mm/dd/yy (2-digit year) for the compact date field.
export function formatDateMMDDYY(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y.slice(2)}`;
}
// Parse a typed date like "9/18", "9/18/26", "09/18/2026" -> ISO (assumes
// current year if year omitted). Returns '' if unparseable.
export function parseTypedDate(text) {
  const t = (text || '').trim();
  const m = t.match(/^(\d{1,2})\D+(\d{1,2})(?:\D+(\d{2,4}))?$/);
  if (!m) return '';
  let [, mm, dd, yy] = m;
  let year = yy ? Number(yy) : new Date().getFullYear();
  if (yy && yy.length === 2) year = 2000 + Number(yy);
  const mo = Number(mm), day = Number(dd);
  if (mo < 1 || mo > 12 || day < 1 || day > 31) return '';
  return `${year}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function formatDateTime(iso) {
  const date = new Date(iso);
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function toISO(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ---- Money / line math ----
export function formatMoney(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}
export function lineTotal(item, qty) {
  return (Number(item.price) || 0) * (Number(item.pack) || 1) * (Number(qty) || 0);
}
export function casePrice(item) {
  return (Number(item.price) || 0) * (Number(item.pack) || 1);
}

// ---- Item id display ----
// Item numbers are stored brand-prefixed (e.g. "Ritter Sport:2146") because
// that's the real DB key. For DISPLAY ONLY, strip the brand prefix so users
// see the bare code ("2146"). Never use this where the value is used as a key.
export function displayCode(id) {
  const s = String(id ?? '');
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}

// ---- CSV ----
export function csvEscape(val) {
  const s = String(val ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ---- Fuzzy matching (customer/item search) ----
export function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
// Tolerant match score of query vs text: higher = better.
export function fuzzyScore(q, text) {
  q = q.trim(); if (!q) return 0;
  if (text === q) return 1000;
  if (text.startsWith(q)) return 800 - text.length;
  if (text.includes(q)) return 600 - text.indexOf(q);
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every(w => text.includes(w))) return 500 - text.length;
  let ti = 0, hits = 0;
  for (let i = 0; i < q.length; i++) {
    const idx = text.indexOf(q[i], ti);
    if (idx >= 0) { hits++; ti = idx + 1; }
  }
  if (hits === q.length) return 300 - (ti - q.length);
  let best = 0;
  for (const w of text.split(/\s+/)) {
    const d = editDistance(q, w.slice(0, q.length + 2));
    const sim = 1 - d / Math.max(q.length, 1);
    if (sim > best) best = sim;
  }
  const textWords = text.split(/\s+/);
  const lead = textWords.slice(0, Math.max(1, words.length)).join(' ');
  const dw = editDistance(q, lead);
  const simw = 1 - dw / Math.max(q.length, 1);
  if (simw > best) best = simw;
  return best >= 0.55 ? Math.round(100 * best) : 0;
}
