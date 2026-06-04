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
  // Test: traer SKUs de VTEX y ver qué campos trae
  console.log("=== TEST: SKU list de VTEX ===");
  try {
    const res = await axios.get(
      `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/catalog_system/pvt/sku/stockkeepingunitids?page=1&pagesize=5`,
      { headers }
    );
    console.log("Status:", res.status);
    console.log("SKU IDs (primeros 5):", JSON.stringify(res.data));
  } catch (err) {
    console.error("Error SKU list:", err.response?.status, JSON.stringify(err.response?.data));
  }

  // Test: fixed price de un SKU numérico real
  console.log("\n=== TEST: fixed prices de SKU numérico ===");
  try {
    // Primero traemos un SKU ID real
    const listRes = await axios.get(
      `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/catalog_system/pvt/sku/stockkeepingunitids?page=1&pagesize=1`,
      { headers }
    );
    const skuId = listRes.data[0];
    console.log("SKU ID numérico de prueba:", skuId);

    // Ahora traemos sus fixed prices
    const priceRes = await axios.get(
      `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/pricing/prices/${skuId}`,
      { headers }
    );
    console.log("Precio response:", JSON.stringify(priceRes.data, null, 2));
  } catch (err) {
    console.error("Error fixed price:", err.response?.status, JSON.stringify(err.response?.data));
  }

  // Test: fixed prices filtrado por trade policy
  console.log("\n=== TEST: fixed prices por trade policy ===");
  try {
    const listRes = await axios.get(
      `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/catalog_system/pvt/sku/stockkeepingunitids?page=1&pagesize=1`,
      { headers }
    );
    const skuId = listRes.data[0];

    const priceRes = await axios.get(
      `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/pricing/prices/${skuId}/fixed/5`,
      { headers }
    );
    console.log("Fixed price PC5:", JSON.stringify(priceRes.data, null, 2));
  } catch (err) {
    console.error("Error fixed price PC5:", err.response?.status, JSON.stringify(err.response?.data));
  }
}

main().catch(console.error);
