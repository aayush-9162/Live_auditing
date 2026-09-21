const { namesMatch } = require('../match/name');
const { addressEqual } = require('../match/address');
const { expectedDeliveryVia } = require('../match/deliveryVia');

function eqStr(a, b) {
  return String(a || '').toLowerCase().trim() === String(b || '').toLowerCase().trim();
}

function eqAddr(a, b) {
  return addressEqual(a, b);
}

// Like eqStr but treats hyphens, periods, and other punctuation as spaces.
// Useful for city names like "Fuquay-Varina" vs "Fuquay Varina".
function eqCity(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}

function eqNum(a, b, tol = 0.01) {
  const x = Number(a) || 0;
  const y = Number(b) || 0;
  return Math.abs(x - y) <= tol;
}

function pushDiff(out, group, field, jsonVal, mssqlVal) {
  out.push({
    group,
    field,
    json: jsonVal,
    mssql: mssqlVal,
  });
}

function diffCustomer(a, b, out) {
  if (!namesMatch(a.name, b.name)) pushDiff(out, 'customer', 'name', a.name, b.name);
  if (!eqStr(a.cell, b.cell))      pushDiff(out, 'customer', 'cell', a.cell, b.cell);
  if (!eqStr(a.home, b.home))      pushDiff(out, 'customer', 'home', a.home, b.home);
  if (!eqStr(a.email, b.email))    pushDiff(out, 'customer', 'email', a.email, b.email);

  diffAddressBlock(a.billing  || {}, b.billing  || {}, 'billing',  out);
  diffAddressBlock(a.delivery || {}, b.delivery || {}, 'delivery', out);
}

function diffAddressBlock(a, b, group, out) {
  if (!eqAddr(a.address, b.address))   pushDiff(out, 'customer', `${group}.address`,  a.address,  b.address);
  if (!eqAddr(a.address2, b.address2)) pushDiff(out, 'customer', `${group}.address2`, a.address2, b.address2);
  if (!eqCity(a.city, b.city))         pushDiff(out, 'customer', `${group}.city`,     a.city,     b.city);
  if (!eqStr(a.state, b.state))        pushDiff(out, 'customer', `${group}.state`,    a.state,    b.state);
  if (!eqStr(a.zip, b.zip))            pushDiff(out, 'customer', `${group}.zip`,      a.zip,      b.zip);
}

function diffDates(a, b, out) {
  if (!eqStr(a.order, b.order)) pushDiff(out, 'dates', 'order', a.order, b.order);
  // Single delivery comparison. Both sides have already collapsed pickup_asap
  // into the literal "ASAP" marker, so pickup-orders match without special
  // casing here.
  if (!eqStr(a.effective, b.effective)) pushDiff(out, 'dates', 'delivery', a.effective, b.effective);
}

function diffTotals(a, b, out, opts = {}) {
  // Subtotal — for No-Tax-Sale tickets, also accept Ticket.subtotal that
  // equals RV.subtotal + RV.tax (RV computed tax but the promo absorbed it
  // into the price, so Ticket's pre-tax subtotal == RV's total).
  let subtotalOk = eqNum(a.subtotal, b.subtotal);
  if (!subtotalOk && opts.noTaxSale) {
    subtotalOk = eqNum(a.subtotal, (Number(b.subtotal) || 0) + (Number(b.tax) || 0));
  }
  if (!subtotalOk) pushDiff(out, 'totals', 'subtotal', a.subtotal, b.subtotal);

  // Skip tax + total checks for No-Tax-Sale tickets — RV may still compute
  // tax but it's expected.
  if (!opts.noTaxSale) {
    if (!eqNum(a.tax, b.tax))             pushDiff(out, 'totals', 'tax', a.tax, b.tax);
    if (!eqNum(a.total, b.total))         pushDiff(out, 'totals', 'total', a.total, b.total);
  }
  if (!eqNum(a.amountPaid, b.amountPaid)) pushDiff(out, 'totals', 'amountPaid', a.amountPaid, b.amountPaid);
  if (!eqNum(a.balanceDue, b.balanceDue)) pushDiff(out, 'totals', 'balanceDue', a.balanceDue, b.balanceDue);
  if (!termsEqual(a.terms, b.terms))      pushDiff(out, 'totals', 'terms', a.terms, b.terms);
}

// Terms codes that mean the same thing across systems. Add pairs here as
// they come up — e.g. FIN (financing) and GE (general/GE finance) are the
// same on the shop floor.
const TERMS_ALIASES = [
  ['FIN', 'GE'],
];

function termsEqual(a, b) {
  const na = String(a || '').trim().toUpperCase();
  const nb = String(b || '').trim().toUpperCase();
  if (na === nb) return true;
  for (const group of TERMS_ALIASES) {
    if (group.includes(na) && group.includes(nb)) return true;
  }
  return false;
}

// Prefer itemId as the match key. Numeric IDs are zero-padded in MSSQL but
// bare in JSON, so strip leading zeros. Generic *-prefix itemIds are shared
// across distinct products (e.g. *SIGNCASE used for headboard AND footboard),
// so include SKU in the key for those.
function normalizeItemId(id) {
  const v = String(id || '').trim().toLowerCase();
  if (!v) return '';
  return /^\d+$/.test(v) ? v.replace(/^0+/, '') || '0' : v;
}

function itemKey(it) {
  const id = normalizeItemId(it.itemId);
  if (id && !id.startsWith('*')) return `id:${id}`;
  // Star items / itemId-less items: build a signature from sku + cover where
  // all non-alphanumeric is stripped and lowercased. This collapses parsing
  // differences like "B414 84" + "LANDOCKEN" vs "B414" + "84 LANDOCKEN" into
  // the same key "b41484landocken".
  const sig = [it.sku, it.cover].filter(Boolean).join(' ').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (id) return sig ? `${id}|${sig}` : id;
  return sig ? `sig:${sig}` : '';
}

// Soft text match: ignore case, collapse whitespace, ignore inner punctuation.
function softTextEqual(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return na === nb;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// Grade may be parsed as "GC" in MSSQL (G is a section/group prefix) while
// JSON has just "c". Treat one as a suffix-or-substring of the other.
function gradeEqual(a, b) {
  const na = String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const nb = String(b || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!na || !nb) return na === nb;
  return na === nb || na.endsWith(nb) || nb.endsWith(na);
}

// Tokenize and normalize a product identifier across one or more fields.
function productBag(...parts) {
  return parts
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort();
}

function bagsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function diffItems(jsonItems, mssqlItems, out) {
  if ((!jsonItems || jsonItems.length === 0) && (!mssqlItems || mssqlItems.length === 0)) return;

  const jMap = new Map();
  const mMap = new Map();
  for (const it of jsonItems || []) jMap.set(itemKey(it), it);
  for (const it of mssqlItems || []) mMap.set(itemKey(it), it);

  const seen = new Set();
  for (const [k, j] of jMap) {
    seen.add(k);
    const m = mMap.get(k);
    const label = itemLabel(j);
    if (!m) {
      pushDiff(out, 'items', `missing-in-mssql:${label}`, j, null);
      continue;
    }
    if (!eqNum(j.qty, m.qty))                     pushDiff(out, 'items', `${label}/qty`, j.qty, m.qty);
    if (!eqStr(j.ven, m.ven))                     pushDiff(out, 'items', `${label}/ven`, j.ven, m.ven);
    // Treat sku + cover + grade as one bag of tokens per side. JSON may bake
    // the grade into the SKU string (e.g. "9B14 DP 22389 MUSHROOM") while RV
    // breaks it out as a separate column. Compare as multisets so ordering
    // and field-placement differences don't trigger a false mismatch.
    const jBag = productBag(j.sku, j.cover, j.grade);
    const mBag = productBag(m.sku, m.cover, m.grade);
    if (!bagsEqual(jBag, mBag))                   pushDiff(out, 'items', `${label}/sku+cover`, [j.sku, j.cover, j.grade].filter(Boolean).join(' '), [m.sku, m.cover, m.grade].filter(Boolean).join(' '));
    if (!softTextEqual(j.description, m.description))
                                                  pushDiff(out, 'items', `${label}/description`, j.description, m.description);
    if (m.salePrice !== undefined && !eqNum(j.salePrice, m.salePrice))
                                                  pushDiff(out, 'items', `${label}/salePrice`, j.salePrice, m.salePrice);
    // Extended price is informational only — not diff-compared. RV often
    // stores the after-discount line total while the Ticket shows the
    // pre-discount value, so these routinely differ without being wrong.
    // if (!eqNum(j.extendedPrice, m.extendedPrice)) pushDiff(out, 'items', `${label}/extPrice`, j.extendedPrice, m.extendedPrice);
  }
  for (const [k, m] of mMap) {
    if (!seen.has(k)) pushDiff(out, 'items', `missing-in-json:${itemLabel(m)}`, null, m);
  }
}

function itemLabel(it) {
  if (!it) return '?';
  const id = normalizeItemId(it.itemId);
  const sku = String(it.sku || '').trim();
  if (id && !id.startsWith('*')) return id;
  return id ? `${id} ${sku}`.trim() : sku || '?';
}

// Packages. The Ticket prices a package as a whole and leaves every member
// line at 0; RV prints a roll-up row carrying the same total and allocates it
// across the member lines. Neither side's item rows can be compared on price
// for these, so the package total is what gets audited.
//
// The two sides name packages differently ("bedroom" vs "*PKG1253243"), so
// pair them by how many member items they share, falling back to an equal
// price when membership is unknown.
function diffPackages(jsonPackages, mssqlPackages, out) {
  const a = jsonPackages || [];
  const b = mssqlPackages || [];
  if (!a.length && !b.length) return;

  const ids = (pkg) => new Set((pkg.itemIds || []).map(normalizeItemId).filter(Boolean));
  const overlap = (x, y) => {
    const sy = ids(y);
    let n = 0;
    for (const id of ids(x)) if (sy.has(id)) n++;
    return n;
  };

  const takenB = new Set();
  for (const pkg of a) {
    let best = -1;
    let bestScore = 0;
    b.forEach((cand, i) => {
      if (takenB.has(i)) return;
      const score = overlap(pkg, cand);
      if (score > bestScore) { bestScore = score; best = i; }
    });
    // No shared members (RV couldn't resolve membership) — fall back to price.
    if (best < 0) {
      best = b.findIndex((cand, i) => !takenB.has(i) && eqNum(cand.price, pkg.price));
    }
    // Still nothing, and exactly one package each side — they must be the pair.
    if (best < 0 && a.length === 1 && b.length === 1 && !takenB.has(0)) best = 0;

    const label = pkg.label || pkg.key || 'package';
    if (best < 0) {
      pushDiff(out, 'packages', `missing-in-mssql:${label}`, pkg, null);
      continue;
    }
    takenB.add(best);
    const match = b[best];
    if (!eqNum(pkg.price, match.price)) {
      pushDiff(out, 'packages', `${label}/price`, pkg.price, match.price);
    }
    if (pkg.itemIds && match.itemIds && match.itemIds.length) {
      const missing = [...ids(pkg)].filter((id) => !ids(match).has(id));
      const extra   = [...ids(match)].filter((id) => !ids(pkg).has(id));
      if (missing.length || extra.length) {
        pushDiff(out, 'packages', `${label}/items`,
          (pkg.itemIds || []).join(', '), (match.itemIds || []).join(', '));
      }
    }
  }

  b.forEach((pkg, i) => {
    if (takenB.has(i)) return;
    pushDiff(out, 'packages', `missing-in-json:${pkg.label || pkg.key || 'package'}`, null, pkg);
  });
}

function diffDeliveryVia(jsonInvoice, mssqlRecord, out) {
  const expected = expectedDeliveryVia({
    state: (jsonInvoice.customer.delivery && jsonInvoice.customer.delivery.state) || jsonInvoice.customer.state,
    orderDate: jsonInvoice.dates.order,
    deliveryDate: jsonInvoice.dates.delivery || jsonInvoice.dates.pickup,
    isPickup: jsonInvoice.dates.isPickup,
  });
  if (expected === null) return; // pickup orders: rule doesn't apply
  const actual = String(mssqlRecord.deliveryVia || '').trim().toUpperCase();
  if (actual !== expected) {
    pushDiff(out, 'dates', 'deliveryVia', expected, actual || '(none)');
  }
}

function diffFees(jsonInvoice, mssqlRecord, out) {
  const a = jsonInvoice.fees || {};
  const b = mssqlRecord.fees || {};
  // For pickup orders, RV often carries an incidental "CFC DELIVERY/SETUP"
  // line (setup/handling) and the Ticket's deliveryCharge field is often
  // stale from before the order was switched to pickup. Skip the delivery
  // comparison entirely in that case.
  const isPickup = jsonInvoice.dates && jsonInvoice.dates.isPickup;
  if (!isPickup && !eqNum(a.deliveryCharge, b.deliveryCharge)) {
    pushDiff(out, 'totals', 'fees.deliveryCharge', a.deliveryCharge, b.deliveryCharge);
  }
  if (!eqNum(a.carePlanCharge, b.carePlanCharge)) {
    pushDiff(out, 'totals', 'fees.carePlanCharge', a.carePlanCharge, b.carePlanCharge);
  }
}

function compare(jsonInvoice, mssqlRecord) {
  const out = [];
  if (!mssqlRecord) {
    return { matched: false, reason: 'no-mssql-record', diffs: [], json: jsonInvoice, mssql: null };
  }
  diffDeliveryVia(jsonInvoice, mssqlRecord, out);
  diffFees(jsonInvoice, mssqlRecord, out);
  diffCustomer(jsonInvoice.customer, mssqlRecord.customer, out);
  // pass noTaxSale flag into diffTotals so tax+total checks can be skipped
  diffDates(jsonInvoice.dates, mssqlRecord.dates, out);
  diffTotals(jsonInvoice.totals, mssqlRecord.totals, out, { noTaxSale: jsonInvoice.noTaxSale });
  diffPackages(jsonInvoice.packages, mssqlRecord.packages, out);
  diffItems(jsonInvoice.items, mssqlRecord.items, out);
  return {
    matched: true,
    diffs: out,
    json: jsonInvoice,
    mssql: mssqlRecord,
  };
}

module.exports = { compare };
