import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import JsBarcode from 'jsbarcode';
import { formatDate, todayISODate, formatDateMMDDYY, parseTypedDate, formatDateTime, toISO, formatMoney, lineTotal, casePrice, displayCode, csvEscape, editDistance, fuzzyScore } from './utils.js';
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
// QuickBooks payment terms (from the QB terms list).
const TERMS_OPTIONS = [
  '1% 10 Net 11', '1% 10 Net 15', '1% 10 Net 30', '2% 10 Net 30',
  'CIA', 'COD', 'Consignment', 'Due on receipt',
  'Net 10', 'Net 11', 'Net 15', 'Net 21', 'Net 30', 'Net 30 ROG', 'Net 60',
];

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
  { id: 'printOrder', label: 'Inventory order' },
];
function inventorySortValue(item, field, popularity, printPos) {
  switch (field) {
    case 'id': return item.id.toLowerCase();
    case 'brand': return (item.brand || '').toLowerCase();
    case 'upc': return (item.upc || '').toLowerCase();
    case 'pack': return Number(item.pack) || 1;
    case 'price': return Number(item.price) || 0;
    case 'cost': return item.cost == null ? -1 : Number(item.cost);
    case 'casePrice': return casePrice(item);
    case 'stock': return Number(item.stock) || 0;
    case 'active': return item.active ? 1 : 0;
    case 'popularity': return popularity[item.id] || 0;
    case 'printOrder': return (printPos && printPos[item.id] != null) ? printPos[item.id] : Number.MAX_SAFE_INTEGER;
    case 'name':
    default: return (item.name || '').toLowerCase();
  }
}
function sortInventoryItems(items, field, dir, popularity, printSequence) {
  const mult = dir === 'desc' ? -1 : 1;
  const printPos = {};
  if (Array.isArray(printSequence)) printSequence.forEach((id, i) => { printPos[id] = i; });
  const arr = [...items];
  arr.sort((a, b) => {
    const va = inventorySortValue(a, field, popularity, printPos);
    const vb = inventorySortValue(b, field, popularity, printPos);
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

// Today's date as ISO yyyy-mm-dd (local).
// ISO yyyy-mm-dd -> mm/dd/yy (2-digit year) for the compact date field.
// Parse a typed date like "9/18", "9/18/26", "09/18/2026" -> ISO (assumes
// current year if year omitted). Returns '' if unparseable.
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
function sortLinesForPrint(lines, printOrder, enabled = true) {
  if (!enabled || !printOrder || printOrder.length === 0) return lines;
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
  const customer = options.customer || null;
  // PO number = MMDDYY(delivery date) - customer abbreviation (same as the exports).
  let poNumber = '';
  const abbr = (customer && customer.abbreviation || '').trim();
  if (abbr && order.deliveryDate) {
    const [py, pm, pd] = String(order.deliveryDate).split('-');
    poNumber = `${pm}${pd}${py.slice(2)}-${abbr}`;
  }
  const total = order.lines.reduce((s, l) => s + lineTotal(l, l.qty), 0);
  const totalCases = order.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const totalUnits = order.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.pack) || 1), 0);
  const orderedLines = sortLinesForPrint(order.lines, printSequence, !!(customer && customer.usePrintOrder));
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
    <h1>${poNumber ? `PO# ${poNumber}` : `Order #${order.id}`} — ${order.customer}</h1>
    <div class="meta">${poNumber ? `Order #${order.id} &nbsp;·&nbsp; ` : ''}Delivery ${formatDate(order.deliveryDate)} &nbsp;·&nbsp; Submitted ${formatDateTime(order.submittedAt)}${order.submittedBy ? ` &nbsp;·&nbsp; by ${String(order.submittedBy).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}` : ''}</div>
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

// Printed-invoice number: the order number plus an admin-set offset (so the
// sequence can be aligned to QuickBooks). Default 30000 until the app loads the
// live offset. invoiceNumberFor uses whatever the module has fetched.
let INVOICE_OFFSET = 30000;
function invoiceNumberFor(order) {
  if (order && order.invoiceNumber != null && order.invoiceNumber !== '') return Number(order.invoiceNumber);
  return INVOICE_OFFSET + Number(order.id || 0);
}

// Build a printable invoice that matches the Hawken Group template, using the
// same data as the TP export (customer bill-to/ship-to, PO, line items with
// cases/eaches/price, UPCs, totals, 0.5% sales tax).
function printInvoice(order, customer, printSequence, items = []) {
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const c = customer || {};
  const SALES_TAX_RATE = 0.005; // 0.5%
  const money = n => (Number(n) || 0).toFixed(2);
  // Totals show a "$" and thousands separators, matching the reference; line
  // items stay plain (no $).
  const moneyD = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const ordered = sortLinesForPrint(order.lines, printSequence, !!(c && c.usePrintOrder));
  const positive = ordered.filter(l => (Number(l.qty) || 0) > 0);
  const zeros = ordered.filter(l => (Number(l.qty) || 0) === 0);
  const lines = [...positive, ...zeros];

  const totalCases = positive.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  // Total Each counts only box-unit lines; case lines don't break into eaches.
  const totalEach = positive.reduce((s, l) => s + (l.unit === 'case' ? 0 : (Number(l.qty) || 0) * (Number(l.pack) || 1)), 0);
  const subtotal = positive.reduce((s, l) => s + lineTotal(l, l.qty), 0);
  const tax = Math.round(subtotal * SALES_TAX_RATE * 100) / 100;
  const grand = Math.round((subtotal + tax) * 100) / 100;

  const now = new Date();
  const poDate = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getFullYear()).slice(2)}`;
  const abbr = (c.abbreviation || '').trim();
  const autoPoNum = abbr ? `${poDate}-${abbr}` : poDate;
  const poNumber = (order.poNumber && String(order.poNumber).trim()) ? String(order.poNumber).trim() : autoPoNum;
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

  const itemById = {};
  for (const it of items) itemById[it.id] = it;

  // If every ordered (positive-qty) line is a case, drop the EACH column entirely.
  const allCases = positive.length > 0 && positive.every(l => l.unit === 'case');
  const hideUpc = !!(c && c.hideBarcodes);

  const rows = lines.map(l => {
    const cases = Number(l.qty) || 0;
    const pack = Number(l.pack) || 1;
    const isCase = l.unit === 'case';
    // For case lines: show the case price (per-each × pack) and leave EACH blank.
    const each = isCase ? '' : cases * pack;
    const priceShown = isCase ? (Number(l.price) || 0) * pack : (Number(l.price) || 0);
    const desc = esc(l.name) + (l.packLabel ? ' ' + esc(l.packLabel) : '');
    const upcCell = barcodesForCell(l.upc) || parseUpcList(l.upc).map(esc).join('<br>');
    let row = '<tr class="itemrow">' +
      '<td class="c-item">' + esc(displayCode(l.id)) + '</td>' +
      '<td class="c-cs">' + cases + '</td>' +
      (allCases ? '' : '<td class="c-each">' + each + '</td>') +
      '<td class="c-desc">' + desc + '</td>' +
      (hideUpc ? '' : '<td class="c-upc">' + upcCell + '</td>') +
      '<td class="c-price">' + money(priceShown) + '</td>' +
      '<td class="c-total">' + money(lineTotal(l, l.qty)) + '</td>' +
    '</tr>';
    // Shipper "Contains below" sub-lines (from the item's `contains` list).
    const contains = (itemById[l.id] && itemById[l.id].contains) || [];
    if (Array.isArray(contains) && contains.length) {
      row += '<tr class="containrow"><td></td><td></td>' + (allCases ? '' : '<td></td>') +
        '<td class="c-contains"><div class="contains-lbl">Contains below:</div>' +
        contains.map(x => {
          const bc = barcodeSVG(x.upc);
          const label = (x.qty ? x.qty + 'ea ' : '') + esc(x.name || '');
          return '<div class="contain-item"><span class="contain-name">' + label + '</span>' +
                 '<span class="contain-bc">' + (bc ? '<div class="barcode">' + bc + '</div>' : esc(x.upc || '')) + '</span></div>';
        }).join('') +
        '</td>' + (hideUpc ? '' : '<td></td>') + '<td></td><td></td></tr>';
    }
    return row;
  }).join('');

  const HDR =
    '<table class="hdr-top"><tr>' +
    '<td style="width:40%"><div class="company">Hawken Group<small>PO Box 8514</small><small>Honolulu, HI 96830</small></div></td>' +
    '<td style="width:24%"><div class="invoice-word">INVOICE</div></td>' +
    '<td style="width:36%"><table class="metabox">' +
    '<tr class="boxrow"><td class="lbl">DATE:</td><td class="val">' + (esc(dateStr) || '&nbsp;') + '</td></tr>' +
    '<tr class="boxrow"><td class="lbl">INVOICE #</td><td class="val">' + invoiceNumberFor(order) + '</td></tr>' +
    '<tr class="termsrow"><td class="lbl">TERMS:</td><td class="val">' + esc((c.terms && String(c.terms).trim()) || '1% 10 Net 11') + '</td></tr></table></td></tr></table>' +
    '<table class="addrs"><tr>' +
    '<td><div class="addr-lbl">BILL TO:</div><div class="addr-body">' + (billBlock || '&nbsp;') + '</div></td>' +
    '<td class="shipcol"><div class="addr-lbl">SHIP TO:</div><div class="addr-body">' + (shipBlock || '&nbsp;') + '</div></td></tr></table>' +
    '<div class="pobox"><table><tr><td class="lbl">PO #:</td><td class="val">' + (esc(poNumber) || '&nbsp;') + '</td></tr></table></div>';

  const TOT =
    '<table class="totals"><tr>' +
    '<td class="tf-left">Total Case: ' + totalCases + (allCases ? '' : '<br>Total Each: ' + totalEach) + '</td>' +
    '<td class="tf-right"><table>' +
    '<tr><td class="lbl">Subtotal</td><td class="amt">' + moneyD(subtotal) + '</td></tr>' +
    '<tr><td class="lbl">Sales Tax (0.5%)</td><td class="amt">' + moneyD(tax) + '</td></tr>' +
    '<tr class="grand"><td class="lbl">TOTAL AMOUNT</td><td class="amt">' + moneyD(grand) + '</td></tr>' +
    '</table></td></tr></table>';

  const SIG =
    '<table class="sigrow"><tr><td style="width:25%">Total Cases</td><td style="width:25%">Print Name</td>' +
    '<td style="width:30%">Signature</td><td style="width:20%">Date</td></tr></table>';

  // Columns: Item#, CS, [Each unless allCases], Description, [UPC unless hideUpc], Price, Total.
  const colDefs = [];
  const headCells = [];
  colDefs.push('<col style="width:9%"/>'); headCells.push('<th>ITEM #</th>');
  colDefs.push('<col style="width:5%"/>'); headCells.push('<th class="ctr">CS</th>');
  if (!allCases) { colDefs.push('<col style="width:6%"/>'); headCells.push('<th class="ctr">EACH</th>'); }
  colDefs.push('<col style="width:' + (hideUpc ? '52%' : '39%') + '"/>'); headCells.push('<th>DESCRIPTION</th>');
  if (!hideUpc) { colDefs.push('<col style="width:20%"/>'); headCells.push('<th class="ctr">UPC</th>'); }
  colDefs.push('<col style="width:8%"/>'); headCells.push('<th class="r">PRICE</th>');
  colDefs.push('<col style="width:13%"/>'); headCells.push('<th class="r">TOTAL($)</th>');
  const COLG = '<colgroup>' + colDefs.join('') + '</colgroup>';
  const COLH = '<tr class="colhdr">' + headCells.join('') + '</tr>';

  const win = window.open('', '_blank', 'width=880,height=1000');
  if (!win) return;
  const style =
    '* { box-sizing: border-box; }' +
    'html, body { margin: 0; padding: 0; }' +
    "body { font-family: 'Times New Roman', Times, serif; color: #000; font-size: 12px; background: #e9e9e9; }" +
    '.printBtn { position: fixed; top: 10px; left: 10px; z-index: 20; background: #2B5D50; color: #fff; border: none; border-radius: 8px; padding: 9px 16px; font-size: 13px; font-weight: 700; cursor: pointer; font-family: Arial, sans-serif; }' +
    '.page { position: relative; width: 8.5in; height: 11in; padding: 0.35in 0.4in; background: #fff; margin: 12px auto; overflow: hidden; box-shadow: 0 1px 6px rgba(0,0,0,0.25); }' +
    'table.sheet { width: 100%; border-collapse: collapse; table-layout: fixed; }' +
    '.hdr-top { width: 100%; border-collapse: collapse; }' +
    '.hdr-top > tbody > tr > td { vertical-align: top; padding: 0; }' +
    '.company { font-size: 27px; font-weight: bold; line-height: 1.08; white-space: nowrap; }' +
    '.company small { display: block; font-size: 12px; font-weight: normal; white-space: nowrap; }' +
    '.invoice-word { font-size: 30px; font-weight: bold; text-align: center; padding-top: 36px; }' +
    '.metabox { border-collapse: collapse; margin-left: auto; }' +
    '.metabox tr.boxrow td { border: 1px solid #000; padding: 5px 14px; font-size: 14px; }' +
    '.metabox tr.boxrow td.lbl { font-weight: bold; text-align: center; }' +
    '.metabox tr.boxrow td.val { text-align: center; min-width: 110px; }' +
    '.metabox tr.termsrow td { border: none; padding: 4px 10px; font-size: 14px; }' +
    '.metabox tr.termsrow td.lbl { font-weight: bold; text-align: center; }' +
    '.addrs { width: 100%; margin: 18px 0 0; }' +
    '.addrs td { vertical-align: top; width: 50%; padding: 0; }' +
    '.addrs td.shipcol { padding-left: 48px; }' +
    ".addr-lbl { font-weight: bold; font-size: 12px; font-family: Arial, sans-serif; margin-bottom: 4px; }" +
    '.addr-body { font-size: 13px; line-height: 1.4; }' +
    '.pobox { margin: 20px 0 6px; }' +
    '.pobox table { border-collapse: collapse; }' +
    '.pobox td.lbl { border: 1px solid #000; font-weight: bold; padding: 8px 18px; font-size: 15px; text-align: center; }' +
    '.pobox td.val { border: 1px solid #000; padding: 8px 90px; font-size: 17px; font-weight: bold; text-align: center; }' +
    '.colhdr th { border-bottom: 1px solid #000; text-align: left; font-size: 13px; padding: 4px 4px 3px; font-weight: normal; }' +
    '.colhdr th.r { text-align: right; } .colhdr th.ctr { text-align: center; }' +
    'tbody td { padding: 2px 4px; font-size: 12.5px; vertical-align: middle; line-height: 1.2; }' +
    'td.c-item { white-space: nowrap; } td.c-cs, td.c-each { text-align: center; }' +
    'td.c-upc { text-align: center; font-size: 11px; }' +
    'td.c-upc .barcode svg { display: block; margin: 0 auto; height: 20px; width: auto; max-width: 100%; }' +
    'td.c-upc .barcode + .barcode { margin-top: 2px; }' +
    'td.c-price, td.c-total { text-align: right; white-space: nowrap; }' +
    '.contd { text-align: center; font-size: 12px; font-weight: bold; margin: 14px 0 14px; }' +
    /* Contains-below sub-lines under a shipper item */
    'tr.containrow td { padding-top: 0; padding-bottom: 4px; vertical-align: top; }' +
    '.contains-lbl { font-size: 12px; font-style: italic; margin: 0 0 2px; }' +
    '.contain-item { display: flex; align-items: center; gap: 12px; padding: 1px 0; }' +
    '.contain-name { font-size: 12px; min-width: 130px; }' +
    '.contain-bc .barcode svg { display: block; height: 24px; width: auto; }' +
    '.pg-footer { position: absolute; left: 0.4in; right: 0.4in; bottom: 0.3in; }' +
    '.totals { width: 100%; }' +
    '.tf-left { font-size: 14px; line-height: 1.9; vertical-align: bottom; }' +
    '.tf-right { vertical-align: bottom; }' +
    '.tf-right table { border-collapse: collapse; margin-left: auto; }' +
    '.tf-right td { padding: 4px 12px; font-size: 15px; }' +
    '.tf-right td.lbl { text-align: center; } .tf-right td.amt { text-align: right; white-space: nowrap; }' +
    '.tf-right tr.grand td { font-weight: bold; }' +
    '.sigrow { width: 100%; margin-top: 16px; }' +
    '.sigrow td { text-align: center; font-size: 11px; border-top: 1px solid #000; padding-top: 3px; }' +
    '.pnum { text-align: right; font-size: 10px; color: #444; font-family: Arial, sans-serif; margin-top: 6px; }' +
    '@media print { html, body { background: #fff; } .no-print { display: none; }' +
    ' .page { margin: 0; box-shadow: none; page-break-after: always; }' +
    ' .page:last-child { page-break-after: auto; }' +
    ' .barcode svg { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }' +
    '@page { size: letter; margin: 0; }';

  const script =
    '(function(){' +
    'var HDR=' + JSON.stringify(HDR) + ',TOT=' + JSON.stringify(TOT) + ',SIG=' + JSON.stringify(SIG) + ',COLG=' + JSON.stringify(COLG) + ',COLH=' + JSON.stringify(COLH) + ';' +
    'var pagesEl=document.getElementById("pages"),tpl=document.getElementById("rowsrc");' +
    'var srcRows=Array.prototype.slice.call((tpl.content||tpl).querySelectorAll("tr"));' +
    'function newPage(){var pg=document.createElement("div");pg.className="page";' +
    'pg.innerHTML=\'<div class="pg-head">\'+HDR+\'</div><table class="sheet">\'+COLG+\'<thead>\'+COLH+\'</thead><tbody class="rowbody"></tbody></table><div class="pg-footer"></div>\';' +
    'pagesEl.appendChild(pg);return pg;}' +
    'var probe=newPage();probe.querySelector(".pg-footer").innerHTML=\'<div class="contd">Continued</div>\'+TOT+SIG+\'<div class="pnum">Page 1 of 1</div>\';' +
    'var footerH=probe.querySelector(".pg-footer").offsetHeight;pagesEl.removeChild(probe);' +
    'var RESERVE=footerH-6;' +
    'var pg=newPage(),tbody=pg.querySelector("tbody.rowbody");' +
    'function over(){var tb=pg.querySelector("table.sheet").getBoundingClientRect(),pr=pg.getBoundingClientRect();return tb.bottom>(pr.bottom-(0.3*96)-RESERVE);}' +
    'for(var i=0;i<srcRows.length;i++){var r=srcRows[i];tbody.appendChild(r);' +
    'if(over()&&tbody.children.length>1){' +
    'var isContain=r.className.indexOf("containrow")>=0;' +
    'var prev=isContain?r.previousElementSibling:null;' +
    'tbody.removeChild(r);if(prev&&prev.parentNode===tbody)tbody.removeChild(prev);' +
    'pg=newPage();tbody=pg.querySelector("tbody.rowbody");' +
    'if(prev)tbody.appendChild(prev);tbody.appendChild(r);}' +
    '}' +
    'var all=pagesEl.querySelectorAll(".page"),N=all.length;' +
    'for(var p=0;p<N;p++){var cont=(p<N-1)?\'<div class="contd">Continued</div>\':"";' +
    'all[p].querySelector(".pg-footer").innerHTML=cont+TOT+SIG+\'<div class="pnum">Page \'+(p+1)+\' of \'+N+\'</div>\';}' +
    '})();';

  win.document.write('<!doctype html><html><head><meta charset="utf-8" /><title>Invoice ' + invoiceNumberFor(order) + '</title><style>' + style + '</style></head><body>' +
    '<button class="printBtn no-print" onclick="window.print()">Print / Save as PDF</button>' +
    '<div id="pages"></div>' +
    '<template id="rowsrc"><table><tbody>' + rows + '</tbody></table></template>' +
    '<script>' + script + '<\/script></body></html>');
  win.document.close();
  win.focus();
}

// Item numbers are stored brand-prefixed (e.g. "Ritter Sport:2146") because
// that's the real DB key used for API calls, matching, and cart ops. For
// DISPLAY ONLY, strip the brand prefix so users just see the bare code
// ("2146"). Never use this where the value is used as a key.
// Tolerant match score of query vs text: higher = better. Handles exact,
// prefix, substring, per-word matches, subsequence (typos/skips), and small
// edit-distance so misspellings still surface the best customer.
// --- CSV helpers for bulk inventory export/import ---
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
// One-time "app was updated" notice. The build bakes in __BUILD_ID__; this polls
// /version.json and, when the deployed id differs (a new deploy happened), shows
// a dismissible refresh prompt. Won't nag again for the same version once dismissed.
const APP_BUILD_ID = (typeof __BUILD_ID__ !== 'undefined') ? __BUILD_ID__ : 'dev';
function UpdateNotice() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let stopped = false;
    async function check() {
      try {
        const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) return;
        const { buildId } = await r.json();
        if (stopped || !buildId) return;
        if (buildId !== APP_BUILD_ID) {
          let dismissed = null;
          try { dismissed = localStorage.getItem('updateDismissed'); } catch { /* ignore */ }
          if (dismissed !== buildId) setShow(true);
        }
      } catch { /* offline or not deployed yet — ignore */ }
    }
    check();
    const iv = setInterval(check, 120000); // every 2 min
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => { stopped = true; clearInterval(iv); window.removeEventListener('focus', onFocus); };
  }, []);

  async function dismiss() {
    try {
      const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
      const { buildId } = await r.json();
      if (buildId) localStorage.setItem('updateDismissed', buildId);
    } catch { /* ignore */ }
    setShow(false);
  }

  if (!show) return null;
  return (
    <div style={updateStyles.wrap}>
      <div style={updateStyles.card}>
        <div style={updateStyles.title}>App updated</div>
        <div style={updateStyles.body}>A new version is available. Refresh to get the latest.</div>
        <div style={updateStyles.actions}>
          <button style={updateStyles.later} onClick={dismiss}>Later</button>
          <button style={updateStyles.refresh} onClick={() => window.location.reload(true)}>Refresh now</button>
        </div>
      </div>
    </div>
  );
}
const updateStyles = {
  wrap: { position: 'fixed', left: 0, right: 0, bottom: 0, display: 'flex', justifyContent: 'center', padding: 16, zIndex: 200, pointerEvents: 'none' },
  card: { pointerEvents: 'auto', background: '#14181F', color: '#F7F8F4', borderRadius: 14, padding: '14px 18px', boxShadow: '0 12px 40px rgba(20,24,31,0.45)', maxWidth: 440, width: '100%', fontFamily: "'Inter', system-ui, sans-serif" },
  title: { fontSize: 15, fontWeight: 800 },
  body: { fontSize: 13.5, color: '#C7CBC1', marginTop: 3 },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 },
  later: { background: 'transparent', color: '#C7CBC1', border: '1px solid #3A3F49', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  refresh: { background: '#5B9A86', color: '#0F1A16', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' },
};

// Catches render errors in a subtree so one broken screen doesn't white out the
// whole app. Shows the error message (useful for diagnosing) and a reset link.
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { try { console.error('Screen error:', error, info); } catch (e) { /* ignore */ } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: "'Inter', system-ui, sans-serif" }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: '#B5493B', marginBottom: 8 }}>Something went wrong on this screen</div>
          <div style={{ fontSize: 13, color: '#5B6058', marginBottom: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{String(this.state.error && this.state.error.message || this.state.error)}</div>
          <button style={{ background: '#2B5D50', color: '#F7F8F4', border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }} onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}

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
      const [itemsData, customersData, itemsAllData, customersAllData, ordersData, brandColorsData, printOrderData, brandSettingsData, incomingData] = await Promise.all([
        apiGet('/items'),
        apiGet('/customers'),
        apiGet('/items?includeInactive=true'),
        apiGet('/customers?includeInactive=true'),
        apiGet('/orders'),
        apiGet('/brand-colors'),
        apiGet('/print-order'),
        apiGet('/brand-settings').catch(() => ({})),
        apiGet('/purchase-orders/incoming').catch(() => ({})),
      ]);
      // Load the invoice-number offset (aligns printed # + QuickBooks RefNumber).
      apiGet('/orders/invoice-offset').then(d => { if (d && typeof d.offset === 'number') INVOICE_OFFSET = d.offset; }).catch(() => {});
      const incoming = incomingData || {};
      const withIncoming = arr => arr.map(it => (incoming[it.id] ? { ...it, incoming: incoming[it.id] } : it));
      setItems(withIncoming(itemsData));
      setCustomers(customersData);
      setItemsAll(withIncoming(itemsAllData));
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
        <UpdateNotice />
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
        <ErrorBoundary key={tab}>
        {tab === 'order' && (
          <OrderTab items={items} customers={customers} customersAll={customersAll} orders={orderHistory} brandColors={brandColors} printSequence={printSequence} onOrderSubmitted={loadAll} />
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
        </ErrorBoundary>
      </div>
      <TabBar active={tab} onChange={setTab} />
      <UpdateNotice />
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
// Editable quantity field for a line on the order-ticket / review screen. Lets
// the user type a number; commits (clamped to stock) on blur/Enter.
function TicketQtyInput({ qty, onSet, disabled }) {
  const [val, setVal] = useState(String(qty));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setVal(String(qty)); }, [qty, editing]);
  function commit() {
    setEditing(false);
    const n = parseInt(val, 10);
    if (Number.isNaN(n)) { setVal(String(qty)); return; }
    onSet(Math.max(0, n));
  }
  return (
    <div style={styles.ticketQtyWrap}>
      <span style={styles.ticketQtyX}>×</span>
      <input
        style={styles.ticketQtyInput}
        value={val}
        disabled={disabled}
        inputMode="numeric"
        onFocus={e => { setEditing(true); e.target.select(); }}
        onChange={e => setVal(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setVal(String(qty)); e.currentTarget.blur(); } }}
      />
    </div>
  );
}

// Desktop bulk entry: a QuickBooks-style grid. Type an item # (or search),
// enter cases, and it builds the order. Uses the store's catalog prices and
// warns (amber) on items not in the store's catalog.
function QuickEntryGrid({ allItems, catalog, priceOf, orderLines, setQty, onSetQty, setUnit, removeLine, desktop }) {
  const BLANK_ROWS = 8;
  // Each entry row has its own draft text + dropdown highlight index.
  const [drafts, setDrafts] = useState(() => Array.from({ length: BLANK_ROWS }, () => ''));
  const [activeRow, setActiveRow] = useState(null);   // which entry row's dropdown is open
  const [hi, setHi] = useState(0);                     // highlighted match index
  const codeRefs = useRef([]);
  const qtyRefs = useRef([]);

  const inCatalog = (id) => !catalog || !catalog.ids || catalog.ids.has(id);
  const matchesFor = (text) => {
    const c = (text || '').trim().toLowerCase();
    if (!c) return [];
    const starts = [], contains = [];
    for (const i of allItems) {
      const code = displayCode(i.id).toLowerCase();
      if (code === c) return [i]; // exact code → single match
      if (code.startsWith(c) || i.name.toLowerCase().startsWith(c)) starts.push(i);
      else if (code.includes(c) || i.name.toLowerCase().includes(c)) contains.push(i);
    }
    return [...starts, ...contains].slice(0, 50);
  };
  function setDraft(rowIdx, text) {
    setDrafts(prev => { const n = [...prev]; n[rowIdx] = text; return n; });
    setActiveRow(rowIdx); setHi(0);
  }
  function focusQty(itemId) {
    let tries = 0;
    const tryFocus = () => {
      const q = qtyRefs.current[itemId];
      if (q) { q.focus(); q.select && q.select(); q.scrollIntoView({ block: 'center' }); return; }
      if (tries++ < 10) requestAnimationFrame(tryFocus);
    };
    requestAnimationFrame(tryFocus);
  }
  function focusFirstEmptyCode() {
    const idx = drafts.findIndex(d => !d.trim());
    const ref = codeRefs.current[idx >= 0 ? idx : 0];
    if (ref) { ref.focus(); ref.scrollIntoView({ block: 'center' }); }
  }
  function pickForRow(rowIdx, item) {
    if (!item) return;
    if (!orderLines.some(l => l.id === item.id)) {
      // Out-of-stock items still go on the order, but at 0 (a placeholder);
      // in-stock items start at 1.
      if ((Number(item.stock) || 0) <= 0) onSetQty(item.id, 0);
      else setQty(item.id, 1);
    }
    setDrafts(prev => { const n = [...prev]; n[rowIdx] = ''; return n; });
    setActiveRow(null); setHi(0);
    focusQty(item.id); // focus the new line's Cases field once it renders
  }
  function onCodeKey(e, rowIdx) {
    // Always match against the CURRENT input value (avoids stale state on fast typing).
    const text = e.currentTarget.value;
    const ms = matchesFor(text);
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveRow(rowIdx); setHi(h => Math.min(h + 1, ms.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); return; }
    // Tab or Enter: if anything was typed and there's any match, take the
    // highlighted match for THIS row (or the closest/first) and jump to Cases.
    if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'Enter') {
      if (text.trim() && ms.length > 0) {
        e.preventDefault();
        const idx = (activeRow === rowIdx) ? Math.min(Math.max(hi, 0), ms.length - 1) : 0;
        pickForRow(rowIdx, ms[idx]);
      }
      // truly empty row → let Tab fall through to the next field normally
      return;
    }
    if (e.key === 'Escape') { setActiveRow(null); }
  }
  function onQtyKey(e, itemId, isLastLine) {
    if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      focusFirstEmptyCode();
    }
  }

  const totalCases = orderLines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const totalEach = orderLines.reduce((s, l) => s + (l.unit === 'case' ? 0 : (Number(l.qty) || 0) * (Number(l.pack) || 1)), 0);
  const totalAmt = orderLines.reduce((s, l) => s + lineTotal(l, l.qty), 0);
  // Hide the EACH column while every ordered line is a case.
  const showEach = orderLines.length === 0 ? true : !orderLines.every(l => l.unit === 'case');

  return (
    <div style={qeStyles.wrap}>
      <div style={qeStyles.hint}>Type an item # or name, press <b>Tab</b> to pick the highlighted match and jump to Cases, then <b>Tab</b> to the next row.</div>
      <table style={qeStyles.table}>
        <thead><tr>
          <th style={{ ...qeStyles.th, width: 130 }}>Item #</th>
          <th style={qeStyles.th}>Description</th>
          <th style={{ ...qeStyles.th, textAlign: 'center', width: 90 }}>Unit</th>
          <th style={{ ...qeStyles.th, textAlign: 'right', width: 80 }}>Qty</th>
          {showEach && <th style={{ ...qeStyles.th, textAlign: 'right', width: 70 }}>Each</th>}
          <th style={{ ...qeStyles.th, textAlign: 'right', width: 90 }}>Price/ea</th>
          <th style={{ ...qeStyles.th, textAlign: 'right', width: 100 }}>Total</th>
          <th style={{ ...qeStyles.th, width: 34 }} />
        </tr></thead>
        <tbody>
          {orderLines.map((l, i) => {
            const warn = !inCatalog(l.id);
            const oos = (Number(l.stock) || 0) <= 0;
            const pack = Number(l.pack) || 1;
            return (
              <tr key={l.id} style={oos ? qeStyles.oosRow : (warn ? qeStyles.warnRow : undefined)}>
                <td style={qeStyles.td}>{displayCode(l.id)}</td>
                <td style={qeStyles.td}>
                  {l.name}
                  {oos && <span style={qeStyles.oosTag} title="Out of stock — added at 0 as a backorder placeholder">out of stock</span>}
                  {oos && l.incoming > 0 && <span style={qeStyles.incomingTag} title="Incoming from a purchase order">+{l.incoming} incoming</span>}
                  {warn && !oos && <span style={qeStyles.warnTag} title="Not in this store's catalog">not in catalog</span>}
                </td>
                <td style={{ ...qeStyles.td, textAlign: 'center' }}>
                  {l.caseSize ? (
                    <div style={qeStyles.unitToggle}>
                      <button
                        style={{ ...qeStyles.unitBtn, ...((l.unit || 'box') === 'box' ? qeStyles.unitBtnOn : {}) }}
                        tabIndex={-1}
                        onClick={() => setUnit(l.id, 'box')}
                      >Box</button>
                      <button
                        style={{ ...qeStyles.unitBtn, ...(l.unit === 'case' ? qeStyles.unitBtnOn : {}) }}
                        tabIndex={-1}
                        onClick={() => setUnit(l.id, 'case')}
                      >Case</button>
                    </div>
                  ) : <span style={{ fontSize: 12, color: '#B9BDB2' }}>ea</span>}
                </td>
                <td style={{ ...qeStyles.td, textAlign: 'right' }}>
                  <input
                    ref={el => { qtyRefs.current[l.id] = el; }}
                    style={qeStyles.qtyInput}
                    value={l.qty}
                    inputMode="numeric"
                    onFocus={e => e.target.select()}
                    onChange={e => {
                      const n = parseInt(e.target.value.replace(/[^0-9]/g, ''), 10) || 0;
                      onSetQty(l.id, n);
                    }}
                    onKeyDown={e => onQtyKey(e, l.id, i === orderLines.length - 1)}
                  />
                </td>
                {showEach && <td style={{ ...qeStyles.td, textAlign: 'right', color: '#8A8F87' }}>{(Number(l.qty) || 0) * pack}</td>}
                <td style={{ ...qeStyles.td, textAlign: 'right', color: '#8A8F87' }}>{formatMoney(l.price)}</td>
                <td style={{ ...qeStyles.td, textAlign: 'right', fontWeight: 700 }}>{formatMoney(lineTotal(l, l.qty))}</td>
                <td style={{ ...qeStyles.td, textAlign: 'center' }}>
                  <button style={qeStyles.rm} tabIndex={-1} onClick={() => removeLine(l.id)} title="Remove">×</button>
                </td>
              </tr>
            );
          })}
          {/* blank entry rows */}
          {drafts.map((text, rowIdx) => {
            const ms = activeRow === rowIdx ? matchesFor(text) : [];
            const preview = (activeRow === rowIdx && text.trim() && ms.length > 0)
              ? ms[Math.min(Math.max(hi, 0), ms.length - 1)]
              : null;
            return (
              <tr key={`draft-${rowIdx}`} style={preview ? qeStyles.previewRow : undefined}>
                <td style={qeStyles.td}>
                  <div style={{ position: 'relative' }}>
                    <input
                      ref={el => { codeRefs.current[rowIdx] = el; }}
                      style={qeStyles.codeInput}
                      placeholder={rowIdx === 0 && orderLines.length === 0 ? 'Type item # or name…' : ''}
                      value={text}
                      onChange={e => setDraft(rowIdx, e.target.value)}
                      onFocus={e => { setActiveRow(rowIdx); setHi(0); e.currentTarget.scrollIntoView({ block: 'center' }); }}
                      onKeyDown={e => onCodeKey(e, rowIdx)}
                    />
                    {activeRow === rowIdx && text.trim() && ms.length > 0 && (
                      <div style={qeStyles.dropdown}>
                        {ms.map((it, mi) => {
                          const isHi = mi === Math.min(hi, ms.length - 1);
                          return (
                          <button
                            key={it.id}
                            ref={isHi ? (el => { if (el) el.scrollIntoView({ block: 'nearest' }); }) : undefined}
                            style={{ ...qeStyles.matchRow, ...(isHi ? qeStyles.matchRowHi : {}) }}
                            onMouseEnter={() => setHi(mi)}
                            onMouseDown={e => { e.preventDefault(); pickForRow(rowIdx, it); }}
                          >
                            <span style={qeStyles.matchCode}>{displayCode(it.id)}</span>
                            <span style={qeStyles.matchName}>{it.name}</span>
                            {(Number(it.stock) || 0) <= 0 && <span style={qeStyles.oosTag}>out of stock</span>}
                            {!inCatalog(it.id) && (Number(it.stock) || 0) > 0 && <span style={qeStyles.warnTag}>not in catalog</span>}
                          </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </td>
                {/* live preview of the best-fitting item as you type */}
                <td style={{ ...qeStyles.td, color: '#5B6058' }}>
                  {preview ? (
                    <span>
                      <span style={{ color: '#8A8F87', fontWeight: 700, marginRight: 8 }}>{displayCode(preview.id)}</span>
                      {preview.name}
                      {(Number(preview.stock) || 0) <= 0 && <span style={qeStyles.oosTag}>out of stock</span>}
                      {!inCatalog(preview.id) && (Number(preview.stock) || 0) > 0 && <span style={qeStyles.warnTag}>not in catalog</span>}
                    </span>
                  ) : null}
                </td>
                <td style={qeStyles.td} />
                <td style={{ ...qeStyles.td, textAlign: 'right', color: '#B9BDB2' }}>{preview ? '—' : ''}</td>
                {showEach && <td style={{ ...qeStyles.td, textAlign: 'right', color: '#B9BDB2' }}>{preview ? (Number(preview.pack) || 1) : ''}</td>}
                <td style={{ ...qeStyles.td, textAlign: 'right', color: '#B9BDB2' }}>{preview ? formatMoney(preview.price) : ''}</td>
                <td style={qeStyles.td} colSpan={2} />
              </tr>
            );
          })}
        </tbody>
        <tfoot><tr>
          <td style={qeStyles.tfoot} colSpan={3}>Totals</td>
          <td style={{ ...qeStyles.tfoot, textAlign: 'right' }}>{totalCases}</td>
          {showEach && <td style={{ ...qeStyles.tfoot, textAlign: 'right' }}>{totalEach}</td>}
          <td style={qeStyles.tfoot} />
          <td style={{ ...qeStyles.tfoot, textAlign: 'right' }}>{formatMoney(totalAmt)}</td>
          <td style={qeStyles.tfoot} />
        </tr></tfoot>
      </table>
    </div>
  );
}

const qeStyles = {
  wrap: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 16px 120px' },
  hint: { fontSize: 12, color: '#8A8F87', padding: '2px 2px 8px' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13.5 },
  th: { textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#8A8F87', textTransform: 'uppercase', letterSpacing: '0.03em', padding: '6px 8px', borderBottom: '1px solid #E3E1D6' },
  td: { padding: '5px 8px', borderBottom: '1px solid #F0EEE6', color: '#14181F' },
  warnRow: { background: '#FDF6EC' },
  previewRow: { background: '#F3F6F4' },
  oosRow: { background: '#FBEEE7' },
  oosTag: { marginLeft: 8, fontSize: 10.5, fontWeight: 700, color: '#B5493B', background: '#F8DCD2', border: '1px solid #E6C6B4', borderRadius: 20, padding: '1px 7px' },
  incomingTag: { marginLeft: 8, fontSize: 10.5, fontWeight: 700, color: '#2B5D50', background: '#EAF1EE', border: '1px solid #C4DDD2', borderRadius: 20, padding: '1px 7px' },
  unitToggle: { display: 'inline-flex', border: '1px solid #D6D3C6', borderRadius: 7, overflow: 'hidden' },
  unitBtn: { background: '#FFFFFF', border: 'none', padding: '4px 9px', fontSize: 12, fontWeight: 700, color: '#8A8F87', cursor: 'pointer', fontFamily: 'inherit' },
  unitBtnOn: { background: '#2B5D50', color: '#F7F8F4' },
  warnTag: { marginLeft: 8, fontSize: 10.5, fontWeight: 700, color: '#B5793B', background: '#FBEED9', border: '1px solid #EAD3A8', borderRadius: 20, padding: '1px 7px' },
  qtyInput: { width: 60, textAlign: 'right', background: '#F7F8F4', border: '1px solid #D6D3C6', borderRadius: 6, padding: '5px 7px', fontSize: 13.5, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", outline: 'none' },
  codeInput: { width: '100%', background: '#FFFFFF', border: '1px solid #D6D3C6', borderRadius: 7, padding: '7px 10px', fontSize: 13.5, fontFamily: 'inherit', outline: 'none' },
  dropdown: { position: 'absolute', left: 0, top: '100%', marginTop: 3, minWidth: 480, width: 'max-content', maxWidth: '70vw', background: '#FFFFFF', border: '1px solid #D6D3C6', borderRadius: 10, boxShadow: '0 14px 36px rgba(20,24,31,0.22)', zIndex: 8, padding: 6, maxHeight: 340, overflowY: 'auto' },
  matchRow: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '10px 12px', fontSize: 13.5, color: '#14181F', cursor: 'pointer', fontFamily: 'inherit', borderRadius: 7, whiteSpace: 'nowrap' },
  matchRowHi: { background: '#EAF1EE' },
  matchCode: { fontWeight: 800, color: '#2B5D50', minWidth: 84, flexShrink: 0, fontFamily: "'JetBrains Mono', monospace" },
  matchName: { overflow: 'hidden', textOverflow: 'ellipsis' },
  rm: { width: 26, height: 26, borderRadius: 6, border: '1px solid #E6C6B4', background: '#FBEEE7', color: '#B5493B', fontSize: 15, fontWeight: 700, cursor: 'pointer', lineHeight: 1 },
  tfoot: { padding: '9px 8px', borderTop: '2px solid #14181F', fontWeight: 800, fontSize: 14, color: '#14181F' },
};

// Three-box date entry: MM / DD / YY. Typing auto-advances (2 digits in a box
// jumps to the next); commits to an ISO date whenever all three are valid.
function DateBoxes({ value, onChange, firstRef }) {
  const parts = value ? value.split('-') : ['', '', ''];
  const [mm, setMm] = useState(value ? String(Number(parts[1])) : '');
  const [dd, setDd] = useState(value ? String(Number(parts[2])) : '');
  const [yy, setYy] = useState(value ? parts[0].slice(2) : '');
  const mRef = useRef(null), dRef = useRef(null), yRef = useRef(null);
  useEffect(() => { if (firstRef) firstRef.current = mRef.current; }, [firstRef]);
  // Only re-sync from `value` when it's cleared elsewhere; otherwise let the user
  // type freely (don't clobber in-progress input with padded values).
  useEffect(() => {
    if (!value) { setMm(''); setDd(''); setYy(''); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function commit(m, d, y) {
    const mo = Number(m), day = Number(d);
    if (m && d && y && y.length === 2 && mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
      onChange(`20${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }
  }
  const digits = s => s.replace(/[^0-9]/g, '');
  // When a box already has 2 digits and is fully selected, a new keystroke
  // should start over. React's controlled input + select() handles most of it;
  // we just take the last 2 digits typed so it never gets "stuck".
  const take2 = raw => digits(raw).slice(-2);
  return (
    <div style={dateBoxStyles.wrap}>
      <input ref={mRef} style={dateBoxStyles.box} placeholder="MM" value={mm} inputMode="numeric"
        onFocus={e => e.target.select()}
        onChange={e => { const v = take2(e.target.value); setMm(v); commit(v, dd, yy); if (v.length === 2 && dRef.current) { dRef.current.focus(); dRef.current.select(); } }} />
      <span style={dateBoxStyles.sep}>/</span>
      <input ref={dRef} style={dateBoxStyles.box} placeholder="DD" value={dd} inputMode="numeric"
        onFocus={e => e.target.select()}
        onChange={e => { const v = take2(e.target.value); setDd(v); commit(mm, v, yy); if (v.length === 2 && yRef.current) { yRef.current.focus(); yRef.current.select(); } }}
        onKeyDown={e => { if (e.key === 'Backspace' && !dd && mRef.current) mRef.current.focus(); }} />
      <span style={dateBoxStyles.sep}>/</span>
      <input ref={yRef} style={dateBoxStyles.box} placeholder="YY" value={yy} inputMode="numeric"
        onFocus={e => e.target.select()}
        onChange={e => { const v = take2(e.target.value); setYy(v); commit(mm, dd, v); }}
        onKeyDown={e => { if (e.key === 'Backspace' && !yy && dRef.current) dRef.current.focus(); }} />
    </div>
  );
}
const dateBoxStyles = {
  wrap: { display: 'inline-flex', alignItems: 'center', gap: 1 },
  box: { width: 30, textAlign: 'center', background: 'transparent', border: 'none', outline: 'none', fontSize: 14, fontWeight: 600, color: '#14181F', fontFamily: 'inherit' },
  sep: { color: '#8A8F87', fontSize: 14 },
};

// Compact month calendar that drops down from the date field. Click a day to pick.
function MiniCalendar({ value, onPick, onClose }) {
  const today = new Date();
  const initial = value ? (() => { const [y, m] = value.split('-').map(Number); return { y, m: m - 1 }; })() : { y: today.getFullYear(), m: today.getMonth() };
  const [view, setView] = useState(initial);
  const wrapRef = useRef(null);
  useEffect(() => {
    function onDoc(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) onClose(); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  const first = new Date(view.y, view.m, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const monthName = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const selISO = value;
  const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const shift = delta => setView(v => { const dt = new Date(v.y, v.m + delta, 1); return { y: dt.getFullYear(), m: dt.getMonth() }; });

  return (
    <div ref={wrapRef} style={calStyles.pop}>
      <div style={calStyles.head}>
        <button style={calStyles.nav} tabIndex={-1} onClick={() => shift(-1)}>‹</button>
        <span style={calStyles.month}>{monthName}</span>
        <button style={calStyles.nav} tabIndex={-1} onClick={() => shift(1)}>›</button>
      </div>
      <div style={calStyles.grid}>
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={'h' + i} style={calStyles.dow}>{d}</div>)}
        {cells.map((d, i) => {
          if (d == null) return <div key={'e' + i} />;
          const iso = `${view.y}-${String(view.m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          const isSel = iso === selISO, isToday = iso === todayISO;
          return (
            <button
              key={iso}
              tabIndex={-1}
              style={{ ...calStyles.day, ...(isSel ? calStyles.daySel : (isToday ? calStyles.dayToday : {})) }}
              onClick={() => onPick(iso)}
            >{d}</button>
          );
        })}
      </div>
      <button style={calStyles.todayBtn} tabIndex={-1} onClick={() => onPick(todayISO)}>Today</button>
    </div>
  );
}
const calStyles = {
  pop: { position: 'absolute', top: '100%', right: 0, marginTop: 6, width: 250, background: '#FFFFFF', border: '1px solid #D6D3C6', borderRadius: 12, boxShadow: '0 16px 40px rgba(20,24,31,0.22)', zIndex: 40, padding: 10, fontFamily: "'Inter', system-ui, sans-serif" },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  nav: { background: '#F0EEE4', border: '1px solid #E3E1D6', borderRadius: 8, width: 28, height: 28, fontSize: 16, cursor: 'pointer', color: '#14181F', lineHeight: 1 },
  month: { fontSize: 13.5, fontWeight: 700, color: '#14181F' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 },
  dow: { textAlign: 'center', fontSize: 10.5, fontWeight: 700, color: '#8A8F87', padding: '2px 0' },
  day: { aspectRatio: '1', border: 'none', background: 'none', borderRadius: 8, fontSize: 12.5, color: '#14181F', cursor: 'pointer', fontFamily: 'inherit' },
  daySel: { background: '#2B5D50', color: '#F7F8F4', fontWeight: 700 },
  dayToday: { border: '1px solid #C4DDD2', fontWeight: 700, color: '#2B5D50' },
  todayBtn: { marginTop: 8, width: '100%', background: '#EAF1EE', border: '1px solid #C4DDD2', color: '#2B5D50', borderRadius: 8, padding: '6px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
};

function OrderTab({ items, customers, customersAll, orders, brandColors, printSequence, onOrderSubmitted, desktop = false, editOrder = null, onClose = null }) {
  const isEdit = !!editOrder;
  // Look up a customer by id across the active list and the full list (so desktop
  // quick entry can select inactive customers too).
  const allCustList = (customersAll && customersAll.length) ? customersAll : customers;
  const findCust = (id) => customers.find(c => c.id === id) || allCustList.find(c => c.id === id);
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
  // Distributor mode: new lines default to case; EACH column hides while all cases.
  const [distributor, setDistributor] = useState(false);
  const [distributorTouched, setDistributorTouched] = useState(false);
  // Per-store catalog: which items this customer carries + their per-each prices.
  // catalog === null means "not loaded / no customer"; catalog.off means the
  // store has no catalog set up (field shows nothing).
  const [catalog, setCatalog] = useState(null);
  useEffect(() => {
    if (customerId == null) { setCatalog(null); return; }
    const cust = findCust(customerId);
    // A customer with catalog_on = false shows nothing until configured.
    if (cust && cust.catalogOn === false) { setCatalog({ off: true, ids: new Set(), prices: new Map(), units: new Map() }); return; }
    let cancelled = false;
    apiGet(`/customers/${customerId}/catalog`)
      .then(d => {
        if (cancelled) return;
        const prices = new Map();
        const units = new Map();
        for (const o of (d.overrides || [])) {
          if (o.present && o.price != null) prices.set(o.item_id, o.price);
          if (o.present && o.unit) units.set(o.item_id, o.unit);
        }
        setCatalog({ off: !d.catalogOn, ids: new Set(d.itemIds || []), prices, units });
      })
      .catch(() => { if (!cancelled) setCatalog(null); });
    return () => { cancelled = true; };
  }, [customerId, customers]);
  // The store's default unit for an item ('box' | 'case'), fallback 'box'.
  const unitOf = React.useCallback((item) => {
    if (distributor && item.caseSize) return 'case';
    if (catalog && catalog.units && catalog.units.has(item.id)) return catalog.units.get(item.id);
    return 'box';
  }, [catalog, distributor]);
  // Eaches per ordered unit for an item at a given unit.
  const packFor = React.useCallback((item, unit) => {
    if (unit === 'case' && item.caseSize) return (Number(item.pack) || 1) * item.caseSize;
    return Number(item.pack) || 1;
  }, []);
  // Effective per-each price for an item at a given unit for the selected customer.
  const priceOf = React.useCallback((item, unit) => {
    const u = unit || unitOf(item);
    // The store's catalog price applies to their default unit.
    if (catalog && catalog.prices.has(item.id) && unitOf(item) === u) return catalog.prices.get(item.id);
    if (u === 'case') return Number(item.casePrice != null ? item.casePrice : item.price) || 0;
    return Number(item.price) || 0;
  }, [catalog, unitOf]);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [customerQuery, setCustomerQuery] = useState('');
  // Desktop keyboard flow: type-to-filter customer, Tab to accept + go to date.
  const [comboText, setComboText] = useState('');
  const [comboOpen, setComboOpen] = useState(false);
  const [comboHi, setComboHi] = useState(0);
  const dateInputRef = useRef(null);
  const [dateText, setDateText] = useState('');
  const [dateFocused, setDateFocused] = useState(false);
  const [calOpen, setCalOpen] = useState(false);
  const [customerDayFilter, setCustomerDayFilter] = useState(null); // 0-6, or null for all
  // Mobile only: field reps see just the "show on mobile" customers unless they
  // opt into all. Desktop always shows everyone.
  const [showAllCustomers, setShowAllCustomers] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState(isEdit ? editOrder.deliveryDate : (savedDraft.deliveryDate || todayISODate()));
  // Custom PO# override. Empty string means "use the auto value"; once the user
  // edits it, poEdited flips and we keep their value.
  const [poNumber, setPoNumber] = useState(isEdit ? (editOrder.poNumber || '') : '');
  const [poEdited, setPoEdited] = useState(isEdit && !!editOrder.poNumber);
  // Editable invoice number. Auto = next id + offset; override saves on the order.
  const [invNumber, setInvNumber] = useState(isEdit ? (editOrder.invoiceNumber != null ? String(editOrder.invoiceNumber) : '') : '');
  const [invEdited, setInvEdited] = useState(isEdit && editOrder.invoiceNumber != null);
  const [dateOpen, setDateOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [brand, setBrand] = useState('All');
  const [query, setQuery] = useState('');
  const [screen, setScreen] = useState('brands');
  const [showAllItems, setShowAllItems] = useState(false); // escape hatch: show full catalog, not just the store's
  const [quickEntry, setQuickEntry] = useState(desktop && !editOrder); // desktop default: QuickBooks-style grid entry
  // Adopt the customer's "is distributor" default (unless manually toggled).
  useEffect(() => {
    if (distributorTouched) return;
    const cust = findCust(customerId);
    setDistributor(!!(cust && cust.isDistributor));
  }, [customerId, customers, distributorTouched]);
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

  const customerName = findCust(customerId)?.name
    || (isEdit && editOrder.customerId === customerId ? editOrder.customer : '')
    || '';
  // Auto PO# = MMDDYY(delivery date)-<customer abbreviation>.
  const autoPo = useMemo(() => {
    // Fill in as soon as a customer is chosen. Uses TODAY's date (MMDDYY) plus
    // the customer's abbreviation when they have one.
    if (customerId == null) return '';
    const cust = findCust(customerId);
    const abbr = (cust && cust.abbreviation || '').trim();
    const [y, m, d] = todayISODate().split('-');
    const mmddyy = `${m}${d}${y.slice(2)}`;
    return abbr ? `${mmddyy}-${abbr}` : mmddyy;
  }, [customers, customerId]);
  const poValue = poEdited ? poNumber : autoPo;
  // Next invoice number = (highest existing order id + 1) + offset. In edit mode
  // it's the order's own number.
  const autoInv = useMemo(() => {
    if (isEdit) return invoiceNumberFor(editOrder);
    const maxId = (orders && orders.length) ? Math.max(...orders.map(o => Number(o.id) || 0)) : 0;
    return (maxId + 1) + (INVOICE_OFFSET || 0);
  }, [orders, isEdit, editOrder]);
  const invValue = invEdited ? invNumber : String(autoInv);
  const filteredCustomers = useMemo(() => {
    const q = customerQuery.trim().toLowerCase();
    let active = customers.filter(c => c.active !== 0);
    // On mobile, show only "show on mobile" customers unless the rep opted into all.
    if (!desktop && !showAllCustomers) active = active.filter(c => !!c.showOnMobile && c.showOnMobile !== 0);
    if (customerDayFilter !== null) active = active.filter(c => c.deliveryDay === customerDayFilter);
    if (q) active = active.filter(c => c.name.toLowerCase().includes(q));
    return active;
  }, [customers, customerQuery, customerDayFilter, desktop, showAllCustomers]);
  // Desktop combobox: filter customers by the typed text (all customers on desktop).
  const comboMatches = useMemo(() => {
    const q = comboText.trim().toLowerCase();
    // Desktop quick entry can pick ANY customer (active or not).
    const source = (desktop && customersAll && customersAll.length) ? customersAll : customers;
    const pool = desktop ? source : source.filter(c => c.active !== 0);
    if (!q) return [...pool].sort((a, b) => a.name.localeCompare(b.name));
    const scored = pool
      .map(c => ({ c, s: fuzzyScore(q, c.name.toLowerCase()) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name));
    return scored.map(x => x.c);
  }, [customers, customersAll, comboText, desktop]);
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

  // In edit mode, keep the full item set. Otherwise, once a customer is chosen,
  // restrict to their catalog and apply their per-each prices.
  const catalogItems = useMemo(() => {
    if (isEdit || !catalog) return items;
    // Escape hatch: show every item (still apply the store's price if they have one).
    if (showAllItems) {
      return items.map(i => (catalog.prices.has(i.id) ? { ...i, price: catalog.prices.get(i.id) } : i));
    }
    if (catalog.off) return [];
    return items
      .filter(i => catalog.ids.has(i.id))
      .map(i => (catalog.prices.has(i.id) ? { ...i, price: catalog.prices.get(i.id) } : i));
  }, [items, catalog, isEdit, showAllItems]);

  const brandList = useMemo(() => Array.from(new Set(catalogItems.map(i => i.brand))), [catalogItems]);
  const brandCounts = useMemo(() => {
    const counts = {};
    catalogItems.forEach(i => { counts[i.brand] = (counts[i.brand] || 0) + 1; });
    return counts;
  }, [catalogItems]);
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
    const filtered = catalogItems.filter(i => {
      const brandMatch = effectiveBrand === 'All' || i.brand === effectiveBrand;
      const q = query.trim().toLowerCase();
      const queryMatch = !q || i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q);
      return brandMatch && queryMatch;
    });
    return sortItemsBy(filtered, sortBy, popularity, printSequence);
  }, [catalogItems, brand, query, screen, sortBy, popularity, printSequence]);

  const orderLines = useMemo(() => {
    const snap = {};
    if (isEdit) for (const l of editOrder.lines) snap[l.id] = l;
    return order.map(o => {
      let item = catalogItems.find(i => i.id === o.id) || items.find(i => i.id === o.id) || (isEdit ? snap[o.id] : null);
      if (!item) return null;
      // Ordering unit for this line: chosen on the line, else the store's default.
      const unit = o.unit || unitOf(item);
      const pack = packFor(item, unit);
      const price = priceOf(item, unit);
      return { ...item, qty: o.qty, checkin: !!o.checkin, unit, pack, price };
    }).filter(Boolean);
  }, [order, catalogItems, items, isEdit, editOrder, catalog, unitOf, packFor, priceOf]);

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
    // to current stock + whatever this order originally held. On desktop we allow
    // ordering beyond stock (stock can go negative — orders placed before restock).
    const maxQty = (item.stock || 0) + (isEdit ? (origQtyById[id] || 0) : 0);
    const clamped = desktop ? Math.max(0, qty) : Math.max(0, Math.min(qty, maxQty));
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

  // Like setQty, but going to 0 keeps the line on the order at qty 0 (a $0
  // placeholder) instead of removing it — used by the Quick entry grid.
  function setQtyKeepZero(id, qty) {
    const item = itemById[id];
    if (!item) return;
    const maxQty = (item.stock || 0) + (isEdit ? (origQtyById[id] || 0) : 0);
    const clamped = desktop ? Math.max(0, qty) : Math.max(0, Math.min(qty, maxQty));
    setOrder(prev => {
      const exists = prev.find(o => o.id === id);
      if (!exists) return [...prev, { id, qty: clamped, checkin: clamped === 0 }];
      return prev.map(o => (o.id === id ? { ...o, qty: clamped, checkin: clamped === 0 ? true : false } : o));
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
  // Switch a line between 'box' and 'case'.
  function setUnit(id, unit) {
    setOrder(prev => prev.map(o => (o.id === id ? { ...o, unit } : o)));
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
        lines: orderLines.map(l => ({ itemId: l.id, qty: l.qty, unit: l.unit })),
        poNumber: poEdited ? (poNumber || null) : null,
        invoiceNumber: invEdited ? (invNumber || null) : null,
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
        lines: orderLines.map(l => ({ itemId: l.id, qty: l.qty, unit: l.unit })),
        poNumber: poEdited ? (poNumber || null) : null,
        invoiceNumber: invEdited ? (invNumber || null) : null,
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
        {(desktop || pickersExpanded) ? (
          <>
            {desktop ? (
              <div style={{ position: 'relative', ...(desktop && !isEdit ? { flex: '0 0 240px' } : { flex: 1 }) }}>
                <div style={{ ...styles.customerBtn, marginTop: 0 }}>
                  <User size={16} color={customerId ? '#14181F' : '#8A8F87'} />
                  <input
                    style={styles.comboInput}
                    placeholder="Type a customer…"
                    value={comboOpen ? comboText : (customerName || '')}
                    onChange={e => { setComboText(e.target.value); setComboOpen(true); setComboHi(0); }}
                    onFocus={e => { setComboText(customerId ? '' : comboText); setComboOpen(true); setComboHi(0); e.target.select(); }}
                    onKeyDown={e => {
                      const matches = comboMatches;
                      if (e.key === 'ArrowDown') { e.preventDefault(); setComboOpen(true); setComboHi(h => Math.min(h + 1, matches.length - 1)); return; }
                      if (e.key === 'ArrowUp') { e.preventDefault(); setComboHi(h => Math.max(h - 1, 0)); return; }
                      if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
                        if (comboText.trim() && matches.length > 0) {
                          e.preventDefault();
                          const pick = matches[Math.min(comboHi, matches.length - 1)];
                          setCustomerId(pick.id);
                          if (!isEdit && pick.deliveryDay != null) { /* leave date to user */ }
                          setComboOpen(false); setComboText('');
                          setTimeout(() => { if (dateInputRef.current) dateInputRef.current.focus(); }, 20);
                        }
                        return;
                      }
                      if (e.key === 'Escape') { setComboOpen(false); }
                    }}
                  />
                  <ChevronDown size={16} color="#8A8F87" style={{ marginLeft: 'auto' }} />
                </div>
                {comboOpen && comboMatches.length > 0 && (
                  <div style={styles.comboDropdown}>
                    {comboMatches.slice(0, 500).map((c, ci) => (
                      <button
                        key={c.id}
                        ref={ci === Math.min(comboHi, comboMatches.length - 1) ? (el => { if (el) el.scrollIntoView({ block: 'nearest' }); }) : undefined}
                        style={{ ...styles.comboRow, ...(ci === Math.min(comboHi, comboMatches.length - 1) ? styles.comboRowHi : {}) }}
                        onMouseEnter={() => setComboHi(ci)}
                        onMouseDown={e => { e.preventDefault(); setCustomerId(c.id); setComboOpen(false); setComboText(''); setTimeout(() => { if (dateInputRef.current) dateInputRef.current.focus(); }, 20); }}
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <button style={styles.customerBtn} onClick={() => { setCustomerQuery(''); setCustomerDayFilter(null); setCustomerOpen(true); }}>
                <User size={16} color={customerId ? '#14181F' : '#8A8F87'} />
                <span style={{ ...styles.customerBtnText, color: customerId ? '#14181F' : '#8A8F87' }}>
                  {customerName || 'Select customer'}
                </span>
                <ChevronDown size={16} color="#8A8F87" style={{ marginLeft: 'auto' }} />
              </button>
            )}
            {desktop ? (
              <div style={{ ...styles.dateBtn, width: 'auto', flex: '0 0 auto', marginTop: 0, marginLeft: 'auto', padding: '9px 8px 9px 10px', position: 'relative' }}>
                <button
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                  tabIndex={-1}
                  onClick={() => setCalOpen(o => !o)}
                  title="Open calendar"
                >
                  <Calendar size={17} color={deliveryDate ? '#2B5D50' : '#8A8F87'} />
                </button>
                <DateBoxes value={deliveryDate} onChange={setDeliveryDate} firstRef={dateInputRef} />
                {calOpen && (
                  <MiniCalendar
                    value={deliveryDate}
                    onPick={iso => { setDeliveryDate(iso); setCalOpen(false); }}
                    onClose={() => setCalOpen(false)}
                  />
                )}
              </div>
            ) : (
              <button style={styles.dateBtn} onClick={() => setDateOpen(true)}>
                <Calendar size={16} color={deliveryDate ? '#14181F' : '#8A8F87'} />
                <span style={{ ...styles.customerBtnText, color: deliveryDate ? '#14181F' : '#8A8F87' }}>
                  {deliveryDate ? formatDate(deliveryDate) : 'Delivery date'}
                </span>
                <ChevronDown size={16} color="#8A8F87" style={{ marginLeft: 'auto' }} />
              </button>
            )}
            {desktop && !isEdit && (
              <>
                <div style={{ ...styles.dateBtn, flex: '0 0 175px', width: 'auto', marginTop: 0, padding: '9px 10px', gap: 6 }} title="PO number — auto-filled; edit to override">
                  <span style={{ fontSize: 11, fontWeight: 800, color: '#8A8F87' }}>PO#</span>
                  <input
                    style={{ ...styles.comboInput, fontSize: 13 }}
                    placeholder="PO #"
                    value={poValue}
                    onChange={e => { setPoEdited(true); setPoNumber(e.target.value); }}
                  />
                </div>
                <div style={{ ...styles.dateBtn, flex: '0 0 120px', width: 'auto', marginTop: 0, padding: '9px 10px', gap: 6 }} title="Invoice number — next available; edit to override">
                  <span style={{ fontSize: 11, fontWeight: 800, color: '#8A8F87' }}>INV#</span>
                  <input
                    style={{ ...styles.comboInput, fontSize: 13 }}
                    placeholder="Inv #"
                    inputMode="numeric"
                    value={invValue}
                    onChange={e => { setInvEdited(true); setInvNumber(e.target.value.replace(/[^0-9]/g, '')); }}
                  />
                </div>
              </>
            )}
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

      <div style={desktop ? { ...styles.searchWrap, padding: '8px 16px 4px' } : styles.searchWrap}>
        {!(desktop && quickEntry && !isEdit) && (
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
        )}
        {desktop && quickEntry && !isEdit && <div style={{ flex: 1 }} />}
        {!(desktop && quickEntry && !isEdit) && (
        <button style={styles.gridSizeBtn} onClick={toggleGridSize} title={`Tile size: ${gridSize} (tap to change)`}>
          <GridSizeIcon variant={gridSize} size={16} color="#5B6058" />
        </button>
        )}
        {!isEdit && customerId != null && !(desktop && quickEntry) && (
          <button
            style={{ ...styles.allItemsChip, ...(showAllItems ? styles.allItemsChipOn : {}) }}
            onClick={() => setShowAllItems(v => !v)}
            title={showAllItems ? 'Showing all items — tap to show only this store\u2019s catalog' : 'Show every item, not just this store\u2019s catalog'}
          >
            {showAllItems ? 'All items ✓' : 'All items'}
          </button>
        )}
        {desktop && !isEdit && (
          <button
            style={{ ...styles.allItemsChip, ...(quickEntry ? styles.allItemsChipOn : {}) }}
            onClick={() => setQuickEntry(v => !v)}
            title="Bulk entry: type item numbers and cases, QuickBooks-style"
          >
            {quickEntry ? 'Quick entry ✓' : 'Quick entry'}
          </button>
        )}
        {desktop && !isEdit && quickEntry && (
          <button
            style={{ ...styles.allItemsChip, ...(distributor ? styles.allItemsChipOn : {}) }}
            onClick={() => { setDistributorTouched(true); setDistributor(v => !v); }}
            title="Distributor order: new lines default to cases; each column hidden while all cases"
          >
            {distributor ? 'Distributor ✓' : 'Distributor'}
          </button>
        )}
      </div>

      {!isEdit && customerId == null && (
        <div style={styles.catalogNote}>Pick a customer to see the items they carry.</div>
      )}
      {!isEdit && customerId != null && catalog && catalog.off && !showAllItems && (
        <div style={styles.catalogNote}>This store has no catalog set up yet — set one up on the desktop (Catalogs tab), or tap "All items" to browse everything.</div>
      )}
      {quickEntry && !isEdit && (customerId != null) && (
        <QuickEntryGrid
          allItems={items.map(i => (catalog && catalog.prices.has(i.id) ? { ...i, price: catalog.prices.get(i.id) } : i))}
          catalog={catalog}
          priceOf={priceOf}
          orderLines={orderLines}
          setQty={setQty}
          onSetQty={setQtyKeepZero}
          setUnit={setUnit}
          removeLine={removeLine}
          desktop={desktop}
        />
      )}
      {quickEntry && !isEdit && customerId == null && (
        <div style={styles.catalogNote}>Pick a customer to start bulk entry.</div>
      )}
      {!quickEntry && screen === 'brands' && !searching && (customerId != null || isEdit) && !(catalog && catalog.off && !showAllItems) && (
        <div style={{ ...styles.brandGrid, gridTemplateColumns: `repeat(auto-fill, minmax(${gridSizeMinWidth(gridSize)}px, 1fr))` }}>
          <button
            style={{ ...styles.brandTile, background: '#3C4132', ...styles.brandTileVariant[gridSize] }}
            onClick={() => { setBrand('All'); setScreen('items'); }}
          >
            <span style={{ ...styles.brandTileName, ...styles.brandTileNameVariant[gridSize] }}>All Items</span>
            <span style={styles.brandTileCount}>{catalogItems.length} items</span>
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

      {!quickEntry && screen === 'items' && !searching && (
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
      {!quickEntry && searching && (
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

      {!quickEntry && (screen === 'items' || searching) && (
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
                    {item.incoming > 0 && (
                      <span style={styles.incomingTag} title={`${item.incoming} on order (incoming from a purchase order)`}>
                        +{item.incoming} incoming
                      </span>
                    )}
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
                    <div style={styles.sheetLineName}>
                      <span style={styles.sheetLineCode}>{displayCode(l.id)}</span>
                      {l.name}
                    </div>
                    <div style={styles.sheetLineSku}>
                      {l.pack > 1 ? `${l.pack}ea` : ''}
                      {l.price > 0 && l.qty > 0 ? `${l.pack > 1 ? ' · ' : ''}${formatMoney(l.price)}/ea · ${formatMoney(lineTotal(l, l.qty))}` : ''}
                    </div>
                  </div>
                  {l.checkin && l.qty === 0 && <div style={styles.checkinTag}>check-in</div>}
                  <TicketQtyInput qty={l.qty} onSet={v => setQty(l.id, v)} disabled={submitting} />
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
            {!desktop && (
              <label style={styles.showAllCustLabel}>
                <input type="checkbox" checked={showAllCustomers} onChange={e => setShowAllCustomers(e.target.checked)} />
                Show all customers
              </label>
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
                    // Auto-date on customer select is turned off — leave the
                    // delivery date as-is; the user picks it themselves.
                    if (deliveryDate) setPickersExpanded(false);
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
    return sortInventoryItems(filtered, sortField, sortDir, popularity, printSequence);
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
        <div style={styles.itemsSubHeader}>
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
        <div style={styles.itemsSubHeader}>
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
                    <button style={styles.orderCardActionBtn} onClick={() => printOrder(o, printSequence, { withUpc: false, customer: customers.find(cc => cc.name === o.customer) || customers.find(cc => cc.id === o.customerId) })}>Print</button>
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
          <button
            style={{ ...officeStyles.navBtn, ...(section === 'catalogs' ? officeStyles.navBtnActive : {}) }}
            onClick={() => setSection('catalogs')}
          >
            Catalogs
          </button>
          <button
            style={{ ...officeStyles.navBtn, ...(section === 'reports' ? officeStyles.navBtnActive : {}) }}
            onClick={() => setSection('reports')}
          >
            Reports
          </button>
          <button
            style={{ ...officeStyles.navBtn, ...(section === 'purchasing' ? officeStyles.navBtnActive : {}) }}
            onClick={() => setSection('purchasing')}
          >
            Purchasing
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
        {section === 'catalogs' && <OfficeCatalogs customers={activeCustomers} items={items} onRefresh={onRefresh} />}
        {section === 'reports' && <OfficeReports />}
        {section === 'purchasing' && <OfficePurchasing items={activeItems || items} onRefresh={onRefresh} />}
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
  const [readyBusyId, setReadyBusyId] = useState(null);

  // Toggle the shared "ready for import" flag on an order (saved server-side so
  // a coworker can mark orders ready and you batch-import them later).
  async function toggleReady(id, next) {
    setReadyBusyId(id); setIifError('');
    try {
      await apiPost('/orders/set-ready', { ids: [id], ready: next });
      await onRefresh();
    } catch (err) { setIifError(err.message || 'Could not update the order.'); }
    finally { setReadyBusyId(null); }
  }
  // Download every "ready" order as one QB import file, mark exported + clear ready.
  async function downloadReadyBatch(readyOrders) {
    const ids = readyOrders.map(o => o.id);
    if (ids.length === 0) return;
    setBatchBusy(true); setIifError('');
    try {
      await downloadOrdersTP(ids);
      await apiPost('/orders/mark-exported', { ids });
      await onRefresh();
    } catch (err) {
      setIifError(err.message || 'Could not download the batch.');
    } finally { setBatchBusy(false); }
  }

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
    const customer = customers.find(cc => cc.name === order.customer) || customers.find(cc => cc.id === order.customerId) || null;
    printOrder(order, printSequence, { withUpc, customer });
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

  const readyOrders = useMemo(() => orders.filter(o => o.readyForImport && !o.exported), [orders]);
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

      {readyOrders.length > 0 && (
        <div style={officeStyles.batchBar}>
          <span style={{ fontWeight: 700 }}>{readyOrders.length} order{readyOrders.length === 1 ? '' : 's'} ready for import</span>
          <button style={officeStyles.primarySmallBtn} onClick={() => downloadReadyBatch(readyOrders)} disabled={batchBusy}>
            {batchBusy ? 'Downloading…' : `Download ${readyOrders.length} for import`}
          </button>
          <span style={{ fontSize: 12.5, color: '#5B6058' }}>Downloads one QuickBooks import file for all ready orders and marks them exported.</span>
        </div>
      )}

      <div style={officeStyles.tableCard}>
        <table style={officeStyles.table}>
          <thead>
            <tr>
              <th style={{ ...officeStyles.th, width: 44, textAlign: 'center' }} title="Ready for QuickBooks import (shared)">Ready</th>
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
              <tr><td style={officeStyles.emptyCell} colSpan={10}>No orders match "{query}"</td></tr>
            )}
            {filtered.map(o => {
              const isOpen = openId === o.id;
              const totalUnits = o.lines.reduce((s, l) => s + l.qty, 0);
              return (
                <React.Fragment key={o.id}>
                  <tr style={{ ...officeStyles.rowClickable, ...(o.processed ? {} : officeStyles.rowUnprocessed) }}>
                    <td style={{ ...officeStyles.td, textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={!!o.readyForImport}
                        onChange={e => toggleReady(o.id, e.target.checked)}
                        disabled={o.status === 'pending' || readyBusyId === o.id}
                        title={o.status === 'pending' ? 'Pending orders can\u2019t be marked ready' : 'Mark ready for QuickBooks import (saved for everyone)'}
                      />
                    </td>
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
                      {o.exported ? <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: '#2B5D50', background: '#EAF1EE', border: '1px solid #C4DDD2', borderRadius: 20, padding: '1px 7px' }} title={o.exportedAt ? `Exported ${formatDateTime(o.exportedAt)}` : 'Exported'}>exported</span> : null}
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
                          <button style={officeStyles.smallBtn} onClick={() => printInvoice(o, customers.find(cc => cc.name === o.customer) || customers.find(cc => cc.id === o.customerId), printSequence, items)} title="Print an invoice for this order">Invoice</button>{' '}
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
                      <td style={officeStyles.detailCell} colSpan={10}>
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
  const [editingContents, setEditingContents] = useState(null); // item whose "contains" list is being edited

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
    return sortInventoryItems(matches, sortField, sortDir, popularity, printSequence);
  }, [items, query, brand, showInactive, sortField, sortDir, popularity, printSequence]);

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
        {!renamingBrand && (
          <select style={officeStyles.select} value={sortField} onChange={e => handleSortClick(e.target.value)} title="Sort items">
            {INVENTORY_SORT_COLUMNS.filter(o => isItems || o.id !== 'casePrice').map(o => (
              <option key={o.id} value={o.id}>Sort: {o.label}{sortField === o.id ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}</option>
            ))}
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
            <option value="cost">Edit: Cost</option>
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
              {isItems && <SortableTh field="cost" label="Cost/ea" sortField={sortField} sortDir={sortDir} onClick={handleSortClick} align="right" />}
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
                  {isItems && editMode && (
                    <button
                      style={officeStyles.containsBtn}
                      onClick={e => { e.stopPropagation(); setEditingContents(item); }}
                      title="Edit the contained items shown under this item on the invoice (for shippers)"
                    >
                      {item.contains && item.contains.length ? `Contents (${item.contains.length})` : '+ Contents'}
                    </button>
                  )}
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
                {isItems && (
                <td style={{ ...officeStyles.td, textAlign: 'right' }}>
                  {canEdit('cost') ? (
                    <NumberFieldEditor item={item} field="cost" onSaved={onRefresh} min={0} step={0.01} prefix="$" width={64} placeholder="—" />
                  ) : (item.cost != null ? formatMoney(item.cost) : <span style={{ color: '#B9BDB2' }}>—</span>)}
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
                  {item.incoming > 0 && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: '#2B5D50' }} title="Incoming from open purchase orders">+{item.incoming}</span>}
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
      {editingContents && (
        <ItemContentsModal
          item={editingContents}
          allItems={items}
          onClose={() => setEditingContents(null)}
          onSaved={async () => { setEditingContents(null); await onRefresh(); }}
        />
      )}
    </div>
  );
}

// Modal to edit a shipper item's contained sub-items (qty / name / UPC), which
// print under the item on the invoice, each with its own barcode.
function ItemContentsModal({ item, allItems = [], onClose, onSaved }) {
  // Each contained row references an existing item (searched/picked from the
  // catalog) plus a quantity. Name + UPC are pulled from the chosen item, but a
  // legacy free-typed row still shows its stored name/upc.
  const [list, setList] = useState(() => (item.contains && item.contains.length ? item.contains.map(x => ({ ...x })) : [{ qty: '', name: '', upc: '' }]));
  const [saving, setSaving] = useState(false);
  const [openRow, setOpenRow] = useState(null);   // which row's search dropdown is open
  const [query, setQuery] = useState('');

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = allItems.filter(it => it.id !== item.id); // don't add the shipper to itself
    if (!q) return pool.slice(0, 30);
    return pool.filter(it => it.name.toLowerCase().includes(q) || String(it.id).toLowerCase().includes(q)).slice(0, 40);
  }, [allItems, query, item.id]);

  function update(i, patch) { setList(prev => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r))); }
  function addRow() { setList(prev => [...prev, { qty: '', name: '', upc: '' }]); }
  function removeRow(i) { setList(prev => prev.filter((_, idx) => idx !== i)); }
  function pick(i, it) {
    // Use the item's first UPC (barcodes render per line).
    const firstUpc = parseUpcList(it.upc)[0] || '';
    update(i, { name: it.name, upc: firstUpc, itemId: it.id });
    setOpenRow(null); setQuery('');
  }

  async function save() {
    setSaving(true);
    const clean = list
      .map(r => ({ qty: Number(r.qty) || 0, name: String(r.name || '').trim(), upc: String(r.upc || '').trim() }))
      .filter(r => r.name || r.upc || r.qty);
    try {
      await apiPatch(`/items/${encodeURIComponent(item.id)}`, { contains: clean });
      await onSaved();
    } catch (err) { setSaving(false); }
  }

  return (
    <div style={styles.editOverlay} onClick={onClose}>
      <div style={contentsStyles.card} onClick={e => e.stopPropagation()}>
        <div style={contentsStyles.title}>Contents of {item.name}</div>
        <div style={contentsStyles.sub}>Search and pick the items this shipper contains. They print under the item on the invoice as "Contains below", each with its barcode.</div>
        <div style={contentsStyles.headRow}>
          <span style={{ width: 60 }}>Qty (ea)</span>
          <span style={{ flex: 1 }}>Item</span>
          <span style={{ width: 28 }} />
        </div>
        {list.map((r, i) => (
          <div key={i} style={{ position: 'relative', marginBottom: 6 }}>
            <div style={contentsStyles.row}>
              <input style={{ ...contentsStyles.input, width: 60 }} value={r.qty} inputMode="numeric" placeholder="24" onChange={e => update(i, { qty: e.target.value.replace(/[^0-9]/g, '') })} />
              <button
                style={{ ...contentsStyles.pickBtn, ...(r.name ? {} : { color: '#8A8F87', fontWeight: 500 }) }}
                onClick={() => { setOpenRow(openRow === i ? null : i); setQuery(''); }}
              >
                {r.name
                  ? <span><strong>{r.name}</strong>{r.upc ? <span style={{ color: '#8A8F87', fontSize: 11 }}> · {r.upc}</span> : ''}</span>
                  : 'Search for an item…'}
              </button>
              <button style={contentsStyles.removeBtn} onClick={() => removeRow(i)} title="Remove">×</button>
            </div>
            {openRow === i && (
              <div style={contentsStyles.dropdown}>
                <input autoFocus style={contentsStyles.searchInput} placeholder="Search items by name or #…" value={query} onChange={e => setQuery(e.target.value)} />
                <div style={contentsStyles.results}>
                  {candidates.length === 0 && <div style={contentsStyles.noResult}>No items match "{query}"</div>}
                  {candidates.map(it => (
                    <button key={it.id} style={contentsStyles.resultRow} onClick={() => pick(i, it)}>
                      <span style={{ fontWeight: 600 }}>{it.name}</span>
                      <span style={{ color: '#8A8F87', fontSize: 11, marginLeft: 8 }}>{displayCode(it.id)}{parseUpcList(it.upc)[0] ? ` · ${parseUpcList(it.upc)[0]}` : ''}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
        <button style={contentsStyles.addBtn} onClick={addRow}>+ Add item</button>
        <div style={contentsStyles.actions}>
          <button style={contentsStyles.cancel} onClick={onClose} disabled={saving}>Cancel</button>
          <button style={contentsStyles.save} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save contents'}</button>
        </div>
      </div>
    </div>
  );
}

const contentsStyles = {
  card: { width: '100%', maxWidth: 560, background: '#F7F8F4', borderRadius: 16, boxShadow: '0 20px 60px rgba(20,24,31,0.4)', padding: 22 },
  title: { fontSize: 17, fontWeight: 800, color: '#14181F' },
  sub: { fontSize: 12.5, color: '#5B6058', margin: '4px 0 14px' },
  headRow: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', color: '#8A8F87', padding: '0 2px 4px' },
  row: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 },
  input: { background: '#FFFFFF', border: '1px solid #D6D3C6', borderRadius: 7, padding: '7px 9px', fontSize: 13, color: '#14181F', fontFamily: 'inherit', outline: 'none' },
  pickBtn: { flex: 1, textAlign: 'left', background: '#FFFFFF', border: '1px solid #D6D3C6', borderRadius: 7, padding: '7px 10px', fontSize: 13, color: '#14181F', fontFamily: 'inherit', cursor: 'pointer' },
  dropdown: { position: 'absolute', left: 68, top: '100%', marginTop: 2, width: 'min(560px, 92vw)', background: '#FFFFFF', border: '1px solid #D6D3C6', borderRadius: 8, boxShadow: '0 12px 34px rgba(20,24,31,0.22)', zIndex: 5, padding: 8 },
  searchInput: { width: '100%', background: '#F7F8F4', border: '1px solid #E3E1D6', borderRadius: 6, padding: '8px 10px', fontSize: 13.5, fontFamily: 'inherit', outline: 'none', marginBottom: 6 },
  results: { maxHeight: 320, overflowY: 'auto' },
  resultRow: { display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid #F0EEE6', padding: '9px 8px', fontSize: 13.5, color: '#14181F', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  noResult: { fontSize: 12.5, color: '#8A8F87', padding: '8px 6px', fontStyle: 'italic' },
  removeBtn: { width: 28, height: 28, borderRadius: 7, border: '1px solid #E6C6B4', background: '#FBEEE7', color: '#B5493B', fontSize: 16, fontWeight: 700, cursor: 'pointer', lineHeight: 1 },
  addBtn: { marginTop: 4, background: '#EAF1EE', border: '1px solid #C4DDD2', color: '#2B5D50', borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 },
  cancel: { background: '#EDEBE3', color: '#14181F', border: '1px solid #E3E1D6', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  save: { background: '#2B5D50', color: '#F7F8F4', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
};

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

// Reports tab shell: a list of available reports; picking one opens it.
// New reports get added to REPORT_LIST and rendered in the switch below.
const REPORT_LIST = [
  { id: 'sales-by-month', name: 'Sales by month', desc: 'Sales for every item, broken out by month across a period you choose.' },
  { id: 'margin', name: 'Margin', desc: 'Sell vs. landed cost per customer & item — exact margin $ and %.' },
  { id: 'order-margin', name: 'Order margin', desc: 'Pick any order and see the margin per item and total profit instantly.' },
  // Add more reports here as they\u2019re built.
];
// Purchasing tab: list purchase orders, create new ones, and receive stock.
function OfficePurchasing({ items, onRefresh }) {
  const [pos, setPos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list'); // list | new | detail
  const [selId, setSelId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('open');

  async function load() {
    setLoading(true);
    try { setPos(await apiGet('/purchase-orders')); } catch { setPos([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const shown = useMemo(() => {
    if (statusFilter === 'all') return pos;
    if (statusFilter === 'open') return pos.filter(p => p.status === 'open' || p.status === 'partial');
    return pos.filter(p => p.status === statusFilter);
  }, [pos, statusFilter]);

  if (view === 'new') return <PurchaseOrderForm items={items} onBack={() => setView('list')} onSaved={async () => { setView('list'); await load(); }} />;
  if (view === 'detail' && selId != null) return <PurchaseOrderDetail poId={selId} items={items} onBack={() => { setView('list'); setSelId(null); }} onChanged={async () => { await load(); await onRefresh(); }} />;

  const statusChip = s => {
    const map = { open: { bg: '#EAF1EE', bd: '#C4DDD2', c: '#2B5D50' }, partial: { bg: '#FDF3E3', bd: '#EAD3A8', c: '#B5793B' }, received: { bg: '#EDEBE3', bd: '#E3E1D6', c: '#8A8F87' }, cancelled: { bg: '#FBEEE7', bd: '#E6C6B4', c: '#B5493B' } };
    const m = map[s] || map.open;
    return { fontSize: 11, fontWeight: 700, color: m.c, background: m.bg, border: `1px solid ${m.bd}`, borderRadius: 20, padding: '2px 9px', textTransform: 'capitalize' };
  };

  return (
    <div>
      <div style={officeStyles.sectionHeader}>
        <div style={officeStyles.sectionTitle}>Purchasing</div>
        <button style={officeStyles.smallBtn} onClick={() => setView('new')}>+ New PO</button>
        <div style={{ display: 'inline-flex', border: '1px solid #D6D3C6', borderRadius: 8, overflow: 'hidden' }}>
          {[['open', 'Open'], ['received', 'Received'], ['all', 'All']].map(([id, label]) => (
            <button key={id} style={{ background: statusFilter === id ? '#2B5D50' : '#FFFFFF', color: statusFilter === id ? '#F7F8F4' : '#8A8F87', border: 'none', padding: '7px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }} onClick={() => setStatusFilter(id)}>{label}</button>
          ))}
        </div>
      </div>
      {loading ? <div style={{ padding: 30, color: '#8A8F87' }}>Loading…</div> : (
        <div style={{ ...officeStyles.tableCard, overflowX: 'auto' }}>
          <table style={officeStyles.table}>
            <thead><tr>
              <th style={officeStyles.th}>PO #</th>
              <th style={officeStyles.th}>Supplier</th>
              <th style={officeStyles.th}>Reference</th>
              <th style={officeStyles.th}>Expected</th>
              <th style={{ ...officeStyles.th, textAlign: 'center' }}>Items</th>
              <th style={{ ...officeStyles.th, textAlign: 'right' }}>Ordered</th>
              <th style={{ ...officeStyles.th, textAlign: 'right' }}>Received</th>
              <th style={{ ...officeStyles.th, textAlign: 'center' }}>Status</th>
            </tr></thead>
            <tbody>
              {shown.map(p => (
                <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => { setSelId(p.id); setView('detail'); }}>
                  <td style={{ ...officeStyles.td, fontWeight: 700 }}>#{p.id}</td>
                  <td style={officeStyles.td}>{p.supplier || <span style={{ color: '#B9BDB2' }}>—</span>}</td>
                  <td style={officeStyles.td}>{p.reference || ''}</td>
                  <td style={officeStyles.td}>{p.expectedDate ? formatDate(p.expectedDate) : ''}</td>
                  <td style={{ ...officeStyles.td, textAlign: 'center' }}>{p.itemCount}</td>
                  <td style={{ ...officeStyles.td, textAlign: 'right' }}>{p.totalOrdered}</td>
                  <td style={{ ...officeStyles.td, textAlign: 'right' }}>{p.totalReceived}</td>
                  <td style={{ ...officeStyles.td, textAlign: 'center' }}><span style={statusChip(p.status)}>{p.status}</span></td>
                </tr>
              ))}
              {shown.length === 0 && <tr><td colSpan={8} style={{ ...officeStyles.td, color: '#8A8F87', fontStyle: 'italic' }}>No purchase orders.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Create a new purchase order.
function PurchaseOrderForm({ items, onBack, onSaved }) {
  const [supplier, setSupplier] = useState('');
  const [reference, setReference] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([{ itemId: '', qty: '' }]);
  const [saving, setSaving] = useState(false);
  const [pickerRow, setPickerRow] = useState(null);
  const [pquery, setPquery] = useState('');

  const candidates = useMemo(() => {
    const q = pquery.trim().toLowerCase();
    if (!q) return items.slice(0, 30);
    return items.filter(i => i.name.toLowerCase().includes(q) || String(i.id).toLowerCase().includes(q)).slice(0, 40);
  }, [items, pquery]);
  const itemById = useMemo(() => { const m = {}; for (const it of items) m[it.id] = it; return m; }, [items]);

  function setLine(i, patch) { setLines(prev => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r)); }
  function addRow() { setLines(prev => [...prev, { itemId: '', qty: '' }]); }
  function removeRow(i) { setLines(prev => prev.filter((_, idx) => idx !== i)); }

  async function save() {
    const clean = lines.map(l => ({ itemId: l.itemId, qty: Number(l.qty) || 0 })).filter(l => l.itemId && l.qty > 0);
    if (clean.length === 0) return;
    setSaving(true);
    try {
      await apiPost('/purchase-orders', { supplier, reference, expectedDate: expectedDate || null, notes, lines: clean });
      await onSaved();
    } catch { setSaving(false); }
  }

  return (
    <div>
      <div style={officeStyles.sectionHeader}>
        <button style={repStyles.backBtn} onClick={onBack}>← Purchasing</button>
        <div style={officeStyles.sectionTitle}>New purchase order</div>
      </div>
      <div style={poStyles.formGrid}>
        <label style={poStyles.field}><span style={poStyles.lbl}>Supplier</span><input style={poStyles.input} value={supplier} onChange={e => setSupplier(e.target.value)} placeholder="e.g. Albanese" /></label>
        <label style={poStyles.field}><span style={poStyles.lbl}>Reference #</span><input style={poStyles.input} value={reference} onChange={e => setReference(e.target.value)} placeholder="Supplier PO / SO #" /></label>
        <label style={poStyles.field}><span style={poStyles.lbl}>Expected date</span><input style={poStyles.input} type="date" value={expectedDate} onChange={e => setExpectedDate(e.target.value)} /></label>
      </div>
      <div style={poStyles.linesCard}>
        <table style={officeStyles.table}>
          <thead><tr>
            <th style={officeStyles.th}>Item</th>
            <th style={{ ...officeStyles.th, textAlign: 'right', width: 120 }}>Qty ordered</th>
            <th style={{ ...officeStyles.th, width: 34 }} />
          </tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td style={officeStyles.td}>
                  <div style={{ position: 'relative' }}>
                    <button style={poStyles.pickBtn} onClick={() => { setPickerRow(pickerRow === i ? null : i); setPquery(''); }}>
                      {l.itemId ? <span><strong>{displayCode(l.itemId)}</strong> {itemById[l.itemId]?.name}</span> : <span style={{ color: '#8A8F87' }}>Search for an item…</span>}
                    </button>
                    {pickerRow === i && (
                      <div style={poStyles.dropdown}>
                        <input autoFocus style={poStyles.search} placeholder="Search items…" value={pquery} onChange={e => setPquery(e.target.value)} />
                        <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                          {candidates.map(it => (
                            <button key={it.id} style={poStyles.matchRow} onClick={() => { setLine(i, { itemId: it.id }); setPickerRow(null); }}>
                              <strong style={{ marginRight: 8, color: '#2B5D50' }}>{displayCode(it.id)}</strong>{it.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </td>
                <td style={{ ...officeStyles.td, textAlign: 'right' }}>
                  <input style={{ ...poStyles.input, width: 90, textAlign: 'right' }} value={l.qty} inputMode="numeric" placeholder="0" onChange={e => setLine(i, { qty: e.target.value.replace(/[^0-9]/g, '') })} />
                </td>
                <td style={{ ...officeStyles.td, textAlign: 'center' }}><button style={poStyles.rm} onClick={() => removeRow(i)}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button style={poStyles.addBtn} onClick={addRow}>+ Add item</button>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button style={{ ...officeStyles.smallBtn, background: '#2B5D50', color: '#F7F8F4' }} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Create PO'}</button>
        <button style={officeStyles.smallBtn} onClick={onBack} disabled={saving}>Cancel</button>
      </div>
    </div>
  );
}

// View one PO and receive stock (partial or all).
function PurchaseOrderDetail({ poId, items, onBack, onChanged }) {
  const [po, setPo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recv, setRecv] = useState({}); // itemId -> qty to receive
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try { setPo(await apiGet(`/purchase-orders/${poId}`)); } catch { setPo(null); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [poId]);

  async function receive(all) {
    setBusy(true);
    try {
      const body = all ? { all: true } : { receipts: Object.entries(recv).map(([itemId, qty]) => ({ itemId, qty: Number(qty) || 0 })).filter(r => r.qty > 0) };
      await apiPost(`/purchase-orders/${poId}/receive`, body);
      setRecv({});
      await load(); await onChanged();
    } catch { /* ignore */ }
    finally { setBusy(false); }
  }
  async function cancelPO() {
    if (!window.confirm('Cancel this purchase order? Incoming stock from it will be removed.')) return;
    setBusy(true);
    try { await apiPatch(`/purchase-orders/${poId}`, { status: 'cancelled' }); await load(); await onChanged(); }
    catch { /* ignore */ } finally { setBusy(false); }
  }

  if (loading) return <div style={{ padding: 30, color: '#8A8F87' }}>Loading…</div>;
  if (!po) return <div><button style={repStyles.backBtn} onClick={onBack}>← Purchasing</button><div style={{ padding: 20 }}>Not found.</div></div>;

  const outstanding = po.lines.reduce((s, l) => s + (l.qtyOrdered - l.qtyReceived), 0);

  return (
    <div>
      <div style={officeStyles.sectionHeader}>
        <button style={repStyles.backBtn} onClick={onBack}>← Purchasing</button>
        <div style={officeStyles.sectionTitle}>PO #{po.id} · {po.supplier || 'No supplier'}</div>
        {po.status !== 'cancelled' && po.status !== 'received' && <button style={officeStyles.smallBtn} onClick={cancelPO} disabled={busy}>Cancel PO</button>}
      </div>
      <div style={{ fontSize: 13, color: '#5B6058', marginBottom: 12 }}>
        {po.reference ? `Ref ${po.reference} · ` : ''}{po.expectedDate ? `Expected ${formatDate(po.expectedDate)} · ` : ''}Status: <strong style={{ textTransform: 'capitalize' }}>{po.status}</strong>
      </div>
      <div style={{ ...officeStyles.tableCard, overflowX: 'auto' }}>
        <table style={officeStyles.table}>
          <thead><tr>
            <th style={officeStyles.th}>Item</th>
            <th style={{ ...officeStyles.th, textAlign: 'right' }}>Ordered</th>
            <th style={{ ...officeStyles.th, textAlign: 'right' }}>Received</th>
            <th style={{ ...officeStyles.th, textAlign: 'right' }}>Outstanding</th>
            {po.status !== 'received' && po.status !== 'cancelled' && <th style={{ ...officeStyles.th, textAlign: 'right', width: 120 }}>Receive now</th>}
          </tr></thead>
          <tbody>
            {po.lines.map(l => {
              const out = l.qtyOrdered - l.qtyReceived;
              return (
                <tr key={l.id}>
                  <td style={officeStyles.td}><strong style={{ color: '#2B5D50', marginRight: 6 }}>{displayCode(l.itemId)}</strong>{l.item}</td>
                  <td style={{ ...officeStyles.td, textAlign: 'right' }}>{l.qtyOrdered}</td>
                  <td style={{ ...officeStyles.td, textAlign: 'right' }}>{l.qtyReceived}</td>
                  <td style={{ ...officeStyles.td, textAlign: 'right', fontWeight: 700, color: out > 0 ? '#B5793B' : '#8A8F87' }}>{out}</td>
                  {po.status !== 'received' && po.status !== 'cancelled' && (
                    <td style={{ ...officeStyles.td, textAlign: 'right' }}>
                      {out > 0 ? (
                        <input style={{ ...poStyles.input, width: 80, textAlign: 'right' }} value={recv[l.itemId] || ''} inputMode="numeric" placeholder="0"
                          onChange={e => { const v = e.target.value.replace(/[^0-9]/g, ''); setRecv(prev => ({ ...prev, [l.itemId]: Math.min(Number(v) || 0, out) })); }} />
                      ) : <span style={{ color: '#B9BDB2' }}>—</span>}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {po.status !== 'received' && po.status !== 'cancelled' && outstanding > 0 && (
        <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
          <button style={{ ...officeStyles.smallBtn, background: '#2B5D50', color: '#F7F8F4' }} onClick={() => receive(false)} disabled={busy || Object.values(recv).every(v => !Number(v))}>Receive entered</button>
          <button style={officeStyles.smallBtn} onClick={() => receive(true)} disabled={busy}>Receive all ({outstanding})</button>
          <span style={{ fontSize: 12.5, color: '#8A8F87' }}>Receiving adds the quantity into on-hand stock.</span>
        </div>
      )}
    </div>
  );
}
const poStyles = {
  formGrid: { display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  lbl: { fontSize: 11, fontWeight: 700, color: '#8A8F87', textTransform: 'uppercase', letterSpacing: '0.03em' },
  input: { background: '#FFFFFF', border: '1px solid #D6D3C6', borderRadius: 8, padding: '8px 10px', fontSize: 13.5, fontFamily: 'inherit', color: '#14181F', outline: 'none' },
  linesCard: { border: '1px solid #E3E1D6', borderRadius: 12, background: '#FFFFFF', padding: 8 },
  pickBtn: { width: '100%', textAlign: 'left', background: '#F7F8F4', border: '1px solid #D6D3C6', borderRadius: 7, padding: '7px 10px', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' },
  dropdown: { position: 'absolute', left: 0, top: '100%', marginTop: 3, minWidth: 420, background: '#FFFFFF', border: '1px solid #D6D3C6', borderRadius: 8, boxShadow: '0 12px 30px rgba(20,24,31,0.2)', zIndex: 8, padding: 6 },
  search: { width: '100%', background: '#F7F8F4', border: '1px solid #E3E1D6', borderRadius: 6, padding: '7px 9px', fontSize: 13, fontFamily: 'inherit', outline: 'none', marginBottom: 4 },
  matchRow: { display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid #F0EEE6', padding: '8px 6px', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  addBtn: { marginTop: 4, background: '#EAF1EE', border: '1px solid #C4DDD2', color: '#2B5D50', borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  rm: { width: 26, height: 26, borderRadius: 6, border: '1px solid #E6C6B4', background: '#FBEEE7', color: '#B5493B', fontSize: 15, fontWeight: 700, cursor: 'pointer', lineHeight: 1 },
};

function OfficeReports() {
  const [active, setActive] = useState(null);
  if (active === 'sales-by-month') return <SalesByMonthReport onBack={() => setActive(null)} />;
  if (active === 'margin') return <MarginReport onBack={() => setActive(null)} />;
  if (active === 'order-margin') return <OrderMarginReport onBack={() => setActive(null)} />;
  return (
    <div>
      <div style={officeStyles.sectionHeader}>
        <div style={officeStyles.sectionTitle}>Reports</div>
      </div>
      <div style={reportPickStyles.grid}>
        {REPORT_LIST.map(r => (
          <button key={r.id} style={reportPickStyles.card} onClick={() => setActive(r.id)}>
            <div style={reportPickStyles.cardName}>{r.name}</div>
            <div style={reportPickStyles.cardDesc}>{r.desc}</div>
            <div style={reportPickStyles.cardCta}>Open →</div>
          </button>
        ))}
      </div>
    </div>
  );
}
const reportPickStyles = {
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 },
  card: { textAlign: 'left', background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 12, padding: '16px 18px', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', flexDirection: 'column', gap: 6 },
  cardName: { fontSize: 15.5, fontWeight: 800, color: '#14181F' },
  cardDesc: { fontSize: 13, color: '#5B6058', lineHeight: 1.4 },
  cardCta: { marginTop: 4, fontSize: 13, fontWeight: 700, color: '#2B5D50' },
};

// Sales by month — pick a month range, choose the metric (dollars / quantity /
// both), and see an items x months matrix with totals.
function SalesByMonthReport({ onBack }) {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const sixAgo = (() => { const d = new Date(now.getFullYear(), now.getMonth() - 5, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
  const [from, setFrom] = useState(sixAgo);
  const [to, setTo] = useState(thisMonth);
  const [metric, setMetric] = useState('dollars'); // dollars | qty | both
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function run() {
    setLoading(true); setErr('');
    try {
      const d = await apiGet(`/orders/sales-by-month?from=${from}&to=${to}`);
      setData(d);
    } catch (e) { setErr(e.message || 'Could not load the report'); }
    finally { setLoading(false); }
  }
  useEffect(() => { run(); /* eslint-disable-next-line */ }, []);

  const monthLabel = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }); };
  const cellDollars = c => c ? `$${c.dollars.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '';
  const cellQty = c => c ? String(c.qty) : '';

  function downloadCSV() {
    if (!data) return;
    const cols = ['Item #', 'Item', 'Brand', ...data.months.map(monthLabel), 'Total'];
    const lines = [cols];
    for (const it of data.items) {
      const row = [displayCode(it.itemId), it.name, it.brand];
      for (const m of data.months) {
        const c = it.byMonth[m];
        row.push(metric === 'qty' ? (c ? c.qty : '') : (metric === 'both' ? (c ? `${c.qty} / $${c.dollars.toFixed(2)}` : '') : (c ? c.dollars.toFixed(2) : '')));
      }
      row.push(metric === 'qty' ? it.totalQty : (metric === 'both' ? `${it.totalQty} / $${it.totalDollars.toFixed(2)}` : it.totalDollars.toFixed(2)));
      lines.push(row);
    }
    const csv = lines.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    downloadTextFile(`sales-by-month-${from}_to_${to}.csv`, csv);
  }

  const grandByMonth = {};
  let grandTotalD = 0, grandTotalQ = 0;
  if (data) for (const it of data.items) { grandTotalD += it.totalDollars; grandTotalQ += it.totalQty; for (const m of data.months) { const c = it.byMonth[m]; if (c) { grandByMonth[m] = grandByMonth[m] || { qty: 0, dollars: 0 }; grandByMonth[m].qty += c.qty; grandByMonth[m].dollars += c.dollars; } } }

  const showD = metric !== 'qty', showQ = metric !== 'dollars';
  const cellText = c => {
    if (!c) return '';
    if (metric === 'dollars') return cellDollars(c);
    if (metric === 'qty') return cellQty(c);
    return `${c.qty} · ${cellDollars(c)}`;
  };

  return (
    <div>
      <div style={officeStyles.sectionHeader}>
        <button style={repStyles.backBtn} onClick={onBack}>← Reports</button>
        <div style={officeStyles.sectionTitle}>Sales by month</div>
      </div>
      <div style={repStyles.controls}>
        <label style={repStyles.ctrlLabel}>From
          <input style={repStyles.monthInput} type="month" value={from} onChange={e => setFrom(e.target.value)} />
        </label>
        <label style={repStyles.ctrlLabel}>To
          <input style={repStyles.monthInput} type="month" value={to} onChange={e => setTo(e.target.value)} />
        </label>
        <div style={repStyles.metricToggle}>
          {[['dollars', 'Dollars'], ['qty', 'Quantity'], ['both', 'Both']].map(([id, label]) => (
            <button key={id} style={{ ...repStyles.metricBtn, ...(metric === id ? repStyles.metricBtnOn : {}) }} onClick={() => setMetric(id)}>{label}</button>
          ))}
        </div>
        <button style={officeStyles.smallBtn} onClick={run} disabled={loading}>{loading ? 'Loading…' : 'Run'}</button>
        <button style={officeStyles.smallBtn} onClick={downloadCSV} disabled={!data || !data.items.length}>Download CSV</button>
      </div>
      {err && <div style={{ color: '#B5493B', fontSize: 13, marginBottom: 8 }}>{err}</div>}
      {data && (
        <div style={repStyles.tableWrap}>
          <table style={repStyles.table}>
            <thead>
              <tr>
                <th style={{ ...repStyles.th, textAlign: 'left', position: 'sticky', left: 0, background: '#F0EEE4' }}>Item</th>
                {data.months.map(m => <th key={m} style={repStyles.th}>{monthLabel(m)}</th>)}
                <th style={{ ...repStyles.th, fontWeight: 800 }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map(it => (
                <tr key={it.itemId}>
                  <td style={{ ...repStyles.tdItem, position: 'sticky', left: 0, background: '#FFFFFF' }}>
                    <span style={{ color: '#2B5D50', fontWeight: 700, marginRight: 6, fontFamily: "'JetBrains Mono', monospace" }}>{displayCode(it.itemId)}</span>
                    {it.name}
                  </td>
                  {data.months.map(m => <td key={m} style={repStyles.tdNum}>{cellText(it.byMonth[m])}</td>)}
                  <td style={{ ...repStyles.tdNum, fontWeight: 800 }}>
                    {metric === 'qty' ? it.totalQty : metric === 'both' ? `${it.totalQty} · $${it.totalDollars.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : `$${it.totalDollars.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                  </td>
                </tr>
              ))}
              {data.items.length === 0 && (
                <tr><td colSpan={data.months.length + 2} style={{ ...repStyles.tdItem, color: '#8A8F87', fontStyle: 'italic' }}>No sales in this period.</td></tr>
              )}
            </tbody>
            {data.items.length > 0 && (
              <tfoot>
                <tr>
                  <td style={{ ...repStyles.tfoot, textAlign: 'left', position: 'sticky', left: 0, background: '#14181F' }}>Grand total</td>
                  {data.months.map(m => (
                    <td key={m} style={repStyles.tfoot}>
                      {grandByMonth[m] ? (metric === 'qty' ? grandByMonth[m].qty : metric === 'both' ? `${grandByMonth[m].qty} · $${Math.round(grandByMonth[m].dollars).toLocaleString()}` : `$${Math.round(grandByMonth[m].dollars).toLocaleString()}`) : ''}
                    </td>
                  ))}
                  <td style={repStyles.tfoot}>{metric === 'qty' ? grandTotalQ : metric === 'both' ? `${grandTotalQ} · $${Math.round(grandTotalD).toLocaleString()}` : `$${Math.round(grandTotalD).toLocaleString()}`}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
const repStyles = {
  backBtn: { background: '#EDEBE3', border: '1px solid #E3E1D6', borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 700, color: '#5B6058', cursor: 'pointer', fontFamily: 'inherit', marginRight: 12 },
  controls: { display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 14 },
  ctrlLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 700, color: '#8A8F87', textTransform: 'uppercase', letterSpacing: '0.03em' },
  monthInput: { background: '#FFFFFF', border: '1px solid #D6D3C6', borderRadius: 8, padding: '7px 9px', fontSize: 13.5, fontFamily: 'inherit', color: '#14181F', outline: 'none' },
  metricToggle: { display: 'inline-flex', border: '1px solid #D6D3C6', borderRadius: 8, overflow: 'hidden' },
  metricBtn: { background: '#FFFFFF', border: 'none', padding: '8px 12px', fontSize: 13, fontWeight: 700, color: '#8A8F87', cursor: 'pointer', fontFamily: 'inherit' },
  metricBtnOn: { background: '#2B5D50', color: '#F7F8F4' },
  tableWrap: { border: '1px solid #E3E1D6', borderRadius: 10, overflow: 'auto', maxHeight: '70vh', background: '#FFFFFF' },
  table: { borderCollapse: 'collapse', fontSize: 13, minWidth: '100%' },
  th: { position: 'sticky', top: 0, background: '#F0EEE4', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#5B6058', textTransform: 'uppercase', letterSpacing: '0.03em', padding: '8px 12px', whiteSpace: 'nowrap', borderBottom: '1px solid #E3E1D6', zIndex: 1 },
  tdItem: { padding: '7px 12px', borderBottom: '1px solid #F0EEE6', whiteSpace: 'nowrap', color: '#14181F' },
  tdNum: { padding: '7px 12px', borderBottom: '1px solid #F0EEE6', textAlign: 'right', whiteSpace: 'nowrap', color: '#14181F', fontFamily: "'JetBrains Mono', monospace" },
  tfoot: { padding: '9px 12px', textAlign: 'right', whiteSpace: 'nowrap', background: '#14181F', color: '#F7F8F4', fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", position: 'sticky', bottom: 0 },
};

// Margin report: per customer + item, sell vs landed cost, margin $ and %.
function MarginReport({ onBack }) {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const sixAgo = (() => { const d = new Date(now.getFullYear(), now.getMonth() - 5, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
  const [from, setFrom] = useState(sixAgo);
  const [to, setTo] = useState(thisMonth);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [custFilter, setCustFilter] = useState('All');
  const [perEach, setPerEach] = useState(false);

  async function run() {
    setLoading(true); setErr('');
    try { setData(await apiGet(`/orders/margin-report?from=${from}&to=${to}`)); }
    catch (e) { setErr(e.message || 'Could not load the report'); }
    finally { setLoading(false); }
  }
  useEffect(() => { run(); /* eslint-disable-next-line */ }, []);

  const money = n => (n == null ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const pct = n => (n == null ? '—' : `${n}%`);
  const pctColor = n => (n == null ? '#8A8F87' : n < 0 ? '#B5493B' : n < 15 ? '#B5793B' : '#2B5D50');

  const customers = useMemo(() => data ? ['All', ...Array.from(new Set(data.items.map(x => x.customer))).sort()] : ['All'], [data]);
  const shown = useMemo(() => data ? data.items.filter(x => custFilter === 'All' || x.customer === custFilter) : [], [data, custFilter]);

  function downloadCSV() {
    if (!data) return;
    const suffix = perEach ? '/ea' : '';
    const cols = ['Customer', 'Item #', 'Item', 'Brand', 'Eaches', `Sell${suffix}`, `Cost${suffix}`, `Margin${suffix}`, 'Margin %'];
    const lines = [cols, ...shown.map(x => {
      const ea = x.eaches || 0;
      const sellEa = ea ? Math.round(x.sell / ea * 10000) / 10000 : '';
      const costEa = x.unitCost != null ? x.unitCost : (x.cost != null && ea ? Math.round(x.cost / ea * 10000) / 10000 : '');
      const marginEa = (sellEa !== '' && costEa !== '') ? Math.round((sellEa - costEa) * 10000) / 10000 : '';
      return [x.customer, displayCode(x.itemId), x.item, x.brand, x.eaches,
        perEach ? sellEa : x.sell, perEach ? costEa : (x.cost ?? ''), perEach ? marginEa : (x.marginD ?? ''), x.marginPct ?? ''];
    })];
    const csv = lines.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    downloadTextFile(`margin${perEach ? '-perEach' : ''}-${from}_to_${to}.csv`, csv);
  }

  return (
    <div>
      <div style={officeStyles.sectionHeader}>
        <button style={repStyles.backBtn} onClick={onBack}>← Reports</button>
        <div style={officeStyles.sectionTitle}>Margin</div>
      </div>
      <div style={repStyles.controls}>
        <label style={repStyles.ctrlLabel}>From<input style={repStyles.monthInput} type="month" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label style={repStyles.ctrlLabel}>To<input style={repStyles.monthInput} type="month" value={to} onChange={e => setTo(e.target.value)} /></label>
        <label style={repStyles.ctrlLabel}>Customer
          <select style={repStyles.monthInput} value={custFilter} onChange={e => setCustFilter(e.target.value)}>
            {customers.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <div style={repStyles.metricToggle}>
          {[[false, 'Totals'], [true, 'Per each']].map(([id, label]) => (
            <button key={String(id)} style={{ ...repStyles.metricBtn, ...(perEach === id ? repStyles.metricBtnOn : {}) }} onClick={() => setPerEach(id)}>{label}</button>
          ))}
        </div>
        <button style={officeStyles.smallBtn} onClick={run} disabled={loading}>{loading ? 'Loading…' : 'Run'}</button>
        <button style={officeStyles.smallBtn} onClick={downloadCSV} disabled={!data || !shown.length}>Download CSV</button>
      </div>
      {err && <div style={{ color: '#B5493B', fontSize: 13, marginBottom: 8 }}>{err}</div>}
      {data && data.missingCost > 0 && (
        <div style={{ fontSize: 12.5, color: '#B5793B', marginBottom: 10 }}>
          {data.missingCost} line(s) have no cost set (shown as “—”); those are excluded from totals. Costs are landed (incl. Taiyo 6% + Oahu freight); neighbor-island freight isn’t included yet.
        </div>
      )}
      {data && (
        <div style={repStyles.tableWrap}>
          <table style={repStyles.table}>
            <thead><tr>
              <th style={{ ...repStyles.th, textAlign: 'left', position: 'sticky', left: 0, background: '#F0EEE4' }}>Customer / Item</th>
              <th style={repStyles.th}>Eaches</th>
              <th style={repStyles.th}>Sell{perEach ? '/ea' : ''}</th>
              <th style={repStyles.th}>Cost{perEach ? '/ea' : ''}</th>
              <th style={repStyles.th}>Margin{perEach ? '/ea' : ' $'}</th>
              <th style={repStyles.th}>Margin %</th>
            </tr></thead>
            <tbody>
              {shown.map((x, i) => {
                const ea = x.eaches || 0;
                const sellEa = ea ? x.sell / ea : null;
                const costEa = x.unitCost != null ? x.unitCost : (x.cost != null && ea ? x.cost / ea : null);
                const marginEa = (sellEa != null && costEa != null) ? sellEa - costEa : null;
                const sellShow = perEach ? sellEa : x.sell;
                const costShow = perEach ? costEa : x.cost;
                const marginShow = perEach ? marginEa : x.marginD;
                return (
                <tr key={x.customer + x.itemId + i}>
                  <td style={{ ...repStyles.tdItem, position: 'sticky', left: 0, background: '#FFFFFF' }}>
                    <span style={{ color: '#8A8F87' }}>{x.customer}</span>
                    <span style={{ margin: '0 6px', color: '#D6D3C6' }}>·</span>
                    <span style={{ color: '#2B5D50', fontWeight: 700, marginRight: 6, fontFamily: "'JetBrains Mono', monospace" }}>{displayCode(x.itemId)}</span>
                    {x.item}
                  </td>
                  <td style={repStyles.tdNum}>{x.eaches}</td>
                  <td style={repStyles.tdNum}>{money(sellShow)}</td>
                  <td style={{ ...repStyles.tdNum, color: costShow == null ? '#B5793B' : '#14181F' }}>{money(costShow)}</td>
                  <td style={{ ...repStyles.tdNum, color: pctColor(x.marginPct) }}>{money(marginShow)}</td>
                  <td style={{ ...repStyles.tdNum, color: pctColor(x.marginPct), fontWeight: 700 }}>{pct(x.marginPct)}</td>
                </tr>
                );
              })}
              {shown.length === 0 && <tr><td colSpan={6} style={{ ...repStyles.tdItem, color: '#8A8F87', fontStyle: 'italic' }}>No sales in this period.</td></tr>}
            </tbody>
            {shown.length > 0 && (
              <tfoot><tr>
                <td style={{ ...repStyles.tfoot, textAlign: 'left', position: 'sticky', left: 0, background: '#14181F' }}>Totals ($){custFilter !== 'All' ? ` — ${custFilter}` : ''}</td>
                <td style={repStyles.tfoot}>{shown.reduce((s, x) => s + (x.eaches || 0), 0)}</td>
                <td style={repStyles.tfoot}>{money(Math.round(shown.reduce((s, x) => s + x.sell, 0) * 100) / 100)}</td>
                <td style={repStyles.tfoot}>{money(Math.round(shown.filter(x => x.cost != null).reduce((s, x) => s + x.cost, 0) * 100) / 100)}</td>
                <td style={repStyles.tfoot}>{money(Math.round(shown.filter(x => x.cost != null).reduce((s, x) => s + x.marginD, 0) * 100) / 100)}</td>
                <td style={repStyles.tfoot}>{(() => { const wc = shown.filter(x => x.cost != null); const sell = wc.reduce((s, x) => s + x.sell, 0); const marg = wc.reduce((s, x) => s + x.marginD, 0); return sell ? `${Math.round(marg / sell * 1000) / 10}%` : '—'; })()}</td>
              </tr></tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

// Order margin: pick any order, see per-item margin and total profit.
function OrderMarginReport({ onBack }) {
  const [orders, setOrders] = useState([]);
  const [q, setQ] = useState('');
  const [selId, setSelId] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [perEach, setPerEach] = useState(false);

  useEffect(() => { apiGet('/orders').then(setOrders).catch(() => setOrders([])); }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = [...orders].sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
    if (!s) return list.slice(0, 60);
    return list.filter(o =>
      String(o.id).includes(s) ||
      (o.customer || '').toLowerCase().includes(s) ||
      (o.deliveryDate || '').includes(s)
    ).slice(0, 60);
  }, [orders, q]);

  async function pick(id) {
    setSelId(id); setLoading(true); setData(null);
    try { setData(await apiGet(`/orders/${id}/margin`)); }
    catch { setData(null); }
    finally { setLoading(false); }
  }

  const money = n => (n == null ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const pct = n => (n == null ? '—' : `${n}%`);
  const pctColor = n => (n == null ? '#8A8F87' : n < 0 ? '#B5493B' : n < 15 ? '#B5793B' : '#2B5D50');

  return (
    <div>
      <div style={officeStyles.sectionHeader}>
        <button style={repStyles.backBtn} onClick={onBack}>← Reports</button>
        <div style={officeStyles.sectionTitle}>Order margin</div>
      </div>
      <div style={omStyles.wrap}>
        <div style={omStyles.leftCol}>
          <input style={officeStyles.searchSlim} placeholder="Search orders (customer, #, date)…" value={q} onChange={e => setQ(e.target.value)} />
          <div style={omStyles.orderList}>
            {filtered.map(o => (
              <button key={o.id} style={{ ...omStyles.orderRow, ...(o.id === selId ? omStyles.orderRowActive : {}) }} onClick={() => pick(o.id)}>
                <span style={{ fontWeight: 700 }}>#{o.id + (INVOICE_OFFSET || 0)}</span>
                <span style={{ flex: 1, margin: '0 8px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.customer}</span>
                <span style={{ color: '#8A8F87', fontSize: 11.5 }}>{o.deliveryDate ? formatDate(o.deliveryDate) : ''}</span>
              </button>
            ))}
            {filtered.length === 0 && <div style={{ padding: 14, color: '#8A8F87', fontSize: 13, fontStyle: 'italic' }}>No orders match.</div>}
          </div>
        </div>
        <div style={omStyles.rightCol}>
          {!selId && <div style={{ padding: '40px 6px', color: '#8A8F87', fontStyle: 'italic' }}>Pick an order to see its margin.</div>}
          {loading && <div style={{ padding: '40px 6px', color: '#8A8F87' }}>Loading…</div>}
          {data && !loading && (
            <>
              <div style={omStyles.orderHead}>
                <div>
                  <div style={omStyles.orderTitle}>#{data.order.id + (INVOICE_OFFSET || 0)} · {data.order.customer}</div>
                  <div style={{ fontSize: 12.5, color: '#8A8F87' }}>Delivery {data.order.deliveryDate ? formatDate(data.order.deliveryDate) : '—'}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={repStyles.metricToggle}>
                    {[[false, 'Totals'], [true, 'Per each']].map(([id, label]) => (
                      <button key={String(id)} style={{ ...repStyles.metricBtn, ...(perEach === id ? repStyles.metricBtnOn : {}) }} onClick={() => setPerEach(id)}>{label}</button>
                    ))}
                  </div>
                  <div style={omStyles.profitCard}>
                    <div style={omStyles.profitLabel}>Total profit</div>
                    <div style={{ ...omStyles.profitVal, color: pctColor(data.totals.marginPct) }}>{money(data.totals.profit)}</div>
                    <div style={{ fontSize: 12.5, color: pctColor(data.totals.marginPct), fontWeight: 700 }}>{pct(data.totals.marginPct)} margin</div>
                  </div>
                </div>
              </div>
              {data.missingCost > 0 && <div style={{ fontSize: 12.5, color: '#B5793B', margin: '4px 0 8px' }}>{data.missingCost} item(s) have no cost set — shown as “—” and excluded from profit.</div>}
              <div style={repStyles.tableWrap}>
                <table style={repStyles.table}>
                  <thead><tr>
                    <th style={{ ...repStyles.th, textAlign: 'left' }}>Item</th>
                    <th style={repStyles.th}>Qty</th>
                    <th style={repStyles.th}>Ea</th>
                    <th style={repStyles.th}>Sell{perEach ? '/ea' : ''}</th>
                    <th style={repStyles.th}>Cost{perEach ? '/ea' : ''}</th>
                    <th style={repStyles.th}>Margin{perEach ? '/ea' : ' $'}</th>
                    <th style={repStyles.th}>Margin %</th>
                  </tr></thead>
                  <tbody>
                    {data.items.map(x => {
                      const sellShow = perEach ? x.priceEa : x.sell;
                      const costShow = perEach ? x.costEa : x.cost;
                      const marginShow = perEach ? (x.costEa == null ? null : Math.round((x.priceEa - x.costEa) * 10000) / 10000) : x.marginD;
                      return (
                      <tr key={x.itemId}>
                        <td style={repStyles.tdItem}>
                          <span style={{ color: '#2B5D50', fontWeight: 700, marginRight: 6, fontFamily: "'JetBrains Mono', monospace" }}>{displayCode(x.itemId)}</span>
                          {x.item}
                        </td>
                        <td style={repStyles.tdNum}>{x.qty}{x.unit === 'case' ? ' cs' : ''}</td>
                        <td style={repStyles.tdNum}>{x.eaches}</td>
                        <td style={repStyles.tdNum}>{money(sellShow)}</td>
                        <td style={{ ...repStyles.tdNum, color: costShow == null ? '#B5793B' : '#14181F' }}>{money(costShow)}</td>
                        <td style={{ ...repStyles.tdNum, color: pctColor(x.marginPct) }}>{money(marginShow)}</td>
                        <td style={{ ...repStyles.tdNum, color: pctColor(x.marginPct), fontWeight: 700 }}>{pct(x.marginPct)}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                  <tfoot><tr>
                    <td style={{ ...repStyles.tfoot, textAlign: 'left' }}>Order total</td>
                    <td style={repStyles.tfoot} />
                    <td style={repStyles.tfoot} />
                    <td style={repStyles.tfoot}>{money(data.totals.sell)}</td>
                    <td style={repStyles.tfoot}>{money(data.totals.cost)}</td>
                    <td style={repStyles.tfoot}>{money(data.totals.profit)}</td>
                    <td style={repStyles.tfoot}>{pct(data.totals.marginPct)}</td>
                  </tr></tfoot>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
const omStyles = {
  wrap: { display: 'flex', gap: 16, alignItems: 'flex-start' },
  leftCol: { width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  orderList: { border: '1px solid #E3E1D6', borderRadius: 10, background: '#FFFFFF', maxHeight: '70vh', overflowY: 'auto' },
  orderRow: { display: 'flex', alignItems: 'center', width: '100%', padding: '9px 12px', background: 'none', border: 'none', borderBottom: '1px solid #F0EEE6', fontSize: 13, color: '#14181F', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' },
  orderRowActive: { background: '#EAF1EE' },
  rightCol: { flex: 1, minWidth: 0 },
  orderHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 12 },
  orderTitle: { fontSize: 17, fontWeight: 800, color: '#14181F' },
  profitCard: { textAlign: 'right', background: '#F0EEE4', border: '1px solid #E3E1D6', borderRadius: 12, padding: '10px 16px', minWidth: 140 },
  profitLabel: { fontSize: 11, fontWeight: 700, color: '#8A8F87', textTransform: 'uppercase', letterSpacing: '0.03em' },
  profitVal: { fontSize: 24, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.1 },
};
// items it carries with per-customer prices, add/remove items, and apply the
// QuickBooks-derived catalogs in bulk.
function OfficeCatalogs({ customers, items, onRefresh }) {
  const [selId, setSelId] = useState(null);
  const [custQuery, setCustQuery] = useState('');
  const [catalog, setCatalog] = useState(null); // { catalogOn, includeDefault, itemIds:Set, prices:Map }
  const [loading, setLoading] = useState(false);
  const [itemQuery, setItemQuery] = useState('');
  const [brand, setBrand] = useState('All');
  const [inCatalogOnly, setInCatalogOnly] = useState(false);
  const [applyMsg, setApplyMsg] = useState('');
  const [applying, setApplying] = useState(false);

  const selCustomer = customers.find(c => c.id === selId) || null;
  const brandList = useMemo(() => ['All', ...Array.from(new Set(items.map(i => i.brand))).sort()], [items]);
  const itemById = useMemo(() => { const m = {}; for (const it of items) m[it.id] = it; return m; }, [items]);

  const filteredCustomers = useMemo(() => {
    const q = custQuery.trim().toLowerCase();
    return customers.filter(c => !q || c.name.toLowerCase().includes(q));
  }, [customers, custQuery]);

  async function loadCatalog(id) {
    setLoading(true);
    try {
      const d = await apiGet(`/customers/${id}/catalog`);
      const prices = new Map();
      for (const o of (d.overrides || [])) if (o.present && o.price != null) prices.set(o.item_id, o.price);
      setCatalog({ catalogOn: d.catalogOn, includeDefault: d.includeDefault, itemIds: new Set(d.itemIds || []), prices });
    } catch (err) { setCatalog(null); }
    finally { setLoading(false); }
  }
  function selectCustomer(id) { setSelId(id); setItemQuery(''); setBrand('All'); setInCatalogOnly(false); loadCatalog(id); }

  async function setCatalogFlags(patch) {
    await apiPatch(`/customers/${selId}/catalog`, patch);
    await loadCatalog(selId);
  }
  async function toggleItem(itemId, present) {
    await apiPut(`/customers/${selId}/catalog/items`, present ? { add: [itemId] } : { remove: [itemId] });
    await loadCatalog(selId);
  }
  async function addBrand(brandName) {
    const ids = items.filter(i => i.brand === brandName).map(i => i.id);
    await apiPut(`/customers/${selId}/catalog/items`, { add: ids });
    await loadCatalog(selId);
  }
  async function savePrice(itemId, value) {
    await apiPut(`/customers/${selId}/catalog/price`, { itemId, price: value === '' ? null : Number(value) });
    await loadCatalog(selId);
  }
  async function handleApplyQB() {
    if (!window.confirm('Apply the QuickBooks catalogs & prices to all matched stores? This rebuilds each matched store\u2019s catalog from their order history.')) return;
    setApplying(true); setApplyMsg('');
    try {
      const r = await apiPost('/customers/apply-catalogs', {});
      await onRefresh();
      if (selId) await loadCatalog(selId);
      setApplyMsg(`Applied to ${r.customersMatched} stores — ${r.itemsAdded} items, ${r.pricesSet} prices set${r.itemsUnmatched ? `, ${r.itemsUnmatched} items skipped (not in app)` : ''}.`);
    } catch (err) { setApplyMsg(err.message || 'Could not apply catalogs.'); }
    finally { setApplying(false); }
  }

  const shownItems = useMemo(() => {
    const q = itemQuery.trim().toLowerCase();
    return items.filter(it => {
      if (brand !== 'All' && it.brand !== brand) return false;
      if (inCatalogOnly && !(catalog && catalog.itemIds.has(it.id))) return false;
      if (q && !(it.name.toLowerCase().includes(q) || String(it.id).toLowerCase().includes(q))) return false;
      return true;
    });
  }, [items, itemQuery, brand, inCatalogOnly, catalog]);

  const catalogCount = catalog ? catalog.itemIds.size : 0;

  return (
    <div>
      <div style={officeStyles.sectionHeader}>
        <div style={officeStyles.sectionTitle}>Store catalogs</div>
        <button style={officeStyles.smallBtn} onClick={handleApplyQB} disabled={applying} title="Rebuild every matched store's catalog & prices from the QuickBooks order-history export">
          {applying ? 'Applying…' : 'Apply QuickBooks catalogs'}
        </button>
        {applyMsg && <span style={{ fontSize: 12.5, color: '#5B6058' }}>{applyMsg}</span>}
      </div>
      <div style={catStyles.wrap}>
        {/* Left: customer list */}
        <div style={catStyles.leftCol}>
          <input style={officeStyles.searchSlim} placeholder="Search stores…" value={custQuery} onChange={e => setCustQuery(e.target.value)} />
          <div style={catStyles.custList}>
            {filteredCustomers.map(c => (
              <button key={c.id} style={{ ...catStyles.custRow, ...(c.id === selId ? catStyles.custRowActive : {}) }} onClick={() => selectCustomer(c.id)}>
                <span>{c.name}</span>
                <span style={c.catalogOn ? catStyles.onTag : catStyles.offTag}>{c.catalogOn ? 'on' : 'off'}</span>
              </button>
            ))}
          </div>
        </div>
        {/* Right: selected store's catalog */}
        <div style={catStyles.rightCol}>
          {!selCustomer && <div style={catStyles.empty}>Select a store to manage its catalog.</div>}
          {selCustomer && (
            <>
              <div style={catStyles.storeHead}>
                <div style={catStyles.storeName}>{selCustomer.name}</div>
                <label style={officeStyles.checkboxLabel}>
                  <input type="checkbox" checked={!!(catalog && catalog.catalogOn)} onChange={e => setCatalogFlags({ catalogOn: e.target.checked })} />
                  Catalog on (field can order)
                </label>
                <label style={officeStyles.checkboxLabel}>
                  <input type="checkbox" checked={!!(catalog && catalog.includeDefault)} onChange={e => setCatalogFlags({ includeDefault: e.target.checked })} />
                  Include default set
                </label>
                <div style={officeStyles.countPill}>{catalogCount} items</div>
              </div>
              <div style={catStyles.controls}>
                <input style={officeStyles.searchSlim} placeholder="Search items…" value={itemQuery} onChange={e => setItemQuery(e.target.value)} />
                <select style={officeStyles.sortSelect} value={brand} onChange={e => setBrand(e.target.value)}>
                  {brandList.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
                {brand !== 'All' && <button style={officeStyles.smallBtn} onClick={() => addBrand(brand)}>Add all {brand}</button>}
                <label style={officeStyles.checkboxLabel}>
                  <input type="checkbox" checked={inCatalogOnly} onChange={e => setInCatalogOnly(e.target.checked)} />
                  In catalog only
                </label>
              </div>
              {loading && <div style={catStyles.empty}>Loading…</div>}
              {!loading && (
                <div style={catStyles.tableWrap}>
                  <table style={officeStyles.table}>
                    <thead><tr>
                      <th style={{ ...officeStyles.th, textAlign: 'center', width: 60 }}>Carry</th>
                      <th style={officeStyles.th}>Item #</th>
                      <th style={officeStyles.th}>Item</th>
                      <th style={officeStyles.th}>Brand</th>
                      <th style={{ ...officeStyles.th, textAlign: 'right' }}>Base /ea</th>
                      <th style={{ ...officeStyles.th, textAlign: 'right' }}>This store /ea</th>
                    </tr></thead>
                    <tbody>
                      {shownItems.slice(0, 400).map(it => {
                        const inCat = catalog && catalog.itemIds.has(it.id);
                        const custPrice = catalog && catalog.prices.get(it.id);
                        return (
                          <tr key={it.id} style={!inCat ? { opacity: 0.55 } : undefined}>
                            <td style={{ ...officeStyles.td, textAlign: 'center' }}>
                              <input type="checkbox" checked={!!inCat} onChange={e => toggleItem(it.id, e.target.checked)} />
                            </td>
                            <td style={officeStyles.td}>{displayCode(it.id)}</td>
                            <td style={officeStyles.td}>{it.name}</td>
                            <td style={officeStyles.td}>{it.brand}</td>
                            <td style={{ ...officeStyles.td, textAlign: 'right', color: '#8A8F87' }}>{formatMoney(it.price)}</td>
                            <td style={{ ...officeStyles.td, textAlign: 'right' }}>
                              {inCat ? (
                                <CatalogPriceInput
                                  key={it.id + ':' + (custPrice ?? '')}
                                  value={custPrice}
                                  basePrice={it.price}
                                  onSave={v => savePrice(it.id, v)}
                                />
                              ) : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {shownItems.length > 400 && <div style={catStyles.empty}>Showing first 400 — narrow with search or brand.</div>}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Per-store price cell: shows the custom price (or a muted base-price placeholder).
function CatalogPriceInput({ value, basePrice, onSave }) {
  const [val, setVal] = useState(value == null ? '' : String(value));
  const [focused, setFocused] = useState(false);
  return (
    <input
      style={{ ...officeStyles.stockInput, width: 74, textAlign: 'right', ...(value == null ? { color: '#B9BDB2' } : {}) }}
      value={focused ? val : (value == null ? '' : String(value))}
      placeholder={formatMoney(basePrice).replace('$', '')}
      onFocus={() => { setFocused(true); setVal(value == null ? '' : String(value)); }}
      onChange={e => setVal(e.target.value.replace(/[^0-9.]/g, ''))}
      onBlur={() => { setFocused(false); if (val !== (value == null ? '' : String(value))) onSave(val); }}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      inputMode="decimal"
      title="Per-each price for this store (blank = base price)"
    />
  );
}

const catStyles = {
  wrap: { display: 'flex', gap: 16, alignItems: 'flex-start' },
  leftCol: { width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  custList: { border: '1px solid #E3E1D6', borderRadius: 10, background: '#FFFFFF', maxHeight: '70vh', overflowY: 'auto' },
  custRow: { display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '9px 12px', background: 'none', border: 'none', borderBottom: '1px solid #F0EEE6', fontSize: 13.5, fontWeight: 500, color: '#14181F', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' },
  custRowActive: { background: '#EAF1EE' },
  onTag: { fontSize: 10.5, fontWeight: 800, color: '#2B5D50', background: '#EAF1EE', border: '1px solid #C4DDD2', borderRadius: 20, padding: '1px 8px' },
  offTag: { fontSize: 10.5, fontWeight: 700, color: '#8A8F87', background: '#EFEDE4', border: '1px solid #E3E1D6', borderRadius: 20, padding: '1px 8px' },
  rightCol: { flex: 1, minWidth: 0 },
  empty: { fontSize: 13.5, color: '#8A8F87', padding: '30px 6px', fontStyle: 'italic' },
  storeHead: { display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 10 },
  storeName: { fontSize: 17, fontWeight: 800, color: '#14181F' },
  controls: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 },
  tableWrap: { border: '1px solid #E3E1D6', borderRadius: 10, overflow: 'hidden', maxHeight: '64vh', overflowY: 'auto' },
};

function OfficeCustomers({ customers, onRefresh }) {
  const [query, setQuery] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [shipToOpenId, setShipToOpenId] = useState(null);
  const [shipToSeedMsg, setShipToSeedMsg] = useState('');
  const [seeding, setSeeding] = useState(false);
  const [sortBy, setSortBy] = useState('name-asc'); // name-asc | name-desc | active-first | inactive-first

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
    const list = customers.filter(c => {
      if (!showInactive && !c.active) return false;
      return !q || c.name.toLowerCase().includes(q);
    });
    const byName = (a, b) => a.name.localeCompare(b.name);
    const sorted = [...list];
    if (sortBy === 'name-asc') sorted.sort(byName);
    else if (sortBy === 'name-desc') sorted.sort((a, b) => byName(b, a));
    else if (sortBy === 'active-first') sorted.sort((a, b) => (Number(!!b.active) - Number(!!a.active)) || byName(a, b));
    else if (sortBy === 'inactive-first') sorted.sort((a, b) => (Number(!!a.active) - Number(!!b.active)) || byName(a, b));
    return sorted;
  }, [customers, query, showInactive, sortBy]);

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
        <select style={officeStyles.sortSelect} value={sortBy} onChange={e => setSortBy(e.target.value)} title="Sort customers">
          <option value="name-asc">Name A–Z</option>
          <option value="name-desc">Name Z–A</option>
          <option value="active-first">Active first</option>
          <option value="inactive-first">Inactive first</option>
        </select>
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
      <div style={{ ...officeStyles.tableCard, overflowX: 'auto' }}>
        <table className={editMode ? 'cust-edit-tight' : ''} style={{ ...officeStyles.table, ...(editMode ? { minWidth: 900 } : {}) }}>
          <style>{`
            .cust-edit-tight th, .cust-edit-tight td { padding: 4px 6px !important; }
            .cust-edit-tight input, .cust-edit-tight select { padding: 4px 6px !important; font-size: 12.5px !important; }
            .cust-edit-tight input[type=checkbox] { transform: scale(1.15); }
          `}</style>
          <thead><tr>
            <th style={officeStyles.th}>Customer name</th>
            {editMode && <th style={officeStyles.th}>Usual delivery day</th>}
            {editMode && <th style={officeStyles.th}>Abbrev. (PO)</th>}
            {editMode && <th style={officeStyles.th}>Short name (memo)</th>}
            {editMode && <th style={officeStyles.th}>Terms</th>}
            {editMode && <th style={officeStyles.th}>Ship-to</th>}
            {editMode && <th style={{ ...officeStyles.th, textAlign: 'center' }}>Distrib.</th>}
            {editMode && <th style={{ ...officeStyles.th, textAlign: 'center' }}>Print order</th>}
            {editMode && <th style={{ ...officeStyles.th, textAlign: 'center' }}>No barcode</th>}
            <th style={{ ...officeStyles.th, textAlign: 'center' }}>Mobile</th>
            <th style={{ ...officeStyles.th, textAlign: 'center' }}>Active</th>
          </tr></thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td style={officeStyles.emptyCell} colSpan={editMode ? 11 : 3}>No customers match "{query}"</td></tr>
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
                    <CustomerTextField customer={c} field="abbreviation" value={c.abbreviation} placeholder="e.g. T2" width={70} onRefresh={onRefresh} />
                  </td>
                )}
                {editMode && (
                  <td style={officeStyles.td}>
                    <CustomerTextField customer={c} field="shortName" value={c.shortName} placeholder="e.g. Kahala" width={110} onRefresh={onRefresh} />
                  </td>
                )}
                {editMode && (
                  <td style={officeStyles.td}>
                    <select
                      style={{ ...officeStyles.select, minWidth: 130 }}
                      value={c.terms || ''}
                      onChange={async e => { await apiPatch(`/customers/${c.id}`, { terms: e.target.value || null }); await onRefresh(); }}
                    >
                      <option value="">Default (1% 10 Net 11)</option>
                      {TERMS_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
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
                  <input
                    type="checkbox"
                    checked={!!c.showOnMobile && c.showOnMobile !== 0}
                    onChange={async e => { await apiPatch(`/customers/${c.id}`, { showOnMobile: e.target.checked }); await onRefresh(); }}
                    title="Show this customer in the mobile field-rep picker"
                  />
                </td>
                {editMode && (
                  <td style={{ ...officeStyles.td, textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={!!c.isDistributor && c.isDistributor !== 0}
                      onChange={async e => { await apiPatch(`/customers/${c.id}`, { isDistributor: e.target.checked }); await onRefresh(); }}
                      title="Distributor: orders default to cases"
                    />
                  </td>
                )}
                {editMode && (
                  <td style={{ ...officeStyles.td, textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={!!c.usePrintOrder && c.usePrintOrder !== 0}
                      onChange={async e => { await apiPatch(`/customers/${c.id}`, { usePrintOrder: e.target.checked }); await onRefresh(); }}
                      title="Sort this customer's invoice & print sheet by the inventory print order (off = entry order)"
                    />
                  </td>
                )}
                {editMode && (
                  <td style={{ ...officeStyles.td, textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={!!c.hideBarcodes && c.hideBarcodes !== 0}
                      onChange={async e => { await apiPatch(`/customers/${c.id}`, { hideBarcodes: e.target.checked }); await onRefresh(); }}
                      title="Hide the barcode/UPC column on this customer's invoice"
                    />
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
                  <td colSpan={11} style={officeStyles.shipToCell}>
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
    width: '100%',
    maxWidth: 480,
    margin: '0 auto',
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxShadow: '0 1px 3px rgba(20,24,31,0.08)',
  },
  appDesktop: {
    fontFamily: "'Inter', system-ui, sans-serif",
    background: '#F7F8F4',
    width: '100%',
    maxWidth: 1440,
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
  header: { background: '#14181F', padding: 'calc(18px + env(safe-area-inset-top, 0px)) 16px 16px' },
  headerDesktop: { background: '#14181F', padding: '12px 16px', display: 'flex', gap: 10, alignItems: 'center' },
  headerTop: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 },
  officeLinkBtn: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', color: '#B7BCB2', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', padding: '4px 6px' },
  headerTitle: { color: '#EDEBE3', fontSize: 15, fontWeight: 600, letterSpacing: '0.01em' },
  customerBtn: { width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: '#EDEBE3', border: 'none', borderRadius: 10, padding: '11px 12px', cursor: 'pointer', fontFamily: 'inherit' },
  customerBtnText: { fontSize: 14, fontWeight: 500 },
  comboInput: { flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', fontSize: 14, fontWeight: 500, color: '#14181F', fontFamily: 'inherit' },
  comboDropdown: { position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, background: '#FFFFFF', border: '1px solid #D6D3C6', borderRadius: 10, boxShadow: '0 14px 36px rgba(20,24,31,0.22)', zIndex: 30, padding: 6, maxHeight: 320, overflowY: 'auto' },
  comboRow: { display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '9px 10px', fontSize: 13.5, color: '#14181F', cursor: 'pointer', fontFamily: 'inherit', borderRadius: 7, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  comboRowHi: { background: '#EAF1EE' },
  dateBtn: { position: 'relative', width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: '#EDEBE3', border: 'none', borderRadius: 10, padding: '11px 12px', cursor: 'pointer', marginTop: 8, boxSizing: 'border-box', fontFamily: 'inherit' },
  calToggleBtn: { marginLeft: 'auto', background: 'none', border: 'none', padding: 2, cursor: 'pointer', display: 'flex', alignItems: 'center' },
  calDropBtn: { marginLeft: 6, display: 'flex', alignItems: 'center', gap: 1, background: '#FFFFFF', border: '1px solid #D6D3C6', borderRadius: 7, padding: '4px 5px', cursor: 'pointer' },
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
  allItemsChip: { flexShrink: 0, background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 10, height: 38, padding: '0 14px', fontSize: 13, fontWeight: 700, color: '#5B6058', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  allItemsChipOn: { background: '#2B5D50', color: '#F7F8F4', border: '1px solid #2B5D50' },
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
  catalogNote: { textAlign: 'center', color: '#5B6058', fontSize: 14, padding: '40px 20px', fontStyle: 'italic', background: '#F0EEE4', border: '1px solid #E3E1D6', borderRadius: 12, margin: '8px 0' },
  mobileIifError: { display: 'flex', alignItems: 'center', gap: 10, background: '#F7DEDA', color: '#7A2E22', border: '1px solid #EFBEB4', borderRadius: 8, padding: '10px 14px', margin: '0 16px 12px', fontSize: 13 },
  mobileIifErrorDismiss: { marginLeft: 'auto', background: 'none', border: 'none', fontSize: 16, lineHeight: 1, cursor: 'pointer', color: 'inherit', padding: '0 4px' },
  itemRow: { display: 'flex', alignItems: 'center', gap: 14, padding: '8px 0', borderBottom: '1px solid #EAE8DD' },
  itemThumb: { width: 76, height: 76, borderRadius: 10, objectFit: 'contain', flexShrink: 0, background: '#FFFFFF', padding: 4, boxSizing: 'border-box' },
  itemName: { fontSize: 14, fontWeight: 600, color: '#14181F', marginBottom: 3 },
  itemMeta: { display: 'flex', alignItems: 'center', gap: 8 },
  sku: { fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#8A8F87' },
  stockTag: { fontSize: 11, fontWeight: 600, color: '#5B6058', background: '#EAE8DD', borderRadius: 5, padding: '2px 6px' },
  incomingTag: { fontSize: 11, fontWeight: 700, color: '#2B5D50', background: '#EAF1EE', border: '1px solid #C4DDD2', borderRadius: 5, padding: '2px 6px' },
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
  sheetLineCode: { fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 700, color: '#2B5D50', marginRight: 7 },
  ticketQtyWrap: { display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 },
  ticketQtyX: { fontFamily: "'JetBrains Mono', monospace", fontSize: 13.5, fontWeight: 700, color: '#8A8F87' },
  ticketQtyInput: { width: 46, textAlign: 'center', fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 700, color: '#14181F', background: '#F7F8F4', border: '1px solid #D6D3C6', borderRadius: 7, padding: '4px 4px', outline: 'none' },
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
  showAllCustLabel: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, color: '#5B6058', fontWeight: 600, padding: '2px 0 10px', cursor: 'pointer' },
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
  searchSlim: { width: '100%', background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 8, padding: '6px 10px', fontSize: 13, fontFamily: 'inherit', color: '#14181F', outline: 'none', boxSizing: 'border-box' },
  select: { background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 8, padding: '8px 12px', fontSize: 13.5, fontFamily: 'inherit', color: '#14181F', outline: 'none' },
  smallBtn: { background: '#EAE8DD', border: '1px solid #D6D3C6', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, fontWeight: 600, color: '#14181F', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  primarySmallBtn: { background: '#2B5D50', border: '1px solid #2B5D50', borderRadius: 8, padding: '8px 14px', fontSize: 12.5, fontWeight: 700, color: '#F7F8F4', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  batchBar: { display: 'flex', alignItems: 'center', gap: 12, background: '#EAF1EE', border: '1px solid #C4DDD2', borderRadius: 10, padding: '10px 16px', marginBottom: 10, flexWrap: 'wrap' },
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
  containsBtn: { display: 'inline-block', marginTop: 4, background: '#EAF1EE', border: '1px solid #C4DDD2', color: '#2B5D50', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
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
