/**
 * fetch-orders.js
 * Fetches daily VTEX orders, segments by channel/seller, saves to docs/data/daily/
 * Usage: node fetch-orders.js [YYYY-MM-DD]   (default: yesterday AR time)
 */

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

// ── Config ──────────────────────────────────────────────────────────────
const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;
const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;
const PAGE_SIZE    = 100;
const CONCURRENCY  = 20;
const RANGE_PARALLEL = 3;

const vtexHeaders = {
  "X-VTEX-API-AppKey":   VTEX_KEY,
  "X-VTEX-API-AppToken": VTEX_TOKEN,
  "Content-Type":        "application/json"
};

// ── Maestro de sellers marketplace ─────────────────────────────────────
const MARKETPLACE_SELLERS = new Set([
  "abaco284","aircomputers546","americanwood705","anubisdecoracion261","Autodo",
  "awaresolutions923","awaresolutionssrl189","bangho","beautysas","Bebitos",
  "bigstarsar","blackmusic902","brogas700","buhl040","bulonfer","bydsudamericana031",
  "calefactorescalden943","calm328","carrelloar624","clubdigital656","codini088",
  "colchonesysommier288","CRF","ctcgroup940","ctcproductos740","dehuka404","demelf394",
  "derpacomar064","dielfe771","districolor768","districolor804","donacero930","dvigi943",
  "eczanepharma170","electroluxar","emcmuebles005","emoodmarket","enasport189",
  "estelar454","exosa541","ferreydeco793","gasei472","grupomarquez012","haustore986",
  "hidrolit736","hispanos470","hogarisnova327","homekong441","intecnova657",
  "internationalhomesa717","kamadoargentino563","kiluga771","kitsolar316",
  "laplanchetta301","lilasense516","limansky653","lumina946","luxom345","magazzinoar",
  "mantra171","mgsolucionsa519","microbell122","mueblesespeciales315","mundopino165",
  "neba791","neoseg957","ohgiftcard537","ortopedialibertad288","outin691",
  "pampadeacero948","phidigital143","pinataar","pinataarCRF","potenzaemarketsa179",
  "praga278","prestigio1","Producteca225119","Producteca232302","Producteca232621",
  "Producteca237680","Producteca238451","Producteca238567","Producteca238818",
  "Producteca239254","Producteca241872","Producteca241968","Producteca242766",
  "Producteca246251","Producteca246437","Producteca246519","Producteca246643",
  "Producteca247492","Producteca247683","Producteca249023","Producteca249357",
  "Producteca249773","Producteca251086","Producteca251428","Producteca252062",
  "Producteca70438","puntodeportivoar","rockinroll106","rua839","sccortinasrollers240",
  "sharecomputacion867","shopwide119","soportar561","springwall441","sungreensrl102",
  "tecnofull391","tenacta582","tiendasdigitalesar","todotodo061","topmega421",
  "turboblender168","tutiendaonline271","unitecsa564","universopinturerias","Vexi",
  "vexistore751","vexistorear","vinson363","vmpsa473","whirlpoolarg","wolke303",
  "wsabiskin470","xcientoargentino189"
]);

const NON_FOOD_SELLER = "carrefourar0899";
const QC_SALES_CHANNEL = "3";

// ── Date helpers ────────────────────────────────────────────────────────
function getTargetDate() {
  const arg = process.argv[2];
  if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  // Yesterday in Argentina (UTC-3)
  const now = new Date();
  const ar  = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  ar.setUTCDate(ar.getUTCDate() - 1);
  return ar.toISOString().slice(0, 10);
}

function buildDateRanges(dateStr) {
  const ranges = [];
  const base   = new Date(`${dateStr}T03:00:00.000Z`); // medianoche AR
  const end    = new Date(base.getTime() + 24 * 60 * 60 * 1000 - 1);
  const block  = 60 * 60 * 1000; // 1 hora
  let current  = new Date(base);

  while (current <= end) {
    const from = current.toISOString();
    const to   = new Date(Math.min(current.getTime() + block - 1, end.getTime())).toISOString();
    ranges.push({ from, to });
    current = new Date(current.getTime() + block);
  }
  return ranges;
}

// ── Fetch helpers ───────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(fn, retries = 8, delay = 1500) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      const s = e?.response?.status;
      if (s === 401 || s === 403 || s === 404) throw e;
      if (i === retries - 1) throw e;
      const wait = delay * Math.pow(2, i);
      process.stderr.write(`  ⚠ Retry ${i+1} (${s||e.message}) ${wait}ms\n`);
      await sleep(wait);
    }
  }
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

// ── Total ecommerce (all orders, no detail) ─────────────────────────────
async function fetchTotalOrders(from, to) {
  try {
    const res = await axios.get(buildListUrl(from, to, 1), {
      headers: vtexHeaders, transformRequest: [d => d], timeout: 30000
    });
    return res.data?.paging?.total || 0;
  } catch (e) {
    return 0;
  }
}

// ── Segmentation ────────────────────────────────────────────────────────
function getCustomAppFrom(order) {
  for (const app of order?.customData?.customApps || []) {
    if (app?.fields?.from !== undefined) return String(app.fields.from).trim();
  }
  return "";
}

function categorizeOrder(detail) {
  const sc = String(detail.salesChannel || "");
  if (sc === QC_SALES_CHANNEL) return "quickcommerce";

  const sellers = new Set((detail.items || []).map(i => i.seller).filter(Boolean));
  for (const s of sellers) {
    if (MARKETPLACE_SELLERS.has(s)) return "marketplace";
  }
  if (sellers.has(NON_FOOD_SELLER)) return "non_food";
  return "food";
}

// ── Process orders ──────────────────────────────────────────────────────
async function processBatch(orderIds, seen, result) {
  for (let i = 0; i < orderIds.length; i += CONCURRENCY) {
    const batch   = orderIds.slice(i, i + CONCURRENCY);
    const details = await Promise.all(batch.map(async id => {
      try { return await fetchOrderDetail(id); }
      catch (e) { return null; }
    }));

    for (const detail of details) {
      if (!detail?.orderId) continue;
      const orderId   = detail.orderId;
      const fromValue = getCustomAppFrom(detail);
      if (fromValue !== "app") continue;
      if (seen.has(orderId)) continue;
      seen.add(orderId);

      const segment   = categorizeOrder(detail);
      const gmv       = typeof detail.value === "number" ? detail.value / 100 : 0;
      const utmSource = detail.marketingData?.utmSource || "";
      const status    = detail.status || "";

      result.app.total++;
      result.app.gmv += gmv;
      if (utmSource) result.app.con_utm++;
      else result.app.sin_utm++;

      result.app.segments[segment].orders++;
      result.app.segments[segment].gmv += gmv;

      // Store raw row for export
      result.rows.push({
        order_id:     orderId,
        fecha:        new Date(detail.creationDate).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }),
        estado:       status,
        total:        Math.round(gmv),
        utm_source:   utmSource,
        utm_medium:   detail.marketingData?.utmMedium || "",
        utm_campaign: detail.marketingData?.utmCampaign || "",
        coupon:       detail.marketingData?.coupon || "",
        segment,
        email:        detail.clientProfileData?.email || "",
        utm_status:   utmSource ? "CON UTM" : "SIN UTM",
        items: (detail.items || []).map(item => ({
          id:     item.id,
          name:   item.name,
          sku:    item.refId || item.id,
          qty:    item.quantity,
          price:  (item.price || 0) / 100,
          seller: item.seller
        }))
      });
    }
  }
}

async function processRange(from, to, seen, result) {
  let page = 1, totalPages = null, consec = 0;
  const failed = [];

  while (true) {
    let data;
    try {
      data = await fetchOrderList(from, to, page);
      consec = 0;
    } catch (e) {
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
    } catch (e) {
      console.error(`  ✗ Página no recuperada: ${from.slice(0,16)} pág ${p}`);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const targetDate = getTargetDate();
  console.log(`\n🚀 Fetching orders for ${targetDate} (Argentina time)\n`);

  const ranges = buildDateRanges(targetDate);
  console.log(`📅 ${ranges.length} hourly blocks | ${RANGE_PARALLEL} parallel\n`);

  const seen   = new Set();
  const result = {
    date:                targetDate,
    total_ecomm_orders:  0,
    total_ecomm_gmv:     0,
    app: {
      total:   0,
      gmv:     0,
      con_utm: 0,
      sin_utm: 0,
      segments: {
        food:         { orders: 0, gmv: 0 },
        non_food:     { orders: 0, gmv: 0 },
        marketplace:  { orders: 0, gmv: 0 },
        quickcommerce:{ orders: 0, gmv: 0 }
      }
    },
    rows: []
  };

  for (let i = 0; i < ranges.length; i += RANGE_PARALLEL) {
    const batch  = ranges.slice(i, i + RANGE_PARALLEL);
    const labels = batch.map(r => r.from.slice(11,16)).join(" | ");
    process.stdout.write(`[${i+1}-${Math.min(i+RANGE_PARALLEL,ranges.length)}/${ranges.length}] ${labels} ... `);
    await Promise.all(batch.map(({ from, to }) => processRange(from, to, seen, result)));
    console.log(`✓ app: ${result.app.total}`);
  }

  // Finalize
  result.app.gmv              = Math.round(result.app.gmv);
  result.app.segments.food.gmv         = Math.round(result.app.segments.food.gmv);
  result.app.segments.non_food.gmv     = Math.round(result.app.segments.non_food.gmv);
  result.app.segments.marketplace.gmv  = Math.round(result.app.segments.marketplace.gmv);
  result.app.segments.quickcommerce.gmv= Math.round(result.app.segments.quickcommerce.gmv);
  result.participation_pct = result.total_ecomm_orders > 0
    ? Math.round((result.app.total / result.total_ecomm_orders) * 1000) / 10
    : 0;
  result.utm_pct_sin = result.app.total > 0
    ? Math.round((result.app.sin_utm / result.app.total) * 1000) / 10
    : 0;

  // Save daily JSON (summary without rows)
  const outDir  = path.join("docs", "data", "daily");
  const outPath = path.join(outDir, `${targetDate}.json`);
  fs.mkdirSync(outDir, { recursive: true });

  const { rows, ...summary } = result;
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\n💾 Saved: ${outPath}`);

  // Save rows CSV for export
  const csvPath = path.join(outDir, `${targetDate}-rows.json`);
  fs.writeFileSync(csvPath, JSON.stringify(rows));
  console.log(`💾 Saved: ${csvPath}`);

  // Update index.json
  const indexPath = path.join("docs", "data", "index.json");
  let idx = { dates: [] };
  try { idx = JSON.parse(fs.readFileSync(indexPath, "utf8")); } catch {}
  if (!idx.dates.includes(targetDate)) {
    idx.dates.push(targetDate);
    idx.dates.sort().reverse();
  }
  fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2));

  const pct = result.participation_pct;
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✅ ${targetDate}`);
  console.log(`   Total ecomm:       ${result.total_ecomm_orders.toLocaleString()}`);
  console.log(`   App total:         ${result.app.total.toLocaleString()} (${pct}% participación)`);
  console.log(`   Con UTM:           ${result.app.con_utm}`);
  console.log(`   Sin UTM:           ${result.app.sin_utm} (${result.utm_pct_sin}%)`);
  console.log(`   Food:              ${result.app.segments.food.orders}`);
  console.log(`   Non Food (H&E):    ${result.app.segments.non_food.orders}`);
  console.log(`   Marketplace:       ${result.app.segments.marketplace.orders}`);
  console.log(`   Quickcommerce:     ${result.app.segments.quickcommerce.orders}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

main().catch(err => { console.error("💥 Fatal:", err.message); process.exit(1); });
