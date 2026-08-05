import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  Search, Plus, Minus, X, Check, ChevronDown, ChevronLeft, Package, User,
  ClipboardList, LayoutGrid, Calendar, ClipboardCheck, Boxes, PlusCircle,
  AlertTriangle, ChevronRight, Loader2, WifiOff,
} from 'lucide-react';

// Your live backend, deployed on Render.
const API_BASE = 'https://ordering-app-ycc9.onrender.com/api';

const BRAND_COLORS = { Nike: '#2B5D50', Adidas: '#3E5C76', Puma: '#8A4A3D' };
const BRAND_FALLBACK_COLORS = ['#2B5D50', '#3E5C76', '#8A4A3D', '#6B5B95', '#457B7A', '#9C6644'];
function brandColor(brand, index) {
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

// ============================================================
// ROOT APP — owns shared data, fetched live from the backend
// ============================================================
export default function App() {
  const [items, setItems] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [orderHistory, setOrderHistory] = useState([]);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [tab, setTab] = useState('order');

  const loadAll = useCallback(async () => {
    try {
      const [itemsData, customersData, ordersData] = await Promise.all([
        apiGet('/items'),
        apiGet('/customers'),
        apiGet('/orders'),
      ]);
      setItems(itemsData);
      setCustomers(customersData);
      setOrderHistory(ordersData);
      setStatus('ready');
    } catch (err) {
      setStatus('error');
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  if (status === 'loading') {
    return (
      <div style={styles.app}>
        <style>{fontImport}</style>
        <div style={styles.centerState}>
          <Loader2 size={22} color="#2B5D50" style={{ animation: 'spin 0.8s linear infinite' }} />
          <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
          <div style={styles.centerStateText}>Loading live inventory…</div>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div style={styles.app}>
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

  return (
    <div style={styles.app}>
      <style>{fontImport}</style>
      <div style={styles.tabContent}>
        {tab === 'order' && (
          <OrderTab items={items} customers={customers} onOrderSubmitted={loadAll} />
        )}
        {tab === 'inventory' && <InventoryTab items={items} />}
        {tab === 'orders' && <OrdersTab orders={orderHistory} />}
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
function OrderTab({ items, customers, onOrderSubmitted }) {
  const [customerId, setCustomerId] = useState(null);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState('');
  const [dateOpen, setDateOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [brand, setBrand] = useState('All');
  const [query, setQuery] = useState('');
  const [screen, setScreen] = useState('brands');
  const [order, setOrder] = useState([]);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const customerName = customers.find(c => c.id === customerId)?.name || '';

  const brandList = useMemo(() => Array.from(new Set(items.map(i => i.brand))), [items]);
  const brandCounts = useMemo(() => {
    const counts = {};
    items.forEach(i => { counts[i.brand] = (counts[i.brand] || 0) + 1; });
    return counts;
  }, [items]);

  const searching = query.trim().length > 0;

  const filteredItems = useMemo(() => {
    const effectiveBrand = screen === 'brands' ? 'All' : brand;
    return items.filter(i => {
      const brandMatch = effectiveBrand === 'All' || i.brand === effectiveBrand;
      const q = query.trim().toLowerCase();
      const queryMatch = !q || i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q);
      return brandMatch && queryMatch;
    });
  }, [items, brand, query, screen]);

  const orderLines = useMemo(() => {
    return order.map(o => {
      const item = items.find(i => i.id === o.id);
      return item ? { ...item, qty: o.qty } : null;
    }).filter(Boolean);
  }, [order, items]);

  const totalUnits = orderLines.reduce((s, l) => s + l.qty, 0);

  function qtyFor(id) { return order.find(o => o.id === id)?.qty || 0; }

  function setQty(id, qty) {
    const item = items.find(i => i.id === id);
    if (!item) return;
    const clamped = Math.max(0, Math.min(qty, item.stock));
    setOrder(prev => {
      const exists = prev.find(o => o.id === id);
      if (clamped === 0) return prev.filter(o => o.id !== id);
      if (exists) return prev.map(o => (o.id === id ? { ...o, qty: clamped } : o));
      return [...prev, { id, qty: clamped }];
    });
  }

  async function submitOrder() {
    if (!customerId || !deliveryDate || orderLines.length === 0) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const result = await apiPost('/orders', {
        customerId,
        deliveryDate,
        lines: orderLines.map(l => ({ itemId: l.id, qty: l.qty })),
      });
      setConfirmed({
        customer: customerName,
        deliveryDate,
        submittedAt: 'Just now',
        lines: result.lines,
        totalUnits,
      });
      setOrder([]);
      setTicketOpen(false);
      setCustomerId(null);
      setDeliveryDate('');
      setQuery('');
      setScreen('brands');
      setBrand('All');
      await onOrderSubmitted(); // refresh items + order history from server
    } catch (err) {
      setSubmitError(err.message || 'Something went wrong submitting this order.');
    } finally {
      setSubmitting(false);
    }
  }

  if (confirmed) {
    return <Confirmation data={confirmed} onNewOrder={() => setConfirmed(null)} />;
  }

  return (
    <div style={styles.screenWrap}>
      <div style={styles.header}>
        <div style={styles.headerTop}>
          <Package size={18} color="#EDEBE3" strokeWidth={2} />
          <span style={styles.headerTitle}>New Order</span>
        </div>
        <button style={styles.customerBtn} onClick={() => setCustomerOpen(true)}>
          <User size={16} color={customerId ? '#14181F' : '#8A8F87'} />
          <span style={{ ...styles.customerBtnText, color: customerId ? '#14181F' : '#8A8F87' }}>
            {customerName || 'Select customer'}
          </span>
          <ChevronDown size={16} color="#8A8F87" style={{ marginLeft: 'auto' }} />
        </button>
        <button style={styles.dateBtn} onClick={() => setDateOpen(true)}>
          <Calendar size={16} color={deliveryDate ? '#14181F' : '#8A8F87'} />
          <span style={{ ...styles.customerBtnText, color: deliveryDate ? '#14181F' : '#8A8F87' }}>
            {deliveryDate ? formatDate(deliveryDate) : 'Delivery date'}
          </span>
          <ChevronDown size={16} color="#8A8F87" style={{ marginLeft: 'auto' }} />
        </button>
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

      {screen === 'brands' && !searching && (
        <div style={styles.brandGrid}>
          {brandList.map((b, idx) => (
            <button
              key={b}
              style={{ ...styles.brandTile, background: brandColor(b, idx) }}
              onClick={() => { setBrand(b); setScreen('items'); }}
            >
              <span style={styles.brandTileName}>{b}</span>
              <span style={styles.brandTileCount}>{brandCounts[b] || 0} items</span>
            </button>
          ))}
        </div>
      )}

      {screen === 'items' && !searching && (
        <div style={styles.itemsSubHeader}>
          <button style={styles.backBtn} onClick={() => { setScreen('brands'); setBrand('All'); }}>
            <ChevronLeft size={16} color="#14181F" />
            <span>Brands</span>
          </button>
          <span style={styles.itemsSubHeaderBrand}>{brand}</span>
        </div>
      )}
      {searching && (
        <div style={styles.itemsSubHeader}>
          <span style={styles.itemsSubHeaderBrand}>
            <LayoutGrid size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
            Searching all brands
          </span>
        </div>
      )}

      {(screen === 'items' || searching) && (
        <div style={styles.list}>
          {filteredItems.length === 0 && (
            <div style={styles.emptyState}>No items match "{query}"</div>
          )}
          {filteredItems.map(item => {
            const qty = qtyFor(item.id);
            const low = item.stock <= 5;
            return (
              <div key={item.id} style={styles.itemRow}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={styles.itemName}>{item.name}</div>
                  <div style={styles.itemMeta}>
                    <span style={styles.sku}>{item.id}</span>
                    <span style={{ ...styles.stockTag, ...(low ? styles.stockTagLow : {}) }}>
                      {item.stock} in stock
                    </span>
                  </div>
                </div>
                <div style={styles.stepper}>
                  <button style={styles.stepBtn} onClick={() => setQty(item.id, qty - 1)} disabled={qty === 0}>
                    <Minus size={14} color={qty === 0 ? '#C7CBC1' : '#14181F'} />
                  </button>
                  <span style={styles.stepQty}>{qty}</span>
                  <button style={styles.stepBtn} onClick={() => setQty(item.id, qty + 1)} disabled={qty >= item.stock}>
                    <Plus size={14} color={qty >= item.stock ? '#C7CBC1' : '#14181F'} />
                  </button>
                </div>
              </div>
            );
          })}
          <div style={{ height: 96 }} />
        </div>
      )}

      {totalUnits > 0 && (
        <div style={styles.ticketBar} onClick={() => setTicketOpen(true)}>
          <div style={styles.ticketStub} />
          <div style={styles.ticketBarContent}>
            <ClipboardList size={18} color="#EDEBE3" />
            <span style={styles.ticketBarText}>
              {totalUnits} {totalUnits === 1 ? 'unit' : 'units'} · {orderLines.length} {orderLines.length === 1 ? 'item' : 'items'}
            </span>
            <span style={styles.ticketBarCta}>Review order</span>
          </div>
        </div>
      )}

      {ticketOpen && (
        <div style={styles.sheetOverlay} onClick={() => !submitting && setTicketOpen(false)}>
          <div style={styles.sheet} onClick={e => e.stopPropagation()}>
            <div style={styles.sheetHandle} />
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
                    <div style={styles.sheetLineSku}>{l.id}</div>
                  </div>
                  <div style={styles.sheetLineQty}>×{l.qty}</div>
                  <button style={styles.removeBtn} onClick={() => setQty(l.id, 0)} disabled={submitting}>
                    <X size={14} color="#8A8F87" />
                  </button>
                </div>
              ))}
            </div>
            <div style={styles.sheetTotal}>
              <span>Total units</span>
              <span style={styles.sheetTotalNum}>{totalUnits}</span>
            </div>
            {submitError && <div style={styles.sheetWarning}>{submitError}</div>}
            <button
              style={{ ...styles.submitBtn, ...((customerId && deliveryDate && !submitting) ? {} : styles.submitBtnDisabled) }}
              disabled={!customerId || !deliveryDate || submitting}
              onClick={submitOrder}
            >
              {submitting ? (
                <Loader2 size={16} color="#F7F8F4" style={{ animation: 'spin 0.8s linear infinite' }} />
              ) : (
                <Check size={16} color="#F7F8F4" />
              )}
              {submitting ? 'Submitting…' : 'Submit order'}
            </button>
            {!submitting && (!customerId || !deliveryDate) && (
              <div style={styles.sheetWarning}>
                {!customerId && !deliveryDate ? 'Select a customer and delivery date to submit this order'
                  : !customerId ? 'Select a customer to submit this order'
                  : 'Set a delivery date to submit this order'}
              </div>
            )}
          </div>
        </div>
      )}

      {customerOpen && (
        <div style={styles.sheetOverlay} onClick={() => setCustomerOpen(false)}>
          <div style={styles.sheet} onClick={e => e.stopPropagation()}>
            <div style={styles.sheetHandle} />
            <div style={styles.sheetHeader}>
              <span style={styles.sheetTitle}>Select customer</span>
              <button style={styles.iconBtn} onClick={() => setCustomerOpen(false)}>
                <X size={18} color="#8A8F87" />
              </button>
            </div>
            <div style={styles.sheetLines}>
              {customers.map(c => (
                <button key={c.id} style={styles.customerRow} onClick={() => { setCustomerId(c.id); setCustomerOpen(false); }}>
                  <User size={15} color="#8A8F87" />
                  <span>{c.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {dateOpen && (
        <div style={styles.sheetOverlay} onClick={() => setDateOpen(false)}>
          <div style={styles.sheet} onClick={e => e.stopPropagation()}>
            <div style={styles.sheetHandle} />
            <div style={styles.sheetHeader}>
              <span style={styles.sheetTitle}>Delivery date</span>
              <button style={styles.iconBtn} onClick={() => setDateOpen(false)}>
                <X size={18} color="#8A8F87" />
              </button>
            </div>
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
                    onClick={() => { setDeliveryDate(iso); setDateOpen(false); }}
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
                <div style={styles.receiptSku}>{l.id}</div>
              </div>
              <span style={styles.receiptQty}>{l.qty}</span>
            </div>
          ))}
          <div style={styles.receiptDivider} />
          <div style={styles.receiptTotalRow}>
            <span>Total units</span>
            <span style={styles.receiptTotalNum}>{data.totalUnits}</span>
          </div>
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
function InventoryTab({ items }) {
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

  const filteredItems = useMemo(() => {
    const effectiveBrand = screen === 'brands' ? 'All' : brand;
    return items
      .filter(i => {
        const brandMatch = effectiveBrand === 'All' || i.brand === effectiveBrand;
        const q = query.trim().toLowerCase();
        const queryMatch = !q || i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q);
        const lowMatch = !lowOnly || i.stock <= 5;
        return brandMatch && queryMatch && lowMatch;
      })
      .sort((a, b) => a.stock - b.stock);
  }, [items, brand, query, screen, lowOnly]);

  return (
    <div style={styles.screenWrap}>
      <div style={styles.header}>
        <div style={styles.headerTop}>
          <Boxes size={18} color="#EDEBE3" strokeWidth={2} />
          <span style={styles.headerTitle}>Inventory</span>
        </div>
        <button
          style={{ ...styles.lowStockBtn, ...(lowOnly ? styles.lowStockBtnActive : {}) }}
          onClick={() => setLowOnly(v => !v)}
        >
          <AlertTriangle size={15} color={lowOnly ? '#F7F8F4' : '#E7A98B'} />
          <span style={{ color: lowOnly ? '#F7F8F4' : '#EDEBE3' }}>
            {lowStockTotal} item{lowStockTotal === 1 ? '' : 's'} low on stock
          </span>
        </button>
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
          {brandList.map((b, idx) => (
            <button
              key={b}
              style={{ ...styles.brandTile, background: brandColor(b, idx) }}
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
          <button style={styles.backBtn} onClick={() => { setScreen('brands'); setBrand('All'); }}>
            <ChevronLeft size={16} color="#14181F" />
            <span>Brands</span>
          </button>
          <span style={styles.itemsSubHeaderBrand}>{brand}</span>
        </div>
      )}
      {(searching || lowOnly) && (
        <div style={styles.itemsSubHeader}>
          <span style={styles.itemsSubHeaderBrand}>
            {lowOnly ? 'Low stock, all brands' : (
              <><LayoutGrid size={13} style={{ marginRight: 6, verticalAlign: -2 }} />Searching all brands</>
            )}
          </span>
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
                    <span style={styles.sku}>{item.id}</span>
                    <span style={styles.brandLabel}>{item.brand}</span>
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
function OrdersTab({ orders }) {
  const [openId, setOpenId] = useState(null);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter(o =>
      o.customer.toLowerCase().includes(q) ||
      o.lines.some(l => l.name.toLowerCase().includes(q) || l.id.toLowerCase().includes(q))
    );
  }, [orders, query]);

  return (
    <div style={styles.screenWrap}>
      <div style={styles.header}>
        <div style={styles.headerTop}>
          <ClipboardCheck size={18} color="#EDEBE3" strokeWidth={2} />
          <span style={styles.headerTitle}>Orders</span>
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

      <div style={styles.list}>
        {filtered.length === 0 && <div style={styles.emptyState}>No orders match "{query}"</div>}
        {filtered.map(o => {
          const isOpen = openId === o.id;
          const totalUnits = o.lines.reduce((s, l) => s + l.qty, 0);
          return (
            <div key={o.id} style={styles.orderCard}>
              <button style={styles.orderCardHeader} onClick={() => setOpenId(isOpen ? null : o.id)}>
                <div style={{ textAlign: 'left' }}>
                  <div style={styles.orderCardCustomer}>{o.customer}</div>
                  <div style={styles.orderCardMeta}>
                    {formatDateTime(o.submittedAt)} · {totalUnits} units · {o.lines.length} item{o.lines.length === 1 ? '' : 's'}
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
                        <div style={styles.sheetLineSku}>{l.id}</div>
                      </div>
                      <div style={styles.sheetLineQty}>×{l.qty}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div style={{ height: 24 }} />
      </div>
    </div>
  );
}

const fontImport = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap');
`;

const styles = {
  app: {
    fontFamily: "'Inter', system-ui, sans-serif",
    background: '#F7F8F4',
    height: '100vh',
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
  centerState: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 },
  centerStateText: { fontSize: 13, color: '#5B6058', fontWeight: 600 },
  retryBtn: { marginTop: 6, background: '#2B5D50', color: '#F7F8F4', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  tabContent: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
  screenWrap: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' },
  tabBar: { display: 'flex', borderTop: '1px solid #E3E1D6', background: '#FFFFFF', padding: '8px 0 10px' },
  tabBtn: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: '4px 0' },
  tabBtnLabel: { fontSize: 10.5, fontWeight: 700 },
  header: { background: '#14181F', padding: '18px 16px 16px' },
  headerTop: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 },
  headerTitle: { color: '#EDEBE3', fontSize: 15, fontWeight: 600, letterSpacing: '0.01em' },
  customerBtn: { width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: '#EDEBE3', border: 'none', borderRadius: 10, padding: '11px 12px', cursor: 'pointer', fontFamily: 'inherit' },
  customerBtnText: { fontSize: 14, fontWeight: 500 },
  dateBtn: { position: 'relative', width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: '#EDEBE3', border: 'none', borderRadius: 10, padding: '11px 12px', cursor: 'pointer', marginTop: 8, boxSizing: 'border-box', fontFamily: 'inherit' },
  lowStockBtn: { width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: '#2A2E23', border: '1px solid #3C4132', borderRadius: 10, padding: '10px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600 },
  lowStockBtnActive: { background: '#B5493B', border: '1px solid #B5493B' },
  orderCountPill: { display: 'inline-block', color: '#EDEBE3', fontSize: 12.5, fontWeight: 600, background: '#2A2E23', borderRadius: 999, padding: '6px 12px' },
  searchWrap: { position: 'relative', display: 'flex', alignItems: 'center', padding: '14px 16px 8px' },
  searchIcon: { position: 'absolute', left: 28, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' },
  searchInput: { width: '100%', boxSizing: 'border-box', background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 10, padding: '10px 12px 10px 38px', fontSize: 14, fontFamily: 'inherit', color: '#14181F', outline: 'none' },
  clearSearchBtn: { position: 'absolute', right: 28, top: '50%', transform: 'translateY(-50%)', background: '#EAE8DD', border: 'none', borderRadius: '50%', width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
  brandGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: '8px 16px 4px' },
  brandTile: { border: 'none', borderRadius: 14, padding: '20px 14px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, cursor: 'pointer', minHeight: 78 },
  brandTileName: { color: '#F7F8F4', fontSize: 15, fontWeight: 700 },
  brandTileCount: { color: 'rgba(247,248,244,0.75)', fontSize: 11.5, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" },
  itemsSubHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px 6px' },
  backBtn: { display: 'flex', alignItems: 'center', gap: 2, background: 'none', border: 'none', color: '#14181F', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: 'inherit' },
  itemsSubHeaderBrand: { fontSize: 13, fontWeight: 700, color: '#5B6058', textTransform: 'uppercase', letterSpacing: '0.04em' },
  list: { flex: 1, overflowY: 'auto', padding: '4px 16px' },
  emptyState: { textAlign: 'center', color: '#8A8F87', fontSize: 13.5, padding: '32px 0' },
  itemRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid #EAE8DD' },
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
  ticketBarText: { color: '#EDEBE3', fontSize: 13.5, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" },
  ticketBarCta: { marginLeft: 'auto', color: '#EDEBE3', fontSize: 13, fontWeight: 600, background: '#2B5D50', padding: '6px 12px', borderRadius: 7 },
  sheetOverlay: { position: 'absolute', inset: 0, background: 'rgba(20,24,31,0.45)', display: 'flex', alignItems: 'flex-end', zIndex: 10 },
  sheet: { background: '#F7F8F4', width: '100%', maxHeight: '80%', borderRadius: '18px 18px 0 0', padding: '10px 16px 20px', display: 'flex', flexDirection: 'column', boxShadow: '0 -4px 20px rgba(20,24,31,0.15)' },
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
  removeBtn: { background: 'none', border: 'none', cursor: 'pointer', padding: 4 },
  sheetTotal: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0 10px', fontSize: 13, fontWeight: 600, color: '#5B6058' },
  sheetTotalNum: { fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 700, color: '#14181F' },
  submitBtn: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: '#2B5D50', color: '#F7F8F4', border: 'none', borderRadius: 10, padding: '13px', fontSize: 14.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  submitBtnDisabled: { background: '#C7CBC1', cursor: 'not-allowed' },
  sheetWarning: { textAlign: 'center', fontSize: 12, color: '#B5493B', marginTop: 8 },
  customerRow: { width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '13px 4px', background: 'none', border: 'none', borderBottom: '1px solid #EAE8DD', fontSize: 14, fontWeight: 500, color: '#14181F', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' },
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
  orderCardHeader: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: 'none', border: 'none', padding: '13px 14px', cursor: 'pointer', fontFamily: 'inherit' },
  orderCardCustomer: { fontSize: 14, fontWeight: 700, color: '#14181F' },
  orderCardMeta: { fontSize: 11.5, color: '#8A8F87', marginTop: 2 },
  orderCardDelivery: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: '#5B6058', background: '#EAE8DD', borderRadius: 999, padding: '4px 8px', whiteSpace: 'nowrap' },
  orderCardLines: { borderTop: '1px solid #EAE8DD', padding: '4px 14px' },
  orderCardLine: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid #EAE8DD' },
};
