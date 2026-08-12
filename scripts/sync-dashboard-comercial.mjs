/**
 * scripts/sync-dashboard-comercial.mjs
 *
 * (ALTERNATIVA — escritura directa vía Sheets API con service account.)
 * En Carrefour el compartir directo lo bloquea DLP, así que el camino en uso es
 * el Apps Script + docs/data/comercial-app.json (ver build-comercial-json.mjs).
 * Este script queda para el caso de que se pueda usar una service account
 * (p.ej. dentro del dominio o con domain-wide delegation).
 *
 * Escribe las mismas celdas de la hoja "APP" que define comercial-lib.mjs.
 *
 * Uso:
 *   node scripts/sync-dashboard-comercial.mjs 2026-06 2026-07
 *   DRY_RUN=1 node scripts/sync-dashboard-comercial.mjs 2026-06
 *
 * Env: SHEET_ID, GOOGLE_SERVICE_ACCOUNT (o GOOGLE_SA_KEY), SHEET_TAB (default APP).
 */
import { computeMonth, availableMonths, monthCol, ROW, KPI_KEYS } from './comercial-lib.mjs';

const TAB     = process.env.SHEET_TAB || 'APP';
const DRY_RUN = !!process.env.DRY_RUN;

function cellsFor(ym, d) {
  const col = monthCol(ym);
  return KPI_KEYS.map(key => ({ range: `${TAB}!${col}${ROW[key]}`, values: [[d[key]]] }));
}

async function main() {
  let months = process.argv.slice(2).filter(a => /^\d{4}-\d{2}$/.test(a));
  if (!months.length) { const m = availableMonths(); if (m.length) months = [m[m.length - 1]]; }
  if (!months.length) { console.error('No hay datos en docs/data/daily.'); process.exit(1); }

  const data = [];
  for (const ym of months) {
    const d = computeMonth(ym);
    if (!d) { console.warn(`⚠ ${ym}: sin datos, salteo.`); continue; }
    console.log(`${ym} (col ${monthCol(ym)}): Pedidos ${d.pedidos} · VCT ${d.vct.toLocaleString()}`
      + ` · Ticket ${d.ticket.toLocaleString()} · Part ${(d.participacion*100).toFixed(2)}% · Unid ${d.unidades.toLocaleString()}`);
    data.push(...cellsFor(ym, d));
  }
  if (!data.length) { console.error('Nada para escribir.'); process.exit(1); }

  if (DRY_RUN) {
    console.log('\n[DRY_RUN] Celdas:');
    for (const c of data) console.log(`  ${c.range} = ${c.values[0][0]}`);
    return;
  }

  const SHEET_ID = process.env.SHEET_ID;
  const RAW_KEY  = process.env.GOOGLE_SERVICE_ACCOUNT || process.env.GOOGLE_SA_KEY;
  if (!SHEET_ID) { console.error('Falta SHEET_ID.'); process.exit(1); }
  if (!RAW_KEY)  { console.error('Falta GOOGLE_SERVICE_ACCOUNT (o GOOGLE_SA_KEY).'); process.exit(1); }

  let creds;
  try { creds = JSON.parse(RAW_KEY); }
  catch { console.error('El JSON de la service account no es válido.'); process.exit(1); }
  console.log(`Service account: ${creds.client_email}`);

  const { google } = await import('googleapis');
  const auth = new google.auth.JWT(creds.client_email, undefined, creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']);
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID, requestBody: { valueInputOption: 'RAW', data },
  });
  console.log(`\n✅ ${data.length} celdas escritas en "${TAB}" (${months.join(', ')}).`);
}

main().catch(err => { console.error('💥', err?.response?.data?.error?.message || err.message); process.exit(1); });
