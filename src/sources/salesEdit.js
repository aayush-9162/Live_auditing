// Source B: the RV sale, read from its "SALES EDIT" PDF on Google Drive.
//
// This replaces the old MSSQL salesopendaily/Sale_DetailRV queries. Each sale
// is archived to Drive as "<CUSTOMER NAME> SALES EDIT.pdf" inside a folder
// named "<ticket no> <CUSTOMER NAME>", so a name search finds the sale the
// same way a person would.

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

// The first hit is the one to audit — same as picking the top row in Drive.
async function findSalesEditPdf(customerName) {
  const local = findLocalSalesEdit(customerName);
  if (local) return local;
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
  const result = {
    ...parsed,
    file: {
      id: file.id,
      name: file.name,
      createdTime: file.createdTime,
      webViewLink: file.webViewLink,
      local: Boolean(file.localPath),
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
  loadSalesEdit,
  fetchSaleForCustomer,
};
