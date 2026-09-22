// Normalize MSSQL rows (header from salesopendaily + line items from
// Sale_DetailRV) into the same flat shape produced by fromJson.

const { toNumber, toStr, normalizeDate, normalizePhone } = require('./fromJson');
const { toFirstLast } = require('../match/name');

// Header columns (salesopendaily + CustMaster fields grafted onto the same
// row by the audit endpoint). Each value is a list of candidates; the first
// non-empty match wins so it survives a rename.
const FIELD_MAP = {
  salesNo:    ['SalesNo'],
  name:       ['CustomerName'],
  cell:       ['cust_phone_no', 'CustomerPhone'],
  home:       ['cust_phone_no_2'],
  email:      ['cust_email'],

  // billing (sourced from CustMaster)
  billAddress:  ['cust_st_1'],
  billAddress2: ['cust_st_2'],
  billCity:     ['cust_city'],
  billState:    ['cust_state'],
  billZip:      ['cust_zip_cod'],

  // delivery (sourced from salesopendaily)
  deliveryName:    ['DeliveryName'],
  deliveryAddress: ['DeliveryAddr1'],
  deliveryAddress2:['DeliveryAddr2'],
  deliveryCity:    ['DeliveryCity'],
  deliveryState:   ['DeliveryState'],
  deliveryZip:     ['DeliveryZip'],

  // legacy fallback fields (kept for back-compat in places not yet migrated)
  address:    ['cust_st_1', 'DeliveryAddr1'],
  address2:   ['cust_st_2', 'DeliveryAddr2'],
  city:       ['cust_city', 'DeliveryCity'],
  state:      ['cust_state', 'DeliveryState'],
  zip:        ['cust_zip_cod', 'DeliveryZip'],
  orderDate:    ['SaleDate'],
  deliveryDate: ['DeliveryDate'],
  pickupDate:   [],
  subtotal:   ['SaleAmt'],
  tax:        ['SaleTaxAmt'],
  total:      ['SaleTotalAmt'],
  amountPaid: ['DownPmt'],
  balanceDue: ['BalanceDue'],
  terms:      ['Terms'],
};

function pick(row, candidates) {
  if (!row || !candidates) return undefined;
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  const lower = {};
  for (const k of Object.keys(row)) lower[k.toLowerCase()] = row[k];
  for (const key of candidates) {
    const v = lower[key.toLowerCase()];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function trimAll(s) {
  return toStr(s).replace(/\s+/g, ' ').trim();
}

// Parse a Sale_DetailRV.sale_desc string like
//   "BEST 1AW47 GC 25612 LAPIS"
// into { ven, sku, grade, cover }.
//
// Heuristic: vendor is the first token, SKU is the second, what comes next
// is grade (one or two letters); the rest is the cover (code + name).
function parseSaleDesc(saleDesc) {
  const cleaned = trimAll(saleDesc);
  if (!cleaned) return { ven: '', sku: '', grade: '', cover: '' };

  const tokens = cleaned.split(' ');
  const ven = tokens[0] || '';
  const sku = tokens[1] || '';

  let grade = '';
  let coverStart = 2;
  // grade is 1-2 alpha characters (e.g. "C", "GC")
  if (tokens[2] && /^[A-Za-z]{1,2}$/.test(tokens[2])) {
    grade = tokens[2];
    coverStart = 3;
  }
  const cover = tokens.slice(coverStart).join(' ');

  return { ven, sku, grade, cover };
}

function stripLeadingZeros(id) {
  const v = String(id || '').trim();
  if (!v) return v;
  return /^\d+$/.test(v) ? (v.replace(/^0+/, '') || '0') : v;
}

function normalizeItem(row) {
  const { ven, sku, grade, cover } = parseSaleDesc(row.sale_desc);
  const desc2 = trimAll(row.sale_desc2);
  const itemId = stripLeadingZeros(trimAll(row.sale_item));

  // For non-* itemIds (numeric stock items), the JSON stores the full product
  // code in `sku` and leaves `cover` empty — e.g. JSON sku="1091 55PH 352 01",
  // cover="". The RV parser splits the same text into sku+cover. Re-join them
  // on the RV side so both displays line up.
  // For *-prefixed itemIds (brand-generic items like *BESTUPH) the JSON keeps
  // sku and cover separate, so leave the parsed split alone.
  const isStarItem = itemId.startsWith('*');
  const finalSku   = isStarItem ? sku : [sku, cover].filter(Boolean).join(' ');
  const finalCover = isStarItem ? cover : '';

  return {
    itemId,
    qty:          toNumber(row.sale_qty),
    ven,
    sku:          finalSku,
    grade,
    cover:        finalCover,
    description:  desc2,
    salePrice:    row.__list_price !== undefined ? toNumber(row.__list_price) : undefined,
    extendedPrice: toNumber(row.sale_price),
    loc:          toStr(row.sale_loc),
    seq:          toNumber(row.sale_seq),
    isTransfer:   !!row.__transfer,
    // Set on lines that RV allocated out of a package roll-up.
    packageKey:   toStr(row.__package_of),
    // From the receipt: the line is ordered but not shipping yet.
    isBackOrdered: !!row.__back_ordered,
  };
}

// Sale_DetailRV mixes real product lines with package roll-ups, delivery
// charges, and care-plan service rows. Those last three correspond to
// JSON-side fields outside `items[]` (deliveryCharge, carePlanCharge,
// packagePrices), so they shouldn't appear in the item-by-item comparison.
//
// Heuristic: vendor PACKAGE = package roll-up; vendor CFC + sku DELIVERY =
// delivery charge; vendor USLD + sku SVC = care plan; itemId starting with
// '*PKG' = package marker. We deliberately keep brand-specific generic SKUs
// (e.g. *BESTUPH) since those ARE product lines.
function isNonProductRow(item) {
  if (!item) return false;
  const ven = String(item.ven || '').toUpperCase();
  const sku = String(item.sku || '').toUpperCase();
  const id  = String(item.itemId || '').toUpperCase();
  if (ven === 'PACKAGE') return true;
  if (id.startsWith('*PKG')) return true;
  // Delivery / setup / handling fees logged under CFC. Match the keyword
  // anywhere in the combined sku, e.g. "OUTSIDE DELIVERY AND SETUP".
  if (ven === 'CFC'  && /\b(DELIVERY|SETUP|SHIP|HANDLING|FREIGHT)\b/.test(sku)) return true;
  // Service / care plan logged under USLD.
  if (ven === 'USLD' && /\b(SVC|CARE|WARRANTY)\b/.test(sku)) return true;
  return false;
}

// Classify what kind of fee a non-product row represents so we can carry its
// price into the Fees block for side-by-side comparison.
function feeTypeOf(item) {
  if (!item) return null;
  const ven = String(item.ven || '').toUpperCase();
  const sku = String(item.sku || '').toUpperCase();
  if (ven === 'CFC'  && /\b(DELIVERY|SETUP|SHIP|HANDLING|FREIGHT)\b/.test(sku)) return 'delivery';
  if (ven === 'USLD' && /\b(SVC|CARE|WARRANTY)\b/.test(sku)) return 'carePlan';
  return null;
}

function normalizeMssqlRows(headerRows, itemRows = []) {
  if (!Array.isArray(headerRows) || headerRows.length === 0) return null;

  const head = headerRows[0];
  const rawName = trimAll(pick(head, FIELD_MAP.name));

  return {
    salesNo: trimAll(pick(head, FIELD_MAP.salesNo)),
    deliveryVia: trimAll(head.DeliveryVia),
    notes: trimAll(head.SaleRemarks),
    customer: {
      name:     toFirstLast(rawName),
      cell:     normalizePhone(pick(head, FIELD_MAP.cell)),
      home:     normalizePhone(pick(head, FIELD_MAP.home)) || normalizePhone(pick(head, FIELD_MAP.cell)),
      email:    trimAll(pick(head, FIELD_MAP.email)).toLowerCase(),
      billing: {
        address:  trimAll(pick(head, FIELD_MAP.billAddress)),
        address2: trimAll(pick(head, FIELD_MAP.billAddress2)),
        city:     trimAll(pick(head, FIELD_MAP.billCity)),
        state:    trimAll(pick(head, FIELD_MAP.billState)),
        zip:      trimAll(pick(head, FIELD_MAP.billZip)),
      },
      delivery: {
        name:     toFirstLast(trimAll(pick(head, FIELD_MAP.deliveryName))),
        address:  trimAll(pick(head, FIELD_MAP.deliveryAddress)),
        address2: trimAll(pick(head, FIELD_MAP.deliveryAddress2)),
        city:     trimAll(pick(head, FIELD_MAP.deliveryCity)),
        state:    trimAll(pick(head, FIELD_MAP.deliveryState)),
        zip:      trimAll(pick(head, FIELD_MAP.deliveryZip)),
      },
      // legacy flat fields (kept for back-compat)
      address:  trimAll(pick(head, FIELD_MAP.address)),
      address2: trimAll(pick(head, FIELD_MAP.address2)),
      city:     trimAll(pick(head, FIELD_MAP.city)),
      state:    trimAll(pick(head, FIELD_MAP.state)),
      zip:      trimAll(pick(head, FIELD_MAP.zip)),
    },
    dates: (() => {
      const rawDelivery = pick(head, FIELD_MAP.deliveryDate);
      // RV stores either a date or the literal string "ASAP" (pickup orders).
      const isAsap = String(rawDelivery || '').trim().toUpperCase() === 'ASAP';
      const delivery = isAsap ? 'ASAP' : normalizeDate(rawDelivery);
      return {
        order:    normalizeDate(pick(head, FIELD_MAP.orderDate)),
        delivery,
        pickup:   '',
        deliveryOption: '',
        effective: delivery,
        isPickup: isAsap,
      };
    })(),
    totals: {
      subtotal:   toNumber(pick(head, FIELD_MAP.subtotal)),
      tax:        toNumber(pick(head, FIELD_MAP.tax)),
      total:      toNumber(pick(head, FIELD_MAP.total)),
      amountPaid: toNumber(pick(head, FIELD_MAP.amountPaid)),
      balanceDue: toNumber(pick(head, FIELD_MAP.balanceDue)),
      terms:      trimAll(pick(head, FIELD_MAP.terms)),
    },
    items: (() => {
      const all = (itemRows || []).map(normalizeItem).filter((it) => !isNonProductRow(it));
      // RV stores qty>1 as multiple rows of qty=1 for the SAME numeric item.
      // For generic *-prefix items (e.g. *SIGNCASE, *JACKUPH) each row is a
      // DIFFERENT product variant sharing the same itemId — never merge them.
      // For numeric ids, aggregate to recover the single-line Ticket shape.
      const groups = new Map();
      let starCounter = 0;
      for (const it of all) {
        const id  = stripLeadingZeros(it.itemId).toLowerCase();
        const isStar = id.startsWith('*');
        let key;
        if (!id) {
          key = String(it.sku || '').toLowerCase() || `__row_${starCounter++}`;
        } else if (isStar) {
          key = `__star_${id}_${starCounter++}`;     // unique per row, never merged
        } else {
          key = id;                                   // numeric — merge duplicates
        }
        if (!groups.has(key)) {
          groups.set(key, { ...it });
        } else {
          const g = groups.get(key);
          g.qty = (Number(g.qty) || 0) + (Number(it.qty) || 0);
          g.extendedPrice = (Number(g.extendedPrice) || 0) + (Number(it.extendedPrice) || 0);
          if (it.isTransfer) g.isTransfer = true;   // any source row transfer → group is transfer
          if (it.isBackOrdered) g.isBackOrdered = true;
          if (!g.packageKey && it.packageKey) g.packageKey = it.packageKey;
        }
      }
      return [...groups.values()];
    })(),
    // Package roll-ups. These are kept out of `items` (their revenue is
    // already on the component lines) but the price still has to be audited,
    // so they surface here the same way the Ticket's own packages do.
    packages: (() => {
      return (itemRows || [])
        .filter((r) => r.__is_package)
        .map((r) => {
          const it = normalizeItem(r);
          return {
            key:     toStr(r.sale_item),
            label:   [it.ven, it.sku, it.cover].filter(Boolean).join(' ') || toStr(r.sale_item),
            price:   toNumber(r.sale_price),
            itemIds: (r.__member_item_ids || []).map((id) => stripLeadingZeros(trimAll(id))),
            description: it.description,
          };
        });
    })(),
    fees: (() => {
      const totals = { deliveryCharge: 0, carePlanCharge: 0 };
      for (const r of (itemRows || [])) {
        const it = normalizeItem(r);
        const kind = feeTypeOf(it);
        if (kind === 'delivery')  totals.deliveryCharge  += Number(it.extendedPrice) || 0;
        if (kind === 'carePlan')  totals.carePlanCharge += Number(it.extendedPrice) || 0;
      }
      return totals;
    })(),
    _raw: head,
  };
}

module.exports = { normalizeMssqlRows, parseSaleDesc, FIELD_MAP, pick };
