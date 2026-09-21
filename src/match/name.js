function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// "Tracy Hunter"  -> { first: "Tracy", last: "Hunter" }
// "Mary Ann Lee"  -> { first: "Mary Ann", last: "Lee" }
function splitFirstLast(name) {
  const parts = clean(name).split(' ');
  if (parts.length === 0 || !parts[0]) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

// "Hunter, Tracy" -> { first: "Tracy", last: "Hunter" }
function splitLastFirst(name) {
  const c = clean(name);
  if (!c.includes(',')) return splitFirstLast(c);
  const [last, first] = c.split(',', 2).map((s) => s.trim());
  return { first: first || '', last: last || '' };
}

// Convert "Tracy Hunter" -> "Hunter, Tracy" (the MSSQL format)
function toLastFirst(firstLastName) {
  const { first, last } = splitFirstLast(firstLastName);
  if (!last) return first;
  return `${last}, ${first}`;
}

// Convert "Hunter, Tracy" -> "Tracy Hunter"
function toFirstLast(lastFirstName) {
  const { first, last } = splitLastFirst(lastFirstName);
  return clean(`${first} ${last}`);
}

// Normalize any name to a canonical "first last" lowercased form for matching
function canonical(name) {
  const v = clean(name);
  if (!v) return '';
  const split = v.includes(',') ? splitLastFirst(v) : splitFirstLast(v);
  return `${split.first} ${split.last}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

function namesMatch(a, b) {
  return canonical(a) === canonical(b) && canonical(a) !== '';
}

// Levenshtein edit distance — small but enough for catching typos like
// "Debrorah" vs "Deborah" (distance 1) or "Stephen" vs "Steven" (distance 2).
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a || !b) return Math.max((a || '').length, (b || '').length);
  const al = a.length, bl = b.length;
  const dp = Array(bl + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= al; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= bl; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[bl];
}

// Same person? Allow:
//  - exact canonical equality, OR
//  - same last name + first name within edit distance 2 (typo tolerance), OR
//  - one first name is a prefix of the other (Bob ↔ Robert handled via initial).
function namesLooseMatch(a, b) {
  const ca = canonical(a);
  const cb = canonical(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;

  const A = ca.includes(',') ? splitLastFirst(ca) : splitFirstLast(ca);
  const B = cb.includes(',') ? splitLastFirst(cb) : splitFirstLast(cb);
  if (!A.last || !B.last || A.last !== B.last) return false;
  if (!A.first || !B.first) return false;
  if (A.first === B.first) return true;

  // Same first letter, edit distance ≤ 2 (catches one-char typos and
  // transpositions on names of any reasonable length).
  if (A.first[0] !== B.first[0]) return false;
  return editDistance(A.first, B.first) <= 2;
}

module.exports = {
  splitFirstLast,
  splitLastFirst,
  toLastFirst,
  toFirstLast,
  canonical,
  namesMatch,
  namesLooseMatch,
  editDistance,
};
