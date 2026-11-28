// Source B: the RV sale, read from its "SALES EDIT" PDF on Google Drive.
//
// This replaces the old MSSQL salesopendaily/Sale_DetailRV queries. Each sale
// is archived to Drive as "<CUSTOMER NAME> SALES EDIT.pdf" inside a folder
// named "<sale no> <CUSTOMER NAME>" under a single sales-root folder. The
// lookup walks that tree by parent id rather than searching by filename —
// see findViaFolder for why that distinction matters.

const fs = require('fs');
const path = require('path');
const { getDriveClient, streamPdf } = require('./drive');
const { extractLines } = require('../parse/pdfLayout');
const { parseSalesEdit } = require('../parse/salesEdit');
const { parseRvReceipt } = require('../parse/rvReceipt');

const SUFFIX = 'SALES EDIT';
// The customer receipt filed beside every SALES EDIT. It states the whole
// sale's totals unambiguously and marks back-ordered lines, so it is used as
// a second opinion on the figures.
const RECEIPT_SUFFIX = 'RV RCPT';

// Parsed reports are cached by file id + modifiedTime, so re-auditing the
// same invoice doesn't re-download and re-parse the PDF.
const cache = new Map();
const CACHE_LIMIT = 200;

function driveEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// A sale that is changed in RV after it was first filed — a payment taken, an
// item returned or swapped — is printed again and filed beside the first
// print as "<customer> SALES EDIT 2.pdf", then "… 3.pdf", with the receipt
// numbered to match ("… RV RCPT 3.pdf"). About one sale folder in ten has
// these. The highest number is the sale as it stands now.
//
// Returns the print number of a file for the given document suffix: 1 for the
// unnumbered first print, 0 if the file is not that document at all.
function printNumber(fileName, suffix) {
  const m = new RegExp(`${suffix}\\s*(\\d{1,2})?\\s*\\.PDF$`).exec(String(fileName || '').toUpperCase());
  if (!m) return 0;
  return m[1] ? Number(m[1]) : 1;
}

// Drive's `name contains` matches whole words, so "SARA BRYANT" finds
// "SARA BRYANT SALES EDIT.pdf" exactly as typing it into the Drive search box
// does. Results are ranked so the file actually named
// "<customer> SALES EDIT.pdf" wins over anything else that mentions the name.
// A numbered reprint is that same document re-issued, so it ranks with the
// first print rather than behind it — the caller then takes the newest.
function rank(file, customerName) {
  const name = String(file.name || '').toUpperCase();
  const base = printNumber(name, SUFFIX) ? name.replace(new RegExp(`(${SUFFIX})\\s*\\d{0,2}\\s*\\.PDF$`), '$1.PDF') : name;
  const want = `${String(customerName || '').toUpperCase().replace(/\s+/g, ' ').trim()} ${SUFFIX}.PDF`;
  if (base === want) return 0;
  if (base.endsWith(`${SUFFIX}.PDF`)) return 1;
  if (name.includes(SUFFIX)) return 2;
  return 3;
}

async function searchSalesEditPdfs(customerName, { limit = 10, since = '' } = {}) {
  const drive = getDriveClient();
  const safe = driveEscape(String(customerName || '').trim());
  if (!safe) return [];

  const q = [
    `name contains '${safe}'`,
    `name contains '${SUFFIX}'`,
    `mimeType = 'application/pdf'`,
    `trashed = false`,
  ].join(' and ');

  const res = await drive.files.list({
    q,
    fields: 'files(id, name, createdTime, modifiedTime, webViewLink, parents, capabilities(canDownload))',
    orderBy: 'createdTime desc',
    pageSize: limit,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    // The sales live on shared drives. Without this the search covers only
    // the signed-in account's own files and never finds one of them.
    corpora: 'allDrives',
  });

  // Only a file that is this customer's own SALES EDIT (or a reprint of it),
  // and one Drive will actually hand over ahead of one it won't.
  const earliest = /^\d{4}-\d{2}-\d{2}$/.test(String(since || ''))
    ? new Date(Date.parse(`${since}T00:00:00Z`) - 86400000).toISOString()
    : '';
  const files = (res.data.files || []).filter((f) => rank(f, customerName) === 0
    && (!earliest || String(f.createdTime) >= earliest));
  const blocked = (f) => (f.capabilities && f.capabilities.canDownload === false ? 1 : 0);
  return files
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (blocked(a.f) - blocked(b.f)) || (a.i - b.i))
    .map((x) => x.f);
}

// --- manually supplied reports (private to one browser, temporary) ---------
//
// When a sale has no SALES EDIT on Drive an auditor can supply the PDF
// themselves. It is deliberately NOT written to disk and NOT shared: several
// people use this tool at once, and one person's stand-in document must not
// become everyone else's source of truth. Uploads live in memory, keyed by the
// browser that sent them, and expire on their own.

const UPLOAD_TTL_MS = Number(process.env.SALES_EDIT_UPLOAD_TTL_MS) || 4 * 60 * 60 * 1000;
const UPLOAD_LIMIT = 50;
const sessionUploads = new Map();   // "session|date|invoiceId" -> { buffer, name, at }

function uploadKey(sessionId, date, invoiceId) {
  const sid = String(sessionId || '').trim();
  const d = String(date || '').trim();
  const id = String(invoiceId == null ? '' : invoiceId).trim();
  if (!sid || !/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d+$/.test(id)) return null;
  return `${sid}|${d}|${id}`;
}

function sweepUploads() {
  const cutoff = Date.now() - UPLOAD_TTL_MS;
  for (const [key, entry] of sessionUploads) {
    if (entry.at < cutoff) sessionUploads.delete(key);
  }
}

function findSessionUpload(sessionId, date, invoiceId) {
  const key = uploadKey(sessionId, date, invoiceId);
  if (!key) return null;
  sweepUploads();
  const entry = sessionUploads.get(key);
  if (!entry) return null;
  return {
    id: `upload:${key}`,
    name: entry.name || 'uploaded SALES EDIT.pdf',
    createdTime: new Date(entry.at).toISOString(),
    modifiedTime: new Date(entry.at).toISOString(),
    webViewLink: null,
    buffer: entry.buffer,
    uploaded: true,
    expiresAt: new Date(entry.at + UPLOAD_TTL_MS).toISOString(),
    capabilities: { canDownload: true },
  };
}

function saveSessionUpload(sessionId, date, invoiceId, buffer, name = '') {
  const key = uploadKey(sessionId, date, invoiceId);
  if (!key) throw Object.assign(new Error('session, date and invoiceId required'), { code: 'BAD_KEY' });
  sweepUploads();
  // Oldest out first if someone leaves a lot of these open.
  while (sessionUploads.size >= UPLOAD_LIMIT) {
    sessionUploads.delete(sessionUploads.keys().next().value);
  }
  sessionUploads.set(key, { buffer, name: String(name || '').slice(0, 200), at: Date.now() });
  return findSessionUpload(sessionId, date, invoiceId);
}

function removeSessionUpload(sessionId, date, invoiceId) {
  const key = uploadKey(sessionId, date, invoiceId);
  return key ? sessionUploads.delete(key) : false;
}

// Local override. Sales older than a couple of days move to an archive shared
// drive that blocks downloads, so point SALES_EDIT_LOCAL_DIR at a folder of
// hand-downloaded PDFs to audit those. Live sales come straight off Drive and
// never need this.
function findLocalSalesEdit(customerName) {
  const dir = process.env.SALES_EDIT_LOCAL_DIR;
  if (!dir) return null;

  const want = String(customerName || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!want) return null;

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    console.warn(`SALES_EDIT_LOCAL_DIR is not readable (${dir}): ${e.message}`);
    return null;
  }

  const hit = entries
    .filter((n) => n.toLowerCase().endsWith('.pdf'))
    .map((n) => ({ n, u: n.toUpperCase() }))
    .filter(({ u }) => u.includes(want) && u.includes(SUFFIX))
    .sort((a, b) => (a.u === `${want} ${SUFFIX}.PDF` ? -1 : 0) - (b.u === `${want} ${SUFFIX}.PDF` ? -1 : 0))[0];
  if (!hit) return null;

  const full = path.join(dir, hit.n);
  const stat = fs.statSync(full);
  return {
    id: `local:${full}`,
    name: hit.n,
    createdTime: stat.mtime.toISOString(),
    modifiedTime: stat.mtime.toISOString(),
    webViewLink: null,
    localPath: full,
    capabilities: { canDownload: true },
  };
}

// ---------------------------------------------------------------------------
// Finding the sale on Drive
//
// Never by filename search: Drive's full-text `name contains` index is
// eventually consistent, and a freshly filed PDF can be missing from those
// results for hours while sitting in plain sight in the Drive UI. That is what
// makes a sale look like it was never posted to RV. Listing children by parent
// id does not go through that index, so every lookup below walks the tree.
//
// Where a sale lives depends on how old it is:
//
//   Audit Arden / A SEP 21 / 1309090 DIANE DILLINGHAM / …SALES EDIT.pdf
//     the working day's sales, filed per store. Past days keep only the batch
//     and cash reports — "A SEPTEMBER 2026 / A SEP 20" has no sale folders.
//   CFC Data / All Sales / 1309070 JEFF GIUNTA / …
//   CFC Data / " A TO  MOVE TO ARCHIVE" / 2026 1309050 KAREN EDMUND / …
//     where a sale moves once its day is closed out.
//
// So the day folder is checked first, then the two flat roots.

const STORE_ROOTS = {
  arden:       process.env.AUDIT_ARDEN_FOLDER_ID       || '1WNQV45NSjcsVY3G8QbbSzX-Ph7AjHRHc',
  waynesville: process.env.AUDIT_WAYNESVILLE_FOLDER_ID || '1gC8qL6-Xj-DwOq0WbC4FtS2K1kfyyJmb',
};
const STORE_PREFIX = { arden: 'A', waynesville: 'W' };

const MONTH_FULL = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// Sales already moved out of the day folders.
const DEFAULT_SALES_ROOTS = [
  '1bo4WxaTEo2tFn_aLg-hvf0FavQeZFTLI',   // All Sales
  '1KSHk2_M_qcq2vCVxKQGaI-x6xkNlQ6Pp',   // " A TO  MOVE TO ARCHIVE"
];
const SALES_ROOT_IDS = (process.env.SALES_ROOT_FOLDER_IDS || '')
  .split(',').map((x) => x.trim()).filter(Boolean);
const salesRoots = () => (SALES_ROOT_IDS.length ? SALES_ROOT_IDS : DEFAULT_SALES_ROOTS);

// How many of one customer's sale folders are offered to the audit to choose
// between. Each extra one costs a folder listing, and a download if tried.
const MAX_SALE_CANDIDATES = 3;

const FOLDER_TTL_MS = 60 * 1000;
const childCache = new Map();          // folderId -> { at, items }

function isDir(f) {
  return f.mimeType === 'application/vnd.google-apps.folder';
}

// `fresh` skips the cache. A cache hit must never be the reason a just-filed
// sale looks missing, so any lookup that comes up empty re-runs with fresh.
async function listChildren(folderId, { fresh = false } = {}) {
  const hit = childCache.get(folderId);
  if (!fresh && hit && Date.now() - hit.at < FOLDER_TTL_MS) return hit.items;

  const drive = getDriveClient();
  const items = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, webViewLink, capabilities(canDownload))',
      orderBy: 'createdTime desc',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    items.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  childCache.set(folderId, { at: Date.now(), items });
  return items;
}

function nameTokens(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
}

// How well a folder name matches a customer, 3 (best) down to 0 (no match).
//
// Folders are named "<sale no> <CUSTOMER NAME>", sometimes with a year in
// front or a note after ("1309130 PAT CROWLEY Hold for Esign"). The two
// systems don't always spell the name the same way: the Ticket may carry a
// middle initial or middle name that RV drops, as in Ticket "Melody H Glover"
// against Drive "1308670 MELODY GLOVER".
//
// Matching is always on whole words, so "Ann Smith" can't match "Maryann
// Smithson", and the score lets a stricter match win when several folders
// qualify.
function nameMatchScore(folderName, customerName) {
  const want = nameTokens(customerName);
  if (!want.length) return 0;
  const have = new Set(nameTokens(folderName));

  // 3 — every part of the name is there.
  if (want.every((t) => have.has(t))) return 3;

  // 2 — everything but the initials, so a middle initial on one side only
  //     still matches.
  const named = want.filter((t) => t.length > 1);
  if (named.length && named.every((t) => have.has(t))) return 2;

  // 1 — surname plus at least one given name. Covers a middle name one side
  //     is missing ("Sherry Willis Hanson" / "SHERRY HANSON") and a joint
  //     ticket filed under one person ("Mark And Amy Gartman" / "AMY GARTMAN").
  const last = want[want.length - 1];
  if (want.length >= 2 && have.has(last)
      && want.slice(0, -1).some((t) => have.has(t))) return 1;

  return 0;
}

// Surname-only match, for a first name the two systems disagree on entirely —
// a nickname, most often ("Kathy Potts" on the Ticket, "KATHLEEN POTTS" in
// RV). Too weak to trust on its own, so it is used only when exactly one
// candidate carries the surname, and the audit's own name check still warns.
function surnameOnlyCandidates(items, customerName) {
  const want = nameTokens(customerName);
  const last = want[want.length - 1];
  if (!last || last.length < 3) return [];
  const hits = items.filter((f) => new Set(nameTokens(f.name)).has(last));
  return hits.length === 1 ? hits : [];
}

// Candidates for a customer, best match first. Falls back to the surname when
// nothing matches outright and the surname points at exactly one sale.
//
// `mode` splits the two halves apart: "strong" is a real name match only,
// "weak" is only the fallbacks. The lookup runs every location on strong
// before it lets any location answer on weak — otherwise a sale that has
// simply been moved is "found" as the one other customer with that surname.
function pickCandidates(items, customerName, mode = 'any') {
  const matched = items
    .filter((f) => nameMatchScore(f.name, customerName) > 0)
    .sort(byNameThenRecency(customerName));
  if (mode === 'strong') return matched;
  if (matched.length) return mode === 'weak' ? [] : matched;

  const fallback = surnameOnlyCandidates(items, customerName);
  if (fallback.length) {
    console.log(`sales-edit: "${customerName}" matched "${fallback[0].name}" on surname alone`);
    return fallback;
  }

  const near = misspeltSurnameCandidates(items, customerName);
  if (near.length) {
    console.log(`sales-edit: "${customerName}" matched "${near[0].name}" allowing one wrong letter in the surname`);
  }
  return near;
}

// True when two words differ by a single letter — one changed, added or
// dropped ("CARVER" / "CARTER", "MCGILLIN" / "MCGILLEN").
function oneLetterApart(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
  return longer.slice(i + 1) === shorter.slice(i);
}

// The folder is typed by hand, and a surname can come out one letter wrong:
// the Ticket's "Nida Carver" was filed as "2329780 NIDA CARTER". Accept that
// when the first name matches exactly and only one folder fits. As with the
// surname-only match, the audit's own name check still shows the difference.
function misspeltSurnameCandidates(items, customerName) {
  const want = nameTokens(customerName);
  const last = want[want.length - 1];
  const first = want[0];
  if (want.length < 2 || !last || last.length < 5 || first.length < 2) return [];
  const hits = items.filter((f) => {
    const have = nameTokens(f.name);
    return have.includes(first) && have.some((t) => oneLetterApart(t, last));
  });
  return hits.length === 1 ? hits : [];
}

function folderMatchesCustomer(folderName, customerName) {
  return nameMatchScore(folderName, customerName) > 0;
}

// Best match first, then newest, so a repeat customer resolves to their most
// recent sale and an exact name beats a partial one.
function byNameThenRecency(customerName) {
  return (a, b) => (nameMatchScore(b.name, customerName) - nameMatchScore(a.name, customerName))
    || String(b.createdTime).localeCompare(String(a.createdTime));
}

// Best candidate first: the right document for this customer, then the latest
// print of it (see printNumber), then the most recently filed.
function salesEditPdfs(files, customerName) {
  return files
    .filter((f) => !isDir(f) && /\.pdf$/i.test(f.name) && f.name.toUpperCase().includes(SUFFIX))
    .sort((a, b) => rank(a, customerName) - rank(b, customerName)
      || printNumber(b.name, SUFFIX) - printNumber(a.name, SUFFIX)
      || String(b.createdTime).localeCompare(String(a.createdTime)));
}

// "A SEP 20" for the day, "A SEPTEMBER 2026" for the month that holds it.
function dayFolderNames(store, date) {
  const prefix = STORE_PREFIX[store];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!prefix || !m) return null;
  const month = Number(m[2]) - 1;
  return {
    day: `${prefix} ${MONTH_ABBR[month]} ${m[3]}`,
    month: `${prefix} ${MONTH_FULL[month]} ${m[1]}`,
  };
}

async function findDayFolder(store, date, opts = {}) {
  const rootId = STORE_ROOTS[store];
  const names = dayFolderNames(store, date);
  if (!rootId || !names) return null;

  const top = await listChildren(rootId, opts);
  const eq = (f, want) => isDir(f) && f.name.trim().toUpperCase().replace(/\s+/g, ' ') === want;

  // The working day sits at the top level; closed days move under the month.
  const direct = top.find((f) => eq(f, names.day));
  if (direct) return direct;

  const monthFolder = top.find((f) => eq(f, names.month));
  if (!monthFolder) return null;
  return (await listChildren(monthFolder.id, opts)).find((f) => eq(f, names.day)) || null;
}

// The day folder holds one subfolder per sale, plus the occasional loose PDF
// for a sale that never got its own folder.
async function findInDayFolder(customerName, store, date, opts = {}) {
  let folder;
  try {
    folder = await findDayFolder(store, date, opts);
  } catch (e) {
    console.warn(`sales-edit: day folder lookup failed for ${store} ${date}: ${e.message}`);
    return null;
  }
  if (!folder) return null;

  return salesInFolder(folder, customerName, opts, { dayFolder: folder.name });
}

// The customer's sale(s) inside one container folder — a day folder, a
// store's "Issues" folder — which holds one subfolder per sale plus the odd
// loose PDF. Returns the first with any others attached as `alternates`.
//
// A customer can have more than one sale folder in the same place ("1315600
// MARK OTT" and "1315610 MARK OTT"); the rest ride along so the audit can
// pick the one that is actually this ticket's.
async function salesInFolder(container, customerName, opts = {}, tag = {}) {
  const kids = await listChildren(container.id, opts);
  const mode = opts.match || 'any';

  const loose = pickCandidates(salesEditPdfs(kids, customerName), customerName, mode)[0];
  if (loose) return { ...loose, folderName: container.name, ...tag };

  return firstWithAlternates(pickCandidates(kids.filter(isDir), customerName, mode), customerName, opts, tag);
}

async function firstWithAlternates(saleFolders, customerName, opts, tag = {}) {
  const hits = [];
  for (const sub of saleFolders) {
    const hit = salesEditPdfs(await listChildren(sub.id, opts), customerName)[0];
    if (hit) hits.push({ ...hit, folderId: sub.id, folderName: sub.name, ...tag });
    if (hits.length >= MAX_SALE_CANDIDATES) break;
  }
  return hits.length ? { ...hits[0], alternates: hits.slice(1) } : null;
}

// A sale that is not ready to close — waiting on an e-signature, a driver's
// licence, an approval — is parked in the store's "Issues" folder ("Audit
// Arden / Arden Issues / 1315490 JULIO LOPEZ - HOLD FOR DL") instead of
// moving on with its day.
async function findInIssuesFolders(customerName, store, opts = {}) {
  const rootId = STORE_ROOTS[store];
  if (!rootId) return null;
  const parked = (await listChildren(rootId, opts)).filter((f) => isDir(f) && /\bISSUES?\b/i.test(f.name));
  for (const folder of parked) {
    const hit = await salesInFolder(folder, customerName, opts, { parkedIn: folder.name });
    if (hit) return hit;
  }
  return null;
}

// Or it is carried forward: a sale written on the 25th and still open is
// moved into the folder of the day it is finally dealt with ("W NOV 27 /
// 2329820 JAMES WYKLE"). Look through the days that follow the ticket's.
const CARRIED_FORWARD_DAYS = 7;
async function findInLaterDayFolders(customerName, store, date, opts = {}) {
  const start = Date.parse(`${date}T12:00:00Z`);
  if (Number.isNaN(start)) return null;
  for (let n = 1; n <= CARRIED_FORWARD_DAYS; n++) {
    const day = new Date(start + n * 86400000).toISOString().slice(0, 10);
    const hit = await findInDayFolder(customerName, store, day, opts);
    if (hit) return { ...hit, carriedTo: day };
  }
  return null;
}

// Sales that have moved out of their day folder into one of the flat roots.
async function findViaFolder(customerName, opts = {}) {
  const folders = [];
  for (const root of salesRoots()) {
    try {
      folders.push(...(await listChildren(root, opts)).filter(isDir));
    } catch (e) {
      // One unreachable root shouldn't sink the others.
      console.warn(`sales-edit: could not list root ${root}: ${e.message}`);
    }
  }
  return firstWithAlternates(pickCandidates(folders, customerName, opts.match || 'any'), customerName, opts);
}

// Pull the RV sale number out of a folder name like "1309070 JEFF GIUNTA" or
// "2026 1309050 KAREN EDMUND" — the longest run of digits is the sale number,
// a leading year is not.
function salesNoFromFolderName(folderName) {
  const runs = String(folderName || '').match(/\d+/g) || [];
  const best = runs.filter((r) => r.length >= 6).sort((a, b) => b.length - a.length)[0];
  return best || '';
}

// The first hit is the one to audit — same as picking the top row in Drive.
// `store` ("arden" | "waynesville") and `date` (YYYY-MM-DD) come off the
// Ticket and point straight at the day folder. Without them the day-folder
// step is skipped and the flat roots do the work.
async function findSalesEditPdf(customerName, { store = '', date = '', invoiceId = null, sessionId = '' } = {}) {
  // A file this browser supplied for this invoice wins over everything: it is
  // an explicit decision about which report belongs to this ticket. Other
  // people's audits are unaffected — the upload is scoped to the session.
  const uploaded = findSessionUpload(sessionId, date, invoiceId);
  if (uploaded) return uploaded;

  const local = findLocalSalesEdit(customerName);
  if (local) return local;

  const stores = STORE_ROOTS[store] ? [store] : Object.keys(STORE_ROOTS);

  // Every place a sale can be, nearest first.
  const walk = async (opts) => {
    if (date) {
      // 1. The store's day folder — where a sale lives while it is current.
      for (const st of stores) {
        const hit = await findInDayFolder(customerName, st, date, opts);
        if (hit) return hit;
      }
    }
    // Not there, so it has been moved — and a returning customer may have
    // another sale in any of these places. Collect what each one holds and
    // let the audit choose the sale that matches the ticket.
    const found = [];
    const add = (hit) => {
      if (!hit) return;
      const { alternates = [], ...first } = hit;
      found.push(first, ...alternates);
    };
    // A weak match (surname only) is not trusted across a week of other
    // days' sales, so steps 2 and 3 take real name matches only.
    if (opts.match !== 'weak') {
      // 2. The store's Issues folder, for a sale held back from closing.
      for (const st of stores) add(await findInIssuesFolders(customerName, st, opts).catch(() => null));
      // 3. A later day's folder, for a sale carried forward.
      if (date) {
        for (const st of stores) add(await findInLaterDayFolders(customerName, st, date, opts).catch(() => null));
      }
    }
    // 4. The flat roots, for sales whose day has been closed out.
    add(await findViaFolder(customerName, opts));

    if (!found.length) return null;
    const [first, ...rest] = found;
    return { ...first, alternates: rest.slice(0, MAX_SALE_CANDIDATES + 1) };
  };

  // A real name match, anywhere, comes first.
  const cached = await walk({ match: 'strong' });
  if (cached) return cached;

  // Nothing found. Before reporting the sale as missing, repeat the walk
  // against Drive rather than the cache — a sale filed in the last minute
  // would otherwise be invisible for no good reason.
  const live = await walk({ match: 'strong', fresh: true });
  if (live) return live;

  // Then a name search across every drive, which reaches sales moved
  // somewhere the walk doesn't know about, the archive drive included.
  // A file from before the ticket was written is an earlier sale to the same
  // person, not this one.
  const files = await searchSalesEditPdfs(customerName, { limit: 10, since: date }).catch(() => []);
  if (files[0]) return { ...files[0], folderId: (files[0].parents || [])[0] };

  // Only now the weak matches: a surname on its own, or one letter out.
  return walk({ match: 'weak' });
}

async function downloadPdf(fileId) {
  const res = await streamPdf(fileId);
  const chunks = [];
  return new Promise((resolve, reject) => {
    res.data.on('data', (c) => chunks.push(c));
    res.data.on('end', () => resolve(Buffer.concat(chunks)));
    res.data.on('error', reject);
  });
}

// Download + parse one SALES EDIT PDF into { header, custMaster, items }.
async function loadSalesEdit(file) {
  const key = `${file.id}:${file.modifiedTime || ''}`;
  if (cache.has(key)) return cache.get(key);

  if (file.capabilities && file.capabilities.canDownload === false) {
    const err = new Error(
      `Drive will not release "${file.name}" to this account — it lives on a shared drive where ` +
      `downloading is turned off for viewers. Grant the account Content manager on that drive ` +
      `(or lift the download restriction) and it will read normally.`,
    );
    err.code = 'DRIVE_DOWNLOAD_BLOCKED';
    err.file = file;
    throw err;
  }

  let buffer;
  try {
    buffer = file.buffer || (file.localPath ? fs.readFileSync(file.localPath) : await downloadPdf(file.id));
  } catch (e) {
    const status = e.response && e.response.status;
    if (status === 403) {
      const err = new Error(
        `Drive refused to download "${file.name}" (403). The shared drive it sits on has ` +
        `downloading disabled for this account's role.`,
      );
      err.code = 'DRIVE_DOWNLOAD_BLOCKED';
      err.file = file;
      throw err;
    }
    throw e;
  }

  const { pages } = await extractLines(buffer);
  const parsed = parseSalesEdit(pages);

  // Resolve the containing folder name when the filename search found the
  // file directly (the folder fallback already knows it). The folder is named
  // after the sale, so it gives a free check on the number inside the PDF.
  let folderName = file.folderName || '';
  if (!folderName && !file.localPath && file.parents && file.parents[0]) {
    try {
      const drive = getDriveClient();
      const parent = await drive.files.get({
        fileId: file.parents[0], fields: 'name', supportsAllDrives: true,
      });
      folderName = parent.data.name || '';
    } catch (e) { /* non-fatal — the cross-check is simply skipped */ }
  }
  const result = {
    ...parsed,
    file: {
      id: file.id,
      name: file.name,
      createdTime: file.createdTime,
      webViewLink: file.webViewLink,
      local: Boolean(file.localPath),
      uploaded: Boolean(file.uploaded),
      expiresAt: file.expiresAt || null,
      folderName,
      // The folder is named after the sale, so its number is an independent
      // check on the one printed inside the PDF.
      folderSalesNo: salesNoFromFolderName(folderName),
      viaFolder: Boolean(file.folderId),
    },
  };

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}

// Find and parse in one step. Returns null when the customer has no PDF.
async function fetchSaleForCustomer(customerName) {
  const file = await findSalesEditPdf(customerName);
  if (!file) return null;
  return loadSalesEdit(file);
}

// --- the RV receipt filed alongside -----------------------------------------

const receiptCache = new Map();

// The receipt that goes with the SALES EDIT being audited. Each reprint of a
// sale gets its own numbered receipt, so take the one printed with this
// SALES EDIT. With no matching number, fall back to the newest receipt — but
// never one from an earlier print, whose totals would overwrite newer ones.
async function findReceiptPdf(saleFile) {
  if (!saleFile || !saleFile.folderId) return null;
  const files = await listChildren(saleFile.folderId);
  const receipts = files
    .filter((f) => !isDir(f) && f.name.toUpperCase().includes(RECEIPT_SUFFIX))
    .sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)));
  if (!receipts.length) return null;

  const want = printNumber(saleFile.name, SUFFIX);
  if (!want) return receipts[0];               // unusual file name — keep the old behaviour
  const same = receipts.find((f) => printNumber(f.name, RECEIPT_SUFFIX) === want);
  if (same) return same;
  const newest = receipts[0];
  const newestPrint = printNumber(newest.name, RECEIPT_SUFFIX);
  return (!newestPrint || newestPrint > want) ? newest : null;
}

// What else sits in the sale's Drive folder that bears on the audit: how many
// times the sale was printed, and any return form ("<customer> RTS.pdf") filed
// against it. Null when the sale has no folder of its own to look in.
async function describeSaleFolder(saleFile) {
  if (!saleFile || !saleFile.folderId) return null;
  const files = (await listChildren(saleFile.folderId)).filter((f) => !isDir(f) && /\.pdf$/i.test(f.name));
  const brief = (f) => ({ name: f.name, createdTime: f.createdTime });
  const oldestFirst = (a, b) => String(a.createdTime).localeCompare(String(b.createdTime));
  return {
    salesEdits: files.filter((f) => printNumber(f.name, SUFFIX) > 0).sort(oldestFirst).map(brief),
    returnForms: files.filter((f) => /\bRTS\b/i.test(f.name)).sort(oldestFirst).map(brief),
  };
}

// Returns null rather than throwing: the receipt is a cross-check, so a sale
// without one, or one Drive won't release, must not fail the audit.
async function loadReceiptFor(saleFile) {
  let file;
  try {
    file = await findReceiptPdf(saleFile);
  } catch (e) {
    return null;
  }
  if (!file || (file.capabilities && file.capabilities.canDownload === false)) return null;

  const key = `${file.id}:${file.modifiedTime || ''}`;
  if (receiptCache.has(key)) return receiptCache.get(key);

  try {
    const { pages } = await extractLines(await downloadPdf(file.id));
    const parsed = { ...parseRvReceipt(pages), file: { id: file.id, name: file.name } };
    if (receiptCache.size >= CACHE_LIMIT) receiptCache.delete(receiptCache.keys().next().value);
    receiptCache.set(key, parsed);
    return parsed;
  } catch (e) {
    console.warn(`sales-edit: could not read receipt "${file.name}": ${e.message}`);
    return null;
  }
}

module.exports = {
  searchSalesEditPdfs,
  saveSessionUpload,
  removeSessionUpload,
  findSessionUpload,
  findReceiptPdf,
  describeSaleFolder,
  printNumber,
  salesEditPdfs,
  loadReceiptFor,
  findSalesEditPdf,
  findViaFolder,
  findInDayFolder,
  findDayFolder,
  salesNoFromFolderName,
  loadSalesEdit,
  fetchSaleForCustomer,
};
