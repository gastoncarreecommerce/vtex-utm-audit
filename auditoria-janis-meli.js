const PRICING_BASE = 'https://pricing.janis.in/api';
const JANIS_KEY    = process.env.JANIS_API_KEY;
const JANIS_SECRET = process.env.JANIS_API_SECRET;
const JANIS_CLIENT = process.env.JANIS_CLIENT;

const janisHeaders = {
  'Content-Type': 'application/json',
  'janis-api-key': JANIS_KEY,
  'janis-api-secret': JANIS_SECRET,
  'janis-client': JANIS_CLIENT,
};

// El sales channel de MELI 0002 (de tu price-sheet 0002-5)
const SC_MELI_0002 = '68cd4d36f7120cfb22dda331';

async function run() {
  // 1. Encontrar el price-sheet de MELI 0002 y su id
  console.log('=== Buscando price-sheet de MELI 0002 ===');
  let page = 1, target = null;
  while (page <= 5) {
    const res = await fetch(`${PRICING_BASE}/price-sheet`, {
      headers: { ...janisHeaders, 'x-janis-page': String(page), 'x-janis-page-size': '60' },
    });
    const sheets = await res.json();
    if (!sheets.length) break;
    for (const s of sheets) {
      if ((s.salesChannels || []).includes(SC_MELI_0002)) {
        target = s;
      }
    }
    if (target) break;
    page++;
  }
  if (!target) { console.log('No encontrado'); return; }
  console.log('Price-sheet MELI 0002:');
  console.log('  id:', target.id);
  console.log('  name:', target.name);
  console.log('  refId:', target.referenceId);
  console.log('  salesChannels:', JSON.stringify(target.salesChannels));

  // 2. Traer precios de ese price-sheet (muestra)
  console.log('\n=== Muestra de precios del price-sheet MELI 0002 ===');
  const res2 = await fetch(`${PRICING_BASE}/price?filters[priceSheet]=${target.id}`, {
    headers: { ...janisHeaders, 'x-janis-page': '1', 'x-janis-page-size': '5' },
  });
  console.log('HTTP', res2.status);
  const prices = await res2.json();
  console.log(JSON.stringify(prices, null, 2).slice(0, 1500));
  console.log('\nCampos:', prices.length ? Object.keys(prices[0]).join(', ') : 'vacio');
}

run().catch(e => { console.error(e); process.exit(1); });
