const axios = require("axios");
const { google } = require("googleapis");

const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;
const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;
const SHEET_ID     = process.env.SHEET_ID;
const SHEET_NAME   = "MAYO COMPLETO";
const PAGE_SIZE    = 100;
const CONCURRENCY  = 20;   // requests paralelos por batch
const RANGE_PARALLEL = 3;  // rangos horarios en paralelo

const vtexHeaders = {
  "X-VTEX-API-AppKey":   VTEX_KEY,
  "X-VTEX-API-AppToken": VTEX_TOKEN,
  "Content-Type":        "application/json"
};

// Mayo completo en hora Argentina (UTC-3)
function buildDateRanges() {
  const ranges = [];
  const start  = new Date("2026-05-01T03:00:00.000Z"); // 00:00 Argentina
  const end    = new Date("2026-06-01T02:59:59.999Z"); // 23:59 31/05 Argentina
  const block  = 1 * 60 * 60 * 1000; // bloques de 1 hora
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

async function fetchWithRetry(fn, retries = 8, delay = 1500) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      const status = e?.response?.status;
      if (status === 401 || status === 403 || status === 404) throw e;
      if (i === retries - 1) throw e;
      const wait = delay * Math.pow(2, i);
      console.warn(`  ⚠ Retry ${i+1}/${retries} (${status || e.message}) → ${wait}ms`);
      await sleep(wait);
    }
  }
}

function buildListUrl(from, to, page) {
  return `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/oms/pvt/orders`
    + `?f_creationDate=creationDate%3A%5B${from}%20TO%20${to}%5D`
    + `&orderBy=creationDate%2Cdesc`
    + `&page=${page}&per_page=${PAGE_SIZE}`;
}

async function fetchOrderList(from, to, page) {
  return fetchWithRetry(async () => {
    const res = await axios.get(buildListUrl(from, to, page), {
      headers: vtexHeaders,
      transformRequest: [d => d],
      timeout: 30000
    });
    if (!res.data?.list) throw new Error("Respuesta inesperada lista");
    return res.data;
  });
}

async function fetchOrderDetail(orderId) {
  return fetchWithRetry(async () => {
    const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/oms/pvt/orders/${orderId}`;
    const res = await axios.get(url, { headers: vtexHeaders, timeout: 30000 });
    if (!res.data?.orderId) throw new Error("Respuesta inesperada detalle");
    return res.data;
  });
}

function getCustomAppFrom(order) {
  for (const app of order?.customData?.customApps || []) {
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
    const details = await Promise.all(batch.map(async id => {
      try { return await fetchOrderDetail(id); }
      catch (e) { console.error(`  ✗ ${id}: ${e?.response?.status || e.message}`); return null; }
    }));

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

      results.push([
        orderId,
        formatDate(detail.creationDate),
        detail.status || "",
        typeof detail.value === "number" ? detail.value / 100 : 0,
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

async function getSheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth  = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  return google.sheets({ version: "v4", auth });
}

// Mutex para escribir en la sheet sin race conditions
class SheetWriter {
  constructor(sheets) {
    this.sheets  = sheets;
    this.queue   = Promise.resolve();
    this.pending = [];
  }

  add(rows) {
    this.pending.push(...rows);
    if (this.pending.length >= 500) return this.flush();
    return Promise.resolve();
  }

  flush() {
    if (!this.pending.length) return Promise.resolve();
    const rows     = this.pending.splice(0);
    this.queue     = this.queue.then(() => fetchWithRetry(() =>
      this.sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: rows }
      })
    ));
    return this.queue;
  }
}

async function processRange(from, to, seen, writer, stats) {
  let page             = 1;
  let totalPages       = null;
  let consecutiveErrors = 0;
  const failedPages    = [];

  while (true) {
    let data;
    try {
      data = await fetchOrderList(from, to, page);
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        failedPages.push(page);
        consecutiveErrors = 0;
        page++;
        if (totalPages && page > totalPages) break;
        continue;
      }
      await sleep(2000);
      continue;
    }

    if (totalPages === null) {
      const total = data.paging?.total || 0;
      totalPages  = Math.ceil(total / PAGE_SIZE);
      if (!total) break;
    }

    const orderIds = (data.list || []).map(o => o.orderId).filter(Boolean);
    if (orderIds.length) {
      const rows = await processBatch(orderIds, seen);
      stats.analyzed += orderIds.length;
      stats.found    += rows.length;
      stats.conUTM   += rows.filter(r => r[9] === "CON UTM").length;
      stats.sinUTM   += rows.filter(r => r[9] === "SIN UTM").length;
      await writer.add(rows);
    }

    if (page >= totalPages) break;
    page++;
  }

  // Reintentar páginas fallidas
  for (const p of failedPages) {
    try {
      const data     = await fetchOrderList(from, to, p);
      const orderIds = (data.list || []).map(o => o.orderId).filter(Boolean);
      if (orderIds.length) {
        const rows = await processBatch(orderIds, seen);
        stats.analyzed += orderIds.length;
        stats.found    += rows.length;
        stats.conUTM   += rows.filter(r => r[9] === "CON UTM").length;
        stats.sinUTM   += rows.filter(r => r[9] === "SIN UTM").length;
        await writer.add(rows);
      }
    } catch (e) {
      stats.lostPages.push({ from: from.slice(0,16), page: p });
    }
  }
}

async function main() {
  console.log("🚀 Auditoría VTEX — Mayo 2026 COMPLETO");
  console.log(`   Rango: 01/05 00:00 → 31/05 23:59 (hora Argentina)\n`);

  const sheets = await getSheetsClient();

  // Crear/limpiar hoja
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = meta.data.sheets.find(s => s.properties.title === SHEET_NAME);
  if (exists) {
    await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: SHEET_NAME });
  } else {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_NAME } } }] }
    });
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [[
      "Order ID", "Fecha creación", "Estado", "Total (ARS)",
      "UTM Source", "UTM Medium", "UTM Campaign",
      "customApp from", "Email cliente", "UTM Status"
    ]]}
  });

  const ranges = buildDateRanges();
  console.log(`📅 ${ranges.length} bloques de 1 hora | ${RANGE_PARALLEL} en paralelo\n`);

  const seen   = new Set();
  const stats  = { analyzed: 0, found: 0, conUTM: 0, sinUTM: 0, lostPages: [] };
  const writer = new SheetWriter(sheets);

  // Procesar rangos de a RANGE_PARALLEL en paralelo
  for (let i = 0; i < ranges.length; i += RANGE_PARALLEL) {
    const batch = ranges.slice(i, i + RANGE_PARALLEL);
    const labels = batch.map(r => `${r.from.slice(11,16)}`).join(" | ");
    process.stdout.write(`[${i+1}-${Math.min(i+RANGE_PARALLEL, ranges.length)}/${ranges.length}] UTC ${labels} ... `);

    await Promise.all(batch.map(({ from, to }) =>
      processRange(from, to, seen, writer, stats)
    ));

    console.log(`✓ app acum: ${stats.found} (sin UTM: ${stats.sinUTM})`);
  }

  await writer.flush();

  const pct = stats.found > 0 ? ((stats.sinUTM / stats.found) * 100).toFixed(1) : "0.0";

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`✅ FINALIZADO`);
  console.log(`   Pedidos analizados:     ${stats.analyzed.toLocaleString()}`);
  console.log(`   Pedidos de app totales: ${stats.found.toLocaleString()}`);
  console.log(`   Con UTM:                ${stats.conUTM.toLocaleString()}`);
  console.log(`   Sin UTM:                ${stats.sinUTM.toLocaleString()} (${pct}%)`);
  if (stats.lostPages.length) {
    console.log(`\n  ⚠ Páginas no recuperadas: ${stats.lostPages.length}`);
    stats.lostPages.forEach(p => console.log(`    - ${p.from} pág ${p.page}`));
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main().catch(err => {
  console.error("\n💥 Error fatal:", err.message);
  process.exit(1);
});
