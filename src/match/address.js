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

function canonicalAddress(input) {
  if (!input) return '';
  let s = String(input).toLowerCase();
  // strip punctuation except the # used in unit numbers
  s = s.replace(/[.,]/g, ' ');
  s = s.replace(/#/g, ' # ');
  s = s.replace(/\s+/g, ' ').trim();

  const tokens = s.split(' ').map((tok) => {
    if (STREET_TYPES[tok]) return STREET_TYPES[tok];
    if (DIRECTIONALS[tok]) return DIRECTIONALS[tok];
    if (UNIT_TYPES[tok]) return UNIT_TYPES[tok];
    return tok;
  });
  return tokens.join(' ');
}

function addressEqual(a, b) {
  return canonicalAddress(a) === canonicalAddress(b);
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
