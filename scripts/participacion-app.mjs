/**
 * scripts/participacion-app.mjs
 * Reporte de participación de la app vs total ecommerce, 15-mar → 30-jun.
 *
 * Base (según lo pedido):
 *   - May–Jun: from=app (real), leído de docs/data/daily/{date}.json
 *   - Mar–Abr: por UTM (utm_source=app_ecomm), leído de docs/data/utm-backfill/{date}.json,
 *     multiplicado por el factor de corrección UTM→real medido en may-jun (from=app ÷ app_ecomm),
 *     porque en ese período no existía from=app y la UTM subcuenta ~28%.
 *
 * Genera participacion-app.xlsx (Diario + Resumen) e imprime el resumen.
 */
import fs from 'fs';
import path from 'path';
import { utils, writeFile } from 'xlsx';

const DAILY = 'docs/data/daily';
const UTMBF = 'docs/data/utm-backfill';
const FROM = '2026-03-15', TO = '2026-06-30';

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function utmAppEcomm(date) {
  const rows = readJson(path.join(DAILY, `${date}-rows.json`));
  return Array.isArray(rows) ? rows.filter(r => r.utm_source === 'app_ecomm').length : null;
}
function eachDate(from, to) {
  const out = []; let d = new Date(`${from}T00:00:00Z`); const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); }
  return out;
}

// Factor de corrección UTM→real, medido en el período con ambos (from=app y app_ecomm).
let sumFrom = 0, sumUtm = 0;
for (const date of eachDate('2026-05-01', '2026-06-30')) {
  const j = readJson(path.join(DAILY, `${date}.json`)); if (!j) continue;
  const u = utmAppEcomm(date);
  if (j.app?.total && u) { sumFrom += j.app.total; sumUtm += u; }
}
const FACTOR = sumUtm > 0 ? sumFrom / sumUtm : 1.41;

const daily = [];
for (const date of eachDate(FROM, TO)) {
  const d = readJson(path.join(DAILY, `${date}.json`));
  if (d && d.app?.total != null) {
    daily.push({ date, total: d.total_ecomm_orders || 0, app: d.app.total, metodo: 'from=app (real)' });
    continue;
  }
  const u = readJson(path.join(UTMBF, `${date}.json`));
  if (u && u.app_utm_orders != null) {
    daily.push({ date, total: u.total_ecomm_orders || 0, app: Math.round(u.app_utm_orders * FACTOR),
      app_utm: u.app_utm_orders, metodo: `UTM×${FACTOR.toFixed(3)} (est.)` });
    continue;
  }
  daily.push({ date, total: 0, app: 0, metodo: 'SIN DATO' });
}

const pct = (a, t) => t > 0 ? Math.round(a / t * 1000) / 10 : 0;
function agg(rows) {
  const t = rows.reduce((s, r) => s + r.total, 0);
  const a = rows.reduce((s, r) => s + r.app, 0);
  return { total: t, app: a, part: pct(a, t) };
}
const byMonth = {};
for (const r of daily) { const m = r.date.slice(0, 7); (byMonth[m] ??= []).push(r); }

console.log(`\nFactor de corrección UTM→real (may-jun): ${FACTOR.toFixed(3)}  (from=app ${sumFrom} / app_ecomm ${sumUtm})\n`);
console.log('Participación app vs total ecommerce');
console.log('─'.repeat(60));
const resumen = [['periodo', 'total_ecommerce', 'app', 'participacion_pct', 'base']];
for (const m of Object.keys(byMonth).sort()) {
  const rows = byMonth[m], a = agg(rows);
  const base = rows.every(r => r.metodo.startsWith('from=app')) ? 'from=app'
    : rows.every(r => r.metodo.startsWith('UTM')) ? 'UTM×factor (est.)'
    : rows.some(r => r.metodo === 'SIN DATO') ? 'parcial/faltan días' : 'mixto';
  console.log(`  ${m}:  total ${a.total.toLocaleString().padStart(9)} · app ${String(a.app).padStart(6)} · ${String(a.part).padStart(4)}%  [${base}]`);
  resumen.push([m, a.total, a.app, a.part, base]);
}
const full = agg(daily);
console.log('─'.repeat(60));
console.log(`  TOTAL 15-mar→30-jun:  total ${full.total.toLocaleString()} · app ${full.app.toLocaleString()} · ${full.part}%`);
resumen.push(['TOTAL 15-mar→30-jun', full.total, full.app, full.part, 'mixto (real+est.)']);

const faltan = daily.filter(r => r.metodo === 'SIN DATO').map(r => r.date);
if (faltan.length) console.log(`\n⚠ Faltan ${faltan.length} días sin dato: ${faltan[0]} … ${faltan[faltan.length - 1]}`);

// xlsx
const wb = utils.book_new();
utils.book_append_sheet(wb, utils.aoa_to_sheet([
  ['fecha', 'total_ecommerce', 'app', 'app_utm_crudo', 'participacion_pct', 'metodo'],
  ...daily.map(r => [r.date, r.total, r.app, r.app_utm ?? '', pct(r.app, r.total), r.metodo]),
]), 'Diario');
utils.book_append_sheet(wb, utils.aoa_to_sheet(resumen), 'Resumen');
writeFile(wb, 'participacion-app.xlsx');
console.log('\n💾 participacion-app.xlsx');
