// The SALES EDIT report prints human labels where the salesopendaily table
// stored short codes ("PAID IN FULL" for Terms=PIF, "Delivery Van #1" for
// DeliveryVia=D). Map them back so the diff keeps comparing like for like.
//
// Both maps can be extended from .env without touching this file:
//   RV_TERMS_MAP={"BANK DRAFT":"BD"}
//   RV_DELIVERY_VIA_MAP={"WILL CALL":"P"}

function loadOverrides(envKey) {
  const raw = process.env[envKey];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const out = {};
    for (const [k, v] of Object.entries(parsed)) out[normalize(k)] = String(v).toUpperCase();
    return out;
  } catch (e) {
    console.warn(`${envKey} is not valid JSON — ignoring it (${e.message})`);
    return {};
  }
}

function normalize(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9#]+/g, ' ').trim();
}

const TERMS = {
  'PAID IN FULL': 'PIF',
  'PIF': 'PIF',
  'C O D': 'COD',
  'COD': 'COD',
  'CASH ON DELIVERY': 'COD',
  'COLLECT ON DELIVERY': 'COD',
  'BALANCE ON DELIVERY': 'COD',
  'FINANCE': 'FIN',
  'FINANCED': 'FIN',
  'FINANCING': 'FIN',
  'FIN': 'FIN',
  // GE is the finance house code; the diff treats GE and FIN as equivalent.
  'GE FINANCE': 'GE',
  'GE': 'GE',
};

const DELIVERY_VIA = {
  'CUSTOMER PICKUP': 'P',
  'WILL CALL': 'P',
  'PICKUP': 'P',
};

let _termsOverrides = null;
let _viaOverrides = null;

function termsCodeFor(label) {
  if (_termsOverrides === null) _termsOverrides = loadOverrides('RV_TERMS_MAP');
  const key = normalize(label);
  if (!key) return '';
  const mapped = _termsOverrides[key] || TERMS[key];
  if (mapped) return mapped;
  // Any other finance house ("WELLS FARGO FINANCE", "IN HOUSE FINANCE") is
  // still a financed sale, which the Ticket records as FIN.
  if (/\bFINANC(E|ED|ING)\b/.test(key)) return 'FIN';
  // Otherwise pass the label through; the audit shows it as-is rather than
  // inventing a code, and the mismatch makes the gap visible.
  return key;
}

// "Delivery Van #1" -> D, "Delivery Van #2" -> D2, "Delivery Van #5" -> D5.
// RV numbers its delivery routes the same way it codes them, with route 1
// carrying the bare "D". Anything that reads as a pickup collapses to "P".
function deliveryViaCodeFor(label) {
  if (_viaOverrides === null) _viaOverrides = loadOverrides('RV_DELIVERY_VIA_MAP');
  const key = normalize(label);
  if (!key) return '';
  if (_viaOverrides[key]) return _viaOverrides[key];
  if (DELIVERY_VIA[key]) return DELIVERY_VIA[key];
  if (/\bPICK ?UP\b|\bWILL CALL\b/.test(key)) return 'P';
  // The route number can carry a qualifier after it, as in
  // "Delivery Van #5 OUTSIDE", so don't require it at the end of the label.
  const van = key.match(/\bDELIVERY\b.*?#\s*(\d+)/);
  if (van) return van[1] === '1' ? 'D' : `D${van[1]}`;
  // Already a code (the report is configured to print the raw value).
  if (/^[A-Z]\d?$/.test(key)) return key;
  return key;
}

// Exposed so callers can tell a confident mapping from a pass-through.
function isKnownDeliveryViaLabel(label) {
  const key = normalize(label);
  if (!key) return false;
  if (_viaOverrides === null) _viaOverrides = loadOverrides('RV_DELIVERY_VIA_MAP');
  if (_viaOverrides[key] || DELIVERY_VIA[key]) return true;
  return /\bPICK ?UP\b|\bWILL CALL\b/.test(key) || /\bDELIVERY\b.*?#\s*\d+/.test(key);
}

module.exports = { termsCodeFor, deliveryViaCodeFor, isKnownDeliveryViaLabel };
