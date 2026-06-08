const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT; // master: carrefourar
const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;

const vtexHeaders = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'X-VTEX-API-AppKey': VTEX_KEY,
  'X-VTEX-API-AppToken': VTEX_TOKEN,
};

const EAN_PRUEBA = '7791290786639'; // el que dio precio antes

async function refToSku(cuenta, ean) {
  const url = `https://${cuenta}.vtexcommercestable.com.br/api/catalog_system/pvt/sku/stockkeepingunitidsbyrefids`;
  const res = await fetch(url, { method: 'POST', headers: vtexHeaders, body: JSON.stringify([ean]) });
  if (!res.ok) return `HTTP ${res.status}`;
  return JSON.stringify(await res.json());
}

async function price(cuenta, skuId) {
  const res = await fetch(`https://api.vtex.com/${cuenta}/pricing/prices/${skuId}`, { headers: vtexHeaders });
  if (!res.ok) return `HTTP ${res.status}`;
  const d = await res.json();
  return `basePrice=${d.basePrice} fixedPrices=${JSON.stringify(d.fixedPrices)}`;
}

async function run() {
  console.log('EAN de prueba:', EAN_PRUEBA, '\n');

  console.log('--- Traduccion EAN -> skuId ---');
  const skuMaster = await refToSku(VTEX_ACCOUNT, EAN_PRUEBA);
  console.log('  en master', VTEX_ACCOUNT + ':', skuMaster);
  const sku0002 = await refToSku('carrefourar0002', EAN_PRUEBA);
  console.log('  en 0002:', sku0002);

  console.log('\n--- Precio del mismo skuId en cada cuenta ---');
  // probamos el skuId que devolvio master, en ambas cuentas
  const obj = JSON.parse(skuMaster);
  const skuId = obj[EAN_PRUEBA];
  if (skuId) {
    console.log('  skuId', skuId, 'en master:', await price(VTEX_ACCOUNT, skuId));
    console.log('  skuId', skuId, 'en 0002:  ', await price('carrefourar0002', skuId));
  }
}

run().catch(e => { console.error(e); process.exit(1); });
