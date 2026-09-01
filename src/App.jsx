import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import JsBarcode from 'jsbarcode';
import {
  Search, Plus, Minus, X, Check, ChevronDown, ChevronLeft, Package, User,
  ClipboardList, LayoutGrid, Calendar, ClipboardCheck, Boxes, PlusCircle,
  AlertTriangle, ChevronRight, Loader2, WifiOff, RefreshCw, Monitor,
  Grid2x2, Rows, Image as ImageIcon,
} from 'lucide-react';

const GRID_SIZES = [
  { id: 'small', minWidth: 110 },
  { id: 'medium', minWidth: 150 },
  { id: 'large', minWidth: 220 },
];
function nextGridSize(current) {
  const idx = GRID_SIZES.findIndex(s => s.id === current);
  return GRID_SIZES[(idx + 1) % GRID_SIZES.length].id;
}
function gridSizeMinWidth(id) {
  return (GRID_SIZES.find(s => s.id === id) || GRID_SIZES[1]).minWidth;
}
function GridSizeIcon({ variant, ...props }) {
  if (variant === 'small') return <Grid2x2 {...props} />;
  if (variant === 'large') return <Rows {...props} />;
  return <LayoutGrid {...props} />; // medium
}
function computePopularity(orders) {
  const map = {};
  for (const o of orders || []) {
    for (const l of o.lines || []) {
      map[l.id] = (map[l.id] || 0) + (Number(l.qty) || 0);
    }
  }
  return map;
}
// Parse the per-unit oz size out of a packLabel like "12/5.5oz" -> 5.5.
// Returns null when there's no parseable oz value.
function parseOzSize(packLabel) {
  if (!packLabel) return null;
  // take the number immediately before "oz" (handles "12/5.5oz", "4/27oz")
  const m = String(packLabel).match(/([\d.]+)\s*oz/i);
  return m ? parseFloat(m[1]) : null;
}
function sortItemsBy(items, sortBy, popularity, printSequence) {
  const arr = [...items];
  if (sortBy === 'popularity') {
    arr.sort((a, b) => (popularity[b.id] || 0) - (popularity[a.id] || 0) || a.name.localeCompare(b.name));
  } else if (sortBy === 'pack') {
    arr.sort((a, b) => (Number(b.pack) || 1) - (Number(a.pack) || 1) || a.name.localeCompare(b.name));
  } else if (sortBy === 'size') {
    arr.sort((a, b) => {
      const sa = parseOzSize(a.packLabel);
      const sb = parseOzSize(b.packLabel);
      // items without a parseable size sort to the end
      if (sa == null && sb == null) return a.name.localeCompare(b.name);
      if (sa == null) return 1;
      if (sb == null) return -1;
      return sa - sb || a.name.localeCompare(b.name);
    });
  } else if (sortBy === 'printOrder') {
    const pos = new Map();
    (printSequence || []).forEach((sku, i) => pos.set(sku, i));
    const BIG = Number.MAX_SAFE_INTEGER;
    arr.sort((a, b) => {
      const pa = pos.has(a.id) ? pos.get(a.id) : BIG;
      const pb = pos.has(b.id) ? pos.get(b.id) : BIG;
      // items not in the sequence fall to the end, alphabetically
      if (pa === BIG && pb === BIG) return a.name.localeCompare(b.name);
      return pa - pb;
    });
  } else {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }
  return arr;
}
const SORT_OPTIONS = [
  { id: 'name', label: 'Name (A–Z)' },
  { id: 'popularity', label: 'Most ordered' },
  { id: 'pack', label: 'Case pack' },
  { id: 'size', label: 'Size (oz)' },
  { id: 'printOrder', label: 'Inventory order' },
];


// Column-based sort for the Inventory views (mobile + desktop) — any
// column, either direction, with a stable name-based tiebreaker.
const INVENTORY_SORT_COLUMNS = [
  { id: 'id', label: 'SKU' },
  { id: 'name', label: 'Item name' },
  { id: 'brand', label: 'Brand' },
  { id: 'pack', label: 'Pack' },
  { id: 'price', label: 'Price/ea' },
  { id: 'casePrice', label: 'Case price' },
  { id: 'stock', label: 'Stock' },
  { id: 'active', label: 'Active' },
  { id: 'popularity', label: 'Most ordered' },
];
function inventorySortValue(item, field, popularity) {
  switch (field) {
    case 'id': return item.id.toLowerCase();
    case 'brand': return (item.brand || '').toLowerCase();
    case 'upc': return (item.upc || '').toLowerCase();
    case 'pack': return Number(item.pack) || 1;
    case 'price': return Number(item.price) || 0;
    case 'casePrice': return casePrice(item);
    case 'stock': return Number(item.stock) || 0;
    case 'active': return item.active ? 1 : 0;
    case 'popularity': return popularity[item.id] || 0;
    case 'name':
    default: return (item.name || '').toLowerCase();
  }
}
function sortInventoryItems(items, field, dir, popularity) {
  const mult = dir === 'desc' ? -1 : 1;
  const arr = [...items];
  arr.sort((a, b) => {
    const va = inventorySortValue(a, field, popularity);
    const vb = inventorySortValue(b, field, popularity);
    let cmp;
    if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
    else cmp = String(va).localeCompare(String(vb));
    if (cmp !== 0) return cmp * mult;
    return a.name.localeCompare(b.name); // stable tiebreaker
  });
  return arr;
}
// Your live backend, deployed on Render.
const API_BASE = 'https://ordering-app-ycc9.onrender.com/api';

// Device-level submitter name: whoever is placing orders on this device.
// Stored in localStorage so it's remembered across sessions on that device.
const SUBMITTER_KEY = 'submitterName';
function getSubmitterName() {
  try { return localStorage.getItem(SUBMITTER_KEY) || ''; } catch { return ''; }
}
function storeSubmitterName(name) {
  try {
    const trimmed = (name || '').trim();
    if (trimmed) localStorage.setItem(SUBMITTER_KEY, trimmed);
    else localStorage.removeItem(SUBMITTER_KEY);
  } catch { /* ignore storage errors */ }
}
// Hook that exposes the current device submitter name and a setter that
// persists it. Multiple components stay in sync via a window event.
function useSubmitterName() {
  const [name, setName] = useState(getSubmitterName);
  useEffect(() => {
    const handler = () => setName(getSubmitterName());
    window.addEventListener('submitter-name-changed', handler);
    return () => window.removeEventListener('submitter-name-changed', handler);
  }, []);
  const update = useCallback((next) => {
    storeSubmitterName(next);
    setName(getSubmitterName());
    window.dispatchEvent(new Event('submitter-name-changed'));
  }, []);
  return [name, update];
}

const BRAND_COLORS = { Nike: '#2B5D50', Adidas: '#3E5C76', Puma: '#8A4A3D' };
const BRAND_FALLBACK_COLORS = ['#2B5D50', '#3E5C76', '#8A4A3D', '#6B5B95', '#457B7A', '#9C6644'];
function brandColor(brand, index, customColors) {
  if (customColors && customColors[brand]) return customColors[brand];
  return BRAND_COLORS[brand] || BRAND_FALLBACK_COLORS[index % BRAND_FALLBACK_COLORS.length];
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function formatDateTime(iso) {
  const date = new Date(iso);
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function toISO(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
// Day-of-week labels; index 0 = Sunday, matching JS getDay() and the backend.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Next calendar date (today or later) that falls on the given weekday (0-6),
// returned as an ISO yyyy-mm-dd string. E.g. today Wed, weekday=Fri -> this Fri.
function nextDateForWeekday(weekday) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const delta = (weekday - today.getDay() + 7) % 7; // 0..6 days ahead
  const target = new Date(today);
  target.setDate(today.getDate() + delta);
  return toISO(target.getFullYear(), target.getMonth(), target.getDate());
}
function buildCalendarGrid(year, month) {
  const startWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  return cells;
}

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}
async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
async function apiPatch(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
async function apiDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
async function apiPut(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---- Print-order upload helpers ----------------------------------------
// The item code column is found by a labeled header cell. Accept a few
// common spellings so the sheet layout can vary between uploads.
const ITEM_CODE_HEADERS = ['item #', 'item#', 'item number', 'item no', 'item no.', 'sku', 'code', 'item code'];

// Return the code-part of a SKU (everything after the first colon), lowercased.
function skuCodePart(sku) {
  const i = sku.indexOf(':');
  return (i >= 0 ? sku.slice(i + 1) : sku).toLowerCase();
}

// Build a lookup from code-part -> [SKUs]. One code can map to several SKUs
// (e.g. an "each" and its "c" case variant), and we keep them all so both
// sort together.
function buildCodeIndex(items) {
  const idx = {};
  for (const it of items) {
    const code = skuCodePart(it.id);
    (idx[code] = idx[code] || []).push(it.id);
  }
  return idx;
}

// Given a raw item code from the sheet, find matching SKUs. Tries the code
// as-is, then with a 'c' case suffix, then with a trailing 'c' stripped.
function matchCodeToSkus(rawCode, codeIndex) {
  const n = String(rawCode).trim().toLowerCase();
  if (!n) return null;
  if (codeIndex[n]) return codeIndex[n];
  if (codeIndex[n + 'c']) return codeIndex[n + 'c'];
  if (n.endsWith('c') && codeIndex[n.slice(0, -1)]) return codeIndex[n.slice(0, -1)];
  return null;
}

// Parse an uploaded .xlsx into an ordered SKU list plus a match report.
// Reads the first sheet, finds the header row containing an item-code column,
// then reads codes top-to-bottom. Skips blank rows and repeated header rows.
async function parsePrintOrderFile(file, items) {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });

  // Find the header row + which column holds the item code.
  let codeCol = -1;
  let headerRowIdx = -1;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] || '').trim().toLowerCase();
      if (ITEM_CODE_HEADERS.includes(cell)) { codeCol = c; headerRowIdx = r; break; }
    }
    if (codeCol >= 0) break;
  }
  if (codeCol < 0) {
    throw new Error('Could not find an item-code column. Add a header cell labeled "Item #" (or "SKU"/"Code") above your item codes.');
  }

  const headerLabels = new Set(ITEM_CODE_HEADERS);
  const codeIndex = buildCodeIndex(items);
  const orderedSkus = [];
  const seen = new Set();
  const unmatched = [];

  // Read the identified code column from the TOP of the file. The header row
  // can appear partway down (and repeat), with real items above it, so we
  // scan every row and just skip header/blank cells rather than starting
  // below the first header.
  for (let r = 0; r < rows.length; r++) {
    const raw = String((rows[r] || [])[codeCol] || '').trim();
    if (!raw) continue;
    if (headerLabels.has(raw.toLowerCase())) continue; // header row (possibly repeated)
    const cleaned = raw.replace(/\*+$/, '').trim(); // strip trailing * markers
    if (!cleaned) continue;
    const skus = matchCodeToSkus(cleaned, codeIndex);
    if (skus) {
      for (const s of skus) if (!seen.has(s)) { seen.add(s); orderedSkus.push(s); }
    } else {
      unmatched.push(cleaned);
    }
  }

  return { orderedSkus, unmatched, matchedCodes: seen.size };
}

// Parse a UPC spreadsheet: needs a column of item codes (Item #/SKU/Code) and
// a column of UPCs (UPC/Barcode/GTIN). Returns { updates:[{id,upc}], unmatched,
// matched } with item codes resolved to real SKUs.
async function parseUpcFile(file, items) {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });

  const UPC_HEADERS = ['upc', 'upc code', 'barcode', 'bar code', 'gtin', 'upc/ean'];
  let codeCol = -1, upcCol = -1, headerRowIdx = -1;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    let foundCode = -1, foundUpc = -1;
    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] || '').trim().toLowerCase();
      if (foundCode < 0 && ITEM_CODE_HEADERS.includes(cell)) foundCode = c;
      if (foundUpc < 0 && UPC_HEADERS.includes(cell)) foundUpc = c;
    }
    if (foundCode >= 0 && foundUpc >= 0) { codeCol = foundCode; upcCol = foundUpc; headerRowIdx = r; break; }
  }
  if (codeCol < 0 || upcCol < 0) {
    throw new Error('Need two labeled columns: an item-code column ("Item #"/"SKU"/"Code") and a "UPC" column.');
  }

  const headerLabels = new Set([...ITEM_CODE_HEADERS, ...UPC_HEADERS]);
  const codeIndex = buildCodeIndex(items);
  const updates = [];
  const unmatched = [];
  const seen = new Set();

  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const rawCode = String(row[codeCol] || '').trim();
    const rawUpc = String(row[upcCol] || '').trim();
    if (!rawCode) continue;
    if (headerLabels.has(rawCode.toLowerCase())) continue;
    const cleaned = rawCode.replace(/\*+$/, '').trim();
    if (!cleaned) continue;
    const skus = matchCodeToSkus(cleaned, codeIndex);
    if (skus) {
      for (const s of skus) if (!seen.has(s)) { seen.add(s); updates.push({ id: s, upc: rawUpc }); }
    } else {
      unmatched.push(cleaned);
    }
  }

  return { updates, unmatched, matched: seen.size };
}

// Sort an order's lines to follow the saved print sequence. Items in the
// sequence come first (in that order); anything not in it keeps its original
// relative order and goes at the end. Never drops a line.
function sortLinesForPrint(lines, printOrder) {
  if (!printOrder || printOrder.length === 0) return lines;
  const pos = new Map();
  printOrder.forEach((sku, i) => pos.set(sku, i));
  const BIG = Number.MAX_SAFE_INTEGER;
  return lines
    .map((l, i) => ({ l, i }))
    .sort((a, b) => {
      const pa = pos.has(a.l.id) ? pos.get(a.l.id) : BIG;
      const pb = pos.has(b.l.id) ? pos.get(b.l.id) : BIG;
      if (pa !== pb) return pa - pb;
      return a.i - b.i; // stable for unmatched items
    })
    .map(x => x.l);
}

// Build a scannable barcode as an inline SVG string from a UPC value.
// Renders UPC-A / EAN-13 / EAN-8 when the digits fit a standard retail
// symbology, otherwise falls back to Code 128 (which encodes any digits).
// Returns '' if there's no usable value, so the caller can show text instead.
function barcodeSVG(rawUpc) {
  const digits = String(rawUpc == null ? '' : rawUpc).replace(/\D/g, '');
  if (!digits) return '';
  const attempts = [];
  if (digits.length === 12) attempts.push('UPC');
  else if (digits.length === 13) attempts.push('EAN13');
  else if (digits.length === 8) attempts.push('EAN8');
  attempts.push('CODE128'); // universal fallback
  for (const format of attempts) {
    try {
      const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      JsBarcode(node, digits, {
        format,
        width: 1.3,
        height: 22,
        displayValue: true,
        fontSize: 10,
        textMargin: 0,
        margin: 2,
        background: '#ffffff',
        lineColor: '#000000',
      });
      if (node.childNodes.length > 0) {
        return new XMLSerializer().serializeToString(node);
      }
    } catch (e) {
      // try the next format
    }
  }
  return '';
}

// An item's UPC field may hold several UPCs (e.g. a shipper containing
// multiple units), separated by comma / semicolon / newline. Split into a
// clean list. A UPC's own digits use only numbers, dashes and spaces, so
// those separators are safe.
function parseUpcList(rawUpc) {
  return String(rawUpc == null ? '' : rawUpc)
    .split(/[,;\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

// Render one barcode per UPC in the cell, stacked. Falls back to the raw
// text for any value that can't be encoded.
function barcodesForCell(rawUpc) {
  const upcs = parseUpcList(rawUpc);
  if (upcs.length === 0) return '';
  return upcs.map(u => {
    const bc = barcodeSVG(u);
    return bc ? `<div class="barcode">${bc}</div>` : `<div>${u}</div>`;
  }).join('');
}

function printOrder(order, printSequence, options = {}) {
  const withUpc = options.withUpc !== false; // default: include the barcode column
  const total = order.lines.reduce((s, l) => s + lineTotal(l, l.qty), 0);
  const totalCases = order.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const totalUnits = order.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.pack) || 1), 0);
  const orderedLines = sortLinesForPrint(order.lines, printSequence);
  const rows = orderedLines.map(l => {
    const cases = Number(l.qty) || 0;
    const pack = Number(l.pack) || 1;
    let upcTd = '';
    if (withUpc) {
      const cell = barcodesForCell(l.upc);
      upcTd = `<td class="upcCell">${cell || (l.upc ? String(l.upc) : '')}</td>`;
    }
    return `
    <tr>
      <td class="codeCell">${displayCode(l.id)}</td>
      <td class="casesCol">${cases}</td>
      <td class="casesCol">${cases * pack}</td>
      <td class="itemCell">${l.name}</td>
      ${upcTd}
      <td style="text-align:right">${l.pack || 1}</td>
      <td style="text-align:right">${cases > 0 ? formatMoney(l.price) : ''}</td>
      <td style="text-align:right">${cases > 0 ? formatMoney(lineTotal(l, l.qty)) : ''}</td>
    </tr>`;
  }).join('');
  const upcTh = withUpc ? '<th>UPC</th>' : '';
  const footColspan = withUpc ? 5 : 4;      // columns spanned after the Eaches total cell
  const totalColspan = withUpc ? 7 : 6;     // columns before the final Order total value
  const win = window.open('', '_blank', 'width=800,height=900');
  if (!win) return;
  win.document.write(`<!doctype html><html><head><title>Order ${order.id}${withUpc ? ' (UPC)' : ''}</title>
    <meta charset="utf-8" />
    <style>
      body { font-family: Arial, Helvetica, sans-serif; padding: 28px; color: #14181F; }
      h1 { font-size: 18px; margin: 0 0 3px; }
      .meta { color: #5B6058; margin-bottom: 14px; font-size: 12px; }
      .notes { background: #FBFAF6; border: 1px solid #E3E1D6; border-radius: 8px; padding: 8px 10px; margin: 2px 0 12px; color: #14181F; line-height: 1.35; }
      .notes .notesBody { display: block; font-size: 12px; font-weight: 600; white-space: pre-wrap; min-height: calc(1.35em * 3); }
      table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
      th { padding: ${withUpc ? '2px 4px' : '2px 4px'}; border-bottom: 1px solid #ECEAE1; text-align: left; background: #FBFAF6; font-size: 9.5px; text-transform: uppercase; color: #8A8F87; letter-spacing: 0.02em; }
      td { padding: ${withUpc ? '2px 4px' : '7px 4px'}; text-align: left; line-height: 1.15; ${withUpc ? 'border-bottom: 1px solid #ECEAE1;' : 'border-bottom: none;'} }
      tfoot td { font-weight: 700; border-top: 2px solid #14181F; border-bottom: none; padding-top: ${withUpc ? '3px' : '8px'}; }
      tfoot tr.subtotal td { border-top: 1px solid #E3E1D6; }
      .printBtn { display: inline-block; margin-bottom: 16px; background: #2B5D50; color: #fff; border: none; border-radius: 8px; padding: 9px 16px; font-size: 13px; font-weight: 700; cursor: pointer; font-family: inherit; }
      .itemCell, .codeCell { white-space: nowrap; }
      /* Keep Item # and Cases narrow so they sit right next to each other,
         letting the Item (name) column absorb the leftover width. */
      .codeCell, th.codeCol { width: 1px; white-space: nowrap; padding-right: 14px; }
      .casesCol { width: 1px; white-space: nowrap; text-align: left; padding-right: 18px; }
      .upcCell { white-space: nowrap; width: 1px; }
      .barcode svg { display: block; }
      .barcode + .barcode { margin-top: 3px; }
      @media print {
        body { padding: 0; }
        .no-print { display: none; }
        /* keep barcodes sharp and full-contrast when printed */
        .barcode svg { image-rendering: pixelated; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      }
    </style></head><body>
    <button class="printBtn no-print" onclick="window.print()">Print / Save as PDF</button>
    <h1>Order #${order.id} — ${order.customer}</h1>
    <div class="meta">Delivery ${formatDate(order.deliveryDate)} &nbsp;·&nbsp; Submitted ${formatDateTime(order.submittedAt)}${order.submittedBy ? ` &nbsp;·&nbsp; by ${String(order.submittedBy).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}` : ''}</div>
    ${order.notes ? `<div class="notes"><span class="notesBody">${String(order.notes).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span></div>` : ''}
    <table>
      <thead><tr><th class="codeCol">Item #</th><th class="casesCol">Cs</th><th class="casesCol">Ea</th><th>Item</th>${upcTh}<th style="text-align:right">Pack</th><th style="text-align:right">Price/ea</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="subtotal"><td style="text-align:right">Totals</td><td class="casesCol">${totalCases}</td><td class="casesCol">${totalUnits}</td><td colspan="${footColspan}"></td></tr>
        <tr><td colspan="${totalColspan}" style="text-align:right">Order total</td><td style="text-align:right">${formatMoney(total)}</td></tr>
      </tfoot>
    </table>
    </body></html>`);
  win.document.close();
  win.focus();
}

// Printed-invoice number: the order number offset so numbering starts at 30000.
const INVOICE_BASE = 30000;
function invoiceNumberFor(order) { return INVOICE_BASE + Number(order.id || 0); }

// Build a printable invoice that matches the Hawken Group template, using the
// same data as the TP export (customer bill-to/ship-to, PO, line items with
// cases/eaches/price, UPCs, totals, 0.5% sales tax).
function printInvoice(order, customer, printSequence) {
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const c = customer || {};
  const SALES_TAX_RATE = 0.005; // 0.5%
  const money = n => (Number(n) || 0).toFixed(2); // no leading "$" — matches template

  const ordered = sortLinesForPrint(order.lines, printSequence);
  const positive = ordered.filter(l => (Number(l.qty) || 0) > 0);
  const zeros = ordered.filter(l => (Number(l.qty) || 0) === 0);
  const lines = [...positive, ...zeros];

  const totalCases = positive.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const totalEach = positive.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.pack) || 1), 0);
  const subtotal = positive.reduce((s, l) => s + lineTotal(l, l.qty), 0);
  const tax = Math.round(subtotal * SALES_TAX_RATE * 100) / 100;
  const grand = Math.round((subtotal + tax) * 100) / 100;

  const now = new Date();
  const poDate = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getFullYear()).slice(2)}`;
  const abbr = (c.abbreviation || '').trim();
  const poNumber = abbr ? `${poDate}-${abbr}` : '';
  // Invoice DATE = the order's delivery date (fall back to today if missing).
  let dateStr;
  if (order.deliveryDate) {
    const [dy, dm, dd] = String(order.deliveryDate).split('-').map(Number);
    dateStr = `${dm}/${dd}/${dy}`;
  } else {
    dateStr = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
  }

  const cityLine = (l1, st, z) => [[l1, st].filter(Boolean).join(', '), z].filter(Boolean).join(' ').trim();
  const billBlock = [c.billToLine1, c.billToLine2, cityLine(c.billToCity, c.billToState, c.billToZip)].filter(Boolean).map(esc).join('<br>');
  const shipBlock = [c.shipToLine1, c.shipToLine2, cityLine(c.shipToCity, c.shipToState, c.shipToZip)].filter(Boolean).map(esc).join('<br>');

  const rows = lines.map(l => {
    const cases = Number(l.qty) || 0;
    const pack = Number(l.pack) || 1;
    const each = cases * pack;
    const desc = esc(l.name) + (l.packLabel ? ' ' + esc(l.packLabel) : '');
    // UPC as scannable barcode(s); falls back to the raw text if unencodable.
    const upcCell = barcodesForCell(l.upc) || parseUpcList(l.upc).map(esc).join('<br>');
    return `<tr>
      <td class="c-item">${esc(displayCode(l.id))}</td>
      <td class="c-cs">${cases}</td>
      <td class="c-each">${each}</td>
      <td class="c-desc">${desc}</td>
      <td class="c-upc">${upcCell}</td>
      <td class="c-price">${money(l.price)}</td>
      <td class="c-total">${money(lineTotal(l, l.qty))}</td>
    </tr>`;
  }).join('');

  const win = window.open('', '_blank', 'width=850,height=1000');
  if (!win) return;
  win.document.write(`<!doctype html><html><head><meta charset="utf-8" />
    <title>Invoice ${invoiceNumberFor(order)}</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: 'Times New Roman', Times, serif; color: #000; margin: 0; padding: 26px 30px; font-size: 12px; }
      .printBtn { display: inline-block; margin-bottom: 14px; background: #2B5D50; color: #fff; border: none; border-radius: 8px; padding: 9px 16px; font-size: 13px; font-weight: 700; cursor: pointer; font-family: Arial, sans-serif; }
      table.sheet { width: 100%; border-collapse: collapse; table-layout: fixed; }
      .hdr-top { width: 100%; border-collapse: collapse; }
      .hdr-top > tbody > tr > td { vertical-align: top; padding: 0; }
      .company { font-size: 27px; font-weight: bold; line-height: 1.08; white-space: nowrap; }
      .company small { display: block; font-size: 12px; font-weight: normal; white-space: nowrap; }
      .invoice-word { font-size: 30px; font-weight: bold; text-align: center; padding-top: 20px; }
      /* Date / Invoice # each in their own box; terms below, unboxed. */
      .metabox { border-collapse: collapse; margin-left: auto; }
      .metabox td { padding: 3px 6px; font-size: 14px; }
      .metabox td.lbl { text-align: right; font-weight: bold; padding-right: 10px; white-space: nowrap; }
      .metabox td.boxed { border: 1px solid #000; text-align: center; min-width: 92px; }
      .addrs { width: 100%; margin: 20px 0 0; }
      .addrs td { vertical-align: top; width: 50%; padding: 0; }
      .addr-lbl { font-weight: bold; font-size: 12px; font-family: Arial, sans-serif; margin-bottom: 4px; }
      .addr-body { font-size: 13px; line-height: 1.4; }
      .pobox { margin: 24px 0 6px; }
      .pobox table { border-collapse: collapse; }
      .pobox td.lbl { font-weight: bold; padding-right: 12px; font-size: 15px; }
      .pobox td.val { border: 1px solid #000; padding: 6px 60px; font-size: 17px; font-weight: bold; text-align: center; }
      thead .colhdr th { border-bottom: 1px solid #000; text-align: left; font-size: 13px; padding: 4px 4px 3px; font-weight: normal; }
      thead .colhdr th.r { text-align: right; }
      thead .colhdr th.ctr { text-align: center; }
      tbody td { padding: 2px 4px; font-size: 12.5px; vertical-align: middle; line-height: 1.25; }
      td.c-item { white-space: nowrap; }
      td.c-cs, td.c-each { text-align: center; }
      td.c-upc { text-align: center; font-size: 11px; }
      td.c-upc .barcode svg { display: block; margin: 0 auto; height: 30px; width: auto; max-width: 100%; }
      td.c-upc .barcode + .barcode { margin-top: 2px; }
      td.c-price, td.c-total { text-align: right; white-space: nowrap; }
      .totals { width: 100%; margin-top: 30px; }
      .totals td { vertical-align: bottom; }
      .totals .left { font-size: 14px; line-height: 2.0; }
      .totals .right table { border-collapse: collapse; margin-left: auto; }
      .totals .right td { padding: 6px 12px; font-size: 15px; }
      .totals .right td.lbl { text-align: center; }
      .totals .right td.amt { text-align: right; white-space: nowrap; }
      .totals .right tr.grand td { font-weight: bold; }
      .sigrow { width: 100%; margin-top: 40px; }
      .sigrow td { text-align: center; font-size: 11px; color: #000; border-top: 1px solid #000; padding-top: 3px; }
      @media print { body { padding: 16px 22px; } .no-print { display: none; } thead { display: table-header-group; } .barcode svg { image-rendering: pixelated; -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
    </style></head><body>
    <button class="printBtn no-print" onclick="window.print()">Print / Save as PDF</button>
    <table class="sheet">
      <colgroup>
        <col style="width:9%" /><col style="width:5%" /><col style="width:6%" />
        <col style="width:39%" /><col style="width:20%" />
        <col style="width:8%" /><col style="width:13%" />
      </colgroup>
      <thead>
        <tr><td colspan="7">
          <table class="hdr-top"><tr>
            <td style="width:40%"><div class="company">Hawken Group<small>PO Box 8514</small><small>Honolulu, HI 96830</small></div></td>
            <td style="width:24%"><div class="invoice-word">INVOICE</div></td>
            <td style="width:36%">
              <table class="metabox">
                <tr><td class="lbl">DATE:</td><td class="boxed">${esc(dateStr)}</td></tr>
                <tr><td class="lbl">INVOICE #</td><td class="boxed">${invoiceNumberFor(order)}</td></tr>
                <tr><td class="lbl">TERMS:</td><td>1% 10 Net 11</td></tr>
              </table>
            </td>
          </tr></table>
          <table class="addrs"><tr>
            <td><div class="addr-lbl">BILL TO:</div><div class="addr-body">${billBlock || '&nbsp;'}</div></td>
            <td><div class="addr-lbl">SHIP TO:</div><div class="addr-body">${shipBlock || '&nbsp;'}</div></td>
          </tr></table>
          <div class="pobox"><table><tr><td class="lbl">PO #:</td><td class="val">${esc(poNumber) || '&nbsp;'}</td></tr></table></div>
        </td></tr>
        <tr class="colhdr">
          <th>ITEM #</th><th class="ctr">CS</th><th class="ctr">EACH</th>
          <th>DESCRIPTION</th><th>UPC</th><th class="r">PRICE</th><th class="r">TOTAL($)</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <table class="totals"><tr>
      <td class="left">Total Case: ${totalCases}<br>Total Each: ${totalEach}</td>
      <td class="right">
        <table>
          <tr><td class="lbl">Subtotal</td><td class="amt">${money(subtotal)}</td></tr>
          <tr><td class="lbl">Sales Tax (0.5%)</td><td class="amt">${money(tax)}</td></tr>
          <tr class="grand"><td class="lbl">TOTAL AMOUNT</td><td class="amt">${money(grand)}</td></tr>
        </table>
      </td>
    </tr></table>
    <table class="sigrow"><tr>
      <td style="width:25%">Total Cases</td><td style="width:25%">Print Name</td>
      <td style="width:30%">Signature</td><td style="width:20%">Date</td>
    </tr></table>
    </body></html>`);
  win.document.close();
  win.focus();
}
function formatMoney(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

// Item numbers are stored brand-prefixed (e.g. "Ritter Sport:2146") because
// that's the real DB key used for API calls, matching, and cart ops. For
// DISPLAY ONLY, strip the brand prefix so users just see the bare code
// ("2146"). Never use this where the value is used as a key.
function displayCode(id) {
  const s = String(id ?? '');
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}
// --- CSV helpers for bulk inventory export/import ---
function csvEscape(val) {
  const s = String(val ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function toCSV(rows, headers) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => csvEscape(row[h])).join(','));
  }
  return lines.join('\n');
}
// Minimal RFC4180-ish CSV parser: handles quoted fields, escaped quotes, commas/newlines inside quotes.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (r[idx] ?? '').trim(); });
    return obj;
  });
}
function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
// Download a QuickBooks IIF file for an order. Fetches from the backend
// (which formats the file and sets download headers) and saves it. Pass
// experimental=true to get the trial version with a U/M column + cases.
async function downloadOrderIIF(orderId, experimental = false) {
  const qs = experimental ? '?experimental=1' : '';
  const res = await fetch(`${API_BASE}/orders/${orderId}/iif${qs}`);
  if (!res.ok) {
    let msg = `Could not generate the IIF file (${res.status})`;
    try { const d = await res.json(); if (d.error) msg = d.error; } catch { /* keep default */ }
    throw new Error(msg);
  }
  const text = await res.text();
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `order-${orderId}${experimental ? '-experimental' : ''}.iif`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
// Download a Transaction Pro Importer CSV for an order (for QuickBooks Desktop).
async function downloadOrderTP(orderId) {
  const res = await fetch(`${API_BASE}/orders/${orderId}/tp`);
  if (!res.ok) {
    let msg = `Could not generate the Transaction Pro file (${res.status})`;
    try { const d = await res.json(); if (d.error) msg = d.error; } catch { /* keep default */ }
    throw new Error(msg);
  }
  const text = await res.text();
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `order-${orderId}-TP.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
// Download a single Transaction Pro CSV containing several orders at once.
async function downloadOrdersTP(orderIds) {
  const ids = orderIds.join(',');
  const res = await fetch(`${API_BASE}/orders/tp?ids=${encodeURIComponent(ids)}`);
  if (!res.ok) {
    let msg = `Could not generate the Transaction Pro file (${res.status})`;
    try { const d = await res.json(); if (d.error) msg = d.error; } catch { /* keep default */ }
    throw new Error(msg);
  }
  const text = await res.text();
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `orders-${orderIds.length}-TP.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function lineTotal(item, qty) {
  return (Number(item.price) || 0) * (Number(item.pack) || 1) * (Number(qty) || 0);
}
function casePrice(item) {
  return (Number(item.price) || 0) * (Number(item.pack) || 1);
}

// Switches between the mobile ordering UI and the desktop office view based
// on viewport width — same site, same live data, just adapts to the device.
const DESKTOP_BREAKPOINT = 900;
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= DESKTOP_BREAKPOINT
  );
  useEffect(() => {
    function onResize() { setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT); }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return isDesktop;
}

// ============================================================
// ROOT APP — owns shared data, fetched live from the backend
// ============================================================
export default function App() {
  const [items, setItems] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [itemsAll, setItemsAll] = useState([]);
  const [customersAll, setCustomersAll] = useState([]);
  const [orderHistory, setOrderHistory] = useState([]);
  const [brandColors, setBrandColors] = useState({});
  const [brandSettings, setBrandSettings] = useState({});
  const [printSequence, setPrintSequence] = useState([]);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  // Navigation stack: the last element is the current tab. Navigating pushes,
  // back pops exactly one. Single source of truth so history and current view
  // can never get out of sync.
  const [navStack, setNavStack] = useState(['order']);
  const tab = navStack[navStack.length - 1];
  const setTab = useCallback((next) => {
    setNavStack(stack => (next === stack[stack.length - 1] ? stack : [...stack, next]));
  }, []);
  const goBack = useCallback(() => {
    setNavStack(stack => (stack.length > 1 ? stack.slice(0, -1) : stack));
  }, []);
  const canGoBack = navStack.length > 1;
  const isDesktopWidth = useIsDesktop();
  const [viewOverride, setViewOverride] = useState(() => {
    try { return localStorage.getItem('viewOverride') || null; } catch { return null; }
  });
  function setOverride(next) {
    setViewOverride(next);
    try {
      if (next) localStorage.setItem('viewOverride', next);
      else localStorage.removeItem('viewOverride');
    } catch { /* localStorage unavailable — override just won't persist */ }
  }
  const isDesktop = viewOverride ? viewOverride === 'desktop' : isDesktopWidth;

  const loadAll = useCallback(async () => {
    try {
      const [itemsData, customersData, itemsAllData, customersAllData, ordersData, brandColorsData, printOrderData, brandSettingsData] = await Promise.all([
        apiGet('/items'),
        apiGet('/customers'),
        apiGet('/items?includeInactive=true'),
        apiGet('/customers?includeInactive=true'),
        apiGet('/orders'),
        apiGet('/brand-colors'),
        apiGet('/print-order'),
        apiGet('/brand-settings').catch(() => ({})),
      ]);
      setItems(itemsData);
      setCustomers(customersData);
      setItemsAll(itemsAllData);
      setCustomersAll(customersAllData);
      setOrderHistory(ordersData);
      setBrandColors(brandColorsData || {});
      setPrintSequence(printOrderData || []);
      setBrandSettings(brandSettingsData || {});
      setStatus('ready');
    } catch (err) {
      setStatus('error');
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const containerStyle = isDesktop ? styles.appDesktop : styles.app;

  if (status === 'loading') {
    return (
      <div style={containerStyle}>
        <style>{fontImport}</style>
        <div style={styles.centerState}>
          <Loader2 size={22} color="#2B5D50" style={{ animation: 'spin 0.8s linear infinite' }} />
          <div style={styles.centerStateText}>Loading live inventory…</div>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div style={containerStyle}>
        <style>{fontImport}</style>
        <div style={styles.centerState}>
          <WifiOff size={22} color="#B5493B" />
          <div style={styles.centerStateText}>Couldn't reach the server.</div>
          <button style={styles.retryBtn} onClick={() => { setStatus('loading'); loadAll(); }}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (isDesktop) {
    return (
      <div style={styles.appDesktop}>
        <style>{fontImport}</style>
        <OfficeView
          items={itemsAll}
          customers={customersAll}
          activeItems={items}
          activeCustomers={customers}
          orders={orderHistory}
          brandColors={brandColors}
          brandSettings={brandSettings}
          printSequence={printSequence}
          onRefresh={loadAll}
          onSwitchToMobile={() => setOverride('mobile')}
          isManualOverride={!!viewOverride}
          onResetToAuto={() => setOverride(null)}
        />
      </div>
    );
  }

  return (
    <div style={styles.app}>
      <style>{fontImport}</style>
      {canGoBack && (
        <button style={styles.backArrow} onClick={goBack} aria-label="Back to previous screen" title="Back">
          <ChevronLeft size={18} color="#EDEBE3" />
        </button>
      )}
      <div style={styles.tabContent} className={canGoBack ? 'has-back' : ''}>
        {tab === 'order' && (
          <OrderTab items={items} customers={customers} orders={orderHistory} brandColors={brandColors} printSequence={printSequence} onOrderSubmitted={loadAll} />
        )}
        {tab === 'inventory' && <InventoryTab items={items} orders={orderHistory} brandColors={brandColors} />}
        {tab === 'orders' && (
          <OrdersTab
            orders={orderHistory}
            onSwitchToOffice={() => setOverride('desktop')}
            items={items}
            customers={customers}
            printSequence={printSequence}
            onOrderChanged={loadAll}
          />
        )}
      </div>
      <TabBar active={tab} onChange={setTab} />
    </div>
  );
}

function TabBar({ active, onChange }) {
  const tabs = [
    { id: 'order', label: 'New Order', icon: PlusCircle },
    { id: 'inventory', label: 'Inventory', icon: Boxes },
    { id: 'orders', label: 'Orders', icon: ClipboardCheck },
  ];
  return (
    <div style={styles.tabBar}>
      {tabs.map(t => {
        const Icon = t.icon;
        const isActive = active === t.id;
        return (
          <button key={t.id} style={styles.tabBtn} onClick={() => onChange(t.id)}>
            <Icon size={20} color={isActive ? '#2B5D50' : '#8A8F87'} strokeWidth={isActive ? 2.4 : 2} />
            <span style={{ ...styles.tabBtnLabel, color: isActive ? '#2B5D50' : '#8A8F87' }}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ============================================================
// TAB 1 — NEW ORDER
// ============================================================
function OrderTab({ items, customers, orders, brandColors, printSequence, onOrderSubmitted, desktop = false, editOrder = null, onClose = null }) {
  const isEdit = !!editOrder;
  // Restore an in-progress order draft (customer, delivery date, quantities)
  // so switching tabs or an accidental refresh doesn't lose it. In edit mode
  // we ignore the saved draft and initialize from the order being edited.
  const savedDraft = (() => {
    if (isEdit) return {};
    try { return JSON.parse(localStorage.getItem('orderDraft') || '{}'); } catch { return {}; }
  })();
  const editInitLines = isEdit ? editOrder.lines.map(l => ({ id: l.id, qty: l.qty, checkin: l.qty === 0 })) : [];
  const origQtyById = useMemo(() => {
    const map = {};
    if (isEdit) for (const l of editOrder.lines) map[l.id] = l.qty;
    return map;
  }, [isEdit, editOrder]);
  const [customerId, setCustomerId] = useState(isEdit ? editOrder.customerId : (savedDraft.customerId ?? null));
  const [customerOpen, setCustomerOpen] = useState(false);
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerDayFilter, setCustomerDayFilter] = useState(null); // 0-6, or null for all
  const [deliveryDate, setDeliveryDate] = useState(isEdit ? editOrder.deliveryDate : (savedDraft.deliveryDate || ''));
  const [dateOpen, setDateOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [brand, setBrand] = useState('All');
  const [query, setQuery] = useState('');
  const [screen, setScreen] = useState('brands');
  const [order, setOrder] = useState(isEdit ? editInitLines : (Array.isArray(savedDraft.order) ? savedDraft.order : []));
  const [notes, setNotes] = useState(isEdit ? (editOrder.notes || '') : (savedDraft.notes || ''));
  const [ticketOpen, setTicketOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [submitterName, setSubmitterName] = useSubmitterName();
  const [signInOpen, setSignInOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  // When set, submit the order automatically right after the name is saved.
  const submitAfterSignIn = useRef(false);
  const [gridSize, setGridSize] = useState(() => {
    let v; try { v = localStorage.getItem('orderGridSize'); } catch { v = null; }
    return GRID_SIZES.some(s => s.id === v) ? v : 'medium';
  });
  const [pickersExpanded, setPickersExpanded] = useState(true);
  const touchStartRef = useRef(null);

  function toggleGridSize() {
    setGridSize(prev => {
      const next = nextGridSize(prev);
      try { localStorage.setItem('orderGridSize', next); } catch { /* ignore */ }
      return next;
    });
  }

  const bothPicked = !!customerId && !!deliveryDate;
  useEffect(() => {
    if (bothPicked) setPickersExpanded(false);
  }, [bothPicked]);

  // Persist the in-progress order draft so tab switches / refreshes don't lose it.
  // (Not in edit mode — we don't want to clobber a new-order draft.)
  useEffect(() => {
    if (isEdit) return;
    try {
      if (customerId || deliveryDate || order.length > 0 || notes) {
        localStorage.setItem('orderDraft', JSON.stringify({ customerId, deliveryDate, order, notes }));
      } else {
        localStorage.removeItem('orderDraft');
      }
    } catch { /* localStorage unavailable — draft just won't persist */ }
  }, [customerId, deliveryDate, order, notes, isEdit]);

  function goBackToBrands() {
    setScreen('brands');
    setBrand('All');
  }

  function handleTouchStart(e) {
    if (screen !== 'items' || searching) return;
    const t = e.touches[0];
    if (t.clientX < 24) touchStartRef.current = { x: t.clientX, y: t.clientY };
    else touchStartRef.current = null;
  }
  function handleTouchEnd(e) {
    if (!touchStartRef.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStartRef.current.x;
    const dy = Math.abs(t.clientY - touchStartRef.current.y);
    touchStartRef.current = null;
    if (dx > 60 && dy < 50) goBackToBrands();
  }

  const customerName = customers.find(c => c.id === customerId)?.name
    || (isEdit && editOrder.customerId === customerId ? editOrder.customer : '')
    || '';
  const filteredCustomers = useMemo(() => {
    const q = customerQuery.trim().toLowerCase();
    let active = customers.filter(c => c.active !== 0);
    if (customerDayFilter !== null) active = active.filter(c => c.deliveryDay === customerDayFilter);
    if (q) active = active.filter(c => c.name.toLowerCase().includes(q));
    return active;
  }, [customers, customerQuery, customerDayFilter]);
  // Which weekdays actually have customers assigned (to only show useful chips).
  const daysInUse = useMemo(() => {
    const s = new Set();
    for (const c of customers) if (c.active !== 0 && c.deliveryDay !== null && c.deliveryDay !== undefined) s.add(c.deliveryDay);
    return s;
  }, [customers]);

  // Orders come back newest-first, so the first match for this customer
  // is their most recent previous order.
  const previousOrder = useMemo(() => {
    if (!customerId) return null;
    return (orders || []).find(o => o.customerId === customerId) || null;
  }, [orders, customerId]);

  function addPreviousOrderQuantities() {
    if (!previousOrder) return;
    for (const l of previousOrder.lines) {
      const item = items.find(i => i.id === l.id);
      if (!item) continue; // item no longer available — skip it
      setQty(l.id, qtyFor(l.id) + l.qty);
    }
  }

  const brandList = useMemo(() => Array.from(new Set(items.map(i => i.brand))), [items]);
  const brandCounts = useMemo(() => {
    const counts = {};
    items.forEach(i => { counts[i.brand] = (counts[i.brand] || 0) + 1; });
    return counts;
  }, [items]);
  const popularity = useMemo(() => computePopularity(orders), [orders]);
  const [sortBy, setSortBy] = useState(() => {
    try { return localStorage.getItem('orderSortBy') || 'name'; } catch { return 'name'; }
  });
  function changeSortBy(next) {
    setSortBy(next);
    try { localStorage.setItem('orderSortBy', next); } catch { /* ignore */ }
  }

  const searching = query.trim().length > 0;

  const filteredItems = useMemo(() => {
    const effectiveBrand = screen === 'brands' ? 'All' : brand;
    const filtered = items.filter(i => {
      const brandMatch = effectiveBrand === 'All' || i.brand === effectiveBrand;
      const q = query.trim().toLowerCase();
      const queryMatch = !q || i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q);
      return brandMatch && queryMatch;
    });
    return sortItemsBy(filtered, sortBy, popularity, printSequence);
  }, [items, brand, query, screen, sortBy, popularity, printSequence]);

  const orderLines = useMemo(() => {
    const snap = {};
    if (isEdit) for (const l of editOrder.lines) snap[l.id] = l;
    return order.map(o => {
      const item = items.find(i => i.id === o.id) || (isEdit ? snap[o.id] : null);
      return item ? { ...item, qty: o.qty, checkin: !!o.checkin } : null;
    }).filter(Boolean);
  }, [order, items, isEdit, editOrder]);

  const totalUnits = orderLines.reduce((s, l) => s + l.qty, 0);
  const totalPrice = orderLines.reduce((s, l) => s + lineTotal(l, l.qty), 0);

  function qtyFor(id) { return order.find(o => o.id === id)?.qty || 0; }
  function isOnOrder(id) { return order.some(o => o.id === id); }

  // Item lookup: active items plus a fallback snapshot for any line whose item
  // has since gone inactive/renamed (only relevant in edit mode).
  const itemById = useMemo(() => {
    const map = {};
    for (const i of items) map[i.id] = i;
    if (isEdit) for (const l of editOrder.lines) if (!map[l.id]) map[l.id] = { ...l, stock: 0 };
    return map;
  }, [items, isEdit, editOrder]);

  function setQty(id, qty) {
    const item = itemById[id];
    if (!item) return;
    // In edit mode the item's current qty was already reserved, so it can go up
    // to current stock + whatever this order originally held.
    const maxQty = (item.stock || 0) + (isEdit ? (origQtyById[id] || 0) : 0);
    const clamped = Math.max(0, Math.min(qty, maxQty));
    setOrder(prev => {
      const exists = prev.find(o => o.id === id);
      // Going to 0 removes a normal line, but a "check-in" line (added on
      // purpose to print its UPC) stays on the order at 0.
      if (clamped === 0) {
        if (exists && exists.checkin) return prev.map(o => (o.id === id ? { ...o, qty: 0 } : o));
        return prev.filter(o => o.id !== id);
      }
      if (exists) return prev.map(o => (o.id === id ? { ...o, qty: clamped, checkin: false } : o));
      return [...prev, { id, qty: clamped }];
    });
  }

  // Add an item to the order at qty 0 so its UPC/barcode prints for check-in.
  function addCheckin(id) {
    const item = items.find(i => i.id === id);
    if (!item) return;
    setOrder(prev => {
      if (prev.find(o => o.id === id)) return prev; // already on the order
      return [...prev, { id, qty: 0, checkin: true }];
    });
  }

  function removeLine(id) {
    setOrder(prev => prev.filter(o => o.id !== id));
  }

  function resetForm() {
    setOrder([]);
    setNotes('');
    setTicketOpen(false);
    setCustomerId(null);
    setDeliveryDate('');
    setQuery('');
    setScreen('brands');
    setBrand('All');
    setPickersExpanded(true);
    try { localStorage.removeItem('orderDraft'); } catch { /* ignore */ }
  }

  // Discard the in-progress order (clear the whole draft).
  function discardOrder() {
    resetForm();
  }

  // Edit mode: save changes to the existing order via PATCH.
  async function saveEdit() {
    if (!customerId || !deliveryDate || orderLines.length === 0) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      await apiPatch(`/orders/${editOrder.id}`, {
        customerId,
        deliveryDate,
        notes: notes.trim() || undefined,
        lines: orderLines.map(l => ({ itemId: l.id, qty: l.qty })),
      });
      await onOrderSubmitted();
      if (onClose) onClose();
    } catch (err) {
      setSubmitError(err.message || 'Could not save changes.');
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteEditOrder() {
    setDeleting(true);
    setSubmitError('');
    try {
      await apiDelete(`/orders/${editOrder.id}`);
      await onOrderSubmitted();
      if (onClose) onClose();
    } catch (err) {
      setSubmitError(err.message || 'Could not delete this order.');
      setDeleting(false);
    }
  }

  async function submitOrder(pending = false) {
    if (!customerId || !deliveryDate || orderLines.length === 0) return;
    // First submit on this device asks who's submitting (a pending draft can
    // be saved without a name).
    if (!pending && !submitterName) {
      submitAfterSignIn.current = true;
      setNameDraft('');
      setSignInOpen(true);
      return;
    }
    setSubmitting(true);
    setSubmitError('');
    try {
      const result = await apiPost('/orders', {
        customerId,
        deliveryDate,
        notes: notes.trim() || undefined,
        submittedBy: submitterName || undefined,
        status: pending ? 'pending' : 'submitted',
        lines: orderLines.map(l => ({ itemId: l.id, qty: l.qty })),
      });
      if (pending) {
        // Pending drafts just go to the Orders list; no confirmation screen.
        resetForm();
        await onOrderSubmitted();
        return;
      }
      setConfirmed({
        customer: customerName,
        deliveryDate,
        submittedAt: 'Just now',
        submittedBy: result.submittedBy || submitterName || null,
        notes: result.notes || null,
        lines: result.lines,
        totalUnits,
      });
      resetForm();
      await onOrderSubmitted(); // refresh items + order history from server
    } catch (err) {
      setSubmitError(err.message || `Something went wrong ${pending ? 'saving' : 'submitting'} this order.`);
    } finally {
      setSubmitting(false);
    }
  }

  // Save the entered name to this device. If the sign-in was triggered by
  // trying to submit, continue the submission once the name is stored.
  function saveSignIn() {
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    setSubmitterName(trimmed);
    setSignInOpen(false);
  }
  // Once the device name is set (and a submit was pending), run the submit.
  useEffect(() => {
    if (submitterName && submitAfterSignIn.current) {
      submitAfterSignIn.current = false;
      submitOrder();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitterName]);

  function openSignIn() {
    submitAfterSignIn.current = false;
    setNameDraft(submitterName || '');
    setSignInOpen(true);
  }

  if (confirmed) {
    return <Confirmation data={confirmed} onNewOrder={() => setConfirmed(null)} />;
  }

  // On desktop the mobile bottom-sheets are cramped, so present the
  // customer/date/ticket sheets as centered modals with room to breathe.
  const overlayStyle = desktop
    ? { ...styles.sheetOverlay, alignItems: 'center', justifyContent: 'center', position: 'fixed' }
    : styles.sheetOverlay;
  const sheetStyle = desktop
    ? { ...styles.sheet, width: 460, maxWidth: '92vw', maxHeight: '88vh', borderRadius: 16, padding: '18px 22px 22px' }
    : styles.sheet;
  // On desktop, lay item rows out in multiple columns so far more fit on
  // screen at once. The card width follows the grid-size toggle (same control
  // used for the brand tiles): smaller size -> narrower cards -> more columns.
  const itemCardMinWidth = { small: 260, medium: 320, large: 420 }[gridSize] || 320;
  const listStyle = desktop
    ? { ...styles.list, display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${itemCardMinWidth}px, 1fr))`, gap: 6, alignContent: 'start' }
    : styles.list;
  const itemRowStyle = desktop
    ? { ...styles.itemRow, alignItems: 'flex-start', gap: 10, borderBottom: 'none', border: '1px solid #EAE8DD', borderRadius: 10, padding: '8px 10px', background: '#FFFFFF' }
    : styles.itemRow;

  return (
    <div style={styles.screenWrap} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      <div style={desktop ? styles.headerDesktop : styles.header}>
        {isEdit && (
          <div style={styles.headerTop}>
            <ClipboardCheck size={18} color="#EDEBE3" strokeWidth={2} />
            <span style={styles.headerTitle}>Edit order #{editOrder.id}</span>
            {onClose && (
              <button style={{ ...styles.iconBtn, marginLeft: 'auto' }} onClick={onClose} disabled={submitting || deleting} title="Close">
                <X size={18} color="#B7BCB2" />
              </button>
            )}
          </div>
        )}
        {!desktop && !isEdit && (
          <div style={styles.headerTop}>
            <Package size={18} color="#EDEBE3" strokeWidth={2} />
            <span style={styles.headerTitle}>New Order</span>
          </div>
        )}
        {pickersExpanded ? (
          <>
            <button style={desktop ? { ...styles.customerBtn, flex: 1, marginTop: 0 } : styles.customerBtn} onClick={() => { setCustomerQuery(''); setCustomerDayFilter(null); setCustomerOpen(true); }}>
              <User size={16} color={customerId ? '#14181F' : '#8A8F87'} />
              <span style={{ ...styles.customerBtnText, color: customerId ? '#14181F' : '#8A8F87' }}>
                {customerName || 'Select customer'}
              </span>
              <ChevronDown size={16} color="#8A8F87" style={{ marginLeft: 'auto' }} />
            </button>
            <button style={desktop ? { ...styles.dateBtn, flex: 1, marginTop: 0 } : styles.dateBtn} onClick={() => setDateOpen(true)}>
              <Calendar size={16} color={deliveryDate ? '#14181F' : '#8A8F87'} />
              <span style={{ ...styles.customerBtnText, color: deliveryDate ? '#14181F' : '#8A8F87' }}>
                {deliveryDate ? formatDate(deliveryDate) : 'Delivery date'}
              </span>
              <ChevronDown size={16} color="#8A8F87" style={{ marginLeft: 'auto' }} />
            </button>
          </>
        ) : (
          <button style={styles.pickersSummary} onClick={() => setPickersExpanded(true)}>
            <User size={14} color="#EDEBE3" />
            <span style={styles.pickersSummaryText}>{customerName}</span>
            <span style={styles.pickersSummaryDot}>·</span>
            <Calendar size={14} color="#EDEBE3" />
            <span style={styles.pickersSummaryText}>{formatDate(deliveryDate)}</span>
            <ChevronDown size={14} color="#B7BCB2" style={{ marginLeft: 'auto' }} />
          </button>
        )}
      </div>

      {previousOrder && (
        <button style={styles.repeatOrderBanner} onClick={addPreviousOrderQuantities}>
          <ClipboardList size={15} color="#2B5D50" />
          <span style={styles.repeatOrderText}>
            Add their last order — {previousOrder.lines.length} item{previousOrder.lines.length === 1 ? '' : 's'}, {formatDate(previousOrder.deliveryDate)}
          </span>
          <span style={styles.repeatOrderCta}>Add</span>
        </button>
      )}

      <div style={desktop ? { ...styles.searchWrap, padding: '8px 16px 4px' } : styles.searchWrap}>
        <div style={styles.searchInputWrap}>
          <Search size={16} color="#8A8F87" style={styles.searchIconInner} />
          <input
            style={styles.searchInputInner}
            placeholder="Search any item or SKU"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && (
            <button style={styles.clearSearchBtnInner} onClick={() => setQuery('')}>
              <X size={14} color="#8A8F87" />
            </button>
          )}
        </div>
        <button style={styles.gridSizeBtn} onClick={toggleGridSize} title={`Tile size: ${gridSize} (tap to change)`}>
          <GridSizeIcon variant={gridSize} size={16} color="#5B6058" />
        </button>
      </div>

      {screen === 'brands' && !searching && (
        <div style={{ ...styles.brandGrid, gridTemplateColumns: `repeat(auto-fill, minmax(${gridSizeMinWidth(gridSize)}px, 1fr))` }}>
          <button
            style={{ ...styles.brandTile, background: '#3C4132', ...styles.brandTileVariant[gridSize] }}
            onClick={() => { setBrand('All'); setScreen('items'); }}
          >
            <span style={{ ...styles.brandTileName, ...styles.brandTileNameVariant[gridSize] }}>All Items</span>
            <span style={styles.brandTileCount}>{items.length} items</span>
          </button>
          {brandList.map((b, idx) => (
            <button
              key={b}
              style={{ ...styles.brandTile, background: brandColor(b, idx, brandColors), ...styles.brandTileVariant[gridSize] }}
              onClick={() => { setBrand(b); setScreen('items'); }}
            >
              <span style={{ ...styles.brandTileName, ...styles.brandTileNameVariant[gridSize] }}>{b}</span>
              <span style={styles.brandTileCount}>{brandCounts[b] || 0} items</span>
            </button>
          ))}
        </div>
      )}

      {screen === 'items' && !searching && (
        <div style={desktop ? { ...styles.itemsSubHeader, padding: '4px 16px 2px' } : styles.itemsSubHeader}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <button style={styles.backBtnBig} onClick={goBackToBrands}>
              <ChevronLeft size={22} color="#14181F" strokeWidth={2.5} />
              <span>Brands</span>
            </button>
            <span style={styles.itemsSubHeaderBrand}>{brand === 'All' ? 'All Items' : brand}</span>
          </div>
          <select style={styles.sortSelect} value={sortBy} onChange={e => changeSortBy(e.target.value)}>
            {SORT_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
      )}
      {searching && (
        <div style={desktop ? { ...styles.itemsSubHeader, padding: '4px 16px 2px' } : styles.itemsSubHeader}>
          <span style={styles.itemsSubHeaderBrand}>
            <LayoutGrid size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
            Searching all brands
          </span>
          <select style={styles.sortSelect} value={sortBy} onChange={e => changeSortBy(e.target.value)}>
            {SORT_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
      )}

      {(screen === 'items' || searching) && (
        <div style={listStyle}>
          {filteredItems.length === 0 && (
            <div style={styles.emptyState}>No items match "{query}"</div>
          )}
          {filteredItems.map(item => {
            const qty = qtyFor(item.id);
            const low = item.stock <= 5;
            return (
              <div key={item.id} style={itemRowStyle}>
                {item.imageUrl && (
                  <img src={item.imageUrl} alt="" style={styles.itemThumb} loading="lazy" />
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={styles.itemName}>{item.name}</div>
                  <div style={styles.itemMeta}>
                    <span style={styles.sku}>{displayCode(item.id)}</span>
                    {item.packLabel && <span style={styles.brandLabel}>{item.packLabel}</span>}
                    <span style={{ ...styles.stockTag, ...(low ? styles.stockTagLow : {}) }}>
                      {item.stock} in stock
                    </span>
                  </div>
                  {item.price > 0 && (
                    <div style={styles.itemMeta}>
                      <span style={styles.brandLabel}>
                        {formatMoney(item.price)}/ea{item.pack > 1 ? ` · ${formatMoney(casePrice(item))}/cs` : ''}
                      </span>
                    </div>
                  )}
                  {desktop && item.stock <= 0 && !isOnOrder(item.id) && (
                    <button
                      style={styles.backorderBtnDesktop}
                      onClick={() => addCheckin(item.id)}
                      title="Out of stock — add to the order at 0 qty (backorder); it shows as a $0 line at the bottom of the invoice"
                    >
                      + Add (out of stock)
                    </button>
                  )}
                </div>
                {!desktop && item.stock <= 0 && !isOnOrder(item.id) && (
                  <button
                    style={styles.backorderBtn}
                    onClick={() => addCheckin(item.id)}
                    title="Out of stock — add to the order at 0 qty (backorder)"
                  >
                    + Add (out of stock)
                  </button>
                )}
                <div style={styles.stepper}>
                  <button style={styles.stepBtn} onClick={() => setQty(item.id, qty - 1)} disabled={qty === 0}>
                    <Minus size={14} color={qty === 0 ? '#C7CBC1' : '#14181F'} />
                  </button>
                  <span style={styles.stepQty}>{qty}</span>
                  <button style={styles.stepBtn} onClick={() => setQty(item.id, qty + 1)} disabled={qty >= item.stock + (isEdit ? (origQtyById[item.id] || 0) : 0)}>
                    <Plus size={14} color={qty >= item.stock + (isEdit ? (origQtyById[item.id] || 0) : 0) ? '#C7CBC1' : '#14181F'} />
                  </button>
                </div>
              </div>
            );
          })}
          <div style={{ height: 96 }} />
        </div>
      )}

      {orderLines.length > 0 && (
        <div style={styles.ticketBar} onClick={() => setTicketOpen(true)}>
          <div style={styles.ticketStub} />
          <div style={styles.ticketBarContent}>
            <ClipboardList size={18} color="#EDEBE3" />
            <span style={styles.ticketBarText}>
              {totalUnits} {totalUnits === 1 ? 'unit' : 'units'} · {orderLines.length} {orderLines.length === 1 ? 'item' : 'items'}
              {totalPrice > 0 && <span style={styles.ticketBarTotal}> · {formatMoney(totalPrice)}</span>}
            </span>
            <span style={styles.ticketBarCta}>Review order</span>
          </div>
        </div>
      )}

      {ticketOpen && (
        <div style={overlayStyle} onClick={() => !submitting && setTicketOpen(false)}>
          <div style={sheetStyle} onClick={e => e.stopPropagation()}>
            {!desktop && <div style={styles.sheetHandle} />}
            <div style={styles.sheetHeader}>
              <span style={styles.sheetTitle}>Order ticket</span>
              <button style={styles.iconBtn} onClick={() => setTicketOpen(false)} disabled={submitting}>
                <X size={18} color="#8A8F87" />
              </button>
            </div>
            <div style={styles.sheetCustomer}>
              {customerName || <span style={{ color: '#B5493B' }}>No customer selected</span>}
            </div>
            <div style={styles.sheetDelivery}>
              <Calendar size={13} color="#8A8F87" />
              {deliveryDate ? <span>Delivery {formatDate(deliveryDate)}</span> : <span style={{ color: '#B5493B' }}>No delivery date set</span>}
            </div>
            <div style={styles.sheetLines}>
              {orderLines.map(l => (
                <div key={l.id} style={styles.sheetLine}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={styles.sheetLineName}>{l.name}</div>
                    <div style={styles.sheetLineSku}>
                      {displayCode(l.id)}{l.pack > 1 ? ` · ${l.pack}ea` : ''}
                      {l.price > 0 && l.qty > 0 ? ` · ${formatMoney(l.price)}/ea · ${formatMoney(lineTotal(l, l.qty))}` : ''}
                    </div>
                  </div>
                  {l.qty === 0
                    ? <><div style={styles.checkinTag}>check-in</div><div style={styles.sheetLineQty}>×0</div></>
                    : <div style={styles.sheetLineQty}>×{l.qty}</div>}
                  <button style={styles.removeBtn} onClick={() => removeLine(l.id)} disabled={submitting}>
                    <X size={14} color="#8A8F87" />
                  </button>
                </div>
              ))}
            </div>
            <div style={styles.sheetTotal}>
              <span>Total units</span>
              <span style={styles.sheetTotalNum}>{totalUnits}</span>
            </div>
            {orderLines.some(l => l.price > 0) && (
              <div style={styles.sheetTotal}>
                <span>Order total</span>
                <span style={styles.sheetTotalNum}>
                  {formatMoney(orderLines.reduce((s, l) => s + lineTotal(l, l.qty), 0))}
                </span>
              </div>
            )}
            <div style={styles.notesSection}>
              <label style={styles.notesLabel}>Order notes / special instructions</label>
              <textarea
                style={{ ...styles.notesTextarea, minHeight: 34, height: notes ? undefined : 34, overflow: 'hidden' }}
                value={notes}
                onChange={e => setNotes(e.target.value)}
                onInput={e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'; }}
                placeholder="e.g. deliver before noon, call on arrival…"
                rows={1}
                maxLength={1000}
              />
            </div>
            {submitError && <div style={styles.sheetWarning}>{submitError}</div>}
            {!isEdit && (
              <div style={styles.orderedByRow}>
                {submitterName
                  ? <>Ordered by <strong>{submitterName}</strong> · <button style={styles.orderedByLink} onClick={openSignIn}>change</button></>
                  : <button style={styles.orderedByLink} onClick={openSignIn}>Set your name for orders</button>}
              </div>
            )}
            {isEdit ? (
              <>
                <button
                  style={{ ...styles.submitBtn, ...((customerId && deliveryDate && orderLines.length > 0 && !submitting) ? {} : styles.submitBtnDisabled) }}
                  disabled={!customerId || !deliveryDate || orderLines.length === 0 || submitting || deleting}
                  onClick={saveEdit}
                >
                  {submitting ? <Loader2 size={16} color="#F7F8F4" style={{ animation: 'spin 0.8s linear infinite' }} /> : <Check size={16} color="#F7F8F4" />}
                  {submitting ? 'Saving…' : 'Save changes'}
                </button>
                {!confirmDelete ? (
                  <button style={editStyles.deleteLink} onClick={() => setConfirmDelete(true)} disabled={submitting || deleting}>
                    Delete this order
                  </button>
                ) : (
                  <div style={editStyles.confirmDeleteRow}>
                    <span>Delete this order permanently?</span>
                    <button style={editStyles.confirmDeleteBtn} onClick={deleteEditOrder} disabled={deleting}>
                      {deleting ? 'Deleting…' : 'Yes, delete'}
                    </button>
                    <button style={editStyles.cancelLink} onClick={() => setConfirmDelete(false)} disabled={deleting}>
                      Cancel
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
                <button
                  style={{ ...styles.submitBtn, ...((customerId && deliveryDate && !submitting) ? {} : styles.submitBtnDisabled) }}
                  disabled={!customerId || !deliveryDate || submitting}
                  onClick={() => submitOrder(false)}
                >
                  {submitting ? (
                    <Loader2 size={16} color="#F7F8F4" style={{ animation: 'spin 0.8s linear infinite' }} />
                  ) : (
                    <Check size={16} color="#F7F8F4" />
                  )}
                  {submitting ? 'Submitting…' : 'Submit order'}
                </button>
                <div style={styles.ticketSecondaryRow}>
                  <button
                    style={{ ...styles.pendingBtn, ...((customerId && deliveryDate && !submitting) ? {} : styles.pendingBtnDisabled) }}
                    disabled={!customerId || !deliveryDate || submitting}
                    onClick={() => submitOrder(true)}
                    title="Save this order as pending — it shows in Orders and can be submitted later"
                  >
                    Save as pending
                  </button>
                  <button
                    style={styles.discardBtn}
                    disabled={submitting}
                    onClick={() => { if (window.confirm('Discard this order? This clears everything you\'ve added.')) discardOrder(); }}
                    title="Clear this order and start over"
                  >
                    Discard
                  </button>
                </div>
              </>
            )}
            {!submitting && (!customerId || !deliveryDate) && (
              <div style={styles.sheetWarning}>
                {!customerId && !deliveryDate ? `Select a customer and delivery date to ${isEdit ? 'save' : 'submit'} this order`
                  : !customerId ? `Select a customer to ${isEdit ? 'save' : 'submit'} this order`
                  : `Set a delivery date to ${isEdit ? 'save' : 'submit'} this order`}
              </div>
            )}
          </div>
        </div>
      )}

      {signInOpen && (
        <div style={overlayStyle} onClick={() => setSignInOpen(false)}>
          <div style={styles.signInCard} onClick={e => e.stopPropagation()}>
            <div style={styles.signInTitle}>Who's placing orders?</div>
            <div style={styles.signInSub}>Enter your name once — this device will remember it and tag your orders automatically.</div>
            <input
              autoFocus
              style={styles.signInInput}
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveSignIn(); }}
              placeholder="Your name"
              maxLength={60}
            />
            <button
              style={{ ...styles.submitBtn, ...(nameDraft.trim() ? {} : styles.submitBtnDisabled), marginTop: 12 }}
              disabled={!nameDraft.trim()}
              onClick={saveSignIn}
            >
              <Check size={16} color="#F7F8F4" /> Save
            </button>
            {submitterName && (
              <button style={styles.signInClear} onClick={() => { setSubmitterName(''); setSignInOpen(false); }}>
                Sign out of this device
              </button>
            )}
          </div>
        </div>
      )}

      {customerOpen && (
        <div style={overlayStyle} onClick={() => setCustomerOpen(false)}>
          <div style={sheetStyle} onClick={e => e.stopPropagation()}>
            {!desktop && <div style={styles.sheetHandle} />}
            <div style={styles.sheetHeader}>
              <span style={styles.sheetTitle}>Select customer</span>
              <button style={styles.iconBtn} onClick={() => setCustomerOpen(false)}>
                <X size={18} color="#8A8F87" />
              </button>
            </div>
            <div style={styles.customerSearchWrap}>
              <Search size={16} color="#8A8F87" />
              <input
                autoFocus={desktop}
                style={styles.customerSearchInput}
                value={customerQuery}
                onChange={e => setCustomerQuery(e.target.value)}
                placeholder="Search customers…"
              />
              {customerQuery && (
                <button style={styles.iconBtn} onClick={() => setCustomerQuery('')}>
                  <X size={15} color="#8A8F87" />
                </button>
              )}
            </div>
            {daysInUse.size > 0 && (
              <div style={styles.dayChipRow}>
                <button
                  style={{ ...styles.dayChip, ...(customerDayFilter === null ? styles.dayChipActive : {}) }}
                  onClick={() => setCustomerDayFilter(null)}
                >
                  All
                </button>
                {DAY_ABBR.map((label, i) => (
                  daysInUse.has(i) ? (
                    <button
                      key={i}
                      style={{ ...styles.dayChip, ...(customerDayFilter === i ? styles.dayChipActive : {}) }}
                      onClick={() => setCustomerDayFilter(customerDayFilter === i ? null : i)}
                    >
                      {label}
                    </button>
                  ) : null
                ))}
              </div>
            )}
            <div style={styles.sheetLines}>
              {filteredCustomers.length === 0 && (
                <div style={styles.customerEmpty}>
                  {customerDayFilter !== null
                    ? `No ${DAY_NAMES[customerDayFilter]} customers${customerQuery ? ` match "${customerQuery}"` : ''}`
                    : `No customers match "${customerQuery}"`}
                </div>
              )}
              {filteredCustomers.map(c => (
                <button
                  key={c.id}
                  style={{ ...styles.customerRow, ...(c.id === customerId ? styles.customerRowActive : {}) }}
                  onClick={() => {
                    setCustomerId(c.id);
                    setCustomerOpen(false);
                    // If this customer has a usual delivery day, jump the date to
                    // the next occurrence of it. Still fully changeable afterward.
                    // (Not in edit mode — keep the order's existing date.)
                    let nextDate = deliveryDate;
                    if (!isEdit && c.deliveryDay !== null && c.deliveryDay !== undefined) {
                      nextDate = nextDateForWeekday(c.deliveryDay);
                      setDeliveryDate(nextDate);
                    }
                    if (nextDate) setPickersExpanded(false);
                  }}
                >
                  <User size={15} color="#8A8F87" />
                  <span>{c.name}</span>
                  {c.deliveryDay !== null && c.deliveryDay !== undefined && (
                    <span style={styles.custDayTag}>{DAY_ABBR[c.deliveryDay]}s</span>
                  )}
                  {c.id === customerId && <Check size={15} color="#2B5D50" style={{ marginLeft: 'auto' }} />}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {dateOpen && (
        <div style={overlayStyle} onClick={() => setDateOpen(false)}>
          <div style={sheetStyle} onClick={e => e.stopPropagation()}>
            {!desktop && <div style={styles.sheetHandle} />}
            <div style={styles.sheetHeader}>
              <span style={styles.sheetTitle}>Delivery date</span>
              <button style={styles.iconBtn} onClick={() => setDateOpen(false)}>
                <X size={18} color="#8A8F87" />
              </button>
            </div>
            <div style={styles.dateTypeWrap}>
              <input
                type="date"
                style={styles.dateTypeInput}
                value={deliveryDate}
                onChange={e => {
                  const v = e.target.value;
                  setDeliveryDate(v);
                  if (v) {
                    const [y, m] = v.split('-').map(Number);
                    setCalendarMonth({ year: y, month: m - 1 });
                  }
                }}
              />
              <button
                style={styles.dateDoneBtn}
                onClick={() => {
                  setDateOpen(false);
                  if (customerId && deliveryDate) setPickersExpanded(false);
                }}
                disabled={!deliveryDate}
              >
                Done
              </button>
            </div>
            <div style={styles.dateOrDivider}>or pick from the calendar</div>
            <div style={styles.calendarNav}>
              <button
                style={styles.calendarNavBtn}
                onClick={() => setCalendarMonth(m => (m.month === 0 ? { year: m.year - 1, month: 11 } : { year: m.year, month: m.month - 1 }))}
              >
                <ChevronLeft size={16} color="#14181F" />
              </button>
              <span style={styles.calendarMonthLabel}>
                {new Date(calendarMonth.year, calendarMonth.month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
              </span>
              <button
                style={styles.calendarNavBtn}
                onClick={() => setCalendarMonth(m => (m.month === 11 ? { year: m.year + 1, month: 0 } : { year: m.year, month: m.month + 1 }))}
              >
                <ChevronDown size={16} color="#14181F" style={{ transform: 'rotate(-90deg)' }} />
              </button>
            </div>
            <div style={styles.calendarWeekRow}>
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span key={i} style={styles.calendarWeekday}>{d}</span>)}
            </div>
            <div style={styles.calendarGrid}>
              {buildCalendarGrid(calendarMonth.year, calendarMonth.month).map((day, idx) => {
                if (day === null) return <div key={idx} />;
                const iso = toISO(calendarMonth.year, calendarMonth.month, day);
                const isSelected = iso === deliveryDate;
                const todayISO = toISO(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
                const isToday = iso === todayISO;
                return (
                  <button
                    key={idx}
                    style={{ ...styles.calendarDay, ...(isSelected ? styles.calendarDaySelected : {}), ...(isToday && !isSelected ? styles.calendarDayToday : {}) }}
                    onClick={() => {
                      setDeliveryDate(iso);
                      setDateOpen(false);
                      if (customerId) setPickersExpanded(false);
                    }}
                  >
                    {day}
                  </button>
                );
              })}
            </div>
            {deliveryDate && (
              <button style={styles.calendarClearBtn} onClick={() => { setDeliveryDate(''); setDateOpen(false); }}>
                Clear date
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Confirmation({ data, onNewOrder }) {
  return (
    <div style={styles.screenWrap}>
      <div style={styles.confirmWrap}>
        <div style={styles.confirmBadge}>
          <Check size={22} color="#F7F8F4" />
        </div>
        <div style={styles.confirmTitle}>Order logged</div>
        <div style={styles.confirmSub}>{data.submittedAt} · {data.customer}</div>
        {data.submittedBy && <div style={styles.confirmSub}>Ordered by {data.submittedBy}</div>}
        <div style={styles.confirmDelivery}>
          <Calendar size={13} color="#5B6058" />
          Delivery {formatDate(data.deliveryDate)}
        </div>
        <div style={styles.receipt}>
          <div style={styles.receiptHeader}><span>ITEM</span><span>QTY</span></div>
          {data.lines.map(l => (
            <div key={l.id} style={styles.receiptLine}>
              <div>
                <div style={styles.receiptItemName}>{l.name}</div>
                <div style={styles.receiptSku}>
                  {displayCode(l.id)}{l.price > 0 ? ` · ${formatMoney(lineTotal(l, l.qty))}` : ''}
                </div>
              </div>
              <span style={styles.receiptQty}>{l.qty}</span>
            </div>
          ))}
          <div style={styles.receiptDivider} />
          <div style={styles.receiptTotalRow}>
            <span>Total units</span>
            <span style={styles.receiptTotalNum}>{data.totalUnits}</span>
          </div>
          {data.lines.some(l => l.price > 0) && (
            <div style={styles.receiptTotalRow}>
              <span>Order total</span>
              <span style={styles.receiptTotalNum}>
                {formatMoney(data.lines.reduce((s, l) => s + lineTotal(l, l.qty), 0))}
              </span>
            </div>
          )}
        </div>
        <div style={styles.confirmNote}>
          Saved to your live database — inventory updated for the whole team. This is where the order would also queue for QuickBooks.
        </div>
        <button style={styles.submitBtn} onClick={onNewOrder}>Start next order</button>
      </div>
    </div>
  );
}

// ============================================================
// TAB 2 — INVENTORY
// ============================================================
function InventoryTab({ items, orders, brandColors }) {
  const [brand, setBrand] = useState('All');
  const [query, setQuery] = useState('');
  const [screen, setScreen] = useState('brands');
  const [lowOnly, setLowOnly] = useState(false);

  const brandList = useMemo(() => Array.from(new Set(items.map(i => i.brand))), [items]);
  const brandCounts = useMemo(() => {
    const counts = {};
    items.forEach(i => { counts[i.brand] = (counts[i.brand] || 0) + 1; });
    return counts;
  }, [items]);
  const lowStockTotal = items.filter(i => i.stock <= 5).length;
  const searching = query.trim().length > 0;
  const popularity = useMemo(() => computePopularity(orders), [orders]);
  const [sortField, setSortField] = useState(() => {
    try { return localStorage.getItem('inventorySortField') || 'name'; } catch { return 'name'; }
  });
  const [sortDir, setSortDir] = useState(() => {
    try { return localStorage.getItem('inventorySortDir') || 'asc'; } catch { return 'asc'; }
  });
  function changeSortField(next) {
    setSortField(next);
    try { localStorage.setItem('inventorySortField', next); } catch { /* ignore */ }
  }
  function toggleSortDir() {
    setSortDir(prev => {
      const next = prev === 'asc' ? 'desc' : 'asc';
      try { localStorage.setItem('inventorySortDir', next); } catch { /* ignore */ }
      return next;
    });
  }

  useEffect(() => {
    if (lowStockTotal === 0 && lowOnly) setLowOnly(false);
  }, [lowStockTotal, lowOnly]);

  const filteredItems = useMemo(() => {
    const effectiveBrand = screen === 'brands' ? 'All' : brand;
    const filtered = items.filter(i => {
      const brandMatch = effectiveBrand === 'All' || i.brand === effectiveBrand;
      const q = query.trim().toLowerCase();
      const queryMatch = !q || i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q);
      const lowMatch = !lowOnly || i.stock <= 5;
      return brandMatch && queryMatch && lowMatch;
    });
    return sortInventoryItems(filtered, sortField, sortDir, popularity);
  }, [items, brand, query, screen, lowOnly, sortField, sortDir, popularity]);

  return (
    <div style={styles.screenWrap}>
      <div style={styles.header}>
        <div style={styles.headerTop}>
          <Boxes size={18} color="#EDEBE3" strokeWidth={2} />
          <span style={styles.headerTitle}>Inventory</span>
        </div>
        {lowStockTotal > 0 && (
          <button
            style={{ ...styles.lowStockBtn, ...(lowOnly ? styles.lowStockBtnActive : {}) }}
            onClick={() => setLowOnly(v => !v)}
          >
            <AlertTriangle size={15} color={lowOnly ? '#F7F8F4' : '#E7A98B'} />
            <span style={{ color: lowOnly ? '#F7F8F4' : '#EDEBE3' }}>
              {lowStockTotal} item{lowStockTotal === 1 ? '' : 's'} low on stock
            </span>
          </button>
        )}
      </div>

      <div style={styles.searchWrap}>
        <Search size={16} color="#8A8F87" style={styles.searchIcon} />
        <input
          style={styles.searchInput}
          placeholder="Search any item or SKU"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        {query && (
          <button style={styles.clearSearchBtn} onClick={() => setQuery('')}>
            <X size={14} color="#8A8F87" />
          </button>
        )}
      </div>

      {screen === 'brands' && !searching && !lowOnly && (
        <div style={styles.brandGrid}>
          <button
            style={{ ...styles.brandTile, background: '#3C4132' }}
            onClick={() => { setBrand('All'); setScreen('items'); }}
          >
            <span style={styles.brandTileName}>All Items</span>
            <span style={styles.brandTileCount}>{items.length} items</span>
          </button>
          {brandList.map((b, idx) => (
            <button
              key={b}
              style={{ ...styles.brandTile, background: brandColor(b, idx, brandColors) }}
              onClick={() => { setBrand(b); setScreen('items'); }}
            >
              <span style={styles.brandTileName}>{b}</span>
              <span style={styles.brandTileCount}>{brandCounts[b] || 0} items</span>
            </button>
          ))}
        </div>
      )}

      {screen === 'items' && !searching && !lowOnly && (
        <div style={desktop ? { ...styles.itemsSubHeader, padding: '4px 16px 2px' } : styles.itemsSubHeader}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <button style={styles.backBtnBig} onClick={() => { setScreen('brands'); setBrand('All'); }}>
              <ChevronLeft size={22} color="#14181F" strokeWidth={2.5} />
              <span>Brands</span>
            </button>
            <span style={styles.itemsSubHeaderBrand}>{brand === 'All' ? 'All Items' : brand}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <select style={styles.sortSelect} value={sortField} onChange={e => changeSortField(e.target.value)}>
              {INVENTORY_SORT_COLUMNS.map(o => <option key={o.id} value={o.id}>Sort: {o.label}</option>)}
            </select>
            <button style={styles.sortDirBtn} onClick={toggleSortDir} title={sortDir === 'asc' ? 'Ascending' : 'Descending'}>
              {sortDir === 'asc' ? '↑' : '↓'}
            </button>
          </div>
        </div>
      )}
      {(searching || lowOnly) && (
        <div style={desktop ? { ...styles.itemsSubHeader, padding: '4px 16px 2px' } : styles.itemsSubHeader}>
          <span style={styles.itemsSubHeaderBrand}>
            {lowOnly ? 'Low stock, all brands' : (
              <><LayoutGrid size={13} style={{ marginRight: 6, verticalAlign: -2 }} />Searching all brands</>
            )}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <select style={styles.sortSelect} value={sortField} onChange={e => changeSortField(e.target.value)}>
              {INVENTORY_SORT_COLUMNS.map(o => <option key={o.id} value={o.id}>Sort: {o.label}</option>)}
            </select>
            <button style={styles.sortDirBtn} onClick={toggleSortDir} title={sortDir === 'asc' ? 'Ascending' : 'Descending'}>
              {sortDir === 'asc' ? '↑' : '↓'}
            </button>
          </div>
        </div>
      )}

      {(screen === 'items' || searching || lowOnly) && (
        <div style={styles.list}>
          {filteredItems.length === 0 && <div style={styles.emptyState}>No items match "{query}"</div>}
          {filteredItems.map(item => {
            const low = item.stock <= 5;
            const pct = Math.min(100, (item.stock / 40) * 100);
            return (
              <div key={item.id} style={styles.invRow}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={styles.itemName}>{item.name}</div>
                  <div style={styles.itemMeta}>
                    <span style={styles.sku}>{displayCode(item.id)}</span>
                    <span style={styles.brandLabel}>{item.brand}</span>
                    {item.packLabel && <span style={styles.brandLabel}>{item.packLabel}</span>}
                    {item.price > 0 && (
                      <span style={styles.brandLabel}>
                        {formatMoney(item.price)}/ea{item.pack > 1 ? ` · ${formatMoney(casePrice(item))}/cs` : ''}
                      </span>
                    )}
                  </div>
                  <div style={styles.stockBarTrack}>
                    <div style={{ ...styles.stockBarFill, width: `${pct}%`, background: low ? '#B5493B' : '#2B5D50' }} />
                  </div>
                </div>
                <div style={{ ...styles.invStockNum, color: low ? '#B5493B' : '#14181F' }}>{item.stock}</div>
              </div>
            );
          })}
          <div style={{ height: 24 }} />
        </div>
      )}
    </div>
  );
}

// ============================================================
// TAB 3 — ORDERS
// ============================================================
function OrdersTab({ orders, onSwitchToOffice, items, customers, printSequence, onOrderChanged }) {
  const [openId, setOpenId] = useState(null);
  const [query, setQuery] = useState('');
  const [editingOrder, setEditingOrder] = useState(null);
  const [iifBusyId, setIifBusyId] = useState(null);
  const [iifError, setIifError] = useState('');
  const [processingId, setProcessingId] = useState(null);
  const [showUnprocessedOnly, setShowUnprocessedOnly] = useState(false);

  async function setProcessed(orderId, processed) {
    setProcessingId(orderId);
    try {
      await apiPatch(`/orders/${orderId}/processed`, { processed });
      if (onOrderChanged) await onOrderChanged();
    } catch (err) {
      setIifError(err.message || 'Could not update the order status.');
    } finally {
      setProcessingId(null);
    }
  }

  async function handleDownloadIIF(orderId, experimental = false) {
    setIifBusyId(orderId);
    setIifError('');
    try {
      await downloadOrderIIF(orderId, experimental);
      const order = orders.find(o => o.id === orderId);
      if (order && !order.processed) {
        await apiPatch(`/orders/${orderId}/processed`, { processed: true });
        if (onOrderChanged) await onOrderChanged();
      }
    } catch (err) {
      setIifError(err.message || 'Could not download the QuickBooks file.');
    } finally {
      setIifBusyId(null);
    }
  }

  const unprocessedCount = useMemo(() => orders.filter(o => !o.processed).length, [orders]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = showUnprocessedOnly ? orders.filter(o => !o.processed) : orders;
    if (!q) return list;
    return list.filter(o =>
      o.customer.toLowerCase().includes(q) ||
      o.lines.some(l => l.name.toLowerCase().includes(q) || l.id.toLowerCase().includes(q))
    );
  }, [orders, query, showUnprocessedOnly]);

  return (
    <div style={styles.screenWrap}>
      <div style={styles.header}>
        <div style={styles.headerTop}>
          <ClipboardCheck size={18} color="#EDEBE3" strokeWidth={2} />
          <span style={styles.headerTitle}>Orders</span>
          <button style={styles.officeLinkBtn} onClick={onSwitchToOffice}>
            <Monitor size={13} color="#B7BCB2" strokeWidth={2} />
            <span>Office View</span>
          </button>
        </div>
        <div style={styles.orderCountPill}>
          {orders.length} order{orders.length === 1 ? '' : 's'} logged
        </div>
      </div>

      <div style={styles.searchWrap}>
        <Search size={16} color="#8A8F87" style={styles.searchIcon} />
        <input
          style={styles.searchInput}
          placeholder="Search by customer or item"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        {query && (
          <button style={styles.clearSearchBtn} onClick={() => setQuery('')}>
            <X size={14} color="#8A8F87" />
          </button>
        )}
      </div>

      <div style={styles.mobileFilterRow}>
        <button
          style={{ ...styles.mobileFilterChip, ...(showUnprocessedOnly ? styles.mobileFilterChipActive : {}) }}
          onClick={() => setShowUnprocessedOnly(v => !v)}
        >
          {showUnprocessedOnly ? 'Showing unprocessed' : 'Show unprocessed'}
          {unprocessedCount > 0 && ` (${unprocessedCount})`}
        </button>
      </div>

      <div style={styles.list}>
        {iifError && (
          <div style={styles.mobileIifError}>
            {iifError}
            <button style={styles.mobileIifErrorDismiss} onClick={() => setIifError('')}>×</button>
          </div>
        )}
        {filtered.length === 0 && <div style={styles.emptyState}>No orders match "{query}"</div>}
        {filtered.map(o => {
          const isOpen = openId === o.id;
          const totalUnits = o.lines.reduce((s, l) => s + l.qty, 0);
          return (
            <div key={o.id} style={{ ...styles.orderCard, ...(o.processed ? {} : styles.orderCardUnprocessed) }}>
              <button style={styles.orderCardHeader} onClick={() => setOpenId(isOpen ? null : o.id)}>
                <div style={{ textAlign: 'left' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <div style={styles.orderCardCustomer}>{o.customer}</div>
                    {o.status === 'pending'
                      ? <span style={styles.badgePendingMobile}>Pending</span>
                      : !o.processed && <span style={styles.badgeUnprocessedMobile}>New</span>}
                  </div>
                  <div style={styles.orderCardMeta}>
                    {formatDateTime(o.submittedAt)} · {totalUnits} units · {o.lines.length} item{o.lines.length === 1 ? '' : 's'}
                    {o.submittedBy ? ` · by ${o.submittedBy}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={styles.orderCardDelivery}>
                    <Calendar size={12} color="#5B6058" />
                    {formatDate(o.deliveryDate)}
                  </div>
                  <ChevronRight size={16} color="#8A8F87" style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
                </div>
              </button>
              {isOpen && (
                <div style={styles.orderCardLines}>
                  {o.lines.map(l => (
                    <div key={l.id} style={styles.orderCardLine}>
                      <div>
                        <div style={styles.sheetLineName}>{l.name}</div>
                        <div style={styles.sheetLineSku}>{displayCode(l.id)}</div>
                      </div>
                      <div style={styles.sheetLineQty}>×{l.qty}</div>
                    </div>
                  ))}
                  {o.notes && (
                    <div style={styles.orderCardNotes}>
                      <span style={styles.orderCardNotesLabel}>Notes:</span> {o.notes}
                    </div>
                  )}
                  <div style={styles.orderCardActions}>
                    <button style={styles.orderCardActionBtn} onClick={() => setEditingOrder(o)}>Edit</button>
                    <button style={styles.orderCardActionBtn} onClick={() => printOrder(o, printSequence, { withUpc: false })}>Print</button>
                    <button style={styles.orderCardActionBtn} onClick={() => printOrder(o, printSequence, { withUpc: true })}>Print w/UPC</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div style={{ height: 24 }} />
      </div>

      {editingOrder && (
        <OrderEditModal
          order={editingOrder}
          items={items}
          customers={customers}
          orders={orders}
          printSequence={printSequence}
          desktop={false}
          onClose={() => setEditingOrder(null)}
          onSaved={async () => { setEditingOrder(null); await onOrderChanged(); }}
        />
      )}
    </div>
  );
}

// ============================================================
// SHARED — ORDER EDIT MODAL (used by both mobile Orders tab and
// desktop Office Orders table)
// ============================================================
function OrderEditModal({ order, items, customers, brandColors = {}, orders = [], printSequence = [], onClose, onSaved, desktop = true }) {
  // Full New-Order-style editor: reuse OrderTab in edit mode inside a modal.
  // On mobile we drop the desktop layout (and the boxed modal chrome) so the
  // editor fills the screen and the header isn't cramped.
  return (
    <div style={desktop ? styles.editOverlay : styles.editOverlayMobile} onClick={desktop ? onClose : undefined}>
      <div style={desktop ? styles.editModalWrap : styles.editModalWrapMobile} onClick={e => e.stopPropagation()}>
        <OrderTab
          desktop={desktop}
          editOrder={order}
          items={items}
          customers={customers}
          orders={orders}
          brandColors={brandColors}
          printSequence={printSequence}
          onOrderSubmitted={onSaved}
          onClose={onClose}
        />
      </div>
    </div>
  );
}

// Read-only order details popup. Shows the order's customer, date, status, and
// line items (with cases + eaches and totals) without any editing controls.
function OrderViewModal({ order, onClose, onEdit }) {
  const lines = order.lines || [];
  const totalCases = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const totalEaches = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.pack) || 1), 0);
  const total = lines.reduce((s, l) => s + (Number(l.price) || 0) * (Number(l.pack) || 1) * (Number(l.qty) || 0), 0);
  return (
    <div style={styles.editOverlay} onClick={onClose}>
      <div style={viewStyles.card} onClick={e => e.stopPropagation()}>
        <div style={viewStyles.header}>
          <button style={{ ...styles.iconBtn, marginRight: 4 }} onClick={onClose} title="Close"><X size={18} color="#8A8F87" /></button>
          <div>
            <div style={viewStyles.title}>Order #{order.id} — {order.customer}</div>
            <div style={viewStyles.meta}>
              Delivery {formatDate(order.deliveryDate)} · Submitted {formatDateTime(order.submittedAt)}
              {order.submittedBy ? ` · by ${order.submittedBy}` : ''}
            </div>
          </div>
        </div>
        <div style={viewStyles.badgeRow}>
          {order.status === 'pending'
            ? <span style={officeStyles.badgePending}>Pending</span>
            : order.processed
              ? <span style={officeStyles.badgeProcessed}>Processed</span>
              : <span style={officeStyles.badgeUnprocessed}>New</span>}
        </div>
        <div style={viewStyles.tableWrap}>
          <table style={viewStyles.table}>
            <thead>
              <tr>
                <th style={viewStyles.th}>Item #</th>
                <th style={viewStyles.th}>Item</th>
                <th style={{ ...viewStyles.th, textAlign: 'right' }}>Cases</th>
                <th style={{ ...viewStyles.th, textAlign: 'right' }}>Eaches</th>
                <th style={{ ...viewStyles.th, textAlign: 'right' }}>Price/ea</th>
                <th style={{ ...viewStyles.th, textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(l => {
                const cases = Number(l.qty) || 0;
                const pack = Number(l.pack) || 1;
                return (
                  <tr key={l.id}>
                    <td style={viewStyles.td}>{displayCode(l.id)}</td>
                    <td style={viewStyles.td}>{l.name}</td>
                    <td style={{ ...viewStyles.td, textAlign: 'right' }}>{cases}</td>
                    <td style={{ ...viewStyles.td, textAlign: 'right' }}>{cases * pack}</td>
                    <td style={{ ...viewStyles.td, textAlign: 'right' }}>{formatMoney(l.price)}</td>
                    <td style={{ ...viewStyles.td, textAlign: 'right' }}>{formatMoney((Number(l.price) || 0) * pack * cases)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td style={viewStyles.tfootTd}>Totals</td>
                <td style={viewStyles.tfootTd}></td>
                <td style={{ ...viewStyles.tfootTd, textAlign: 'right' }}>{totalCases}</td>
                <td style={{ ...viewStyles.tfootTd, textAlign: 'right' }}>{totalEaches}</td>
                <td style={viewStyles.tfootTd}></td>
                <td style={{ ...viewStyles.tfootTd, textAlign: 'right' }}>{formatMoney(total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        {order.notes && (
          <div style={viewStyles.notes}><strong>Notes:</strong> {order.notes}</div>
        )}
        <div style={viewStyles.footer}>
          <button style={viewStyles.editBtn} onClick={onEdit}>Edit this order</button>
          <button style={viewStyles.closeBtn} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

const viewStyles = {
  card: { width: '100%', maxWidth: 720, maxHeight: '88vh', overflowY: 'auto', background: '#F7F8F4', borderRadius: 16, boxShadow: '0 20px 60px rgba(20,24,31,0.4)', padding: 20 },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start', gap: 10 },
  title: { fontSize: 17, fontWeight: 800, color: '#14181F' },
  meta: { fontSize: 12.5, color: '#5B6058', marginTop: 3 },
  badgeRow: { margin: '10px 0 4px' },
  tableWrap: { marginTop: 8, background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 10, overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', color: '#8A8F87', padding: '8px 10px', borderBottom: '1px solid #ECEAE1', background: '#FBFAF6' },
  td: { padding: '8px 10px', color: '#14181F', borderBottom: '1px solid #F0EEE6' },
  tfootTd: { padding: '9px 10px', fontWeight: 800, color: '#14181F', borderTop: '2px solid #14181F' },
  notes: { marginTop: 12, background: '#FBFAF6', border: '1px solid #E3E1D6', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#14181F' },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 },
  editBtn: { background: '#2B5D50', color: '#F7F8F4', border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  closeBtn: { background: '#EDEBE3', color: '#14181F', border: '1px solid #E3E1D6', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
};

const editStyles = {
  select: { width: '100%', boxSizing: 'border-box', background: '#F7F8F4', border: '1px solid #D6D3C6', borderRadius: 8, padding: '10px 12px', fontSize: 14, fontFamily: 'inherit', color: '#14181F', outline: 'none' },
  searchDropdown: { position: 'absolute', left: 20, right: 20, top: '100%', background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 8, boxShadow: '0 4px 12px rgba(20,24,31,0.12)', zIndex: 30, maxHeight: 220, overflowY: 'auto' },
  searchResultRow: { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, width: '100%', borderBottom: '1px solid #EAE8DD', padding: '5px 8px 5px 12px' },
  searchResultMain: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, flex: 1, textAlign: 'left', background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13.5 },
  checkinAddBtn: { flexShrink: 0, background: '#EAF1EE', border: '1px solid #C4DDD2', color: '#2B5D50', borderRadius: 7, padding: '6px 10px', fontSize: 11.5, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' },
  deleteLink: { display: 'block', margin: '10px auto 4px', background: 'none', border: 'none', color: '#B5493B', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' },
  confirmDeleteRow: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, margin: '10px 20px 4px', fontSize: 12.5, color: '#7A2E22', flexWrap: 'wrap' },
  confirmDeleteBtn: { background: '#B5493B', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  cancelLink: { background: 'none', border: 'none', color: '#8A8F87', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' },
};

// ============================================================
// DESKTOP — OFFICE VIEW (orders table for QuickBooks entry,
// inventory table with editable stock)
// ============================================================
function OfficeView({ items, customers, activeItems, activeCustomers, orders, brandColors, brandSettings = {}, printSequence, onRefresh, onSwitchToMobile, isManualOverride, onResetToAuto }) {
  const [navStack, setNavStack] = useState(['orders']);
  const section = navStack[navStack.length - 1];
  const setSection = useCallback((next) => {
    setNavStack(stack => (next === stack[stack.length - 1] ? stack : [...stack, next]));
  }, []);
  const goBack = useCallback(() => {
    setNavStack(stack => (stack.length > 1 ? stack.slice(0, -1) : stack));
  }, []);
  const canGoBack = navStack.length > 1;
  const [refreshing, setRefreshing] = useState(false);
  // Badge counts only submitted-but-new orders (real work to process). Pending
  // drafts still appear in the Orders tab but don't inflate this "to-do" count.
  const activeOrderCount = useMemo(() => orders.filter(o => o.status !== 'pending' && !o.processed).length, [orders]);

  async function handleRefresh() {
    setRefreshing(true);
    await onRefresh();
    setRefreshing(false);
  }

  return (
    <div style={officeStyles.wrap}>
      <div style={officeStyles.topBar}>
        <div style={officeStyles.brand}>
          <Monitor size={18} color="#EDEBE3" />
          <span style={officeStyles.brandText}>Order Entry — Office View</span>
        </div>
        <div style={officeStyles.nav}>
          <button
            style={{ ...officeStyles.navBtn, ...officeStyles.backNavBtn, ...(!canGoBack ? officeStyles.backNavBtnDisabled : {}) }}
            onClick={goBack}
            disabled={!canGoBack}
            title="Back to previous screen"
            aria-label="Back to previous screen"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            style={{ ...officeStyles.navBtn, ...(section === 'neworder' ? officeStyles.navBtnActive : {}) }}
            onClick={() => setSection('neworder')}
          >
            New Order
          </button>
          <button
            style={{ ...officeStyles.navBtn, ...(section === 'orders' ? officeStyles.navBtnActive : {}) }}
            onClick={() => setSection('orders')}
          >
            Orders{activeOrderCount > 0 && <span style={officeStyles.navBadge}>{activeOrderCount}</span>}
          </button>
          <button
            style={{ ...officeStyles.navBtn, ...(section === 'history' ? officeStyles.navBtnActive : {}) }}
            onClick={() => setSection('history')}
          >
            History
          </button>
          <button
            style={{ ...officeStyles.navBtn, ...(section === 'inventory' ? officeStyles.navBtnActive : {}) }}
            onClick={() => setSection('inventory')}
          >
            Inventory
          </button>
          <button
            style={{ ...officeStyles.navBtn, ...(section === 'items' ? officeStyles.navBtnActive : {}) }}
            onClick={() => setSection('items')}
          >
            Items
          </button>
          <button
            style={{ ...officeStyles.navBtn, ...(section === 'customers' ? officeStyles.navBtnActive : {}) }}
            onClick={() => setSection('customers')}
          >
            Customers
          </button>
        </div>
        {isManualOverride && (
          <button style={officeStyles.autoLink} onClick={onResetToAuto} title="Go back to switching automatically by screen size">
            Auto
          </button>
        )}
        <button style={officeStyles.refreshBtn} onClick={onSwitchToMobile}>
          Mobile View
        </button>
        <button style={officeStyles.refreshBtn} onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw size={14} style={{ animation: refreshing ? 'spin 0.8s linear infinite' : 'none' }} />
          Refresh
        </button>
      </div>

      <div style={section === 'neworder' ? officeStyles.bodyNoScroll : officeStyles.body}>
        {section === 'neworder' && (
          <div style={officeStyles.orderFormWrap}>
            <OrderTab
              items={activeItems}
              customers={activeCustomers}
              orders={orders}
              brandColors={brandColors}
              printSequence={printSequence}
              onOrderSubmitted={async () => { await onRefresh(); }}
              desktop
            />
          </div>
        )}
        {section === 'orders' && <OfficeOrders scope="active" orders={orders} items={activeItems} customers={activeCustomers} printSequence={printSequence} onRefresh={onRefresh} />}
        {section === 'history' && <OfficeOrders scope="all" orders={orders} items={activeItems} customers={activeCustomers} printSequence={printSequence} onRefresh={onRefresh} />}
        {section === 'inventory' && <OfficeInventory mode="inventory" items={items} customers={activeCustomers} orders={orders} brandColors={brandColors} brandSettings={brandSettings} printSequence={printSequence} onRefresh={onRefresh} />}
        {section === 'items' && <OfficeInventory mode="items" items={items} customers={activeCustomers} orders={orders} brandColors={brandColors} brandSettings={brandSettings} printSequence={printSequence} onRefresh={onRefresh} />}
        {section === 'customers' && <OfficeCustomers customers={customers} onRefresh={onRefresh} />}
      </div>
    </div>
  );
}

function OfficeOrders({ orders, items, customers, printSequence, onRefresh, scope = 'all' }) {
  const activeScope = scope === 'active';
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState(null);
  const [editingOrder, setEditingOrder] = useState(null);
  const [iifBusyId, setIifBusyId] = useState(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [iifError, setIifError] = useState('');
  const [processingId, setProcessingId] = useState(null);
  const [showUnprocessedOnly, setShowUnprocessedOnly] = useState(false);

  async function setProcessed(orderId, processed) {
    setProcessingId(orderId);
    try {
      await apiPatch(`/orders/${orderId}/processed`, { processed });
      await onRefresh();
    } catch (err) {
      setIifError(err.message || 'Could not update the order status.');
    } finally {
      setProcessingId(null);
    }
  }

  const [sortField, setSortField] = useState('submittedAt');
  const [sortDir, setSortDir] = useState('desc');
  function handleSortClick(field) {
    if (field === sortField) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      // Dates default newest-first; everything else A→Z / low→high.
      setSortDir(field === 'submittedAt' || field === 'deliveryDate' ? 'desc' : 'asc');
    }
  }

  async function handleDownloadIIF(orderId, experimental = false) {
    setIifBusyId(orderId);
    setIifError('');
    try {
      await downloadOrderIIF(orderId, experimental);
      // Auto-mark as processed once the QuickBooks file is downloaded.
      const order = orders.find(o => o.id === orderId);
      if (order && !order.processed) {
        await apiPatch(`/orders/${orderId}/processed`, { processed: true });
        await onRefresh();
      }
    } catch (err) {
      setIifError(err.message || 'Could not download the QuickBooks file.');
    } finally {
      setIifBusyId(null);
    }
  }

  async function handleDownloadTP(orderId) {
    setIifBusyId(orderId);
    setIifError('');
    try {
      await downloadOrderTP(orderId);
      const order = orders.find(o => o.id === orderId);
      if (order && !order.processed) {
        await apiPatch(`/orders/${orderId}/processed`, { processed: true });
        await onRefresh();
      }
    } catch (err) {
      setIifError(err.message || 'Could not download the Transaction Pro file.');
    } finally {
      setIifBusyId(null);
    }
  }

  // Export every submitted-unprocessed order (skipping pending) as one TP file,
  // then mark them all processed so they drop off the queue.
  async function handleBatchTP() {
    const batch = orders.filter(o => o.status !== 'pending' && !o.processed);
    if (batch.length === 0) return;
    setBatchBusy(true);
    setIifError('');
    try {
      await downloadOrdersTP(batch.map(o => o.id));
      for (const o of batch) {
        await apiPatch(`/orders/${o.id}/processed`, { processed: true });
      }
      await onRefresh();
    } catch (err) {
      setIifError(err.message || 'Could not export the batch Transaction Pro file.');
    } finally {
      setBatchBusy(false);
    }
  }

  // Print an order, then auto-mark it processed. withUpc toggles the barcode column.
  async function handlePrint(order, withUpc = false) {
    printOrder(order, printSequence, { withUpc });
    if (!order.processed) {
      try {
        await apiPatch(`/orders/${order.id}/processed`, { processed: true });
        await onRefresh();
      } catch { /* printing still succeeded; status just won't update */ }
    }
  }

  // Finalize a pending order (reserve stock + move it to submitted).
  async function submitPending(orderId) {
    setProcessingId(orderId);
    setIifError('');
    try {
      await apiPatch(`/orders/${orderId}/submit`, {});
      await onRefresh();
    } catch (err) {
      setIifError(err.message || 'Could not submit this pending order.');
    } finally {
      setProcessingId(null);
    }
  }

  const unprocessedCount = useMemo(() => orders.filter(o => !o.processed).length, [orders]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = orders;
    // The active queue shows only orders needing attention: pending + new.
    if (activeScope) list = list.filter(o => o.status === 'pending' || !o.processed);
    if (showUnprocessedOnly) list = list.filter(o => !o.processed);
    if (q) {
      list = list.filter(o =>
        o.customer.toLowerCase().includes(q) ||
        o.lines.some(l => l.name.toLowerCase().includes(q) || l.id.toLowerCase().includes(q))
      );
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    const val = (o) => {
      switch (sortField) {
        case 'submittedAt': return new Date(o.submittedAt).getTime() || 0;
        case 'customer': return o.customer.toLowerCase();
        case 'deliveryDate': return o.deliveryDate || '';
        case 'status': return o.status === 'pending' ? 0 : (o.processed ? 2 : 1);
        case 'items': return o.lines.length;
        case 'units': return o.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
        case 'total': return o.lines.reduce((s, l) => s + lineTotal(l, l.qty), 0);
        case 'submittedBy': return (o.submittedBy || '').toLowerCase();
        default: return 0;
      }
    };
    return [...list].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return (a.id - b.id) * dir; // stable tiebreak
    });
  }, [orders, query, showUnprocessedOnly, sortField, sortDir, activeScope]);

  function orderTotal(o) {
    return o.lines.reduce((s, l) => s + lineTotal(l, l.qty), 0);
  }

  // Submitted (non-pending) orders not yet processed — what the batch exports.
  const batchExportable = orders.filter(o => o.status !== 'pending' && !o.processed);

  return (
    <div>
      <div style={officeStyles.sectionHeader}>
        <div style={officeStyles.sectionTitle}>{activeScope ? 'New & pending orders' : 'Order history'}</div>
        <input
          style={officeStyles.search}
          placeholder="Search by customer or item…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        {activeScope && (
          <button
            style={{ ...officeStyles.primarySmallBtn, ...(batchExportable.length === 0 || batchBusy ? officeStyles.smallBtnDisabled : {}) }}
            onClick={handleBatchTP}
            disabled={batchExportable.length === 0 || batchBusy}
            title="Download one Transaction Pro file with every new order (excludes pending), and mark them processed"
          >
            {batchBusy ? 'Exporting…' : `Export all to TP${batchExportable.length ? ` (${batchExportable.length})` : ''}`}
          </button>
        )}
        {!activeScope && (
          <button
            style={{ ...officeStyles.smallBtn, ...(showUnprocessedOnly ? officeStyles.editModeBtnActive : {}) }}
            onClick={() => setShowUnprocessedOnly(v => !v)}
            title="Show only orders not yet entered into QuickBooks"
          >
            {showUnprocessedOnly ? 'Showing unprocessed' : 'Show unprocessed'}
            {unprocessedCount > 0 && ` (${unprocessedCount})`}
          </button>
        )}
        <div style={officeStyles.countPill}>{filtered.length} order{filtered.length === 1 ? '' : 's'}</div>
      </div>

      {activeScope && filtered.length === 0 && (
        <div style={officeStyles.allCaughtUp}>
          <Check size={16} color="#2B5D50" /> All caught up — no new or pending orders.
        </div>
      )}

      {iifError && (
        <div style={officeStyles.importBannerError}>
          {iifError}
          <button style={officeStyles.dismissBtn} onClick={() => setIifError('')}>×</button>
        </div>
      )}

      <div style={officeStyles.tableCard}>
        <table style={officeStyles.table}>
          <thead>
            <tr>
              <th style={officeStyles.th}></th>
              <SortableTh field="submittedAt" label="Submitted" sortField={sortField} sortDir={sortDir} onClick={handleSortClick} />
              <SortableTh field="customer" label="Customer" sortField={sortField} sortDir={sortDir} onClick={handleSortClick} />
              <SortableTh field="deliveryDate" label="Delivery date" sortField={sortField} sortDir={sortDir} onClick={handleSortClick} />
              <SortableTh field="status" label="Status" sortField={sortField} sortDir={sortDir} onClick={handleSortClick} />
              <SortableTh field="items" label="Items" sortField={sortField} sortDir={sortDir} onClick={handleSortClick} />
              <SortableTh field="units" label="Units" sortField={sortField} sortDir={sortDir} onClick={handleSortClick} />
              <SortableTh field="total" label="Order total" sortField={sortField} sortDir={sortDir} onClick={handleSortClick} align="right" />
              <th style={officeStyles.th}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td style={officeStyles.emptyCell} colSpan={9}>No orders match "{query}"</td></tr>
            )}
            {filtered.map(o => {
              const isOpen = openId === o.id;
              const totalUnits = o.lines.reduce((s, l) => s + l.qty, 0);
              return (
                <React.Fragment key={o.id}>
                  <tr style={{ ...officeStyles.rowClickable, ...(o.processed ? {} : officeStyles.rowUnprocessed) }}>
                    <td style={officeStyles.td} onClick={() => setOpenId(isOpen ? null : o.id)}>
                      <ChevronRight size={14} color="#8A8F87" style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
                    </td>
                    <td style={officeStyles.td} onClick={() => setOpenId(isOpen ? null : o.id)}>
                      {formatDateTime(o.submittedAt)}
                      {o.submittedBy && <div style={{ fontSize: 11, color: '#8A8F87' }}>by {o.submittedBy}</div>}
                    </td>
                    <td style={{ ...officeStyles.td, fontWeight: 700 }} onClick={() => setOpenId(isOpen ? null : o.id)}>{o.customer}</td>
                    <td style={officeStyles.td} onClick={() => setOpenId(isOpen ? null : o.id)}>{formatDate(o.deliveryDate)}</td>
                    <td style={officeStyles.td} onClick={() => setOpenId(isOpen ? null : o.id)}>
                      {o.status === 'pending'
                        ? <span style={officeStyles.badgePending}>Pending</span>
                        : o.processed
                          ? <span style={officeStyles.badgeProcessed}>Processed</span>
                          : <span style={officeStyles.badgeUnprocessed}>New</span>}
                    </td>
                    <td style={officeStyles.td} onClick={() => setOpenId(isOpen ? null : o.id)}>{o.lines.length}</td>
                    <td style={officeStyles.td} onClick={() => setOpenId(isOpen ? null : o.id)}>{totalUnits}</td>
                    <td style={{ ...officeStyles.td, textAlign: 'right', fontWeight: 700 }} onClick={() => setOpenId(isOpen ? null : o.id)}>{formatMoney(orderTotal(o))}</td>
                    <td style={{ ...officeStyles.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {o.status === 'pending' ? (
                        <>
                          <button
                            style={{ ...officeStyles.smallBtn, ...officeStyles.markDoneBtn }}
                            onClick={() => submitPending(o.id)}
                            disabled={processingId === o.id}
                            title="Finalize this pending order and submit it"
                          >
                            {processingId === o.id ? '…' : 'Submit'}
                          </button>{' '}
                          <button style={officeStyles.smallBtn} onClick={() => setEditingOrder(o)}>Edit</button>{' '}
                          <button style={officeStyles.smallBtn} onClick={() => handlePrint(o, false)} title="Print a compact order sheet (no barcodes)">Print</button>
                        </>
                      ) : (
                        <>
                          <button style={officeStyles.smallBtn} onClick={() => setEditingOrder(o)}>Edit</button>{' '}
                          <button style={officeStyles.smallBtn} onClick={() => handlePrint(o, false)} title="Print a compact order sheet (no barcodes)">Print</button>{' '}
                          <button style={officeStyles.smallBtn} onClick={() => handlePrint(o, true)} title="Print an order sheet with scannable UPC barcodes for check-in">Print w/UPC</button>{' '}
                          <button style={officeStyles.smallBtn} onClick={() => printInvoice(o, customers.find(cc => cc.name === o.customer) || customers.find(cc => cc.id === o.customerId), printSequence)} title="Print an invoice for this order">Invoice</button>{' '}
                          <button style={officeStyles.smallBtn} onClick={() => handleDownloadTP(o.id)} disabled={iifBusyId === o.id} title="Download a Transaction Pro Importer file (.CSV) for QuickBooks Desktop">
                            {iifBusyId === o.id ? '…' : 'TP'}
                          </button>{' '}
                          <button
                            style={{ ...officeStyles.smallBtn, ...(o.processed ? {} : officeStyles.markDoneBtn) }}
                            onClick={() => setProcessed(o.id, !o.processed)}
                            disabled={processingId === o.id}
                            title={o.processed ? 'Mark as not yet processed' : 'Mark as entered into QuickBooks'}
                          >
                            {processingId === o.id ? '…' : (o.processed ? 'Undo' : 'Mark done')}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td style={officeStyles.detailCell} colSpan={9}>
                        {o.notes && (
                          <div style={officeStyles.orderNotes}>
                            <span style={officeStyles.orderNotesLabel}>Notes:</span> {o.notes}
                          </div>
                        )}
                        <table style={officeStyles.subTable}>
                          <thead>
                            <tr>
                              <th style={officeStyles.subTh}>Item #</th>
                              <th style={officeStyles.subTh}>Item</th>
                              <th style={officeStyles.subTh}>Brand</th>
                              <th style={{ ...officeStyles.subTh, textAlign: 'right' }}>Pack</th>
                              <th style={{ ...officeStyles.subTh, textAlign: 'right' }}>Cases ordered</th>
                              <th style={{ ...officeStyles.subTh, textAlign: 'right' }}>Price/ea</th>
                              <th style={{ ...officeStyles.subTh, textAlign: 'right' }}>Line total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {o.lines.map(l => (
                              <tr key={l.id}>
                                <td style={officeStyles.subTd}>{displayCode(l.id)}</td>
                                <td style={officeStyles.subTd}>{l.name}</td>
                                <td style={officeStyles.subTd}>{l.brand}</td>
                                <td style={{ ...officeStyles.subTd, textAlign: 'right' }}>{l.pack || 1}</td>
                                <td style={{ ...officeStyles.subTd, textAlign: 'right' }}>{l.qty}</td>
                                <td style={{ ...officeStyles.subTd, textAlign: 'right' }}>{formatMoney(l.price)}</td>
                                <td style={{ ...officeStyles.subTd, textAlign: 'right' }}>{formatMoney(lineTotal(l, l.qty))}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {editingOrder && (
        <OrderEditModal
          order={editingOrder}
          items={items}
          customers={customers}
          orders={orders}
          printSequence={printSequence}
          onClose={() => setEditingOrder(null)}
          onSaved={async () => { setEditingOrder(null); await onRefresh(); }}
        />
      )}
    </div>
  );
}

function SortableTh({ field, label, sortField, sortDir, onClick, align = 'left' }) {
  const active = sortField === field;
  return (
    <th
      style={{ ...officeStyles.th, textAlign: align, cursor: 'pointer', userSelect: 'none', color: active ? '#14181F' : undefined }}
      onClick={() => onClick(field)}
      title={`Sort by ${label}`}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexDirection: align === 'right' ? 'row-reverse' : 'row' }}>
        {label}
        {active && <span style={{ fontSize: 10 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
      </span>
    </th>
  );
}

function OfficeInventory({ items, customers = [], orders, brandColors, brandSettings = {}, printSequence, onRefresh, mode = 'items' }) {
  // Two views share this component:
  //  - 'inventory': stock-focused, read-only item details (just view/adjust stock)
  //  - 'items': the full editable catalog (edit names/prices/UPCs/photos, imports)
  const isItems = mode === 'items';
  const [query, setQuery] = useState('');
  const [brand, setBrand] = useState('All');
  const [showInactive, setShowInactive] = useState(false);
  const [renamingBrand, setRenamingBrand] = useState(false);
  const [brandNameInput, setBrandNameInput] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [uploadingOrder, setUploadingOrder] = useState(false);
  const [printOrderResult, setPrintOrderResult] = useState(null);
  const [uploadingUpc, setUploadingUpc] = useState(false);
  const [upcResult, setUpcResult] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [editField, setEditField] = useState('all');
  const [sortField, setSortField] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [openItemId, setOpenItemId] = useState(null); // item whose order history is expanded
  const [editingOrder, setEditingOrder] = useState(null); // order opened for editing from history
  const [viewingOrder, setViewingOrder] = useState(null); // order opened read-only from history
  // Stock changes are held here while editing and committed together on "Done
  // editing" (after a confirmation), so nothing changes by accident.
  const [pendingStock, setPendingStock] = useState({}); // { itemId: newValue }
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [savingStock, setSavingStock] = useState(false);

  function setPending(itemId, value) {
    setPendingStock(prev => {
      const next = { ...prev };
      next[itemId] = value;
      return next;
    });
  }

  // Only the entries that actually differ from the item's current stock.
  function realStockChanges() {
    const changes = [];
    for (const [id, val] of Object.entries(pendingStock)) {
      const item = items.find(i => i.id === id);
      if (!item) continue;
      const num = Number(val);
      if (val === '' || Number.isNaN(num) || num < 0) continue;
      if (num !== item.stock) changes.push({ id, name: item.name, from: item.stock, to: num });
    }
    return changes;
  }

  function handleToggleEdit() {
    if (editMode) {
      // Leaving edit mode — if there are pending stock changes, confirm them.
      if (realStockChanges().length > 0) { setConfirmOpen(true); return; }
      setPendingStock({});
      setEditMode(false);
    } else {
      setPendingStock({});
      setEditMode(true);
    }
  }

  async function commitStockChanges() {
    const changes = realStockChanges();
    setSavingStock(true);
    try {
      for (const ch of changes) {
        await apiPatch(`/items/${encodeURIComponent(ch.id)}`, { stock: ch.to });
      }
      await onRefresh();
      setPendingStock({});
      setConfirmOpen(false);
      setEditMode(false);
    } catch (err) {
      // leave the dialog open so they can retry
    } finally {
      setSavingStock(false);
    }
  }
  const fileInputRef = useRef(null);
  const printOrderInputRef = useRef(null);
  const upcInputRef = useRef(null);

  const brandList = useMemo(() => Array.from(new Set(items.map(i => i.brand))).sort(), [items]);
  const popularity = useMemo(() => computePopularity(orders), [orders]);

  // Build the list of orders that include a given item, newest first, with the
  // quantity (cases + eaches) and status for each — used by the expandable
  // per-item order history on the Inventory page to help confirm stock.
  function orderHistoryFor(itemId) {
    const rows = [];
    for (const o of orders) {
      const line = (o.lines || []).find(l => l.id === itemId);
      if (!line) continue;
      const cases = Number(line.qty) || 0;
      const pack = Number(line.pack) || 1;
      rows.push({
        orderId: o.id,
        customer: o.customer,
        deliveryDate: o.deliveryDate,
        submittedAt: o.submittedAt,
        cases,
        eaches: cases * pack,
        status: o.status,
        processed: o.processed,
      });
    }
    rows.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    const submitted = rows.filter(r => r.status !== 'pending');
    const consumedEaches = submitted.reduce((s, r) => s + r.eaches, 0);
    const consumedCases = submitted.reduce((s, r) => s + r.cases, 0);
    const pendingEaches = rows.filter(r => r.status === 'pending').reduce((s, r) => s + r.eaches, 0);
    return { rows, consumedEaches, consumedCases, pendingEaches };
  }
  // Active items only, for the edit modal's brand grid / item cards.
  const activeItemsForEdit = useMemo(() => items.filter(i => i.active), [items]);
  const orderById = id => orders.find(o => o.id === id) || null;

  function handleSortClick(field) {
    if (field === sortField) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = items.filter(i => {
      if (!showInactive && !i.active) return false;
      const brandMatch = brand === 'All' || i.brand === brand;
      const queryMatch = !q || i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q);
      return brandMatch && queryMatch;
    });
    return sortInventoryItems(matches, sortField, sortDir, popularity);
  }, [items, query, brand, showInactive, sortField, sortDir, popularity]);

  const brandAllActive = brand !== 'All' && items.filter(i => i.brand === brand).every(i => !!i.active);

  async function toggleBrand() {
    if (brand === 'All') return;
    try {
      await apiPatch(`/items/brand/${encodeURIComponent(brand)}`, { active: !brandAllActive });
      await onRefresh();
    } catch (err) { /* no-op, row-level state stays in sync on next refresh */ }
  }

  function startRenameBrand() {
    setBrandNameInput(brand);
    setRenamingBrand(true);
  }

  async function saveRenameBrand() {
    const newName = brandNameInput.trim();
    if (!newName || newName === brand) { setRenamingBrand(false); return; }
    try {
      await apiPatch(`/items/brand/${encodeURIComponent(brand)}`, { rename: newName });
      await onRefresh();
      setBrand(newName);
    } catch (err) { /* keep old brand selected on failure */ }
    setRenamingBrand(false);
  }

  async function saveBrandColor(color) {
    if (brand === 'All') return;
    try {
      await apiPut(`/brand-colors/${encodeURIComponent(brand)}`, { color });
      await onRefresh();
    } catch (err) { /* leave current color on failure */ }
  }

  async function saveBrandAbbrev(abbreviation) {
    if (brand === 'All') return;
    try {
      await apiPut(`/brand-settings/${encodeURIComponent(brand)}`, { abbreviation });
      await onRefresh();
    } catch (err) { /* leave current value on failure */ }
  }

  function exportCSV() {
    const headers = ['SKU', 'Item', 'Brand', 'Pack', 'Price', 'Stock', 'Active'];
    const rows = filtered.map(i => ({
      SKU: i.id, Item: i.name, Brand: i.brand, Pack: i.pack || 1,
      Price: i.price, Stock: i.stock, Active: i.active ? 'yes' : 'no',
    }));
    const name = brand === 'All' ? 'inventory' : brand.replace(/[^a-z0-9]+/gi, '_');
    downloadTextFile(`${name}-${new Date().toISOString().slice(0, 10)}.csv`, toCSV(rows, headers));
  }

  function triggerImport() {
    fileInputRef.current?.click();
  }

  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so re-selecting the same file re-triggers onChange
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      const text = await file.text();
      const rows = parseCSV(text);
      const skuKey = Object.keys(rows[0] || {}).find(k => k.toLowerCase() === 'sku') || 'SKU';
      const stockKey = Object.keys(rows[0] || {}).find(k => k.toLowerCase() === 'stock');
      const priceKey = Object.keys(rows[0] || {}).find(k => k.toLowerCase() === 'price');
      const updates = rows
        .map(r => ({ id: r[skuKey], stock: stockKey ? r[stockKey] : undefined, price: priceKey ? r[priceKey] : undefined }))
        .filter(u => u.id);
      const result = await apiPost('/items/bulk-update', { updates });
      setImportResult(result);
      await onRefresh();
    } catch (err) {
      setImportResult({ error: err.message || 'Import failed' });
    } finally {
      setImporting(false);
    }
  }

  function triggerPrintOrderUpload() {
    printOrderInputRef.current?.click();
  }

  function triggerUpcUpload() {
    upcInputRef.current?.click();
  }

  async function handleUpcFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingUpc(true);
    setUpcResult(null);
    try {
      const { updates, unmatched, matched } = await parseUpcFile(file, items);
      if (updates.length === 0) {
        setUpcResult({ error: 'No item codes in that file matched any product. Check the SKU column matches your item codes, and that there is a "UPC" column.' });
        return;
      }
      const result = await apiPost('/items/bulk-upc', { updates });
      setUpcResult({ updated: result.updated, matched, notFound: result.notFound, unmatched, unmatchedCount: unmatched.length });
      await onRefresh();
    } catch (err) {
      setUpcResult({ error: err.message || 'Upload failed' });
    } finally {
      setUploadingUpc(false);
    }
  }

  async function handlePrintOrderFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingOrder(true);
    setPrintOrderResult(null);
    try {
      const { orderedSkus, unmatched, matchedCodes } = await parsePrintOrderFile(file, items);
      if (orderedSkus.length === 0) {
        setPrintOrderResult({ error: 'No item codes in that file matched any product. Check that the item-code column is labeled (e.g. "Item #") and the codes match your SKUs.' });
        return;
      }
      const result = await apiPut('/print-order', { skus: orderedSkus });
      setPrintOrderResult({ saved: result.saved, matchedCodes, unmatched, unmatchedCount: unmatched.length });
      await onRefresh();
    } catch (err) {
      setPrintOrderResult({ error: err.message || 'Upload failed' });
    } finally {
      setUploadingOrder(false);
    }
  }

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        style={{ display: 'none' }}
        onChange={handleImportFile}
      />
      <input
        ref={printOrderInputRef}
        type="file"
        accept=".xlsx,.xls"
        style={{ display: 'none' }}
        onChange={handlePrintOrderFile}
      />
      <input
        ref={upcInputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        style={{ display: 'none' }}
        onChange={handleUpcFile}
      />
      <div style={officeStyles.sectionHeader}>
        <div style={officeStyles.sectionTitle}>{isItems ? 'Items' : 'Inventory'}</div>
        <input
          style={officeStyles.search}
          placeholder="Search item or SKU…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        {!renamingBrand && (
          <select style={officeStyles.select} value={brand} onChange={e => setBrand(e.target.value)}>
            <option value="All">All brands</option>
            {brandList.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        )}
        {renamingBrand && (
          <>
            <input
              style={officeStyles.search}
              value={brandNameInput}
              onChange={e => setBrandNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveRenameBrand(); if (e.key === 'Escape') setRenamingBrand(false); }}
              autoFocus
            />
            <button style={officeStyles.smallBtn} onClick={saveRenameBrand}>Save</button>
            <button style={officeStyles.smallBtn} onClick={() => setRenamingBrand(false)}>Cancel</button>
          </>
        )}
        {isItems && brand !== 'All' && !renamingBrand && (
          <>
            <button style={officeStyles.smallBtn} onClick={toggleBrand}>
              {brandAllActive ? 'Deactivate brand' : 'Activate brand'}
            </button>
            <button style={officeStyles.smallBtn} onClick={startRenameBrand}>Rename brand</button>
            {editMode && (
              <>
                <label style={officeStyles.colorPickerLabel} title="Set this brand's tile color on the New Order page">
                  <span style={{ ...officeStyles.colorSwatch, background: brandColor(brand, brandList.indexOf(brand), brandColors) }} />
                  Color
                  <input
                    type="color"
                    value={brandColors[brand] || brandColor(brand, brandList.indexOf(brand), brandColors)}
                    onChange={e => saveBrandColor(e.target.value)}
                    style={officeStyles.colorInput}
                  />
                </label>
                {brandColors[brand] && (
                  <button style={officeStyles.smallBtn} onClick={() => saveBrandColor('')} title="Reset to the default auto color">
                    Reset color
                  </button>
                )}
                <BrandAbbrevField
                  brand={brand}
                  value={(brandSettings[brand] && brandSettings[brand].abbreviation) || ''}
                  onSave={saveBrandAbbrev}
                />
              </>
            )}
          </>
        )}
        {!isItems && (
          <button style={officeStyles.smallBtn} onClick={exportCSV} title="Download the items currently shown as a CSV">
            Export CSV
          </button>
        )}
        {!isItems && (
          <button style={officeStyles.smallBtn} onClick={triggerImport} disabled={importing} title="Upload a CSV to bulk-update stock and/or price">
            {importing ? 'Importing…' : 'Import CSV'}
          </button>
        )}
        {isItems && editMode && (
          <button style={officeStyles.smallBtn} onClick={triggerPrintOrderUpload} disabled={uploadingOrder} title="Upload an .xlsx to set the order items print in. Needs a column headed 'Item #' (or 'SKU'/'Code').">
            {uploadingOrder ? 'Uploading…' : 'Upload print order'}
          </button>
        )}
        {isItems && editMode && (
          <button style={officeStyles.smallBtn} onClick={triggerUpcUpload} disabled={uploadingUpc} title="Upload a spreadsheet with an item-code column ('Item #'/'SKU'/'Code') and a 'UPC' column to set UPCs in bulk.">
            {uploadingUpc ? 'Uploading…' : 'Import UPCs'}
          </button>
        )}
        <label style={officeStyles.checkboxLabel}>
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
        <button
          style={{ ...officeStyles.smallBtn, ...(editMode ? officeStyles.editModeBtnActive : {}) }}
          onClick={handleToggleEdit}
          title={isItems ? 'Turn on to edit item details' : 'Turn on to adjust stock counts'}
        >
          {editMode ? 'Done editing' : 'Edit'}
        </button>
        {isItems && editMode && (
          <select style={officeStyles.select} value={editField} onChange={e => setEditField(e.target.value)}>
            <option value="all">Edit: All fields</option>
            <option value="name">Edit: Item name</option>
            <option value="brand">Edit: Brand</option>
            <option value="pack">Edit: Pack</option>
            <option value="price">Edit: Price</option>
            <option value="stock">Edit: Stock</option>
            <option value="active">Edit: Active</option>
            <option value="upc">Edit: UPC</option>
            <option value="photo">Edit: Photo</option>
          </select>
        )}
        <div style={officeStyles.countPill}>{filtered.length} item{filtered.length === 1 ? '' : 's'}</div>
      </div>

      {importResult && (
        <div style={importResult.error ? officeStyles.importBannerError : officeStyles.importBanner}>
          {importResult.error
            ? `Import failed: ${importResult.error}`
            : `Updated ${importResult.updated} of ${importResult.totalRows} rows.` +
              (importResult.notFound.length > 0
                ? ` ${importResult.notFound.length} SKU${importResult.notFound.length === 1 ? '' : 's'} not found: ${importResult.notFound.slice(0, 8).join(', ')}${importResult.notFound.length > 8 ? '…' : ''}`
                : '')}
          <button style={officeStyles.dismissBtn} onClick={() => setImportResult(null)}>×</button>
        </div>
      )}

      {printOrderResult && (
        <div style={printOrderResult.error ? officeStyles.importBannerError : officeStyles.importBanner}>
          {printOrderResult.error
            ? `Print order upload failed: ${printOrderResult.error}`
            : `Print order saved — ${printOrderResult.saved} item${printOrderResult.saved === 1 ? '' : 's'} sequenced from ${printOrderResult.matchedCodes} matched code${printOrderResult.matchedCodes === 1 ? '' : 's'}.` +
              (printOrderResult.unmatchedCount > 0
                ? ` ${printOrderResult.unmatchedCount} code${printOrderResult.unmatchedCount === 1 ? '' : 's'} didn't match and were skipped: ${printOrderResult.unmatched.slice(0, 12).join(', ')}${printOrderResult.unmatchedCount > 12 ? '…' : ''}`
                : ' Every code matched.')}
          <button style={officeStyles.dismissBtn} onClick={() => setPrintOrderResult(null)}>×</button>
        </div>
      )}

      {upcResult && (
        <div style={upcResult.error ? officeStyles.importBannerError : officeStyles.importBanner}>
          {upcResult.error
            ? `UPC import failed: ${upcResult.error}`
            : `UPCs set for ${upcResult.updated} item${upcResult.updated === 1 ? '' : 's'}.` +
              (upcResult.unmatchedCount > 0
                ? ` ${upcResult.unmatchedCount} code${upcResult.unmatchedCount === 1 ? '' : 's'} didn't match a product and were skipped: ${upcResult.unmatched.slice(0, 12).join(', ')}${upcResult.unmatchedCount > 12 ? '…' : ''}`
                : ' Every code matched.')}
          <button style={officeStyles.dismissBtn} onClick={() => setUpcResult(null)}>×</button>
        </div>
      )}

      <div style={officeStyles.tableCard}>
        <table style={officeStyles.table}>
          <thead>
            <tr>
              <th style={{ ...officeStyles.th, width: 56 }}></th>
              <SortableTh field="id" label="Item #" sortField={sortField} sortDir={sortDir} onClick={handleSortClick} />
              <SortableTh field="name" label="Item" sortField={sortField} sortDir={sortDir} onClick={handleSortClick} />
              <SortableTh field="brand" label="Brand" sortField={sortField} sortDir={sortDir} onClick={handleSortClick} />
              {isItems && <SortableTh field="upc" label="UPC" sortField={sortField} sortDir={sortDir} onClick={handleSortClick} />}
              {isItems && <SortableTh field="pack" label="Pack" sortField={sortField} sortDir={sortDir} onClick={handleSortClick} align="right" />}
              {isItems && <SortableTh field="price" label="Price/ea" sortField={sortField} sortDir={sortDir} onClick={handleSortClick} align="right" />}
              {isItems && <SortableTh field="casePrice" label="Case price" sortField={sortField} sortDir={sortDir} onClick={handleSortClick} align="right" />}
              <SortableTh field="stock" label="Stock" sortField={sortField} sortDir={sortDir} onClick={handleSortClick} align="right" />
              <SortableTh field="active" label="Active" sortField={sortField} sortDir={sortDir} onClick={handleSortClick} align="center" />
              {isItems && editMode && (editField === 'all' || editField === 'photo') && (
                <th style={{ ...officeStyles.th, textAlign: 'center' }}>Photo</th>
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td style={officeStyles.emptyCell} colSpan={isItems ? (editMode && (editField === 'all' || editField === 'photo') ? 11 : 10) : 6}>No items match "{query}"</td></tr>
            )}
            {filtered.map(item => {
              const canEdit = f => editMode && (editField === 'all' || editField === f);
              const isOpen = openItemId === item.id;
              const toggleHistory = () => setOpenItemId(isOpen ? null : item.id);
              return (
              <React.Fragment key={item.id}>
              <tr style={!item.active ? officeStyles.rowInactive : undefined}>
                <td style={{ ...officeStyles.td, width: 56, cursor: 'pointer' }} onClick={toggleHistory}>
                  {item.imageUrl
                    ? <img src={item.imageUrl} alt="" style={officeStyles.invThumb} loading="lazy" />
                    : <div style={officeStyles.invThumbPlaceholder}><ImageIcon size={16} color="#C7CBC1" /></div>}
                </td>
                <td style={{ ...officeStyles.td, cursor: 'pointer' }} onClick={toggleHistory}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <ChevronRight size={13} color="#8A8F87" style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
                    {displayCode(item.id)}
                  </span>
                </td>
                <td style={{ ...officeStyles.td, cursor: (isItems && canEdit('name')) ? 'default' : 'pointer' }} onClick={(isItems && canEdit('name')) ? undefined : toggleHistory}>
                  {(isItems && canEdit('name')) ? <TextFieldEditor item={item} field="name" onSaved={onRefresh} /> : item.name}
                </td>
                <td style={officeStyles.td}>
                  {(isItems && canEdit('brand')) ? <TextFieldEditor item={item} field="brand" onSaved={onRefresh} /> : item.brand}
                </td>
                {isItems && (
                <td style={officeStyles.td}>
                  {canEdit('upc') ? <TextFieldEditor item={item} field="upc" onSaved={onRefresh} placeholder="UPC(s), comma-separated" /> : (item.upc || <span style={{ color: '#B9BDB2' }}>—</span>)}
                </td>
                )}
                {isItems && (
                <td style={{ ...officeStyles.td, textAlign: 'right' }}>
                  {canEdit('pack') ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                      <NumberFieldEditor item={item} field="pack" onSaved={onRefresh} min={1} width={56} />
                      <TextFieldEditor item={item} field="packLabel" onSaved={onRefresh} placeholder="add label" small />
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                      <span>{item.pack || 1}</span>
                      {item.packLabel && <span style={{ fontSize: 10.5, color: '#8A8F87' }}>{item.packLabel}</span>}
                    </div>
                  )}
                </td>
                )}
                {isItems && (
                <td style={{ ...officeStyles.td, textAlign: 'right' }}>
                  {canEdit('price') ? (
                    <NumberFieldEditor item={item} field="price" onSaved={onRefresh} min={0} step={0.01} prefix="$" width={64} />
                  ) : formatMoney(item.price)}
                </td>
                )}
                {isItems && <td style={{ ...officeStyles.td, textAlign: 'right' }}>{formatMoney(casePrice(item))}</td>}
                <td style={{ ...officeStyles.td, textAlign: 'right' }}>
                  {canEdit('stock') ? (
                    <StockEditor
                      item={item}
                      pendingValue={pendingStock[item.id]}
                      onPendingChange={v => setPending(item.id, v)}
                    />
                  ) : (
                    <span style={item.stock <= 5 ? { color: '#B5493B', fontWeight: 700 } : undefined}>{item.stock}</span>
                  )}
                </td>
                <td style={{ ...officeStyles.td, textAlign: 'center' }}>
                  {(isItems && canEdit('active')) ? (
                    <ActiveToggle
                      active={!!item.active}
                      onToggle={async next => { await apiPatch(`/items/${encodeURIComponent(item.id)}`, { active: next }); await onRefresh(); }}
                    />
                  ) : (
                    <span style={{ ...officeStyles.toggleBtn, ...(item.active ? officeStyles.toggleBtnOn : officeStyles.toggleBtnOff), cursor: 'default' }}>
                      {item.active ? 'Active' : 'Inactive'}
                    </span>
                  )}
                </td>
                {isItems && editMode && (editField === 'all' || editField === 'photo') && (
                  <td style={{ ...officeStyles.td, textAlign: 'center' }}>
                    <PhotoEditor item={item} onSaved={onRefresh} />
                  </td>
                )}
              </tr>
              {isOpen && (() => {
                const hist = orderHistoryFor(item.id);
                const colSpan = isItems ? (editMode && (editField === 'all' || editField === 'photo') ? 11 : 10) : 6;
                return (
                  <tr>
                    <td colSpan={colSpan} style={officeStyles.itemHistoryCell}>
                      {hist.rows.length === 0 ? (
                        <div style={officeStyles.itemHistoryEmpty}>This item hasn't been on any orders yet.</div>
                      ) : (
                        <div style={officeStyles.itemHistoryWrap}>
                          <div style={officeStyles.itemHistorySummary}>
                            <span><strong>{hist.consumedEaches}</strong> eaches ({hist.consumedCases} cs) out on submitted orders</span>
                            {hist.pendingEaches > 0 && <span style={{ color: '#8A6D1B' }}>· {hist.pendingEaches} eaches pending</span>}
                            <span style={{ color: '#8A8F87' }}>· in stock now: {item.stock}</span>
                          </div>
                          <table style={officeStyles.itemHistoryTable}>
                            <thead>
                              <tr>
                                <th style={officeStyles.itemHistoryTh}>Order</th>
                                <th style={officeStyles.itemHistoryTh}>Delivery</th>
                                <th style={officeStyles.itemHistoryTh}>Customer</th>
                                <th style={{ ...officeStyles.itemHistoryTh, textAlign: 'right' }}>Cases</th>
                                <th style={{ ...officeStyles.itemHistoryTh, textAlign: 'right' }}>Eaches</th>
                                <th style={officeStyles.itemHistoryTh}>Status</th>
                                <th style={{ ...officeStyles.itemHistoryTh, textAlign: 'right' }}></th>
                              </tr>
                            </thead>
                            <tbody>
                              {hist.rows.map(r => (
                                <tr key={r.orderId}>
                                  <td style={officeStyles.itemHistoryTd}>#{r.orderId}</td>
                                  <td style={officeStyles.itemHistoryTd}>{formatDate(r.deliveryDate)}</td>
                                  <td style={officeStyles.itemHistoryTd}>{r.customer}</td>
                                  <td style={{ ...officeStyles.itemHistoryTd, textAlign: 'right' }}>{r.cases}</td>
                                  <td style={{ ...officeStyles.itemHistoryTd, textAlign: 'right' }}>{r.eaches}</td>
                                  <td style={officeStyles.itemHistoryTd}>
                                    {r.status === 'pending'
                                      ? <span style={officeStyles.badgePending}>Pending</span>
                                      : r.processed
                                        ? <span style={officeStyles.badgeProcessed}>Processed</span>
                                        : <span style={officeStyles.badgeUnprocessed}>New</span>}
                                  </td>
                                  <td style={{ ...officeStyles.itemHistoryTd, textAlign: 'right', whiteSpace: 'nowrap' }}>
                                    <button style={officeStyles.historyLinkBtn} onClick={() => { const o = orderById(r.orderId); if (o) setViewingOrder(o); }}>View</button>
                                    {' '}
                                    <button style={officeStyles.historyLinkBtn} onClick={() => { const o = orderById(r.orderId); if (o) setEditingOrder(o); }}>Edit</button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })()}
              </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {editingOrder && (
        <OrderEditModal
          order={editingOrder}
          items={activeItemsForEdit}
          customers={customers}
          orders={orders}
          brandColors={brandColors}
          printSequence={printSequence}
          onClose={() => setEditingOrder(null)}
          onSaved={async () => { setEditingOrder(null); await onRefresh(); }}
        />
      )}
      {viewingOrder && (
        <OrderViewModal
          order={viewingOrder}
          onClose={() => setViewingOrder(null)}
          onEdit={() => { setEditingOrder(viewingOrder); setViewingOrder(null); }}
        />
      )}
      {confirmOpen && (
        <div style={styles.editOverlay} onClick={() => !savingStock && setConfirmOpen(false)}>
          <div style={officeStyles.confirmCard} onClick={e => e.stopPropagation()}>
            <div style={officeStyles.confirmTitle}>Save stock changes?</div>
            <div style={officeStyles.confirmSub}>
              You changed stock for {realStockChanges().length} item{realStockChanges().length === 1 ? '' : 's'}:
            </div>
            <div style={officeStyles.confirmList}>
              {realStockChanges().map(ch => (
                <div key={ch.id} style={officeStyles.confirmRow}>
                  <span style={officeStyles.confirmItem}>{ch.name}</span>
                  <span style={officeStyles.confirmDelta}>{ch.from} → <strong>{ch.to}</strong></span>
                </div>
              ))}
            </div>
            <div style={officeStyles.confirmActions}>
              <button
                style={officeStyles.confirmCancel}
                onClick={() => { setConfirmOpen(false); }}
                disabled={savingStock}
              >
                Keep editing
              </button>
              <button
                style={officeStyles.confirmSave}
                onClick={commitStockChanges}
                disabled={savingStock}
              >
                {savingStock ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TextFieldEditor({ item, field, onSaved, placeholder, small }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(item[field] || '');
  const [saving, setSaving] = useState(false);
  const original = item[field] || '';

  async function save() {
    const trimmed = value.trim();
    if (trimmed === original) { setEditing(false); return; }
    if (!trimmed && field !== 'packLabel' && field !== 'upc') { setValue(original); setEditing(false); return; }
    setSaving(true);
    try {
      await apiPatch(`/items/${encodeURIComponent(item.id)}`, { [field]: trimmed });
      await onSaved();
    } catch (err) {
      setValue(original);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  if (!editing) {
    return (
      <button
        style={small ? officeStyles.packLabelEditBtn : officeStyles.nameEditBtn}
        onClick={() => { setValue(original); setEditing(true); }}
        title={`Click to edit ${field}`}
      >
        {original || <span style={{ color: '#B7BCB2' }}>{placeholder || 'add label'}</span>}
      </button>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <input
        style={small ? officeStyles.packLabelInput : officeStyles.nameInput}
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setValue(original); setEditing(false); } }}
        autoFocus
      />
      {saving && <Loader2 size={12} color="#8A8F87" style={{ animation: 'spin 0.8s linear infinite' }} />}
    </span>
  );
}

// Resize/compress an image File in the browser to a small thumbnail data URL.
// Keeps aspect ratio, longest side <= maxDim, JPEG quality ~0.82. Transparent
// PNGs get a white background so they don't turn black as JPEG.
function resizeImageFile(file, maxDim = 400) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not a readable image'));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
        else if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function PhotoEditor({ item, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showUrl, setShowUrl] = useState(false);
  const [urlValue, setUrlValue] = useState(item.imageUrl || '');
  const fileRef = useRef(null);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      const dataUrl = await resizeImageFile(file, 400);
      await apiPost(`/items/${encodeURIComponent(item.id)}/image`, { imageData: dataUrl, ext: 'jpg' });
      await onSaved();
    } catch (err) {
      setError(err.message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  async function saveUrl() {
    const trimmed = urlValue.trim();
    setBusy(true);
    setError('');
    try {
      await apiPatch(`/items/${encodeURIComponent(item.id)}`, { imageUrl: trimmed });
      await onSaved();
      setShowUrl(false);
    } catch (err) {
      setError(err.message || 'Could not save URL');
    } finally {
      setBusy(false);
    }
  }

  async function removeImage() {
    setBusy(true);
    setError('');
    try {
      await apiPatch(`/items/${encodeURIComponent(item.id)}`, { imageUrl: '' });
      await onSaved();
      setUrlValue('');
    } catch (err) {
      setError(err.message || 'Could not remove');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFile} />
      {item.imageUrl
        ? <img src={item.imageUrl} alt="" style={officeStyles.photoThumb} />
        : <div style={officeStyles.photoPlaceholder}>No photo</div>}
      {busy ? (
        <Loader2 size={14} color="#8A8F87" style={{ animation: 'spin 0.8s linear infinite' }} />
      ) : (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button style={officeStyles.photoBtn} onClick={() => fileRef.current?.click()} title="Upload a photo file (or take one on mobile)">Upload</button>
          <button style={officeStyles.photoBtn} onClick={() => { setUrlValue(item.imageUrl || ''); setShowUrl(v => !v); }} title="Paste an image URL">URL</button>
          {item.imageUrl && <button style={officeStyles.photoBtn} onClick={removeImage} title="Remove the photo">Remove</button>}
        </div>
      )}
      {showUrl && !busy && (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input
            style={officeStyles.photoUrlInput}
            value={urlValue}
            onChange={e => setUrlValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') saveUrl(); if (e.key === 'Escape') setShowUrl(false); }}
            placeholder="https://…"
            autoFocus
          />
          <button style={officeStyles.photoBtn} onClick={saveUrl}>Save</button>
        </div>
      )}
      {error && <span style={{ fontSize: 10, color: '#B5493B', maxWidth: 120, textAlign: 'center' }}>{error}</span>}
    </div>
  );
}

function NumberFieldEditor({ item, field, onSaved, min = 0, step = 1, prefix = '', width = 70 }) {
  const original = Number(item[field]) || 0;
  const [value, setValue] = useState(String(original));
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [focused, setFocused] = useState(false);

  // Resync displayed value when the item changes from outside this editor
  // (e.g. a CSV bulk import, or someone else's edit landing via refresh) —
  // but never while the user is actively focused/typing in this field.
  useEffect(() => {
    if (!focused) setValue(String(original));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original]);

  async function save() {
    const num = Number(value);
    if (Number.isNaN(num) || num < min) { setValue(String(original)); return; }
    if (num === original) return;
    setSaving(true);
    try {
      await apiPatch(`/items/${encodeURIComponent(item.id)}`, { [field]: num });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1200);
      await onSaved();
    } catch (err) {
      setValue(String(original));
    } finally {
      setSaving(false);
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {prefix && <span style={{ fontSize: 12.5, color: '#8A8F87' }}>{prefix}</span>}
      <input
        style={{ ...officeStyles.stockInput, width }}
        value={value}
        onChange={e => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); save(); }}
        onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
        inputMode="decimal"
      />
      {saving && <Loader2 size={13} color="#8A8F87" style={{ animation: 'spin 0.8s linear infinite' }} />}
      {!saving && savedFlash && <Check size={14} color="#2B5D50" />}
    </span>
  );
}

function ActiveToggle({ active, onToggle }) {
  const [busy, setBusy] = useState(false);
  async function handleClick() {
    setBusy(true);
    try { await onToggle(!active); } finally { setBusy(false); }
  }
  return (
    <button
      style={{ ...officeStyles.toggleBtn, ...(active ? officeStyles.toggleBtnOn : officeStyles.toggleBtnOff) }}
      onClick={handleClick}
      disabled={busy}
    >
      {busy ? '…' : active ? 'Active' : 'Inactive'}
    </button>
  );
}

function StockEditor({ item, pendingValue, onPendingChange }) {
  // In edit mode the value is held in the parent's pending map and only saved
  // when the user confirms on "Done editing" — so nothing changes by accident.
  const [focused, setFocused] = useState(false);
  const value = pendingValue !== undefined ? pendingValue : String(item.stock);
  const dirty = value !== '' && Number(value) !== item.stock;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <input
        style={{ ...officeStyles.stockInput, ...(item.stock <= 5 ? officeStyles.stockInputLow : {}), ...(dirty ? officeStyles.stockInputDirty : {}) }}
        value={value}
        onChange={e => onPendingChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
        inputMode="numeric"
      />
      {dirty && <span style={officeStyles.unsavedDot} title="Unsaved — confirm on Done editing" />}
    </span>
  );
}

function CustomerNameField({ customer, editMode, onRefresh }) {
  const [value, setValue] = useState(customer.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setValue(customer.name); }, [customer.name]);

  if (!editMode) return <span>{customer.name}</span>;

  async function save() {
    const trimmed = value.trim();
    if (!trimmed) { setValue(customer.name); setError(''); return; }
    if (trimmed === customer.name) { setError(''); return; }
    setSaving(true);
    setError('');
    try {
      await apiPatch(`/customers/${customer.id}`, { name: trimmed });
      await onRefresh();
    } catch (err) {
      setError(err.message || 'Could not rename');
      setValue(customer.name);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <input
        style={officeStyles.inlineInput}
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setValue(customer.name); e.currentTarget.blur(); } }}
        disabled={saving}
      />
      {saving && <span style={{ color: '#8A8F87', fontSize: 12 }}>saving…</span>}
      {error && <span style={{ color: '#B5493B', fontSize: 12, fontWeight: 600 }}>{error}</span>}
    </div>
  );
}

// Small inline editor for a brand's memo abbreviation (Items page, edit mode).
function BrandAbbrevField({ brand, value: initial, onSave }) {
  const [value, setValue] = useState(initial || '');
  useEffect(() => { setValue(initial || ''); }, [initial, brand]);
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#5B6058' }} title="Short code for this brand, used in the invoice memo when an order is only this brand">
      Memo abbrev.
      <input
        style={{ ...officeStyles.inlineInput, width: 90 }}
        value={value}
        placeholder="e.g. LOA"
        onChange={e => setValue(e.target.value)}
        onBlur={() => { if (value.trim() !== (initial || '')) onSave(value.trim()); }}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setValue(initial || ''); e.currentTarget.blur(); } }}
      />
    </label>
  );
}

// Small inline text editor for an optional customer field (abbreviation, short
// name). Saves on blur; empty clears the value. Used only in edit mode.
function CustomerTextField({ customer, field, value: initial, placeholder, width, onRefresh }) {
  const [value, setValue] = useState(initial || '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setValue(initial || ''); }, [initial]);

  async function save() {
    const trimmed = value.trim();
    if (trimmed === (initial || '')) return;
    setSaving(true);
    try {
      await apiPatch(`/customers/${customer.id}`, { [field]: trimmed });
      await onRefresh();
    } catch (err) {
      setValue(initial || '');
    } finally {
      setSaving(false);
    }
  }

  return (
    <input
      style={{ ...officeStyles.inlineInput, width: width || 120 }}
      value={value}
      placeholder={placeholder}
      onChange={e => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setValue(initial || ''); e.currentTarget.blur(); } }}
      disabled={saving}
    />
  );
}

function OfficeCustomers({ customers, onRefresh }) {
  const [query, setQuery] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [shipToOpenId, setShipToOpenId] = useState(null);
  const [shipToSeedMsg, setShipToSeedMsg] = useState('');
  const [seeding, setSeeding] = useState(false);

  async function handleReseedShipTo() {
    setSeeding(true);
    setShipToSeedMsg('');
    try {
      const r = await apiPost('/customers/reseed-shipto', {});
      await onRefresh();
      const unmatchedNote = r.unmatched && r.unmatched.length ? ` (${r.unmatched.length} not matched: ${r.unmatched.join(', ')})` : '';
      setShipToSeedMsg(`Loaded ship-to for ${r.matchedCount} store${r.matchedCount === 1 ? '' : 's'}${unmatchedNote}.`);
    } catch (err) {
      setShipToSeedMsg(err.message || 'Could not load ship-to addresses.');
    } finally {
      setSeeding(false);
    }
  }

  async function handleApplyAddresses() {
    setSeeding(true);
    setShipToSeedMsg('');
    try {
      const r = await apiPost('/customers/apply-addresses', {});
      await onRefresh();
      setShipToSeedMsg(`Applied QuickBooks bill-to & ship-to to ${r.matchedCount} customer${r.matchedCount === 1 ? '' : 's'}.`);
    } catch (err) {
      setShipToSeedMsg(err.message || 'Could not apply addresses.');
    } finally {
      setSeeding(false);
    }
  }
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return customers.filter(c => {
      if (!showInactive && !c.active) return false;
      return !q || c.name.toLowerCase().includes(q);
    });
  }, [customers, query, showInactive]);

  return (
    <div>
      <div style={officeStyles.sectionHeader}>
        <div style={officeStyles.sectionTitle}>Customers</div>
        <input
          style={officeStyles.search}
          placeholder="Search customers…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <button
          style={{ ...officeStyles.smallBtn, ...(editMode ? officeStyles.editModeBtnActive : {}) }}
          onClick={() => setEditMode(v => !v)}
          title="Turn on to rename customers and set their usual delivery day"
        >
          {editMode ? 'Done editing' : 'Edit'}
        </button>
        <label style={officeStyles.checkboxLabel}>
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
        <div style={officeStyles.countPill}>{filtered.length} customer{filtered.length === 1 ? '' : 's'}</div>
      </div>
      {editMode && (
        <div style={officeStyles.editHint}>Editing — click a name to rename it, set each customer's usual delivery day, and their abbreviation (used in the PO number, e.g. T2) and short name (used in the invoice memo, e.g. Kahala). Changes save automatically.</div>
      )}
      {editMode && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '0 0 12px', flexWrap: 'wrap' }}>
          <button style={officeStyles.smallBtn} onClick={handleReseedShipTo} disabled={seeding} title="Fill in the built-in store ship-to addresses for any matching customers that don't have one yet">
            {seeding ? 'Loading…' : 'Load store ship-to addresses'}
          </button>
          <button style={officeStyles.smallBtn} onClick={handleApplyAddresses} disabled={seeding} title="Apply the bill-to and ship-to addresses exported from QuickBooks to all matching customers (overwrites)">
            {seeding ? 'Applying…' : 'Apply QuickBooks addresses'}
          </button>
          {shipToSeedMsg && <span style={{ fontSize: 12.5, color: '#5B6058' }}>{shipToSeedMsg}</span>}
        </div>
      )}
      <div style={officeStyles.tableCard}>
        <table style={officeStyles.table}>
          <thead><tr>
            <th style={officeStyles.th}>Customer name</th>
            {editMode && <th style={officeStyles.th}>Usual delivery day</th>}
            {editMode && <th style={officeStyles.th}>Abbrev. (PO)</th>}
            {editMode && <th style={officeStyles.th}>Short name (memo)</th>}
            {editMode && <th style={officeStyles.th}>Ship-to</th>}
            <th style={{ ...officeStyles.th, textAlign: 'center' }}>Active</th>
          </tr></thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td style={officeStyles.emptyCell} colSpan={editMode ? 6 : 2}>No customers match "{query}"</td></tr>
            )}
            {filtered.map(c => {
              const shipOpen = shipToOpenId === c.id;
              const hasShipTo = !!(c.shipToLine1 || c.shipToLine2 || c.shipToCity);
              return (
              <React.Fragment key={c.id}>
              <tr style={!c.active ? officeStyles.rowInactive : undefined}>
                <td style={officeStyles.td}>
                  <CustomerNameField customer={c} editMode={editMode} onRefresh={onRefresh} />
                </td>
                {editMode && (
                  <td style={officeStyles.td}>
                    <select
                      className="daySelect"
                      value={c.deliveryDay === null || c.deliveryDay === undefined ? '' : String(c.deliveryDay)}
                      onChange={async e => {
                        const v = e.target.value === '' ? null : Number(e.target.value);
                        await apiPatch(`/customers/${c.id}`, { deliveryDay: v });
                        await onRefresh();
                      }}
                      title="Selecting this customer on a new order will auto-fill this day (still changeable)"
                    >
                      <option value="">No default</option>
                      {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
                    </select>
                  </td>
                )}
                {editMode && (
                  <td style={officeStyles.td}>
                    <CustomerTextField customer={c} field="abbreviation" value={c.abbreviation} placeholder="e.g. T2" width={90} onRefresh={onRefresh} />
                  </td>
                )}
                {editMode && (
                  <td style={officeStyles.td}>
                    <CustomerTextField customer={c} field="shortName" value={c.shortName} placeholder="e.g. Kahala" width={140} onRefresh={onRefresh} />
                  </td>
                )}
                {editMode && (
                  <td style={officeStyles.td}>
                    <button
                      style={{ ...officeStyles.smallBtn, ...(shipOpen ? officeStyles.editModeBtnActive : {}) }}
                      onClick={() => setShipToOpenId(shipOpen ? null : c.id)}
                    >
                      {hasShipTo ? 'Ship-to ✓' : 'Add ship-to'}
                    </button>
                  </td>
                )}
                <td style={{ ...officeStyles.td, textAlign: 'center' }}>
                  <ActiveToggle
                    active={!!c.active}
                    onToggle={async next => { await apiPatch(`/customers/${c.id}`, { active: next }); await onRefresh(); }}
                  />
                </td>
              </tr>
              {editMode && shipOpen && (
                <tr>
                  <td colSpan={6} style={officeStyles.shipToCell}>
                    <div style={officeStyles.shipToTitle}>Bill-to address (invoice) for {c.name}</div>
                    <div style={officeStyles.shipToGrid}>
                      <CustomerTextField customer={c} field="billToLine1" value={c.billToLine1} placeholder="Bill-to line 1 (company)" width={220} onRefresh={onRefresh} />
                      <CustomerTextField customer={c} field="billToLine2" value={c.billToLine2} placeholder="Bill-to line 2 (street)" width={220} onRefresh={onRefresh} />
                      <CustomerTextField customer={c} field="billToCity" value={c.billToCity} placeholder="City" width={140} onRefresh={onRefresh} />
                      <CustomerTextField customer={c} field="billToState" value={c.billToState} placeholder="State" width={70} onRefresh={onRefresh} />
                      <CustomerTextField customer={c} field="billToZip" value={c.billToZip} placeholder="Zip" width={90} onRefresh={onRefresh} />
                    </div>
                    <div style={{ ...officeStyles.shipToTitle, marginTop: 12 }}>Ship-to address for {c.name}</div>
                    <div style={officeStyles.shipToGrid}>
                      <CustomerTextField customer={c} field="shipToLine1" value={c.shipToLine1} placeholder="Line 1 (store name)" width={220} onRefresh={onRefresh} />
                      <CustomerTextField customer={c} field="shipToLine2" value={c.shipToLine2} placeholder="Line 2 (street)" width={220} onRefresh={onRefresh} />
                      <CustomerTextField customer={c} field="shipToCity" value={c.shipToCity} placeholder="City" width={140} onRefresh={onRefresh} />
                      <CustomerTextField customer={c} field="shipToState" value={c.shipToState} placeholder="State" width={70} onRefresh={onRefresh} />
                      <CustomerTextField customer={c} field="shipToZip" value={c.shipToZip} placeholder="Zip" width={90} onRefresh={onRefresh} />
                      <CustomerTextField customer={c} field="shipToPhone" value={c.shipToPhone} placeholder="Phone" width={150} onRefresh={onRefresh} />
                    </div>
                  </td>
                </tr>
              )}
              </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const fontImport = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap');
  @keyframes spin { to { transform: rotate(360deg); } }
  .has-back > div > div:first-child > div:first-child { padding-left: 42px; }
  select.daySelect {
    appearance: none; -webkit-appearance: none; -moz-appearance: none;
    background: #F7F8F4 url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238A8F87' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>") no-repeat right 12px center;
    border: 1px solid #D6D3C6; border-radius: 8px; padding: 7px 32px 7px 12px;
    font-size: 13px; font-weight: 600; color: #14181F; font-family: inherit;
    outline: none; cursor: pointer; min-width: 150px;
  }
  select.daySelect:hover { border-color: #B9B6A8; background-color: #FFFFFF; }
  select.daySelect:focus { border-color: #2B5D50; box-shadow: 0 0 0 2px rgba(43,93,80,0.12); }
`;

const styles = {
  app: {
    fontFamily: "'Inter', system-ui, sans-serif",
    background: '#F7F8F4',
    height: '100dvh',
    maxHeight: 900,
    width: '100%',
    maxWidth: 480,
    margin: '0 auto',
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    borderRadius: 20,
    overflow: 'hidden',
    boxShadow: '0 1px 3px rgba(20,24,31,0.08)',
  },
  appDesktop: {
    fontFamily: "'Inter', system-ui, sans-serif",
    background: '#F7F8F4',
    width: '100%',
    maxWidth: 1280,
    height: '100vh',
    overflow: 'hidden',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
  },
  centerState: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 },
  centerStateText: { fontSize: 13, color: '#5B6058', fontWeight: 600 },
  retryBtn: { marginTop: 6, background: '#2B5D50', color: '#F7F8F4', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  tabContent: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
  editOverlay: { position: 'fixed', inset: 0, background: 'rgba(20,24,31,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 20 },
  editModalWrap: { width: '100%', maxWidth: 1100, height: '92vh', maxHeight: 900, background: '#F7F8F4', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(20,24,31,0.4)' },
  editOverlayMobile: { position: 'fixed', inset: 0, background: '#F7F8F4', zIndex: 60 },
  editModalWrapMobile: { width: '100%', height: '100%', background: '#F7F8F4', overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  backArrow: { position: 'absolute', top: 16, left: 12, zIndex: 40, width: 30, height: 30, borderRadius: 15, background: 'rgba(255,255,255,0.14)', border: '1px solid rgba(255,255,255,0.22)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 },
  screenWrap: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' },
  tabBar: { display: 'flex', borderTop: '1px solid #E3E1D6', background: '#FFFFFF', padding: '10px 0 calc(12px + env(safe-area-inset-bottom, 0px))', flexShrink: 0, position: 'relative', zIndex: 10 },
  tabBtn: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: '6px 0' },
  tabBtnLabel: { fontSize: 11, fontWeight: 700 },
  header: { background: '#14181F', padding: '18px 16px 16px' },
  headerDesktop: { background: '#14181F', padding: '12px 16px', display: 'flex', gap: 10, alignItems: 'center' },
  headerTop: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 },
  officeLinkBtn: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', color: '#B7BCB2', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', padding: '4px 6px' },
  headerTitle: { color: '#EDEBE3', fontSize: 15, fontWeight: 600, letterSpacing: '0.01em' },
  customerBtn: { width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: '#EDEBE3', border: 'none', borderRadius: 10, padding: '11px 12px', cursor: 'pointer', fontFamily: 'inherit' },
  customerBtnText: { fontSize: 14, fontWeight: 500 },
  dateBtn: { position: 'relative', width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: '#EDEBE3', border: 'none', borderRadius: 10, padding: '11px 12px', cursor: 'pointer', marginTop: 8, boxSizing: 'border-box', fontFamily: 'inherit' },
  pickersSummary: { width: '100%', display: 'flex', alignItems: 'center', gap: 7, background: '#2A2E23', border: '1px solid #3C4132', borderRadius: 10, padding: '9px 12px', cursor: 'pointer', fontFamily: 'inherit', boxSizing: 'border-box' },
  pickersSummaryText: { fontSize: 12.5, fontWeight: 600, color: '#EDEBE3', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  pickersSummaryDot: { color: '#5B6058' },
  repeatOrderBanner: { display: 'flex', alignItems: 'center', gap: 8, width: 'calc(100% - 32px)', margin: '10px 16px 0', background: '#DCEEE8', border: '1px solid #B7DBCF', borderRadius: 10, padding: '9px 12px', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' },
  repeatOrderText: { flex: 1, fontSize: 12.5, fontWeight: 600, color: '#1E4238' },
  repeatOrderCta: { fontSize: 12, fontWeight: 700, color: '#2B5D50', textDecoration: 'underline', flexShrink: 0 },
  lowStockBtn: { width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: '#2A2E23', border: '1px solid #3C4132', borderRadius: 10, padding: '10px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600 },
  lowStockBtnActive: { background: '#B5493B', border: '1px solid #B5493B' },
  orderCountPill: { display: 'inline-block', color: '#EDEBE3', fontSize: 12.5, fontWeight: 600, background: '#2A2E23', borderRadius: 999, padding: '6px 12px' },
  searchWrap: { position: 'relative', display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 8px' },
  searchInputWrap: { position: 'relative', flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' },
  searchIcon: { position: 'absolute', left: 28, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' },
  searchIconInner: { position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' },
  searchInput: { width: '100%', boxSizing: 'border-box', background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 10, padding: '10px 12px 10px 38px', fontSize: 14, fontFamily: 'inherit', color: '#14181F', outline: 'none' },
  searchInputInner: { width: '100%', boxSizing: 'border-box', background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 10, padding: '10px 34px 10px 38px', fontSize: 14, fontFamily: 'inherit', color: '#14181F', outline: 'none' },
  clearSearchBtn: { position: 'absolute', right: 28, top: '50%', transform: 'translateY(-50%)', background: '#EAE8DD', border: 'none', borderRadius: '50%', width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
  clearSearchBtnInner: { position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: '#EAE8DD', border: 'none', borderRadius: '50%', width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
  gridSizeBtn: { flexShrink: 0, background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
  brandGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, padding: '8px 16px 20px', flex: 1, minHeight: 0, overflowY: 'auto', alignContent: 'start' },
  brandTile: { border: 'none', borderRadius: 14, padding: '20px 14px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, cursor: 'pointer', minHeight: 78 },
  brandTileVariant: {
    small: { padding: '11px 9px', minHeight: 50, borderRadius: 11, gap: 2 },
    medium: {},
    large: { padding: '26px 18px', minHeight: 96, borderRadius: 16, gap: 6 },
  },
  brandTileName: { color: '#F7F8F4', fontSize: 15, fontWeight: 700 },
  brandTileNameVariant: {
    small: { fontSize: 12.5, lineHeight: 1.2 },
    medium: {},
    large: { fontSize: 17 },
  },
  brandTileCount: { color: 'rgba(247,248,244,0.75)', fontSize: 11.5, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" },
  itemsSubHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px 6px' },
  backBtn: { display: 'flex', alignItems: 'center', gap: 2, background: 'none', border: 'none', color: '#14181F', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: 'inherit' },
  backBtnBig: { display: 'flex', alignItems: 'center', gap: 4, background: '#EDEBE3', border: 'none', borderRadius: 10, color: '#14181F', fontSize: 15, fontWeight: 700, cursor: 'pointer', padding: '8px 14px 8px 8px', fontFamily: 'inherit' },
  itemsSubHeaderBrand: { fontSize: 13, fontWeight: 700, color: '#5B6058', textTransform: 'uppercase', letterSpacing: '0.04em' },
  sortSelect: { flexShrink: 0, background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 8, padding: '6px 8px', fontSize: 12, fontWeight: 600, color: '#5B6058', fontFamily: 'inherit', outline: 'none', maxWidth: 130 },
  daySelect: { appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none', background: "#F7F8F4 url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238A8F87' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>\") no-repeat right 12px center", border: '1px solid #D6D3C6', borderRadius: 8, padding: '7px 32px 7px 12px', fontSize: 13, fontWeight: 600, color: '#14181F', fontFamily: 'inherit', outline: 'none', cursor: 'pointer', minWidth: 150 },
  shipToCell: { background: '#F2F4EF', borderBottom: '1px solid #E3E1D6', padding: '12px 16px' },
  shipToTitle: { fontSize: 12.5, fontWeight: 700, color: '#5B6058', marginBottom: 8 },
  shipToGrid: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  sortDirBtn: { flexShrink: 0, background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 8, width: 30, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, color: '#5B6058', cursor: 'pointer' },
  list: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 16px' },
  emptyState: { textAlign: 'center', color: '#8A8F87', fontSize: 13.5, padding: '32px 0' },
  mobileIifError: { display: 'flex', alignItems: 'center', gap: 10, background: '#F7DEDA', color: '#7A2E22', border: '1px solid #EFBEB4', borderRadius: 8, padding: '10px 14px', margin: '0 16px 12px', fontSize: 13 },
  mobileIifErrorDismiss: { marginLeft: 'auto', background: 'none', border: 'none', fontSize: 16, lineHeight: 1, cursor: 'pointer', color: 'inherit', padding: '0 4px' },
  itemRow: { display: 'flex', alignItems: 'center', gap: 14, padding: '8px 0', borderBottom: '1px solid #EAE8DD' },
  itemThumb: { width: 76, height: 76, borderRadius: 10, objectFit: 'contain', flexShrink: 0, background: '#FFFFFF', padding: 4, boxSizing: 'border-box' },
  itemName: { fontSize: 14, fontWeight: 600, color: '#14181F', marginBottom: 3 },
  itemMeta: { display: 'flex', alignItems: 'center', gap: 8 },
  sku: { fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#8A8F87' },
  stockTag: { fontSize: 11, fontWeight: 600, color: '#5B6058', background: '#EAE8DD', borderRadius: 5, padding: '2px 6px' },
  stockTagLow: { color: '#B5493B', background: '#F7E4E0' },
  brandLabel: { fontSize: 11, fontWeight: 600, color: '#8A8F87' },
  stepper: { display: 'flex', alignItems: 'center', gap: 2, background: '#F1EFE6', borderRadius: 9, padding: 3 },
  stepBtn: { width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#FFFFFF', border: 'none', borderRadius: 7, cursor: 'pointer' },
  stepQty: { width: 24, textAlign: 'center', fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 600, color: '#14181F' },
  ticketBar: { position: 'sticky', bottom: 0, cursor: 'pointer' },
  ticketStub: { height: 6, background: 'repeating-linear-gradient(90deg, #F7F8F4 0 6px, transparent 6px 12px)', borderTop: '1px dashed #C7CBC1' },
  ticketBarContent: { background: '#14181F', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10 },
  ticketBarText: { color: '#EDEBE3', fontSize: 13.5, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: 1 },
  ticketBarTotal: { color: '#9FE3CD', fontWeight: 700 },
  ticketBarCta: { flexShrink: 0, whiteSpace: 'nowrap', color: '#FFFFFF', fontSize: 13, fontWeight: 700, background: '#2B5D50', padding: '9px 16px', borderRadius: 8 },
  sheetOverlay: { position: 'absolute', inset: 0, background: 'rgba(20,24,31,0.45)', display: 'flex', alignItems: 'flex-end', zIndex: 10 },
  sheet: { background: '#F7F8F4', width: '100%', maxHeight: '80%', borderRadius: '18px 18px 0 0', padding: '10px 16px 20px', display: 'flex', flexDirection: 'column', boxShadow: '0 -4px 20px rgba(20,24,31,0.15)' },
  sheetTall: { background: '#F7F8F4', width: '100%', height: '92dvh', maxHeight: '92dvh', borderRadius: '18px 18px 0 0', padding: '10px 16px 20px', display: 'flex', flexDirection: 'column', boxShadow: '0 -4px 20px rgba(20,24,31,0.15)' },
  sheetHandle: { width: 36, height: 4, background: '#D6D3C6', borderRadius: 999, margin: '4px auto 12px' },
  sheetHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  sheetTitle: { fontSize: 15, fontWeight: 700, color: '#14181F' },
  iconBtn: { background: 'none', border: 'none', cursor: 'pointer', padding: 4 },
  sheetCustomer: { fontSize: 13, fontWeight: 600, color: '#2B5D50', marginBottom: 6 },
  sheetDelivery: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: '#5B6058', marginBottom: 12 },
  sheetLines: { overflowY: 'auto', flex: 1 },
  sheetLine: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid #EAE8DD' },
  sheetLineName: { fontSize: 13.5, fontWeight: 600, color: '#14181F' },
  sheetLineSku: { fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#8A8F87', marginTop: 2 },
  sheetLineQty: { fontFamily: "'JetBrains Mono', monospace", fontSize: 13.5, fontWeight: 700, color: '#14181F' },
  checkinBtn: { marginRight: 6, background: '#EAF1EE', border: '1px solid #C4DDD2', color: '#2B5D50', borderRadius: 7, padding: '4px 8px', fontSize: 11, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  checkinBtnDesktop: { marginTop: 6, background: '#EAF1EE', border: '1px solid #C4DDD2', color: '#2B5D50', borderRadius: 7, padding: '3px 9px', fontSize: 11, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  backorderBtn: { marginRight: 6, background: '#FBEEE7', border: '1px solid #E6C6B4', color: '#B5493B', borderRadius: 7, padding: '4px 8px', fontSize: 11, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  backorderBtnDesktop: { marginTop: 6, background: '#FBEEE7', border: '1px solid #E6C6B4', color: '#B5493B', borderRadius: 7, padding: '3px 9px', fontSize: 11, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  checkinTag: { fontSize: 10, fontWeight: 800, color: '#2B5D50', background: '#EAF1EE', border: '1px solid #C4DDD2', borderRadius: 20, padding: '2px 8px', textTransform: 'uppercase', letterSpacing: '0.03em' },
  removeBtn: { background: 'none', border: 'none', cursor: 'pointer', padding: 4 },
  sheetTotal: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0 10px', fontSize: 13, fontWeight: 600, color: '#5B6058' },
  sheetTotalNum: { fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 700, color: '#14181F' },
  submitBtn: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: '#2B5D50', color: '#F7F8F4', border: 'none', borderRadius: 10, padding: '13px', fontSize: 14.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  submitBtnDisabled: { background: '#C7CBC1', cursor: 'not-allowed' },
  ticketSecondaryRow: { display: 'flex', gap: 8, marginTop: 8 },
  pendingBtn: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: '#F0EEE4', color: '#2B5D50', border: '1px solid #C4DDD2', borderRadius: 10, padding: '11px 0', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  pendingBtnDisabled: { background: '#F0EEE4', color: '#A9AEA3', borderColor: '#E3E1D6', cursor: 'not-allowed' },
  discardBtn: { background: 'none', color: '#B5493B', border: '1px solid #E7C6C0', borderRadius: 10, padding: '11px 16px', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  orderedByRow: { textAlign: 'center', fontSize: 12.5, color: '#5B6058', margin: '2px 0 10px' },
  orderedByLink: { background: 'none', border: 'none', color: '#2B5D50', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit', padding: 0, textDecoration: 'underline' },
  signInCard: { background: '#F7F8F4', borderRadius: 16, padding: 22, width: '86%', maxWidth: 360, boxShadow: '0 12px 40px rgba(20,24,31,0.28)' },
  signInTitle: { fontSize: 17, fontWeight: 700, color: '#14181F', marginBottom: 6 },
  signInSub: { fontSize: 13, color: '#5B6058', lineHeight: 1.4, marginBottom: 14 },
  signInInput: { width: '100%', boxSizing: 'border-box', background: '#FFFFFF', border: '1px solid #C7CBC1', borderRadius: 10, padding: '12px 14px', fontSize: 15, fontFamily: 'inherit', color: '#14181F', outline: 'none' },
  signInClear: { display: 'block', width: '100%', marginTop: 10, background: 'none', border: 'none', color: '#8A8F87', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' },
  sheetWarning: { textAlign: 'center', fontSize: 12, color: '#B5493B', marginTop: 8 },
  notesSection: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 0 4px' },
  notesLabel: { fontSize: 12, fontWeight: 600, color: '#5B6058' },
  notesTextarea: { width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: 60, background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', color: '#14181F', outline: 'none', lineHeight: 1.4 },
  orderCardNotes: { background: '#FBFAF6', border: '1px solid #EAE8DD', borderRadius: 8, padding: '8px 10px', margin: '8px 0 2px', fontSize: 12.5, color: '#14181F', lineHeight: 1.4 },
  orderCardNotesLabel: { fontWeight: 700, color: '#5B6058' },
  customerRow: { width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '13px 4px', background: 'none', border: 'none', borderBottom: '1px solid #EAE8DD', fontSize: 14, fontWeight: 500, color: '#14181F', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' },
  customerRowActive: { background: '#EAF1EE' },
  custDayTag: { marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: '#2B5D50', background: '#EAF1EE', border: '1px solid #C4DDD2', borderRadius: 20, padding: '1px 8px' },
  dayChipRow: { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 0 10px' },
  dayChip: { background: '#F0EEE4', border: '1px solid #E3E1D6', color: '#5B6058', borderRadius: 20, padding: '5px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  dayChipActive: { background: '#2B5D50', color: '#F7F8F4', borderColor: '#2B5D50' },
  customerSearchWrap: { display: 'flex', alignItems: 'center', gap: 8, background: '#F0EEE4', borderRadius: 10, padding: '10px 12px', margin: '4px 0 10px' },
  customerSearchInput: { flex: 1, background: 'none', border: 'none', outline: 'none', fontSize: 15, fontFamily: 'inherit', color: '#14181F' },
  customerEmpty: { padding: '16px 4px', color: '#8A8F87', fontSize: 13.5 },
  dateTypeWrap: { display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 10px' },
  dateTypeInput: { flex: 1, background: '#FFFFFF', border: '1px solid #C7CBC1', borderRadius: 10, padding: '11px 12px', fontSize: 15, fontFamily: 'inherit', color: '#14181F', outline: 'none' },
  dateDoneBtn: { background: '#2B5D50', color: '#F7F8F4', border: 'none', borderRadius: 10, padding: '11px 18px', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  dateOrDivider: { textAlign: 'center', fontSize: 12, color: '#8A8F87', margin: '4px 0 10px', textTransform: 'uppercase', letterSpacing: '0.04em' },
  calendarNav: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 4px 12px' },
  calendarNavBtn: { width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#EAE8DD', border: 'none', borderRadius: 8, cursor: 'pointer' },
  calendarMonthLabel: { fontSize: 14, fontWeight: 700, color: '#14181F' },
  calendarWeekRow: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', padding: '0 4px' },
  calendarWeekday: { textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#8A8F87', padding: '4px 0 8px' },
  calendarGrid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', rowGap: 4, padding: '0 4px 8px' },
  calendarDay: { aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', borderRadius: 9, fontSize: 13.5, fontWeight: 600, color: '#14181F', cursor: 'pointer', fontFamily: 'inherit' },
  calendarDaySelected: { background: '#2B5D50', color: '#F7F8F4' },
  calendarDayToday: { background: '#EAE8DD', color: '#2B5D50' },
  calendarClearBtn: { width: '100%', background: 'none', border: 'none', color: '#B5493B', fontSize: 13, fontWeight: 600, padding: '10px 0 2px', cursor: 'pointer', fontFamily: 'inherit' },
  confirmWrap: { padding: '40px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', overflowY: 'auto' },
  confirmBadge: { width: 48, height: 48, borderRadius: '50%', background: '#2B5D50', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  confirmTitle: { fontSize: 18, fontWeight: 700, color: '#14181F' },
  confirmSub: { fontSize: 13, color: '#8A8F87', marginTop: 4, marginBottom: 8 },
  confirmDelivery: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: '#5B6058', background: '#EAE8DD', borderRadius: 999, padding: '5px 12px', marginBottom: 24 },
  receipt: { width: '100%', background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 12, padding: '16px', marginBottom: 20 },
  receiptHeader: { display: 'flex', justifyContent: 'space-between', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: '#8A8F87', marginBottom: 10 },
  receiptLine: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' },
  receiptItemName: { fontSize: 13, fontWeight: 600, color: '#14181F' },
  receiptSku: { fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: '#8A8F87', marginTop: 2 },
  receiptQty: { fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 700, color: '#14181F' },
  receiptDivider: { borderTop: '1px dashed #D6D3C6', margin: '8px 0' },
  receiptTotalRow: { display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 700, color: '#14181F' },
  receiptTotalNum: { fontFamily: "'JetBrains Mono', monospace", fontSize: 15 },
  confirmNote: { fontSize: 12.5, color: '#8A8F87', textAlign: 'center', lineHeight: 1.5, marginBottom: 20 },
  invRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid #EAE8DD' },
  stockBarTrack: { width: '100%', height: 4, background: '#EAE8DD', borderRadius: 999, marginTop: 8, overflow: 'hidden' },
  stockBarFill: { height: '100%', borderRadius: 999 },
  invStockNum: { fontFamily: "'JetBrains Mono', monospace", fontSize: 20, fontWeight: 700, minWidth: 32, textAlign: 'right' },
  orderCard: { background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 12, marginTop: 10, overflow: 'hidden' },
  orderCardUnprocessed: { background: '#FBF3E4', borderColor: '#F0D28F' },
  badgeUnprocessedMobile: { fontSize: 10, fontWeight: 800, color: '#9A6B12', background: '#FBE7C2', border: '1px solid #F0D28F', borderRadius: 20, padding: '1px 7px', textTransform: 'uppercase', letterSpacing: '0.03em' },
  badgePendingMobile: { fontSize: 10, fontWeight: 800, color: '#5B6058', background: '#E8E6DC', border: '1px solid #D2CFC0', borderRadius: 20, padding: '1px 7px', textTransform: 'uppercase', letterSpacing: '0.03em' },
  mobileFilterRow: { padding: '10px 16px 0', display: 'flex', gap: 8 },
  mobileFilterChip: { background: '#F0EEE4', border: '1px solid #E3E1D6', borderRadius: 20, padding: '6px 14px', fontSize: 12.5, fontWeight: 700, color: '#5B6058', cursor: 'pointer', fontFamily: 'inherit' },
  mobileFilterChipActive: { background: '#2B5D50', color: '#F7F8F4', borderColor: '#2B5D50' },
  orderCardActionBtnPrimary: { background: '#2B5D50', color: '#F7F8F4' },
  orderCardHeader: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: 'none', border: 'none', padding: '13px 14px', cursor: 'pointer', fontFamily: 'inherit' },
  orderCardCustomer: { fontSize: 14, fontWeight: 700, color: '#14181F' },
  orderCardMeta: { fontSize: 11.5, color: '#8A8F87', marginTop: 2 },
  orderCardDelivery: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: '#5B6058', background: '#EAE8DD', borderRadius: 999, padding: '4px 8px', whiteSpace: 'nowrap' },
  orderCardLines: { borderTop: '1px solid #EAE8DD', padding: '4px 14px' },
  orderCardLine: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid #EAE8DD' },
  orderCardActions: { display: 'flex', gap: 8, padding: '10px 0 4px' },
  orderCardActionBtn: { flex: 1, background: '#F0EEE4', border: 'none', borderRadius: 8, padding: '9px 0', fontSize: 12.5, fontWeight: 700, color: '#14181F', cursor: 'pointer', fontFamily: 'inherit' },
};

const officeStyles = {
  wrap: { flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' },
  topBar: { display: 'flex', alignItems: 'center', gap: 12, rowGap: 8, flexWrap: 'wrap', background: '#14181F', padding: '14px 16px', position: 'sticky', top: 0, zIndex: 5 },
  brand: { display: 'flex', alignItems: 'center', gap: 8 },
  brandText: { color: '#EDEBE3', fontSize: 15, fontWeight: 700, whiteSpace: 'nowrap' },
  nav: { display: 'flex', gap: 4, flex: 1 },
  navBtn: { background: 'none', border: 'none', color: '#B7BCB2', fontSize: 13.5, fontWeight: 600, padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  backNavBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '8px 10px', color: '#EDEBE3' },
  backNavBtnDisabled: { color: '#5A5F57', cursor: 'default' },
  navBtnActive: { background: '#2B5D50', color: '#F7F8F4' },
  navBadge: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 18, height: 18, padding: '0 5px', marginLeft: 6, borderRadius: 9, background: '#C98A2B', color: '#14181F', fontSize: 11, fontWeight: 800, verticalAlign: 'middle' },
  allCaughtUp: { display: 'flex', alignItems: 'center', gap: 8, background: '#E3EFE9', border: '1px solid #C4DDD2', borderRadius: 10, padding: '14px 16px', color: '#2B5D50', fontSize: 13.5, fontWeight: 600 },
  refreshBtn: { display: 'flex', alignItems: 'center', gap: 6, background: '#2A2E23', color: '#EDEBE3', border: '1px solid #3C4132', borderRadius: 8, padding: '8px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  autoLink: { background: 'none', border: 'none', color: '#8A8F87', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline', whiteSpace: 'nowrap' },
  editModeBtnActive: { background: '#2B5D50', color: '#F7F8F4', borderColor: '#2B5D50' },
  editHint: { margin: '0 0 10px', padding: '8px 12px', background: '#EAF1EE', border: '1px solid #C4DDD2', borderRadius: 8, color: '#2B5D50', fontSize: 12.5, fontWeight: 600 },
  colorPickerLabel: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6, background: '#FFFFFF', border: '1px solid #D6D3C6', borderRadius: 8, padding: '6px 10px', fontSize: 13, fontWeight: 600, color: '#14181F', cursor: 'pointer', fontFamily: 'inherit' },
  colorSwatch: { width: 14, height: 14, borderRadius: 4, border: '1px solid rgba(0,0,0,0.15)', display: 'inline-block' },
  colorInput: { position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' },
  importBanner: { display: 'flex', alignItems: 'center', gap: 10, background: '#DCEEE8', color: '#1E4238', border: '1px solid #B7DBCF', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 13 },
  importBannerError: { display: 'flex', alignItems: 'center', gap: 10, background: '#F7DEDA', color: '#7A2E22', border: '1px solid #EFBEB4', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 13 },
  dismissBtn: { marginLeft: 'auto', background: 'none', border: 'none', fontSize: 16, lineHeight: 1, cursor: 'pointer', color: 'inherit', padding: '0 4px' },
  body: { flex: 1, minHeight: 0, padding: '20px 24px', background: '#F7F8F4', overflowY: 'auto' },
  bodyNoScroll: { flex: 1, minHeight: 0, padding: '12px 24px 16px', background: '#F7F8F4', overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  orderFormWrap: { width: '100%', flex: 1, minHeight: 0, background: '#F7F8F4', borderRadius: 16, overflow: 'hidden', boxShadow: '0 1px 3px rgba(20,24,31,0.12)', border: '1px solid #E3E1D6', display: 'flex', flexDirection: 'column' },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' },
  sectionTitle: { fontSize: 18, fontWeight: 700, color: '#14181F', marginRight: 4 },
  search: { flex: '1 1 260px', maxWidth: 340, background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 8, padding: '8px 12px', fontSize: 13.5, fontFamily: 'inherit', color: '#14181F', outline: 'none' },
  select: { background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 8, padding: '8px 12px', fontSize: 13.5, fontFamily: 'inherit', color: '#14181F', outline: 'none' },
  smallBtn: { background: '#EAE8DD', border: '1px solid #D6D3C6', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, fontWeight: 600, color: '#14181F', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  primarySmallBtn: { background: '#2B5D50', border: '1px solid #2B5D50', borderRadius: 8, padding: '8px 14px', fontSize: 12.5, fontWeight: 700, color: '#F7F8F4', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  smallBtnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  inlineInput: { background: '#FFFFFF', border: '1px solid #B7C9C1', borderRadius: 8, padding: '7px 10px', fontSize: 13.5, fontWeight: 600, color: '#14181F', fontFamily: 'inherit', minWidth: 220, outline: 'none' },
  checkboxLabel: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: '#5B6058', whiteSpace: 'nowrap' },
  countPill: { marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: '#5B6058', background: '#EAE8DD', borderRadius: 999, padding: '6px 12px', whiteSpace: 'nowrap' },
  tableCard: { background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 12, overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13.5 },
  th: { textAlign: 'left', padding: '10px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#8A8F87', borderBottom: '1px solid #E3E1D6', background: '#FBFAF6', whiteSpace: 'nowrap' },
  td: { padding: '10px 14px', borderBottom: '1px solid #EAE8DD', color: '#14181F', verticalAlign: 'middle' },
  rowClickable: { cursor: 'pointer' },
  rowUnprocessed: { background: '#FBF3E4' },
  badgeProcessed: { display: 'inline-block', fontSize: 11, fontWeight: 700, color: '#2B5D50', background: '#E3EFE9', border: '1px solid #C4DDD2', borderRadius: 20, padding: '2px 9px' },
  badgeUnprocessed: { display: 'inline-block', fontSize: 11, fontWeight: 700, color: '#9A6B12', background: '#FBE7C2', border: '1px solid #F0D28F', borderRadius: 20, padding: '2px 9px' },
  badgePending: { display: 'inline-block', fontSize: 11, fontWeight: 700, color: '#5B6058', background: '#E8E6DC', border: '1px solid #D2CFC0', borderRadius: 20, padding: '2px 9px' },
  itemHistoryCell: { background: '#F2F4EF', borderBottom: '1px solid #E3E1D6', padding: '12px 16px 16px 56px' },
  itemHistoryEmpty: { fontSize: 13, color: '#8A8F87', fontStyle: 'italic' },
  itemHistoryWrap: { display: 'flex', flexDirection: 'column', gap: 8 },
  itemHistorySummary: { display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 13, color: '#14181F' },
  itemHistoryTable: { width: '100%', maxWidth: 760, borderCollapse: 'collapse', background: '#FFFFFF', borderRadius: 8, overflow: 'hidden', border: '1px solid #E3E1D6' },
  itemHistoryTh: { textAlign: 'left', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', color: '#8A8F87', padding: '7px 10px', borderBottom: '1px solid #ECEAE1', background: '#FBFAF6' },
  itemHistoryTd: { fontSize: 13, color: '#14181F', padding: '7px 10px', borderBottom: '1px solid #F0EEE6' },
  historyLinkBtn: { background: '#FFFFFF', border: '1px solid #D6D3C6', color: '#2B5D50', borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  markDoneBtn: { background: '#2B5D50', color: '#F7F8F4', borderColor: '#2B5D50' },
  rowInactive: { opacity: 0.5 },
  emptyCell: { padding: '28px 14px', textAlign: 'center', color: '#8A8F87', fontSize: 13.5 },
  detailCell: { padding: '8px 14px 14px', background: '#FBFAF6' },
  subTable: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5, background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 8, overflow: 'hidden' },
  subTh: { textAlign: 'left', padding: '8px 12px', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', color: '#8A8F87', borderBottom: '1px solid #E3E1D6' },
  subTd: { padding: '8px 12px', borderBottom: '1px solid #EAE8DD', color: '#14181F' },
  orderNotes: { marginTop: 0, marginBottom: 8, background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, color: '#14181F', lineHeight: 1.45 },
  orderNotesLabel: { fontWeight: 700, color: '#5B6058' },
  stockInput: { width: 60, textAlign: 'right', background: '#F7F8F4', border: '1px solid #D6D3C6', borderRadius: 6, padding: '5px 8px', fontSize: 13, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: '#14181F', outline: 'none' },
  stockInputDirty: { border: '1px solid #C9A227', background: '#FFFDF5' },
  confirmCard: { width: '100%', maxWidth: 460, maxHeight: '80vh', overflowY: 'auto', background: '#F7F8F4', borderRadius: 16, boxShadow: '0 20px 60px rgba(20,24,31,0.4)', padding: 22 },
  confirmTitle: { fontSize: 17, fontWeight: 800, color: '#14181F' },
  confirmSub: { fontSize: 13.5, color: '#5B6058', marginTop: 4 },
  confirmList: { marginTop: 12, border: '1px solid #E3E1D6', borderRadius: 10, overflow: 'hidden', background: '#FFFFFF' },
  confirmRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '9px 12px', borderBottom: '1px solid #F0EEE6' },
  confirmItem: { fontSize: 13, color: '#14181F', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  confirmDelta: { fontSize: 13, color: '#5B6058', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap', flexShrink: 0 },
  confirmActions: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 },
  confirmCancel: { background: '#EDEBE3', color: '#14181F', border: '1px solid #E3E1D6', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  confirmSave: { background: '#2B5D50', color: '#F7F8F4', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  nameEditBtn: { background: 'none', border: 'none', color: '#14181F', fontSize: 13.5, fontFamily: 'inherit', textAlign: 'left', cursor: 'text', padding: '2px 4px', borderRadius: 4, textDecoration: 'underline dotted', textUnderlineOffset: 3 },
  nameInput: { width: '100%', minWidth: 180, background: '#F7F8F4', border: '1px solid #2B5D50', borderRadius: 6, padding: '5px 8px', fontSize: 13.5, fontFamily: 'inherit', color: '#14181F', outline: 'none' },
  packLabelEditBtn: { background: 'none', border: 'none', color: '#8A8F87', fontSize: 10.5, fontFamily: 'inherit', textAlign: 'right', cursor: 'text', padding: '1px 3px', borderRadius: 4, textDecoration: 'underline dotted', textUnderlineOffset: 2 },
  packLabelInput: { width: 90, textAlign: 'right', background: '#F7F8F4', border: '1px solid #2B5D50', borderRadius: 5, padding: '3px 6px', fontSize: 10.5, fontFamily: 'inherit', color: '#14181F', outline: 'none' },
  photoThumb: { width: 44, height: 44, borderRadius: 6, objectFit: 'contain', background: '#F0EEE4', border: '1px solid #E3E1D6' },
  invThumb: { width: 42, height: 42, borderRadius: 7, objectFit: 'contain', background: '#FFFFFF', border: '1px solid #E3E1D6', padding: 2, boxSizing: 'border-box', display: 'block' },
  invThumbPlaceholder: { width: 42, height: 42, borderRadius: 7, background: '#F0EEE4', border: '1px solid #E7E4D8', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  photoPlaceholder: { width: 44, height: 44, borderRadius: 6, background: '#F0EEE4', border: '1px dashed #C9C6B8', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8.5, color: '#A8AC9E', textAlign: 'center' },
  photoBtn: { background: '#F0EEE4', border: '1px solid #D6D3C6', borderRadius: 5, padding: '2px 7px', fontSize: 10.5, fontWeight: 600, fontFamily: 'inherit', color: '#14181F', cursor: 'pointer' },
  photoUrlInput: { width: 120, background: '#F7F8F4', border: '1px solid #2B5D50', borderRadius: 5, padding: '3px 6px', fontSize: 10.5, fontFamily: 'inherit', color: '#14181F', outline: 'none' },
  stockInputLow: { borderColor: '#B5493B', color: '#B5493B' },
  unsavedDot: { width: 6, height: 6, borderRadius: '50%', background: '#C9A227' },
  toggleBtn: { border: 'none', borderRadius: 999, padding: '5px 12px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', minWidth: 62 },
  toggleBtnOn: { background: '#DCEEE8', color: '#2B5D50' },
  toggleBtnOff: { background: '#F0EEE4', color: '#8A8F87' },
};
