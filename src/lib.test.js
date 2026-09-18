import { describe, expect, it } from 'vitest'
import { applyReconciliationAdjustment, businessDayStatus, businessDaySummary, canEditBusinessDay, cardFee, closeBusinessDay, dismissShortage, expectedCash, inDateRange, normaliseData, operatingProfit, reconciliationBreakdown, recordCashMovement, refundableItems, startNextBusinessDay, totalsFor, totalsForBusinessDay, underpaidCashSales, validateRefund, vatFromInclusive } from './lib'

describe('TillFlow calculations', () => {
  it('calculates expected cash including all cash movements', () => {
    expect(expectedCash({ openingCash: 100, cashSales: 80, cashRefunds: 10, cashAdded: 20, cashRemoved: 15, cashExpenses: 12 })).toBe(163)
  })

  it('uses cash actually received, not the product price, for expected cash', () => {
    const data = {
      ...baseData({ sales: [{ id: 'underpaid-sale', businessDate: '2026-09-18', paymentMethod: 'cash', total: 13, received: 5, items: [] }] }),
      settings: { vatRate: 20, cardFeeRate: 1.5 }, closings: [], reconciliationAdjustments: []
    }
    const day = { date: '2026-09-18', openingCash: 100 }
    expect(businessDaySummary(data, day)).toMatchObject({ cashReceived: 5, cashSales: 5, expectedCash: 105 })
  })

  it('extracts VAT from VAT-inclusive sales', () => {
    expect(vatFromInclusive(120, 20)).toBe(20)
  })

  it('calculates estimated operating profit', () => {
    expect(operatingProfit({ netSales: 120, vatRate: 20, expenditure: 35, cardFees: 3 })).toBe(62)
  })

  it('calculates card-processing fees', () => {
    expect(cardFee(19.99, 1.5)).toBe(0.3)
  })

  it('only lets cash-from-till expenses reduce expected cash', () => {
    const data = baseData({ expenses: [expense('Cash from till', 12), expense('Bank transfer', 20)] })
    const totals = totalsFor(data)
    expect(totals.expenditure).toBe(32)
    expect(totals.cashExpenses).toBe(12)
  })

  it('keeps non-cash expenses out of expected cash', () => {
    const totals = totalsFor(baseData({ expenses: [expense('Card', 32)] }))
    expect(expectedCash({ openingCash: 100, ...totals })).toBe(100)
  })

  it('accounts for cash added and removed', () => {
    const totals = totalsFor(baseData({ cashMovements: [movement('added', 20), movement('removed', 7)] }))
    expect(expectedCash({ openingCash: 50, ...totals })).toBe(63)
  })

  it('keeps the selected product on a cash-added movement', () => {
    const saved = recordCashMovement(baseData(), { id: 'cash-added', businessDate: current.slice(0, 10), type: 'added', amount: 20, category: 'Flat white', createdAt: current })
    expect(saved.cashMovements[0]).toMatchObject({ type: 'added', category: 'Flat white' })
  })

  it('flags only cash sales recorded below their product sale total', () => {
    const flagged = underpaidCashSales([
      { id: 'underpaid', paymentMethod: 'cash', total: 13, received: 5 },
      { id: 'exact', paymentMethod: 'cash', total: 13, received: 13 },
      { id: 'card', paymentMethod: 'card', total: 13, received: 0 },
      { id: 'legacy', paymentMethod: 'cash', total: 13 }
    ])
    expect(flagged).toEqual([expect.objectContaining({ id: 'underpaid', shortfall: 8 })])
  })

  it('supports full and partial refunds', () => {
    const sale = saleWithTwoCroissants()
    const partial = [{ saleId: sale.id, items: [{ productId: 'croissant', quantity: 1 }] }]
    expect(refundableItems(sale, partial)[0].available).toBe(1)
    expect(validateRefund(sale, partial, [{ productId: 'croissant', quantity: 1 }])).toBe(true)
    const full = [{ saleId: sale.id, items: [{ productId: 'croissant', quantity: 2 }] }]
    expect(refundableItems(sale, full)[0].available).toBe(0)
  })

  it('prevents excessive refunds', () => {
    const sale = saleWithTwoCroissants()
    const refunds = [{ saleId: sale.id, items: [{ productId: 'croissant', quantity: 1 }] }]
    expect(validateRefund(sale, refunds, [{ productId: 'croissant', quantity: 2 }])).toBe(false)
  })

  it('filters dates for today, week, and month', () => {
    const now = new Date('2026-09-17T12:00:00')
    expect(inDateRange('2026-09-17T09:00:00', 'today', now)).toBe(true)
    expect(inDateRange('2026-09-14T09:00:00', 'week', now)).toBe(true)
    expect(inDateRange('2026-09-01T09:00:00', 'month', now)).toBe(true)
    expect(inDateRange('2026-08-31T09:00:00', 'month', now)).toBe(false)
  })

  it('starts a new logical business day and carries actual closing cash forward', () => {
    const data = twoDayFixture()
    const next = startNextBusinessDay(data)
    expect(next.businessDays).toHaveLength(2)
    expect(next.activeBusinessDate).toBe('2026-09-17')
    expect(next.businessDays[1]).toMatchObject({ date: '2026-09-17', number: 2, suggestedOpeningCash: 448, openingCash: null })
  })

  it('closes an open day before starting its successor', () => {
    const data = twoDayFixture()
    data.closings = []
    const closed = closeBusinessDay(data, '2026-09-16', 463)
    const next = startNextBusinessDay(closed)
    expect(businessDayStatus(closed, closed.businessDays[0])).toBe('balanced')
    expect(next.businessDays[1].suggestedOpeningCash).toBe(463)
  })

  it('keeps records separate by business day while range totals include both', () => {
    const data = twoDayFixture()
    data.businessDays.push({ id: 'day-2', number: 2, date: '2026-09-17', openingCash: 448 })
    data.activeBusinessDate = '2026-09-17'
    data.sales.push({ id: 'day-2-cash', businessDate: '2026-09-17', createdAt: '2026-09-17T10:00:00', total: 20, paymentMethod: 'cash', cardFee: 0, items: [] })
    expect(totalsForBusinessDay(data, '2026-09-16').cashSales).toBe(345)
    expect(totalsForBusinessDay(data, '2026-09-17').cashSales).toBe(20)
    expect(totalsFor(data, 'today', new Date('2026-09-17T12:00:00')).cashSales).toBe(20)
    expect(totalsFor(data, 'week', new Date('2026-09-17T12:00:00')).cashSales).toBe(365)
  })

  it('calculates the Day 1 £15 shortage from underlying records', () => {
    const data = twoDayFixture()
    const summary = businessDaySummary(data, data.businessDays[0])
    expect(summary.expectedCash).toBe(463)
    expect(summary.actualCash).toBe(448)
    expect(summary.difference).toBe(-15)
  })

  it('marks a day short when actual cash is below expected cash', () => {
    const data = twoDayFixture()
    expect(businessDayStatus(data, data.businessDays[0])).toBe('short')
  })

  it('persists a dismissed warning without deleting the discrepancy', () => {
    const data = twoDayFixture()
    const dismissed = dismissShortage(data, '2026-09-16')
    expect(dismissed.businessDays[0].shortageWarningDismissed).toBe(true)
    expect(businessDaySummary(dismissed, dismissed.businessDays[0]).difference).toBe(-15)
  })

  it('builds the Day 1 reconciliation from its underlying records', () => {
    const data = twoDayFixture()
    const breakdown = reconciliationBreakdown(data, data.businessDays[0])
    expect(Object.fromEntries(breakdown.rows.map((row) => [row.key, row.amount]))).toMatchObject({ opening: 150, sales: 350, added: 0, refunds: 5, expenses: 22, removed: 10 })
    expect(breakdown.summary).toMatchObject({ expectedCash: 463, actualCash: 448, difference: -15 })
  })

  it('resolves the coffee-bean shortage without deleting its original audit trail', () => {
    const data = twoDayFixture()
    const before = businessDaySummary(data, data.businessDays[0])
    const resolved = coffeeBeans(data)
    const after = businessDaySummary(resolved, resolved.businessDays[0])
    expect(after.expectedCash).toBe(448)
    expect(after.difference).toBe(0)
    expect(after.profit).toBe(before.profit - 15)
    expect(after.originalDifference).toBe(-15)
    expect(after.adjustments[0]).toMatchObject({ description: 'Purchase coffee beans', amount: 15, expenseId: 'coffee-beans-expense' })
    expect(businessDayStatus(resolved, resolved.businessDays[0])).toBe('resolved')
  })

  it('does not count a linked business purchase twice', () => {
    const data = twoDayFixture()
    const purchase = recordCashMovement(data, { id: 'beans-movement', expenseId: 'beans-expense', businessDate: '2026-09-16', type: 'purchase', amount: 15, reason: 'Purchase coffee beans', category: 'Goods or supplies', createdAt: '2026-09-16T16:30:00' })
    const summary = businessDaySummary(purchase, purchase.businessDays[0])
    expect(purchase.cashMovements.find((item) => item.id === 'beans-movement').expenseId).toBe('beans-expense')
    expect(summary.cashExpenses).toBe(37)
    expect(summary.cashRemoved).toBe(10)
    expect(summary.expectedCash).toBe(448)
    expect(summary.profit).toBe(businessDaySummary(data, data.businessDays[0]).profit - 15)
  })

  it('keeps a still-unknown difference unresolved', () => {
    const data = twoDayFixture()
    const unresolved = applyReconciliationAdjustment(data, { id: 'unknown', businessDate: '2026-09-16', cause: 'unknown', amount: 15, description: 'Still investigating', category: 'Other', createdAt: '2026-09-16T18:30:00' })
    expect(businessDayStatus(unresolved, unresolved.businessDays[0])).toBe('unresolved')
    expect(businessDaySummary(unresolved, unresolved.businessDays[0]).difference).toBe(-15)
  })

  it('makes a previous closed day read-only', () => {
    const data = twoDayFixture()
    data.businessDays.push({ id: 'day-2', number: 2, date: '2026-09-17', openingCash: 448 })
    data.activeBusinessDate = '2026-09-17'
    expect(canEditBusinessDay(data, '2026-09-16')).toBe(false)
    expect(canEditBusinessDay(data, '2026-09-17')).toBe(true)
  })

  it('preserves multiple days and the active day after local-storage round trip', () => {
    const data = twoDayFixture()
    data.businessDays.push({ id: 'day-2', number: 2, date: '2026-09-17', openingCash: 448 })
    data.activeBusinessDate = '2026-09-17'
    const restored = normaliseData(JSON.parse(JSON.stringify(data)))
    expect(restored.businessDays).toHaveLength(2)
    expect(restored.activeBusinessDate).toBe('2026-09-17')
    expect(businessDaySummary(restored, restored.businessDays[0]).difference).toBe(-15)
  })

  it('persists a reconciliation adjustment after local-storage reload', () => {
    const restored = normaliseData(JSON.parse(JSON.stringify(coffeeBeans(twoDayFixture()))))
    const summary = businessDaySummary(restored, restored.businessDays[0])
    expect(restored.reconciliationAdjustments).toHaveLength(1)
    expect(summary).toMatchObject({ expectedCash: 448, difference: 0, originalDifference: -15 })
    expect(businessDayStatus(restored, restored.businessDays[0])).toBe('resolved')
  })
})

const current = new Date().toISOString()
const baseData = (overrides = {}) => ({ sales: [], refunds: [], expenses: [], cashMovements: [], ...overrides })
const expense = (paymentMethod, amount) => ({ id: paymentMethod, createdAt: current, date: current.slice(0, 10), paymentMethod, amount, category: 'Other' })
const movement = (type, amount) => ({ id: type, createdAt: current, type, amount })
const saleWithTwoCroissants = () => ({ id: 'sale-1', items: [{ productId: 'croissant', name: 'Croissant', price: 3.2, quantity: 2 }] })
const coffeeBeans = (data) => applyReconciliationAdjustment(data, { id: 'coffee-beans', expenseId: 'coffee-beans-expense', businessDate: '2026-09-16', cause: 'expense', amount: 15, description: 'Purchase coffee beans', category: 'Goods or supplies', createdAt: '2026-09-16T18:10:00' })
const twoDayFixture = () => ({
  settings: { vatRate: 20, cardFeeRate: 1.5 }, activeBusinessDate: '2026-09-16',
  businessDays: [{ id: 'day-1', number: 1, date: '2026-09-16', openingCash: 150, shortageWarningDismissed: false }],
  sales: [{ id: 'cash-sale', businessDate: '2026-09-16', createdAt: '2026-09-16T09:00:00', total: 350, paymentMethod: 'cash', cardFee: 0, items: [{ productId: 'cash', quantity: 70, price: 5 }] }, { id: 'card-sale', businessDate: '2026-09-16', createdAt: '2026-09-16T12:00:00', total: 220, paymentMethod: 'card', cardFee: 3.3, items: [] }],
  refunds: [{ id: 'cash-refund', saleId: 'cash-sale', businessDate: '2026-09-16', createdAt: '2026-09-16T13:00:00', total: 5, paymentMethod: 'cash', cardFeeRate: 1.5, items: [{ productId: 'cash', quantity: 1, price: 5 }] }],
  expenses: [{ id: 'cash-expense', businessDate: '2026-09-16', date: '2026-09-16', createdAt: '2026-09-16T14:00:00', amount: 22, paymentMethod: 'Cash from till', category: 'Goods or supplies' }],
  cashMovements: [{ id: 'cash-removed', businessDate: '2026-09-16', createdAt: '2026-09-16T15:00:00', type: 'removed', amount: 10 }],
  openings: [{ id: 'open', businessDate: '2026-09-16', amount: 150 }], closings: [{ id: 'close', businessDate: '2026-09-16', actualCash: 448 }]
})
