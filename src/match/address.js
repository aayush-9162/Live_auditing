// Normalize US-style street addresses for fuzzy equality.
//
// Strategy: lowercase, collapse whitespace, strip punctuation, then map common
// street-type and directional abbreviations to a canonical short form. Both
// sides go through the same pipeline so "5550 Soco Rd" and "5550 Soco Road"
// produce the same canonical string.

const STREET_TYPES = {
  street: 'st',  st: 'st',
  road: 'rd',    rd: 'rd',
  avenue: 'ave', ave: 'ave', av: 'ave',
  boulevard: 'blvd', blvd: 'blvd', boul: 'blvd',
  drive: 'dr',   dr: 'dr',
  lane: 'ln',    ln: 'ln',
  court: 'ct',   ct: 'ct',
  circle: 'cir', cir: 'cir',
  place: 'pl',   pl: 'pl',
  highway: 'hwy', hwy: 'hwy',
  parkway: 'pkwy', pkwy: 'pkwy',
  terrace: 'ter', ter: 'ter',
  trail: 'trl',  trl: 'trl', tr: 'trl',
  way: 'way',
  square: 'sq',  sq: 'sq',
  loop: 'loop',
  cove: 'cv',    cv: 'cv',
  pike: 'pike',
  ridge: 'rdg',  rdg: 'rdg',
  run: 'run',
  path: 'path',
  alley: 'aly',  aly: 'aly',
  plaza: 'plz',  plz: 'plz',
  expressway: 'expy', expy: 'expy',
  bypass: 'byp', byp: 'byp',

  // The rest of the "Common Street Name Sign Abbreviations" sheet the office
  // works from. Rows already covered above (Avenue, Road, Trail = TR, ...) and
  // rows whose short form is the word itself (Alley, Hill, Way) need nothing
  // here. Two short forms follow the sheet rather than the USPS list, where
  // BR is Branch and PT is Point — so "Branch" and "Point" are left alone.
  bridge: 'br',          br: 'br',
  canyon: 'cyn',         cyn: 'cyn',
  center: 'ctr',         ctr: 'ctr',
  crescent: 'cres',      cres: 'cres',
  expwy: 'expy',
  freeway: 'fwy',        fwy: 'fwy',
  information: 'info',   info: 'info',
  international: 'intl', intl: 'intl',
  island: 'isl',         isl: 'isl',
  junction: 'jct',       jct: 'jct',
  lake: 'lk',            lk: 'lk',
  lp: 'loop',
  mount: 'mt',           mt: 'mt',
  mountain: 'mtn',       mtn: 'mtn',
  national: 'natl',      natl: 'natl',
  port: 'pt',            pt: 'pt',
  river: 'r',            r: 'r',
  route: 'rte',          rte: 'rte',
  thruway: 'thwy',       thwy: 'thwy',
  turnpike: 'tpk',       tpk: 'tpk',
  // Not on the sheet, but in use on tickets ("393 Carver Mountain Vly").
  valley: 'vly',         vly: 'vly',
};

const DIRECTIONALS = {
  north: 'n', n: 'n',
  south: 's', s: 's',
  east: 'e',  e: 'e',
  west: 'w',  w: 'w',
  northeast: 'ne', ne: 'ne',
  northwest: 'nw', nw: 'nw',
  southeast: 'se', se: 'se',
  southwest: 'sw', sw: 'sw',
};

const UNIT_TYPES = {
  apartment: 'apt', apt: 'apt',
  suite: 'ste',     ste: 'ste',
  unit: 'unit',
  building: 'bldg', bldg: 'bldg',
  floor: 'fl',      fl: 'fl',
  room: 'rm',       rm: 'rm',
};

function canonicalTokens(input, { directionals = true } = {}) {
  if (!input) return [];
  let s = String(input).toLowerCase();
  // strip punctuation except the # used in unit numbers
  s = s.replace(/[.,]/g, ' ');
  s = s.replace(/#/g, ' # ');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return [];

  return s.split(' ').map((tok) => {
    if (Object.hasOwn(STREET_TYPES, tok)) return STREET_TYPES[tok];
    if (directionals && Object.hasOwn(DIRECTIONALS, tok)) return DIRECTIONALS[tok];
    if (Object.hasOwn(UNIT_TYPES, tok)) return UNIT_TYPES[tok];
    return tok;
  });
}

function canonicalAddress(input) {
  return canonicalTokens(input).join(' ');
}

// Equal once abbreviations are levelled — or differing only in where the
// spaces fall, as in "321 East View Dr" against "321 Eastview Drive". For
// that second test the words are run together, with "East" left spelled out
// so it still lines up with the "east" inside "Eastview".
function addressEqual(a, b) {
  if (canonicalAddress(a) === canonicalAddress(b)) return true;
  const ta = canonicalTokens(a, { directionals: false });
  const tb = canonicalTokens(b, { directionals: false });
  // Only words may run together — "1 2 Oak Rd" is not "12 Oak Rd".
  const numbers = (t) => t.filter((w) => /\d/.test(w)).join(' ');
  return numbers(ta) === numbers(tb) && ta.join('') === tb.join('');
}

// Fuzzy match: same canonical OR one is a prefix/suffix of the other. Useful
// when JSON has "1445 1st Ave Place" and MSSQL has the same plus "Northwest".
function addressLooseMatch(a, b) {
  const ca = canonicalAddress(a);
  const cb = canonicalAddress(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  // require the shorter side's tokens to fully appear at the start of the longer
  const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  return long.startsWith(short + ' ') || long === short;
}

module.exports = { canonicalAddress, addressEqual, addressLooseMatch };
