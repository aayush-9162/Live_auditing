// Turn a PDF buffer into positioned text lines.
//
// The RV "SALES EDIT" report is a fixed-column terminal report, so the only
// reliable way to read it back is by x coordinate — a plain text dump loses
// which column a number belonged to. pdfjs hands us every text run with its
// own transform, so we keep the x of each run and rebuild lines from that.

const { pathToFileURL } = require('url');

let _pdfjs = null;

// pdfjs-dist ships ESM only; load it once and cache the namespace.
async function getPdfjs() {
  if (!_pdfjs) {
    const entry = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    _pdfjs = await import(pathToFileURL(entry).href);
  }
  return _pdfjs;
}

// Text runs on the same printed row share a y within a fraction of a point;
// consecutive rows are ~11pt apart, so 2pt is a safe grouping window.
const ROW_TOLERANCE = 2;

// Rebuild a monospace-looking string for a row so callers can run plain
// regexes over it. `unit` is the page's median character width.
function renderLine(cells, originX, unit) {
  let out = '';
  for (const cell of cells) {
    const col = Math.round((cell.x - originX) / unit);
    if (col > out.length) out += ' '.repeat(col - out.length);
    else if (out.length && !/\s$/.test(out)) out += ' ';
    out += cell.str;
  }
  return out.replace(/\s+$/, '');
}

// Returns { pages: [{ number, lines }] } where each line is
// { y, text, cells: [{ x, xEnd, str }] }.
async function extractLines(buffer) {
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();

      const charWidths = [];
      const rows = [];
      let originX = Infinity;

      for (const item of content.items) {
        if (!item.str || !item.str.trim()) continue;
        const x = item.transform[4];
        const y = item.transform[5];
        const width = item.width || 0;
        if (width > 0) charWidths.push(width / item.str.length);
        if (x < originX) originX = x;

        const cell = { x, xEnd: x + width, str: item.str };
        const row = rows.find((r) => Math.abs(r.y - y) <= ROW_TOLERANCE);
        if (row) row.cells.push(cell);
        else rows.push({ y, cells: [cell] });
      }

      charWidths.sort((a, b) => a - b);
      const unit = charWidths[Math.floor(charWidths.length / 2)] || 5;
      if (!Number.isFinite(originX)) originX = 0;

      rows.sort((a, b) => b.y - a.y);            // PDF y grows upward
      const lines = rows.map((row) => {
        const cells = row.cells.sort((a, b) => a.x - b.x);
        return { y: row.y, cells, text: renderLine(cells, originX, unit) };
      });

      pages.push({ number: n, lines });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return { pages };
}

// --- helpers for reading a line by column -----------------------------------

// Cells whose left edge falls in [x0, x1).
function cellsBetween(line, x0, x1) {
  return line.cells.filter((c) => c.x >= x0 - 0.5 && c.x < x1 - 0.5);
}

function textBetween(line, x0, x1) {
  return cellsBetween(line, x0, x1).map((c) => c.str).join(' ').replace(/\s+/g, ' ').trim();
}

// Split merged text runs back into single words.
//
// The same RV report comes out of the PDF writer two different ways: usually
// each word is its own text run, but sometimes a whole phrase arrives as one
// ("QTY-ORD QTY-SHP QTY-BO ITEM-ID", "TERMS: COLLECT ON DELIVERY"). Anything
// that locates a field by matching a cell against a word then fails on the
// merged form, so normalise to one word per cell up front.
//
// The reports are monospace, so a word's x is its character offset scaled
// across the run's width. `text` is left alone — it already renders correctly
// either way, and the words keep their original positions.
function splitWords(pages) {
  return pages.map((page) => ({
    ...page,
    lines: page.lines.map((line) => {
      if (!line.cells.some((c) => /\s/.test(c.str.trim()))) return line;
      const cells = [];
      for (const cell of line.cells) {
        if (!/\s/.test(cell.str.trim())) { cells.push(cell); continue; }
        const perChar = cell.str.length ? (cell.xEnd - cell.x) / cell.str.length : 0;
        const re = /\S+/g;
        let m;
        while ((m = re.exec(cell.str)) !== null) {
          cells.push({
            x: cell.x + perChar * m.index,
            xEnd: cell.x + perChar * (m.index + m[0].length),
            str: m[0],
          });
        }
      }
      return { ...line, cells: cells.sort((a, b) => a.x - b.x) };
    }),
  }));
}

module.exports = { extractLines, cellsBetween, textBetween, splitWords };
