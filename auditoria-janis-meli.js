const fs = require('fs');

const JANIS_BASE   = 'https://pricing.janis.in/api';
const JANIS_KEY    = process.env.JANIS_API_KEY;
const JANIS_SECRET = process.env.JANIS_API_SECRET;
const JANIS_CLIENT = process.env.JANIS_CLIENT;
const MELI_SALES_CHANNEL_ID = process.env.MELI_SC_ID;
const TOLERANCIA = 0.01;

const janisHeaders = {
  'Content-Type': 'application/json',
  'janis-api-key': JANIS_KEY,
  'janis-api-secret': JANIS_SECRET,
  'janis-client': JANIS_CLIENT,
};

async function fetchAllJanisPrices(salesChannelId) {
  const all = [];
  let page = 1;
  const pageSize = 100;
  while (true) {
    const url = `${JANIS_BASE}/sc-sku-price?filters[salesChannelId]=${encodeURIComponent(salesChannelId)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...janisHeaders, 'x-janis-page': String(page), 'x-janis-page-size': String(pageSize) },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Janis HTTP ${res.status} (page ${page}): ${body.slice(0, 300)}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    console.log(`  Janis page ${page}: +${batch.length} (total ${all.length})`);
    if (batch.length < pageSize) break;
    page++;
    if (page > 5000) break;
  }
  return all;
}

function loadVtexMap() {
  if (!fs.existsSync('vtex-prices.json')) {
    console.warn('!! No existe vtex-prices.json. El cruce con VTEX se omite.');
    return new Map();
  }
  const vtex = JSON.parse(fs.readFileSync('vtex-prices.json', 'utf-8'));
  return new Map(vtex.filter(r => !r.error).map(r => [String(r.sku), Number(r.pc5Price)]));
}

async function runAudit() {
  // Modo descubrimiento: muestra una listita para encontrar el canal de MELI
  if (process.env.LIST_CHANNELS === '1') {
    console.log('--- Modo descubrimiento: muestra de sc-sku-price ---');
    const res = await fetch(`${JANIS_BASE}/sc-sku-price`, {
      headers: { ...janisHeaders, 'x-janis-page': '1', 'x-janis-page-size': '20' },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Janis HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const sample = await res.json();
    console.log(JSON.stringify(sample, null, 2));
    return;
  }

  if (!MELI_SALES_CHANNEL_ID) {
    throw new Error('Falta MELI_SC_ID. Corré primero con LIST_CHANNELS=1 para descubrirlo.');
  }

  console.log(`--- Auditoría Janis->MELI (salesChannel ${MELI_SALES_CHANNEL_ID}) ---\n`);
  const janisPrices = await fetchAllJanisPrices(MELI_SALES_CHANNEL_ID);
  console.log(`\nTotal precios en Janis (MELI): ${janisPrices.length}`);

  const vtexMap = loadVtexMap();
  console.log(`Precios de referencia VTEX: ${vtexMap.size}\n`);

  const afectados = [];
  let sinReferencia = 0;
  for (const row of janisPrices) {
    const sku = String(row.skuId);
    const precioJanis = Number(row.price);
    const precioVtex = vtexMap.get(sku);
    if (precioVtex == null) { sinReferencia++; continue; }
    const diff = Math.round((precioJanis - precioVtex) * 100) / 100;
    if (Math.abs(diff) > TOLERANCIA) {
      afectados.push({
        sku, precioJanisMeli: precioJanis, precioVtexCorrecto: precioVtex,
        diferencia: diff, dateModifiedJanis: row.dateModified || null,
        estado: diff < 0 ? 'MELI MAS BARATO (riesgo)' : 'MELI MAS CARO',
      });
    }
  }
  afectados.sort((a, b) => a.diferencia - b.diferencia);

  console.log(`\n========================================`);
  console.log(`SKUs desfasados: ${afectados.length}`);
  console.log(`SKUs sin precio de referencia VTEX: ${sinReferencia}`);
  console.log(`========================================\n`);
  afectados.slice(0, 50).forEach(a =>
    console.log(`SKU ${a.sku} | Janis: $${a.precioJanisMeli} | Correcto: $${a.precioVtexCorrecto} | Dif: $${a.diferencia} | mod: ${a.dateModifiedJanis} | ${a.estado}`)
  );
  if (afectados.length > 50) console.log(`... y ${afectados.length - 50} más (ver CSV)`);

  fs.writeFileSync('afectados.json', JSON.stringify(afectados, null, 2));
  fs.writeFileSync('afectados.csv',
    'sku,precio_janis_meli,precio_vtex_correcto,diferencia,date_modified_janis,estado\n' +
    afectados.map(a => `${a.sku},${a.precioJanisMeli},${a.precioVtexCorrecto},${a.diferencia},${a.dateModifiedJanis},${a.estado}`).join('\n')
  );
  console.log('\n-> Generados: afectados.csv / afectados.json');
}

runAudit().catch(e => { console.error(e); process.exit(1); });
