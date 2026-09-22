// Parse an RV "SALES EDIT LIST — DETAIL" PDF into the same raw row shapes the
// MSSQL source used to return, so the rest of the pipeline (the fromMssql
// normalizer, the diff, the RV viewer modal) keeps working unchanged.
//
// The report is a fixed-column terminal dump. Every field is located by the
// x coordinate of the column header above it rather than by counting spaces,
// so a change in page margins or font metrics doesn't break the read.

const { cellsBetween, textBetween } = require('./pdfLayout');
const { termsCodeFor, deliveryViaCodeFor } = require('../match/rvCodes');

const NUMBER_RE = /^-?[\d,]+(?:\.\d+)?$/;
const UOM_RE    = /^(EA|EACH|PR|SET|PC|PCS)$/i;
const CSZ_RE    = /^(.+?),\s*([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)$/;

function num(s) {
  if (s === null || s === undefined || s === '') return 0;
  const n = Number(String(s).replace(/[$,%]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function isNumeric(s) {
  return NUMBER_RE.test(String(s || '').trim());
}

function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Label readers
//
// A report line like
//   SALE TYPE: REGULAR      TERMS: PAID IN FULL      DOWN PMT: 1,550.43
// holds several label/value pairs. Split on the labels themselves: a value
// runs from the end of its label to the start of the next label on the line.

function readLabels(line, labels) {
  const tokens = line.cells.map((c) => c.str);
  const upper = tokens.map((t) => t.toUpperCase());
  const hits = [];

  for (const label of labels) {
    const want = label.toUpperCase().split(/\s+/);
    for (let i = 0; i + want.length <= upper.length; i++) {
      let ok = true;
      for (let k = 0; k < want.length; k++) {
        if (upper[i + k] !== want[k]) { ok = false; break; }
      }
      if (ok) { hits.push({ label, start: i, end: i + want.length }); break; }
    }
  }

  hits.sort((a, b) => a.start - b.start);
  const out = {};
  for (let i = 0; i < hits.length; i++) {
    const stop = i + 1 < hits.length ? hits[i + 1].start : tokens.length;
    out[hits[i].label] = clean(tokens.slice(hits[i].end, stop).join(' '));
  }
  return out;
}

// Read a money figure to the right of `label` on this line.
//
// The totals block prints the same figure three times, under THIS DELIVERY /
// ORIG-ORDER / REMAINING. They only differ when part of the sale is back
// ordered: THIS DELIVERY then covers just what is shipping now, while
// ORIG-ORDER is the whole sale. The Ticket always describes the whole sale,
// so `anchorX` points at the ORIG-ORDER column and the figure nearest it
// wins. Without an anchor (an older layout with one column) take the first.
function numberAfterLabel(line, label, anchorX = null) {
  const want = label.toUpperCase().split(/\s+/);
  const cells = line.cells;
  const upper = cells.map((c) => c.str.toUpperCase());
  for (let i = 0; i + want.length <= upper.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) {
      if (upper[i + k] !== want[k]) { ok = false; break; }
    }
    if (!ok) continue;

    const after = cells.slice(i + want.length).filter((c) => isNumeric(c.str));
    if (!after.length) return null;
    if (anchorX == null) return num(after[0].str);

    let best = after[0];
    let bestDist = Math.abs(after[0].x - anchorX);
    for (const cell of after.slice(1)) {
      const d = Math.abs(cell.x - anchorX);
      if (d < bestDist) { bestDist = d; best = cell; }
    }
    return num(best.str);
  }
  return null;
}

function lineHas(line, phrase) {
  return line.text.toUpperCase().includes(phrase.toUpperCase());
}

// ---------------------------------------------------------------------------
// Column anchors
//
// Read the x of every column header so values can be assigned by position.
// The header spans two printed rows:
//   QTY-ORD QTY-SHP QTY-BO ITEM-ID  BCL ID SLS-ACCT  PRNT ON PRICE  OVR DISC  EXTENDED EXTENDED UNIT  GROSS
//   LOCATION        DESCRIPTION              PIK RCP CODE     PCT   TO-SHIP  ORDERED  COST  MARGIN

function readAnchors(topLine, bottomLine) {
  const at = (line, label) => {
    const want = label.toUpperCase();
    const cell = line.cells.find((c) => c.str.toUpperCase() === want);
    return cell ? cell.x : null;
  };
  const anchors = {
    qtyOrd:   at(topLine, 'QTY-ORD'),
    qtyShp:   at(topLine, 'QTY-SHP'),
    qtyBo:    at(topLine, 'QTY-BO'),
    itemId:   at(topLine, 'ITEM-ID'),
    bcl:      at(topLine, 'BCL'),
    slsAcct:  at(topLine, 'SLS-ACCT'),
    prnt:     at(topLine, 'PRNT'),
    price:    at(topLine, 'PRICE'),
    ovr:      at(topLine, 'OVR'),
    loc:      at(bottomLine, 'LOCATION'),
    desc:     at(bottomLine, 'DESCRIPTION'),
    disc:     at(bottomLine, 'PCT'),
    extShip:  at(bottomLine, 'TO-SHIP'),
    extOrd:   at(bottomLine, 'ORDERED'),
    unitCost: at(bottomLine, 'COST'),
    margin:   at(bottomLine, 'MARGIN'),
  };
  // DESCRIPTION sits directly under ITEM-ID; either one can stand in.
  if (anchors.desc == null) anchors.desc = anchors.itemId;
  if (anchors.itemId == null) anchors.itemId = anchors.desc;
  return anchors;
}

// Assign each cell to the column header nearest its left edge. The money
// columns are >25pt apart, so nearest-anchor is unambiguous.
function assignByAnchor(cells, anchors) {
  const names = Object.keys(anchors).filter((k) => anchors[k] != null);
  const out = {};
  for (const cell of cells) {
    let best = null;
    let bestDist = Infinity;
    for (const name of names) {
      const d = Math.abs(cell.x - anchors[name]);
      if (d < bestDist) { bestDist = d; best = name; }
    }
    if (best && out[best] === undefined) out[best] = cell.str;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Customer block
//
// SALES-NO: 1309040 CUS-ID: 239300   Lanning, Charles       SHIP TO: Lanning, Charles
// PROFIT-CENTER: 001                 189 Bolton Court                189 Bolton Court
//        Cell: (828) 388-0535        Hendersonville, NC 28792        Hendersonville, NC 28792
//                                    truckin3988@gmail.com
//
// Three columns: sale identifiers on the left, bill-to in the middle,
// ship-to on the right. The middle column starts at the customer name and the
// right column starts just after the "SHIP TO:" label.

function readAddressColumn(parts) {
  const out = { name: '', address: '', address2: '', city: '', state: '', zip: '', email: '' };
  const rest = [];
  parts.forEach((raw, i) => {
    const value = clean(raw);
    if (!value) return;
    if (i === 0) { out.name = value; return; }
    if (value.includes('@')) { out.email = value.toLowerCase(); return; }
    const csz = value.match(CSZ_RE);
    if (csz) {
      out.city = clean(csz[1]);
      out.state = csz[2].toUpperCase();
      out.zip = csz[3];
      return;
    }
    rest.push(value);
  });
  out.address = rest[0] || '';
  out.address2 = rest.slice(1).join(' ');
  return out;
}

function parseCustomerBlock(lines, startIdx, endIdx) {
  const head = lines[startIdx];

  // Column boundaries. The bill-to column starts at the customer name, which
  // is the first cell after the CUS-ID value. The ship-to column starts at
  // the "SHIP TO:" label — only the first row carries that label, so it gets
  // stripped from the value below.
  const shipIdx = head.cells.findIndex((c) => c.str.toUpperCase() === 'SHIP');
  const xShip = shipIdx >= 0 ? head.cells[shipIdx].x : Infinity;
  const cusIdx = head.cells.findIndex((c) => c.str.toUpperCase() === 'CUS-ID:');
  const xBill = cusIdx >= 0 && head.cells[cusIdx + 2] ? head.cells[cusIdx + 2].x : 0;

  // Read the identifiers from the left column only, so the bill-to name
  // can't be swallowed as part of the CUS-ID value.
  const ids = readLabels({ cells: head.cells.filter((c) => c.x < xBill - 0.5) },
    ['SALES-NO:', 'CUS-ID:']);

  const billParts = [];
  const shipParts = [];

  let profitCenter = '';
  let cell = '';
  let home = '';
  let other = '';

  for (let i = startIdx; i < endIdx; i++) {
    const line = lines[i];
    billParts.push(textBetween(line, xBill, xShip));
    shipParts.push(xShip === Infinity
      ? ''
      : textBetween(line, xShip, Infinity).replace(/^SHIP\s+TO:\s*/i, ''));

    // Left column: PROFIT-CENTER and the phone numbers.
    const leftCells = line.cells.filter((c) => c.x < xBill - 0.5);
    const got = readLabels({ cells: leftCells },
      ['PROFIT-CENTER:', 'CELL:', 'HOME:', 'OTHER:', 'WORK:']);
    if (got['PROFIT-CENTER:'] && !profitCenter) profitCenter = got['PROFIT-CENTER:'];
    if (got['CELL:']  && !cell)  cell  = got['CELL:'];
    if (got['HOME:']  && !home)  home  = got['HOME:'];
    if (got['OTHER:'] && !other) other = got['OTHER:'];
    if (got['WORK:']  && !other) other = got['WORK:'];
  }

  const billing = readAddressColumn(billParts);
  const shipping = readAddressColumn(shipParts);

  return {
    salesNo: clean(ids['SALES-NO:']),
    customerId: clean(ids['CUS-ID:']),
    profitCenter,
    phones: { cell, home, other },
    billing,
    shipping: shipping.name ? shipping : { ...billing },
  };
}

// ---------------------------------------------------------------------------
// Line items
//
// One item prints as a small block:
//                 1235019      77826 2000     Y  Y          <- ids + flags
//   1   1   SIGN 3130438 OLTEN MOCHA  650.00 EA Y 0.00 ...   <- qty/desc/money
//   001 R4E00  T  SOFA                          MTO:         <- location/desc2
//                 COMMISSION CODE: SP  ...                   <- ignored

function parseItems(lines, from, to, anchors) {
  const items = [];
  const xDesc = anchors.desc;
  const xLoc = anchors.loc != null ? anchors.loc : 0;
  const xQty = anchors.qtyOrd != null ? anchors.qtyOrd : 0;
  // Right edge of the description column. Continuation rows are read only up
  // to here, so stray figures printed in the money columns (a package's
  // commission amount, for one) never land in the description.
  const xDescEnd = anchors.prnt != null ? anchors.prnt : (anchors.price != null ? anchors.price : Infinity);

  const hasLeftOfDesc = (line) => line.cells.some((c) => c.x < xDesc - 0.5);
  const isIdLine = (line, next) => {
    if (hasLeftOfDesc(line)) return false;
    const first = line.cells[0];
    if (!first || Math.abs(first.x - xDesc) > 1.5) return false;
    if (!/^\*?[A-Za-z0-9][A-Za-z0-9*.\-/]*$/.test(first.str)) return false;
    if (/^COMMISSION$/i.test(first.str)) return false;
    // The row underneath an id row always carries the quantity columns.
    return Boolean(next) && hasLeftOfDesc(next);
  };

  const blocks = [];
  for (let i = from; i < to; i++) {
    if (isIdLine(lines[i], lines[i + 1])) blocks.push({ start: i, end: to });
  }
  for (let b = 0; b < blocks.length - 1; b++) blocks[b].end = blocks[b + 1].start;

  blocks.forEach((block, index) => {
    const idLine = lines[block.start];
    const itemId = idLine.cells[0] ? idLine.cells[0].str : '';
    const xBclEnd = anchors.slsAcct != null ? anchors.slsAcct - 5 : (anchors.bcl != null ? anchors.bcl + 40 : 0);
    const labelId = anchors.bcl != null ? textBetween(idLine, anchors.bcl - 8, xBclEnd) : '';
    const slsAcct = anchors.slsAcct != null
      ? textBetween(idLine, anchors.slsAcct - 5, anchors.prnt != null ? anchors.prnt - 5 : Infinity)
      : '';

    const item = {
      sale_seq: index + 1,
      sale_item: clean(itemId),
      sale_qty: 0,
      sale_desc: '',
      sale_desc2: '',
      sale_price: 0,
      sale_unit_cost: 0,
      sale_loc: '',
      __label_id: clean(labelId),
      __sls_acct: clean(slsAcct),
      __unit_price: 0,
      __price_overridden: false,
      __gross_margin_pct: 0,
      __transfer: false,
      __is_package: false,
    };

    const desc2Parts = [];
    let mainDone = false;

    for (let i = block.start + 1; i < block.end; i++) {
      const line = lines[i];
      if (!line.cells.length) continue;
      if (lineHas(line, 'COMMISSION CODE:')) continue;

      const first = line.cells[0];

      // The quantity/description/money row.
      if (!mainDone && first.x < xDesc - 0.5 && first.x >= xQty - 12) {
        readMainLine(line, item, anchors);
        mainDone = true;
        continue;
      }

      // Location row: "001 R4E00 T   SOFA   MTO:"
      if (first.x <= xLoc + 2 && hasLeftOfDesc(line)) {
        const tokens = textBetween(line, -Infinity, xDesc).split(/\s+/).filter(Boolean);
        // A bare "T" in the location block marks a transfer (move-to-order).
        if (tokens.includes('T')) item.__transfer = true;
        item.sale_loc = tokens[0] || '';
        item.__loc_detail = tokens.join(' ');
        if (/\bMTO:\s*\S/i.test(textBetween(line, xDesc, Infinity))) item.__transfer = true;
        const tail = textBetween(line, xDesc, xDescEnd).replace(/\bMTO:.*$/i, '').trim();
        if (tail) desc2Parts.push(tail);
        continue;
      }

      // Continuation rows in the description column.
      const tail = textBetween(line, xDesc, xDescEnd).replace(/\bMTO:.*$/i, '').trim();
      if (tail) desc2Parts.push(tail);
    }

    item.sale_desc2 = clean(desc2Parts.join(' '));
    items.push(item);
  });

  return items;
}

// "1   1   SIGN 3130438 OLTEN MOCHA   650.00 EA Y 0.00  650.00  650.00  269.675 58.5"
function readMainLine(line, item, anchors) {
  const xDesc = anchors.desc;
  const qtyCells = line.cells.filter((c) => c.x < xDesc - 0.5);
  const rest = line.cells.filter((c) => c.x >= xDesc - 0.5);

  // QTY-ORD / QTY-SHP / QTY-BO — or the literal "PACKAGE" in the QTY-SHP
  // column, which marks the roll-up row of a package.
  const qtyNums = qtyCells.filter((c) => isNumeric(c.str)).map((c) => num(c.str));
  if (qtyCells.some((c) => /^PACKAGE$/i.test(c.str))) item.__is_package = true;
  item.sale_qty = qtyNums.length ? qtyNums[0] : 1;

  const uomIdx = rest.findIndex((c) => UOM_RE.test(c.str));
  let descCells;
  let tailCells;
  if (uomIdx >= 0) {
    const before = rest.slice(0, uomIdx);
    tailCells = rest.slice(uomIdx + 1);
    // The last numeric before the unit of measure is the unit price.
    let priceIdx = -1;
    for (let i = before.length - 1; i >= 0; i--) {
      if (isNumeric(before[i].str)) { priceIdx = i; break; }
    }
    if (priceIdx >= 0) {
      item.__unit_price = num(before[priceIdx].str);
      descCells = before.slice(0, priceIdx);
    } else {
      descCells = before;
    }
  } else {
    descCells = rest.filter((c) => !isNumeric(c.str));
    tailCells = rest.filter((c) => isNumeric(c.str));
  }

  item.sale_desc = clean(descCells.map((c) => c.str).join(' '));

  // A "Y" right after the unit of measure is the price-override flag.
  if (tailCells.length && /^[YN]$/i.test(tailCells[0].str)) {
    item.__price_overridden = tailCells[0].str.toUpperCase() === 'Y';
    tailCells = tailCells.slice(1);
  }

  const money = assignByAnchor(
    tailCells.filter((c) => isNumeric(c.str)),
    {
      disc:     anchors.disc,
      extShip:  anchors.extShip,
      extOrd:   anchors.extOrd,
      unitCost: anchors.unitCost,
      margin:   anchors.margin,
    },
  );

  const extShip = money.extShip !== undefined ? num(money.extShip) : null;
  const extOrd  = money.extOrd  !== undefined ? num(money.extOrd)  : null;
  // EXTENDED ORDERED, not TO-SHIP: a back-ordered line ships nothing yet but
  // the Ticket still carries its full price. Same reasoning as the totals.
  item.sale_price         = extOrd !== null ? extOrd : (extShip !== null ? extShip : item.__unit_price * item.sale_qty);
  item.__ext_to_ship      = extShip !== null ? extShip : item.sale_price;
  item.__ext_ordered      = extOrd !== null ? extOrd : item.sale_price;
  item.__discount_pct     = money.disc !== undefined ? num(money.disc) : 0;
  item.sale_unit_cost     = money.unitCost !== undefined ? num(money.unitCost) : 0;
  item.__gross_margin_pct = money.margin !== undefined ? num(money.margin) : 0;
}

// ---------------------------------------------------------------------------

function parseSalesEdit(pages) {
  const lines = [];
  for (const page of pages) {
    for (const line of page.lines) {
      if (line.cells.length) lines.push(line);
    }
  }

  const findIdx = (pred, from = 0) => {
    for (let i = from; i < lines.length; i++) if (pred(lines[i], i)) return i;
    return -1;
  };

  // "SALES-NO:" — not the "SALES-NO RANGE:" filter echo at the top.
  const headIdx = findIdx((l) => /^SALES-NO:\s/.test(l.text.trim()));
  if (headIdx < 0) throw new Error('not a SALES EDIT report — no "SALES-NO:" header found');

  const saleDateIdx = findIdx((l) => /^SALE DATE:/.test(l.text.trim()), headIdx);
  if (saleDateIdx < 0) throw new Error('malformed SALES EDIT report — no "SALE DATE:" line');

  const customer = parseCustomerBlock(lines, headIdx, saleDateIdx);

  const info = {};
  for (let i = saleDateIdx; i < saleDateIdx + 4 && i < lines.length; i++) {
    Object.assign(info, readLabels(lines[i], [
      'SALE DATE:', 'CUST PO NO:', 'APPLY TO:', 'DUE DATE:',
      'SALE TYPE:', 'TERMS:', 'DOWN PMT:', 'MONTHLY PMT:', 'PMTS:',
      'SHIP DATE:', 'DELIVER:', 'TAX CODE:', 'TAX PCT:', 'INS CODE:',
    ]));
  }

  const colTopIdx = findIdx((l) => l.cells.some((c) => c.str.toUpperCase() === 'QTY-ORD'), saleDateIdx);
  if (colTopIdx < 0) throw new Error('malformed SALES EDIT report — no item column header');
  const anchors = readAnchors(lines[colTopIdx], lines[colTopIdx + 1] || lines[colTopIdx]);

  // The totals block opens with its own column header ("THIS DELIVERY
  // ORIG-ORDER REMAINING ...") one row above the "N LINE ITEMS" line; items
  // stop there so that header can't be read as a description continuation.
  const totalsIdx = findIdx((l) => /\bLINE ITEMS\b/i.test(l.text), colTopIdx);
  const totalsHeadIdx = findIdx((l) => /THIS DELIVERY|ORIG-ORDER/i.test(l.text), colTopIdx);
  const ends = [totalsHeadIdx, totalsIdx].filter((i) => i >= 0);
  const itemsEnd = ends.length ? Math.min(...ends) : lines.length;
  const items = parseItems(lines, colTopIdx + 2, itemsEnd, anchors);

  const parsed = parseTotals(lines, itemsEnd, anchors);

  return buildRows({ customer, info, items, pageCount: pages.length, ...parsed });
}

function parseTotals(lines, from, anchors) {
  const totals = {
    saleAmt: null, saleTax: null, cashPrice: null,
    amtRecd: null, downPayment: null, cost: null,
    grossMarginPct: null, lineItemCount: null,
  };
  const remarks = [];
  const cashBreakdown = [];
  let salesperson = '';
  let inRemarks = false;
  let inCash = false;

  const MONEY_LABELS = [
    ['SALE AMT:', 'saleAmt'], ['SALE TAX:', 'saleTax'], ['CASH PRICE:', 'cashPrice'],
    ['AMT RECD:', 'amtRecd'], ['DOWN PAYMENT:', 'downPayment'], ['COST:', 'cost'],
  ];

  // x of the ORIG-ORDER column header, so the whole-sale figures are read
  // rather than the this-delivery ones.
  let origOrderX = null;
  for (let i = from; i < lines.length; i++) {
    const cell = lines[i].cells.find((c) => c.str.toUpperCase() === 'ORIG-ORDER');
    if (cell) { origOrderX = cell.x; break; }
  }

  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    const text = line.text.trim();

    if (/^-+\s*SALES REMARKS\s*-+/i.test(text)) { inRemarks = true; inCash = false; continue; }
    if (/^CASH BREAKDOWN/i.test(text)) { inCash = true; inRemarks = false; continue; }
    // Page breaks repeat the report banner; stop collecting free text there.
    if (/Carolina Furniture Concepts/i.test(text)) { inRemarks = false; inCash = false; continue; }

    if (inRemarks) {
      // The "NOTE: THIS REMARK WILL PRINT ON SALES ONLY" caption is printed
      // to the right of the divider, not part of the remark text.
      const body = text.replace(/\s*NOTE:\s*THIS REMARK.*$/i, '').trim();
      if (body) remarks.push(body);
      continue;
    }
    if (inCash) {
      if (text) cashBreakdown.push(text);
      continue;
    }

    const m = text.match(/^(\d+)\s+LINE ITEMS/i);
    if (m) {
      totals.lineItemCount = Number(m[1]);
      if (anchors.margin != null) {
        const gm = cellsBetween(line, anchors.margin - 20, Infinity).filter((c) => isNumeric(c.str));
        if (gm.length) totals.grossMarginPct = num(gm[gm.length - 1].str);
      }
    }

    if (!salesperson && /SALESPERSON\s+1\b/i.test(text)) {
      const idx = line.cells.findIndex((c) => /^SALESPERSON$/i.test(c.str));
      const code = idx >= 0 ? line.cells[idx + 2] : null;
      if (code && /^[A-Za-z]{2,4}$/.test(code.str)) salesperson = code.str.toUpperCase();
    }

    for (const [label, key] of MONEY_LABELS) {
      if (totals[key] !== null) continue;
      const v = numberAfterLabel(line, label, origOrderX);
      if (v !== null) totals[key] = v;
    }
  }

  return { totals, salesperson, remarks, cashBreakdown };
}

// Work out which lines belong to each package.
//
// The report prints a package as a roll-up row carrying the package price,
// immediately followed by its component lines. RV allocates the package price
// across those components, so the members are exactly the run of following
// rows whose extended prices add up to the roll-up. Walk forward until the
// running total lands on the package price; if it never does (an unexpected
// layout), leave the rows unassigned rather than guessing.
function linkPackageMembers(rows) {
  for (let i = 0; i < rows.length; i++) {
    const pkg = rows[i];
    if (!pkg.__is_package) continue;

    const target = Number(pkg.sale_price) || 0;
    const members = [];
    let sum = 0;
    for (let j = i + 1; j < rows.length && !rows[j].__is_package; j++) {
      sum += Number(rows[j].sale_price) || 0;
      members.push(rows[j]);
      if (Math.abs(sum - target) < 0.01) break;
    }

    if (target > 0 && Math.abs(sum - target) < 0.01) {
      for (const m of members) m.__package_of = pkg.sale_item;
      pkg.__member_item_ids = members.map((m) => m.sale_item);
    } else {
      pkg.__member_item_ids = [];
    }
  }
}

// Shape the parsed report the way the MSSQL source used to: a salesopendaily
// header row, a CustMaster row, and Sale_DetailRV item rows.
function buildRows({ customer, info, items, totals, salesperson, remarks, cashBreakdown, pageCount }) {
  const deliverLabel = clean(info['DELIVER:']);
  const termsLabel   = clean(info['TERMS:']);

  const subtotal = totals.saleAmt != null ? totals.saleAmt : 0;
  const tax      = totals.saleTax != null ? totals.saleTax : 0;
  const total    = totals.cashPrice != null ? totals.cashPrice : subtotal + tax;
  const paid     = totals.amtRecd != null ? totals.amtRecd
                 : (totals.downPayment != null ? totals.downPayment : num(info['DOWN PMT:']));
  const balance  = Math.round((total - paid) * 100) / 100;

  const bill = customer.billing;
  const ship = customer.shipping;
  const via  = deliveryViaCodeFor(deliverLabel);

  // RV records pickup orders with the literal "ASAP" in the delivery-date
  // field; the report prints whatever RV holds, so pass it straight through.
  const shipDate = clean(info['SHIP DATE:']);

  const header = {
    SalesNo:       customer.salesNo,
    CustomerId:    customer.customerId,
    CustomerName:  bill.name,
    CustomerPhone: customer.phones.cell || customer.phones.home,
    Salesperson:   salesperson,

    DeliveryName:  ship.name,
    DeliveryAddr1: ship.address,
    DeliveryAddr2: ship.address2,
    DeliveryCity:  ship.city,
    DeliveryState: ship.state,
    DeliveryZip:   ship.zip,

    SaleDate:     clean(info['SALE DATE:']),
    DeliveryDate: shipDate,
    DeliveryVia:  via,
    Terms:        termsCodeFor(termsLabel),
    SaleRemarks:  remarks.join(' '),

    SaleAmt:      subtotal,
    SaleTaxAmt:   tax,
    SaleTotalAmt: total,
    DownPmt:      paid,
    BalanceDue:   balance,

    // CustMaster fields are grafted onto the header row, exactly as the audit
    // endpoint used to do after its CustMaster lookup.
    cust_email:      bill.email,
    cust_st_1:       bill.address,
    cust_st_2:       bill.address2,
    cust_city:       bill.city,
    cust_state:      bill.state,
    cust_zip_cod:    bill.zip,
    cust_phone_no:   customer.phones.cell || customer.phones.home,
    cust_phone_no_2: customer.phones.home,

    __deliver_label:    deliverLabel,
    __terms_label:      termsLabel,
    __due_date:         clean(info['DUE DATE:']),
    __sale_type:        clean(info['SALE TYPE:']),
    __tax_code:         clean(info['TAX CODE:']),
    __tax_pct:          num(info['TAX PCT:']),
    __cust_po_no:       clean(info['CUST PO NO:']),
    __down_pmt_field:   num(info['DOWN PMT:']),
    __cash_breakdown:   cashBreakdown,
    __total_cost:       totals.cost != null ? totals.cost : 0,
    __gross_margin_pct: totals.grossMarginPct,
    __line_item_count:  totals.lineItemCount,
    __page_count:       pageCount,
  };

  const custMaster = {
    cust_id:         customer.customerId,
    cust_nam:        bill.name,
    cust_st_1:       bill.address,
    cust_st_2:       bill.address2,
    cust_city:       bill.city,
    cust_state:      bill.state,
    cust_zip_cod:    bill.zip,
    cust_phone_no:   customer.phones.cell || customer.phones.home,
    cust_phone_no_2: customer.phones.home,
    cust_email:      bill.email,
  };

  // The package roll-up row repeats the revenue of its component lines, so it
  // is tagged "*PKG…" — the downstream normalizer lifts those out of `items`
  // into their own `packages` list rather than double-counting them.
  const rows = items.map((it) => {
    const row = { ...it, sale_profit_ctr: customer.profitCenter };
    if (it.__is_package) {
      row.__package_item_id = it.sale_item;
      row.sale_item = `*PKG${it.sale_item}`;
    }
    return row;
  });

  linkPackageMembers(rows);

  return { header, custMaster, items: rows, totals };
}

module.exports = { parseSalesEdit };
