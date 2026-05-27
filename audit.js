const axios = require("axios");
const { google } = require("googleapis");

const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;
const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;
const SHEET_ID     = process.env.SHEET_ID;
const DATE_FROM    = "2026-05-01T00:00:00.000Z";
const DATE_TO      = "2026-05-27T23:59:59.999Z";
const PAGE_SIZE    = 100;
const CONCURRENCY  = 20;

const vtexHeaders = {
  "X-VTEX-API-AppKey":   VTEX_KEY,
  "X-VTEX-API-AppToken": VTEX_TOKEN,
  "Content-Type":        "application/json"
};

// --- Google Sheets auth via service account ---
async function getSheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  return google.sheets({ version: "v4", auth });
}

// --- Traer página de lista ---
async function fetchOrderList(page) {
  const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/oms/pvt/orders`
    + `?f_creationDate=creationDate:[${DATE_FROM} TO ${DATE_TO}]`
    + `&orderBy=creationDate,desc`
    + `&page=${page}&per_page=${PAGE_SIZE}`;
  const res = await axios.get(url, { headers: vtexHeaders });
  return res.data;
}

// --- Traer detalle de un pedido ---
async function fetchOrderDetail(orderId) {
  try {
    const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/oms/pvt/orders/${orderId}`;
    const res = await axios.get(url, { headers: vtexHeaders });
    return res.data;
  } catch (e) {
    console.error(`Error detalle ${orderId}: ${e.message}`);
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
  return new Date(iso).toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
}

// --- Procesar en batches paralelos ---
async function processBatch(orderIds) {
  const results = [];
  for (let i = 0; i < orderIds.length; i += CONCURRENCY) {
    const batch = orderIds.slice(i, i + CONCURRENCY);
    const details = await Promise.all(batch.map(fetchOrderDetail));
    for (const detail of details) {
      if (!detail) continue;
      const utmSource   = detail.marketingData?.utmSource   || "";
      const utmMedium   = detail.marketingData?.utmMedium   || "";
      const utmCampaign = detail.marketingData?.utmCampaign || "";
      const fromValue   = getCustomAppFrom(detail);
      if (fromValue === "app" && !utmSource) {
        results.push([
          detail.orderId,
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
    console.log(`  Batch procesado: ${Math.min(i + CONCURRENCY, orderIds.length)}/${orderIds.length}`);
  }
  return results;
}

// --- Main ---
async function main() {
  console.log("Iniciando auditoría VTEX...");

  const sheets = await getSheetsClient();

  // Limpiar sheet y poner headers
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: "HOJA 1"
  });
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

  // Obtener total de páginas
  const firstPage = await fetchOrderList(1);
  const totalPages = Math.ceil((firstPage.paging?.total || 0) / PAGE_SIZE);
  console.log(`Total pedidos: ${firstPage.paging?.total} | Páginas: ${totalPages}`);

  let allRows = [];
  const seen  = new Set(); // deduplicado

  for (let page = 1; page <= totalPages; page++) {
    console.log(`\nPágina ${page}/${totalPages}...`);
    const data = page === 1 ? firstPage : await fetchOrderList(page);
    const orderIds = (data.list || []).map(o => o.orderId);

    const rows = await processBatch(orderIds);

    // Deduplicar por orderId
    for (const row of rows) {
      if (!seen.has(row[0])) {
        seen.add(row[0]);
        allRows.push(row);
      }
    }

    // Flush cada 10 páginas para no perder datos
    if (allRows.length > 0 && page % 10 === 0) {
      await flushToSheet(sheets, allRows);
      console.log(`✅ Flush: ${allRows.length} filas escritas`);
      allRows = [];
    }
  }

  // Flush final
  if (allRows.length > 0) {
    await flushToSheet(sheets, allRows);
  }

  console.log("\n✅ FINALIZADO");
}

async function flushToSheet(sheets, rows) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "HOJA 1!A1",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows }
  });
}

main().catch(console.error);
