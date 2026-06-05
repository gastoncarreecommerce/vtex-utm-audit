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
  // Buscar SKUs del producto 6286
  console.log("=== SKUs del producto 6286 ===");
  try {
    const res = await axios.get(
      `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/catalog_system/pvt/products/productget/6286`,
      { headers }
    );
    console.log(JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error("Error:", err.response?.status, JSON.stringify(err.response?.data));
  }

  // Alternativa: buscar SKUs por productId
  console.log("\n=== SKUs por productId ===");
  try {
    const res = await axios.get(
      `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/catalog_system/pvt/sku/stockkeepingunitByProductId/6286`,
      { headers }
    );
    console.log(JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error("Error:", err.response?.status, JSON.stringify(err.response?.data));
  }
}

main().catch(console.error);
