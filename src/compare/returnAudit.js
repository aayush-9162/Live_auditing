// Audit of a RETURN ticket (the Ticket app's "RTS").
//
// A return ticket is not a sale. It lists only the lines being returned
// (quantity negative, no RV item id) plus any replacement lines, and its
// header totals are a copy of the original sale's. Run through the normal
// comparison it reports the whole RV sale as missing from the Ticket.
//
// So a return is checked on what it actually says: the returned lines, the
// replacement lines, and the money. RV records a return one of two ways, and
// both are handled:
//
//   in-place     the original sale is edited — the returned item comes off,
//                any replacement goes on, the totals drop. Same sale number as
//                the ticket names.
//   return-sale  a new sale is written for the return, dated the day of the
//                return, carrying a negative line per returned item and a
//                normal line per replacement. Its totals are the net change.
//
// Quantities are counted per RV item id rather than per line, so a partial
// return, or an item returned and put straight back on, works out the same.

const {
  eqStr, eqNum, pushDiff, diffCustomer, diffItems,
  normalizeItemId, itemKey, productBag, bagsEqual,
} = require('./diff').internals;

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// An RV item id without the "*PKG" marker the SALES EDIT parser adds.
function bareId(id) {
  return normalizeItemId(String(id || '').replace(/^\*PKG/i, ''));
}

// Find a ticket line on the RV sale by product text, for lines that carry no
// item id. RV splits vendor / grade into their own columns where the Ticket
// may bake them into the SKU, so compare as bags of words either way.
function matchBySku(line, rvItems) {
  const want = productBag(line.sku, line.cover, line.grade);
  if (!want.length) return null;
  return (rvItems || []).find((m) => bagsEqual(productBag(m.sku, m.cover, m.grade), want)
    || bagsEqual(productBag(m.ven, m.sku, m.cover, m.grade), want)) || null;
}

// Quantity on RV per item id, sale lines and return lines kept apart.
function tally(rows) {
  const out = new Map();
  for (const row of rows || []) {
    const id = bareId(row.itemId);
    const qty = Number(row.qty) || 0;
    if (!id || !qty) continue;
    const t = out.get(id) || { pos: 0, neg: 0 };
    if (qty > 0) t.pos += qty; else t.neg += -qty;
    out.set(id, t);
  }
  return out;
}

function lineLabel(line) {
  return [line.ven, line.sku].filter(Boolean).join(' ') || line.description || line.itemId || 'item';
}

// ctx:
//   original       the original sale ticket, normalized (null if not found)
//   originalLines  its raw lines, to turn a returned line's id into an RV item id
//   rvRows         the SALES EDIT lines as printed: [{ itemId, qty }]
//   receiptRows    the RV receipt's lines, same shape, or null
function compareReturn(jsonInvoice, mssqlRecord, ctx = {}) {
  if (!mssqlRecord) {
    return { matched: false, reason: 'no-mssql-record', diffs: [], json: jsonInvoice, mssql: null };
  }

  const out = [];
  const info = jsonInvoice.returnInfo || {};
  const original = ctx.original || null;
  const originalLines = ctx.originalLines || [];
  const rvItems = mssqlRecord.items || [];
  const rvNo = String(mssqlRecord.salesNo || '').trim();

  // The receipt is the newer print when a sale has been re-issued, so it is
  // the one that shows whether a returned item has come off.
  const editRows = ctx.rvRows || rvItems.map((it) => ({ itemId: it.itemId, qty: it.qty }));
  const receiptRows = ctx.receiptRows && ctx.receiptRows.length ? ctx.receiptRows : null;
  const onRv = tally(receiptRows || editRows);

  const sameSale = Boolean(info.rvNumber) && info.rvNumber === rvNo;
  const hasReturnRows = editRows.concat(receiptRows || []).some((r) => Number(r.qty) < 0);
  let mode;
  if (sameSale) mode = 'in-place';
  else if (hasReturnRows) mode = 'return-sale';
  else if (info.rvNumber) mode = 'other-sale';
  else mode = 'in-place';

  const audit = {
    mode,
    rvNumber: info.rvNumber || '',
    rvSalesNo: rvNo,
    rvSaleDate: (mssqlRecord.dates && mssqlRecord.dates.order) || '',
    returnDate: info.returnDate || '',
    checkedAgainst: receiptRows ? 'receipt' : 'salesEdit',
    original: original ? { id: original.id, slug: original.slug, date: original.dates.order } : null,
    originalSlug: info.originalInvoiceSlug || '',
    lines: [],
    totals: null,
    notes: [],
  };
  const done = () => ({
    matched: true,
    diffs: out,
    json: jsonInvoice,
    mssql: mssqlRecord,
    packageReconciled: { jsonIds: [], mssqlIds: [] },
    returnAudit: audit,
  });

  diffCustomer(jsonInvoice.customer, mssqlRecord.customer, out);

  // The PDF is neither the sale the ticket names nor a return written against
  // it — a different sale for the same customer. Nothing on it can be checked.
  if (mode === 'other-sale') {
    pushDiff(out, 'customer', 'rvSaleNumber', info.rvNumber, rvNo);
    for (const r of info.returned || []) {
      audit.lines.push({ kind: 'returned', label: lineLabel(r), itemId: '', qty: r.returnQty, ticket: `returned ${r.returnQty}`, rv: 'not checked', ok: null });
    }
    return done();
  }

  if (mode === 'in-place') {
    if (!eqStr(jsonInvoice.dates.order, mssqlRecord.dates.order)) {
      pushDiff(out, 'dates', 'order', jsonInvoice.dates.order, mssqlRecord.dates.order);
    }
  } else if (info.returnDate && audit.rvSaleDate && !eqStr(info.returnDate, audit.rvSaleDate)) {
    pushDiff(out, 'dates', 'returnDate', info.returnDate, audit.rvSaleDate);
  }

  // --- which RV item each line is --------------------------------------------
  const perId = new Map();                       // id -> { returned, added }
  const bump = (id, key, qty) => {
    const e = perId.get(id) || { returned: 0, added: 0 };
    e[key] += Number(qty) || 0;
    perId.set(id, e);
  };

  const returned = (info.returned || []).map((r) => {
    // The return line has no RV item id of its own; the original ticket's
    // line does. Failing that, look for the same product on the RV sale.
    const src = originalLines.find((o) => o.id && o.id === r.lineId);
    let itemId = src ? bareId(src.itemId) : '';
    if (!itemId) {
      const hit = matchBySku(r, rvItems);
      if (hit) itemId = bareId(hit.itemId);
    }
    if (itemId) bump(itemId, 'returned', r.returnQty);
    return { ...r, itemId };
  });

  const added = (jsonInvoice.items || []).filter((it) => !it.isReturn).map((a) => {
    let itemId = bareId(a.itemId);
    if (!itemId) {
      const hit = matchBySku(a, rvItems);
      if (hit) itemId = bareId(hit.itemId);
    }
    if (itemId) bump(itemId, 'added', a.qty);
    return { ...a, rvId: itemId };
  });

  // What the sale held before the return, per item id.
  const origQty = new Map();
  const addOrig = (id, qty) => origQty.set(id, (origQty.get(id) || 0) + (Number(qty) || 0));
  if (original) {
    for (const it of original.items || []) { const id = bareId(it.itemId); if (id) addOrig(id, it.qty); }
  } else {
    for (const r of returned) if (r.itemId) addOrig(r.itemId, r.originalQty);
  }

  const verdict = new Map();
  for (const [id, d] of perId) {
    const rv = onRv.get(id) || { pos: 0, neg: 0 };
    if (mode === 'in-place') {
      const expected = Math.max(0, (origQty.get(id) || 0) - d.returned + d.added);
      const actual = rv.pos - rv.neg;
      verdict.set(id, { ok: actual === expected, expected, actual });
    } else {
      verdict.set(id, { returnOk: rv.neg === d.returned, saleOk: rv.pos === d.added, neg: rv.neg, pos: rv.pos });
    }
  }

  // One mismatch per item id (and per direction on a return sale), however
  // many ticket lines point at it.
  const flagged = new Set();
  const flag = (key, field, ticketVal, rvVal) => {
    if (flagged.has(key)) return;
    flagged.add(key);
    pushDiff(out, 'items', field, ticketVal, rvVal);
  };
  const itemValue = (a) => ({
    itemId: a.itemId, qty: a.qty, ven: a.ven, sku: a.sku, grade: a.grade, cover: a.cover,
    description: a.description, salePrice: a.salePrice, extendedPrice: a.extendedPrice,
  });

  for (const r of returned) {
    const label = lineLabel(r);
    const line = { kind: 'returned', label, itemId: r.itemId, qty: r.returnQty, value: r2(r.extendedPrice * r.returnQty) };

    if (!r.itemId) {
      if (mode === 'in-place') {
        // Nothing with this product is on the RV sale, which is where a
        // returned item should end up.
        Object.assign(line, { ticket: `returned ${r.returnQty}`, rv: 'not on the RV sale', ok: true });
      } else {
        Object.assign(line, { ticket: `returned ${r.returnQty}`, rv: 'no return line on the RV sale', ok: false });
        flag(`line:${label}`, `returned:${label}`, `returned ${r.returnQty}`, 'no return line on the RV sale');
      }
      audit.lines.push(line);
      continue;
    }

    const v = verdict.get(r.itemId);
    const d = perId.get(r.itemId);
    if (mode === 'in-place') {
      line.ticket = v.expected === 0
        ? `returned ${r.returnQty} — should be off the sale`
        : `returned ${r.returnQty}${d.added ? `, ${d.added} added under the same item id` : ''} — ${v.expected} should remain`;
      line.rv = v.actual === 0 ? 'not on the RV sale' : `qty ${v.actual} on the RV sale`;
      line.ok = v.ok;
      if (!v.ok) {
        if (v.expected === 0) flag(r.itemId, `returned:${label}`, 'returned — should be off the sale', `still on the RV sale (qty ${v.actual})`);
        else flag(r.itemId, `${label}/qty`, v.expected, v.actual);
      }
    } else {
      line.ticket = `returned ${d.returned}`;
      line.rv = v.neg ? `return line for ${v.neg}` : 'no return line on the RV sale';
      line.ok = v.returnOk;
      if (!v.returnOk) flag(`${r.itemId}:neg`, `returned:${label}`, `returned ${d.returned}`, line.rv);
    }
    audit.lines.push(line);
  }

  for (const a of added) {
    const label = lineLabel(a);
    const line = { kind: 'added', label, itemId: a.rvId, qty: a.qty, value: r2(a.extendedPrice * a.qty) };

    if (!a.rvId) {
      Object.assign(line, { ticket: `added ${a.qty}`, rv: 'not on the RV sale', ok: false });
      flag(`line:${label}`, `missing-in-mssql:${label}`, itemValue(a), null);
      audit.lines.push(line);
      continue;
    }

    const v = verdict.get(a.rvId);
    const d = perId.get(a.rvId);
    let ok;
    if (mode === 'in-place') {
      ok = v.ok;
      line.ticket = `added ${d.added} — ${v.expected} should be on the sale`;
      line.rv = v.actual === 0 ? 'not on the RV sale' : `qty ${v.actual} on the RV sale`;
      if (!ok) {
        if (v.actual === 0) flag(a.rvId, `missing-in-mssql:${label}`, itemValue(a), null);
        else flag(a.rvId, `${label}/qty`, v.expected, v.actual);
      }
    } else {
      ok = v.saleOk;
      line.ticket = `added ${d.added}`;
      line.rv = v.pos ? `qty ${v.pos} on the RV sale` : 'not on the RV sale';
      if (!ok) {
        if (v.pos === 0) flag(`${a.rvId}:pos`, `missing-in-mssql:${label}`, itemValue(a), null);
        else flag(`${a.rvId}:pos`, `${label}/qty`, d.added, v.pos);
      }
    }
    line.ok = ok;
    audit.lines.push(line);

    // The replacement is a normal sale line, so its vendor / SKU / description
    // are held to the same standard as on any sale. Quantity is settled above.
    const match = rvItems.find((m) => itemKey(m) === itemKey(a));
    if (match) diffItems([{ ...a, qty: match.qty }], [match], out);
  }

  // --- the money ---------------------------------------------------------------
  // The return ticket's header totals are a copy of the original sale's, so
  // they serve as the "before" figures when the original ticket isn't to hand.
  const before = (original && original.totals) || jsonInvoice.totals || {};
  const base = mode === 'in-place' ? Number(before.subtotal) || 0 : 0;
  const returnedValue = Number(info.returnedValue) || 0;
  const newItemsValue = Number(info.newItemsValue) || 0;
  const newCharges = Number(info.newCharges) || 0;
  const expected = r2(base - returnedValue + newItemsValue);
  const rv = mssqlRecord.totals || {};
  const rvSubtotal = Number(rv.subtotal) || 0;

  // The ticket can add a delivery / care-plan charge on top of a return. RV
  // does not always carry it, so either figure counts as agreeing; which one
  // RV shows is reported rather than judged.
  let subtotalOk = eqNum(rvSubtotal, expected, 0.02);
  let chargesIncluded = false;
  if (!subtotalOk && newCharges > 0 && eqNum(rvSubtotal, r2(expected + newCharges), 0.02)) {
    subtotalOk = true;
    chargesIncluded = true;
  }

  const totals = {
    before: mode === 'in-place' ? r2(before.subtotal) : null,
    returnedValue: r2(returnedValue),
    newItemsValue: r2(newItemsValue),
    newCharges: r2(newCharges),
    chargesIncluded,
    expectedSubtotal: chargesIncluded ? r2(expected + newCharges) : expected,
    rvSubtotal: r2(rvSubtotal),
    subtotalOk,
    expectedTax: null,
    expectedTotal: null,
    taxOk: null,
    totalOk: null,
  };

  if (!subtotalOk) {
    // Tax and total follow from the subtotal, so one mismatch says it all.
    pushDiff(out, 'totals', 'subtotal', totals.expectedSubtotal, rvSubtotal);
  } else if (!jsonInvoice.noTaxSale && Number(before.subtotal) > 0) {
    const rate = (Number(before.tax) || 0) / Number(before.subtotal);
    totals.expectedTax = r2(rvSubtotal * rate);
    totals.expectedTotal = r2(rvSubtotal + totals.expectedTax);
    totals.taxOk = eqNum(rv.tax, totals.expectedTax, 0.05);
    totals.totalOk = eqNum(rv.total, totals.expectedTotal, 0.05);
    if (!totals.taxOk) pushDiff(out, 'totals', 'tax', totals.expectedTax, rv.tax);
    if (!totals.totalOk) pushDiff(out, 'totals', 'total', totals.expectedTotal, rv.total);
  }
  audit.totals = totals;

  if (newCharges > 0 && subtotalOk) {
    audit.notes.push(chargesIncluded
      ? `RV's total includes the $${newCharges.toFixed(2)} delivery / care-plan charge the ticket adds on this return.`
      : `The ticket adds a $${newCharges.toFixed(2)} delivery / care-plan charge on this return. RV's total does not include it.`);
  }
  if (!original && info.originalInvoiceSlug) {
    audit.notes.push('The original sale ticket could not be loaded, so the "before" figures are the copy carried on this return ticket.');
  }

  return done();
}

module.exports = { compareReturn };
