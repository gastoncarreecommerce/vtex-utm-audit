const JANIS_KEY    = process.env.JANIS_API_KEY;
const JANIS_SECRET = process.env.JANIS_API_SECRET;
const JANIS_CLIENT = process.env.JANIS_CLIENT;

const H = {
  'Content-Type': 'application/json',
  'janis-api-key': JANIS_KEY,
  'janis-api-secret': JANIS_SECRET,
  'janis-client': JANIS_CLIENT,
};

async function probe(label, url) {
  try {
    const res = await fetch(url, { headers: { ...H, 'x-janis-page': '1', 'x-janis-page-size': '3' } });
    console.log(label.padEnd(24) + ' -> HTTP ' + res.status);
    if (!res.ok) console.log('     ' + (await res.text()).slice(0, 120));
  } catch (e) {
    console.log(label + ' ERROR ' + e.message);
  }
}

async function run() {
  console.log('Client:', JANIS_CLIENT, '\n');
  await probe('catalog/sku',   'https://catalog.janis.in/api/sku');
  await probe('catalog/product','https://catalog.janis.in/api/product');
  await probe('pricing/base-price', 'https://pricing.janis.in/api/base-price');
  await probe('pricing/price-sheet','https://pricing.janis.in/api/price-sheet');
  await probe('pricing/price',  'https://pricing.janis.in/api/price?filters[priceSheet]=68cd5054eaa341977f783fef');
}

run().catch(e => { console.error(e); process.exit(1); });
