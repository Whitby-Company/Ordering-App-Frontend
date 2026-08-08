import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  Search, Plus, Minus, X, Check, ChevronDown, ChevronLeft, Package, User,
  ClipboardList, LayoutGrid, Calendar, ClipboardCheck, Boxes, PlusCircle,
  AlertTriangle, ChevronRight, Loader2, WifiOff, RefreshCw, Monitor,
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
function formatMoney(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}
// Price is stored per single "each"; each case/pack ordered contains
// item.pack eaches. Line total = price × pack size × cases ordered.
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
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [tab, setTab] = useState('order');
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
      const [itemsData, customersData, itemsAllData, customersAllData, ordersData] = await Promise.all([
        apiGet('/items'),
        apiGet('/customers'),
        apiGet('/items?includeInactive=true'),
        apiGet('/customers?includeInactive=true'),
        apiGet('/orders'),
      ]);
      setItems(itemsData);
      setCustomers(customersData);
      setItemsAll(itemsAllData);
      setCustomersAll(customersAllData);
      setOrderHistory(ordersData);
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
          orders={orderHistory}
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
      <div style={styles.tabContent}>
        {tab === 'order' && (
          <OrderTab items={items} customers={customers} onOrderSubmitted={loadAll} />
        )}
        {tab === 'inventory' && <InventoryTab items={items} />}
        {tab === 'orders' && <OrdersTab orders={orderHistory} />}
      </div>
      <TabBar
        active={tab}
        onChange={setTab}
        onSwitchToOffice={() => setOverride('desktop')}
        isManualOverride={!!viewOverride}
        onResetToAuto={() => setOverride(null)}
      />
    </div>
  );
}

function TabBar({ active, onChange, onSwitchToOffice }) {
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
      <button style={styles.tabBtn} onClick={onSwitchToOffice}>
        <Monitor size={20} color="#8A8F87" strokeWidth={2} />
        <span style={{ ...styles.tabBtnLabel, color: '#8A8F87' }}>Office View</span>
      </button>
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
                    {item.packLabel && <span style={styles.brandLabel}>{item.packLabel}</span>}
                    <span style={{ ...styles.stockTag, ...(low ? styles.stockTagLow : {}) }}>
                      {item.stock} in stock
                    </span>
                  </div>
                  {item.price > 0 && (
                    <div style={styles.itemMeta}>
                      <span style={styles.brandLabel}>
                        {formatMoney(item.price)}/ea{item.pack > 1 ? ` · ${formatMoney(casePrice(item))}/case of ${item.pack}` : ''}
                      </span>
                    </div>
                  )}
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
                    <div style={styles.sheetLineSku}>
                      {l.id}{l.price > 0 ? ` · ${formatMoney(lineTotal(l, l.qty))}` : ''}
                    </div>
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
            {orderLines.some(l => l.price > 0) && (
              <div style={styles.sheetTotal}>
                <span>Order total</span>
                <span style={styles.sheetTotalNum}>
                  {formatMoney(orderLines.reduce((s, l) => s + lineTotal(l, l.qty), 0))}
                </span>
              </div>
            )}
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
                <div style={styles.receiptSku}>
                  {l.id}{l.price > 0 ? ` · ${formatMoney(lineTotal(l, l.qty))}` : ''}
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
                    {item.packLabel && <span style={styles.brandLabel}>{item.packLabel}</span>}
                    {item.price > 0 && (
                      <span style={styles.brandLabel}>
                        {formatMoney(item.price)}/ea{item.pack > 1 ? ` · ${formatMoney(casePrice(item))}/case` : ''}
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

// ============================================================
// DESKTOP — OFFICE VIEW (orders table for QuickBooks entry,
// inventory table with editable stock)
// ============================================================
function OfficeView({ items, customers, orders, onRefresh, onSwitchToMobile, isManualOverride, onResetToAuto }) {
  const [section, setSection] = useState('orders');
  const [refreshing, setRefreshing] = useState(false);

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
            style={{ ...officeStyles.navBtn, ...(section === 'orders' ? officeStyles.navBtnActive : {}) }}
            onClick={() => setSection('orders')}
          >
            Orders
          </button>
          <button
            style={{ ...officeStyles.navBtn, ...(section === 'inventory' ? officeStyles.navBtnActive : {}) }}
            onClick={() => setSection('inventory')}
          >
            Inventory
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

      <div style={officeStyles.body}>
        {section === 'orders' && <OfficeOrders orders={orders} />}
        {section === 'inventory' && <OfficeInventory items={items} onRefresh={onRefresh} />}
        {section === 'customers' && <OfficeCustomers customers={customers} onRefresh={onRefresh} />}
      </div>
    </div>
  );
}

function OfficeOrders({ orders }) {
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter(o =>
      o.customer.toLowerCase().includes(q) ||
      o.lines.some(l => l.name.toLowerCase().includes(q) || l.id.toLowerCase().includes(q))
    );
  }, [orders, query]);

  function orderTotal(o) {
    return o.lines.reduce((s, l) => s + lineTotal(l, l.qty), 0);
  }

  return (
    <div>
      <div style={officeStyles.sectionHeader}>
        <div style={officeStyles.sectionTitle}>Orders</div>
        <input
          style={officeStyles.search}
          placeholder="Search by customer or item…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <div style={officeStyles.countPill}>{filtered.length} order{filtered.length === 1 ? '' : 's'}</div>
      </div>

      <div style={officeStyles.tableCard}>
        <table style={officeStyles.table}>
          <thead>
            <tr>
              <th style={officeStyles.th}></th>
              <th style={officeStyles.th}>Customer</th>
              <th style={officeStyles.th}>Delivery date</th>
              <th style={officeStyles.th}>Submitted</th>
              <th style={officeStyles.th}>Items</th>
              <th style={officeStyles.th}>Units</th>
              <th style={{ ...officeStyles.th, textAlign: 'right' }}>Order total</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td style={officeStyles.emptyCell} colSpan={7}>No orders match "{query}"</td></tr>
            )}
            {filtered.map(o => {
              const isOpen = openId === o.id;
              const totalUnits = o.lines.reduce((s, l) => s + l.qty, 0);
              return (
                <React.Fragment key={o.id}>
                  <tr style={officeStyles.rowClickable} onClick={() => setOpenId(isOpen ? null : o.id)}>
                    <td style={officeStyles.td}>
                      <ChevronRight size={14} color="#8A8F87" style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
                    </td>
                    <td style={{ ...officeStyles.td, fontWeight: 700 }}>{o.customer}</td>
                    <td style={officeStyles.td}>{formatDate(o.deliveryDate)}</td>
                    <td style={officeStyles.td}>{formatDateTime(o.submittedAt)}</td>
                    <td style={officeStyles.td}>{o.lines.length}</td>
                    <td style={officeStyles.td}>{totalUnits}</td>
                    <td style={{ ...officeStyles.td, textAlign: 'right', fontWeight: 700 }}>{formatMoney(orderTotal(o))}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td style={officeStyles.detailCell} colSpan={7}>
                        <table style={officeStyles.subTable}>
                          <thead>
                            <tr>
                              <th style={officeStyles.subTh}>SKU</th>
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
                                <td style={officeStyles.subTd}>{l.id}</td>
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
    </div>
  );
}

function OfficeInventory({ items, onRefresh }) {
  const [query, setQuery] = useState('');
  const [brand, setBrand] = useState('All');
  const [showInactive, setShowInactive] = useState(false);
  const [renamingBrand, setRenamingBrand] = useState(false);
  const [brandNameInput, setBrandNameInput] = useState('');

  const brandList = useMemo(() => Array.from(new Set(items.map(i => i.brand))).sort(), [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(i => {
      if (!showInactive && !i.active) return false;
      const brandMatch = brand === 'All' || i.brand === brand;
      const queryMatch = !q || i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q);
      return brandMatch && queryMatch;
    });
  }, [items, query, brand, showInactive]);

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

  return (
    <div>
      <div style={officeStyles.sectionHeader}>
        <div style={officeStyles.sectionTitle}>Inventory</div>
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
        {brand !== 'All' && !renamingBrand && (
          <>
            <button style={officeStyles.smallBtn} onClick={toggleBrand}>
              {brandAllActive ? 'Deactivate brand' : 'Activate brand'}
            </button>
            <button style={officeStyles.smallBtn} onClick={startRenameBrand}>Rename brand</button>
          </>
        )}
        <label style={officeStyles.checkboxLabel}>
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
        <div style={officeStyles.countPill}>{filtered.length} item{filtered.length === 1 ? '' : 's'}</div>
      </div>

      <div style={officeStyles.tableCard}>
        <table style={officeStyles.table}>
          <thead>
            <tr>
              <th style={officeStyles.th}>SKU</th>
              <th style={officeStyles.th}>Item</th>
              <th style={officeStyles.th}>Brand</th>
              <th style={{ ...officeStyles.th, textAlign: 'right' }}>Pack</th>
              <th style={{ ...officeStyles.th, textAlign: 'right' }}>Price/ea</th>
              <th style={{ ...officeStyles.th, textAlign: 'right' }}>Case price</th>
              <th style={{ ...officeStyles.th, textAlign: 'right' }}>Stock</th>
              <th style={{ ...officeStyles.th, textAlign: 'center' }}>Active</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td style={officeStyles.emptyCell} colSpan={8}>No items match "{query}"</td></tr>
            )}
            {filtered.map(item => (
              <tr key={item.id} style={!item.active ? officeStyles.rowInactive : undefined}>
                <td style={officeStyles.td}>{item.id}</td>
                <td style={officeStyles.td}>
                  <TextFieldEditor item={item} field="name" onSaved={onRefresh} />
                </td>
                <td style={officeStyles.td}>
                  <TextFieldEditor item={item} field="brand" onSaved={onRefresh} />
                </td>
                <td style={{ ...officeStyles.td, textAlign: 'right' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                    <NumberFieldEditor item={item} field="pack" onSaved={onRefresh} min={1} width={56} />
                    {item.packLabel && <span style={{ fontSize: 10.5, color: '#8A8F87' }}>{item.packLabel}</span>}
                  </div>
                </td>
                <td style={{ ...officeStyles.td, textAlign: 'right' }}>
                  <NumberFieldEditor item={item} field="price" onSaved={onRefresh} min={0} step={0.01} prefix="$" width={64} />
                </td>
                <td style={{ ...officeStyles.td, textAlign: 'right' }}>{formatMoney(casePrice(item))}</td>
                <td style={{ ...officeStyles.td, textAlign: 'right' }}>
                  <StockEditor item={item} onSaved={onRefresh} />
                </td>
                <td style={{ ...officeStyles.td, textAlign: 'center' }}>
                  <ActiveToggle
                    active={!!item.active}
                    onToggle={async next => { await apiPatch(`/items/${encodeURIComponent(item.id)}`, { active: next }); await onRefresh(); }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TextFieldEditor({ item, field, onSaved, placeholder }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(item[field] || '');
  const [saving, setSaving] = useState(false);
  const original = item[field] || '';

  async function save() {
    const trimmed = value.trim();
    if (!trimmed || trimmed === original) { setValue(original); setEditing(false); return; }
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
      <button style={officeStyles.nameEditBtn} onClick={() => { setValue(original); setEditing(true); }} title={`Click to edit ${field}`}>
        {original || <span style={{ color: '#8A8F87' }}>{placeholder || '—'}</span>}
      </button>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <input
        style={officeStyles.nameInput}
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setValue(original); setEditing(false); } }}
        autoFocus
      />
      {saving && <Loader2 size={13} color="#8A8F87" style={{ animation: 'spin 0.8s linear infinite' }} />}
    </span>
  );
}

function NumberFieldEditor({ item, field, onSaved, min = 0, step = 1, prefix = '', width = 70 }) {
  const original = Number(item[field]) || 0;
  const [value, setValue] = useState(String(original));
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

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
        onBlur={save}
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

function StockEditor({ item, onSaved }) {
  const [value, setValue] = useState(String(item.stock));
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const dirty = Number(value) !== item.stock;

  async function save() {
    const num = Number(value);
    if (Number.isNaN(num) || num < 0) { setValue(String(item.stock)); return; }
    if (num === item.stock) return;
    setSaving(true);
    try {
      await apiPatch(`/items/${encodeURIComponent(item.id)}`, { stock: num });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1200);
      await onSaved();
    } catch (err) {
      setValue(String(item.stock));
    } finally {
      setSaving(false);
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <input
        style={{ ...officeStyles.stockInput, ...(item.stock <= 5 ? officeStyles.stockInputLow : {}) }}
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
        inputMode="numeric"
      />
      {saving && <Loader2 size={13} color="#8A8F87" style={{ animation: 'spin 0.8s linear infinite' }} />}
      {!saving && savedFlash && <Check size={14} color="#2B5D50" />}
      {!saving && !savedFlash && dirty && <span style={officeStyles.unsavedDot} />}
    </span>
  );
}

function OfficeCustomers({ customers, onRefresh }) {
  const [query, setQuery] = useState('');
  const [showInactive, setShowInactive] = useState(false);
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
        <label style={officeStyles.checkboxLabel}>
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
        <div style={officeStyles.countPill}>{filtered.length} customer{filtered.length === 1 ? '' : 's'}</div>
      </div>
      <div style={officeStyles.tableCard}>
        <table style={officeStyles.table}>
          <thead><tr><th style={officeStyles.th}>Customer name</th><th style={{ ...officeStyles.th, textAlign: 'center' }}>Active</th></tr></thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td style={officeStyles.emptyCell} colSpan={2}>No customers match "{query}"</td></tr>
            )}
            {filtered.map(c => (
              <tr key={c.id} style={!c.active ? officeStyles.rowInactive : undefined}>
                <td style={officeStyles.td}>{c.name}</td>
                <td style={{ ...officeStyles.td, textAlign: 'center' }}>
                  <ActiveToggle
                    active={!!c.active}
                    onToggle={async next => { await apiPatch(`/customers/${c.id}`, { active: next }); await onRefresh(); }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const fontImport = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap');
  @keyframes spin { to { transform: rotate(360deg); } }
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
  appDesktop: {
    fontFamily: "'Inter', system-ui, sans-serif",
    background: '#F7F8F4',
    width: '100%',
    maxWidth: 1280,
    minHeight: '100vh',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
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
  brandGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: '8px 16px 20px', flex: 1, minHeight: 0, overflowY: 'auto', alignContent: 'start' },
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

const officeStyles = {
  wrap: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: '100vh' },
  topBar: { display: 'flex', alignItems: 'center', gap: 12, rowGap: 8, flexWrap: 'wrap', background: '#14181F', padding: '14px 16px', position: 'sticky', top: 0, zIndex: 5 },
  brand: { display: 'flex', alignItems: 'center', gap: 8 },
  brandText: { color: '#EDEBE3', fontSize: 15, fontWeight: 700, whiteSpace: 'nowrap' },
  nav: { display: 'flex', gap: 4, flex: 1 },
  navBtn: { background: 'none', border: 'none', color: '#B7BCB2', fontSize: 13.5, fontWeight: 600, padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  navBtnActive: { background: '#2B5D50', color: '#F7F8F4' },
  refreshBtn: { display: 'flex', alignItems: 'center', gap: 6, background: '#2A2E23', color: '#EDEBE3', border: '1px solid #3C4132', borderRadius: 8, padding: '8px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  autoLink: { background: 'none', border: 'none', color: '#8A8F87', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline', whiteSpace: 'nowrap' },
  body: { flex: 1, padding: '20px 24px 40px', background: '#F7F8F4' },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' },
  sectionTitle: { fontSize: 18, fontWeight: 700, color: '#14181F', marginRight: 4 },
  search: { flex: '1 1 260px', maxWidth: 340, background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 8, padding: '8px 12px', fontSize: 13.5, fontFamily: 'inherit', color: '#14181F', outline: 'none' },
  select: { background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 8, padding: '8px 12px', fontSize: 13.5, fontFamily: 'inherit', color: '#14181F', outline: 'none' },
  smallBtn: { background: '#EAE8DD', border: '1px solid #D6D3C6', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, fontWeight: 600, color: '#14181F', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  checkboxLabel: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: '#5B6058', whiteSpace: 'nowrap' },
  countPill: { marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: '#5B6058', background: '#EAE8DD', borderRadius: 999, padding: '6px 12px', whiteSpace: 'nowrap' },
  tableCard: { background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 12, overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13.5 },
  th: { textAlign: 'left', padding: '10px 14px', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#8A8F87', borderBottom: '1px solid #E3E1D6', background: '#FBFAF6', whiteSpace: 'nowrap' },
  td: { padding: '10px 14px', borderBottom: '1px solid #EAE8DD', color: '#14181F', verticalAlign: 'middle' },
  rowClickable: { cursor: 'pointer' },
  rowInactive: { opacity: 0.5 },
  emptyCell: { padding: '28px 14px', textAlign: 'center', color: '#8A8F87', fontSize: 13.5 },
  detailCell: { padding: '0 14px 14px', background: '#FBFAF6' },
  subTable: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5, background: '#FFFFFF', border: '1px solid #E3E1D6', borderRadius: 8, overflow: 'hidden' },
  subTh: { textAlign: 'left', padding: '8px 12px', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', color: '#8A8F87', borderBottom: '1px solid #E3E1D6' },
  subTd: { padding: '8px 12px', borderBottom: '1px solid #EAE8DD', color: '#14181F' },
  stockInput: { width: 60, textAlign: 'right', background: '#F7F8F4', border: '1px solid #D6D3C6', borderRadius: 6, padding: '5px 8px', fontSize: 13, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: '#14181F', outline: 'none' },
  nameEditBtn: { background: 'none', border: 'none', color: '#14181F', fontSize: 13.5, fontFamily: 'inherit', textAlign: 'left', cursor: 'text', padding: '2px 4px', borderRadius: 4, textDecoration: 'underline dotted', textUnderlineOffset: 3 },
  nameInput: { width: '100%', minWidth: 180, background: '#F7F8F4', border: '1px solid #2B5D50', borderRadius: 6, padding: '5px 8px', fontSize: 13.5, fontFamily: 'inherit', color: '#14181F', outline: 'none' },
  stockInputLow: { borderColor: '#B5493B', color: '#B5493B' },
  unsavedDot: { width: 6, height: 6, borderRadius: '50%', background: '#C9A227' },
  toggleBtn: { border: 'none', borderRadius: 999, padding: '5px 12px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', minWidth: 62 },
  toggleBtnOn: { background: '#DCEEE8', color: '#2B5D50' },
  toggleBtnOff: { background: '#F0EEE4', color: '#8A8F87' },
};
