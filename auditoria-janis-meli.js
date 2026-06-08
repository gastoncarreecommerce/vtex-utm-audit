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

async function run() {
  // 1. Buscar el price-sheet de carrefourar0002-5
  console.log('=== Buscando price-sheet carrefourar0002-5 ===');
  let target = null;
  let page = 1;
  while (true) {
    const res = await fetch(`${PRICING_BASE}/price-sheet`, {
      headers: { ...janisHeaders, 'x-janis-page': String(page), 'x-janis-page-size': '100' },
    });
    const sheets = await res.json();
    if (!Array.isArray(sheets) || sheets.length === 0) break;
    for (const s of sheets) {
      if (s.referenceId && s.referenceId.includes('0002-5')) {
        target = s;
      }
    }
    if (target || sheets.length < 100) break;
    page++;
  }

  if (!target) { console.log('NO encontrado. Revisar referenceId.'); return; }
  console.log('ENCONTRADO:');
  console.log(JSON.stringify(target, null, 2));

  // 2. Traer precios de ESE price-sheet
  console.log(`\n=== Precios del price-sheet ${target.id} (primeros 5) ===`);
  const res2 = await fetch(`${PRICING_BASE}/price?filters[priceSheet]=${target.id}`, {
    headers: { ...janisHeaders, 'x-janis-page': '1', 'x-janis-page-size': '5' },
  });
  console.log('HTTP', res2.status);
  if (res2.ok) {
    const precios = await res2.json();
    console.log(JSON.stringify(precios, null, 2));
    if (Array.isArray(precios) && precios.length) {
      console.log('\nCAMPOS:', Object.keys(precios[0]).join(', '));
    }
  } else {
    console.log((await res2.text()).slice(0, 200));
  }
}

run().catch(e => { console.error(e); process.exit(1); });
