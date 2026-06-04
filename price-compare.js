const axios = require("axios");

const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;
const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;

const headers = {
  "X-VTEX-API-AppKey":   VTEX_KEY,
  "X-VTEX-API-AppToken": VTEX_TOKEN,
  "Content-Type":        "application/json"
};

async function main() {
  // Test 1: buscar SKUs con precio en PC1 (saltear los vacíos)
  console.log("=== TEST: buscar SKU con precio cargado ===");
  let skuConPrecio = null;

  for (let skuId = 1; skuId <= 200; skuId++) {
    try {
      const res = await axios.get(
        `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/pricing/prices/${skuId}`,
        { headers }
      );
      if (res.data) {
        console.log(`SKU ${skuId} tiene precio:`, JSON.stringify(res.data, null, 2));
        skuConPrecio = skuId;
        break;
      }
    } catch (err) {
      if (err.response?.status !== 404) {
        console.error(`SKU ${skuId} error:`, err.response?.status);
      }
      // 404 = sin precio, seguimos
    }
  }

  if (!skuConPrecio) {
    console.log("No se encontró ningún SKU con precio entre 1-200");
    return;
  }

  // Test 2: ver detalle del SKU encontrado
  console.log(`\n=== TEST: detalle SKU ${skuConPrecio} ===`);
  try {
    const res = await axios.get(
      `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/catalog_system/pvt/sku/stockkeepingunitbyid/${skuConPrecio}`,
      { headers }
    );
    console.log("RefId:", res.data.RefId);
    console.log("AlternateIds:", JSON.stringify(res.data.AlternateIds));
    console.log("ProductId:", res.data.ProductId);
    console.log("Name:", res.data.Name);
  } catch (err) {
    console.error("Error detalle SKU:", err.response?.status);
  }

  // Test 3: fixed price PC5 del mismo SKU
  console.log(`\n=== TEST: fixed price PC5 del SKU ${skuConPrecio} ===`);
  try {
    const res = await axios.get(
      `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/pricing/prices/${skuConPrecio}/fixed/5`,
      { headers }
    );
    console.log("Fixed price PC5:", JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error("Error PC5:", err.response?.status, JSON.stringify(err.response?.data));
  }
}

main().catch(console.error);
