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

// Trae todos los SKUs con precio para una política comercial
async function getPricesForPolicy(policyId) {
  const prices = {};
  let hasMore = true;
  let token = null;

  console.log(`Trayendo precios PC${policyId}...`);

  while (hasMore) {
    const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/pricing/pipeline/catalog/${policyId}?pageSize=1000${token ? `&token=${token}` : ""}`;

    try {
      const res = await axios.get(url, { headers });
      const data = res.data;

      if (Array.isArray(data.items)) {
        for (const item of data.items) {
          prices[item.itemId] = {
            price: item.basePrice ?? item.costPrice ?? null,
            listPrice: item.listPrice ?? null
          };
        }
        console.log(`  PC${policyId}: ${Object.keys(prices).length} SKUs acumulados...`);
      }

      token = data.nextToken ?? null;
      hasMore = !!token;

    } catch (err) {
      console.error(`Error en PC${policyId}:`, err.response?.status, err.response?.data ?? err.message);
      hasMore = false;
    }
  }

  return prices;
}

async function main() {
  const [pc1, pc5] = await Promise.all([
    getPricesForPolicy(1),
    getPricesForPolicy(5)
  ]);

  console.log(`\nPC1: ${Object.keys(pc1).length} SKUs`);
  console.log(`PC5: ${Object.keys(pc5).length} SKUs`);

  const diffs = [];

  for (const skuId of Object.keys(pc5)) {
    const p5 = pc5[skuId]?.price;
    const p1 = pc1[skuId]?.price;

    if (p1 === null || p1 === undefined) continue; // SKU sin precio en PC1, skip
    if (p5 === null || p5 === undefined) continue;

    if (p5 !== p1) {
      diffs.push({
        skuId,
        precio_pc1: p1,
        precio_pc5: p5,
        diferencia: p5 - p1,
        diferencia_pct: (((p5 - p1) / p1) * 100).toFixed(2) + "%"
      });
    }
  }

  console.log(`\nSKUs con precio PC5 ≠ PC1: ${diffs.length}`);

  // Ordenar por diferencia absoluta descendente
  diffs.sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia));

  const csvWriter = createObjectCsvWriter({
    path: "price-diff.csv",
    header: [
      { id: "skuId",         title: "SKU ID" },
      { id: "precio_pc1",    title: "Precio PC1" },
      { id: "precio_pc5",    title: "Precio PC5" },
      { id: "diferencia",    title: "Diferencia ($)" },
      { id: "diferencia_pct", title: "Diferencia (%)" }
    ]
  });

  await csvWriter.writeRecords(diffs);
  console.log("Archivo price-diff.csv generado ✓");
}

main().catch(console.error);
