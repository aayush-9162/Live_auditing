// Parse the customer-facing "RV RCPT" PDF that sits beside every SALES EDIT.
//
// It carries less than the SALES EDIT — no cost, margin, bin location or
// transfer flags — but what it does carry, it states plainly. In particular
// the totals are the whole sale, one figure per label:
//
//     Sale Total          2,748.00
//     Sales Tax             192.36
//     Grand Total         2,940.36
//     Payment Received      300.00
//     Balance Due         2,640.36
//
// The SALES EDIT prints those same figures three times (this delivery /
// original order / remaining) and they diverge whenever part of a sale is
// back ordered, so the receipt is a useful second opinion on the numbers.

// Same RV money conventions as the SALES EDIT: ".00" for zero, and negatives
// with the minus trailing ("172.50-").
const NUMBER_RE = /^-?(?:[\d,]+\.\d{2}|\.\d{2})-?$/;

function num(s) {
  if (s === null || s === undefined || s === '') return null;
  let str = String(s).trim().replace(/[$,]/g, '');
  let negative = false;
  if (str.endsWith('-')) { negative = true; str = str.slice(0, -1); }
  if (str.startsWith('.')) str = `0${str}`;
  const n = Number(str);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function isNumeric(s) {
  return NUMBER_RE.test(String(s || '').trim());
}

// The value printed to the right of a label on the same row.
function valueFor(lines, label) {
  const want = label.toUpperCase();
  for (const line of lines) {
    const idx = line.cells.findIndex((c) => c.str.toUpperCase().replace(/\s+/g, ' ').trim() === want);
    if (idx < 0) continue;
    const labelX = line.cells[idx].x;
    const after = line.cells.filter((c) => c.x > labelX && isNumeric(c.str));
    if (after.length) return num(after[0].str);
  }
  return null;
}

// "Customer ID / Sale No. / Sale Date" sit as headings with their values on
// the row beneath.
function readIdentifiers(lines) {
  const out = { customerId: '', salesNo: '', saleDate: '' };
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/SALE\s*NO/i.test(lines[i].text)) continue;
    const values = lines[i + 1].cells.map((c) => clean(c.str)).filter(Boolean);
    const digits = values.filter((v) => /^\d+$/.test(v.replace(/\s/g, '')));
    if (digits.length >= 2) {
      out.customerId = digits[0];
      out.salesNo = digits[1];
    }
    // The date is printed a character at a time ("09" "/" "21" "/" "2026"),
    // so read it off the joined row rather than any single cell.
    const joined = values.join('').replace(/\s+/g, '');
    const date = joined.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (date) out.saleDate = date[0];
    break;
  }
  return out;
}

// Item rows look like
//    1   EA   1163971   JOHN 0145606 CUPRUM KING 6/6    2,000.00   2,000.00
//  B/O                  PLUSH EPT FD HD AIRELUXE MATT 6/6
// where the row underneath carries the second description line and, for a
// back-ordered line, the "B/O" status in the left margin.
function readItems(lines, from, to) {
  const items = [];
  for (let i = from; i < to; i++) {
    const cells = lines[i].cells;
    const uom = cells.findIndex((c) => /^(EA|EACH|PR|SET|PC|PCS)$/i.test(c.str.trim()));
    if (uom < 1) continue;

    const qty = num(cells[uom - 1].str);
    if (qty === null) continue;

    const rest = cells.slice(uom + 1);
    const money = rest.filter((c) => isNumeric(c.str));
    const text = rest.filter((c) => !isNumeric(c.str)).map((c) => clean(c.str)).filter(Boolean);
    if (!text.length) continue;

    const item = {
      qty,
      itemId: text[0],
      description: clean(text.slice(1).join(' ')),
      description2: '',
      unitPrice: money.length ? num(money[0].str) : null,
      extendedPrice: money.length > 1 ? num(money[money.length - 1].str) : null,
      backOrdered: false,
    };

    // The following row: second description line, plus any status flag.
    const next = lines[i + 1];
    if (next) {
      const flags = next.cells.filter((c) => /^B\s*\/\s*O$/i.test(c.str.trim()));
      if (flags.length) item.backOrdered = true;
      const desc2 = next.cells
        .filter((c) => !/^B\s*\/\s*O$/i.test(c.str.trim()) && !isNumeric(c.str))
        .map((c) => clean(c.str))
        .filter(Boolean)
        .join(' ');
      // Only treat it as a description when it isn't the next item row.
      const isItemRow = next.cells.some((c) => /^(EA|EACH|PR|SET|PC|PCS)$/i.test(c.str.trim()));
      if (!isItemRow && desc2) item.description2 = clean(desc2);
    }

    items.push(item);
  }
  return items;
}

function parseRvReceipt(pages) {
  const lines = [];
  for (const page of pages) {
    for (const line of page.lines) if (line.cells.length) lines.push(line);
  }

  const findIdx = (re, from = 0) => {
    for (let i = from; i < lines.length; i++) if (re.test(lines[i].text)) return i;
    return -1;
  };

  const headerIdx = findIdx(/Quantity\s*Sold|Item\s*Description/i);
  const paymentsIdx = findIdx(/Payments\s*Received\s*On\s*Sale/i, Math.max(headerIdx, 0));
  const itemsFrom = headerIdx >= 0 ? headerIdx + 1 : 0;
  const itemsTo = paymentsIdx >= 0 ? paymentsIdx : lines.length;

  const ids = readIdentifiers(lines);
  const items = readItems(lines, itemsFrom, itemsTo);

  // Payment lines between the "Payments Received On Sale" heading and the
  // "Total Payments" line, e.g. "Cash 300.00".
  const payments = [];
  if (paymentsIdx >= 0) {
    for (let i = paymentsIdx + 1; i < lines.length; i++) {
      if (/Total\s*Payments/i.test(lines[i].text)) break;
      const money = lines[i].cells.filter((c) => isNumeric(c.str));
      const label = lines[i].cells.filter((c) => !isNumeric(c.str)).map((c) => clean(c.str)).filter(Boolean).join(' ');
      if (label && money.length) payments.push({ method: clean(label), amount: num(money[money.length - 1].str) });
    }
  }

  const readLabelled = (label) => {
    for (const line of lines) {
      const hit = line.cells.find((c) => clean(c.str).toUpperCase() === label.toUpperCase());
      if (!hit) continue;
      const after = line.cells.filter((c) => c.x > hit.x && isNumeric(c.str));
      if (after.length) return num(after[0].str);
    }
    return null;
  };

  return {
    ...ids,
    ...(() => {
      // Salesperson codes, delivery route and payment terms share one row
      // under their headings. The values sit well left of the headings they
      // belong to, so read them by shape rather than by column: the route is
      // the van/pickup cell and the terms are whatever comes last.
      const idx = findIdx(/Payment\s*Terms/i);
      const row = idx >= 0 && lines[idx + 1] ? lines[idx + 1].cells : [];
      if (!row.length) return { terms: '', deliveryVia: '', salespersons: [] };
      const route = row.find((c) => /\bvan\b|\bpick ?up\b|\bwill call\b/i.test(c.str));
      const terms = row[row.length - 1];
      return {
        terms: terms && terms !== route ? clean(terms.str) : '',
        deliveryVia: route ? clean(route.str) : '',
        salespersons: row
          .filter((c) => c !== route && c !== terms && /^[A-Za-z]{2,4}$/.test(c.str.trim()))
          .map((c) => clean(c.str).toUpperCase()),
      };
    })(),
    items,
    payments,
    totals: {
      saleTotal:       readLabelled('Sale Total'),
      salesTax:        readLabelled('Sales Tax'),
      grandTotal:      readLabelled('Grand Total'),
      paymentReceived: readLabelled('Payment Received'),
      balanceDue:      readLabelled('Balance Due'),
      totalPayments:   valueFor(lines, 'Total Payments'),
    },
  };
}

module.exports = { parseRvReceipt };
