import { useEffect, useMemo, useState } from 'react'
import {
  applyReconciliationAdjustment, businessDayStatus, businessDaySummary, canEditBusinessDay, cardFee, closeBusinessDay, dateTime, dismissShortage, emptyData, gbp,
  normaliseData, refundableItems, round, salesExcludingVat,
  reconciliationBreakdown, recordCashMovement, startNextBusinessDay, totalsFor, totalsForBusinessDay, underpaidCashSales, validateRefund
} from './lib'

const STORE = 'tillflow-data-v1'
const EXPENSE_CATEGORIES = ['Goods or supplies', 'Rent', 'Utilities', 'Employee salaries', 'Delivery or transport', 'Marketing', 'Insurance', 'Tax or business fees', 'Maintenance', 'Other']
const PAYMENT_METHODS = ['Cash from till', 'Card', 'Bank transfer', 'Other']
const NAV = [['dashboard', '▦', 'Dashboard'], ['checkout', '⌘', 'Checkout'], ['expenditure', '↗', 'Expenditure'], ['transactions', '≡', 'Transactions'], ['close', '◉', 'Close day'], ['settings', '⚙', 'Settings']]
const id = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
const now = () => new Date().toISOString()
const localDateTime = () => { const date = new Date(); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 16) }

function Card({ children, className = '' }) { return <section className={`card ${className}`}>{children}</section> }
function Button({ children, kind = 'primary', className = '', ...props }) { return <button className={`button ${kind} ${className}`} {...props}>{children}</button> }
function Field({ label, children, hint }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label> }
function Empty({ title, text, action }) { return <div className="empty"><div>◌</div><strong>{title}</strong><p>{text}</p>{action}</div> }

function Modal({ title, children, onClose }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <div className="modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close">×</button></div>
      {children}
    </div>
  </div>
}

function App() {
  const [data, setData] = useState(() => {
    try { return normaliseData(JSON.parse(localStorage.getItem(STORE))) } catch { return emptyData() }
  })
  const [page, setPage] = useState('dashboard')
  const [period, setPeriod] = useState('today')
  const [selectedDate, setSelectedDate] = useState('')
  const [cart, setCart] = useState([])
  const [notice, setNotice] = useState('')
  const [modal, setModal] = useState(null)

  useEffect(() => { localStorage.setItem(STORE, JSON.stringify(data)) }, [data])
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(timer) }, [notice])
  const update = (fn) => setData((previous) => fn(previous))
  const businessDate = selectedDate || data.activeBusinessDate
  const businessDay = data.businessDays.find((day) => day.date === businessDate)
  const activeDay = data.businessDays.find((day) => day.date === data.activeBusinessDate)
  const dayStatus = businessDayStatus(data, businessDay)
  const isActiveDay = businessDate === data.activeBusinessDate
  const isEditable = canEditBusinessDay(data, businessDate)
  const isOpen = isEditable && businessDay.openingCash !== null
  const closing = data.closings.find((record) => record.businessDate === businessDate)
  const metrics = useMemo(() => totalsFor(data, period, new Date(`${businessDate}T12:00:00`)), [data, period, businessDate])
  const dayMetrics = useMemo(() => totalsForBusinessDay(data, businessDate), [data, businessDate])
  const daySummary = useMemo(() => businessDaySummary(data, businessDay), [data, businessDay])
  const openingCash = daySummary.openingCash
  const expectedToday = daySummary.expectedCash
  const shortageDay = [...data.businessDays].reverse().find((day) => ['short', 'unresolved'].includes(businessDayStatus(data, day)) && !day.shortageWarningDismissed)

  const show = (message) => setNotice(message)
  const openTill = (amount) => {
    if (!isEditable) return show('Previous closed days are read-only.')
    update((state) => ({ ...state, businessDays: state.businessDays.map((day) => day.date === businessDate ? { ...day, openingCash: Number(amount) } : day), openings: [...state.openings.filter((record) => record.businessDate !== businessDate), { id: id('opening'), date: businessDate, businessDate, amount: Number(amount), createdAt: now() }] }))
    show(`Till opened with ${gbp(amount)}.`)
  }
  const addToCart = (product) => setCart((items) => {
    const found = items.find((item) => item.productId === product.id)
    return found ? items.map((item) => item.productId === product.id ? { ...item, quantity: item.quantity + 1 } : item) : [...items, { productId: product.id, name: product.name, price: product.price, quantity: 1 }]
  })
  const setQuantity = (productId, quantity) => setCart((items) => quantity < 1 ? items.filter((item) => item.productId !== productId) : items.map((item) => item.productId === productId ? { ...item, quantity } : item))
  const checkout = ({ paymentMethod, received }) => {
    const total = round(cart.reduce((sum, item) => sum + item.price * item.quantity, 0))
    if (!cart.length || !isOpen) return
    const sale = { id: id('sale'), businessDate, createdAt: now(), items: cart, total, paymentMethod, received: paymentMethod === 'cash' ? Number(received) : null, cardFee: paymentMethod === 'card' ? cardFee(total, data.settings.cardFeeRate) : 0, cardFeeRate: data.settings.cardFeeRate }
    update((state) => ({ ...state, sales: [...state.sales, sale] }))
    setCart([])
    show(paymentMethod === 'cash' ? Number(received) < total ? `Cash sale recorded ${gbp(total - Number(received))} below the product total. Review it at close.` : `Cash sale complete. Change: ${gbp(Number(received) - total)}.` : `Card payment approved. ${gbp(sale.cardFee)} payout fee pending.`)
  }
  const createRefund = (sale, items) => {
    if (!isOpen || sale.businessDate !== businessDate) { show('Refunds can only be made on the active open day.'); return false }
    if (!validateRefund(sale, data.refunds, items)) { show('Those quantities are no longer available to refund.'); return false }
    const total = round(items.reduce((sum, item) => sum + item.price * item.quantity, 0))
    const refund = { id: id('refund'), saleId: sale.id, businessDate, createdAt: now(), items, total, paymentMethod: sale.paymentMethod, cardFeeRate: sale.cardFeeRate || data.settings.cardFeeRate }
    update((state) => ({ ...state, refunds: [...state.refunds, refund] }))
    show(`${gbp(total)} refunded to ${sale.paymentMethod === 'cash' ? 'cash' : 'card'}.`)
    return true
  }
  const saveExpense = (expense) => {
    if (!isEditable) return show('Previous closed days are read-only.')
    update((state) => ({ ...state, expenses: expense.id ? state.expenses.map((item) => item.id === expense.id ? { ...expense, businessDate, date: businessDate, amount: Number(expense.amount) } : item) : [...state.expenses, { ...expense, id: id('expense'), businessDate, date: businessDate, amount: Number(expense.amount), createdAt: now() }] }))
    setModal(null); show(expense.id ? 'Expense updated.' : 'Expense recorded.')
  }
  const removeExpense = (expense) => { if (window.confirm(`Delete “${expense.description}”?`)) update((state) => ({ ...state, expenses: state.expenses.filter((item) => item.id !== expense.id) })) }
  const addMovement = (movement) => {
    if (!isOpen) return show('Open the till before recording cash movements.')
    update((state) => recordCashMovement(state, { ...movement, id: id('cash'), expenseId: id('expense'), businessDate, createdAt: movement.dateTime ? new Date(movement.dateTime).toISOString() : now() }))
    setModal(null); show(movement.type === 'purchase' ? 'Business purchase recorded as cash movement and expenditure.' : `Cash ${movement.type} recorded.`)
  }
  const closeDay = (actual) => {
    if (!isOpen) return show('Open the active till before closing it.')
    const difference = round(Number(actual) - expectedToday)
    update((state) => closeBusinessDay(state, businessDate, actual))
    setModal(null); show(difference < 0 ? `Day closed with a ${gbp(Math.abs(difference))} cash shortage.` : 'Day closed. Start the next day when you are ready.')
  }
  const startNextDay = () => {
    const next = startNextBusinessDay(data)
    if (next === data) return show('Close this day before starting the next one.')
    setData(next); setSelectedDate(next.activeBusinessDate); setCart([]); setPage('dashboard'); show(`Day ${next.businessDays.at(-1).number} is ready to open.`)
  }
  const dismissWarning = (date) => update((state) => dismissShortage(state, date))
  const openBreakdown = (date) => { setSelectedDate(date); setModal('breakdown') }
  const openResolution = (date) => { setSelectedDate(date); setModal('resolve') }
  const saveResolution = (adjustment) => {
    update((state) => applyReconciliationAdjustment(state, { ...adjustment, id: id('adjustment'), businessDate, createdAt: new Date(adjustment.dateTime).toISOString() }))
    setModal(null); show(adjustment.cause === 'unknown' ? 'Difference kept as unresolved.' : 'Reconciliation adjustment saved.')
  }
  const reset = () => { if (window.confirm('Reset all TillFlow data? This cannot be undone.')) { const next = emptyData(); setData(next); setSelectedDate(next.activeBusinessDate); setCart([]); setPage('dashboard'); show('All local data reset.') } }
  const renderPage = () => {
    const common = { data, update, businessDate, businessDay, dayStatus, daySummary, isActiveDay, isEditable, isOpen, closing, metrics, dayMetrics, expectedToday, openingCash, period, setPeriod, setSelectedDate, shortageDay, dismissWarning, openBreakdown, openResolution, addToCart, cart, setQuantity, checkout, createRefund, saveExpense, removeExpense, setModal, addMovement, openTill, closeDay, startNextDay, reset, setPage }
    return ({ dashboard: <Dashboard {...common} />, checkout: <Checkout {...common} />, expenditure: <Expenditure {...common} />, transactions: <Transactions {...common} />, close: <CloseDay {...common} />, settings: <Settings {...common} /> })[page]
  }
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span>t</span><div>TillFlow<small>DAILY TILL, MADE CLEAR</small></div></div><nav>{NAV.map(([key, icon, label]) => <button key={key} className={page === key ? 'active' : ''} onClick={() => setPage(key)}><i>{icon}</i>{label}</button>)}</nav><div className="sidebar-footer"><button onClick={reset}>⌫ Reset local data</button></div></aside>
    <main><header className="topbar"><div><p className="eyebrow">Business day {businessDay.number} · {new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${businessDate}T12:00:00`))}</p><h1>{NAV.find((item) => item[0] === page)?.[2]}</h1></div><div className={`till-state ${isOpen ? 'open' : dayStatus !== 'open' ? 'closed' : ''}`}><span></span>{isOpen ? `Till open · ${gbp(expectedToday)}` : dayStatus !== 'open' ? `Day ${dayStatus}` : 'Opening cash needed'}</div></header>{renderPage()}</main>
    {notice && <div className="toast">✓ {notice}</div>}
    {modal === 'movement' && <MovementForm products={data.products} onClose={() => setModal(null)} onSave={addMovement} />}
    {modal === 'breakdown' && <BreakdownModal data={data} businessDay={businessDay} daySummary={daySummary} onClose={() => setModal(null)} onResolve={() => setModal('resolve')} />}
    {modal === 'resolve' && <ResolveShortageForm businessDay={businessDay} daySummary={daySummary} onClose={() => setModal(null)} onSave={saveResolution} />}
  </div>
}

function PeriodTabs({ period, setPeriod }) { return <div className="tabs">{[['today', 'Today'], ['week', 'This week'], ['month', 'This month']].map(([value, label]) => <button key={value} className={period === value ? 'selected' : ''} onClick={() => setPeriod(value)}>{label}</button>)}</div> }

function DaySelector({ data, businessDate, setSelectedDate }) {
  return <div className="day-selector"><label>Viewing business day<select value={businessDate} onChange={(event) => setSelectedDate(event.target.value)}>{data.businessDays.map((day) => <option key={day.date} value={day.date}>Day {day.number} · {new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(`${day.date}T12:00:00`))} · {businessDayStatus(data, day)}</option>)}</select></label><div className="day-pills">{data.businessDays.map((day) => <button key={day.date} className={`${businessDate === day.date ? 'selected' : ''} ${businessDayStatus(data, day)}`} onClick={() => setSelectedDate(day.date)}>Day {day.number}<small>{businessDayStatus(data, day)}</small></button>)}</div></div>
}

function ShortageWarning({ day, summary, onBreakdown, onResolve, onDismiss }) {
  const difference = summary.originalDifference ?? summary.difference
  const expected = summary.originalExpectedCash ?? summary.expectedCash
  return <div className="shortage-warning"><span>!</span><div><b>Cash shortage detected</b><p>Day {day.number} is {gbp(Math.abs(difference))} short and has not been explained. The expected cash was {gbp(expected)}, but only {gbp(summary.actualCash)} was counted. Review the day’s cash sales, refunds, expenses and cash movements.</p></div><div className="warning-actions"><button onClick={onBreakdown}>View breakdown</button>{onResolve && <button onClick={onResolve}>Review & resolve</button>}{onDismiss && <button onClick={onDismiss}>Dismiss</button>}</div></div>
}

function UnderpaymentWarning({ sales }) {
  if (!sales.length) return null
  const shortfall = round(sales.reduce((total, sale) => total + sale.shortfall, 0))
  return <div className="fraud-warning"><span>!</span><div><b>Possible fraud / cash underpayment</b><p>{gbp(shortfall)} was recorded below the product sale total. Expected cash uses what was actually received; review these sales before closing.</p><div className="fraud-list">{sales.map((sale) => <div key={sale.id}><div><b>{sale.items?.map((item) => `${item.quantity}× ${item.name || 'Item'}`).join(', ') || 'Cash sale'}</b><small>{dateTime(sale.createdAt)} · Sale {gbp(sale.total)} · Recorded {gbp(sale.received)}</small></div><strong>−{gbp(sale.shortfall)}</strong></div>)}</div></div></div>
}

function Dashboard({ data, businessDate, businessDay, dayStatus, daySummary, metrics, dayMetrics, openingCash, expectedToday, period, setPeriod, setSelectedDate, setModal, isOpen, isEditable, isActiveDay, closing, shortageDay, dismissWarning, openBreakdown, openResolution, openTill, startNextDay, setPage }) {
  const categories = dayMetrics.expenses.reduce((result, item) => ({ ...result, [item.category]: (result[item.category] || 0) + item.amount }), {})
  const highestCategory = Math.max(...Object.values(categories), 1)
  const recent = [...dayMetrics.sales.map((sale) => ({ id: sale.id, createdAt: sale.createdAt, type: sale.paymentMethod === 'cash' ? 'Cash sale' : 'Card sale', icon: sale.paymentMethod === 'cash' ? '£' : '▣', description: sale.items.map((item) => item.name).join(', '), amount: sale.total })), ...dayMetrics.expenses.map((expense) => ({ id: expense.id, createdAt: expense.createdAt, type: expense.category, icon: '↗', description: expense.description, amount: -expense.amount })), ...dayMetrics.movements.filter((movement) => movement.type !== 'purchase').map((movement) => ({ id: movement.id, createdAt: movement.createdAt, type: movement.type === 'added' ? 'Cash added' : 'Cash removed', icon: '£', description: movement.reason || movement.category || movement.note || `Cash ${movement.type}`, amount: movement.type === 'added' ? movement.amount : -movement.amount }))].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5)
  const warningSummary = shortageDay && businessDaySummary(data, shortageDay)
  return <>
    <DaySelector data={data} businessDate={businessDate} setSelectedDate={setSelectedDate}/>
    {shortageDay && <ShortageWarning day={shortageDay} summary={warningSummary} onBreakdown={() => openBreakdown(shortageDay.date)} onResolve={() => openResolution(shortageDay.date)} onDismiss={() => dismissWarning(shortageDay.date)}/>} 
    {!isOpen && isEditable && <Card className="opening-card"><div><p className="eyebrow">START DAY {businessDay.number}</p><h2>Open your till before taking sales.</h2><p>Suggested opening cash is {gbp(businessDay.suggestedOpeningCash || 0)}. You can edit it before confirming.</p></div><OpenTillForm businessDay={businessDay} onOpen={openTill} /></Card>}
    <div className="dashboard-title"><div><p className="eyebrow">YOUR BUSINESS AT A GLANCE</p><h2>Day {businessDay.number} · {dayStatus === 'open' ? 'In progress' : dayStatus}</h2></div><PeriodTabs period={period} setPeriod={setPeriod} /></div>
    <div className="metric-grid"><Metric label="Total sales" value={gbp(metrics.netSales)} note={`${gbp(metrics.grossSales)} before refunds`} icon="↗"/><Metric label="Cash sales" value={gbp(metrics.cashSales)} note="After cash refunds" icon="£"/><Metric label="Card sales" value={gbp(metrics.cardSales)} note={`${gbp(metrics.cardFees)} fees pending`} icon="▣"/><Metric label="Pending card payout" value={gbp(metrics.cardSales - metrics.cardFees)} note="Net of processing fees" icon="◌"/><Metric label="Total expenditure" value={gbp(metrics.expenditure)} note="Across all payment methods" icon="↘"/></div>
    <div className="dashboard-grid"><Card className="cash-card"><div className="card-title"><div><p className="eyebrow">CASH POSITION · DAY {businessDay.number}</p><h2>Expected cash in till</h2></div><span className="cash-symbol">£</span></div><strong className="cash-total">{gbp(expectedToday)}</strong><div className="cash-line"><span>Opening cash</span><b>{gbp(openingCash)}</b></div><div className="cash-line"><span>Cash received & movements</span><b>{gbp(dayMetrics.cashSales + dayMetrics.cashAdded - dayMetrics.cashRemoved - dayMetrics.cashExpenses)}</b></div>{isOpen && <div className="quick-actions"><Button onClick={() => setModal('movement')}>+ Cash movement</Button><Button kind="ghost" onClick={() => setPage('close')}>Close day →</Button></div>}{closing && <><p className={`reconcile ${dayStatus}`}>{dayStatus === 'resolved' ? 'Resolved after reconciliation adjustment.' : daySummary.difference === 0 ? 'Balanced when closed.' : `${gbp(Math.abs(daySummary.difference))} ${daySummary.difference < 0 ? 'short' : 'over'} when closed.`}</p>{isActiveDay && <Button className="next-day" onClick={startNextDay}>Start next day →</Button>}</>}</Card>
      <Card className="profit-card"><p className="eyebrow">ESTIMATED OPERATING PROFIT · EX. VAT</p><strong>{gbp(daySummary.profit)}</strong><p>Product prices include {data.settings.vatRate}% VAT; profit excludes that VAT, expenses and card fees.</p><div className="profit-detail"><span>Sales ex. VAT <b>{gbp(salesExcludingVat(daySummary.netSales, data.settings.vatRate))}</b></span><span>Expenses <b>−{gbp(daySummary.expenditure)}</b></span><span>Card fees <b>−{gbp(daySummary.cardFees)}</b></span></div></Card>
    </div>
    <Card className="history-card"><div className="section-head"><div><p className="eyebrow">BUSINESS DAY HISTORY</p><h2>Review every day at a glance.</h2></div></div><div className="day-history">{data.businessDays.map((day) => { const summary = businessDaySummary(data, day), status = businessDayStatus(data, day); return <button key={day.date} className={`${businessDate === day.date ? 'selected' : ''} ${status}`} onClick={() => setSelectedDate(day.date)}><div><b>Day {day.number}</b><small>{new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(`${day.date}T12:00:00`))} · {status}</small></div><span>Sales <b>{gbp(summary.netSales)}</b></span><span>Expenses <b>{gbp(summary.expenditure)}</b></span><span>Expected <b>{gbp(summary.expectedCash)}</b></span><span>Actual <b>{summary.actualCash === null ? '—' : gbp(summary.actualCash)}</b></span><span>Difference <b>{summary.difference === null ? '—' : `${summary.difference < 0 ? '−' : summary.difference > 0 ? '+' : ''}${gbp(Math.abs(summary.difference))}`}</b></span><span>Profit <b>{gbp(summary.profit)}</b></span></button> })}</div></Card>
    <div className="lower-grid"><Card><div className="section-head"><div><p className="eyebrow">LATEST ACTIVITY</p><h2>Day {businessDay.number} sales & till activity</h2></div><button className="text-button" onClick={() => setPage('transactions')}>View all</button></div>{recent.length ? <div className="activity-list">{recent.map((item) => <div className="activity" key={item.id}><span className="activity-icon">{item.icon}</span><div><b>{item.description}</b><small>{item.type} · {dateTime(item.createdAt)}</small></div><strong className={item.amount < 0 ? 'negative' : ''}>{item.amount < 0 ? '−' : ''}{gbp(Math.abs(item.amount))}</strong></div>)}</div> : <Empty title="Nothing recorded yet" text="Open your till, then start taking sales."/>}</Card>
      <Card><div className="section-head"><div><p className="eyebrow">SPENDING BY CATEGORY</p><h2>Day {businessDay.number} expenditure</h2></div><button className="text-button" onClick={() => setPage('expenditure')}>Manage expenses</button></div>{Object.keys(categories).length ? <div className="breakdown">{Object.entries(categories).sort((a,b) => b[1]-a[1]).map(([category, amount]) => <div key={category}><div><span>{category}</span><b>{gbp(amount)}</b></div><i><em style={{ width: `${amount / highestCategory * 100}%` }} /></i></div>)}</div> : <Empty title="No expenditure yet" text="Recorded business costs will appear here."/>}</Card>
    </div>
  </>
}

function OpenTillForm({ businessDay, onOpen }) {
  const [amount, setAmount] = useState(businessDay.suggestedOpeningCash ?? '')
  return <form className="open-form" onSubmit={(event) => { event.preventDefault(); if (Number(amount) >= 0) onOpen(Number(amount)) }}><Field label="Opening cash"><div className="currency-input"><span>£</span><input required min="0" step="0.01" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} autoFocus /></div></Field><Button type="submit">Open till</Button></form>
}

function Metric({ label, value, note, icon }) { return <Card className="metric"><div className="metric-icon">{icon}</div><p>{label}</p><strong>{value}</strong><small>{note}</small></Card> }

function Checkout({ data, isOpen, cart, addToCart, setQuantity, checkout, setPage }) {
  const [category, setCategory] = useState('All')
  const [search, setSearch] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [received, setReceived] = useState('')
  const categories = ['All', ...new Set(data.products.map((item) => item.category))]
  const products = data.products.filter((item) => (category === 'All' || item.category === category) && item.name.toLowerCase().includes(search.toLowerCase()))
  const total = round(cart.reduce((sum, item) => sum + item.price * item.quantity, 0))
  if (!isOpen) return <Card className="locked"><span>◉</span><h2>Open the till to start checkout.</h2><p>Sales are kept in step with your daily cash balance, so checkout unlocks once you’ve entered opening cash.</p><Button onClick={() => setPage('dashboard')}>Open till on Dashboard</Button></Card>
  return <div className="checkout-layout"><section className="catalogue"><div className="checkout-tools"><input aria-label="Search products" placeholder="Search products…" value={search} onChange={(event) => setSearch(event.target.value)}/><div className="chips">{categories.map((item) => <button key={item} className={category === item ? 'selected' : ''} onClick={() => setCategory(item)}>{item}</button>)}</div></div><div className="product-grid">{products.map((product) => <button className="product-button" key={product.id} onClick={() => addToCart(product)}><span>{product.category}</span><b>{product.name}</b><strong>{gbp(product.price)}</strong><i>+</i></button>)}</div>{!products.length && <Empty title="No products found" text="Try a different search or category."/>}</section><aside className="cart"><div className="cart-head"><div><p className="eyebrow">CURRENT ORDER</p><h2>{cart.length ? `${cart.length} item${cart.length > 1 ? 's' : ''}` : 'Your cart is empty'}</h2></div><span>⌘</span></div>{cart.length ? <><div className="cart-list">{cart.map((item) => <div className="cart-item" key={item.productId}><div><b>{item.name}</b><small>{gbp(item.price)} each</small></div><div className="quantity"><button onClick={() => setQuantity(item.productId, item.quantity - 1)}>−</button><span>{item.quantity}</span><button onClick={() => setQuantity(item.productId, item.quantity + 1)}>+</button></div><strong>{gbp(item.price * item.quantity)}</strong></div>)}</div><div className="cart-total"><span>Total to pay</span><strong>{gbp(total)}</strong></div><div className="payment-selector"><button className={paymentMethod === 'cash' ? 'selected' : ''} onClick={() => setPaymentMethod('cash')}>£ Cash</button><button className={paymentMethod === 'card' ? 'selected' : ''} onClick={() => setPaymentMethod('card')}>▣ Card</button></div>{paymentMethod === 'cash' ? <Field label="Cash received"><div className="currency-input"><span>£</span><input min="0" step="0.01" type="number" value={received} onChange={(event) => setReceived(event.target.value)} placeholder="0.00" /></div><small>Change due: <b>{gbp(Math.max(0, Number(received || 0) - total))}</b></small></Field> : <div className="card-note">Card payment will be simulated as approved.<small>{data.settings.cardFeeRate}% processing fee · payout pending</small></div>}<Button className="pay-button" onClick={() => checkout({ paymentMethod, received })}>Confirm {paymentMethod} payment · {gbp(total)}</Button></> : <Empty title="Ready when you are" text="Select products to build an order."/>}</aside></div>
}

function Expenditure({ data, businessDate, isEditable, saveExpense, removeExpense }) {
  const [editing, setEditing] = useState(null); const [filter, setFilter] = useState({ category: 'All', method: 'All', date: '' })
  const expenses = data.expenses.filter((item) => item.businessDate === businessDate && (filter.category === 'All' || item.category === filter.category) && (filter.method === 'All' || item.paymentMethod === filter.method) && (!filter.date || item.date === filter.date)).sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt))
  const filteredTotal = expenses.reduce((sum, item) => sum + item.amount, 0)
  return <><div className="page-actions"><div><p className="eyebrow">BUSINESS COSTS · DAY {data.businessDays.find((day) => day.date === businessDate)?.number}</p><h2>{isEditable ? 'Record what the business spends.' : 'Closed-day expenditure is read-only.'}</h2></div>{isEditable && <Button onClick={() => setEditing({ date: businessDate, description: '', category: 'Goods or supplies', amount: '', paymentMethod: 'Cash from till', note: '' })}>+ Add expenditure</Button>}</div><div className="metric-grid compact"><Metric label="Total expenditure" value={gbp(filteredTotal)} note="For this business day" icon="↘"/><Metric label="Cash from till" value={gbp(expenses.filter((item) => item.paymentMethod === 'Cash from till').reduce((sum, item) => sum + item.amount, 0))} note="Reduces expected cash" icon="£"/><Metric label="Recorded costs" value={`${expenses.length}`} note="Expense entries" icon="≡"/></div><Card><div className="filter-row three"><select value={filter.category} onChange={(event) => setFilter({ ...filter, category: event.target.value })}><option>All</option>{EXPENSE_CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select><select value={filter.method} onChange={(event) => setFilter({ ...filter, method: event.target.value })}><option>All</option>{PAYMENT_METHODS.map((item) => <option key={item}>{item}</option>)}</select><input type="date" value={filter.date} onChange={(event) => setFilter({ ...filter, date: event.target.value })}/></div>{expenses.length ? <div className="expense-list">{expenses.map((expense) => <div key={expense.id}><div className="expense-badge">↘</div><div><b>{expense.description}</b><small>{expense.category} · {expense.paymentMethod} · {new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(`${expense.date}T12:00:00`))}{expense.note && ` · ${expense.note}`}</small></div><strong>{gbp(expense.amount)}</strong>{isEditable && <><button className="text-button" onClick={() => setEditing(expense)}>Edit</button><button className="delete-button" onClick={() => removeExpense(expense)}>Delete</button></>}</div>)}</div> : <Empty title="No expenses found" text="Try changing the filters or record a business cost."/>}</Card>{editing && <ExpenseForm expense={editing} onClose={() => setEditing(null)} onSave={saveExpense}/>}</>
}

function ExpenseForm({ expense, onClose, onSave }) { const [form, setForm] = useState(expense); return <Modal title={expense.id ? 'Edit expenditure' : 'Add expenditure'} onClose={onClose}><form className="form-grid" onSubmit={(event) => { event.preventDefault(); onSave(form) }}><Field label="Date"><input required type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })}/></Field><Field label="Description"><input required value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })}/></Field><div className="two-fields"><Field label="Category"><select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>{EXPENSE_CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></Field><Field label="Amount"><div className="currency-input"><span>£</span><input required min="0.01" step="0.01" type="number" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })}/></div></Field></div><Field label="Payment method"><select value={form.paymentMethod} onChange={(event) => setForm({ ...form, paymentMethod: event.target.value })}>{PAYMENT_METHODS.map((item) => <option key={item}>{item}</option>)}</select></Field><Field label="Note (optional)"><textarea value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })}/></Field><div className="form-actions"><Button type="button" kind="ghost" onClick={onClose}>Cancel</Button><Button type="submit">Save expenditure</Button></div></form></Modal> }

function Transactions({ data, businessDate, businessDay, createRefund, isOpen }) {
  const [filter, setFilter] = useState('All'); const [refunding, setRefunding] = useState(null)
  const refundStatus = (sale) => {
    const items = refundableItems(sale, data.refunds)
    return items.some((item) => item.refunded) ? items.every((item) => item.available === 0) ? ' · fully refunded' : ' · partially refunded' : ''
  }
  const dayRecords = (items) => items.filter((item) => item.businessDate === businessDate)
  const transactions = [
    ...dayRecords(data.sales).map((sale) => ({ ...sale, kind: sale.paymentMethod === 'cash' ? 'Cash sale' : 'Card sale', description: sale.items.map((item) => `${item.quantity}× ${item.name}`).join(', '), amount: sale.total })),
    ...dayRecords(data.refunds).map((refund) => ({ ...refund, kind: 'Refund', description: refund.items.map((item) => `${item.quantity}× ${item.name}`).join(', '), amount: -refund.total })),
    ...dayRecords(data.expenses).map((expense) => ({ ...expense, kind: 'Expenditure', description: expense.description, amount: -expense.amount })),
    ...dayRecords(data.cashMovements).map((movement) => ({ ...movement, kind: movement.type === 'added' ? 'Cash added' : movement.type === 'purchase' ? 'Business purchase' : 'Cash removed', description: movement.reason || movement.category || movement.note || `Cash ${movement.type}`, amount: movement.type === 'added' ? movement.amount : -movement.amount }))
  ].sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt))
  const shown = transactions.filter((item) => filter === 'All' || item.kind === filter)
  return <><div className="page-actions"><div><p className="eyebrow">COMPLETE RECORD · DAY {businessDay.number}</p><h2>{isOpen ? 'Every sale, refund and cash movement.' : 'This closed day is read-only.'}</h2></div></div><Card><div className="filter-row"><select value={filter} onChange={(event) => setFilter(event.target.value)}>{['All', 'Cash sale', 'Card sale', 'Refund', 'Expenditure', 'Cash added', 'Business purchase', 'Cash removed'].map((item) => <option key={item}>{item}</option>)}</select></div>{shown.length ? <div className="transaction-list">{shown.map((item) => <div key={`${item.kind}-${item.id}`}><span className={`transaction-icon ${item.kind.toLowerCase().replaceAll(' ', '-')}`}>{item.kind === 'Refund' ? '↩' : item.kind === 'Expenditure' || item.kind === 'Business purchase' ? '↘' : item.kind.includes('Cash') ? '£' : '▣'}</span><div><b>{item.description}</b><small>{item.kind} · {dateTime(item.createdAt)}{item.paymentMethod && ` · ${item.paymentMethod}`}{item.kind.endsWith('sale') && refundStatus(item)}</small></div><strong className={item.amount < 0 ? 'negative' : ''}>{item.amount < 0 ? '−' : ''}{gbp(Math.abs(item.amount))}</strong>{item.kind.endsWith('sale') && <RefundButton sale={item} refunds={data.refunds} isOpen={isOpen} onRefund={() => setRefunding(item)}/>}</div>)}</div> : <Empty title="No matching transactions" text="Sales and expenses will appear here as you record them."/>}</Card>{refunding && <RefundForm sale={refunding} refunds={data.refunds} onClose={() => setRefunding(null)} onSave={createRefund}/>}</>
}

function RefundButton({ sale, refunds, isOpen, onRefund }) { const stillAvailable = refundableItems(sale, refunds).some((item) => item.available > 0); return stillAvailable && isOpen ? <button className="text-button" onClick={onRefund}>Refund</button> : null }
function RefundForm({ sale, refunds, onClose, onSave }) { const available = refundableItems(sale, refunds); const [quantities, setQuantities] = useState(Object.fromEntries(available.map((item) => [item.productId, 0]))); const requested = available.filter((item) => quantities[item.productId] > 0).map((item) => ({ productId: item.productId, name: item.name, price: item.price, quantity: Number(quantities[item.productId]) })); const amount = requested.reduce((sum, item) => sum + item.quantity * item.price, 0); return <Modal title="Refund sale items" onClose={onClose}><p className="modal-copy">Refunds return to the original <b>{sale.paymentMethod}</b> payment method.</p><div className="refund-lines">{available.map((item) => <div key={item.productId}><div><b>{item.name}</b><small>{gbp(item.price)} · {item.available} available</small></div><input aria-label={`Refund quantity for ${item.name}`} type="number" min="0" max={item.available} value={quantities[item.productId]} onChange={(event) => setQuantities({ ...quantities, [item.productId]: Math.min(item.available, Math.max(0, Number(event.target.value))) })}/></div>)}</div><div className="form-actions"><div><small>Refund total</small><strong>{gbp(amount)}</strong></div><Button kind="ghost" onClick={onClose}>Cancel</Button><Button disabled={!amount} onClick={() => { if (onSave(sale, requested)) onClose() }}>Confirm refund</Button></div></Modal> }

function ReconciliationBreakdown({ data, businessDay, summary: summaryOverride }) {
  const [expanded, setExpanded] = useState('')
  const breakdown = reconciliationBreakdown(data, businessDay)
  const summary = summaryOverride || breakdown.summary
  const rows = [...breakdown.rows, { key: 'expected', label: 'Expected closing cash', amount: summary.expectedCash, records: [{ id: 'expected', description: 'Calculated from the rows above', amount: summary.expectedCash }] }, { key: 'actual', label: 'Actual closing cash', amount: summary.actualCash, records: [{ id: 'actual', description: 'Cash counted at close', amount: summary.actualCash }] }, { key: 'difference', label: 'Unexplained difference', amount: summary.difference, records: [{ id: 'difference', description: 'Actual closing cash less expected closing cash', amount: summary.difference }] }]
  const amount = (row) => row.amount === null || row.amount === undefined ? '—' : `${row.sign || (row.key === 'difference' && row.amount < 0 ? '−' : '')}${gbp(Math.abs(row.amount))}`
  return <div className="reconciliation-breakdown"><p className="eyebrow">CASH CALCULATION</p>{rows.map((row) => <div className={`reconciliation-row ${row.key === 'difference' ? row.amount < 0 ? 'short' : row.amount > 0 ? 'over' : 'balanced' : ''}`} key={row.key}><button type="button" onClick={() => setExpanded(expanded === row.key ? '' : row.key)}><span>{row.label}<small>{expanded === row.key ? 'Hide records' : 'View records'}</small></span><b>{amount(row)}</b></button>{expanded === row.key && <div className="reconciliation-records">{row.records.length ? row.records.map((record) => <span key={record.id}><span>{record.description}</span><b>{record.amount === null || record.amount === undefined ? '—' : gbp(Math.abs(record.amount))}</b></span>) : <span><span>No records included.</span><b>{gbp(0)}</b></span>}</div>}</div>)}{summary.difference !== null && summary.difference < 0 && <div className="unexplained-callout"><b>{gbp(Math.abs(summary.difference))} left the till but has not been recorded.</b><p>TillFlow cannot identify the cause automatically. Common causes include an unrecorded business purchase, incorrect change, an unrecorded refund, a bank deposit, or an incorrect cash-sale entry.</p></div>}</div>
}

function AuditTrail({ summary }) {
  const adjustment = summary.adjustments.at(-1)
  if (!adjustment) return null
  return <div className="adjustment-audit"><b>Reconciliation audit</b><span>Original shortage: {gbp(Math.abs(summary.originalDifference || 0))}</span><span>Resolution: {gbp(adjustment.amount)} {adjustment.description || 'adjustment'} added</span><span>Resolved: {dateTime(adjustment.resolvedAt || adjustment.createdAt)}</span><span>Adjusted difference: {gbp(Math.abs(summary.difference || 0))}</span></div>
}

function BreakdownModal({ data, businessDay, daySummary, onClose, onResolve }) { return <Modal title={`Day ${businessDay.number} reconciliation`} onClose={onClose}><ReconciliationBreakdown data={data} businessDay={businessDay} summary={daySummary}/>{daySummary.difference !== null && daySummary.difference !== 0 && <div className="form-actions"><Button kind="ghost" onClick={onClose}>Close</Button><Button onClick={onResolve}>Review & resolve</Button></div>}</Modal> }

function ResolveShortageForm({ businessDay, daySummary, onClose, onSave }) {
  const [cause, setCause] = useState('expense'); const [amount, setAmount] = useState(Math.abs(daySummary.difference ?? daySummary.originalDifference ?? '')); const [description, setDescription] = useState('Purchase coffee beans'); const [category, setCategory] = useState('Goods or supplies'); const [dateTimeValue, setDateTimeValue] = useState(`${businessDay.date}T18:10`); const [note, setNote] = useState('')
  const quickReasons = ['Purchase coffee beans', 'Buy milk or ingredients', 'Buy cups or packaging', 'Pay a supplier', 'Cleaning supplies', 'Maintenance', 'Other']
  return <Modal title={`Review Day ${businessDay.number} difference`} onClose={onClose}><form className="form-grid" onSubmit={(event) => { event.preventDefault(); onSave({ cause, amount, description, category, dateTime: dateTimeValue, note }) }}><Field label="What caused the difference?"><select value={cause} onChange={(event) => setCause(event.target.value)}><option value="expense">Unrecorded business expense</option><option value="removed">Cash removed from till</option><option value="change">Incorrect change given</option><option value="refund">Missing refund</option><option value="transaction">Incorrect transaction</option><option value="unknown">Still unknown</option></select></Field>{cause === 'expense' && <div className="quick-reasons">{quickReasons.map((reason) => <button type="button" className={description === reason ? 'selected' : ''} key={reason} onClick={() => setDescription(reason)}>{reason}</button>)}</div>}<div className="two-fields"><Field label="Amount"><div className="currency-input"><span>£</span><input required min="0.01" step="0.01" type="number" value={amount} onChange={(event) => setAmount(event.target.value)}/></div></Field><Field label="Category"><select value={category} onChange={(event) => setCategory(event.target.value)}>{EXPENSE_CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></Field></div><Field label="Description"><input required value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Explain the adjustment"/></Field><Field label="Date and time"><input required type="datetime-local" value={dateTimeValue} onChange={(event) => setDateTimeValue(event.target.value)}/></Field>{cause === 'expense' && <><Field label="Payment method"><input readOnly value="Cash from till"/></Field><p className="form-note">This will add a cash business expense and reduce estimated profit.</p></>}<Field label="Note (optional)"><textarea value={note} onChange={(event) => setNote(event.target.value)}/></Field><div className="form-actions"><Button type="button" kind="ghost" onClick={onClose}>Cancel</Button><Button type="submit">Save reconciliation adjustment</Button></div></form></Modal>
}

function CloseDay({ data, businessDay, dayStatus, daySummary, closing, expectedToday, dayMetrics, isActiveDay, isEditable, isOpen, closeDay, startNextDay, setPage, openBreakdown, openResolution }) {
  const [actual, setActual] = useState('')
  const [confirming, setConfirming] = useState(false)
  const underpaidSales = underpaidCashSales(dayMetrics.sales)
  if (closing) { const label = dayStatus === 'resolved' ? 'Resolved' : dayStatus === 'unresolved' ? 'Unresolved' : daySummary.difference === 0 ? 'Balanced' : daySummary.difference < 0 ? 'Short' : 'Over'; return <><div className="page-actions"><div><p className="eyebrow">DAY {businessDay.number} COMPLETE</p><h2>Your till has been reconciled.</h2></div></div>{['short', 'unresolved'].includes(dayStatus) && <ShortageWarning day={businessDay} summary={daySummary} onBreakdown={() => openBreakdown(businessDay.date)} onResolve={() => openResolution(businessDay.date)}/>}<Card className="closed-summary"><span className={`status-orb ${label.toLowerCase()}`}>✓</span><h2>{label}{dayStatus === 'resolved' ? '' : ` by ${gbp(Math.abs(daySummary.difference))}`}</h2><p>{dayStatus === 'resolved' ? `The adjusted expected balance is ${gbp(daySummary.expectedCash)}, matching the ${gbp(daySummary.actualCash)} counted.` : daySummary.difference === 0 ? 'The till matched its expected balance.' : `The expected balance was ${gbp(daySummary.expectedCash)}, but ${gbp(daySummary.actualCash)} was counted.`}</p><div className="close-figures"><span>Opening <b>{gbp(daySummary.openingCash)}</b></span><span>Expected <b>{gbp(daySummary.expectedCash)}</b></span><span>Actual <b>{gbp(daySummary.actualCash)}</b></span></div><AuditTrail summary={daySummary}/><div className="summary-actions"><Button kind="ghost" onClick={() => openBreakdown(businessDay.date)}>View reconciliation breakdown</Button>{isActiveDay ? <Button onClick={startNextDay}>Start next day →</Button> : <Button kind="ghost" onClick={() => setPage('dashboard')}>Back to dashboard</Button>}</div></Card></> }
  if (!isOpen) return <Card className="locked"><span>◉</span><h2>{isEditable ? 'Open the till before closing it.' : 'This historical day is read-only.'}</h2><p>{isEditable ? 'Once you enter your starting cash, TillFlow can calculate what should be in the drawer.' : 'Choose the active business day to continue trading.'}</p><Button onClick={() => setPage('dashboard')}>{isEditable ? 'Open till' : 'View dashboard'}</Button></Card>
  const difference = round(Number(actual || 0) - expectedToday); const status = difference === 0 ? 'Balanced' : difference < 0 ? 'Short' : 'Over'
  const countSummary = actual === '' ? daySummary : { ...daySummary, actualCash: Number(actual), difference }
  return <><div className="page-actions"><div><p className="eyebrow">END OF DAY · DAY {businessDay.number}</p><h2>Count cash, then reconcile the till.</h2></div></div><div className="close-layout"><Card><p className="eyebrow">EXPECTED CASH</p><strong className="close-expected">{gbp(expectedToday)}</strong><ReconciliationBreakdown data={data} businessDay={businessDay} summary={countSummary}/></Card><Card><p className="eyebrow">COUNTED CASH</p><h2>What is actually in the till?</h2><UnderpaymentWarning sales={underpaidSales}/><Field label="Actual closing cash"><div className="currency-input large"><span>£</span><input autoFocus min="0" step="0.01" type="number" value={actual} onChange={(event) => setActual(event.target.value)} placeholder="0.00" /></div></Field>{actual !== '' && <div className={`closing-result ${status.toLowerCase()}`}><b>{status} by {gbp(Math.abs(difference))}</b><p>{difference === 0 ? 'The counted cash matches what TillFlow expected.' : `The till is ${gbp(Math.abs(difference))} ${difference < 0 ? 'short' : 'over'}. The expected balance was ${gbp(expectedToday)}, but ${gbp(Number(actual))} was counted.`}</p></div>}{actual !== '' && difference < 0 && <ShortageWarning day={businessDay} summary={countSummary} onBreakdown={() => openBreakdown(businessDay.date)}/>}<Button disabled={actual === ''} onClick={() => setConfirming(true)}>Close & save day</Button></Card></div>{confirming && <Modal title="Close business day" onClose={() => setConfirming(false)}><p className="modal-copy">Close Day {businessDay.number} with {gbp(Number(actual))} counted cash? This locks its transactions and expenses.</p><UnderpaymentWarning sales={underpaidSales}/>{difference < 0 && <ShortageWarning day={businessDay} summary={countSummary} onBreakdown={() => { setConfirming(false); openBreakdown(businessDay.date) }}/>}<div className="form-actions"><Button kind="ghost" onClick={() => setConfirming(false)}>Cancel</Button><Button onClick={() => { closeDay(Number(actual)); setConfirming(false) }}>Close & save day</Button></div></Modal>}</>
}

function Settings({ data, update, reset }) { const [settings, setSettings] = useState(data.settings); const save = () => update((state) => ({ ...state, settings: { vatRate: Number(settings.vatRate), cardFeeRate: Number(settings.cardFeeRate) } })); return <><div className="page-actions"><div><p className="eyebrow">YOUR DEFAULTS</p><h2>Settings for your daily calculations.</h2></div></div><div className="settings-grid"><Card><p className="eyebrow">TAX & CARD FEES</p><h2>Calculation settings</h2><div className="form-grid"><Field label="VAT rate"><div className="suffix-input"><input min="0" step="0.1" type="number" value={settings.vatRate} onChange={(event) => setSettings({ ...settings, vatRate: event.target.value })}/><span>%</span></div><small>Product prices are treated as VAT-inclusive.</small></Field><Field label="Card-processing fee"><div className="suffix-input"><input min="0" step="0.1" type="number" value={settings.cardFeeRate} onChange={(event) => setSettings({ ...settings, cardFeeRate: event.target.value })}/><span>%</span></div><small>Applied when a card sale is confirmed.</small></Field><Button onClick={() => { save(); window.alert('Settings saved.') }}>Save settings</Button></div></Card><Card className="danger-zone"><p className="eyebrow">LOCAL DATA</p><h2>Reset local data</h2><p>TillFlow keeps data in this browser’s local storage. It persists after refreshes.</p><Button kind="danger" onClick={reset}>Reset all local data</Button></Card></div></> }

function MovementForm({ products, onClose, onSave }) { const [type, setType] = useState('added'); const [amount, setAmount] = useState(String(products[0]?.price ?? '')); const [reason, setReason] = useState(''); const [category, setCategory] = useState(products[0]?.name || ''); const [dateTimeValue, setDateTimeValue] = useState(localDateTime()); const [note, setNote] = useState(''); const quickReasons = ['Purchase coffee beans', 'Buy milk or ingredients', 'Buy cups or packaging', 'Pay supplier', 'Cleaning supplies', 'Maintenance', 'Other']; const selectProduct = (name) => { setCategory(name); setAmount(String(products.find((product) => product.name === name)?.price ?? '')) }; const selectType = (next) => { setType(next); if (next === 'added') { selectProduct(products[0]?.name || ''); setReason('') } else { setCategory('Goods or supplies'); setAmount('') } }; const categories = type === 'added' ? products : EXPENSE_CATEGORIES; return <Modal title="Cash movement" onClose={onClose}><form className="form-grid" onSubmit={(event) => { event.preventDefault(); onSave({ type, amount, reason, category, dateTime: dateTimeValue, note }) }}><div className="movement-types">{[['added', 'Cash added'], ['purchase', 'Business purchase'], ['removed', 'Other cash removed']].map(([value, label]) => <button className={type === value ? 'selected' : ''} type="button" key={value} onClick={() => selectType(value)}>{label}</button>)}</div>{type === 'purchase' && <div className="quick-reasons">{quickReasons.map((item) => <button type="button" className={reason === item ? 'selected' : ''} key={item} onClick={() => setReason(item)}>{item}</button>)}</div>}<Field label="Amount"><div className="currency-input"><span>£</span><input autoFocus required min="0.01" step="0.01" type="number" value={amount} onChange={(event) => setAmount(event.target.value)}/></div></Field>{type !== 'added' && <Field label="Reason"><input required placeholder={type === 'removed' ? 'e.g. Bank deposit' : 'e.g. Purchase coffee beans'} value={reason} onChange={(event) => setReason(event.target.value)}/></Field>}<div className="two-fields"><Field label={type === 'added' ? 'Product' : 'Category'}><select value={category} onChange={(event) => type === 'added' ? selectProduct(event.target.value) : setCategory(event.target.value)}>{categories.map((item) => <option key={typeof item === 'string' ? item : item.id} value={typeof item === 'string' ? item : item.name}>{typeof item === 'string' ? item : `${item.name} · ${item.category}`}</option>)}</select></Field><Field label="Date and time"><input required type="datetime-local" value={dateTimeValue} onChange={(event) => setDateTimeValue(event.target.value)}/></Field></div><Field label="Note (optional)"><textarea value={note} onChange={(event) => setNote(event.target.value)}/></Field><div className="form-actions"><Button kind="ghost" type="button" onClick={onClose}>Cancel</Button><Button type="submit">Record cash movement</Button></div></form></Modal> }
export default App
