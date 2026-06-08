const JANIS_BASE   = 'https://pricing.janis.in/api';
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
  console.log('=== DEBUG: estructura cruda de base-price ===\n');
  const res = await fetch(`${JANIS_BASE}/base-price`, {
    headers: { ...janisHeaders, 'x-janis-page': '1', 'x-janis-page-size': '3' },
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
  console.log('\n=== Campos disponibles en cada registro ===');
  if (Array.isArray(data) && data.length > 0) {
    console.log(Object.keys(data[0]).join(', '));
  }
}

run().catch(e => { console.error(e); process.exit(1); });
