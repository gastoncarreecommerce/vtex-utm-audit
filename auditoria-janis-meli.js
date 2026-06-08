const fs = require('fs');

// ===================== CONFIG =====================
const PRICING_BASE = 'https://pricing.janis.in/api';
const CATALOG_BASE = 'https://catalog.janis.in/api';

const JANIS_KEY    = process.env.JANIS_API_KEY;
const JANIS_SECRET = process.env.JANIS_API_SECRET;
const JANIS_CLIENT = process.env.JANIS_CLIENT;

const TOLERANCIA = 0.01;
const DIAS_PEGADO = Number(process.env.DIAS_PEGADO || 60);

const janisHeaders = {
  'Content-Type': 'application/json',
  'janis-api-key': JANIS_KEY,
  'janis-api-secret': JANIS_SECRET,
  'janis-client': JANIS_CLIENT,
};

// ===================== HELPERS =====================
async function fetchAllPaged(label, baseUrl) {
  const all = [];
  let page = 1;
  const pageSize = 100;
  while (true) {
    const res = await fetch(baseUrl, {
      method: 'GET',
      headers: { ...janisHeaders, 'x-janis-page': String(page), 'x-janis-page-size': String(pageSize) },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(label + ' HTTP ' + res.status + ' (page ' + page + '): ' + body.slice(0, 200));
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (page % 10 === 0) console.log('  ' + label + ': ' + all.length + ' registros...');
    if (batch.length < pageSize) break;
    page++;
    if (page > 10000) break;
  }
  console.log('  ' + label + ': ' + all.length + ' registros (total)');
  return all;
}

function loadVtexMap() {
  if (!fs.existsSync('vtex-prices.json')) {
    console.warn('\n!! No existe vtex-prices.json. Se omite el cruce de precios con VTEX.');
    console.warn('   (igual se genera el reporte de precios pegados por antiguedad)\n');
    return new Map();
  }
  const vtex = JSON.parse(fs.readFileSync('vtex-prices.json', 'utf-8'));
  return new Map(vtex.filter(r => !r.error).map(r => [String(r.sku), Number(r.pc5Price)]));
}

// ===================== MAIN =====================
async function run() {
  console.log('=== AUDITORIA JANIS -> MELI (con traduccion a SKU VTEX) ===\n');

  // 1. Catalog: mapa hex -> { referenceId, nombre }
  console.log('1) Bajando catalogo (SKUs)...');
  const skus = await fetchAllPaged('catalog/sku', CATALOG_BASE + '/sku');
  const catalogMap = new Map();
  for (const s of skus) {
    catalogMap.set(String(s.id), {
      referenceId: s.referenceId != null ? String(s.referenceId) : '',
      nombre: s.name || '',
    });
  }
  console.log('   -> ' + catalogMap.size + ' SKUs mapeados (hex -> referenceId)\n');

  // 2. Pricing: base-prices
  console.log('2) Bajando base-prices...');
  const prices = await fetchAllPaged('base-price', PRICING_BASE + '/base-price');
  console.log('');

  // 3. VTEX (opcional)
  const vtexMap = loadVtexMap();

  // 4. Cruce
  const ahora = Date.now();
  const filas = [];
  let sinCatalog = 0;

  for (const p of prices) {
    const hex = String(p.sku);
    const cat = catalogMap.get(hex);
    const referenceId = cat ? cat.referenceId : '';
    const nombre = cat ? cat.nombre : '';
    if (!cat) sinCatalog++;

    const mod = p.dateModified ? new Date(p.dateModified) : null;
    const diasSinCambio = mod ? Math.floor((ahora - mod.getTime()) / 86400000) : '';

    const precioVtex = referenceId ? vtexMap.get(referenceId) : undefined;
    let diferencia = '', estado = '';
    if (precioVtex != null) {
      diferencia = Math.round((Number(p.price) - precioVtex) * 100) / 100;
      estado = Math.abs(diferencia) <= TOLERANCIA ? 'OK'
             : (diferencia < 0 ? 'MELI MAS BARATO (riesgo)' : 'MELI MAS CARO');
    }

    filas.push({
      referenceId,
      nombre: (nombre || '').replace(/[",;\n]/g, ' '),
      hex,
      precioJanis: Number(p.price),
      precioVtex: precioVtex != null ? precioVtex : '',
      diferencia,
      estado,
      status: p.status || '',
      dateModified: p.dateModified || '',
      diasSinCambio,
    });
  }

  console.log('Total filas: ' + filas.length);
  console.log('Sin match en catalogo: ' + sinCatalog);

  // --- Reporte: pegados ---
  const pegados = filas
    .filter(f => typeof f.diasSinCambio === 'number' && f.diasSinCambio >= DIAS_PEGADO)
    .sort((a, b) => b.diasSinCambio - a.diasSinCambio);

  console.log('\n========================================');
  console.log('Precios sin cambios hace +' + DIAS_PEGADO + ' dias: ' + pegados.length);
  console.log('========================================');
  pegados.slice(0, 25).forEach(f =>
    console.log('Ref ' + (f.referenceId || '???') + ' | $' + f.precioJanis + ' | ' + f.diasSinCambio + 'd | ' + f.status + ' | ' + f.nombre.slice(0,40))
  );
  if (pegados.length > 25) console.log('... y ' + (pegados.length - 25) + ' mas (ver CSV)');

  // --- Reporte: desfasados vs VTEX ---
  const desfasados = filas.filter(f => f.estado && f.estado !== 'OK')
    .sort((a, b) => (a.diferencia || 0) - (b.diferencia || 0));
  if (vtexMap.size > 0) {
    console.log('\n========================================');
    console.log('Desfasados vs VTEX: ' + desfasados.length);
    console.log('========================================');
    desfasados.slice(0, 25).forEach(f =>
      console.log('Ref ' + f.referenceId + ' | Janis $' + f.precioJanis + ' | VTEX $' + f.precioVtex + ' | Dif $' + f.diferencia + ' | ' + f.estado)
    );
  }

  // --- CSVs ---
  const header = 'reference_id,nombre,hex_janis,precio_janis,precio_vtex,diferencia,estado,status,date_modified,dias_sin_cambio\n';
  const toRow = f => f.referenceId + ',' + f.nombre + ',' + f.hex + ',' + f.precioJanis + ',' + f.precioVtex + ',' + f.diferencia + ',' + f.estado + ',' + f.status + ',' + f.dateModified + ',' + f.diasSinCambio;

  fs.writeFileSync('janis-completo.csv', header + filas.map(toRow).join('\n'));
  fs.writeFileSync('janis-pegados.csv', header + pegados.map(toRow).join('\n'));
  if (vtexMap.size > 0) {
    fs.writeFileSync('janis-desfasados.csv', header + desfasados.map(toRow).join('\n'));
  }

  console.log('\n-> Generados: janis-completo.csv / janis-pegados.csv' + (vtexMap.size > 0 ? ' / janis-desfasados.csv' : ''));
}

run().catch(e => { console.error(e); process.exit(1); });
