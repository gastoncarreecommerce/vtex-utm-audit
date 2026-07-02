const JANIS_KEY    = process.env.JANIS_API_KEY;
const JANIS_SECRET = process.env.JANIS_API_SECRET;
const JANIS_CLIENT = process.env.JANIS_CLIENT;

const H = {
  'Content-Type': 'application/json',
  'janis-api-key': JANIS_KEY,
  'janis-api-secret': JANIS_SECRET,
  'janis-client': JANIS_CLIENT,
};

async function get(url) {
  const res = await fetch(url, { headers: { ...H, 'x-janis-page': '1', 'x-janis-page-size': '2' } });
  return { status: res.status, data: res.ok ? await res.json() : await res.text() };
}

async function run() {
  // 1. Un product completo (ver estructura)
  console.log('=== catalog/product (2 registros) ===');
  const prod = await get('https://catalog.janis.in/api/product');
  console.log(JSON.stringify(prod.data, null, 2).slice(0, 2500));

  // 2. Un precio del price-sheet MELI (para ver el sku hex que hay que traducir)
  console.log('\n=== un price del sheet MELI (ver campo sku) ===');
  const price = await get('https://pricing.janis.in/api/price?filters[priceSheet]=68cd5054eaa341977f783fef');
  if (Array.isArray(price.data) && price.data[0]) {
    console.log('sku hex a traducir:', price.data[0].sku);
    console.log('registro completo:', JSON.stringify(price.data[0], null, 2));
  }
}

run().catch(e => { console.error(e); process.exit(1); });
