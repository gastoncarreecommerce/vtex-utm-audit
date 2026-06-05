const axios = require("axios");
const { createObjectCsvWriter } = require("csv-writer");
const XLSX = require("xlsx");
const fs = require("fs");

const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;
const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;

const headers = {
  "X-VTEX-API-AppKey":   VTEX_KEY,
  "X-VTEX-API-AppToken": VTEX_TOKEN,
  "Content-Type":        "application/json"
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseCsv(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = line.split(",");
    const obj = {};
    headers.forEach((h, i) => obj[h.trim()] = (vals[i] ?? "").trim());
    return obj;
  });
}

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
  // Leer Productos.xlsx
  const prodWb = XLSX.readFile("Productos.xlsx");
  const prodSheet = prodWb.Sheets[prodWb.SheetNames[0]];
  const productos = XLSX.utils.sheet_to_json(prodSheet);
  console.log(`Productos: ${productos.length}`);

  // Leer janis-prices-small.csv
  const janisRows = parseCsv("janis-prices-small.csv");
  console.log(`Precios Janis PC5: ${janisRows.length}`);

  // Indexar Janis por meliItemId
  const janisByMeli = {};
  for (const row of janisRows) {
    if (row.meliItemId) janisByMeli[row.meliItemId] = row;
  }

  // Filtrar SKUs válidos
  const skus = productos
    .filter(p => p.referenceId && !isNaN(p.referenceId))
    .map(p => ({ skuId: Number(p.referenceId), name: p.name }));

  console.log(`SKUs a procesar: ${skus.length}`);

  // Para cada SKU: obtener precio VTEX
  // Guardar mapa skuId -> precio VTEX
  const vtexPrices = {};
  const CONCURRENCY = 20;
  let processed = 0;

  for (let i = 0; i < skus.length; i += CONCURRENCY) {
    const batch = skus.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async ({ skuId, name }) => {
      try {
        const price = await getSkuPrice(skuId);
        if (price !== null) {
          vtexPrices[skuId] = { price, name };
        }
      } catch (err) {
        console.error(`Error SKU ${skuId}:`, err.message);
      }
    }));

    processed += batch.length;
    if (processed % 500 === 0 || processed >= skus.length) {
      console.log(`  Procesados ${processed}/${skus.length} — con precio: ${Object.keys(vtexPrices).length}`);
    }
    await sleep(100);
  }

  console.log(`\nSKUs con precio en VTEX: ${Object.keys(vtexPrices).length}`);

  // Ahora comparar con Janis
  // Janis no tiene skuId numérico, pero sí meliItemId
  // Generamos dos outputs:
  // 1. vtex-prices.csv: todos los SKUs con precio VTEX (para cruzar manual)
  // 2. Si encontramos matches, price-diff.csv con diferencias

  const vtexCsvWriter = createObjectCsvWriter({
    path: "vtex-prices.csv",
    header: [
      { id: "skuId",       title: "SKU ID VTEX" },
      { id: "nombre",      title: "Nombre" },
      { id: "precio_vtex", title: "Precio VTEX actual" }
    ]
  });

  const vtexRows = Object.entries(vtexPrices).map(([skuId, { price, name }]) => ({
    skuId, nombre: name, precio_vtex: price
  }));

  await vtexCsvWriter.writeRecords(vtexRows);
  console.log(`vtex-prices.csv generado con ${vtexRows.length} SKUs ✓`);

  // También exportar Janis para cruzar
  const janisCsvWriter = createObjectCsvWriter({
    path: "janis-export.csv",
    header: [
      { id: "meliItemId",   title: "MELI Item ID" },
      { id: "price",        title: "Precio Janis (PC5)" },
      { id: "lastPricingUpdateDate", title: "Última actualización" }
    ]
  });

  const janisOut = janisRows.map(r => ({
    meliItemId: r.meliItemId,
    price: r.price,
    lastPricingUpdateDate: r.lastPricingUpdateDate
  }));

  await janisCsvWriter.writeRecords(janisOut);
  console.log(`janis-export.csv generado ✓`);
}

main().catch(console.error);
