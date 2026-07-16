/**
 * auditoria-janis-meli.js
 * Compara, EAN por EAN, el precio del price-sheet MELI de Janis contra el precio
 * en VTEX (cuenta carrefourar), y reporta cuáles están desfasados y hace cuánto
 * no se actualiza el precio de Janis.
 *
 * Flujo (confirmado con probes):
 *   1. Precios del price-sheet MELI de Janis (pricing.janis.in)          → precio_janis
 *   2. Catálogo de SKUs de Janis (catalog.janis.in)   hex → EAN, nombre
 *   3. EAN → skuId de VTEX vía catálogo (pub/products/search?fq=alternateIds_Ean)
 *   4. skuId → precio VTEX (pricing/prices/{skuId}, basePrice)           → precio_vtex
 *
 * El SKU de Janis no guarda el skuId de VTEX; hay que resolver el EAN contra el
 * catálogo de VTEX. El RefId de VTEX NO es el EAN (stockkeepingunitidsbyrefid da
 * 404), por eso se busca por alternateIds_Ean. El precio no varía por política
 * comercial, solo por cuenta/seller; usamos la cuenta del env VTEX_ACCOUNT.
 *
 * Genera 3 xlsx:
 *   meli0002-completo.xlsx     — todos los SKUs del price-sheet
 *   meli0002-pegados.xlsx      — solo status "active"
 *   meli0002-desfasados.xlsx   — los que NO matchean (MELI más barato o más caro)
 *
 * Env LIMIT=N (opcional) → procesa solo N registros trayendo los SKUs por id
 * (sin paginar todo el catálogo). Ideal para validar rápido. LIMIT=0 = todos.
 */

import { utils, writeFile } from 'xlsx';

const JANIS_KEY    = process.env.JANIS_API_KEY;
const JANIS_SECRET = process.env.JANIS_API_SECRET;
const JANIS_CLIENT = process.env.JANIS_CLIENT;
const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;
const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT || 'carrefourar';

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

// Pagina un endpoint de Janis. Intenta con pageSize; si lo rechaza con 400 (el
// de pricing no lo soporta), reintenta sin ese header. Corta en página vacía.
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
  return { ean: ean || ref, nombre: s.name || '' };
}

// ── VTEX ──────────────────────────────────────────────────────────────────────

// EAN → skuId de VTEX buscando en el catálogo por alternateIds_Ean.
async function vtexSkuIdByEan(ean) {
  const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${encodeURIComponent(ean)}&_from=0&_to=0`;
  const res = await fetch(url, { headers: VTEX_H });
  if (!res.ok) return null;
  const arr = await res.json().catch(() => []);
  const items = [];
  for (const prod of Array.isArray(arr) ? arr : [])
    for (const it of prod.items || [])
      items.push({ itemId: String(it.itemId), ean: it.ean });
  const m = items.find(i => String(i.ean) === String(ean)) || items[0];
  return m ? m.itemId : null;
}

async function vtexPrice(skuId) {
  const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/pricing/prices/${skuId}`;
  const res = await fetch(url, { headers: VTEX_H });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`prices/${skuId} → ${res.status}`);
  return res.json();
}

// Precio de venta en VTEX. No varía por política comercial; tomamos basePrice.
function vtexSellerPrice(v) {
  if (!v) return null;
  let n = Number(v.basePrice ?? 0);
  if (!(n > 0)) {
    const f = Array.isArray(v.fixedPrices) ? v.fixedPrices : [];
    n = Number(f[0]?.value ?? v.listPrice ?? 0);
  }
  return n > 0 ? n : null;
}

// ── util ───────────────────────────────────────────────────────────────────────

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
  const runDate  = new Date();
  const PRICE_URL = `https://pricing.janis.in/api/price?filters[priceSheet]=${PRICE_SHEET}`;
  console.log(`VTEX account: ${VTEX_ACCOUNT === 'carrefourar' ? 'carrefourar' : '(env)'}${LIMIT ? ` · LIMIT=${LIMIT}` : ''}`);

  // 1. Precios del price-sheet MELI
  console.log('1/5 Precios Janis MELI...');
  const prices = LIMIT
    ? (await janisGet(PRICE_URL, 1)).data.slice(0, LIMIT)
    : await paginateAll(PRICE_URL, 0);
  console.log(`   ${prices.length} precios`);

  // 2. SKUs de Janis (hex → EAN, nombre)
  console.log('2/5 SKUs Janis...');
  const skuMap = new Map();
  if (LIMIT) {
    const hexes = [...new Set(prices.map(p => String(p.sku)))];
    const skus  = await mapPool(hexes, h => janisSkuById(h));
    hexes.forEach((h, k) => { if (skus[k]) skuMap.set(h, skuInfo(skus[k])); });
  } else {
    const skus = await paginateAll('https://catalog.janis.in/api/sku', 100);
    console.log(`   ${skus.length} SKUs`);
    for (const s of skus) { const h = String(s.id || ''); if (h) skuMap.set(h, skuInfo(s)); }
  }

  // 3. EAN → skuId de VTEX (search por alternateIds_Ean)
  console.log('3/5 Resolviendo EAN → skuId de VTEX...');
  const eans = [...new Set(prices.map(p => skuMap.get(String(p.sku))?.ean).filter(Boolean))];
  const skuIds = await mapPool(eans, e => vtexSkuIdByEan(e), (d, t) => console.log(`  ean ${d}/${t}`));
  const eanToSku = new Map();
  eans.forEach((e, k) => eanToSku.set(e, skuIds[k] || null));
  console.log(`   ${[...eanToSku.values()].filter(Boolean).length}/${eans.length} EANs resueltos a skuId`);

  // 4. skuId → precio VTEX
  console.log('4/5 Precios VTEX...');
  const idSet   = [...new Set([...eanToSku.values()].filter(Boolean))];
  const priceRs = await mapPool(idSet, id => vtexPrice(id), (d, t) => console.log(`  precio ${d}/${t}`));
  const priceMap = new Map();
  idSet.forEach((id, k) => priceMap.set(id, priceRs[k]));
  console.log(`   ${[...priceMap.values()].filter(Boolean).length}/${idSet.length} skuIds con precio`);

  // 5. Armar filas
  console.log('5/5 Armando xlsx...');
  const HEADER = [
    'ean', 'nombre', 'sku_vtex', 'hex_janis',
    'precio_janis_meli', 'precio_vtex', 'diferencia',
    'estado', 'status', 'date_modified', 'dias_sin_cambio',
  ];
  const allRows = [HEADER], pegados = [HEADER], desfasados = [HEADER];
  const muestra = [];

  for (const p of prices) {
    const hexId      = String(p.sku || '');
    const info       = skuMap.get(hexId) || { ean: '', nombre: '' };
    const status     = p.status || 'active';
    const dateModStr = p.dateModified || p.updateDate || p.dateCreated || '';
    const dateMod    = dateModStr ? new Date(dateModStr) : null;
    const diasSin    = dateMod && !isNaN(dateMod) ? Math.floor((runDate - dateMod) / 86400000) : '';
    const precioJanis = Math.round(Number(p.price ?? p.value ?? 0) * 100) / 100;

    const skuVtex    = (info.ean && eanToSku.get(info.ean)) || '';
    const precioVtex = vtexSellerPrice(skuVtex ? priceMap.get(skuVtex) : null);

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
    if (muestra.length < 8) muestra.push(`   ${info.ean} | ${(info.nombre || '').slice(0, 26).padEnd(26)} | vtex ${skuVtex || '∅'} | janis ${precioJanis} vs vtex ${precioVtex ?? '—'} | ${estado}`);
  }

  console.log('   --- muestra ---\n' + muestra.join('\n'));

  writeXlsx('meli0002-completo.xlsx',   'Completo',   allRows);
  writeXlsx('meli0002-pegados.xlsx',    'Pegados',    pegados);
  writeXlsx('meli0002-desfasados.xlsx', 'Desfasados', desfasados);

  const desf = desfasados.length - 1, ok = allRows.length - 1;
  console.log(`\nResumen: ${ok} filas · ${desf} desfasados · ${[...priceMap.values()].filter(Boolean).length} con precio VTEX`);
  console.log('Listo.');
}

run().catch(e => { console.error(e.message); process.exit(1); });
