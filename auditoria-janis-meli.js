/**
 * auditoria-janis-meli.js
 * Genera 3 xlsx comparando precios Janis-MELI vs VTEX:
 *   meli0002-completo.xlsx     — todos los SKUs del price-sheet
 *   meli0002-pegados.xlsx      — solo status "active"
 *   meli0002-desfasados.xlsx   — solo estado "MELI MAS BARATO (riesgo)"
 */

import { utils, writeFile } from 'xlsx';

const JANIS_KEY    = process.env.JANIS_API_KEY;
const JANIS_SECRET = process.env.JANIS_API_SECRET;
const JANIS_CLIENT = process.env.JANIS_CLIENT;
const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;
const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;

const PRICE_SHEET      = '68cd5054eaa341977f783fef';
const VTEX_CONCURRENCY = 20;

const JANIS_H = {
  'Content-Type':     'application/json',
  'janis-api-key':    JANIS_KEY,
  'janis-api-secret': JANIS_SECRET,
  'janis-client':     JANIS_CLIENT,
};

// ── helpers ───────────────────────────────────────────────────────────────────

async function janisGet(url, page) {
  const res = await fetch(url, {
    headers: { ...JANIS_H, 'x-janis-page': String(page) }
  });
  if (!res.ok) throw new Error(`Janis ${url} p${page} → ${res.status}: ${await res.text()}`);
  const total = Number(res.headers.get('x-janis-total') || '0');
  const data  = await res.json();
  return { data, total };
}

async function paginateAll(url) {
  const first    = await janisGet(url, 1);
  const items    = [...first.data];
  const total    = first.total;
  const pageSize = first.data.length;
  const label    = url.split('/api/')[1]?.split('?')[0] || url;
  if (!pageSize || (total > 0 && items.length >= total)) return items;
  const pages = total > 0 ? Math.ceil(total / pageSize) : 9999;
  for (let p = 2; p <= pages; p++) {
    const { data } = await janisGet(url, p);
    if (!data.length) break;
    items.push(...data);
    if (p % 20 === 0) console.log(`  ${label} p${p}/${pages} (${items.length}/${total})`);
    if (total > 0 && items.length >= total) break;
  }
  return items;
}

async function vtexPrice(skuId) {
  const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/pricing/prices/${skuId}`;
  const res = await fetch(url, {
    headers: {
      'X-VTEX-API-AppKey':   VTEX_KEY,
      'X-VTEX-API-AppToken': VTEX_TOKEN,
      'Accept':              'application/json',
    }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`VTEX prices/${skuId} → ${res.status}`);
  return res.json();
}

async function batchVtex(skuIds) {
  const results = new Map();
  for (let i = 0; i < skuIds.length; i += VTEX_CONCURRENCY) {
    const chunk = skuIds.slice(i, i + VTEX_CONCURRENCY);
    await Promise.all(chunk.map(async id => {
      try { results.set(id, await vtexPrice(id)); }
      catch { results.set(id, undefined); }
    }));
    if (i > 0 && (i / VTEX_CONCURRENCY) % 50 === 0) {
      console.log(`  VTEX precios: ${i}/${skuIds.length}`);
    }
  }
  return results;
}

function writeXlsx(filename, sheetName, rows) {
  const ws = utils.aoa_to_sheet(rows);
  // Freeze header row
  ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft' };
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, sheetName);
  writeFile(wb, filename);
  console.log(`  ${filename}: ${rows.length - 1} filas`);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function run() {
  const runDate = new Date();

  // 1. Precios Janis MELI
  console.log('1/4 Obteniendo precios Janis MELI...');
  const priceUrl = `https://pricing.janis.in/api/price?filters[priceSheet]=${PRICE_SHEET}`;
  const prices   = await paginateAll(priceUrl);
  console.log(`   ${prices.length} registros de precio`);

  // 2. Catálogo de SKUs
  console.log('2/4 Obteniendo catálogo de SKUs Janis...');
  const skus = await paginateAll('https://catalog.janis.in/api/sku');
  console.log(`   ${skus.length} SKUs`);

  // Debug: ver estructura del primer SKU para identificar los campos correctos
  if (skus.length > 0) {
    console.log('   Debug SKU[0] keys:', Object.keys(skus[0]).join(', '));
    console.log('   Debug SKU[0]:', JSON.stringify(skus[0]).slice(0, 500));
  }

  // Construir mapa hexId → { ean, nombre, skuVtex }
  const skuMap = new Map();
  for (const s of skus) {
    const hexId = String(s.id || s._id || '');
    if (!hexId) continue;
    // Intentar todos los campos candidatos para el ID VTEX numérico
    const skuVtex = String(
      s.externalId   ??
      s.vtexSkuId    ??
      s.vtexId       ??
      s.referenceId  ??
      s.skuId        ??
      s.code         ??
      s.sku          ??
      ''
    );
    const ean    = String(s.ean || s.barcode || s.gtin || s.referenceId || '');
    const nombre = String(s.name || s.fullName || s.title || '');
    skuMap.set(hexId, { ean, nombre, skuVtex });
  }

  // Debug: mostrar primer match precio→SKU
  if (prices.length > 0) {
    const hex0  = String(prices[0].sku || prices[0].skuId || prices[0]._id || '');
    const info0 = skuMap.get(hex0);
    console.log(`   Debug precio[0].sku: ${hex0} → skuMap: ${JSON.stringify(info0)}`);
  }

  // 3. Precios VTEX
  console.log('3/4 Obteniendo precios VTEX...');
  const vtexIds = new Set();
  for (const p of prices) {
    const hexId = String(p.sku || p.skuId || p._id || '');
    const info  = skuMap.get(hexId);
    if (info?.skuVtex) vtexIds.add(info.skuVtex);
  }
  console.log(`   ${vtexIds.size} SKUs únicos a consultar en VTEX`);

  let vtexPrices = new Map();
  if (vtexIds.size > 0) {
    vtexPrices = await batchVtex([...vtexIds]);
    const encontrados = [...vtexPrices.values()].filter(v => v != null).length;
    console.log(`   VTEX: ${encontrados} con precio, ${vtexIds.size - encontrados} sin precio`);
  }

  // 4. Armar filas y escribir xlsx
  console.log('4/4 Armando xlsx...');
  const HEADER = [
    'ean', 'nombre', 'sku_vtex', 'hex_janis',
    'precio_janis_meli', 'precio_vtex', 'diferencia',
    'estado', 'status', 'date_modified', 'dias_sin_cambio',
  ];

  const allRows    = [HEADER];
  const pegados    = [HEADER];
  const desfasados = [HEADER];

  for (const p of prices) {
    const hexId      = String(p.sku || p.skuId || p._id || '');
    const info       = skuMap.get(hexId) || { ean: '', nombre: '', skuVtex: '' };
    const status     = p.status || 'active';
    const dateModStr = p.dateModified || p.updatedAt || p.date || p.createdAt || '';
    const dateMod    = dateModStr ? new Date(dateModStr) : null;
    const diasSin    = dateMod && !isNaN(dateMod)
      ? Math.floor((runDate - dateMod) / 86400000) : '';

    const precioJanis = Math.round(Number(p.price ?? p.value ?? p.basePrice ?? 0) * 100) / 100;

    const vData    = info.skuVtex ? vtexPrices.get(info.skuVtex) : undefined;
    let precioVtex = null;
    if (vData) {
      precioVtex = Number(vData.basePrice ?? vData.listPrice ?? vData.sellingPrice ?? 0) || null;
    }

    let diferencia, estado;
    if (precioVtex != null) {
      diferencia = Math.round((precioVtex - precioJanis) * 100) / 100;
      estado     = diferencia < 0 ? 'MELI MAS BARATO (riesgo)' : 'OK';
    } else {
      diferencia = '';
      estado     = 'SIN PRECIO EN VTEX';
    }

    const row = [
      info.ean,
      info.nombre,
      info.skuVtex,
      hexId,
      precioJanis,
      precioVtex != null ? precioVtex : 'SIN PRECIO EN VTEX',
      diferencia,
      estado,
      status,
      dateModStr,
      diasSin,
    ];

    allRows.push(row);
    if (status === 'active')                       pegados.push(row);
    if (estado === 'MELI MAS BARATO (riesgo)')     desfasados.push(row);
  }

  writeXlsx('meli0002-completo.xlsx',    'Completo',    allRows);
  writeXlsx('meli0002-pegados.xlsx',     'Pegados',     pegados);
  writeXlsx('meli0002-desfasados.xlsx',  'Desfasados',  desfasados);

  console.log('\nListo.');
}

run().catch(e => { console.error(e.message); process.exit(1); });
