const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');

async function fetchInvoicesByDate(date) {
  const mode = process.env.MODE || 'dev';

  if (mode === 'dev') {
    const dir = process.env.FIXTURES_DIR || './fixtures';
    const file = path.resolve(dir, `${date}.json`);
    const raw = await fs.readFile(file, 'utf-8');
    return JSON.parse(raw);
  }

  const base = process.env.INVOICES_API_BASE;
  const userId = process.env.INVOICES_API_USER_ID;
  const res = await axios.get(`${base}/api/invoices-archive`, {
    params: { date },
    headers: { 'X-User-Id': userId },
    timeout: 15000,
  });
  return res.data;
}

module.exports = { fetchInvoicesByDate };
