const axios = require("axios");
const { google } = require("googleapis");

const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;
const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;
const SHEET_ID     = process.env.SHEET_ID;
const PAGE_SIZE    = 100;
const CONCURRENCY  = 10;

const vtexHeaders = {
  "X-VTEX-API-AppKey":   VTEX_KEY,
  "X-VTEX-API-AppToken": VTEX_TOKEN,
  "Content-Type":        "application/json"
};

function buildDateRanges() {
  const ranges = [];
  const start  = new Date("2026-05-27T18:00:00.000Z"); // 15hs Argentina en adelante
  const end    = new Date("2026-05-27T23:59:59.999Z");
  const block  = 6 * 60 * 60 * 1000;
  let current  = new Date(start);

  while (current <= end) {
    const from = current.toISOString();
    const to   = new Date(Math.min(current.getTime() + block - 1, end.getTime())).toISOString();
    ranges.push({ from, to });
    current = new Date(current.getTime() + block);
  }
  return ranges;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithRetry(fn, retries = 6, delay = 1500) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      const status = e?.response?.status;
      if (status === 401 || status === 403 || status === 404) throw e;
      if (i === retries - 1) throw e;
      const wait = delay * Math.pow(2, i);
      console.warn(`  ⚠ Retry ${i + 1}/${retries} (status ${status || e.message}) → esperando ${wait}ms...`);
      await sleep(wait);
    }
  }
}

function buildListUrl(from, to, page) {
  return `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/oms/pvt/orders`
    + `?f_creationDate=creationDate%3A%5B${from}%20TO%20${to}%5D`
    + `&orderBy=creationDate%2Cdesc`
    + `&page=${page}`
    + `&per_page=${PAGE_SIZE}`;
}

async function fetchOrderList(from, to, page) {
  return fetchWithRetry(async () => {
    const res = await axios.get(buildListUrl(from, to, page), {
      headers: vtexHeaders,
      transformRequest: [d => d],
      timeout: 30000
    });
    if (!res.data || !res.data.list) throw new Error("Respuesta inesperada de VTEX lista");
    return res.data;
  });
}

async function fetchOrderDetail(orderId) {
  try {
    return await fetchWithRetry(async () => {
      const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/oms/pvt/orders/${orderId}`;
      const res = await axios.get(url, { headers: vtexHeaders, timeout: 30000 });
      if (!res.data || !res.data.orderId) throw new Error("Respuesta inesperada de VTEX detalle");
      return res.data;
    });
  } catch (e) {
    console.error(`  ✗ Detalle ${orderId}: ${e?.response?.status || e.message}`);
    return null;
  }
}

function getCustomAppFrom(order) {
  const apps = order?.customData?.customApps || [];
  for (const app of apps) {
    if (app?.fields?.from !== undefined) return String(app.fields.from).trim();
  }
  return "";
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
  } catch (e) { return iso; }
}

async function processBatch(orderIds, seen) {
  const results = [];

  for (let i = 0; i < orderIds.length; i += CONCURRENCY) {
    const batch   = orderIds.slice(i, i + CONCURRENCY);
    const details = await Promise.all(batch.map(fetchOrderDetail));

    for (const detail of details) {
      if (!detail?.orderId) continue;

      const orderId   = detail.orderId;
      const fromValue = getCustomAppFrom(detail);

      if (fromValue !== "app") continue;
      if (seen.has(orderId)) continue;
      seen.add(orderId);

      const utmSource   = detail.marketingData?.utmSource   || "";
      const utmMedium   = detail.marketingData?.utmMedium   || "";
      const utmCampaign = detail.marketingData?.utmCampaign || "";
      const email       = detail.clientProfileData?.email   || "";
      const total       = typeof detail.value === "number" ? detail.value / 100 : 0;
      const utmStatus   = utmSource ? "CON UTM" : "SIN UTM";

      results.push([
        orderId,
        formatDate(detail.creationDate),
        detail.status || "",
        total,
        utmSource,
        utmMedium,
        utmCampaign,
        fromValue,
        email,
        utmStatus
      ]);
    }

    if (i + CONCURRENCY < orderIds.length) await sleep(100);
  }

  return results;
}

async function getSheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth  = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  return google.sheets({ version: "v4", auth });
}

async function flushToSheet(sheets, rows) {
  if (!rows.length) return;
  await fetchWithRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "HOJA 1!A1",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows }
    })
  );
}

async function processRange(from, to, seen, sheets, stats) {
  let page              = 1;
  let totalPages        = null;
  let consecutiveErrors = 0;

  while (true) {
    let data;
    try {
      data = await fetchOrderList(from, to, page);
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      console.error(`  ✗ Error página ${page} [${from.slice(0,10)} ${from.slice(11,16)}]: ${e?.response?.status || e.message}`);
      if (consecutiveErrors >= 3) {
        console.error(`  ✗ 3 errores consecutivos, abandonando este rango`);
        break;
      }
      await sleep(3000);
      continue;
    }

    if (totalPages === null) {
      const total = data.paging?.total || 0;
      totalPages  = Math.ceil(total / PAGE_SIZE);
      if (total > 0) {
        process.stdout.write(`  → ${total} pedidos (${totalPages} págs) `);
      } else {
        console.log(`  → 0 pedidos, saltando`);
        break;
      }
    }

    const orderIds = (data.list || []).map(o => o.orderId).filter(Boolean);
    if (!orderIds.length) break;

    const rows = await processBatch(orderIds, seen);
    stats.analyzed += orderIds.length;
    stats.found    += rows.length;
    stats.conUTM   += rows.filter(r => r[9] === "CON UTM").length;
    stats.sinUTM   += rows.filter(r => r[9] === "SIN UTM").length;
    stats.pending.push(...rows);

    process.stdout.write(".");

    if (stats.pending.length >= 300) {
      await flushToSheet(sheets, stats.pending);
      stats.pending = [];
    }

    if (page >= totalPages) break;
    page++;
    await sleep(200);
  }

  console.log(` ✓`);
}

async function main() {
  console.log("🚀 Completando día 27 — desde las 15hs Argentina");
  console.log(`   Cuenta: ${VTEX_ACCOUNT}`);
  console.log(`   Sheet:  ${SHEET_ID}\n`);

  const sheets = await getSheetsClient();

  // Sin clear — appendea a lo que ya está en la sheet
  const ranges = buildDateRanges();
  console.log(`📅 ${ranges.length} bloques de 6hs a procesar\n`);

  const seen  = new Set();
  const stats = { analyzed: 0, found: 0, conUTM: 0, sinUTM: 0, pending: [] };

  for (let i = 0; i < ranges.length; i++) {
    const { from, to } = ranges[i];
    const label = `${from.slice(0,10)} ${from.slice(11,16)} → ${to.slice(11,16)}`;
    process.stdout.write(`[${String(i+1).padStart(3)}/${ranges.length}] ${label} `);
    await processRange(from, to, seen, sheets, stats);
    await sleep(300);
  }

  if (stats.pending.length > 0) {
    await flushToSheet(sheets, stats.pending);
  }

  const pctSinUTM = stats.found > 0
    ? ((stats.sinUTM / stats.found) * 100).toFixed(1)
    : "0.0";

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`✅ FINALIZADO`);
  console.log(`   Pedidos analizados:     ${stats.analyzed.toLocaleString()}`);
  console.log(`   Pedidos de app totales: ${stats.found.toLocaleString()}`);
  console.log(`   Con UTM:                ${stats.conUTM.toLocaleString()}`);
  console.log(`   Sin UTM:                ${stats.sinUTM.toLocaleString()} (${pctSinUTM}%)`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main().catch(err => {
  console.error("\n💥 Error fatal:", err.message);
  process.exit(1);
});
