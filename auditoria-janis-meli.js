const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT; // master
const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;

const H = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'X-VTEX-API-AppKey': VTEX_KEY,
  'X-VTEX-API-AppToken': VTEX_TOKEN,
};

const SKUS = ['9833', '181128', '200321'];

async function show(label, url, opts = {}) {
  try {
    const res = await fetch(url, { headers: H, ...opts });
    const txt = await res.text();
    console.log(`  [${res.status}] ${label}`);
    if (res.ok) console.log('       ' + txt.slice(0, 400));
    else console.log('       ' + txt.slice(0, 150));
  } catch (e) {
    console.log(`  [ERR] ${label}: ${e.message}`);
  }
}

async function run() {
  for (const sku of SKUS) {
    console.log(`\n===== SKU ${sku} =====`);

    // 1. Pricing master - ver TODO el objeto (no solo basePrice)
    await show('Pricing master completo',
      `https://api.vtex.com/${VTEX_ACCOUNT}/pricing/prices/${sku}`);

    // 2. Pricing con computeInfo (precios por cuenta)
    await show('Pricing master + computeInfo',
      `https://api.vtex.com/${VTEX_ACCOUNT}/pricing/prices/${sku}?computeInfo=true`);

    // 3. Price endpoint alternativo (pricing/v3 o por account)
    await show('Pricing fixedPrices por cuenta',
      `https://api.vtex.com/${VTEX_ACCOUNT}/pricing/prices/${sku}/fixed`);

    // 4. Catalog pricing (precio simple por SKU desde catalog)
    await show('Catalog system price',
      `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/catalog_system/pvt/products/GetPriceById/${sku}`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
