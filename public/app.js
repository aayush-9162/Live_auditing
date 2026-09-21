const $ = (sel) => document.querySelector(sel);

async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
}

function yesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = theme === 'light' ? '🌞' : '🌙';
}

function applySidebar(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const btn = document.getElementById('sidebarToggle');
  if (btn) {
    const span = btn.querySelector('span');
    if (span) span.textContent = collapsed ? '›' : '‹';
  }
}

async function init() {
  // Restore saved theme; default to dark
  const savedTheme = localStorage.getItem('sa-theme') || 'dark';
  applyTheme(savedTheme);
  const themeBtn = document.getElementById('themeToggle');
  if (themeBtn) themeBtn.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    localStorage.setItem('sa-theme', next);
    applyTheme(next);
  });

  // Sidebar collapse toggle
  applySidebar(localStorage.getItem('sa-sidebar') === 'collapsed');
  const sidebarBtn = document.getElementById('sidebarToggle');
  if (sidebarBtn) sidebarBtn.addEventListener('click', () => {
    const next = !document.body.classList.contains('sidebar-collapsed');
    localStorage.setItem('sa-sidebar', next ? 'collapsed' : 'open');
    applySidebar(next);
  });

  const dateInput = $('#date');
  if (dateInput && !dateInput.value) dateInput.value = yesterdayISO();

  const health = await getJSON('/api/health').catch(() => ({ mode: '?' }));
  $('#mode').textContent = `mode: ${health.mode}`;
  const hostEl = document.getElementById('hostLabel');
  if (hostEl) hostEl.textContent = window.location.host;

  $('#loadBtn').addEventListener('click', loadInvoices);

  const contentEl = document.querySelector('.content');
  const SCROLL_STEP = () => 160;
  const scrollUp = document.getElementById('scrollUp');
  const scrollDown = document.getElementById('scrollDown');
  if (scrollUp)   scrollUp.addEventListener('click',   () => contentEl.scrollBy({ top: -SCROLL_STEP(), behavior: 'smooth' }));
  if (scrollDown) scrollDown.addEventListener('click', () => contentEl.scrollBy({ top:  SCROLL_STEP(), behavior: 'smooth' }));

  // Sidebar scroll buttons — scroll the whole sidebar (brand + date + list +
  // footer all in one scroll flow).
  const sidebarEl = document.querySelector('.sidebar');
  const listUp   = document.getElementById('sidebarScrollUp');
  const listDown = document.getElementById('sidebarScrollDown');
  const LIST_STEP = 140;
  if (listUp)   listUp.addEventListener('click',   () => sidebarEl.scrollBy({ top: -LIST_STEP, behavior: 'smooth' }));
  if (listDown) listDown.addEventListener('click', () => sidebarEl.scrollBy({ top:  LIST_STEP, behavior: 'smooth' }));

  document.querySelectorAll('.store-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.store-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentStoreFilter = btn.dataset.store || '';
      applyStoreFilter();
    });
  });

  loadInvoices();
}

let currentInvoices = [];
let currentStoreFilter = '';

async function loadInvoices() {
  const date = $('#date').value;
  $('#invoiceList').innerHTML = skeleton(5);
  $('#invoiceCount').textContent = '…';
  try {
    const { invoices } = await getJSON(`/api/invoices?date=${date}`);
    currentInvoices = invoices;
    applyStoreFilter();
  } catch (e) {
    $('#invoiceList').innerHTML = `<div class="banner error">${esc(e.message)}</div>`;
    $('#invoiceCount').textContent = '!';
  }
}

function applyStoreFilter() {
  const filtered = currentStoreFilter
    ? currentInvoices.filter((inv) => (inv.storeLocation || '') === currentStoreFilter)
    : currentInvoices;
  $('#invoiceCount').textContent = filtered.length;
  renderInvoices(filtered);
}

function skeleton(n) {
  let html = '';
  for (let i = 0; i < n; i++) {
    html += `<div class="invoice-item"><div class="skeleton skeleton-row" style="width:60%"></div><div class="skeleton skeleton-row" style="width:90%"></div></div>`;
  }
  return html;
}

function renderInvoices(list) {
  if (!list.length) {
    $('#invoiceList').innerHTML = '<p class="muted" style="padding:12px 8px;font-size:13px;">No invoices for this date.</p>';
    return;
  }
  $('#invoiceList').innerHTML = list.map((inv, i) => {
    // The sale number only becomes known once the PDF is parsed, so the list
    // shows whether a SALES EDIT PDF exists for the customer instead.
    const pdfLabel = inv.pdf
      ? `${inv.pdf.canDownload ? '📄' : '🔒'} ${esc(inv.pdf.name)}`
      : '<span class="muted">no SALES EDIT pdf</span>';
    return `
      <div class="invoice-item" data-index="${i}" data-id="${inv.id}">
        <div class="iv-name">
          <span>${esc(inv.name || '—')}</span>
          <span class="iv-total">$${num(inv.total)}</span>
        </div>
        <div class="iv-sub">${esc(inv.city)}, ${esc(inv.state)} · ${esc(inv.invoiceType)} · ${esc(inv.orderDate)}</div>
        <div class="iv-sub mono-sm">${pdfLabel}</div>
      </div>`;
  }).join('');
  $('#invoiceList').querySelectorAll('.invoice-item').forEach((el) => {
    el.addEventListener('click', () => audit(Number(el.dataset.id), el));
  });
}

async function audit(invoiceId, el) {
  document.querySelectorAll('.invoice-item').forEach((e) => e.classList.remove('active'));
  el.classList.add('active');

  const date = $('#date').value;
  $('#result').className = '';
  $('#result').innerHTML = `<div class="banner" style="background:var(--surface);border-color:var(--border-soft);color:var(--text-soft);">Reading the SALES EDIT PDF for invoice ${invoiceId} from Google Drive…</div>`;
  try {
    const url = `/api/audit?date=${date}&invoiceId=${invoiceId}`;
    const data = await getJSON(url);
    renderAudit(data);
  } catch (e) {
    $('#result').innerHTML = `<div class="banner error">${esc(e.message)}<pre>${esc(JSON.stringify(e.data || {}, null, 2))}</pre></div>`;
  }
}

// The RV side comes from a "<NAME> SALES EDIT.pdf" on Google Drive, so a
// failure is one of three things: the search found nothing, Drive refused to
// hand over the file, or the PDF didn't parse. Each needs a different fix.
function rvSourceError(data) {
  const jc = (data.json && data.json.customer) || {};
  const name = data.lookupName || jc.name || '';
  const file = data.driveFile;
  const fileLine = file
    ? `<div style="margin-top:8px;">Matched file: <code>${esc(file.name)}</code>${
      file.webViewLink ? ` · <a href="${esc(file.webViewLink)}" target="_blank" rel="noopener">open in Drive</a>` : ''}</div>`
    : '';

  if (data.stage === 'drive-download') {
    return `<div class="banner error">
      <b>Drive will not release this PDF.</b>
      <div style="margin-top:8px;">${esc(data.error || '')}</div>
      ${fileLine}
      <div style="margin-top:10px;">Fix: give the account the app signs in as <b>Content manager</b> on that shared drive, or turn off the “viewers cannot download” restriction for it.</div>
    </div>`;
  }

  if (data.stage === 'pdf-parse') {
    return `<div class="banner error">
      <b>Could not read the SALES EDIT PDF.</b>
      <div style="margin-top:8px;">${esc(data.error || '')}</div>
      ${fileLine}
      <div style="margin-top:10px;">The file may be a different report, a scan with no text layer, or a layout this parser hasn't seen.</div>
    </div>`;
  }

  const looksLikeTest = /test|dummy|sample|^\s*$/i.test(jc.name || '');
  const reasons = [
    'The sale was written up on a Ticket but never posted to RV, so no SALES EDIT was archived',
    'RV spells the customer name differently from the Ticket (try searching Drive by hand)',
    'The PDF is filed under a name that does not contain the words “SALES EDIT”',
    looksLikeTest ? 'The Ticket name looks like a test entry, not a real customer' : null,
  ].filter(Boolean);

  return `<div class="banner warn">
    <b>No RV sale found on Drive for this Ticket.</b>
    <div style="margin-top:8px;">Searched Google Drive for <code>${esc(name)} SALES EDIT.pdf</code> and got no usable hit.</div>
    <div style="margin-top:10px;"><b>Ticket data:</b></div>
    <ul style="margin:6px 0 0 18px;">
      <li>Name: <code>${esc(jc.name || '—')}</code></li>
      <li>Address: <code>${esc(jc.address || '—')}, ${esc(jc.city || '')} ${esc(jc.state || '')} ${esc(jc.zip || '')}</code></li>
      <li>Phone: <code>${esc(jc.cell || '—')}</code></li>
      <li>Date: <code>${esc(data.date || '')}</code></li>
    </ul>
    <div style="margin-top:10px;"><b>Likely reasons:</b></div>
    <ul style="margin:6px 0 0 18px;">${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
  </div>`;
}

let currentAuditData = null;
let hideMatchedRows = true;   // default: hide rows that match
function renderAudit(data) {
  currentAuditData = data;
  if (data.ok === false) {
    $('#result').innerHTML = rvSourceError(data);
    return;
  }
  if (!data.matched) {
    $('#result').innerHTML = rvSourceError({ ...data, stage: 'drive-search' });
    return;
  }

  const { diffs, json, mssql } = data;

  const grpCount = (g) => diffs.filter((d) => d.group === g && d.field !== '_note').length;
  const totalReal = diffs.filter((d) => d.field !== '_note').length;

  const diffSet = new Set(diffs.map((d) => `${d.group}/${d.field}`));

  // Compute a stable item ordering: JSON's items first (in order), then any
  // RV-only items at the end. Both side cards render this same sequence.
  const itemOrder = computeItemOrder(json.items, mssql.items);

  const status = totalReal === 0
    ? `<div class="status-badge ok"><span class="dot"></span>All match</div>`
    : `<div class="status-badge warn"><span class="dot"></span>${totalReal} mismatch${totalReal === 1 ? '' : 'es'}</div>`;

  const noTaxBanner = json.noTaxSale
    ? `<div class="banner ok" style="margin-bottom:14px;"><b>No-Tax Sale.</b> Ticket flagged as <code>"No Sales Tax"</code> in notes/override-reason — tax and total comparisons are skipped.</div>`
    : '';

  let fuzzyBanner = '';
  if (data.dateOffDays > 0) {
    fuzzyBanner = `<div class="banner warn" style="margin-bottom:14px;"><b>Date mismatch.</b> Ticket is dated <code>${esc(data.date)}</code> but the SALES EDIT PDF (sale #${esc(mssql.salesNo)}) is on <code>${esc(mssql.dates && mssql.dates.order || '?')}</code> — <b>${data.dateOffDays} day(s) off</b>. Drive may have returned an older sale for this customer. Verify before trusting the audit.</div>`;
  } else if (data.fuzzyNameMatched) {
    fuzzyBanner = `<div class="banner warn" style="margin-bottom:14px;"><b>Name does not line up.</b> Ticket says <code>${esc(json.customer.name)}</code> but the PDF is for <code>${esc(mssql.customer.name)}</code>. The Drive search matches on name alone — verify this is the right customer.</div>`;
  }

  // The report prints a delivery route label rather than the raw code, so say
  // so when the label wasn't one this app knows how to translate.
  // The Drive folder name carries the sale number; disagreeing with the PDF
  // means the search resolved to the wrong file.
  const folderBanner = data.salesNoMatchesFolder === false
    ? `<div class="banner error" style="margin-bottom:14px;"><b>Wrong file?</b> The Drive folder is numbered <code>${esc(data.folderSalesNo)}</code> but the PDF inside it reports sale <code>${esc(mssql.salesNo)}</code>. Check the file before trusting this audit.</div>`
    : '';

  const viaBanner = (data.deliveryViaLabel && data.deliveryViaMapped === false)
    ? `<div class="banner warn" style="margin-bottom:14px;"><b>Unrecognised delivery route.</b> The PDF says <code>${esc(data.deliveryViaLabel)}</code>, which doesn't map to a known RV DeliveryVia code — it is being compared as-is. Add it to <code>RV_DELIVERY_VIA_MAP</code> in <code>.env</code> to fix the comparison.</div>`
    : '';

  const sourceLine = data.driveFile
    ? `<div class="audit-sub mono-sm">RV source: <a href="${esc(data.driveFile.webViewLink || '#')}" target="_blank" rel="noopener">${esc(data.driveFile.name)}</a></div>`
    : '';

  $('#result').className = '';
  $('#result').innerHTML = `
    <div class="audit-header">
      <div class="audit-title">
        <h1>${esc(json.customer.name)}</h1>
        <div class="audit-sub">invoice #${esc(json.id)} · ${esc(json.slug)} · sale #${esc(mssql.salesNo || '—')}</div>
        ${sourceLine}
      </div>
      <div class="audit-header-right">
        <button id="toggleMatched" class="ghost small-btn" title="Toggle visibility of matched fields">
          ${hideMatchedRows ? 'Show all fields' : 'Hide matched fields'}
        </button>
        ${deliveryViaBadge(mssql.deliveryVia, data.expectedDeliveryVia)}
        ${status}
      </div>
    </div>

    ${noTaxBanner}
    ${fuzzyBanner}
    ${folderBanner}
    ${viaBanner}

    <div class="summary-chips">
      ${chip('Customer', grpCount('customer'))}
      ${chip('Dates',    grpCount('dates'))}
      ${chip('Totals',   grpCount('totals'))}
      ${chip('Items',    grpCount('items'))}
      ${(json.packages || []).length || (mssql.packages || []).length ? chip('Packages', grpCount('packages')) : ''}
      ${gmChip(mssql.totals)}
    </div>

    <div class="compare-grid">
      ${sideCard('Ticket', 'invoices-archive', json, 'json', diffSet, itemOrder,
        `<button id="viewTicketPdf" class="view-pdf-btn" data-name="${esc(json.customer.name)}" title="Open the customer ticket PDF from Google Drive">📄 View Ticket PDF</button>`)}
      ${sideCard('RV',     'SALES EDIT pdf',  mssql, 'mssql', diffSet, itemOrder,
        `<button id="openRvViewer" class="view-rv-btn">📋 View in RV</button>`)}
    </div>

    ${diffsTable(diffs)}
  `;

  const openBtn = document.getElementById('openRvViewer');
  if (openBtn) openBtn.addEventListener('click', () => {
    const d = currentAuditData || {};
    const date = d.date || $('#date').value;
    const inv = d.json && d.json.id;
    if (!inv) return;
    const params = new URLSearchParams({ date, invoiceId: inv });
    window.open(`/rv.html?${params.toString()}`, '_blank', 'noopener');
  });

  const pdfBtn = document.getElementById('viewTicketPdf');
  if (pdfBtn) pdfBtn.addEventListener('click', () => {
    const name = pdfBtn.dataset.name || '';
    if (!name) return;
    window.open(`/api/customer-pdf?name=${encodeURIComponent(name)}`, '_blank', 'noopener');
  });
  const toggleBtn = document.getElementById('toggleMatched');
  if (toggleBtn) toggleBtn.addEventListener('click', () => {
    hideMatchedRows = !hideMatchedRows;
    renderAudit(currentAuditData);
  });
}

// ------------------------------- RV Viewer modal --------------------------
function openRvViewer(data) {
  const rv = (data && data.rvRaw) || {};
  const diffs = (data && data.diffs) || [];
  const sellers = (data && data.json && data.json.sellerNames) || [];
  const dlg = document.getElementById('rvViewer');
  document.getElementById('rvViewerContent').innerHTML = renderRvViewer(rv, diffs, sellers);
  dlg.showModal();
  const closeBtn = dlg.querySelector('.rv-close');
  if (closeBtn) closeBtn.onclick = () => dlg.close();
}

function renderRvViewer(rv, diffs = [], sellers = []) {
  // Index diffs for fast per-field lookups
  const diffSet = new Set(diffs.map((d) => `${d.group}/${d.field}`));
  const has = (key) => diffSet.has(key);
  const cls = (key) => has(key) ? 'class="rv-mismatch"' : '';
  const h  = rv.header || {};
  const cm = rv.custMaster || {};
  const items = rv.items || [];

  const cleanStr = (s) => String(s ?? '').replace(/\s+$/g, '').trim();
  const fmtPhone = (s) => {
    const d = String(s || '').replace(/\D/g, '');
    if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
    return cleanStr(s);
  };
  const fmtMoney = (v) => {
    const n = Number(v) || 0;
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const fmtDate = (s) => {
    const str = String(s || '');
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[2]}/${m[3]}/${m[1].slice(2)}`;
    return cleanStr(s);
  };

  const cellPhone  = fmtPhone(cm.cust_phone_no   || h.CustomerPhone);
  const homePhone  = fmtPhone(cm.cust_phone_no_2 || '');
  const custId     = (() => { const v = cleanStr(h.CustomerId); return /^\d+$/.test(v) ? (v.replace(/^0+/, '') || '0') : v; })();
  const salesNo    = cleanStr(h.SalesNo);
  const saleDate   = fmtDate(h.SaleDate);
  const profitCtr  = items[0] ? cleanStr(items[0].sale_profit_ctr) : '';

  // billing is the PDF's bill-to column, delivery its SHIP TO column
  const billName    = cleanStr(cm.cust_nam).split('|').pop().trim() || cleanStr(h.CustomerName);
  const billAddr    = cleanStr(cm.cust_st_1);
  const billCSZ     = `${cleanStr(cm.cust_city)}, ${cleanStr(cm.cust_state)} ${cleanStr(cm.cust_zip_cod)}`.replace(/^,\s*/, '').trim();
  const delivName   = cleanStr(h.DeliveryName);
  const delivAddr   = cleanStr(h.DeliveryAddr1);
  const delivAddr2  = cleanStr(h.DeliveryAddr2);
  const delivCSZ    = `${cleanStr(h.DeliveryCity)}, ${cleanStr(h.DeliveryState)} ${cleanStr(h.DeliveryZip)}`.trim();
  const salesperson = cleanStr(h.Salesperson);
  const sellerMatch = (sellers || []).find((s) => (s.rv_code || '').toUpperCase() === salesperson.toUpperCase());
  const salespersonName = sellerMatch ? sellerMatch.name.toUpperCase() : spFullName(salesperson);
  const deliveryVia = cleanStr(h.DeliveryVia);
  // Desc #2 + Label ID from the first product item (mirrors the desktop app)
  const firstItem = (items || []).find((it) => {
    const id = cleanStr(it.sale_item);
    return id && !id.startsWith('*PKG');
  }) || {};
  const desc2Val = cleanStr(firstItem.sale_desc2);
  const labelIdVal = cleanStr(firstItem.__label_id);
  const deliveryDate = cleanStr(h.DeliveryDate);
  const terms       = cleanStr(h.Terms);
  const emailRaw    = cleanStr(cm.cust_email);
  const email       = emailRaw || 'Email Address not on File';
  const remarks     = cleanStr(h.SaleRemarks);
  const balanceDue  = Number(h.BalanceDue) || 0;
  const pcValue     = profitCtr || String(cleanStr(h.SalesNo))[0] || '';
  // Opportunity ID — not stored in DB; derived from SalesNo low 5 digits
  // so the display has a stable value like the Sales screen shows.
  const opportunityId = String(cleanStr(h.SalesNo)).slice(-5);

  // Right-side label — "Pickup"/"Delivery" prefix + raw code + the date/ASAP.
  const vanLabel = (() => {
    if (!deliveryVia) return '';
    const c = deliveryVia.toUpperCase();
    const kind = c.startsWith('P') ? 'Pickup' : (c.startsWith('D') ? 'Delivery' : '');
    const when = deliveryDate ? ` — ${deliveryDate}` : '';
    return kind ? `${kind} ${c}${when}` : `${c}${when}`;
  })();

  // Per-item diff helpers — the diff keys use the normalized itemId label.
  const normItemId = (id) => {
    const v = String(id || '').trim().toLowerCase();
    if (!v) return '';
    return /^\d+$/.test(v) ? (v.replace(/^0+/, '') || '0') : v;
  };
  const itemHas = (id, field) => has(`items/${normItemId(id)}/${field}`);
  const itemCls = (id, field) => itemHas(id, field) ? 'class="rv-mismatch"' : '';

  const stripZeros = (id) => {
    const v = cleanStr(id);
    return /^\d+$/.test(v) ? (v.replace(/^0+/, '') || '0') : v;
  };
  const itemRows = items.map((it) => {
    const itemId = stripZeros(it.sale_item);
    const isPkg  = itemId.startsWith('*PKG');
    const type   = isPkg ? 'P' : 'C';
    const qty    = Number(it.sale_qty) || 0;
    const bo     = Number(it.sale_qty_bo) || 0;
    const unitPrice = qty ? (Number(it.sale_price) / qty) : Number(it.sale_price);
    const ext       = Number(it.sale_price) || 0;
    const ovr       = 'N';
    const disc      = Number(it.sale_disc_amt) || 0;
    // PO/Loc — prefer the detailed "BLDG A L B" from salesitemdetail; fall
    // back to sale_loc. Prefix with "T" for transfer items.
    const detailLoc = cleanStr(it.__loc_detail);
    const rawLoc    = detailLoc || cleanStr(it.sale_loc) || '';
    const poLoc     = it.__transfer ? `T ${rawLoc}`.trim() : rawLoc;
    const isMissing = itemHas(itemId, 'missing-in-json:' + normItemId(itemId)) ||
                      diffs.some((d) => d.field === `missing-in-json:${normItemId(itemId)}`);
    const rowCls = isMissing ? 'class="rv-row-missing"' : '';
    return `
      <tr ${rowCls}>
        <td class="c">${esc(type)}</td>
        <td ${itemCls(itemId, 'sku+cover')}>${esc(itemId)}</td>
        <td ${itemCls(itemId, 'description')}>${esc(cleanStr(it.sale_desc))}</td>
        <td class="r ${itemHas(itemId, 'qty') ? 'rv-mismatch' : ''}">${qty || ''}</td>
        <td class="r">${bo || ''}</td>
        <td class="r ${itemHas(itemId, 'extPrice') ? 'rv-mismatch' : ''}">${fmtMoney(unitPrice)}</td>
        <td class="c">${esc(ovr)}</td>
        <td class="r">${disc ? fmtMoney(disc) : ''}</td>
        <td class="r ${itemHas(itemId, 'extPrice') ? 'rv-mismatch' : ''}">${fmtMoney(ext)}</td>
        <td class="${it.__transfer ? 'rv-transfer-cell' : ''}">${esc(poLoc)}</td>
      </tr>`;
  }).join('');

  const subtotal = Number(h.SaleAmt) || 0;
  const tax      = Number(h.SaleTaxAmt) || 0;
  const total    = Number(h.SaleTotalAmt) || 0;
  const totalCost = Number(h.__total_cost) || 0;
  const gmPct     = h.__gross_margin_pct === undefined ? NaN : Number(h.__gross_margin_pct);
  const gmClass   = !isFinite(gmPct) ? '' : gmPct >= 45 ? 'rv-gm-ok' : gmPct >= 30 ? 'rv-gm-warn' : 'rv-gm-bad';

  return `
  <div class="rv-app">
    <div class="rv-titlebar">
      <span class="rv-title">Sales</span>
      <div class="rv-titlebar-btns">
        <button class="rv-tb-btn" disabled>—</button>
        <button class="rv-tb-btn" disabled>☐</button>
        <button class="rv-tb-btn rv-close">✕</button>
      </div>
    </div>
    <div class="rv-menubar"><span>File</span><span>Activities</span><span>View</span><span>Help</span></div>

    <div class="rv-body">
      <div class="rv-rail">
        <button class="rv-rail-btn"><span class="rv-icon rv-icon-update">↻</span><span>Update</span></button>
        <button class="rv-rail-btn"><span class="rv-icon rv-icon-bill">📋</span><span>Bill</span></button>
        <button class="rv-rail-btn"><span class="rv-icon rv-icon-sales">👤</span><span>Salespeople</span></button>
        <button class="rv-rail-btn"><span class="rv-icon rv-icon-tax">💰</span><span>Calculate Tax</span></button>
      </div>

      <div class="rv-content">
        <div class="rv-top-grid">
          <div class="rv-phones">
            <label class="rv-phones-label">Cell</label>
            <div class="rv-phones-stack">
              <input type="text" value="${esc(cellPhone)}" readonly ${cls('customer/cell')}>
              <input type="text" value="${esc(homePhone === cellPhone ? '' : homePhone)}" readonly ${cls('customer/home')}>
              <input type="text" value="" readonly>
            </div>
          </div>
          <div class="rv-id-row">
            <div class="rv-id-field"><label>Customer ID</label><input value="${esc(custId)}" readonly></div>
            <div class="rv-id-field"><label>Sale Number</label><input value="${esc(salesNo)}" readonly></div>
            <div class="rv-id-field"><label>Date</label><input value="${esc(saleDate)}" readonly ${cls('dates/order')}></div>
            <div class="rv-id-field rv-id-pc"><label>PC</label><input value="${esc(pcValue)}" readonly></div>
          </div>
        </div>

        <div class="rv-addr-grid">
          <div class="rv-addr-block">
            <div class="rv-name ${has('customer/name') ? 'rv-mismatch-text' : ''}">${esc(billName)}</div>
            <input value="${esc(billAddr)}" readonly ${cls('customer/address')}>
            <input value="${esc(billCSZ)}" readonly>
          </div>
          <div class="rv-opportunity">
            <span class="rv-opportunity-label">Opportunity</span>
            <input value="${esc(opportunityId)}" readonly class="rv-opp-input">
            <div class="rv-balance ${has('totals/balanceDue') ? 'rv-mismatch-text' : ''}">${balanceDue > 0 ? 'Balance Due' : ''}</div>
          </div>
          <div class="rv-deliver-icon">
            <div class="rv-truck-icon">🚚</div>
            <div class="rv-deliver-text">Deliver To</div>
          </div>
          <div class="rv-addr-block">
            <div class="rv-name ${has('customer/name') ? 'rv-mismatch-text' : ''}">${esc(delivName)}</div>
            <input value="${esc(delivAddr)}" readonly ${cls('customer/address')}>
            <input value="${esc(delivCSZ)}" readonly>
          </div>
        </div>

        <div class="rv-sales-row">
          <select disabled><option>${esc(salespersonName)}</option></select>
          <input value="${esc(salesperson)}" class="rv-sm" readonly>
          <input value="" class="rv-sm" readonly>
          <input value="" class="rv-sm" readonly>
          <input value="${esc(vanLabel)}" class="rv-van" readonly ${cls('dates/deliveryVia')}>
          <span class="rv-terms-text ${has('totals/terms') ? 'rv-mismatch-text' : ''}">${esc(termsText(terms))}</span>
        </div>

        <div class="rv-toolbar">
          <button><span class="rv-tb-icon">💰</span>Calculate Tax</button>
          <button><span class="rv-tb-icon">➕</span>Insert Detail Item</button>
          <button><span class="rv-tb-icon">↻</span>Refresh Items</button>
          <button><span class="rv-tb-icon">📅</span>Update Dates</button>
          ${renderDateInfo(deliveryDate, deliveryVia, has('dates/delivery'))}
          <button><span class="rv-tb-icon">💵</span>Cash Receipts</button>
          <button><span class="rv-tb-icon">📌</span>Select for Posting</button>
          <button><span class="rv-tb-icon">📄</span>Payment Terms</button>
        </div>

        <div class="rv-items-wrap">
          <table class="rv-items">
            <thead>
              <tr>
                <th>Type</th><th>Item ID</th><th>Description</th>
                <th>Qty Ord</th><th>Qty B/O</th>
                <th>Unit Price</th><th>Ovr</th><th>Disc.</th>
                <th>Extended</th><th>PO / Loc</th>
              </tr>
            </thead>
            <tbody>${itemRows}</tbody>
          </table>
        </div>

        <div class="rv-detail-row">
          <div><label>Desc #2</label><input value="${esc(desc2Val)}" readonly></div>
          <div><label>Serial No</label><input readonly></div>
        </div>
        <div class="rv-detail-row">
          <div><label>Label ID</label><input value="${esc(labelIdVal)}" readonly></div>
          <div></div>
        </div>
        <div class="rv-detail-row">
          <div><label>Email</label><input value="${esc(email)}" readonly ${cls('customer/email')}></div>
          <div></div>
        </div>

        <div class="rv-bottom-grid">
          <div class="rv-remarks-block">
            <label>Sales Remarks</label>
            <textarea readonly>${esc(remarks)}</textarea>
            <div class="rv-radios">
              <label><input type="radio" checked disabled>Sale Only</label>
              <label><input type="radio" disabled>Order Only</label>
              <label><input type="radio" disabled>Both</label>
            </div>
          </div>
          <div class="rv-totals-block">
            ${isFinite(gmPct) ? `<div class="rv-gm-row ${gmClass}"><span>Gross Margin</span><span class="rv-gm-pct">${fmtMoney(gmPct)}%</span><span class="rv-gm-cost">cost ${fmtMoney(totalCost)}</span></div>` : ''}
            <div class="rv-tot-row"><span>Sale Total</span><span class="rv-num ${has('totals/subtotal') ? 'rv-mismatch' : ''}">${fmtMoney(subtotal)}</span></div>
            <div class="rv-tot-row"><span>TAX(RET)</span><span class="rv-num ${has('totals/tax') ? 'rv-mismatch' : ''}">${fmtMoney(tax)}</span></div>
            <div class="rv-tot-row rv-grand"><span>Total</span><span class="rv-num ${has('totals/total') ? 'rv-mismatch' : ''}">${fmtMoney(total)}</span></div>
            <div class="rv-tot-row"><span>Amount Paid</span><span class="rv-num ${has('totals/amountPaid') ? 'rv-mismatch' : ''}">${fmtMoney(Number(h.DownPmt) || 0)}</span></div>
            <div class="rv-tot-row"><span>Balance Due</span><span class="rv-num ${has('totals/balanceDue') ? 'rv-mismatch' : ''}">${fmtMoney(balanceDue)}</span></div>
            <div class="rv-tot-row"><span>Number of sales form copies</span><span class="rv-num small">1</span></div>
            <div class="rv-tot-row"><span>Number of delivery receipt copies</span><span class="rv-num small">1</span></div>
          </div>
        </div>

        <div class="rv-action-bar">
          <button><span class="rv-aicon">➕</span>Add</button>
          <button><span class="rv-aicon">💾</span>Save</button>
          <button><span class="rv-aicon">🗑</span>Delete</button>
          <button><span class="rv-aicon">🧹</span>Clear</button>
          <button><span class="rv-aicon">🧮</span>Sale Totals</button>
          <button><span class="rv-aicon">📧</span>Email Receipt</button>
          <button><span class="rv-aicon">🚚</span>Print Delivery Receipt</button>
          <button><span class="rv-aicon">🖨</span>Print Sale</button>
          <button><span class="rv-aicon">🖨</span>Print Sales Edit</button>
          <button><span class="rv-aicon">📌</span>Post Sales</button>
          <button class="rv-exit-btn"><span class="rv-aicon">↪</span>Exit</button>
        </div>
      </div>
    </div>
  </div>`;
}

// Show both Delivery and Pickup date labels; populate the one that matches
// the DeliveryVia code, leave the other blank. Highlights in red if there's
// a delivery-date mismatch with the Ticket side.
function renderDateInfo(date, via, isMismatch) {
  const code = String(via || '').trim().toUpperCase();
  const isPickup = code.startsWith('P');
  const isDelivery = code.startsWith('D');
  const cls = isMismatch ? 'rv-mismatch-text' : '';
  const delivVal = isDelivery ? (date || '—') : '—';
  const pickupVal = isPickup  ? (date || '—') : '—';
  return `
    <span class="rv-tb-info ${isDelivery ? cls : ''}">🚛 Delivery: ${esc(delivVal)}</span>
    <span class="rv-tb-info ${isPickup ? cls : ''}">🏬 Pickup: ${esc(pickupVal)}</span>`;
}

function spFullName(code) {
  // Tiny lookup for known salesperson codes; falls back to the code itself.
  const map = {
    JRW: 'JON WEIDENMILLER',
    DTO: 'DONNA OWLE',
    BJT: 'BILLY/CAROL TERRY',
    JCC: 'JOE COLE',
  };
  return map[code] || code;
}

function termsText(t) {
  const map = { PIF: 'PAID IN FULL', COD: 'COLLECT ON DELIVERY', WFF: 'WELLS FARGO FINANCE' };
  return map[(t || '').toUpperCase()] || t || '';
}

// Same scheme as the backend itemKey — collapse non-alphanumeric in
// sku+cover for star/generic items so parsing differences don't break match.
function itemKeyFor(it) {
  if (!it) return '';
  const raw = String(it.itemId || '').trim().toLowerCase();
  const id = raw && /^\d+$/.test(raw) ? (raw.replace(/^0+/, '') || '0') : raw;
  if (id && !id.startsWith('*')) return id;
  const sig = [it.sku, it.cover].filter(Boolean).join(' ').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (id) return sig ? `${id}|${sig}` : id;
  return sig;
}

function computeItemOrder(jsonItems, mssqlItems) {
  const order = [];
  const seen = new Set();
  for (const it of jsonItems || []) {
    const k = itemKeyFor(it);
    if (k && !seen.has(k)) { seen.add(k); order.push(k); }
  }
  for (const it of mssqlItems || []) {
    const k = itemKeyFor(it);
    if (k && !seen.has(k)) { seen.add(k); order.push(k); }
  }
  return order;
}

function findItemByKey(items, key) {
  for (const it of items || []) {
    if (itemKeyFor(it) === key) return it;
  }
  return null;
}


function chip(label, count) {
  const cls = count === 0 ? 'ok' : 'warn';
  return `
    <div class="chip ${cls}">
      <span class="chip-label">${esc(label)}</span>
      <span class="chip-value">${count}</span>
    </div>`;
}

function gmChip(totals) {
  const t = totals || {};
  if (t.grossMarginPct == null) return '';
  const pct = Number(t.grossMarginPct) || 0;
  const cls = pct >= 45 ? 'ok' : pct >= 30 ? 'warn' : 'error';
  return `
    <div class="chip chip-gm ${cls}" title="Total cost: $${num(t.totalCost || 0)}">
      <span class="chip-label">Gross Margin</span>
      <span class="chip-value">${num(pct)}%</span>
    </div>`;
}

function gmBadge(rec) {
  const t = rec.totals || {};
  if (t.grossMarginPct == null) return '';
  const pct = Number(t.grossMarginPct) || 0;
  // Color-coded: green for healthy (>= 45%), amber for borderline, red for low
  const cls = pct >= 45 ? 'gm-ok' : pct >= 30 ? 'gm-warn' : 'gm-bad';
  return `<span class="gm-badge ${cls}" title="Total Cost: $${num(t.totalCost || 0)}">GM ${num(pct)}%</span>`;
}

function sideCard(title, source, rec, side, diffSet, itemOrder, extraAction = '') {
  const c = rec.customer || {};
  const d = rec.dates || {};
  const t = rec.totals || {};

  const bill = c.billing  || {};
  const dlv  = c.delivery || {};

  const headerRows = [
    ['customer/name',                 'Name',           c.name],
    ['customer/cell',                 'Phone',          formatPhone(c.cell)],
    ['customer/email',                'Email',          c.email],
    // billing
    ['__SECTION__',                   'BILLING ADDRESS', ''],
    ['customer/billing.address',      'Address',        bill.address],
    ['customer/billing.city',         'City',           bill.city],
    ['customer/billing.state',        'State',          bill.state],
    ['customer/billing.zip',          'Zip',            bill.zip],
    // delivery
    ['__SECTION__',                   'DELIVERY ADDRESS', ''],
    ['customer/delivery.address',     'Address',        dlv.address],
    ['customer/delivery.city',        'City',           dlv.city],
    ['customer/delivery.state',       'State',          dlv.state],
    ['customer/delivery.zip',         'Zip',            dlv.zip],
    // dates & totals
    ['__SECTION__',                   '',               ''],
    ['dates/order',                   'Order',          d.order],
    deliveryRowFor(d, side, rec),
    ['totals/subtotal',               'Subtotal',       '$' + num(t.subtotal)],
    ['totals/tax',                    'Tax',            '$' + num(t.tax)],
    ['totals/total',                  'Total',          '$' + num(t.total)],
    ['totals/amountPaid',             'Paid',           '$' + num(t.amountPaid)],
    ['totals/balanceDue',             'Balance',        '$' + num(t.balanceDue)],
    ['totals/terms',                  'Terms',          t.terms],
    ['__SECTION__',                   'FEES',           ''],
    ['totals/fees.deliveryCharge',    'Delivery',       '$' + num((rec.fees||{}).deliveryCharge)],
    ['totals/fees.carePlanCharge',    'Care Plan',      '$' + num((rec.fees||{}).carePlanCharge)],
  ];

  // When hide-matched is on, suppress rows that aren't in diffSet, and drop
  // section headers that end up with no visible rows underneath.
  const builtRows = [];
  for (let i = 0; i < headerRows.length; i++) {
    const [key, label, value, suffixHtml, labelExtraClass] = headerRows[i];
    if (key === '__SECTION__') {
      builtRows.push({ kind: 'section', label });
      continue;
    }
    let isDiff = diffSet.has(key);
    if (hideMatchedRows && !isDiff) continue;
    builtRows.push({ kind: 'row', label, value, isDiff, suffixHtml, labelExtraClass });
  }
  // Drop empty sections (header with no following rows before next section)
  const compactRows = [];
  for (let i = 0; i < builtRows.length; i++) {
    const r = builtRows[i];
    if (r.kind === 'section') {
      const next = builtRows[i + 1];
      if (!next || next.kind === 'section') continue;
    }
    compactRows.push(r);
  }
  const headerHtml = compactRows.map((r) => {
    if (r.kind === 'section') {
      return r.label ? `<div class="card-mini-section">${esc(r.label)}</div>` : `<div class="card-mini-gap"></div>`;
    }
    return fieldRow(r.label, r.value, r.isDiff, r.suffixHtml, r.labelExtraClass);
  }).join('') || (hideMatchedRows ? '<div class="muted" style="padding:14px 4px;font-size:12.5px;">All header fields match.</div>' : '');

  // Always render the NOTES section so both side cards stay aligned even
  // when one side has no notes. Empty side shows a faint placeholder.
  const notesHtml = `
    <div class="card-mini-section">NOTES</div>
    <div class="notes-block${rec.notes ? '' : ' empty'}">${rec.notes ? esc(rec.notes) : '(no notes)'}</div>`;

  const packagesHtml = renderPackagesSection(rec.packages, diffSet);
  const itemsHtml = renderItemsSection(rec.items, itemOrder, diffSet);

  return `
    <div class="compare-card">
      <div class="card-head">
        <div style="display:flex;align-items:center;gap:10px;">
          <h3>${esc(title)}</h3>
          ${side === 'mssql' && rec.salesNo ? `<span class="sale-no-label">Sale #${esc(rec.salesNo)}</span>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          ${extraAction}
        </div>
      </div>
      <div class="card-body">
        ${headerHtml}
        ${notesHtml}
        ${packagesHtml}
        ${itemsHtml}
      </div>
    </div>`;
}

function deliveryViaBadge(via, expected) {
  if (!via && !expected) return '';
  const code = String(via || '').trim().toUpperCase();
  const exp  = expected ? String(expected).trim().toUpperCase() : null;
  const isDelivery = (code || exp || '').startsWith('D');
  const icon = isDelivery ? '🚚' : '🏬';
  const label = isDelivery ? 'Delivery via' : 'Pickup at';
  const mismatch = exp && code && exp !== code;
  const match    = exp && code && exp === code;
  const cls = mismatch ? 'via-mismatch' : (match ? 'via-ok' : (isDelivery ? 'via-delivery' : 'via-pickup'));

  let trailing = '';
  if (mismatch) {
    trailing = `<span class="via-expected" title="expected by delivery-via rules">expected ${esc(exp)}</span>`;
  } else if (match) {
    trailing = `<span class="via-check" title="matches expected ${esc(exp)}">✓</span>`;
  }

  return `
    <div class="via-badge ${cls}" title="RV delivery route (DeliveryVia)">
      <span class="via-icon">${icon}</span>
      <span class="via-label">${esc(label)}</span>
      <span class="via-code">${esc(code || '—')}</span>
      ${trailing}
    </div>`;
}

// Build the Delivery/Pickup field-row spec per side. Returns a 5-tuple:
// [diff-key, label, value, suffixHtml, labelExtraClass]
function deliveryRowFor(d, side, rec) {
  const tag = side === 'json' ? deliveryTypeTag(d) : '';
  const via = side === 'mssql' ? String(rec.deliveryVia || '').toUpperCase() : '';
  const isPickup = side === 'json'
    ? !!(d && d.isPickup)
    : via.startsWith('P');
  const label = isPickup ? 'Pickup' : 'Delivery';
  const viaBadge = via ? ` <span class="row-via-badge ${via.startsWith('P') ? 'via-pickup-inline' : 'via-delivery-inline'}">${esc(via)}</span>` : '';
  return ['dates/delivery', label, d.effective, tag + viaBadge, isPickup ? 'k-bold' : ''];
}

function deliveryTypeTag(d) {
  if (!d || !d.deliveryOption) return '';
  let label = '', cls = '';
  switch (d.deliveryOption.toLowerCase()) {
    case 'pickup_asap':        label = 'pickup ASAP'; cls = 'tag-pickup'; break;
    case 'pickup_on_date':     label = 'pickup';      cls = 'tag-pickup'; break;
    case 'delivery_asap':      label = 'ASAP';        cls = 'tag-delivery'; break;
    case 'delivery_scheduled': label = 'scheduled';   cls = 'tag-delivery'; break;
    default:                   label = d.deliveryOption; cls = '';
  }
  return ` <span class="opt-tag ${cls}">${esc(label)}</span>`;
}

function fieldRow(label, value, isDiff, suffixHtml = '', labelExtraClass = '') {
  const empty = (value === '' || value === undefined || value === null);
  const cls = ['v'];
  if (isDiff) cls.push('diff');
  if (empty) cls.push('empty');
  return `
    <div class="field-row">
      <div class="k ${labelExtraClass}">${esc(label)}</div>
      <div class="${cls.join(' ')}">${empty ? '—' : esc(value)}${suffixHtml || ''}</div>
    </div>`;
}

// Render an items section inside a side card. Both cards receive the same
// itemOrder so item N on the left aligns with item N on the right.
// Packages are priced as a whole: the Ticket leaves every member line at 0
// and RV allocates the total across them. Showing the package alongside its
// members is the only way either side's item prices make sense.
function renderPackagesSection(packages, diffSet) {
  const list = packages || [];
  if (!list.length) return '';

  const touched = [...diffSet].filter((f) => f.startsWith('packages/'));
  const blocks = list.map((pkg) => {
    const label = pkg.label || pkg.key || 'Package';
    const isDiff = touched.some((f) => f.includes(label));
    const members = (pkg.itemIds || []).filter(Boolean);
    const rows = [
      fieldRow('Price', '$' + num(pkg.price), isDiff),
      pkg.listTotal ? fieldRow('List total', '$' + num(pkg.listTotal), false) : '',
      pkg.savings ? fieldRow('Savings', '$' + num(pkg.savings), false) : '',
      fieldRow('Items', members.length
        ? members.join(', ')
        : (pkg.bookedAsSingleLine ? 'booked as one line' : '(not resolved)'), false),
    ].join('');
    return `
      <div class="item-block${isDiff ? ' has-diff' : ''}">
        <div class="item-block-head">
          <span class="item-block-title">Package</span>
          <span class="item-block-id">${esc(label)}</span>
        </div>
        ${rows}
      </div>`;
  }).join('');

  return `
    <div class="card-section">
      <div class="card-section-label">Packages (${list.length})</div>
      ${blocks}
    </div>`;
}

function renderItemsSection(items, itemOrder, diffSet) {
  if (!itemOrder || itemOrder.length === 0) return '';

  // Decide which item keys to show — hide-matched mode drops blocks with no
  // diffs (and no missing-side markers).
  const visibleKeys = hideMatchedRows
    ? itemOrder.filter((key) => itemHasAnyDiff(key, diffSet))
    : itemOrder;

  if (!visibleKeys.length) {
    return `
      <div class="card-section">
        <div class="card-section-label">Items (${itemOrder.length})</div>
        <div class="muted" style="padding:10px 4px;font-size:12.5px;">All items match.</div>
      </div>`;
  }

  const blocks = visibleKeys.map((key) => {
    const it = findItemByKey(items, key);
    if (!it) {
      return `
        <div class="item-block missing">
          <div class="item-block-head">
            <span class="item-block-title">Item</span>
            <span class="item-block-id">${esc(key)}</span>
          </div>
          <div class="item-missing">(not on this side)</div>
        </div>`;
    }
    return renderItemBlock(it, key, diffSet);
  }).join('');

  return `
    <div class="card-section">
      <div class="card-section-label">Items (${visibleKeys.length} of ${itemOrder.length})</div>
      ${blocks}
    </div>`;
}

function itemHasAnyDiff(key, diffSet) {
  for (const f of diffSet) {
    if (f.startsWith(`items/${key}/`) || f === `items/missing-in-mssql:${key}` || f === `items/missing-in-json:${key}`) {
      return true;
    }
  }
  return false;
}

function renderItemBlock(it, key, diffSet) {
  const prefix = `items/${key}`;
  const skuCoverDiff = diffSet.has(`${prefix}/sku+cover`);

  const rows = [
    ['itemId',        'Item ID',     it.itemId,                             false],
    ['qty',           'Qty',         it.qty,                                diffSet.has(`${prefix}/qty`)],
    ['ven',           'Vendor',      it.ven,                                diffSet.has(`${prefix}/ven`)],
    ['sku',           'SKU',         it.sku,                                skuCoverDiff],
    ['grade',         'Grade',       it.grade,                              skuCoverDiff],
    ['cover',         'Cover',       it.cover,                              skuCoverDiff],
    ['description',   'Description', it.description,                        diffSet.has(`${prefix}/description`)],
    ['salePrice',     'Sale Price',  it.salePrice == null ? '' : '$' + num(it.salePrice), diffSet.has(`${prefix}/salePrice`)],
    ['extendedPrice', 'Ext. Price',  it.extendedPrice == null ? '' : '$' + num(it.extendedPrice), diffSet.has(`${prefix}/extPrice`)],
  ];

  const visibleRows = hideMatchedRows ? rows.filter(([, , , isDiff]) => isDiff) : rows;
  const fieldsHtml = visibleRows.length
    ? visibleRows.map(([, label, value, isDiff]) => fieldRow(label, value, isDiff)).join('')
    : `<div class="muted" style="font-size:12px;padding:4px 0;">all fields match</div>`;

  const transferBadge = it.isTransfer ? `<span class="transfer-badge" title="Item is on transfer (A=OT in salesitemdetail)">TRANSFER</span>` : '';
  const packageBadge = it.packageKey
    ? `<span class="package-badge" title="Priced as part of package ${esc(it.packageKey)}">IN PACKAGE</span>`
    : '';
  return `
    <div class="item-block${it.isTransfer ? ' is-transfer' : ''}">
      <div class="item-block-head">
        <span class="item-block-title">Item${packageBadge}${transferBadge}</span>
        <span class="item-block-id">${esc(it.itemId || it.sku || key)}</span>
      </div>
      ${fieldsHtml}
    </div>`;
}

function diffsTable(diffs) {
  const real = diffs.filter((d) => d.field !== '_note');
  const notes = diffs.filter((d) => d.field === '_note');

  let html = '<div class="mismatch-section">';
  if (real.length) {
    html += `<h2>Mismatched fields (${real.length})</h2>`;
    html += `
      <table class="diff-table">
        <thead>
          <tr><th style="width:110px;">Group</th><th style="width:30%;">Field</th><th>Ticket</th><th>RV</th></tr>
        </thead>
        <tbody>
          ${real.map((d) => `
            <tr>
              <td><span class="group-pill ${esc(d.group)}">${esc(d.group)}</span></td>
              <td class="field-name">${esc(d.field)}</td>
              <td class="v-json">${renderValue(d.json)}</td>
              <td class="v-mssql">${renderValue(d.mssql)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } else {
    html += `<div class="banner ok">All audited fields match.</div>`;
  }
  if (notes.length) {
    html += '<h2 style="margin-top:20px;">Notes</h2>';
    html += notes.map((n) => `<div class="banner" style="background:var(--surface);border-color:var(--border-soft);color:var(--text-soft);"><b>${esc(n.group)}:</b> ${esc(fmt(n.json))} vs ${esc(fmt(n.mssql))}</div>`).join('');
  }
  html += '</div>';
  return html;
}

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (v === '') return '(empty)';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Friendly labels for known item fields when rendering an item-object diff value
const ITEM_LABELS = {
  itemId: 'Item ID',
  qty: 'Qty',
  ven: 'Vendor',
  sku: 'SKU',
  grade: 'Grade',
  cover: 'Cover',
  description: 'Description',
  salePrice: 'Sale Price',
  extendedPrice: 'Ext. Price',
  loc: 'Loc',
  seq: 'Seq',
};
const ITEM_ORDER = ['itemId','qty','ven','sku','grade','cover','description','salePrice','extendedPrice','loc','seq'];

// Render a diff value as HTML. Scalars: a single span. Object (a whole item):
// a vertical key:value list, one row per field, prices formatted as currency.
function renderValue(v) {
  if (v === null || v === undefined) return '<span class="empty">—</span>';
  if (v === '') return '<span class="empty">(empty)</span>';
  if (typeof v !== 'object') return esc(String(v));
  if (Array.isArray(v)) return esc(JSON.stringify(v));

  const keys = ITEM_ORDER.filter((k) => k in v).concat(Object.keys(v).filter((k) => !ITEM_ORDER.includes(k) && !k.startsWith('_')));
  const rows = keys.map((k) => {
    let val = v[k];
    if (val === undefined || val === null || val === '') return `<div class="kv-row"><span class="kv-k">${esc(ITEM_LABELS[k] || k)}</span><span class="kv-v empty">—</span></div>`;
    if (k === 'salePrice' || k === 'extendedPrice') val = '$' + num(val);
    return `<div class="kv-row"><span class="kv-k">${esc(ITEM_LABELS[k] || k)}</span><span class="kv-v">${esc(String(val))}</span></div>`;
  }).join('');
  return `<div class="kv-list">${rows}</div>`;
}
function num(v) { return (Number(v) || 0).toFixed(2); }
function formatPhone(s) {
  const d = String(s || '').replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return s || '';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Only run the audit-page init when the main #result container exists.
// Loading this script from rv.html should be a no-op except for exposing
// renderRvViewer / helpers.
if (document.getElementById('result')) init();
