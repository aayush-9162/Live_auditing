require('dotenv').config();
const path = require('path');
const express = require('express');

const { fetchInvoicesByDate } = require('./src/sources/invoices');
const { findCustomerPdf, streamPdf } = require('./src/sources/drive');
const {
  findSalesEditPdf, loadSalesEdit, loadReceiptFor, describeSaleFolder,
  saveSessionUpload, removeSessionUpload,
} = require('./src/sources/salesEdit');
const { extractLines } = require('./src/parse/pdfLayout');
const { parseSalesEdit } = require('./src/parse/salesEdit');
const { normalizeInvoice, normalizeDate } = require('./src/normalize/fromJson');
const { normalizeMssqlRows } = require('./src/normalize/fromMssql');
const { toFirstLast, namesLooseMatch } = require('./src/match/name');
const { addressLooseMatch } = require('./src/match/address');
const { expectedDeliveryVia } = require('./src/match/deliveryVia');
const { isKnownDeliveryViaLabel } = require('./src/match/rvCodes');
const { compare } = require('./src/compare/diff');
const { compareReturn } = require('./src/compare/returnAudit');

// A return ticket points back at the sale it returns from. That ticket was
// written on an earlier day, and its slug carries the date
// ("BRENTPERRY_20261122173220D559"), so it can be fetched from that day's
// archive. Best effort — the return is still audited without it.
async function findOriginalInvoice(slug, sameDay) {
  const wanted = String(slug || '').trim();
  if (!wanted) return null;
  const inDay = (sameDay && sameDay.data) || [];
  const here = inDay.find((r) => r.slug === wanted);
  if (here) return here;

  const m = /_(\d{4})(\d{2})(\d{2})\d{6}/.exec(wanted);
  if (!m) return null;
  try {
    const day = await fetchInvoicesByDate(`${m[1]}-${m[2]}-${m[3]}`);
    return (day.data || []).find((r) => r.slug === wanted) || null;
  } catch (e) {
    console.warn(`return audit: could not load original ticket ${wanted}: ${e.message}`);
    return null;
  }
}

// Return tickets written against a sale ticket.
//
// The audit compares a sale against RV as it stands now. If part of the sale
// has since been returned, RV no longer matches the ticket — correctly — and
// the auditor needs to be told why. The same day's archive is already in
// hand. Beyond that, a return form in the sale's Drive folder says which day
// the return was written; its filing time is UTC, so that date and the one
// before it are checked. Best effort: a failed lookup just means no note.
const MAX_RETURN_DAYS = 4;
async function findReturnsFor(rec, sameDay, date, folder) {
  const slug = String((rec && rec.slug) || '').trim();
  if (!slug) return [];

  const days = new Map([[date, sameDay]]);
  for (const form of (folder && folder.returnForms) || []) {
    const t = Date.parse(form.createdTime);
    if (Number.isNaN(t)) continue;
    for (const back of [0, 1]) {
      const d = new Date(t - back * 86400000).toISOString().slice(0, 10);
      if (!days.has(d) && days.size <= MAX_RETURN_DAYS) days.set(d, null);
    }
  }

  const found = [];
  for (const [d, known] of days) {
    let day = known;
    if (!day) {
      try { day = await fetchInvoicesByDate(d); } catch (e) { continue; }
    }
    for (const r of (day && day.data) || []) {
      if (String(r.transaction_mode || '').toUpperCase() !== 'RETURN') continue;
      if (String((r.form_json && r.form_json.originalInvoiceSlug) || '').trim() !== slug) continue;
      const n = normalizeInvoice(r);
      const label = (x) => [x.ven, x.sku].filter(Boolean).join(' ') || x.description || 'item';
      found.push({
        id: n.id,
        date: d,
        returned: n.returnInfo.returned.map((x) => ({ label: label(x), qty: x.returnQty })),
        added: n.items.filter((x) => !x.isReturn).map((x) => ({ label: label(x), qty: x.qty })),
        returnedValue: n.returnInfo.returnedValue,
        newItemsValue: n.returnInfo.newItemsValue,
      });
    }
  }
  return found.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id);
}

// Is this RV sale the one the ticket was written for? Used only to choose
// between several sales on file for the same customer. A sale ticket's sale
// has the ticket's total; a return ticket's is either the sale it names or a
// sale carrying return (negative) lines.
function saleFitsTicket(sale, jsonNorm, originalRec = null) {
  const header = (sale && sale.header) || {};
  if (jsonNorm.isReturn) {
    if ((sale.items || []).some((row) => Number(row.sale_qty) < 0)) return true;
    // The ticket being returned from is a firmer link than the sale number
    // typed on the return, which can be left over from an earlier sale: the
    // right sale is the one holding most of what that ticket sold.
    const bare = (id) => String(id || '').trim().replace(/^\*PKG/i, '').replace(/^0+(?=\d)/, '').toLowerCase();
    const sold = [...new Set(((originalRec && originalRec.form_json && originalRec.form_json.items) || [])
      .map((it) => bare(it.itemId)).filter((id) => id && !id.startsWith('*')))];
    if (sold.length) {
      const onSale = new Set((sale.items || []).map((row) => bare(row.sale_item)));
      return sold.filter((id) => onSale.has(id)).length >= sold.length / 2;
    }
    const wanted = String((jsonNorm.returnInfo && jsonNorm.returnInfo.rvNumber) || '').trim();
    return Boolean(wanted) && wanted === String(header.SalesNo || '').trim();
  }
  return Math.abs((Number(header.SaleTotalAmt) || 0) - (Number(jsonNorm.totals.total) || 0)) < 0.01;
}

// Compare two phone strings by their last 10 digits (US numbers; ignores
// formatting and leading country code).
function phonesMatch(a, b) {
  const norm = (s) => String(s || '').replace(/\D+/g, '').slice(-10);
  const na = norm(a);
  const nb = norm(b);
  return Boolean(na) && na === nb;
}

// Drive returns exactly one SALES EDIT PDF per customer, so there is nothing
// to disambiguate the way the old multi-row SQL lookup needed. What is worth
// checking is whether the PDF we picked really belongs to this ticket —
// a name search can land on a different person with a similar name. Score the
// header against the ticket on name, address and phone so the UI can warn.
function scoreSaleMatch(header, jsonNorm) {
  const pdfName = toFirstLast(String(header.CustomerName || '').trim());
  const pdfAddr = String(header.cust_st_1 || header.DeliveryAddr1 || '').trim();
  const pdfPhone = String(header.cust_phone_no || header.CustomerPhone || '').trim();
  const pdfPhone2 = String(header.cust_phone_no_2 || '').trim();

  const nameOk = namesLooseMatch(jsonNorm.customer.name, pdfName);
  const addressOk = addressLooseMatch(jsonNorm.customer.address, pdfAddr);
  const phoneOk =
    phonesMatch(pdfPhone, jsonNorm.customer.cell) ||
    phonesMatch(pdfPhone, jsonNorm.customer.home) ||
    phonesMatch(pdfPhone2, jsonNorm.customer.cell) ||
    phonesMatch(pdfPhone2, jsonNorm.customer.home);

  return { nameOk, addressOk, phoneOk, confident: nameOk && (addressOk || phoneOk) };
}

// Whole-day difference between the ticket date and the date RV recorded, so a
// PDF from a different sale for the same customer is visible in the UI.
function daysBetween(a, b) {
  const t1 = Date.parse(a);
  const t2 = Date.parse(b);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return 0;
  return Math.abs(Math.round((t2 - t1) / 86400000));
}

// Identifies the browser, so a manually supplied SALES EDIT stays private to
// whoever uploaded it instead of becoming everyone's source of truth.
function sessionOf(req) {
  return String(req.get('X-Session-Id') || req.query.session || '').trim().slice(0, 80);
}

// Which store wrote the ticket — picks the Drive day folder to look in.
function storeOf(rec) {
  return String((rec && rec.form_json && rec.form_json.storeLocation) || '').trim().toLowerCase();
}

// Ticket types that never reach RV, so there is no sale to audit.
// "QS" is a quote sheet.
const SKIP_INVOICE_TYPES = new Set(['QS']);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mode: process.env.MODE || 'dev' });
});

// --- Customer ticket PDF from Google Drive ----------------------------------
// GET /api/customer-pdf?name=Tracy%20Hunter[&days=5]
// Streams the PDF back if found within the window, else 404s with a reason.
app.get('/api/customer-pdf', async (req, res) => {
  const name = String(req.query.name || '').trim();
  const days = Math.max(1, Math.min(60, Number(req.query.days) || 5));
  const mode = String(req.query.mode || 'auto');   // "auto" | "stream" | "redirect"
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const file = await findCustomerPdf(name, { daysBack: days });
    if (!file) return res.status(404).json({ error: `no PDF for "${name}" created in the last ${days} days` });

    // Prefer streaming; if the file is marked "no download" in Drive we get
    // a 403 "cannotDownloadFile" — fall back to the Drive viewer URL.
    if (mode === 'redirect') return res.redirect(file.webViewLink);
    try {
      const pdf = await streamPdf(file.id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${name}.pdf"`);
      res.setHeader('X-Drive-File-Id', file.id);
      res.setHeader('X-Drive-Created', file.createdTime);
      pdf.data.pipe(res);
    } catch (streamErr) {
      const status = streamErr.response && streamErr.response.status;
      if (status === 403 && mode === 'auto') {
        console.log(`customer-pdf: download blocked, redirecting to viewer: ${file.name}`);
        return res.redirect(file.webViewLink);
      }
      throw streamErr;
    }
  } catch (err) {
    console.error('customer-pdf error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Metadata-only variant for the UI — check availability without downloading.
app.get('/api/customer-pdf-info', async (req, res) => {
  const name = String(req.query.name || '').trim();
  const days = Math.max(1, Math.min(60, Number(req.query.days) || 5));
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const file = await findCustomerPdf(name, { daysBack: days });
    if (!file) return res.status(404).json({ ok: false, name });
    res.json({ ok: true, id: file.id, name: file.name, createdTime: file.createdTime, webViewLink: file.webViewLink });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stream one of the sale's own PDFs (SALES EDIT or RV RCPT) by its Drive id,
// so the audit page can open them without a second lookup. Falls back to the
// Drive viewer when the shared drive won't release the bytes.
app.get('/api/sale-pdf', async (req, res) => {
  const id = String(req.query.id || '').trim();
  const label = String(req.query.name || 'sale').replace(/[^\w .-]/g, '');
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) return res.status(400).json({ error: 'valid Drive file id required' });
  try {
    const pdf = await streamPdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${label}.pdf"`);
    pdf.data.pipe(res);
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 403) return res.redirect(`https://drive.google.com/file/d/${id}/view`);
    console.error('sale-pdf error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Manually supplied SALES EDIT --------------------------------------------
//
// For a sale whose report never reached Drive, or sits on the archive drive
// that refuses downloads, an auditor can upload the PDF themselves. The bytes
// are POSTed raw (Content-Type: application/pdf) so no multipart parser is
// needed. The file is parsed before it is kept — a wrong document is rejected
// here rather than breaking every later audit.
app.post('/api/sales-edit-upload',
  express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: '25mb' }),
  async (req, res) => {
    const date = String(req.query.date || '').trim();
    const invoiceId = String(req.query.invoiceId || '').trim();
    const originalName = String(req.query.filename || '').trim();
    const sessionId = sessionOf(req);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d+$/.test(invoiceId)) {
      return res.status(400).json({ error: 'date=YYYY-MM-DD and invoiceId required' });
    }
    if (!sessionId) return res.status(400).json({ error: 'missing session — reload the page and try again' });
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) {
      return res.status(400).json({ error: 'no file received' });
    }
    if (body.slice(0, 5).toString('latin1') !== '%PDF-') {
      return res.status(400).json({ error: 'that file is not a PDF' });
    }

    let parsed;
    try {
      const { pages } = await extractLines(body);
      parsed = parseSalesEdit(pages);
    } catch (err) {
      return res.status(400).json({
        error: `that PDF does not read as a SALES EDIT report — ${err.message}`,
      });
    }

    try {
      const file = saveSessionUpload(sessionId, date, invoiceId, body, originalName);
      console.log(`sales-edit: session upload for invoice ${invoiceId} on ${date} (sale ${parsed.header.SalesNo})`);
      res.json({
        ok: true,
        file: { name: file.name, uploadedAt: file.createdTime, expiresAt: file.expiresAt },
        salesNo: parsed.header.SalesNo,
        customerName: parsed.header.CustomerName,
        saleDate: parsed.header.SaleDate,
        itemCount: parsed.items.length,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

// Drop this browser's upload so the sale goes back to being looked up on Drive.
app.delete('/api/sales-edit-upload', (req, res) => {
  const date = String(req.query.date || '').trim();
  const invoiceId = String(req.query.invoiceId || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d+$/.test(invoiceId)) {
    return res.status(400).json({ error: 'date=YYYY-MM-DD and invoiceId required' });
  }
  res.json({ ok: true, removed: removeSessionUpload(sessionOf(req), date, invoiceId) });
});

// --- Source A: invoices-archive (Node app) -----------------------------------
//
// For each JSON invoice on the given date, look up whether that customer has a
// "<NAME> SALES EDIT.pdf" archived on Drive. This is a metadata-only Drive
// call per customer — the PDF itself is downloaded and parsed on demand when
// the invoice is actually audited.
app.get('/api/invoices', async (req, res) => {
  try {
    const date = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
    }

    const raw = await fetchInvoicesByDate(date);
    const all = (raw.data || []).map((rec) => ({ rec, norm: normalizeInvoice(rec) }));
    // Quote sheets (invoice_type "QS") are not posted sales, so there is
    // nothing in RV to audit them against. Leave them out of the list rather
    // than reporting every one as a missing RV sale.
    const records = all.filter(({ norm }) => !SKIP_INVOICE_TYPES.has(String(norm.invoiceType || '').toUpperCase()));
    const skipped = all.length - records.length;

    // Drive lookups run in parallel — a failed one only costs that row its
    // PDF badge, it never fails the list.
    const files = await Promise.all(records.map(({ rec, norm }) =>
      findSalesEditPdf(norm.customer.name, { store: storeOf(rec), date }).catch((e) => {
        console.warn(`drive lookup failed for "${norm.customer.name}": ${e.message}`);
        return null;
      }),
    ));

    const list = [];
    records.forEach(({ rec, norm }, i) => {
      const file = files[i];
      const base = {
        id: norm.id,
        slug: norm.slug,
        name: norm.customer.name,
        address: norm.customer.address,
        city: norm.customer.city,
        state: norm.customer.state,
        zip: norm.customer.zip,
        orderDate: norm.dates.order,
        total: norm.totals.total,
        invoiceType: norm.invoiceType,
        transactionMode: norm.transactionMode,
        storeLocation: (rec.form_json && rec.form_json.storeLocation) ? String(rec.form_json.storeLocation).toLowerCase() : '',
      };

      list.push({
        ...base,
        salesNo: null,              // only known once the PDF is parsed
        multiMatch: false,
        pdf: file
          ? {
            id: file.id,
            name: file.name,
            createdTime: file.createdTime,
            webViewLink: file.webViewLink,
            canDownload: !(file.capabilities && file.capabilities.canDownload === false),
          }
          : null,
      });
    });

    res.json({ ok: true, date, count: list.length, skipped, invoices: list });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

// --- Source B: the RV sale, read from its SALES EDIT PDF on Drive ------------
// Handy for checking what the name search resolves to without running an audit.
app.get('/api/sales-edit', async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const file = await findSalesEditPdf(name);
    if (!file) return res.status(404).json({ ok: false, error: `no "${name} SALES EDIT.pdf" on Drive` });
    const sale = await loadSalesEdit(file);
    res.json({ ok: true, ...sale });
  } catch (err) {
    res.status(err.code === 'DRIVE_DOWNLOAD_BLOCKED' ? 403 : 500)
      .json({ error: err.message, code: err.code });
  }
});

// --- Audit: compare one invoice against its RV SALES EDIT PDF ---------------
//
// The RV side is read straight out of Drive: search for the customer's
// "<NAME> SALES EDIT.pdf", take the first hit, parse it, and hand the result
// to the same normalizer the MSSQL rows used to go through.
app.get('/api/audit', async (req, res) => {
  try {
    const date = String(req.query.date || '').trim();
    const invoiceId = req.query.invoiceId ? Number(req.query.invoiceId) : null;
    const slug = String(req.query.slug || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
    }

    const archive = await fetchInvoicesByDate(date);
    const rec = (archive.data || []).find((r) =>
      (invoiceId && r.id === invoiceId) || (slug && r.slug === slug)
    );
    if (!rec) return res.status(404).json({ error: 'invoice not found in JSON source' });

    const jsonNorm = normalizeInvoice(rec);
    const lookupName = jsonNorm.customer.name;

    let file;
    try {
      file = await findSalesEditPdf(lookupName, {
        store: storeOf(rec), date, invoiceId: jsonNorm.id, sessionId: sessionOf(req),
      });
    } catch (e) {
      return res.json({
        ok: false,
        date,
        stage: 'drive-search',
        lookupName,
        error: `Google Drive search failed: ${e.message}`,
        json: jsonNorm,
      });
    }
    if (!file) {
      return res.json({
        ok: false,
        date,
        stage: 'drive-search',
        lookupName,
        error: `No "${lookupName} SALES EDIT.pdf" found on Google Drive.`,
        json: jsonNorm,
      });
    }

    let sale;
    try {
      sale = await loadSalesEdit(file);
    } catch (e) {
      return res.json({
        ok: false,
        date,
        stage: e.code === 'DRIVE_DOWNLOAD_BLOCKED' ? 'drive-download' : 'pdf-parse',
        lookupName,
        driveFile: { id: file.id, name: file.name, createdTime: file.createdTime, webViewLink: file.webViewLink },
        error: e.message,
        code: e.code,
        json: jsonNorm,
      });
    }

    // The lookup goes by customer name, so a customer with two sales on file
    // comes back as the most recent one for both tickets. When that one is
    // plainly not this ticket's sale and there are others, take the one that
    // is.
    // A return ticket's original sale ticket, wanted both for choosing the
    // right RV sale and for the return check itself.
    const originalRec = jsonNorm.isReturn
      ? await findOriginalInvoice(jsonNorm.returnInfo.originalInvoiceSlug, archive)
      : null;

    if ((file.alternates || []).length && !saleFitsTicket(sale, jsonNorm, originalRec)) {
      const others = [];
      for (const alt of file.alternates) {
        try { others.push({ file: alt, sale: await loadSalesEdit(alt) }); } catch (e) { /* unreadable — skip */ }
      }
      // The one with the ticket's total; failing that, the one RV dated the
      // same day as the ticket (unless the first already is).
      const sameDay = (s) => normalizeDate(s.header.SaleDate) === jsonNorm.dates.order;
      const better = others.find((o) => saleFitsTicket(o.sale, jsonNorm, originalRec))
        || (!sameDay(sale) ? others.find((o) => sameDay(o.sale)) : null);
      if (better) { file = better.file; sale = better.sale; }
    }

    const header = sale.header;
    const itemRows = sale.items;

    // How many times RV printed this sale, and whether a return was filed
    // against it — both explain why a sale no longer matches its ticket.
    const folder = await describeSaleFolder(file).catch(() => null);
    const laterReturns = jsonNorm.isReturn
      ? []
      : await findReturnsFor(rec, archive, date, folder).catch(() => []);

    // The customer receipt filed beside the SALES EDIT states the whole-sale
    // totals with one figure per label, where the SALES EDIT prints three
    // columns that only agree when nothing is back ordered. Use it to check
    // the figures, and to mark which lines are not shipping yet.
    const receipt = await loadReceiptFor(file).catch(() => null);
    const totalsCheck = [];
    if (receipt) {
      const near = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.01;
      const rt = receipt.totals || {};
      const pairs = [
        ['subtotal',   'SaleAmt',      rt.saleTotal],
        ['tax',        'SaleTaxAmt',   rt.salesTax],
        ['total',      'SaleTotalAmt', rt.grandTotal],
        ['amountPaid', 'DownPmt',      rt.paymentReceived],
        ['balanceDue', 'BalanceDue',   rt.balanceDue],
      ];
      for (const [label, key, receiptValue] of pairs) {
        if (receiptValue === null || receiptValue === undefined) continue;
        if (near(header[key], receiptValue)) continue;
        // The receipt is the unambiguous source, so it wins.
        totalsCheck.push({ field: label, salesEdit: header[key], receipt: receiptValue });
        header[key] = receiptValue;
      }

      const normId = (v) => String(v || '').trim().replace(/^0+/, '') || '0';
      const backOrdered = new Set(
        (receipt.items || []).filter((i) => i.backOrdered).map((i) => normId(i.itemId)),
      );
      for (const row of itemRows) {
        if (backOrdered.has(normId(row.sale_item))) row.__back_ordered = true;
      }

      // The SALES EDIT is the source for the customer's email, but it leaves
      // the line out when RV has none on that screen. Rather than compare the
      // Ticket against a blank, fall back to the email the receipt prints.
      if (!String(header.cust_email || '').trim() && receipt.email) {
        header.cust_email = receipt.email;
        header.__email_from_receipt = true;
        if (sale.custMaster) sale.custMaster.cust_email = receipt.email;
      }
    }

    // Gross margin comes straight off the report footer. Fall back to summing
    // the line costs when the footer didn't print it (older report layouts).
    if (header.__gross_margin_pct == null) {
      let cost = 0;
      let revenue = 0;
      for (const row of itemRows) {
        if (String(row.sale_item || '').toUpperCase().startsWith('*PKG')) continue;
        cost += (Number(row.sale_unit_cost) || 0) * (Number(row.sale_qty) || 0);
        revenue += Number(row.sale_price) || 0;
      }
      if (revenue > 0) {
        header.__total_cost = Math.round(cost * 100) / 100;
        header.__gross_margin_pct = Math.round(((revenue - cost) / revenue) * 10000) / 100;
      }
    }

    const mssqlNorm = normalizeMssqlRows([header], itemRows);
    if (mssqlNorm && header.__email_from_receipt) mssqlNorm.customer.emailFromReceipt = true;

    // Gross margin is an RV-side figure (only RV carries cost), but it applies
    // to the same sale, so surface it on both cards.
    if (header.__gross_margin_pct != null) {
      const gm = {
        grossMarginPct: header.__gross_margin_pct,
        totalCost: header.__total_cost,
      };
      if (mssqlNorm && mssqlNorm.totals) Object.assign(mssqlNorm.totals, gm);
      if (jsonNorm && jsonNorm.totals) Object.assign(jsonNorm.totals, gm);
    }

    // A return ticket is checked on its returned / replacement lines and the
    // money, not line-for-line against the whole sale.
    let result;
    if (jsonNorm.isReturn) {
      result = compareReturn(jsonNorm, mssqlNorm, {
        original: originalRec ? normalizeInvoice(originalRec) : null,
        originalLines: (originalRec && originalRec.form_json && originalRec.form_json.items) || [],
        rvRows: itemRows.map((row) => ({ itemId: row.sale_item, qty: Number(row.sale_qty) || 0 })),
        receiptRows: receipt ? (receipt.items || []).map((i) => ({ itemId: i.itemId, qty: Number(i.qty) || 0 })) : null,
      });
    } else {
      result = compare(jsonNorm, mssqlNorm);
    }
    const expectedVia = expectedDeliveryVia({
      state: (jsonNorm.customer.delivery && jsonNorm.customer.delivery.state) || jsonNorm.customer.state,
      orderDate: jsonNorm.dates.order,
      deliveryDate: jsonNorm.dates.delivery || jsonNorm.dates.pickup,
      isPickup: jsonNorm.dates.isPickup,
    });

    // Confidence checks. The Drive search matches on name alone, so flag it
    // when the PDF's own details don't back that up, or when RV booked the
    // sale on a different day than the ticket.
    const match = scoreSaleMatch(header, jsonNorm);
    const rvDate = (mssqlNorm && mssqlNorm.dates && mssqlNorm.dates.order) || '';
    // A return is written days or months after the sale it returns from, so
    // its date never lines up with the sale's — that is not a wrong file.
    const dateOffDays = (rvDate && !jsonNorm.isReturn) ? daysBetween(date, rvDate) : 0;

    // The Drive folder is named "<sale no> <CUSTOMER NAME>", so its number is
    // an independent check on the SALES-NO printed inside the PDF. They should
    // always agree; if they don't, the wrong file was picked up.
    const folderSalesNo = sale.file.folderSalesNo || '';
    const salesNoMatchesFolder = folderSalesNo
      ? String(folderSalesNo) === String(header.SalesNo || '').trim()
      : null;

    res.json({
      ok: true,
      date,
      lookupName,
      driveFile: sale.file,
      itemRowCount: itemRows.length,
      reportedLineItems: header.__line_item_count,
      manualUpload: Boolean(sale.file && sale.file.uploaded),
      manualUploadExpiresAt: (sale.file && sale.file.expiresAt) || null,
      fuzzyNameMatched: !match.nameOk,
      matchConfidence: match,
      dateOffDays,
      folderSalesNo,
      salesNoMatchesFolder,
      expectedDeliveryVia: expectedVia,
      // The report prints a delivery route label ("Delivery Van #1"), not the
      // raw DeliveryVia code, so say when the mapping was a guess.
      deliveryViaLabel: header.__deliver_label,
      deliveryViaMapped: isKnownDeliveryViaLabel(header.__deliver_label),
      receipt: receipt
        ? { id: receipt.file.id, name: receipt.file.name, payments: receipt.payments, totals: receipt.totals }
        : null,
      // Non-empty when the two RV documents disagreed; the receipt was used.
      totalsCorrectedFromReceipt: totalsCheck,
      // Every SALES EDIT print of this sale on Drive, oldest first. The audit
      // uses the newest; more than one means RV changed the sale after it
      // was first filed.
      rvPrints: (folder && folder.salesEdits.length)
        ? { count: folder.salesEdits.length, files: folder.salesEdits, used: sale.file.name, usedFiled: sale.file.createdTime }
        : null,
      // For a sale ticket: returns written against it since, and any return
      // form filed in its Drive folder.
      laterReturns,
      returnForms: jsonNorm.isReturn ? [] : ((folder && folder.returnForms) || []),
      // True when the SALES EDIT had no email and the receipt's was compared.
      emailFromReceipt: Boolean(header.__email_from_receipt),
      // raw RV data for the View-in-RV modal
      rvRaw: {
        header,
        items: itemRows,
        custMaster: sale.custMaster,
      },
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

const port = Number(process.env.PORT || 4000);
app.listen(port, '0.0.0.0', () => {
  const mode = process.env.MODE || 'dev';
  console.log(`\nSales auditing tool started (mode=${mode})\n`);
  console.log(`  Local:   http://localhost:${port}`);
  for (const url of listLanUrls(port)) {
    console.log(`  Network: ${url}`);
  }
  console.log(`\nShare a Network URL with other machines on the LAN.`);
  console.log(`(If they cannot connect, allow port ${port} through Windows Firewall.)\n`);
});

// Enumerate IPv4 LAN addresses so the user knows what URL to share.
function listLanUrls(port) {
  const os = require('os');
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        out.push(`http://${net.address}:${port}  (${name})`);
      }
    }
  }
  return out;
}
