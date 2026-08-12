/**
 * scripts/comercial-lib.mjs
 * Lógica compartida para los KPIs de la hoja "APP" del Dashboard Comercial.
 * La usan build-comercial-json.mjs (genera el JSON público) y
 * sync-dashboard-comercial.mjs (escritura directa vía Sheets API, alternativa).
 */
import fs from 'fs';
import path from 'path';

export const DAILY = 'docs/data/daily';

// Fila (1-indexed en el Sheet) por KPI.
export const ROW = {
  pedidos: 2, vct: 3, ticket: 4, participacion: 5,
  unidades: 10, unidades_prom: 11,
  food: 12, food_pct: 13,
  non_food: 14, non_food_pct: 15,
  marketplace: 16, marketplace_pct: 17,
  quick: 18, quick_pct: 19,
};

// Columna por mes: Marzo=C, Abril=D, Mayo=E, Junio=F, Julio=G, agosto=H...
export function monthCol(ym) {
  const m = Number(ym.slice(5, 7));
  return String.fromCharCode('C'.charCodeAt(0) + (m - 3)); // marzo(3)->C
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function monthFiles(ym, suffix) {
  if (!fs.existsSync(DAILY)) return [];
  return fs.readdirSync(DAILY).filter(f => f.startsWith(ym) && f.endsWith(suffix)).sort();
}

// Todos los meses (YYYY-MM) con al menos un daily JSON.
export function availableMonths() {
  const all = monthFiles('', '.json').filter(f => !f.endsWith('-rows.json')).map(f => f.slice(0, 7));
  return [...new Set(all)].sort();
}

// Calcula los KPIs de un mes a partir de docs/data/daily. Devuelve null si no hay datos.
export function computeMonth(ym) {
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

  const p = (n, den) => (den ? n / den : 0);
  return {
    ym, days: dailies.length, rowsDays,
    pedidos, vct, totalEcomm,
    ticket:        pedidos ? Math.round(vct / pedidos) : 0,
    participacion: p(pedidos, totalEcomm),
    unidades,
    unidades_prom: p(unidades, pedidos),
    food: seg.food,               food_pct: p(seg.food, pedidos),
    non_food: seg.non_food,       non_food_pct: p(seg.non_food, pedidos),
    marketplace: seg.marketplace, marketplace_pct: p(seg.marketplace, pedidos),
    quick: seg.quickcommerce,     quick_pct: p(seg.quickcommerce, pedidos),
  };
}

// Los campos KPI que van al Sheet (en el orden de ROW).
export const KPI_KEYS = Object.keys(ROW);
