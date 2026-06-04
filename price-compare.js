const axios = require("axios");
const { createObjectCsvWriter } = require("csv-writer");

const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;
const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;

const headers = {
  "X-VTEX-API-AppKey":   VTEX_KEY,
  "X-VTEX-API-AppToken": VTEX_TOKEN,
  "Content-Type":        "application/json"
};

const CONCURRENCY = 20;
const PAGE_SIZE   = 1000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Trae todos los SKU IDs numéricos de VTEX
async function getAllSkuIds() {
  const allIds = [];
  let page = 1;

  console.log("Trayendo lista de SKU IDs...");
  while (true) {
    try {
      const res = await axios.get(
        `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/catalog_system/pvt/sku/stockkeepingunitids?page=${page}&pagesize=${PAGE_SIZE}`,
        { headers }
      );
      const ids = res.data;
      if (!ids || ids.length === 0) break;
      allIds.push(...ids);
      console.log(`  ${allIds.length} SKU IDs traídos (página ${page})...`);
      if (ids.length < PAGE_SIZE) break;
      page++;
      await sleep(200);
    } catch (err) {
      console.error("Error trayendo SKU IDs:", err.response?.status, err.message);
      break;
    }
  }

  return allIds;
}

// Procesa un lote de SKU IDs en paralelo
async function processBatch(skuIds) {
  const results = await Promise.allSettled(
    skuIds.map(async (skuId) => {
      try {
        const res = await axios.get(
          `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/pricing/prices/${skuId}`,
          { headers }
        );
        return { skuId, data: res.data };
      } catch (err) {
        if (err.response?.status === 404) return null; // sin precio, skip
        throw err;
      }
    })
  );

  return results
    .filter(r => r.status === "fulfilled" && r.value !== null)
    .map(r => r.value);
}

async function main() {
  const allSkuIds = await getAllSkuIds();
  console.log(`\nTotal SKU IDs: ${allSkuIds.length}`);

  const diffs = [];
  let processed = 0;

  // Procesar en lotes con concurrencia controlada
  for (let i = 0; i < allSkuIds.length; i += CONCURRENCY) {
    const batch = allSkuIds.slice(i, i + CONCURRENCY);
    const results = await processBatch(batch);

    for (const { skuId, data } of results) {
      const basePrice = data.basePrice;
      const fixedPrices = data.fixedPrices ?? [];

      // Buscar si tiene fixed price para PC5
      const fp5 = fixedPrices.find(fp => String(fp.tradePolicyId) === "5");
      if (!fp5) continue; // No tiene precio específico para PC5, skip

      const pc5Price = fp5.value ?? fp5.price ?? null;
      if (pc5Price === null) continue;

      if (pc5Price !== basePrice) {
        diffs.push({
          skuId:         String(skuId),
          precio_base:   basePrice,
          precio_pc5:    pc5Price,
          diferencia:    (pc5Price - basePrice).toFixed(2),
          diferencia_pct: (((pc5Price - basePrice) / basePrice) * 100).toFixed(2) + "%",
          minQuantity:   fp5.minQuantity ?? "",
          dateFrom:      fp5.dateRange?.from ?? "",
          dateTo:        fp5.dateRange?.to ?? ""
        });
      }
    }

    processed += batch.length;
    if (processed % 500 === 0 || processed >= allSkuIds.length) {
      console.log(`  Procesados ${processed}/${allSkuIds.length} SKUs — diferencias encontradas: ${diffs.length}`);
    }

    await sleep(100);
  }

  console.log(`\nSKUs con precio PC5 ≠ base: ${diffs.length}`);
  diffs.sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia));

  const csvWriter = createObjectCsvWriter({
    path: "price-diff.csv",
    header: [
      { id: "skuId",          title: "SKU ID VTEX" },
      { id: "precio_base",    title: "Precio Base (PC1)" },
      { id: "precio_pc5",     title: "Precio PC5 (MELI)" },
      { id: "diferencia",     title: "Diferencia ($)" },
      { id: "diferencia_pct", title: "Diferencia (%)" },
      { id: "minQuantity",    title: "Min Quantity" },
      { id: "dateFrom",       title: "Vigencia Desde" },
      { id: "dateTo",         title: "Vigencia Hasta" }
    ]
  });

  await csvWriter.writeRecords(diffs);
  console.log("Archivo price-diff.csv generado ✓");
}

main().catch(console.error);
