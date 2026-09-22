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

const SUFFIX = 'SALES EDIT';

// Parsed reports are cached by file id + modifiedTime, so re-auditing the
// same invoice doesn't re-download and re-parse the PDF.
const cache = new Map();
const CACHE_LIMIT = 200;

function driveEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Drive's `name contains` matches whole words, so "SARA BRYANT" finds
// "SARA BRYANT SALES EDIT.pdf" exactly as typing it into the Drive search box
// does. Results are ranked so the file actually named
// "<customer> SALES EDIT.pdf" wins over anything else that mentions the name.
function rank(file, customerName) {
  const name = String(file.name || '').toUpperCase();
  const want = `${String(customerName || '').toUpperCase().replace(/\s+/g, ' ').trim()} ${SUFFIX}.PDF`;
  if (name === want) return 0;
  if (name.endsWith(`${SUFFIX}.PDF`)) return 1;
  if (name.includes(SUFFIX)) return 2;
  return 3;
}

async function searchSalesEditPdfs(customerName, { limit = 10 } = {}) {
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
  });

  const files = res.data.files || [];
  return files
    .map((f, i) => ({ f, r: rank(f, customerName), i }))
    .sort((a, b) => (a.r - b.r) || (a.i - b.i))
    .map((x) => x.f);
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

// Folders are named "<sale no> <CUSTOMER NAME>", sometimes with a year in
// front or a note after ("1309130 PAT CROWLEY Hold for Esign"). Require every
// part of the customer's name as a whole word so "Ann Smith" can't match
// "Maryann Smithson".
function folderMatchesCustomer(folderName, customerName) {
  const want = nameTokens(customerName);
  if (!want.length) return false;
  const have = new Set(nameTokens(folderName));
  return want.every((t) => have.has(t));
}

function salesEditPdfs(files, customerName) {
  return files
    .filter((f) => !isDir(f) && /\.pdf$/i.test(f.name) && f.name.toUpperCase().includes(SUFFIX))
    .sort((a, b) => rank(a, customerName) - rank(b, customerName)
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

  const kids = await listChildren(folder.id, opts);

  const loose = salesEditPdfs(kids, customerName)
    .filter((f) => folderMatchesCustomer(f.name, customerName))[0];
  if (loose) return { ...loose, folderName: folder.name, dayFolder: folder.name };

  for (const sub of kids.filter(isDir).filter((f) => folderMatchesCustomer(f.name, customerName))) {
    const hit = salesEditPdfs(await listChildren(sub.id, opts), customerName)[0];
    if (hit) return { ...hit, folderId: sub.id, folderName: sub.name, dayFolder: folder.name };
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
  folders.sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)));

  for (const folder of folders.filter((f) => folderMatchesCustomer(f.name, customerName))) {
    const hit = salesEditPdfs(await listChildren(folder.id, opts), customerName)[0];
    if (hit) return { ...hit, folderId: folder.id, folderName: folder.name };
  }
  return null;
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
async function findSalesEditPdf(customerName, { store = '', date = '' } = {}) {
  const local = findLocalSalesEdit(customerName);
  if (local) return local;

  const stores = STORE_ROOTS[store] ? [store] : Object.keys(STORE_ROOTS);

  const walk = async (opts) => {
    // 1. The store's day folder — where a sale lives while it is current.
    if (date) {
      for (const st of stores) {
        const hit = await findInDayFolder(customerName, st, date, opts);
        if (hit) return hit;
      }
    }
    // 2. The flat roots, for sales whose day has been closed out.
    return findViaFolder(customerName, opts);
  };

  const cached = await walk({});
  if (cached) return cached;

  // Nothing found. Before reporting the sale as missing, repeat the walk
  // against Drive rather than the cache — a sale filed in the last minute
  // would otherwise be invisible for no good reason.
  const live = await walk({ fresh: true });
  if (live) return live;

  // 3. Last resort: a name search. Reaches sales moved off to the archive
  //    drive, at the cost of being subject to the index lag described above.
  const files = await searchSalesEditPdfs(customerName, { limit: 10 });
  return files[0] || null;
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
    buffer = file.localPath ? fs.readFileSync(file.localPath) : await downloadPdf(file.id);
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

module.exports = {
  searchSalesEditPdfs,
  findSalesEditPdf,
  findViaFolder,
  findInDayFolder,
  findDayFolder,
  salesNoFromFolderName,
  loadSalesEdit,
  fetchSaleForCustomer,
};
