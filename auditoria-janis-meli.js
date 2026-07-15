/**
 * auditoria-janis-meli.js
 * Genera 3 CSVs comparando precios Janis-MELI vs VTEX:
 *   meli0002-completo.csv     — todos los SKUs del price-sheet
 *   meli0002-pegados.csv      — solo status "active"
 *   meli0002-desfasados.csv   — solo estado "MELI MAS BARATO (riesgo)"
 */

import { writeFileSync } from 'fs';

const JANIS_KEY    = process.env.JANIS_API_KEY;
const JANIS_SECRET = process.env.JANIS_API_SECRET;
const JANIS_CLIENT = process.env.JANIS_CLIENT;
const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;
const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;

const PRICE_SHEET  = '68cd5054eaa341977f783fef';
const PAGE_SIZE    = 500;
const VTEX_CONCURRENCY = 20;

const JANIS_H = {
  'Content-Type':    'application/json',
  'janis-api-key':   JANIS_KEY,
  'janis-api-secret': JANIS_SECRET,
  'janis-client':    JANIS_CLIENT,
};

// ── helpers ──────────────────────────────────────────────────────────────────

async function janisGet(url, page, pageSize = PAGE_SIZE) {
  const res = await fetch(url, {
    headers: {
      ...JANIS_H,
      'x-janis-page':      String(page),
      'x-janis-page-size': String(pageSize),
    }
  });
  if (!res.ok) throw new Error(`Janis ${url} p${page} → ${res.status}: ${await res.text()}`);
  const total = Number(res.headers.get('x-janis-total') || '0');
  const data  = await res.json();
  return { data, total };
}

async function paginateAll(url) {
  const first = await janisGet(url, 1);
  const items = [...first.data];
  const total = first.total || items.length;
  const pages = Math.ceil(total / PAGE_SIZE);
  for (let p = 2; p <= pages; p++) {
    const { data } = await janisGet(url, p);
    items.push(...data);
    if (p % 10 === 0) console.log(`  ${url.split('/api/')[1]} página ${p}/${pages} (${items.length}/${total})`);
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
    if ((i / VTEX_CONCURRENCY) % 50 === 0 && i > 0) {
      console.log(`  VTEX precios: ${i}/${skuIds.length}`);
    }
  }
  return results;
}

function csvRow(fields) {
  return fields.map(f => {
    const s = f == null ? '' : String(f);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

// ── main ─────────────────────────────────────────────────────────────────────

async function run() {
  const runDate = new Date();

  // 1. Traer todos los precios del price-sheet MELI
  console.log('1/4 Obteniendo precios Janis MELI...');
  const priceUrl = `https://pricing.janis.in/api/price?filters[priceSheet]=${PRICE_SHEET}`;
  const prices   = await paginateAll(priceUrl);
  console.log(`   ${prices.length} registros de precio`);

  // 2. Traer todos los SKUs del catálogo (para mapear hex → ean, nombre, sku_vtex)
  console.log('2/4 Obteniendo catálogo de SKUs Janis...');
  const skus = await paginateAll('https://catalog.janis.in/api/sku');
  console.log(`   ${skus.length} SKUs en catálogo`);

  // Construir mapa hex → { ean, nombre, sku_vtex }
  const skuMap = new Map();
  for (const s of skus) {
    const id = s.id || s._id;
    if (!id) continue;
    // sku_vtex puede estar en s.externalId, s.skuId, s.code, s.ean
    const skuVtex = s.externalId || s.skuId || s.code || '';
    const ean     = s.ean || s.barcode || s.gtin || '';
    const nombre  = s.name || s.fullName || s.title || '';
    skuMap.set(String(id), { ean, nombre, skuVtex: String(skuVtex) });
  }

  // 3. Resolver qué sku_vtex necesitamos y traer precios VTEX en batch
  console.log('3/4 Obteniendo precios VTEX...');
  const vtexIds = new Set();
  for (const p of prices) {
    const hexId = String(p.sku || p.skuId || p._id || '');
    const info  = skuMap.get(hexId);
    if (info?.skuVtex) vtexIds.add(info.skuVtex);
  }
  console.log(`   ${vtexIds.size} SKUs únicos a consultar en VTEX`);
  const vtexPrices = await batchVtex([...vtexIds]);
  console.log(`   VTEX respondió para ${[...vtexPrices.values()].filter(v => v != null).length} SKUs`);

  // 4. Armar filas
  console.log('4/4 Armando CSVs...');
  const HEADER = 'ean,nombre,sku_vtex,hex_janis,precio_janis_meli,precio_vtex,diferencia,estado,status,date_modified,dias_sin_cambio';

  const allRows    = [HEADER];
  const pegados    = [HEADER];
  const desfasados = [HEADER];

  for (const p of prices) {
    const hexId    = String(p.sku || p.skuId || p._id || '');
    const info     = skuMap.get(hexId) || { ean: '', nombre: '', skuVtex: '' };
    const status   = p.status || 'active';
    const dateModStr = p.updatedAt || p.date || p.createdAt || '';
    const dateMod  = dateModStr ? new Date(dateModStr) : null;
    const diasSin  = dateMod && !isNaN(dateMod)
      ? Math.floor((runDate - dateMod) / 86400000) : '';

    // precio_janis_meli en centavos → convertir a pesos si >1000 comparado a VTEX
    // El xlsx muestra valores como 15990 → asumimos que la API devuelve en centavos y /100, o ya en pesos.
    // Tomamos el valor tal cual y si es >1000x el esperado lo dividimos.
    let precioJanis = Number(p.price ?? p.value ?? p.basePrice ?? 0);
    // Si la API devuelve en centavos (precio > 100000 para productos normales), dividir por 100
    if (precioJanis > 0 && precioJanis >= 100000 && precioJanis % 1 === 0) {
      precioJanis = precioJanis / 100;
    }
    precioJanis = Math.round(precioJanis * 100) / 100;

    // VTEX price
    const vData = info.skuVtex ? vtexPrices.get(info.skuVtex) : undefined;
    let precioVtex = null;
    if (vData) {
      // VTEX pricing API: basePrice, costPrice, markup, listPrice, sellingPrice
      precioVtex = Number(vData.basePrice ?? vData.listPrice ?? vData.sellingPrice ?? 0) || null;
    }

    let diferencia = '';
    let estado     = '';
    if (precioVtex != null) {
      diferencia = Math.round((precioVtex - precioJanis) * 100) / 100;
      if (diferencia < 0) {
        estado = 'MELI MAS BARATO (riesgo)';
      } else {
        estado = 'OK';
      }
    } else {
      diferencia = '';
      estado     = 'SIN PRECIO EN VTEX';
    }

    const row = csvRow([
      info.ean,
      info.nombre,
      info.skuVtex,
      hexId,
      precioJanis,
      precioVtex != null ? precioVtex : 'SIN PRECIO EN VTEX',
      precioVtex != null ? diferencia  : '',
      estado,
      status,
      dateModStr,
      diasSin,
    ]);

    allRows.push(row);
    if (status === 'active') pegados.push(row);
    if (estado === 'MELI MAS BARATO (riesgo)') desfasados.push(row);
  }

  writeFileSync('meli0002-completo.csv',    allRows.join('\n'),    'utf8');
  writeFileSync('meli0002-pegados.csv',     pegados.join('\n'),    'utf8');
  writeFileSync('meli0002-desfasados.csv',  desfasados.join('\n'), 'utf8');

  console.log(`\nResultados:`);
  console.log(`  meli0002-completo.csv     ${allRows.length - 1} filas`);
  console.log(`  meli0002-pegados.csv      ${pegados.length - 1} filas`);
  console.log(`  meli0002-desfasados.csv   ${desfasados.length - 1} filas`);
}

run().catch(e => { console.error(e.message); process.exit(1); });
