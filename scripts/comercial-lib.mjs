/**
 * scripts/comercial-lib.mjs
 * Lógica compartida para los KPIs de la hoja "APP" del Dashboard Comercial.
 * La usan build-comercial-json.mjs (genera el JSON público) y
 * sync-dashboard-comercial.mjs (escritura directa vía Sheets API, alternativa).
 */
import fs from 'fs';
import path from 'path';

export const DAILY = 'docs/data/daily';

// Fila (1-indexed en el Sheet) por KPI — fallback si no se encuentra por etiqueta.
export const ROW = {
  pedidos: 2, vct: 3, ticket: 4, participacion: 5,
  recompra: 6, frecuencia: 7, frecuencia_qc: 8,
  unidades: 10, unidades_prom: 11,
  food: 12, food_pct: 13,
  non_food: 14, non_food_pct: 15,
  marketplace: 16, marketplace_pct: 17,
  quick: 18, quick_pct: 19,
};

// Etiqueta exacta del KPI en la columna B del Sheet (para ubicar la fila por texto,
// robusto ante inserción/movimiento de filas). Se normaliza (trim/acentos/case) al comparar.
export const ROW_LABELS = {
  pedidos: 'Pedidos Criterio Checkout',
  vct: 'VCT Criterio Checkout',
  ticket: 'Ticket Promedio',
  participacion: '% Participacion Criterio Checkout',
  recompra: '% de Recompra (2 o mas)',
  frecuencia: 'Frecuencia de Compra',
  frecuencia_qc: 'Frecuencia de Compra QuickCommerce',
  unidades: 'Unidades',
  unidades_prom: 'Unidades Promedio',
  food: 'Pedidos Food',                food_pct: '% Pedidos Food',
  non_food: 'Pedidos NonFood',         non_food_pct: '% Pedidos NonFood',
  marketplace: 'Pedidos Marketplace',  marketplace_pct: '% Pedidos Marketplace',
  quick: 'Pedidos Quick',              quick_pct: '% Pedidos Quick',
};

const MONTH_NAMES = ['enero','febrero','marzo','abril','mayo','junio',
  'julio','agosto','septiembre','octubre','noviembre','diciembre'];
export function monthName(ym) { return MONTH_NAMES[Number(ym.slice(5, 7)) - 1]; }
function daysInMonth(ym) { return new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate(); }

// Columna por mes: Marzo=C, Abril=D, Mayo=E, Junio=F, Julio=G, agosto=H...
export function monthCol(ym) {
  const m = Number(ym.slice(5, 7));
  return String.fromCharCode('C'.charCodeAt(0) + (m - 3)); // marzo(3)->C
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// VTEX anonimiza el email por-orden: <email>@<dom>-<orderref>.ct.vtex.com.br.
// Sacando ese sufijo recuperamos una clave estable de cliente (el email real).
// Se usa SOLO en memoria para contar clientes únicos; nunca se escribe a ningún lado.
export function realEmail(e) {
  if (!e) return null;
  return String(e).replace(/-[^-@]*\.ct\.vtex\.com\.br$/i, '').toLowerCase() || null;
}

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

  // Unidades (Σ qty de items) y clientes únicos (por email normalizado), leyendo los rows.
  let unidades = 0, rowsDays = 0, ordersWithEmail = 0, qcOrders = 0;
  const cust = new Map(), custQc = new Map();
  for (const f of monthFiles(ym, '-rows.json')) {
    const rows = readJson(path.join(DAILY, f));
    if (!Array.isArray(rows)) continue;
    rowsDays++;
    for (const r of rows) {
      if (Array.isArray(r.items)) for (const it of r.items) unidades += Number(it.qty) || 0;
      const k = realEmail(r.email);
      if (!k) continue;
      ordersWithEmail++; cust.set(k, (cust.get(k) || 0) + 1);
      if (r.segment === 'quickcommerce') { qcOrders++; custQc.set(k, (custQc.get(k) || 0) + 1); }
    }
  }
  const clientes = cust.size;
  const recompraCnt = [...cust.values()].filter(c => c >= 2).length;

  const through = dailies[dailies.length - 1].slice(0, 10); // último día con dato (orden asc)
  const dim = daysInMonth(ym);
  const daysCovered = Number(through.slice(8, 10));
  const p = (n, den) => (den ? n / den : 0);
  return {
    ym, name: monthName(ym), days: dailies.length, rowsDays,
    through, days_in_month: dim, partial: daysCovered < dim,
    pedidos, vct, totalEcomm,
    ticket:        pedidos ? Math.round(vct / pedidos) : 0,
    participacion: p(pedidos, totalEcomm),
    clientes,
    recompra:      p(recompraCnt, clientes),
    frecuencia:    p(ordersWithEmail, clientes),
    frecuencia_qc: p(qcOrders, custQc.size),
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
