const PRICING_BASE = 'https://pricing.janis.in/api';
const JANIS_KEY    = process.env.JANIS_API_KEY;
const JANIS_SECRET = process.env.JANIS_API_SECRET;
const JANIS_CLIENT = process.env.JANIS_CLIENT;

const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;
const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;

const janisHeaders = {
  'Content-Type': 'application/json',
  'janis-api-key': JANIS_KEY,
  'janis-api-secret': JANIS_SECRET,
  'janis-client': JANIS_CLIENT,
};
const vtexHeaders = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'X-VTEX-API-AppKey': VTEX_KEY,
  'X-VTEX-API-AppToken': VTEX_TOKEN,
};

// EANs de ejemplo de tus pegados
const EANS_PRUEBA = ['7798049540078', '7790895001024', '7791290786639'];

async function listarPriceSheets() {
  console.log('=== 1) PRICE-SHEETS DE JANIS ===');
  const res = await fetch(`${PRICING_BASE}/price-sheet`, {
    headers: { ...janisHeaders, 'x-janis-page': '1', 'x-janis-page-size': '60' },
  });
  if (!res.ok) { console.log('  HTTP', res.status); return; }
  const sheets = await res.json();
  console.log(`  Total price-sheets: ${sheets.length}`);
  sheets.forEach(s =>
    console.log(`  - "${s.name}" | refId: ${s.referenceId} | salesChannels: ${JSON.stringify(s.salesChannels)}`)
  );
  console.log('');
}

async function eanToSkuId(ean) {
  // VTEX: buscar SKU por referenceId
  const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/catalog_system/pvt/sku/stockkeepingunitidsbyrefids`;
  const res = await fetch(url, {
    method: 'POST',
    headers: vtexHeaders,
    body: JSON.stringify([ean]),
  });
  if (!res.ok) return { ean, error: `HTTP ${res.status}` };
  const data = await res.json();
  return { ean, skuId: data[ean] || null, raw: data };
}

async function vtexPrice(skuId) {
  const url = `https://api.vtex.com/${VTEX_ACCOUNT}/pricing/prices/${skuId}`;
  const res = await fetch(url, { headers: vtexHeaders });
  if (!res.ok) return { skuId, error: `HTTP ${res.status}` };
  const data = await res.json();
  return { skuId, basePrice: data.basePrice, fixedPrices: data.fixedPrices };
}

async function run() {
  await listarPriceSheets();

  console.log('=== 2) PRUEBA EAN -> SKU ID VTEX -> PRECIO ===');
  for (const ean of EANS_PRUEBA) {
    const t = await eanToSkuId(ean);
    console.log(`\nEAN ${ean}:`);
    console.log('  traduccion:', JSON.stringify(t));
    if (t.skuId) {
      const p = await vtexPrice(t.skuId);
      console.log('  precio VTEX:', JSON.stringify(p));
    }
  }
}

run().catch(e => { console.error(e); process.exit(1); });
