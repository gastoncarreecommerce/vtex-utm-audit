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

async function getPricesForPolicy(policyId) {
  const prices = {};
  let page = 1;
  const pageSize = 100;

  console.log(`Trayendo precios PC${policyId}...`);

  while (true) {
    const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/pricing/pipeline/catalog/${policyId}?pageSize=${pageSize}&page=${page}`;

    try {
      const res = await axios.get(url, { headers });
      const items = res.data;

      if (!Array.isArray(items) || items.length === 0) break;

      for (const item of items) {
        prices[item.itemId] = {
          price:     item.basePrice ?? item.costPrice ?? null,
          listPrice: item.listPrice ?? null
        };
      }

      console.log(`  PC${policyId}: ${Object.keys(prices).length} SKUs (página ${page})...`);
      if (items.length < pageSize) break;
      page++;
      await new Promise(r => setTimeout(r, 200));

    } catch (err) {
      console.error(`Error en PC${policyId} (pág ${page}):`, err.response?.status, err.response?.data ?? err.message);
      break;
    }
  }

  return prices;
}

async function main() {
  const pc1 = await getPricesForPolicy(1);
  const pc5 = await getPricesForPolicy(5);

  console.log(`\nPC1: ${Object.keys(pc1).length} SKUs`);
  console.log(`PC5: ${Object.keys(pc5).length} SKUs`);

  const diffs = [];

  for (const skuId of Object.keys(pc5)) {
    const p5 = pc5[skuId]?.price;
    const p1 = pc1[skuId]?.price;

    if (!p1 || !p5) continue;
    if (p5 !== p1) {
      diffs.push({
        skuId,
        precio_pc1:     p1,
        precio_pc5:     p5,
        diferencia:     (p5 - p1).toFixed(2),
        diferencia_pct: (((p5 - p1) / p1) * 100).toFixed(2) + "%"
      });
    }
  }

  console.log(`\nSKUs con precio PC5 ≠ PC1: ${diffs.length}`);
  diffs.sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia));

  const csvWriter = createObjectCsvWriter({
    path: "price-diff.csv",
    header: [
      { id: "skuId",          title: "SKU ID" },
      { id: "precio_pc1",     title: "Precio PC1" },
      { id: "precio_pc5",     title: "Precio PC5" },
      { id: "diferencia",     title: "Diferencia ($)" },
      { id: "diferencia_pct", title: "Diferencia (%)" }
    ]
  });

  await csvWriter.writeRecords(diffs);
  console.log("Archivo price-diff.csv generado ✓");
}

main().catch(console.error);
