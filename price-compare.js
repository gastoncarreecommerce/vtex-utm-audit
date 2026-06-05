const axios = require("axios");
const { createObjectCsvWriter } = require("csv-writer");
const XLSX = require("xlsx");
const path = require("path");

const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;
const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;

const headers = {
  "X-VTEX-API-AppKey":   VTEX_KEY,
  "X-VTEX-API-AppToken": VTEX_TOKEN,
  "Content-Type":        "application/json"
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getSkuPrice(skuId) {
  try {
    const res = await axios.get(
      `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/pricing/prices/${skuId}`,
      { headers, timeout: 10000 }
    );
    return res.data?.basePrice ?? null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

async function main() {
  // Leer archivos
  const prodWb = XLSX.readFile("Productos.xlsx");
  const prodSheet = prodWb.Sheets[prodWb.SheetNames[0]];
  const productos = XLSX.utils.sheet_to_json(prodSheet);

  const priceWb = XLSX.readFile("price-1.xlsx");
  const priceSheet = priceWb.Sheets[priceWb.SheetNames[0]];
  const janisPrecios = XLSX.utils.sheet_to_json(priceSheet);

  console.log(`Productos: ${productos.length}`);
  console.log(`Precios Janis PC5: ${janisPrecios.length}`);

  // Indexar Janis por meliItemId para lookup rápido
  // También por nombre (normalizado) como fallback
  const janisByMeli = {};
  const janisByNombre = {};
  for (const row of janisPrecios) {
    if (row.meliItemId) janisByMeli[row.meliItemId] = row;
  }

  // Filtrar solo productos que tienen referenceId numérico válido
  const skuIds = productos
    .filter(p => p.referenceId && !isNaN(p.referenceId))
    .map(p => ({ skuId: Number(p.referenceId), name: p.name }));

  console.log(`SKUs a procesar: ${skuIds.length}`);

  const diffs = [];
  const CONCURRENCY = 20;
  let processed = 0;

  for (let i = 0; i < skuIds.length; i += CONCURRENCY) {
    const batch = skuIds.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async ({ skuId, name }) => {
      try {
        const vtexPrice = await getSkuPrice(skuId);
        if (vtexPrice === null) return;

        // Buscar en Janis — por ahora guardamos VTEX price para comparar manualmente
        // También buscamos si el SKU aparece en Janis de alguna forma
        diffs.push({
          skuId:       String(skuId),
          nombre:      name,
          precio_vtex: vtexPrice
        });
      } catch (err) {
        console.error(`Error SKU ${skuId}:`, err.message);
      }
    }));

    processed += batch.length;
    if (processed % 500 === 0 || processed >= skuIds.length) {
      console.log(`  Procesados ${processed}/${skuIds.length}...`);
    }
    await sleep(100);
  }

  console.log(`\nSKUs con precio en VTEX: ${diffs.length}`);

  const csvWriter = createObjectCsvWriter({
    path: "vtex-prices.csv",
    header: [
      { id: "skuId",       title: "SKU ID VTEX" },
      { id: "nombre",      title: "Nombre" },
      { id: "precio_vtex", title: "Precio VTEX actual" }
    ]
  });

  await csvWriter.writeRecords(diffs);
  console.log("Archivo vtex-prices.csv generado ✓");
}

main().catch(console.error);
