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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const results = [];
  const PAGE_SIZE = 50;
  let from = 0;
  let total = null;

  console.log("Trayendo productos PC5 de VTEX...");

  while (true) {
    try {
      const res = await axios.get(
        `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/catalog_system/pub/products/search?sc=5&_from=${from}&_to=${from + PAGE_SIZE - 1}`,
        { headers, timeout: 15000 }
      );

      if (total === null) {
        const resourceHeader = res.headers["resources"] ?? "";
        total = parseInt(resourceHeader.split("/")?.[1] ?? "0");
        console.log(`Total estimado: ${total} productos`);
      }

      const products = res.data;
      if (!products || products.length === 0) break;

      for (const product of products) {
        for (const item of (product.items ?? [])) {
          const seller = item.sellers?.find(s => s.sellerId === "1");
          const price     = seller?.commertialOffer?.Price ?? null;
          const listPrice = seller?.commertialOffer?.ListPrice ?? null;

          results.push({
            productId:  product.productId,
            skuId:      item.itemId,
            ean:        item.ean ?? "",
            nombre:     product.productName,
            skuNombre:  item.nameComplete,
            precio:     price,
            listPrice:  listPrice
          });
        }
      }

      console.log(`  ${results.length} SKUs acumulados (from=${from})...`);
      from += PAGE_SIZE;
      if (total && from >= total) break;
      await sleep(300);

    } catch (err) {
      console.error(`Error (from=${from}):`, err.response?.status, err.message);
      break;
    }
  }

  console.log(`\nTotal SKUs PC5: ${results.length}`);

  const csvWriter = createObjectCsvWriter({
    path: "vtex-pc5.csv",
    header: [
      { id: "productId",  title: "Product ID" },
      { id: "skuId",      title: "SKU ID" },
      { id: "ean",        title: "EAN" },
      { id: "nombre",     title: "Producto" },
      { id: "skuNombre",  title: "SKU" },
      { id: "precio",     title: "Precio PC5" },
      { id: "listPrice",  title: "List Price PC5" }
    ]
  });

  await csvWriter.writeRecords(results);
  console.log("vtex-pc5.csv generado ✓");
}

main().catch(console.error);
