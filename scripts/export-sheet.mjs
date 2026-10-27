// Pulls every tab of the league Google Sheet into data/raw/<tab>.csv.
//
// Auth: a Google service account that the Sheet is shared with (Viewer is enough).
//   GOOGLE_SERVICE_ACCOUNT_JSON  the key file's JSON, as one string (GitHub secret), or
//   GOOGLE_APPLICATION_CREDENTIALS  a path to the key file (local runs)
//   SHEET_ID  the spreadsheet ID from the Sheet's URL
//
// Locally, put those in a .env file (see .env.example) and run `npm run export`.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { GoogleAuth } from 'google-auth-library';

const SHEET_ID = process.env.SHEET_ID;
// Tabs the site doesn't need: validation sheets, the run log, and the 50k-row NFL Weeks.
const SKIP = new Set(['Checks', 'Wins Check', 'Run Log', 'NFL Weeks']);
const OUT = new URL('../data/raw/', import.meta.url);

if (!SHEET_ID) throw new Error('SHEET_ID is not set. Copy .env.example to .env and fill it in.');

async function credentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return JSON.parse(await readFile(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
  }
  throw new Error('No service account key: set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.');
}

const auth = new GoogleAuth({
  credentials: await credentials(),
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});
const client = await auth.getClient();
const api = (path) => client.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${path}` })
  .then((r) => r.data);

// Tab names, then every tab's values in one batch request.
const meta = await api('?fields=sheets.properties.title');
const tabs = meta.sheets.map((s) => s.properties.title).filter((t) => !SKIP.has(t));
const qs = tabs.map((t) => 'ranges=' + encodeURIComponent(`'${t.replace(/'/g, "''")}'`)).join('&');
const batch = await api(`/values:batchGet?${qs}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`);

const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const cell = (v) => {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

await mkdir(OUT, { recursive: true });
const manifest = { exported_at: new Date().toISOString(), tabs: {} };
for (let i = 0; i < tabs.length; i++) {
  const rows = batch.valueRanges[i].values || [];
  if (!rows.length) continue;
  const width = rows[0].length;
  // Drop rows whose first cell is blank (trailing formatting rows), pad short rows to the header width.
  const body = rows.slice(1).filter((r) => r.length && r[0] !== '' && r[0] !== undefined);
  const csv = [rows[0], ...body].map((r) => Array.from({ length: width }, (_, j) => cell(r[j])).join(',')).join('\n');
  const file = slug(tabs[i]) + '.csv';
  await writeFile(new URL(file, OUT), csv + '\n');
  manifest.tabs[tabs[i]] = { file, rows: body.length };
  console.log(`${tabs[i].padEnd(16)} ${String(body.length).padStart(6)} rows → data/raw/${file}`);
}
await writeFile(new URL('_manifest.json', OUT), JSON.stringify(manifest, null, 2) + '\n');
