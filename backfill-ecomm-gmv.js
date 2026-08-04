/**
 * backfill-ecomm-gmv.js
 * Rellena total_ecomm_gmv (y participation_gmv_pct) en los JSON diarios YA
 * existentes de docs/data/daily/. Es BARATO: el GMV total del ecommerce sale del
 * totalValue (centavos) del LISTADO de pedidos de VTEX, así que solo se pagina la
 * lista — NO se re-fetchean los detalles (eso ya está calculado en el JSON).
 *
 * No recalcula nada de la app: usa el app.gmv ya guardado. Idempotente: saltea
 * días que ya tienen total_ecomm_gmv > 0.
 *
 * Env: VTEX_ACCOUNT, VTEX_APP_KEY, VTEX_APP_TOKEN
 *      DATE_FROM (default 2026-05-01), DATE_TO (default: ayer AR)
 */
const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;
const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;
const PAGE_SIZE    = 100;
const headers = {
  "X-VTEX-API-AppKey":   VTEX_KEY,
  "X-VTEX-API-AppToken": VTEX_TOKEN,
  "Content-Type":        "application/json"
};

function yesterdayAR() {
  const ar = new Date(Date.now() - 3 * 3600 * 1000);
  ar.setUTCDate(ar.getUTCDate() - 1);
  return ar.toISOString().slice(0, 10);
}
function addDays(s, n) { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// Bloques horarios AR (UTC-3), igual que fetch-orders.js, para no chocar límites de paginación.
function buildDateRanges(dateStr) {
  const ranges = [];
  const base   = new Date(`${dateStr}T03:00:00.000Z`);
  const end    = new Date(base.getTime() + 24 * 60 * 60 * 1000 - 1);
  const block  = 60 * 60 * 1000;
  let current  = new Date(base);
  while (current <= end) {
    ranges.push({
      from: current.toISOString(),
      to:   new Date(Math.min(current.getTime() + block - 1, end.getTime())).toISOString()
    });
    current = new Date(current.getTime() + block);
  }
  return ranges;
}
function listUrl(from, to, page) {
  return `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/oms/pvt/orders`
    + `?f_creationDate=creationDate%3A%5B${from}%20TO%20${to}%5D`
    + `&orderBy=creationDate%2Cdesc&page=${page}&per_page=${PAGE_SIZE}`;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchList(from, to, page) {
  for (let i = 0; i < 6; i++) {
    try {
      const res = await axios.get(listUrl(from, to, page), { headers, transformRequest: [d => d], timeout: 30000 });
      return res.data;
    } catch (e) {
      const s = e?.response?.status;
      if (s === 401 || s === 403) throw e;
      if (i === 5) throw e;
      await sleep(1500 * Math.pow(2, i));
    }
  }
}

async function ecommGmvForDay(date) {
  let cents = 0;
  for (const { from, to } of buildDateRanges(date)) {
    let page = 1, totalPages = null;
    while (true) {
      const data = await fetchList(from, to, page);
      if (totalPages === null) {
        const t = data?.paging?.total || 0;
        totalPages = Math.ceil(t / PAGE_SIZE);
        if (!t) break;
      }
      cents += (data?.list || []).reduce((s, o) => s + (Number(o.totalValue) || 0), 0);
      if (page >= totalPages) break;
      page++;
    }
  }
  return Math.round(cents / 100);
}

async function main() {
  const from = process.env.DATE_FROM || "2026-05-01";
  const to   = process.env.DATE_TO   || yesterdayAR();
  console.log(`Backfill GMV ecommerce: ${from} → ${to}`);

  const dir = path.join("docs", "data", "daily");
  let done = 0, skipped = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const p = path.join(dir, `${d}.json`);
    if (!fs.existsSync(p)) { continue; }
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if ((j.total_ecomm_gmv || 0) > 0) { skipped++; continue; }
    const gmv = await ecommGmvForDay(d);
    j.total_ecomm_gmv = gmv;
    j.participation_gmv_pct = gmv > 0 ? Math.round((j.app.gmv / gmv) * 1000) / 10 : 0;
    fs.writeFileSync(p, JSON.stringify(j, null, 2));
    done++;
    console.log(`  ${d} → $${gmv.toLocaleString()} ecomm · ${j.participation_gmv_pct}% part $ (app $${(j.app.gmv||0).toLocaleString()})`);
  }
  console.log(`\nListo. ${done} días rellenados, ${skipped} ya tenían $.`);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
