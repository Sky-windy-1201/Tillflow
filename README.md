# TillFlow

A frontend-only point-of-sale and daily cash reconciliation MVP for small UK businesses. Data is stored in the current browser using `localStorage`.

## Run it

```bash
npm install
npm run dev
```

Open the local URL Vite prints (usually `http://localhost:5173`).

## Checks

```bash
npm test
npm run build
```

## Included workflow

1. Open the till with one opening-cash total.
2. Take cash or card payments in Checkout.
3. Record cash movements and business expenditure.
4. Refund selected sale items from Transactions.
5. Reconcile counted cash in Close day, then start the next logical business day using the actual closing cash as the suggested opening amount.

Each financial record is assigned a business date, so closed days stay read-only while weekly and monthly totals can span the saved history. Shortage banners can be dismissed without changing the saved reconciliation. Settings controls the VAT-inclusive sales rate and default card-processing fee.

TillFlow’s profit figure is an **estimated operating profit based on recorded transactions**, not official accounting profit.
