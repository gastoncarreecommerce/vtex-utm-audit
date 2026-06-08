const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;
const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;

const vtexHeaders = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'X-VTEX-API-AppKey': VTEX_KEY,
  'X-VTEX-API-AppToken': VTEX_TOKEN,
};

const SKUS_PRUEBA = ['9833', '181128', '200321'];

async function simular(skuId) {
  const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/checkout/pub/orderForms/simulation?sc=5`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: vtexHeaders,
      body: JSON.stringify({ items: [{ id: skuId, quantity: 1, seller: 'carrefourar0002' }] }),
    });
    const data = await res.json();
    if (data.items && data.items[0]) {
      const it = data.items[0];
      return `price=${it.price/100} sellingPrice=${it.sellingPrice/100} listPrice=${it.listPrice/100} availability=${it.availability}`;
    }
    return 'Sin items: ' + JSON.stringify(data).slice(0, 300);
  } catch (e) { return 'ERROR ' + e.message; }
}

async function run() {
  console.log('Simulacion seller carrefourar0002, sc=5:\n');
  for (const sku of SKUS_PRUEBA) {
    console.log(`SKU ${sku}: ${await simular(sku)}`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
