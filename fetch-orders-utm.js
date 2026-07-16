/**
 * fetch-orders-utm.js
 * Backfill histórico de participación de la app POR UTM (para marzo/abril, cuando
 * todavía no existía el parámetro from=app). Cuenta, por día:
 *   - total_ecomm_orders : todos los pedidos del ecommerce (paging.total)
 *   - app_utm_orders     : pedidos con utm_source === "app_ecomm" (marcador histórico de la app)
 *
 * NO escribe filas con datos personales: solo agregados (conteos + gmv). Sale a
 * docs/data/utm-backfill/{date}.json, separado del pipeline diario (docs/data/daily)
 * para no ensuciar el dashboard, que usa from=app.
 *
 * Uso: node fetch-orders-utm.js YYYY-MM-DD
 * Si el archivo del día ya existe, se saltea (para re-correr sin repetir trabajo).
 */

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;
const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;
const PAGE_SIZE    = 100;
const CONCURRENCY  = 25;
const RANGE_PARALLEL = 3;
const APP_UTM      = "app_ecomm";   // marcador de la app en UTM

const vtexHeaders = {
  "X-VTEX-API-AppKey":   VTEX_KEY,
  "X-VTEX-API-AppToken": VTEX_TOKEN,
  "Content-Type":        "application/json"
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(fn, retries = 8, delay = 1500) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      const s = e?.response?.status;
      if (s === 401 || s === 403 || s === 404) throw e;
      if (i === retries - 1) throw e;
      await sleep(delay * Math.pow(2, i));
    }
  }
}

function buildDateRanges(dateStr) {
  const ranges = [];
  const base   = new Date(`${dateStr}T03:00:00.000Z`); // medianoche AR (UTC-3)
  const end    = new Date(base.getTime() + 24 * 60 * 60 * 1000 - 1);
  const block  = 60 * 60 * 1000;
  let current  = new Date(base);
  while (current <= end) {
    const from = current.toISOString();
    const to   = new Date(Math.min(current.getTime() + block - 1, end.getTime())).toISOString();
    ranges.push({ from, to });
    current = new Date(current.getTime() + block);
  }
  return ranges;
}

function buildListUrl(from, to, page) {
  return `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/oms/pvt/orders`
    + `?f_creationDate=creationDate%3A%5B${from}%20TO%20${to}%5D`
    + `&orderBy=creationDate%2Cdesc&page=${page}&per_page=${PAGE_SIZE}`;
}

async function fetchOrderList(from, to, page) {
  return fetchWithRetry(async () => {
    const res = await axios.get(buildListUrl(from, to, page), {
      headers: vtexHeaders, transformRequest: [d => d], timeout: 30000
    });
    if (!res.data?.list) throw new Error("Bad list response");
    return res.data;
  });
}

async function fetchOrderDetail(orderId) {
  return fetchWithRetry(async () => {
    const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/oms/pvt/orders/${orderId}`;
    const res = await axios.get(url, { headers: vtexHeaders, timeout: 30000 });
    if (!res.data?.orderId) throw new Error("Bad detail response");
    return res.data;
  });
}

async function processBatch(orderIds, seen, result) {
  for (let i = 0; i < orderIds.length; i += CONCURRENCY) {
    const batch   = orderIds.slice(i, i + CONCURRENCY);
    const details = await Promise.all(batch.map(async id => {
      try { return await fetchOrderDetail(id); } catch (e) { return null; }
    }));
    for (const detail of details) {
      if (!detail?.orderId) continue;
      if (seen.has(detail.orderId)) continue;
      seen.add(detail.orderId);
      const utmSource = detail.marketingData?.utmSource || "";
      if (utmSource === APP_UTM) {
        result.app_utm_orders++;
        result.app_utm_gmv += typeof detail.value === "number" ? detail.value / 100 : 0;
      }
    }
  }
}

async function processRange(from, to, seen, result) {
  let page = 1, totalPages = null, consec = 0;
  const failed = [];
  while (true) {
    let data;
    try { data = await fetchOrderList(from, to, page); consec = 0; }
    catch (e) {
      consec++;
      if (consec >= 3) { failed.push(page); consec = 0; page++; if (totalPages && page > totalPages) break; continue; }
      await sleep(2000); continue;
    }
    if (totalPages === null) {
      const total = data.paging?.total || 0;
      totalPages  = Math.ceil(total / PAGE_SIZE);
      result.total_ecomm_orders += total;
      if (!total) break;
    }
    const ids = (data.list || []).map(o => o.orderId).filter(Boolean);
    if (ids.length) await processBatch(ids, seen, result);
    if (page >= totalPages) break;
    page++;
  }
  for (const p of failed) {
    try {
      const data = await fetchOrderList(from, to, p);
      const ids  = (data.list || []).map(o => o.orderId).filter(Boolean);
      if (ids.length) await processBatch(ids, seen, result);
    } catch (e) { console.error(`  ✗ Página no recuperada: ${from.slice(0,16)} pág ${p}`); }
  }
}

async function main() {
  const date = process.argv[2];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) { console.error("Uso: node fetch-orders-utm.js YYYY-MM-DD"); process.exit(1); }

  const outDir  = path.join("docs", "data", "utm-backfill");
  const outPath = path.join(outDir, `${date}.json`);
  if (fs.existsSync(outPath)) { console.log(`⏭  ${date} ya existe, salteo.`); return; }

  console.log(`\n🚀 UTM backfill ${date} (Argentina time)`);
  const ranges = buildDateRanges(date);
  const seen   = new Set();
  const result = { date, total_ecomm_orders: 0, app_utm_orders: 0, app_utm_gmv: 0 };

  for (let i = 0; i < ranges.length; i += RANGE_PARALLEL) {
    const batch = ranges.slice(i, i + RANGE_PARALLEL);
    await Promise.all(batch.map(({ from, to }) => processRange(from, to, seen, result)));
    process.stdout.write(`  [${Math.min(i+RANGE_PARALLEL,ranges.length)}/${ranges.length}] app_utm: ${result.app_utm_orders}\r`);
  }

  result.app_utm_gmv  = Math.round(result.app_utm_gmv);
  result.part_utm_pct = result.total_ecomm_orders > 0
    ? Math.round((result.app_utm_orders / result.total_ecomm_orders) * 1000) / 10 : 0;
  result.fetched_at   = new Date().toISOString();

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n✅ ${date}: total ${result.total_ecomm_orders} · app_utm ${result.app_utm_orders} · ${result.part_utm_pct}% (UTM)`);
}

main().catch(err => { console.error("💥 Fatal:", err.message); process.exit(1); });
