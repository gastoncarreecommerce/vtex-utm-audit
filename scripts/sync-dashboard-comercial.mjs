/**
 * scripts/sync-dashboard-comercial.mjs
 *
 * Llena automáticamente la hoja "APP" del Google Sheet Dashboard_Comercial con
 * los KPIs de negocio que salen de los datos del dashboard (docs/data/daily),
 * mes a mes. Escribe DIRECTO al Google Sheet vía la Sheets API (service account).
 *
 * KPIs que sincroniza (los que mapean 1:1 desde nuestros datos):
 *   fila 2  Pedidos Criterio Checkout      = Σ app.total
 *   fila 3  VCT Criterio Checkout          = Σ app.gmv (pesos)
 *   fila 4  Ticket Promedio                = VCT / Pedidos
 *   fila 5  % Participacion Criterio Checkout = Pedidos app / Σ total_ecomm_orders
 *   fila 10 Unidades                        = Σ qty de items (rows)
 *   fila 11 Unidades Promedio               = Unidades / Pedidos
 *   fila 12 Pedidos Food        · 13 % Food
 *   fila 14 Pedidos NonFood     · 15 % NonFood
 *   fila 16 Pedidos Marketplace · 17 % Marketplace
 *   fila 18 Pedidos Quick       · 19 % Quick
 *
 * NO toca las filas de GA4 (Trafico, Tasa de Conversion), app-store
 * (Instalaciones, Usuarios Activos, Eventos, NPS, Ratings) ni Margen: esas
 * vienen de otras fuentes y quedan a revisar.
 *
 * Uso:
 *   node scripts/sync-dashboard-comercial.mjs            # mes anterior (por default)
 *   node scripts/sync-dashboard-comercial.mjs 2026-06    # un mes puntual
 *   node scripts/sync-dashboard-comercial.mjs 2026-05 2026-06 2026-07   # varios
 *   DRY_RUN=1 node scripts/sync-dashboard-comercial.mjs 2026-06   # solo imprime, no escribe
 *
 * Env necesarias:
 *   SHEET_ID        id del Google Sheet (de la URL .../d/<SHEET_ID>/edit)
 *   GOOGLE_SA_KEY   JSON de la service account (con Sheets API) — como string
 *   SHEET_TAB       (opcional) nombre de la pestaña, default "APP"
 */
import fs from 'fs';
import path from 'path';

const DAILY   = 'docs/data/daily';
const TAB     = process.env.SHEET_TAB || 'APP';
const DRY_RUN = !!process.env.DRY_RUN;

// Fila (1-indexed en el sheet) por KPI.
const ROW = {
  pedidos: 2, vct: 3, ticket: 4, participacion: 5,
  unidades: 10, unidades_prom: 11,
  food: 12, food_pct: 13,
  non_food: 14, non_food_pct: 15,
  marketplace: 16, marketplace_pct: 17,
  quick: 18, quick_pct: 19,
};

// Columna por mes: Marzo=C, Abril=D, Mayo=E, Junio=F, Julio=G, agosto=H...
function monthCol(ym) {
  const m = Number(ym.slice(5, 7));
  return String.fromCharCode('C'.charCodeAt(0) + (m - 3)); // marzo(3)->C
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function monthFiles(ym, suffix) {
  if (!fs.existsSync(DAILY)) return [];
  return fs.readdirSync(DAILY)
    .filter(f => f.startsWith(ym) && f.endsWith(suffix))
    .sort();
}

function computeMonth(ym) {
  const dailies = monthFiles(ym, '.json').filter(f => !f.endsWith('-rows.json'));
  if (!dailies.length) return null;

  let pedidos = 0, vct = 0, totalEcomm = 0;
  const seg = { food: 0, non_food: 0, marketplace: 0, quickcommerce: 0 };
  for (const f of dailies) {
    const j = readJson(path.join(DAILY, f)); if (!j) continue;
    pedidos    += j.app?.total || 0;
    vct        += j.app?.gmv || 0;
    totalEcomm += j.total_ecomm_orders || 0;
    for (const k of Object.keys(seg)) seg[k] += j.app?.segments?.[k]?.orders || 0;
  }

  // Unidades: suma de qty de items en los -rows.json del mes.
  let unidades = 0, rowsDays = 0;
  for (const f of monthFiles(ym, '-rows.json')) {
    const rows = readJson(path.join(DAILY, f));
    if (!Array.isArray(rows)) continue;
    rowsDays++;
    for (const r of rows) if (Array.isArray(r.items)) for (const it of r.items) unidades += Number(it.qty) || 0;
  }

  return {
    ym, days: dailies.length, rowsDays,
    pedidos, vct, totalEcomm, seg, unidades,
    ticket:        pedidos ? Math.round(vct / pedidos) : 0,
    participacion: totalEcomm ? pedidos / totalEcomm : 0,
    unidades_prom: pedidos ? unidades / pedidos : 0,
  };
}

function cellsFor(ym, d) {
  const col = monthCol(ym);
  const p = (n, den) => (den ? n / den : 0);
  const map = {
    pedidos: d.pedidos, vct: d.vct, ticket: d.ticket, participacion: d.participacion,
    unidades: d.unidades, unidades_prom: d.unidades_prom,
    food: d.seg.food, food_pct: p(d.seg.food, d.pedidos),
    non_food: d.seg.non_food, non_food_pct: p(d.seg.non_food, d.pedidos),
    marketplace: d.seg.marketplace, marketplace_pct: p(d.seg.marketplace, d.pedidos),
    quick: d.seg.quickcommerce, quick_pct: p(d.seg.quickcommerce, d.pedidos),
  };
  return Object.entries(map).map(([key, value]) => ({
    range: `${TAB}!${col}${ROW[key]}`, values: [[value]],
  }));
}

async function main() {
  let months = process.argv.slice(2).filter(a => /^\d{4}-\d{2}$/.test(a));
  if (!months.length) {
    // mes anterior al actual (según el JSON más nuevo que tengamos, para no depender de la fecha del runner)
    const all = monthFiles('', '.json').filter(f => !f.endsWith('-rows.json')).map(f => f.slice(0, 7));
    const latest = [...new Set(all)].sort().pop();
    if (latest) months = [latest];
  }
  if (!months.length) { console.error('No hay datos en docs/data/daily.'); process.exit(1); }

  const data = [];
  for (const ym of months) {
    const d = computeMonth(ym);
    if (!d) { console.warn(`⚠ ${ym}: sin datos, salteo.`); continue; }
    console.log(`\n${ym}  (${d.days} días, ${d.rowsDays} con items · col ${monthCol(ym)})`);
    console.log(`  Pedidos ${d.pedidos} · VCT ${d.vct.toLocaleString()} · Ticket ${d.ticket.toLocaleString()}`
      + ` · Part ${(d.participacion * 100).toFixed(2)}%`);
    console.log(`  Unidades ${d.unidades.toLocaleString()} (${d.unidades_prom.toFixed(2)}/ped)`
      + ` · Food ${d.seg.food} · NonFood ${d.seg.non_food} · Mkt ${d.seg.marketplace} · Quick ${d.seg.quickcommerce}`);
    data.push(...cellsFor(ym, d));
  }
  if (!data.length) { console.error('Nada para escribir.'); process.exit(1); }

  if (DRY_RUN) {
    console.log('\n[DRY_RUN] Celdas que se escribirían:');
    for (const c of data) console.log(`  ${c.range} = ${c.values[0][0]}`);
    return;
  }

  const SHEET_ID = process.env.SHEET_ID;
  const RAW_KEY  = process.env.GOOGLE_SA_KEY;
  if (!SHEET_ID) { console.error('Falta SHEET_ID.'); process.exit(1); }
  if (!RAW_KEY)  { console.error('Falta GOOGLE_SA_KEY.'); process.exit(1); }

  let creds;
  try { creds = JSON.parse(RAW_KEY); }
  catch { console.error('GOOGLE_SA_KEY no es un JSON válido.'); process.exit(1); }

  const { google } = await import('googleapis');
  const auth = new google.auth.JWT(
    creds.client_email, undefined, creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data },
  });

  console.log(`\n✅ ${data.length} celdas escritas en "${TAB}" (${months.join(', ')}).`);
}

main().catch(err => {
  console.error('💥', err?.response?.data?.error?.message || err.message);
  process.exit(1);
});
