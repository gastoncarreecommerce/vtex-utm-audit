const fs = require('fs');

const JANIS_BASE   = 'https://pricing.janis.in/api';
const JANIS_KEY    = process.env.JANIS_API_KEY;
const JANIS_SECRET = process.env.JANIS_API_SECRET;
const JANIS_CLIENT = process.env.JANIS_CLIENT;
const TOLERANCIA = 0.01;

// Cuántos días sin modificarse para considerar un precio "sospechoso de pegado"
const DIAS_PEGADO = Number(process.env.DIAS_PEGADO || 60);

const janisHeaders = {
  'Content-Type': 'application/json',
  'janis-api-key': JANIS_KEY,
  'janis-api-secret': JANIS_SECRET,
  'janis-client': JANIS_CLIENT,
};

async function fetchAllBasePrices() {
  const all = [];
  let page = 1;
  const pageSize = 100;
  while (true) {
    const res = await fetch(`${JANIS_BASE}/base-price`, {
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
    console.log(`  base-price page ${page}: +${batch.length} (total ${all.length})`);
    if (batch.length < pageSize) break;
    page++;
    if (page > 5000) break;
  }
  return all;
}

function loadVtexMap() {
  if (!fs.existsSync('vtex-prices.json')) {
    console.warn('!! No existe vtex-prices.json. Solo se hace el analisis de antiguedad (sin cruce VTEX).');
    return new Map();
  }
  const vtex = JSON.parse(fs.readFileSync('vtex-prices.json', 'utf-8'));
  return new Map(vtex.filter(r => !r.error).map(r => [String(r.sku), Number(r.pc5Price)]));
}

async function run() {
  console.log('--- Auditoria de Base Prices en Janis ---\n');
  const prices = await fetchAllBasePrices();
  console.log(`\nTotal base prices: ${prices.length}\n`);

  const ahora = Date.now();
  const vtexMap = loadVtexMap();

  const filas = prices.map(p => {
    const sku = String(p.sku);
    const mod = p.dateModified ? new Date(p.dateModified) : null;
    const diasSinCambio = mod ? Math.floor((ahora - mod.getTime()) / 86400000) : null;
    const precioVtex = vtexMap.get(sku);
    let diferencia = null, estado = '';
    if (precioVtex != null) {
      diferencia = Math.round((Number(p.price) - precioVtex) * 100) / 100;
      if (Math.abs(diferencia) > TOLERANCIA) {
        estado = diferencia < 0 ? 'MELI MAS BARATO (riesgo)' : 'MELI MAS CARO';
      } else {
        estado = 'OK';
      }
    }
    return {
      sku,
      precioJanis: Number(p.price),
      precioVtex: precioVtex ?? '',
      diferencia: diferencia ?? '',
      estado,
      status: p.status,
      dateModified: p.dateModified || '',
      diasSinCambio: diasSinCambio ?? '',
    };
  });

  // --- Reporte 1: precios pegados (viejos) ---
  const pegados = filas
    .filter(f => typeof f.diasSinCambio === 'number' && f.diasSinCambio >= DIAS_PEGADO)
    .sort((a, b) => b.diasSinCambio - a.diasSinCambio);

  console.log(`========================================`);
  console.log(`Precios sin cambios hace +${DIAS_PEGADO} dias: ${pegados.length}`);
  console.log(`========================================\n`);
  pegados.slice(0, 30).forEach(f =>
    console.log(`SKU ${f.sku} | $${f.precioJanis} | ${f.diasSinCambio} dias sin cambio | ${f.status} | mod: ${f.dateModified}`)
  );
  if (pegados.length > 30) console.log(`... y ${pegados.length - 30} mas (ver CSV)`);

  // --- Reporte 2: desfasados vs VTEX (si hay referencia) ---
  const desfasados = filas.filter(f => f.estado && f.estado !== 'OK');
  if (vtexMap.size > 0) {
    console.log(`\n========================================`);
    console.log(`Desfasados vs VTEX: ${desfasados.length}`);
    console.log(`========================================\n`);
    desfasados.slice(0, 30).forEach(f =>
      console.log(`SKU ${f.sku} | Janis: $${f.precioJanis} | VTEX: $${f.precioVtex} | Dif: $${f.diferencia} | ${f.estado}`)
    );
  }

  // --- Salidas CSV ---
  const header = 'sku,precio_janis,precio_vtex,diferencia,estado,status,date_modified,dias_sin_cambio\n';
  const toRow = f => `${f.sku},${f.precioJanis},${f.precioVtex},${f.diferencia},${f.estado},${f.status},${f.dateModified},${f.diasSinCambio}`;

  fs.writeFileSync('janis-base-prices-completo.csv', header + filas.map(toRow).join('\n'));
  fs.writeFileSync('janis-pegados.csv', header + pegados.map(toRow).join('\n'));
  if (vtexMap.size > 0) {
    fs.writeFileSync('janis-desfasados.csv', header + desfasados.map(toRow).join('\n'));
  }

  console.log('\n-> Generados: janis-base-prices-completo.csv / janis-pegados.csv' + (vtexMap.size > 0 ? ' / janis-desfasados.csv' : ''));
}

run().catch(e => { console.error(e); process.exit(1); });
