const axios = require("axios");
const { google } = require("googleapis");

const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;
const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;
const SHEET_ID     = process.env.SHEET_ID;
const PAGE_SIZE    = 100;
const CONCURRENCY  = 15;

// Partir el mes en rangos de 3 días
function buildDateRanges() {
  const ranges = [];
  const start  = new Date("2026-05-01T00:00:00.000Z");
  const end    = new Date("2026-05-27T23:59:59.999Z");
  let current  = new Date(start);

  while (current < end) {
    const from = current.toISOString();
    const to   = new Date(Math.min(
      current.getTime() + (3 * 24 * 60 * 60 * 1000) - 1,
      end.getTime()
    )).toISOString();
    ranges.push({ from, to });
    current = new Date(current.getTime() + (3 * 24 * 60 * 60 * 1000));
  }
  return ranges;
}

const vtexHeaders = {
  "X-VTEX-API-AppKey":   VTEX_KEY,
  "X-VTEX-API-AppToken": VTEX_TOKEN,
  "Content-Type":        "application/json"
};

async function getSheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth  = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  return google.sheets({ version: "v4", auth });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithRetry(fn, retries = 5, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      const status = e?.response?.status;
      if (status === 401 || status === 403) throw e;
      if (i === retries - 1) throw e;
      const wait = delay * Math.pow(2, i);
      console.warn(`  ⚠ Retry ${i + 1}/${retries} (status ${status}) esperando ${wait}ms...`);
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
      transformRequest: [d => d]
    });
    return res.data;
  });
}

async function fetchOrderDetail(orderId) {
  try {
    return await fetchWithRetry(async () => {
      const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/oms/pvt/orders/${orderId}`;
      const res = await axios.get(url, { headers: vtexHeaders });
      return res.data;
    });
  } catch (e) {
    console.error(`  ✗ Error detalle ${orderId}: ${e?.response?.status || e.message}`);
    return null;
  }
}

function getCustomAppFrom(order) {
  const apps = order?.customData?.customApps || [];
  for (const app of apps) {
    if (app?.fields?.from !== undefined) return app.fields.from;
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
      if (!detail) continue;
      const orderId   = detail.orderId;
      const fromValue = getCustomAppFrom(detail);
      if (fromValue !== "app") continue;
      if (seen.has(orderId)) continue;
      seen.add(orderId);

      const utmSource   = detail.marketingData?.utmSource   || "";
      const utmMedium   = detail.marketingData?.utmMedium   || "";
      const utmCampaign = detail.marketingData?.utmCampaign || "";

      results.push([
        orderId,
        formatDate(detail.creationDate),
        detail.status || "",
        detail.value ? detail.value / 100 : 0,
        utmSource,
        utmMedium,
        utmCampaign,
        fromValue,
        detail.clientProfileData?.email || "",
        utmSource ? "CON UTM" : "SIN UTM"
      ]);
    }
  }
  return results;
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

async function processRange(from, to, seen, sheets, globalStats) {
  let page = 1;
  let totalPagesInRange = null;

  while (true) {
    let data;
    try {
      data = await fetchOrderList(from, to, page);
    } catch (e) {
      console.error(`  ✗ Error página ${page} [${from.slice(0,10)}]: ${e?.response?.status || e.message}`);
      break;
    }

    if (!totalPagesInRange) {
      totalPagesInRange = Math.ceil((data.paging?.total || 0) / PAGE_SIZE);
      console.log(`  → ${data.paging?.total || 0} pedidos en este rango (${totalPagesInRange} páginas)`);
    }

    const orderIds = (data.list || []).map(o => o.orderId);
    if (!orderIds.length) break;

    const rows = await processBatch(orderIds, seen);
    globalStats.analyzed += orderIds.length;
    globalStats.found    += rows.length;
    globalStats.conUTM   += rows.filter(r => r[9] === "CON UTM").length;
    globalStats.sinUTM   += rows.filter(r => r[9] === "SIN UTM").length;
    globalStats.pending.push(...rows);

    // Flush cada 500 filas
    if (globalStats.pending.length >= 500) {
      await flushToSheet(sheets, globalStats.pending);
      console.log(`  💾 Flush: ${globalStats.pending.length} filas | total app → con UTM: ${globalStats.conUTM} | sin UTM: ${globalStats.sinUTM}`);
      globalStats.pending = [];
    }

    if (page >= totalPagesInRange) break;
    page++;
  }
}

async function main() {
  console.log("🚀 Iniciando auditoría VTEX...");

  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: "HOJA 1" });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "HOJA 1!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        "Order ID", "Fecha creación", "Estado", "Total (ARS)",
        "UTM Source", "UTM Medium", "UTM Campaign", "customApp from",
        "Email cliente", "UTM Status"
      ]]
    }
  });

  const ranges = buildDateRanges();
  console.log(`\n📅 Procesando ${ranges.length} rangos de 3 días\n`);

  const seen        = new Set();
  const globalStats = { analyzed: 0, found: 0, conUTM: 0, sinUTM: 0, pending: [] };

  for (let i = 0; i < ranges.length; i++) {
    const { from, to } = ranges[i];
    console.log(`\n[${i + 1}/${ranges.length}] ${from.slice(0,10)} → ${to.slice(0,10)}`);
    await processRange(from, to, seen, sheets, globalStats);
    await sleep(500);
  }

  // Flush final
  if (globalStats.pending.length > 0) {
    await flushToSheet(sheets, globalStats.pending);
    console.log(`  💾 Flush final: ${globalStats.pending.length} filas`);
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`✅ FINALIZADO`);
  console.log(`   Pedidos analizados:     ${globalStats.analyzed}`);
  console.log(`   Pedidos de app totales: ${globalStats.found}`);
  console.log(`   Con UTM:                ${globalStats.conUTM}`);
  console.log(`   Sin UTM:                ${globalStats.sinUTM}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main().catch(err => {
  console.error("💥 Error fatal:", err.message);
  process.exit(1);
});
