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
  // Test 1: endpoint pipeline catalog
  console.log("=== TEST 1: pipeline/catalog ===");
  try {
    const res = await axios.get(
      `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/pricing/pipeline/catalog/1?pageSize=5&page=1`,
      { headers }
    );
    console.log("Status:", res.status);
    console.log("Headers:", JSON.stringify(res.headers, null, 2));
    console.log("Data:", JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error("Error:", err.response?.status, JSON.stringify(err.response?.data));
  }

  // Test 2: endpoint alternativo prices por SKU conocido
  console.log("\n=== TEST 2: precio SKU individual ===");
  try {
    // Usamos un SKU ID del export de Janis para probar
    const testSku = "68d6f323962fc72e0502a2df";
    const res = await axios.get(
      `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/pricing/prices/${testSku}`,
      { headers }
    );
    console.log("Status:", res.status);
    console.log("Data:", JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error("Error:", err.response?.status, JSON.stringify(err.response?.data));
  }

  // Test 3: endpoint con myvtex
  console.log("\n=== TEST 3: myvtex domain ===");
  try {
    const res = await axios.get(
      `https://${VTEX_ACCOUNT}.myvtex.com/api/pricing/pipeline/catalog/1?pageSize=5&page=1`,
      { headers }
    );
    console.log("Status:", res.status);
    console.log("Data:", JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error("Error:", err.response?.status, JSON.stringify(err.response?.data));
  }
}

main().catch(console.error);
