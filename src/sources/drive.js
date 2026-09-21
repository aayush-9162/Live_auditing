// Google Drive access for pulling ticket-sale PDFs by customer name.
//
// Uses the OAuth client + refresh-token JSON files copied from the Forms
// project (both live under ../../secrets). The googleapis library handles
// token refresh automatically using the saved refresh_token — no login flow.

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SECRETS_DIR   = path.join(__dirname, '..', '..', 'secrets');
const CLIENT_PATH   = path.join(SECRETS_DIR, 'gdrive-client.json');
const TOKEN_PATH    = path.join(SECRETS_DIR, 'gdrive-token.json');

let _drive = null;

function getDriveClient() {
  if (_drive) return _drive;
  const clientJson = JSON.parse(fs.readFileSync(CLIENT_PATH, 'utf8'));
  const cfg = clientJson.installed || clientJson.web;
  if (!cfg) throw new Error('Invalid client JSON — expected "installed" or "web" key');
  const oauth = new google.auth.OAuth2(
    cfg.client_id,
    cfg.client_secret,
    cfg.redirect_uris?.[0] || 'urn:ietf:wg:oauth:2.0:oob',
  );
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oauth.setCredentials(token);
  // Persist refreshed tokens back to disk so restarts survive.
  oauth.on('tokens', (t) => {
    try {
      const existing = fs.existsSync(TOKEN_PATH) ? JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')) : {};
      fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...existing, ...t }, null, 2));
    } catch (_) { /* non-fatal */ }
  });
  _drive = google.drive({ version: 'v3', auth: oauth });
  return _drive;
}

// Find the most recent PDF matching the customer name whose createdTime is
// within the last `daysBack` days. Returns { id, name, createdTime, webViewLink }
// or null if nothing qualifies.
async function findCustomerPdf(customerName, { daysBack = 5, folderId = null } = {}) {
  const drive = getDriveClient();
  const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();
  const safeName = String(customerName || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const clauses = [
    `name contains '${safeName}'`,
    `mimeType = 'application/pdf'`,
    `createdTime > '${cutoff}'`,
    `trashed = false`,
  ];
  if (folderId) clauses.push(`'${folderId}' in parents`);

  const res = await drive.files.list({
    q: clauses.join(' and '),
    fields: 'files(id, name, createdTime, webViewLink, parents)',
    orderBy: 'createdTime desc',
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = res.data.files || [];
  // Prefer an exact "<name>.pdf" match if present
  const wanted = `${customerName}.pdf`.toLowerCase();
  const exact = files.find((f) => f.name.toLowerCase() === wanted);
  return exact || files[0] || null;
}

async function streamPdf(fileId) {
  const drive = getDriveClient();
  return drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' },
  );
}

module.exports = { getDriveClient, findCustomerPdf, streamPdf };
