const JANIS_KEY    = process.env.JANIS_API_KEY;
const JANIS_SECRET = process.env.JANIS_API_SECRET;
const JANIS_CLIENT = process.env.JANIS_CLIENT;

const janisHeaders = {
  'Content-Type': 'application/json',
  'janis-api-key': JANIS_KEY,
  'janis-api-secret': JANIS_SECRET,
  'janis-client': JANIS_CLIENT,
};

async function probe(label, url) {
  try {
    const res = await fetch(url, {
      headers: { ...janisHeaders, 'x-janis-page': '1', 'x-janis-page-size': '3' },
    });
    console.log(`\n=== ${label} -> HTTP ${res.status} ===`);
    if (res.ok) {
      const data = await res.json();
      console.log(JSON.stringify(data, null, 2).slice(0, 2000));
      if (Array.isArray(data) && data.length) {
        console.log('\nCAMPOS:', Object.keys(data[0]).join(', '));
      }
    } else {
      console.log((await res.text()).slice(0, 200));
    }
  } catch (e) {
    console.log(`${label} ERROR: ${e.message}`);
  }
}

async function run() {
  // Probamos el Catalog Service en sus posibles URLs
  await probe('catalog /sku', 'https://catalog.janis.in/api/sku');
  await probe('catalog /product', 'https://catalog.janis.in/api/product');
}

run().catch(e => { console.error(e); process.exit(1); });
