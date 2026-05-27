const axios = require("axios");
const { google } = require("googleapis");

const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;
const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;
const SHEET_ID     = process.env.SHEET_ID;
const DATE_FROM    = "2026-05-01T00:00:00.000Z";
const DATE_TO      = "2026-05-27T23:59:59.999Z";
const PAGE_SIZE    = 100;
const CONCURRENCY  = 15; // paralelo conservador para no quemar VTEX

const vtexHeaders = {
  "X-VTEX-API-AppKey":   VTEX_KEY,
  "X-VTEX-API-AppToken": VTEX_TOKEN,
  "Content-Type":        "application/json"
};

// --- Google Sheets ---
async function getSheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth  = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  return google.sheets({ version: "v4", auth });
}

// --- Fetch con retry automático ---
async function fetchWithRetry(fn, retries = 5, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      const status = e?.response?.status;
      // No reintentar en errores que no son de red/throttle
      if (status === 404 || status === 401 || status === 403) throw e;
      if (i === retries - 1) throw e;
      const wait = delay * Math.pow(2, i);
      console.warn(`  ⚠ Retry ${i + 1}/${retries} (status ${status}) esperando ${wait}ms...`);
      await sleep(wait);
    }
  }
}

// --- Traer página de lista ---
async function fetchOrderList(page) {
  return fetchWithRetry(async () => {
    const dateFilter = `creationDate:[${DATE_FROM} TO ${DATE_TO}]`;
    const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/oms/pvt/orders`
      + `?f_creationDate=${encodeURIComponent(dateFilter)}`
      + `&orderBy=creationDate%2Cdesc`
      + `&page=${page}`
      + `&per_page=${PAGE_SIZE}`;
    const res = await axios.get(url, { headers: vtexHeaders });
    return res.data;
  });
}

// --- Traer detalle de un pedido ---
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

// --- Buscar from en customApps ---
function getCustomAppFrom(order) {
  const apps = order?.customData?.customApps || [];
  for (const app of apps) {
    if (app?.fields?.from !== undefined) return app.fields.from;
  }
  return "";
}

// --- Formatear fecha a hora argentina ---
function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
  } catch (e) {
    return iso;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// --- Procesar batch en paralelo ---
async function processBatch(orderIds, seen) {
  const results = [];
  for (let i = 0; i < orderIds.length; i += CONCURRENCY) {
    const batch   = orderIds.slice(i, i + CONCURRENCY);
    const details = await Promise.all(batch.map(fetchOrderDetail));

    for (const detail of details) {
      if (!detail) continue;

      const orderId     = detail.orderId;
      const utmSource   = detail.marketingData?.utmSource   || "";
      const utmMedium   = detail.marketingData?.utmMedium   || "";
      const utmCampaign = detail.marketingData?.utmCampaign || "";
      const fromValue   = getCustomAppFrom(detail);

      // Deduplicar
      if (seen.has(orderId)) continue;
      seen.add(orderId);

      if (fromValue === "app" && !utmSource) {
        results.push([
          orderId,
          formatDate(detail.creationDate),
          detail.status || "",
          detail.value ? detail.value / 100 : 0,
          utmSource,
          utmMedium,
          utmCampaign,
          fromValue,
          detail.clientProfileData?.email || ""
        ]);
      }
    }
  }
  return results;
}

// --- Escribir en sheet ---
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

// --- Main ---
async function main() {
  console.log("🚀 Iniciando auditoría VTEX...");
  console.log(`   Período: ${DATE_FROM} → ${DATE_TO}`);

  const sheets = await getSheetsClient();

  // Limpiar sheet y headers
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: "HOJA 1" });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "HOJA 1!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        "Order ID", "Fecha creación", "Estado", "Total (ARS)",
        "UTM Source", "UTM Medium", "UTM Campaign", "customApp from", "Email cliente"
      ]]
    }
  });

  // Primera página para saber el total
  const firstPage  = await fetchOrderList(1);
  const totalItems = firstPage.paging?.total || 0;
  const totalPages = Math.ceil(totalItems / PAGE_SIZE);
  console.log(`\n📦 Total pedidos: ${totalItems} | Páginas: ${totalPages}\n`);

  const seen        = new Set(); // deduplicado global
  let allRows       = [];
  let totalAnalyzed = 0;
  let totalFound    = 0;

  for (let page = 1; page <= totalPages; page++) {
    process.stdout.write(`Página ${page}/${totalPages}... `);

    let data;
    try {
      data = page === 1 ? firstPage : await fetchOrderList(page);
    } catch (e) {
      console.error(`\n✗ Error al traer página ${page}: ${e?.response?.status || e.message}. Saltando...`);
      await sleep(2000);
      continue;
    }

    const orderIds = (data.list || []).map(o => o.orderId);
    const rows     = await processBatch(orderIds, seen);

    totalAnalyzed += orderIds.length;
    totalFound    += rows.length;
    allRows.push(...rows);

    console.log(`✓ encontrados: ${rows.length} (total: ${totalFound})`);

    // Flush cada 10 páginas
    if (page % 10 === 0 && allRows.length > 0) {
      await flushToSheet(sheets, allRows);
      console.log(`  💾 Flush: ${allRows.length} filas escritas en sheet\n`);
      allRows = [];
    }

    // Pequeña pausa cada 50 páginas para no saturar VTEX
    if (page % 50 === 0) {
      console.log("  ⏸ Pausa de 2s...");
      await sleep(2000);
    }
  }

  // Flush final
  if (allRows.length > 0) {
    await flushToSheet(sheets, allRows);
    console.log(`  💾 Flush final: ${allRows.length} filas escritas\n`);
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`✅ FINALIZADO`);
  console.log(`   Pedidos analizados: ${totalAnalyzed}`);
  console.log(`   Sin UTM + from=app: ${totalFound}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main().catch(err => {
  console.error("💥 Error fatal:", err.message);
  process.exit(1);
});
