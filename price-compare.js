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

const PAGE_SIZE = 50;

async function getProductsForPolicy(sc) {
  const prices = {};
  let from = 0;
  let total = null;

  console.log(`Trayendo productos PC${sc}...`);

  while (true) {
    const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/catalog_system/pub/products/search?sc=${sc}&_from=${from}&_to=${from + PAGE_SIZE - 1}`;

    try {
      const res = await axios.get(url, { headers });

      // El total viene en el header
      if (total === null) {
        total = parseInt(res.headers["resources"]?.split("/")?.[1] ?? "0");
        console.log(`  PC${sc}: total estimado ${total} productos`);
      }

      const products = res.data;
      if (!products || products.length === 0) break;

      for (const product of products) {
        for (const item of (product.items ?? [])) {
          const skuId = item.itemId;
          const seller = item.sellers?.find(s => s.sellerId === "1");
          const price = seller?.commertialOffer?.Price ?? null;
          const listPrice = seller?.commertialOffer?.ListPrice ?? null;
          if (skuId && price !== null) {
            prices[skuId] = { price, listPrice, productName: product.productName, skuName: item.nameComplete };
          }
        }
      }

      console.log(`  PC${sc}: ${Object.keys(prices).length} SKUs acumulados (from=${from})...`);
      from += PAGE_SIZE;
      if (from >= total) break;

      // Pausa para no saturar la API
      await new Promise(r => setTimeout(r, 300));

    } catch (err) {
      console.error(`Error en PC${sc} (from=${from}):`, err.response?.status, err.response?.data ?? err.message);
      break;
    }
  }

  return prices;
}

async function main() {
  // Traer en serie para no saturar
  const pc1 = await getProductsForPolicy(1);
  const pc5 = await getProductsForPolicy(5);

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
        productName: pc5[skuId].productName ?? "",
        skuName:     pc5[skuId].skuName ?? "",
        precio_pc1:  p1,
        precio_pc5:  p5,
        diferencia:  (p5 - p1).toFixed(2),
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
      { id: "productName",    title: "Producto" },
      { id: "skuName",        title: "SKU" },
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
