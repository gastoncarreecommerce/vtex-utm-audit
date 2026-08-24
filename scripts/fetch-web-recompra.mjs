/**
 * scripts/fetch-web-recompra.mjs
 *
 * Trae Recompra / Frecuencia / Basket size de WEB (todo pedido que NO es
 * from=app) para un rango de fechas cerrado, ej. julio 2026 completo.
 *
 * Por qué hace falta un fetch aparte: el pipeline diario (fetch-orders.js) ya
 * pide el detalle de TODOS los pedidos para detectar cuáles son de la app,
 * pero solo GUARDA email/items de los pedidos de la app (docs/data/daily/*-rows.json).
 * De los pedidos de Web descarta ese detalle y solo deja el agregado
 * (total_ecomm_orders / total_ecomm_gmv). Para Recompra/Frecuencia/Basket de
 * Web hace falta volver a pedir el detalle de esos pedidos.
 *
 * IMPORTANTE — PII: el email del cliente se usa SOLO en memoria durante esta
 * corrida (para contar clientes únicos y recompra). Nunca se escribe a disco
 * ni al repo: la salida es exclusivamente el agregado final (números), en
 * docs/data/web-recompra/{from}_{to}.json. Es un archivo PÚBLICO — no debe
 * llevar jamás nada por-pedido ni por-cliente.
 *
 * Uso: node scripts/fetch-web-recompra.mjs 2026-07-01 2026-07-31
 */
import axios from "axios";
import fs from "fs";
import path from "path";

const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;
const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN    = process.env.VTEX_APP_TOKEN;
const PAGE_SIZE     = 100;
const CONCURRENCY   = 25;
const RANGE_PARALLEL = 3;

const vtexHeaders = {
  "X-VTEX-API-AppKey": VTEX_KEY,
  "X-VTEX-API-AppToken": VTEX_TOKEN,
  "Content-Type": "application/json",
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
  const base = new Date(`${dateStr}T03:00:00.000Z`); // medianoche AR (UTC-3)
  const end = new Date(base.getTime() + 24 * 60 * 60 * 1000 - 1);
  const block = 60 * 60 * 1000;
  let current = new Date(base);
  while (current <= end) {
    const from = current.toISOString();
    const to = new Date(Math.min(current.getTime() + block - 1, end.getTime())).toISOString();
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
      headers: vtexHeaders, transformRequest: [d => d], timeout: 30000,
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

function getCustomAppFrom(order) {
  for (const app of order?.customData?.customApps || []) {
    if (app?.fields?.from !== undefined) return String(app.fields.from).trim();
  }
  return "";
}

// Recupera el email real sacando el sufijo por-orden que agrega VTEX
// (<email>-<orderref>.ct.vtex.com.br). Usado SOLO en memoria.
function realEmail(e) {
  if (!e) return null;
  return String(e).replace(/-[^-@]*\.ct\.vtex\.com\.br$/i, "").toLowerCase() || null;
}

// ── Estado acumulado en memoria para TODO el período (nunca se persiste tal cual) ──
const state = {
  webOrders: 0,
  webGmv: 0,
  webUnits: 0,
  customers: new Map(), // email normalizado -> cantidad de pedidos web
  seen: new Set(),       // orderId ya procesado (evita duplicados de reintentos)
};

async function processBatch(orderIds) {
  for (let i = 0; i < orderIds.length; i += CONCURRENCY) {
    const batch = orderIds.slice(i, i + CONCURRENCY);
    const details = await Promise.all(batch.map(async id => {
      try { return await fetchOrderDetail(id); } catch { return null; }
    }));
    for (const detail of details) {
      if (!detail?.orderId) continue;
      if (state.seen.has(detail.orderId)) continue;
      state.seen.add(detail.orderId);

      if (getCustomAppFrom(detail) === "app") continue; // eso ya lo tenemos vía el pipeline de la app

      state.webOrders++;
      state.webGmv += typeof detail.value === "number" ? detail.value / 100 : 0;
      for (const item of detail.items || []) state.webUnits += Number(item.quantity) || 0;

      const key = realEmail(detail.clientProfileData?.email);
      if (key) state.customers.set(key, (state.customers.get(key) || 0) + 1);
    }
  }
}

async function processRange(from, to) {
  let page = 1, totalPages = null, consec = 0;
  const failed = [];
  while (true) {
    let data;
    try { data = await fetchOrderList(from, to, page); consec = 0; }
    catch {
      consec++;
      if (consec >= 3) { failed.push(page); consec = 0; page++; if (totalPages && page > totalPages) break; continue; }
      await sleep(2000); continue;
    }
    if (totalPages === null) {
      const total = data.paging?.total || 0;
      totalPages = Math.ceil(total / PAGE_SIZE);
      if (!total) break;
    }
    const ids = (data.list || []).map(o => o.orderId).filter(Boolean);
    if (ids.length) await processBatch(ids);
    if (page >= totalPages) break;
    page++;
  }
  for (const p of failed) {
    try {
      const data = await fetchOrderList(from, to, p);
      const ids = (data.list || []).map(o => o.orderId).filter(Boolean);
      if (ids.length) await processBatch(ids);
    } catch { console.error(`  ✗ Página no recuperada: ${from.slice(0, 16)} pág ${p}`); }
  }
}

function eachDate(from, to) {
  const out = [];
  let d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); }
  return out;
}

async function main() {
  const from = process.argv[2], to = process.argv[3];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "")) {
    console.error("Uso: node scripts/fetch-web-recompra.mjs YYYY-MM-DD YYYY-MM-DD");
    process.exit(1);
  }
  if (!VTEX_ACCOUNT || !VTEX_KEY || !VTEX_TOKEN) {
    console.error("Faltan credenciales VTEX (VTEX_ACCOUNT / VTEX_APP_KEY / VTEX_APP_TOKEN).");
    process.exit(1);
  }

  const dates = eachDate(from, to);
  console.log(`\n🚀 Web recompra ${from} → ${to} (${dates.length} días)`);

  for (const date of dates) {
    const ranges = buildDateRanges(date);
    for (let i = 0; i < ranges.length; i += RANGE_PARALLEL) {
      const batch = ranges.slice(i, i + RANGE_PARALLEL);
      await Promise.all(batch.map(({ from: f, to: t }) => processRange(f, t)));
    }
    console.log(`  ✓ ${date} · acumulado: web ${state.webOrders} · clientes ${state.customers.size}`);
  }

  const webOrders = state.webOrders;
  const clientes = state.customers.size;
  const recompraCnt = [...state.customers.values()].filter(c => c >= 2).length;
  const ordersWithEmail = [...state.customers.values()].reduce((s, c) => s + c, 0);

  const out = {
    from, to, days: dates.length,
    web_orders: webOrders,
    web_gmv: Math.round(state.webGmv),
    web_ticket: webOrders ? Math.round(state.webGmv / webOrders) : 0,
    web_units: state.webUnits,
    web_basket_size: webOrders ? +(state.webUnits / webOrders).toFixed(2) : 0,
    web_clientes: clientes,
    web_recompra_pct: clientes ? +(recompraCnt / clientes * 100).toFixed(2) : 0,
    web_frecuencia: clientes ? +(ordersWithEmail / clientes).toFixed(3) : 0,
    generated_at: process.env.SOURCE_DATE || "",
    note: "Solo agregados. No contiene datos por pedido ni por cliente.",
  };

  const outDir = "docs/data/web-recompra";
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${from}_${to}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

  console.log(`\n✅ ${outPath}`);
  console.log(`   Web: ${webOrders} pedidos · ticket $${out.web_ticket.toLocaleString()} · basket ${out.web_basket_size}`);
  console.log(`   Recompra ${out.web_recompra_pct}% · Frecuencia ${out.web_frecuencia} · clientes ${clientes}`);
}

main().catch(err => { console.error("💥 Fatal:", err.message); process.exit(1); });
