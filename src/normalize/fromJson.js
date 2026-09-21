// Normalize an invoices-archive record (form_json based) into a flat shape
// the comparison engine can consume.

function toNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function toStr(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

// "05-15-2026" or "2026-05-15T00:00:00.000Z" -> "2026-05-15"
function normalizeDate(s) {
  if (!s) return '';
  const str = String(s).trim();
  let m = str.match(/^(\d{2})-(\d{2})-(\d{4})$/);          // MM-DD-YYYY
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);                // YYYY-MM-DD[Tdate...]
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);             // MM/DD/YYYY
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return str;
}

function normalizePhone(s) {
  const digits = toStr(s).replace(/\D+/g, '');
  // Treat placeholder values (all zeros, or fewer than 7 digits) as empty so
  // callers can fall back to another phone field.
  if (!digits) return '';
  if (/^0+$/.test(digits)) return '';
  if (digits.length < 7) return '';
  return digits;
}

function normalizeInvoice(rec) {
  const fj = rec.form_json || {};
  const bill = fj.billTo || {};
  const ship = fj.shipTo || {};
  const items = Array.isArray(fj.items) ? fj.items : [];

  // shipTo can be a placeholder ("SAME_AS_BILLING" with empty fields) or a
  // real different address. Use billTo as the delivery fallback when same.
  const sameAsBilling = String(fj.sameAsBilling || '').toLowerCase() === 'yes'
    || String(ship.name1 || '').toUpperCase() === 'SAME_AS_BILLING'
    || !toStr(ship.address_1);
  const delivSrc = sameAsBilling ? bill : ship;

  return {
    id: rec.id,
    slug: rec.slug,
    invoiceType: toStr(rec.invoice_type),
    transactionMode: toStr(rec.transaction_mode),

    customer: {
      name: toStr(bill.name1),
      cell: normalizePhone(bill.cell),
      home: normalizePhone(bill.home) || normalizePhone(bill.cell),
      email: toStr(bill.email || bill.email_1).toLowerCase(),
      billing: {
        address:  toStr(bill.address_1),
        address2: toStr(bill.address_2),
        city:     toStr(bill.city),
        state:    toStr(bill.state),
        zip:      toStr(bill.zip),
      },
      delivery: {
        name:     sameAsBilling ? toStr(bill.name1) : toStr(delivSrc.name1),
        address:  toStr(delivSrc.address_1),
        address2: toStr(delivSrc.address_2),
        city:     toStr(delivSrc.city),
        state:    toStr(delivSrc.state),
        zip:      toStr(delivSrc.zip),
      },
      sameAsBilling,
      // kept for back-compat in places that haven't switched to billing/* yet
      address: toStr(bill.address_1),
      address2: toStr(bill.address_2),
      city: toStr(bill.city),
      state: toStr(bill.state),
      zip: toStr(bill.zip),
    },

    dates: (() => {
      // Scheduled orders sometimes store the chosen date under
      // form_json.delivery.selectedDate (or pickup.selectedDate) rather than
      // the top-level deliveryDate/pickupDate fields.
      const nested = (key) => (fj[key] && typeof fj[key] === 'object') ? normalizeDate(fj[key].selectedDate) : '';
      const deliveryDate = normalizeDate(fj.deliveryDate) || nested('delivery');
      const pickupDate   = normalizeDate(fj.pickupDate)   || nested('pickup');
      const opt          = toStr(fj.deliveryOption).toLowerCase();
      // Both pickup_asap and delivery_asap map to RV's "ASAP" marker.
      const isAsap   = opt === 'pickup_asap' || opt === 'delivery_asap';
      const isPickup = opt.startsWith('pickup');
      const effective = isAsap ? 'ASAP' : (deliveryDate || pickupDate);
      return {
        order: normalizeDate(fj.orderDate),
        delivery: deliveryDate,
        pickup: pickupDate,
        deliveryOption: opt,
        effective,
        isPickup,
        isAsap,
      };
    })(),

    totals: (() => {
      // Paid = sum of cash-equivalent payment methods only. `finance` is a
      // financing commitment (loan approval), not cash received — the RV
      // side won't count it as paid until the lender actually disburses, so
      // we exclude it here too. Falls back to fj.amountPaid when the
      // `payments` sub-object is missing or all-empty.
      const pmts = (fj.payments && typeof fj.payments === 'object') ? fj.payments : null;
      const EXCLUDE = new Set(['finance', 'financing', 'finamount', 'financeamount']);
      let paid;
      if (pmts) {
        // Sum only cash-equivalent methods. Zero is a legitimate result
        // (e.g. finance-only tickets — no cash yet received).
        paid = 0;
        for (const [k, v] of Object.entries(pmts)) {
          if (EXCLUDE.has(String(k).toLowerCase())) continue;
          paid += toNumber(v);
        }
      } else {
        paid = toNumber(fj.amountPaid);
      }
      const total = toNumber(fj.total);
      // Balance = total - paid so it stays consistent with our (finance-excluded)
      // paid figure. Falls back to fj.balanceDue when we couldn't compute paid.
      const balance = pmts ? Math.round((total - paid) * 100) / 100 : toNumber(fj.balanceDue);
      return {
        subtotal: toNumber(fj.subtotal),
        tax: toNumber(fj.tax),
        total,
        amountPaid: paid,
        balanceDue: balance,
        terms: toStr(fj.terms),
      };
    })(),

    fees: {
      deliveryCharge: toNumber(fj.deliveryCharge),
      carePlanCharge: toNumber(fj.carePlanCharge),
    },

    notes: [toStr(fj.note), toStr(fj.note1)].filter(Boolean).join('\n').trim(),
    sellerNames: Array.isArray(fj.sellerNames) ? fj.sellerNames.map((s) => ({
      name: toStr(s.name),
      rv_code: toStr(s.rv_code),
      storeCode: toStr(s.storeCode),
    })) : [],

    // "No Sales Tax" / "No Tax Sale" promo flag — when present in any of the
    // free-text fields, RV may still compute tax but it's a known exception.
    // The diff engine skips the tax + total checks for these tickets.
    noTaxSale: (() => {
      const blob = [
        toStr(fj.taxOverrideReason),
        toStr(fj.systemNotes),
        toStr(fj.note),
        toStr(fj.note1),
      ].join(' ');
      return /no\s*sales\s*tax|no\s*tax\s*sale/i.test(blob);
    })(),

    items: (() => {
      const mapped = items.map((it) => ({
        itemId: toStr(it.itemId),
        qty: toNumber(it.qty),
        ven: toStr(it.ven),
        sku: toStr(it.sku),
        grade: toStr(it.gradeOverride || it.grade),
        cover: toStr(it.coverOverride || it.cover),
        description: toStr(it.descriptionOverride || it.description),
        salePrice: toNumber(it.salePrice),
        extendedPrice: toNumber(it.extendedPrice),
        // Members of a package carry its key. Their extendedPrice is 0 —
        // the money sits on the package, not the line (see `packages`).
        packageKey: toStr(it.packageKey),
      }));
      // Mirror the RV-side aggregation: if the same numeric itemId appears
      // on multiple rows (each qty=1), collapse to a single row with summed
      // qty + extendedPrice. Star items (* prefix) are NEVER merged since
      // each row represents a distinct product variant.
      const norm = (s) => String(s || '').trim().toLowerCase();
      const stripZ = (s) => { const v = norm(s); return /^\d+$/.test(v) ? (v.replace(/^0+/, '') || '0') : v; };
      const groups = new Map();
      let starCounter = 0;
      for (const it of mapped) {
        const id = stripZ(it.itemId);
        const isStar = id.startsWith('*');
        let key;
        if (!id) {
          key = norm(it.sku) || `__row_${starCounter++}`;
        } else if (isStar) {
          key = `__star_${id}_${starCounter++}`;
        } else {
          key = id;
        }
        if (!groups.has(key)) {
          groups.set(key, { ...it });
        } else {
          const g = groups.get(key);
          g.qty = (Number(g.qty) || 0) + (Number(it.qty) || 0);
          g.extendedPrice = (Number(g.extendedPrice) || 0) + (Number(it.extendedPrice) || 0);
          if (!g.packageKey && it.packageKey) g.packageKey = it.packageKey;
        }
      }
      return [...groups.values()];
    })(),

    // Packages. The Ticket prices a package as a whole and leaves every
    // member line at 0, so without this the package price is invisible to
    // the audit even though RV prints it as its own roll-up row.
    packages: (() => {
      const summary = fj.packageSummary || {};
      const out = [];
      for (const [key, info] of Object.entries(summary)) {
        if (!info || info.applied === false) continue;
        const price = toNumber(info.packagePrice);
        const members = items.filter((it) => toStr(it.packageKey) === key);
        if (!price && !members.length) continue;
        out.push({
          key,
          label: toStr(info.label) || key,
          price,
          listTotal: toNumber(info.computedTotal),
          savings: toNumber(info.savings),
          itemIds: members.map((it) => toStr(it.itemId)).filter(Boolean),
        });
      }
      return out;
    })(),
  };
}

module.exports = { normalizeInvoice, toNumber, toStr, normalizeDate, normalizePhone };
