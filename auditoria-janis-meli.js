/**
 * auditoria-janis-meli.js
 * Compara, EAN por EAN, el precio del price-sheet MELI de Janis contra el precio
 * del seller carrefourar0002 en VTEX, y reporta cuáles están desfasados y hace
 * cuánto no se actualiza el precio de Janis.
 *
 * El SKU de Janis NO guarda el ID numérico de VTEX; solo tiene referenceId y
 * eans (el código de barras). Para consultar el precio en VTEX hay que resolver
 * primero ese referenceId/EAN → SKU ID de VTEX vía el catálogo de VTEX
 * (stockkeepingunitidsbyrefid), y recién ahí pedir el precio.
 *
 * Genera 3 xlsx:
 *   meli0002-completo.xlsx     — todos los SKUs del price-sheet
 *   meli0002-pegados.xlsx      — solo status "active"
 *   meli0002-desfasados.xlsx   — los que NO matchean (MELI más barato o más caro)
 *
 * Env opcional LIMIT=30 → modo diagnóstico: procesa solo los primeros 30
 * registros (trae los SKUs por id, no pagina todo el catálogo) e imprime el
 * detalle de la resolución EAN→skuId. Ideal para validar rápido antes del run
 * completo. LIMIT=0 (default) = todos.
 */

import { utils, writeFile } from 'xlsx';

const JANIS_KEY    = process.env.JANIS_API_KEY;
const JANIS_SECRET = process.env.JANIS_API_SECRET;
const JANIS_CLIENT = process.env.JANIS_CLIENT;
const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;
const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT || 'carrefourar0002';

const PRICE_SHEET = '68cd5054eaa341977f783fef';
const CONCURRENCY = 20;
const LIMIT       = Number(process.env.LIMIT || '0');   // 0 = todos

const JANIS_H = {
  'Content-Type':     'application/json',
  'janis-api-key':    JANIS_KEY,
  'janis-api-secret': JANIS_SECRET,
  'janis-client':     JANIS_CLIENT,
};
const VTEX_H = {
  'X-VTEX-API-AppKey':   VTEX_KEY,
  'X-VTEX-API-AppToken': VTEX_TOKEN,
  'Accept':              'application/json',
  'Content-Type':        'application/json',
};

// ── Janis ─────────────────────────────────────────────────────────────────────

async function janisGet(url, page, pageSize) {
  const headers = { ...JANIS_H, 'x-janis-page': String(page) };
  if (pageSize) headers['x-janis-page-size'] = String(pageSize);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Janis ${url} p${page} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { data: await res.json(), total: Number(res.headers.get('x-janis-total') || '0') };
}

// Pagina un endpoint de Janis. Intenta con pageSize; si el servicio lo rechaza
// con 400 (el de pricing no lo soporta), reintenta sin ese header.
async function paginateAll(url, wantPageSize = 0) {
  let pageSize = wantPageSize, first;
  try { first = await janisGet(url, 1, pageSize || undefined); }
  catch (e) {
    if (pageSize && /→ 400/.test(e.message)) { pageSize = 0; first = await janisGet(url, 1); }
    else throw e;
  }
  const items = [...first.data];
  const total = first.total;
  const per   = first.data.length || 1;
  const label = url.split('/api/')[1]?.split('?')[0] || url;
  const maxP  = total > 0 ? Math.ceil(total / per) : 100000;
  for (let p = 2; p <= maxP; p++) {
    const { data } = await janisGet(url, p, pageSize || undefined);
    if (!data.length) break;
    items.push(...data);
    if (p % 50 === 0) console.log(`  ${label} p${p} (${items.length}${total ? '/' + total : ''})`);
    if (total > 0 && items.length >= total) break;
  }
  return items;
}

async function janisSkuById(hexId) {
  const res = await fetch(`https://catalog.janis.in/api/sku/${hexId}`, { headers: JANIS_H });
  if (!res.ok) return null;
  return res.json();
}

function skuInfo(s) {
  const ean = Array.isArray(s.eans) && s.eans[0] ? String(s.eans[0]) : '';
  const ref = s.referenceId != null ? String(s.referenceId) : '';
  // Candidatos de RefId para buscar el skuId en VTEX (referenceId primero, luego EAN).
  const refCandidates = [...new Set([ref, ean].filter(Boolean))];
  return { ean: ean || ref, nombre: s.name || '', refCandidates };
}

// ── VTEX ──────────────────────────────────────────────────────────────────────

// EAN / RefId → array de skuIds de VTEX en la cuenta del seller.
async function vtexSkuIdsByRefId(refId) {
  const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/catalog_system/pvt/sku/stockkeepingunitidsbyrefid/${encodeURIComponent(refId)}`;
  const res = await fetch(url, { headers: VTEX_H });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`refId ${refId} → ${res.status}`);
  const arr = await res.json().catch(() => []);
  return Array.isArray(arr) ? arr.map(String) : [];
}

async function vtexPrice(skuId) {
  const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/pricing/prices/${skuId}`;
  const res = await fetch(url, { headers: VTEX_H });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`prices/${skuId} → ${res.status}`);
  return res.json();
}

// Precio de venta del seller. No varía por política comercial; tomamos basePrice.
function vtexSellerPrice(v) {
  if (!v) return null;
  let n = Number(v.basePrice ?? 0);
  if (!(n > 0)) {
    const f = Array.isArray(v.fixedPrices) ? v.fixedPrices : [];
    n = Number(f[0]?.value ?? v.listPrice ?? 0);
  }
  return n > 0 ? n : null;
}

// GET crudo a VTEX: devuelve status + primeros chars del body, sin tirar error.
async function vtexRaw(account, path) {
  try {
    const res  = await fetch(`https://${account}.vtexcommercestable.com.br${path}`, { headers: VTEX_H });
    const body = await res.text();
    return `${res.status} ${body.slice(0, 220).replace(/\s+/g, ' ')}`;
  } catch (e) { return `ERR ${e.message}`; }
}

// Prueba varios endpoints × cuentas para descubrir cómo resolver EAN → skuId.
async function probeVtex(samples) {
  const isSeller = VTEX_ACCOUNT === 'carrefourar0002';
  console.log(`   VTEX_ACCOUNT secret == 'carrefourar0002'? ${isSeller} (len=${(VTEX_ACCOUNT || '').length})`);
  const accounts = [...new Set([VTEX_ACCOUNT, 'carrefourar0002'])];
  for (const v of samples) {
    console.log(`\n   ===== muestra: ${v} =====`);
    for (const acc of accounts) {
      const tag = acc === 'carrefourar0002' ? 'carrefourar0002' : 'secret';
      console.log(`   [${tag}] pvt/refId      → ` + await vtexRaw(acc, `/api/catalog_system/pvt/sku/stockkeepingunitidsbyrefid/${encodeURIComponent(v)}`));
      console.log(`   [${tag}] pub/eanSearch  → ` + await vtexRaw(acc, `/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${encodeURIComponent(v)}`));
      console.log(`   [${tag}] pub/eanSearch1 → ` + await vtexRaw(acc, `/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${encodeURIComponent(v)}&sc=1`));
    }
  }
}

// ── util concurrencia ──────────────────────────────────────────────────────────

async function mapPool(items, fn, onProgress) {
  const results = new Array(items.length);
  let i = 0, done = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx], idx); } catch { results[idx] = undefined; }
      if (onProgress && ++done % 2000 === 0) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

function writeXlsx(filename, sheetName, rows) {
  const ws = utils.aoa_to_sheet(rows);
  ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft' };
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, sheetName);
  writeFile(wb, filename);
  console.log(`  ${filename}: ${rows.length - 1} filas`);
}

// ── main ───────────────────────────────────────────────────────────────────────

async function run() {
  const runDate = new Date();
  console.log(`Seller VTEX: ${VTEX_ACCOUNT}${LIMIT ? ` · MODO DIAGNÓSTICO (LIMIT=${LIMIT})` : ''}`);

  const PRICE_URL = `https://pricing.janis.in/api/price?filters[priceSheet]=${PRICE_SHEET}`;

  // MODO DIAGNÓSTICO: solo 1 página de precios, resuelve sus SKUs por id y
  // prueba endpoints de VTEX contra ambas cuentas. Rápido, no arma xlsx.
  if (LIMIT) {
    const { data } = await janisGet(PRICE_URL, 1);
    const prices   = data.slice(0, LIMIT);
    const hexes    = [...new Set(prices.map(p => String(p.sku)))];
    const skus     = await mapPool(hexes, h => janisSkuById(h));
    const smap      = new Map();
    hexes.forEach((h, k) => { if (skus[k]) smap.set(h, skuInfo(skus[k])); });
    const samples  = [...new Set(prices.flatMap(p => smap.get(String(p.sku))?.refCandidates || []))].slice(0, 3);
    console.log(`\n=== PROBE VTEX (muestras: ${samples.join(', ')}) ===`);
    await probeVtex(samples);
    console.log('\nProbe listo.');
    return;
  }

  // 1. Precios del price-sheet MELI
  console.log('1/5 Precios Janis MELI...');
  const prices = await paginateAll(PRICE_URL, 0);
  console.log(`   ${prices.length} precios`);

  // 2. SKUs de Janis (hex → referenceId, ean, nombre)
  console.log('2/5 SKUs Janis...');
  const skuMap = new Map();
  const skus = await paginateAll('https://catalog.janis.in/api/sku', 100);
  console.log(`   ${skus.length} SKUs`);
  for (const s of skus) { const h = String(s.id || ''); if (h) skuMap.set(h, skuInfo(s)); }

  // 3. Resolver referenceId/EAN → skuId de VTEX
  console.log('3/5 Resolviendo SKU IDs de VTEX (por referenceId/EAN)...');
  const refToSku = new Map();     // refId → skuId VTEX (o null)
  for (const p of prices) {
    const info = skuMap.get(String(p.sku));
    if (!info) continue;
    for (const c of info.refCandidates) if (!refToSku.has(c)) refToSku.set(c, null);
  }
  const refList = [...refToSku.keys()];
  const skuIds = await mapPool(refList, r => vtexSkuIdsByRefId(r), (d, t) => console.log(`  refId ${d}/${t}`));
  refList.forEach((r, k) => refToSku.set(r, (skuIds[k] && skuIds[k][0]) || null));
  const resueltos = refList.filter(r => refToSku.get(r)).length;
  console.log(`   ${resueltos}/${refList.length} referenceIds resueltos a skuId de VTEX`);

  // Detalle de los primeros registros para validar la resolución.
  const muestra = prices.slice(0, Math.min(LIMIT ? 20 : 8, prices.length));
  console.log('   --- muestra hex → refId → skuId ---');
  for (const p of muestra) {
    const info  = skuMap.get(String(p.sku));
    const cands = info?.refCandidates || [];
    const trace = cands.map(c => `${c}→${refToSku.get(c) || '∅'}`).join('  ') || '(sin SKU en Janis)';
    console.log(`   ${p.sku} | ${(info?.nombre || '').slice(0, 28).padEnd(28)} | ${trace}`);
  }

  // 4. Precios VTEX de los skuIds resueltos
  console.log('4/5 Precios VTEX...');
  const skuIdSet   = [...new Set([...refToSku.values()].filter(Boolean))];
  const priceRes   = await mapPool(skuIdSet, id => vtexPrice(id), (d, t) => console.log(`  precio ${d}/${t}`));
  const vtexPrices = new Map();
  skuIdSet.forEach((id, k) => vtexPrices.set(id, priceRes[k]));
  console.log(`   ${[...vtexPrices.values()].filter(Boolean).length}/${skuIdSet.length} skuIds con precio`);

  // 5. Armar filas
  console.log('5/5 Armando xlsx...');
  const HEADER = [
    'ean', 'nombre', 'sku_vtex', 'hex_janis',
    'precio_janis_meli', 'precio_vtex', 'diferencia',
    'estado', 'status', 'date_modified', 'dias_sin_cambio',
  ];
  const allRows = [HEADER], pegados = [HEADER], desfasados = [HEADER];

  for (const p of prices) {
    const hexId      = String(p.sku || '');
    const info       = skuMap.get(hexId) || { ean: '', nombre: '', refCandidates: [] };
    const status     = p.status || 'active';
    const dateModStr = p.dateModified || p.updateDate || p.dateCreated || '';
    const dateMod    = dateModStr ? new Date(dateModStr) : null;
    const diasSin    = dateMod && !isNaN(dateMod) ? Math.floor((runDate - dateMod) / 86400000) : '';
    const precioJanis = Math.round(Number(p.price ?? p.value ?? 0) * 100) / 100;

    // skuId VTEX = primer candidato de RefId que se resolvió.
    let skuVtex = '';
    for (const c of info.refCandidates) { const id = refToSku.get(c); if (id) { skuVtex = id; break; } }

    const precioVtex = vtexSellerPrice(skuVtex ? vtexPrices.get(skuVtex) : null);

    let diferencia, estado;
    if (precioVtex != null) {
      diferencia = Math.round((precioVtex - precioJanis) * 100) / 100;
      if (Math.abs(diferencia) < 0.01)  estado = 'OK';
      else if (diferencia > 0)          estado = 'MELI MAS BARATO (riesgo)';
      else                              estado = 'MELI MAS CARO';
    } else {
      diferencia = '';
      estado     = 'SIN PRECIO EN VTEX';
    }

    const row = [
      info.ean, info.nombre, skuVtex, hexId,
      precioJanis, precioVtex != null ? precioVtex : 'SIN PRECIO EN VTEX', diferencia,
      estado, status, dateModStr, diasSin,
    ];
    allRows.push(row);
    if (status === 'active')                                                  pegados.push(row);
    if (estado === 'MELI MAS BARATO (riesgo)' || estado === 'MELI MAS CARO')  desfasados.push(row);
  }

  writeXlsx('meli0002-completo.xlsx',   'Completo',   allRows);
  writeXlsx('meli0002-pegados.xlsx',    'Pegados',    pegados);
  writeXlsx('meli0002-desfasados.xlsx', 'Desfasados', desfasados);
  console.log('\nListo.');
}

run().catch(e => { console.error(e.message); process.exit(1); });
