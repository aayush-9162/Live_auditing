require('dotenv').config();
const path = require('path');
const express = require('express');

const { fetchInvoicesByDate } = require('./src/sources/invoices');
const { findCustomerPdf, streamPdf } = require('./src/sources/drive');
const { findSalesEditPdf, loadSalesEdit } = require('./src/sources/salesEdit');
const { normalizeInvoice } = require('./src/normalize/fromJson');
const { normalizeMssqlRows } = require('./src/normalize/fromMssql');
const { toFirstLast, namesLooseMatch } = require('./src/match/name');
const { addressLooseMatch } = require('./src/match/address');
const { expectedDeliveryVia } = require('./src/match/deliveryVia');
const { isKnownDeliveryViaLabel } = require('./src/match/rvCodes');
const { compare } = require('./src/compare/diff');

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
    const records = (raw.data || []).map((rec) => ({ rec, norm: normalizeInvoice(rec) }));

    // Drive lookups run in parallel — a failed one only costs that row its
    // PDF badge, it never fails the list.
    const files = await Promise.all(records.map(({ norm }) =>
      findSalesEditPdf(norm.customer.name).catch((e) => {
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

    res.json({ ok: true, date, count: list.length, invoices: list });
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
      file = await findSalesEditPdf(lookupName);
    } catch (e) {
      return res.json({
        ok: false,
        stage: 'drive-search',
        lookupName,
        error: `Google Drive search failed: ${e.message}`,
        json: jsonNorm,
      });
    }
    if (!file) {
      return res.json({
        ok: false,
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
        stage: e.code === 'DRIVE_DOWNLOAD_BLOCKED' ? 'drive-download' : 'pdf-parse',
        lookupName,
        driveFile: { id: file.id, name: file.name, createdTime: file.createdTime, webViewLink: file.webViewLink },
        error: e.message,
        code: e.code,
        json: jsonNorm,
      });
    }

    const header = sale.header;
    const itemRows = sale.items;

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

    const result = compare(jsonNorm, mssqlNorm);
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
    const dateOffDays = rvDate ? daysBetween(date, rvDate) : 0;

    res.json({
      ok: true,
      date,
      lookupName,
      driveFile: sale.file,
      itemRowCount: itemRows.length,
      reportedLineItems: header.__line_item_count,
      fuzzyNameMatched: !match.nameOk,
      matchConfidence: match,
      dateOffDays,
      expectedDeliveryVia: expectedVia,
      // The report prints a delivery route label ("Delivery Van #1"), not the
      // raw DeliveryVia code, so say when the mapping was a guess.
      deliveryViaLabel: header.__deliver_label,
      deliveryViaMapped: isKnownDeliveryViaLabel(header.__deliver_label),
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
