export const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' })
export const gbp = (amount = 0) => money.format(Number(amount) || 0)
export const round = (amount) => Math.round((Number(amount) || 0) * 100) / 100

export const localDate = (value = new Date()) => {
  const date = new Date(value)
  const offset = date.getTimezoneOffset()
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10)
}

const dateAtNoon = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value)
export const addBusinessDays = (date, amount = 1) => {
  const next = dateAtNoon(date)
  next.setDate(next.getDate() + amount)
  return localDate(next)
}
export const businessDateFor = (record) => record.businessDate || record.date || localDate(record.createdAt)

export const dateTime = (value) => new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
}).format(new Date(value))

export function inDateRange(value, range = 'today', now = new Date()) {
  const date = dateAtNoon(value)
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  if (range === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  if (range === 'month') start.setDate(1)
  return date >= start && date <= end
}

export function cardFee(amount, rate) { return round(amount * ((Number(rate) || 0) / 100)) }
export function vatFromInclusive(amount, vatRate) { return round(amount - amount / (1 + (Number(vatRate) || 0) / 100)) }
export function salesExcludingVat(netSales, vatRate) { return round(netSales - vatFromInclusive(netSales, vatRate)) }
export function expectedCash({ openingCash = 0, cashSales = 0, cashRefunds = 0, cashAdded = 0, cashRemoved = 0, cashExpenses = 0 }) {
  return round(openingCash + cashSales + cashAdded - cashRefunds - cashRemoved - cashExpenses)
}
export function operatingProfit({ netSales = 0, vatRate = 20, expenditure = 0, cardFees = 0 }) {
  return round(salesExcludingVat(netSales, vatRate) - expenditure - cardFees)
}

export function refundedQuantity(sale, refunds, productId) {
  return refunds.filter((refund) => refund.saleId === sale.id)
    .flatMap((refund) => refund.items)
    .filter((item) => item.productId === productId)
    .reduce((total, item) => total + item.quantity, 0)
}

export function refundableItems(sale, refunds) {
  return sale.items.map((item) => ({ ...item, refunded: refundedQuantity(sale, refunds, item.productId), available: item.quantity - refundedQuantity(sale, refunds, item.productId) }))
}

export function validateRefund(sale, refunds, requestedItems) {
  const available = Object.fromEntries(refundableItems(sale, refunds).map((item) => [item.productId, item.available]))
  return requestedItems.length > 0 && requestedItems.every((item) => item.quantity > 0 && item.quantity <= (available[item.productId] ?? 0))
}

export function underpaidCashSales(sales) {
  return sales
    .filter((sale) => sale.paymentMethod === 'cash' && sale.received !== null && sale.received !== undefined && Number(sale.received) < Number(sale.total))
    .map((sale) => ({ ...sale, shortfall: round(Number(sale.total) - Number(sale.received)) }))
}

const cashKeptFromSale = (sale) => round(Math.min(Number(sale.total), sale.received === null || sale.received === undefined ? Number(sale.total) : Number(sale.received)))

function calculateTotals(sales, refunds, expenses, movements) {
  const grossSales = sales.reduce((sum, sale) => sum + sale.total, 0)
  const cashReceived = round(sales.filter((sale) => sale.paymentMethod === 'cash').reduce((sum, sale) => sum + cashKeptFromSale(sale), 0))
  const cardGross = sales.filter((sale) => sale.paymentMethod === 'card').reduce((sum, sale) => sum + sale.total, 0)
  const totalRefunds = refunds.reduce((sum, refund) => sum + refund.total, 0)
  const cashRefunds = refunds.filter((refund) => refund.paymentMethod === 'cash').reduce((sum, refund) => sum + refund.total, 0)
  const cardRefunds = totalRefunds - cashRefunds
  const expenditure = expenses.reduce((sum, expense) => sum + expense.amount, 0)
  const cashExpenses = expenses.filter((expense) => expense.paymentMethod === 'Cash from till').reduce((sum, expense) => sum + expense.amount, 0)
  const cashAdded = movements.filter((movement) => movement.type === 'added').reduce((sum, movement) => sum + movement.amount, 0)
  const cashRemoved = movements.filter((movement) => movement.type === 'removed').reduce((sum, movement) => sum + movement.amount, 0)
  const fees = round(sales.filter((sale) => sale.paymentMethod === 'card').reduce((sum, sale) => sum + sale.cardFee, 0) - refunds.filter((refund) => refund.paymentMethod === 'card').reduce((sum, refund) => sum + cardFee(refund.total, refund.cardFeeRate), 0))
  const netSales = round(grossSales - totalRefunds)
  return { sales, refunds, expenses, movements, grossSales, totalRefunds, cashReceived, cardGross, cashSales: round(cashReceived - cashRefunds), cardSales: round(cardGross - cardRefunds), cashRefunds, cardRefunds, expenditure, cashExpenses, cashAdded, cashRemoved, cardFees: Math.max(0, fees), netSales }
}

export function totalsFor(data, range = 'today', now = new Date()) {
  const pick = (items) => items.filter((item) => inDateRange(businessDateFor(item), range, now))
  return calculateTotals(pick(data.sales), pick(data.refunds), pick(data.expenses), pick(data.cashMovements))
}

export function totalsForBusinessDay(data, businessDate) {
  const pick = (items) => items.filter((item) => businessDateFor(item) === businessDate)
  return calculateTotals(pick(data.sales), pick(data.refunds), pick(data.expenses), pick(data.cashMovements))
}

export function businessDaySummary(data, businessDay) {
  const totals = totalsForBusinessDay(data, businessDay.date)
  const openingCash = Number(businessDay.openingCash) || 0
  const expected = expectedCash({ openingCash, ...totals, cashSales: totals.cashReceived })
  const closing = data.closings.find((record) => businessDateFor(record) === businessDay.date)
  const adjustments = (data.reconciliationAdjustments || []).filter((record) => businessDateFor(record) === businessDay.date)
  const actualCash = closing?.actualCash ?? null
  const difference = actualCash === null ? null : round(actualCash - expected)
  const originalExpectedCash = closing?.expectedCash ?? adjustments[0]?.originalExpectedCash ?? expected
  const originalDifference = closing?.difference ?? adjustments[0]?.originalDifference ?? (actualCash === null ? null : round(actualCash - originalExpectedCash))
  return {
    ...totals, date: businessDay.date, businessDate: businessDay.date, openingCash, expectedCash: expected,
    actualCash, difference, originalExpectedCash, originalDifference, adjustments, vat: vatFromInclusive(totals.netSales, data.settings.vatRate),
    profit: operatingProfit({ netSales: totals.netSales, vatRate: data.settings.vatRate, expenditure: totals.expenditure, cardFees: totals.cardFees })
  }
}

export function businessDayStatus(data, businessDay) {
  const summary = businessDaySummary(data, businessDay)
  if (summary.actualCash === null) return 'open'
  if (summary.adjustments.some((adjustment) => adjustment.cause === 'unknown')) return 'unresolved'
  if (summary.adjustments.length && summary.difference === 0) return 'resolved'
  if (summary.difference === 0) return 'balanced'
  return summary.difference < 0 ? 'short' : 'over'
}

export function canEditBusinessDay(data, businessDate) {
  const businessDay = data.businessDays.find((day) => day.date === businessDate)
  return data.activeBusinessDate === businessDate && Boolean(businessDay) && businessDayStatus(data, businessDay) === 'open'
}

export function nextBusinessDay(previousDay, closing) {
  return {
    id: `day-${previousDay.number + 1}-${addBusinessDays(previousDay.date)}`,
    number: previousDay.number + 1,
    date: addBusinessDays(previousDay.date),
    suggestedOpeningCash: closing.actualCash,
    openingCash: null,
    createdAt: new Date().toISOString(),
    shortageWarningDismissed: false
  }
}

export function startNextBusinessDay(data) {
  const current = data.businessDays.find((day) => day.date === data.activeBusinessDate)
  const closing = data.closings.find((record) => businessDateFor(record) === current?.date)
  if (!current || !closing) return data
  const next = nextBusinessDay(current, closing)
  return { ...data, businessDays: [...data.businessDays, next], activeBusinessDate: next.date }
}

export function closeBusinessDay(data, businessDate, actualCash) {
  const businessDay = data.businessDays.find((day) => day.date === businessDate)
  if (!businessDay) return data
  const calculated = businessDaySummary(data, businessDay)
  const summary = {
    id: `summary-${businessDate}`, date: businessDate, businessDate, openingCash: calculated.openingCash,
    expectedCash: calculated.expectedCash, actualCash: Number(actualCash), difference: round(Number(actualCash) - calculated.expectedCash), createdAt: new Date().toISOString()
  }
  return {
    ...data,
    closings: [...data.closings.filter((record) => businessDateFor(record) !== businessDate), summary]
  }
}

export function dismissShortage(data, businessDate) {
  return { ...data, businessDays: data.businessDays.map((day) => day.date === businessDate ? { ...day, shortageWarningDismissed: true } : day) }
}

export function reconciliationBreakdown(data, businessDay) {
  const summary = businessDaySummary(data, businessDay)
  const pick = (items) => items.filter((item) => businessDateFor(item) === businessDay.date)
  const label = (record, fallback) => record.description || record.reason || record.category || record.note || fallback
  const sales = pick(data.sales).filter((sale) => sale.paymentMethod === 'cash')
  const refunds = pick(data.refunds).filter((refund) => refund.paymentMethod === 'cash')
  const expenses = pick(data.expenses).filter((expense) => expense.paymentMethod === 'Cash from till')
  const movements = pick(data.cashMovements)
  const added = movements.filter((movement) => movement.type === 'added')
  const removed = movements.filter((movement) => movement.type === 'removed')
  return {
    summary,
    rows: [
      { key: 'opening', label: 'Opening cash', amount: summary.openingCash, records: [{ id: `opening-${businessDay.date}`, description: 'Opening till float', amount: summary.openingCash }] },
      { key: 'sales', label: 'Cash received', amount: summary.cashReceived, sign: '+', records: sales.map((sale) => ({ ...sale, description: sale.items?.map((item) => `${item.quantity}× ${item.name}`).join(', ') || 'Cash sale', amount: cashKeptFromSale(sale) })) },
      { key: 'added', label: 'Cash added', amount: summary.cashAdded, sign: '+', records: added.map((movement) => ({ ...movement, description: label(movement, 'Cash added') })) },
      { key: 'refunds', label: 'Cash refunds', amount: summary.cashRefunds, sign: '−', records: refunds.map((refund) => ({ ...refund, description: refund.items?.map((item) => `${item.quantity}× ${item.name}`).join(', ') || 'Cash refund', amount: refund.total })) },
      { key: 'expenses', label: 'Cash expenses', amount: summary.cashExpenses, sign: '−', records: expenses.map((expense) => ({ ...expense, description: label(expense, 'Cash expense') })) },
      { key: 'removed', label: 'Other cash removed', amount: summary.cashRemoved, sign: '−', records: removed.map((movement) => ({ ...movement, description: label(movement, 'Cash removed') })) }
    ]
  }
}

export function recordCashMovement(data, movement) {
  const amount = Number(movement.amount)
  const createdAt = movement.createdAt || new Date().toISOString()
  const cashMovement = { id: movement.id, businessDate: movement.businessDate, type: movement.type, amount, reason: movement.reason, category: movement.category, note: movement.note || '', createdAt }
  if (movement.type !== 'purchase') return { ...data, cashMovements: [...data.cashMovements, cashMovement] }
  const expense = { id: movement.expenseId, businessDate: movement.businessDate, date: movement.businessDate, createdAt, description: movement.reason, category: movement.category, amount, paymentMethod: 'Cash from till', note: movement.note || '', cashMovementId: movement.id }
  return { ...data, cashMovements: [...data.cashMovements, { ...cashMovement, expenseId: expense.id }], expenses: [...data.expenses, expense] }
}

export function applyReconciliationAdjustment(data, adjustment) {
  const businessDay = data.businessDays.find((day) => day.date === adjustment.businessDate)
  if (!businessDay) return data
  const summary = businessDaySummary(data, businessDay)
  const amount = Number(adjustment.amount)
  const createdAt = adjustment.createdAt || new Date().toISOString()
  const entry = { ...adjustment, amount, createdAt, businessDate: businessDay.date, originalExpectedCash: summary.originalExpectedCash, originalDifference: summary.originalDifference }
  if (adjustment.cause === 'expense') {
    const expenseId = adjustment.expenseId || `${adjustment.id}-expense`
    const expense = { id: expenseId, businessDate: businessDay.date, date: businessDay.date, createdAt, description: adjustment.description, category: adjustment.category, amount, paymentMethod: 'Cash from till', note: adjustment.note || '', reconciliationAdjustmentId: adjustment.id }
    return { ...data, expenses: [...data.expenses, expense], reconciliationAdjustments: [...(data.reconciliationAdjustments || []), { ...entry, expenseId, resolvedAt: createdAt }] }
  }
  if (adjustment.cause === 'unknown') return { ...data, reconciliationAdjustments: [...(data.reconciliationAdjustments || []), entry] }
  const movementId = adjustment.movementId || `${adjustment.id}-movement`
  const moved = recordCashMovement(data, { id: movementId, businessDate: businessDay.date, type: 'removed', amount, reason: adjustment.description, category: adjustment.category, note: adjustment.note, createdAt })
  return { ...moved, reconciliationAdjustments: [...(moved.reconciliationAdjustments || []), { ...entry, movementId, resolvedAt: createdAt }] }
}

export const initialProducts = [
  ['Flat white', 'Coffee', 3.4], ['Cappuccino', 'Coffee', 3.7], ['Americano', 'Coffee', 3.0], ['English breakfast tea', 'Tea', 2.8], ['Chai latte', 'Tea', 3.9], ['Ham & cheese toastie', 'Sandwiches', 6.8], ['Veggie focaccia', 'Sandwiches', 6.5], ['Almond croissant', 'Pastries', 3.3], ['Pain au chocolat', 'Pastries', 3.1]
].map(([name, category, price], index) => ({ id: `product-${index + 1}`, name, category, price }))

export const emptyData = () => ({
  products: initialProducts,
  sales: [], refunds: [], expenses: [], cashMovements: [], reconciliationAdjustments: [], openings: [], closings: [],
  businessDays: [{ id: `day-1-${localDate()}`, number: 1, date: localDate(), suggestedOpeningCash: null, openingCash: null, createdAt: new Date().toISOString(), shortageWarningDismissed: false }],
  activeBusinessDate: localDate(),
  settings: { vatRate: 20, cardFeeRate: 1.5 }
})

export function normaliseData(saved) {
  const blank = emptyData()
  if (!saved) return blank
  const { dailySummaries: _dailySummaries, ...savedData } = saved
  const records = (name) => (saved[name] || []).map((record) => ({ ...record, businessDate: businessDateFor(record) }))
  const sales = records('sales'), refunds = records('refunds'), expenses = records('expenses'), cashMovements = records('cashMovements'), reconciliationAdjustments = records('reconciliationAdjustments')
  const openings = records('openings'), closings = records('closings')
  const allDates = [...openings, ...closings, ...sales, ...expenses, ...cashMovements].map(businessDateFor)
  const dates = [...new Set(allDates)].sort()
  const businessDays = saved.businessDays?.length ? saved.businessDays.map(({ status: _status, ...day }, index) => ({ ...day, number: day.number || index + 1, openingCash: day.openingCash ?? openings.find((record) => record.businessDate === day.date)?.amount ?? null, shortageWarningDismissed: Boolean(day.shortageWarningDismissed) })) : (dates.length ? dates : [localDate()]).map((date, index) => ({
    id: `day-${index + 1}-${date}`, number: index + 1, date, suggestedOpeningCash: null, openingCash: openings.find((record) => record.businessDate === date)?.amount ?? null, createdAt: `${date}T09:00:00`, shortageWarningDismissed: false
  }))
  const activeBusinessDate = saved.activeBusinessDate || businessDays.find((day) => !closings.some((record) => record.businessDate === day.date))?.date || businessDays.at(-1).date
  return { ...blank, ...savedData, products: saved.products?.length ? saved.products : initialProducts, sales, refunds, expenses, cashMovements, reconciliationAdjustments, openings, closings, businessDays, activeBusinessDate, settings: { ...blank.settings, ...saved.settings } }
}
