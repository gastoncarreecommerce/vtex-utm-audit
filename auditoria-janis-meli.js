const fs = require('fs');

// ===================== CONFIG =====================
const PRICING_BASE = 'https://pricing.janis.in/api';
const CATALOG_BASE = 'https://catalog.janis.in/api';

const JANIS_KEY    = process.env.JANIS_API_KEY;
const JANIS_SECRET = process.env.JANIS_API_SECRET;
const JANIS_CLIENT = process.env.JANIS_CLIENT;

// VTEX subcuenta (carrefourar0002). Si IT te da credenciales propias,
// cargalas como VTEX_SUC_ACCOUNT / VTEX_SUC_KEY / VTEX_SUC_TOKEN.
const VTEX_ACCOUNT = process.env.VTEX_SUC_ACCOUNT || process.env.VTEX_ACCOUNT;
const VTEX_KEY     = process.env.VTEX_SUC_KEY   || process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_SUC_TOKEN || process.env.VTEX_APP_TOKEN;

const PRICE_SHEET_MELI = '68cd5054eaa341977f783fef'; // carrefourar0002-5

const TOLERANCIA = 0.01;
const DIAS_PEGADO = Number(process.env.DIAS_PEGADO || 30);
const CONCURRENCIA = 8;

const janisHeaders = {
  'Content-Type': 'application/json',
  'janis-api-key': JANIS_KEY,
  'janis-api-secret': JANIS_SECRET,
  'janis-client': JANIS_CLIENT,
};
const vtexHeaders = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'X-VTEX-API-AppKey': VTEX_KEY,
  'X-VTEX-API-AppToken': VTEX_TOKEN,
};

async function fetchRetry(url, options = {}, { retries = 3, timeoutMs = 20000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer);
      return res;
    } catch (e) {
      clearTimeout(timer);
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

async function fetchAllPaged(label, baseUrl) {
  const all = [];
  let page = 1;
  const pageSize = 100;
  while (true) {
    const res = await fetchRetry(baseUrl, {
      headers: { ...janisHeaders, 'x-janis-page': String(page), 'x-janis-page-size': String(pageSize) },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(label + ' HTTP ' + res.status + ' (page ' + page + '): ' + body.slice(0, 200));
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (page % 10 === 0) console.log('  ' + label + ': ' + all.length + '...');
    if (batch.length < pageSize) break;
    page++;
    if (page > 10000) break;
  }
  console.log('  ' + label + ': ' + all.length + ' (total)');
  return all;
}

async function eansToSkuIds(eans) {
  const url = 'https://' + VTEX_ACCOUNT + '.vtexcommercestable.com.br/api/catalog_system/pvt/sku/stockkeepingunitidsbyrefids';
  try {
    const res = await fetchRetry(url, { method: 'POST', headers: vtexHeaders, body: JSON.stringify(eans) }, { retries: 3, timeoutMs: 30000 });
    if (!res.ok) return {};
    return await res.json();
  } catch { return {}; }
}

async function vtexPrice(skuId) {
  const url = 'https://api.vtex.com/' + VTEX_ACCOUNT + '/pricing/prices/' + skuId;
  try {
    const res = await fetchRetry(url, { headers: vtexHeaders }, { retries: 2, timeoutMs: 15000 });
    if (res.status === 404) return { skuId, sinPrecio: true };
    if (!res.ok) return { skuId, error: 'HTTP ' + res.status };
    const data = await res.json();
    return { skuId, precio: data.basePrice };
  } catch (e) { return { skuId, error: e.message }; }
}

async function mapConcurrency(items, fn, concurrency, label) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
      if (idx % 1000 === 0 && idx > 0) console.log('    ' + label + ': ' + idx + '/' + items.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ===================== MAIN =====================
async function run() {
  console.log('=== AUDITORIA MELI carrefourar0002-5 ===');
  console.log('Cuenta VTEX usada: ' + VTEX_ACCOUNT + '\n');

  console.log('1) Catalogo Janis...');
  const skus = await fetchAllPaged('catalog/sku', CATALOG_BASE + '/sku');
  const catalogMap = new Map();
  for (const s of skus) {
    catalogMap.set(String(s.id), { ean: s.referenceId != null ? String(s.referenceId) : '', nombre: s.name || '' });
  }
  console.log('   ' + catalogMap.size + ' SKUs mapeados\n');

  console.log('2) Precios Janis (price-sheet MELI 0002)...');
  const precios = await fetchAllPaged('price', PRICING_BASE + '/price?filters[priceSheet]=' + PRICE_SHEET_MELI);
  console.log('');

  const ahora = Date.now();
  const filas = precios.map(p => {
    const cat = catalogMap.get(String(p.sku));
    const mod = p.dateModified ? new Date(p.dateModified) : null;
    return {
      hexJanis: String(p.sku),
      ean: cat ? cat.ean : '',
      nombre: cat ? (cat.nombre || '').replace(/[",;\n]/g, ' ') : '',
      precioJanis: Number(p.price),
      skuIdVtex: '',
      precioVtex: '',
      diferencia: '',
      estado: '',
      ultimaActualizacion: p.dateModified || '',
      diasSinCambio: mod ? Math.floor((ahora - mod.getTime()) / 86400000) : '',
    };
  });

  console.log('3) Traduciendo EAN -> SKU VTEX (' + VTEX_ACCOUNT + ')...');
  const eansValidos = [...new Set(filas.map(f => f.ean).filter(Boolean))];
  const eanToSku = {};
  const LOTE = 50;
  for (let i = 0; i < eansValidos.length; i += LOTE) {
    Object.assign(eanToSku, await eansToSkuIds(eansValidos.slice(i, i + LOTE)));
    if ((i / LOTE) % 20 === 0) console.log('    ~' + i + '/' + eansValidos.length);
  }
  const traducidos = Object.keys(eanToSku).length;
  console.log('   ' + traducidos + ' EANs traducidos\n');

  if (traducidos === 0) {
    console.log('!! No se pudo traducir ningun EAN (falta acceso a ' + VTEX_ACCOUNT + ').');
    console.log('   Se genera el CSV con datos de Janis; columnas de VTEX vacias.\n');
  } else {
    console.log('4) Trayendo precios VTEX...');
    const skuIdsUnicos = [...new Set(Object.values(eanToSku).filter(Boolean))];
    const preciosVtex = await mapConcurrency(skuIdsUnicos, vtexPrice, CONCURRENCIA, 'VTEX');
    const vtexMap = new Map();
    for (const r of preciosVtex) if (r && r.skuId) vtexMap.set(String(r.skuId), r);
    console.log('   ' + vtexMap.size + ' precios procesados\n');

    for (const f of filas) {
      const skuId = eanToSku[f.ean];
      f.skuIdVtex = skuId || '';
      const v = skuId ? vtexMap.get(String(skuId)) : null;
      if (!v) { f.estado = 'SIN SKU VTEX'; continue; }
      if (v.sinPrecio) { f.estado = 'SIN PRECIO EN VTEX'; continue; }
      if (v.error) { f.estado = 'ERROR VTEX'; continue; }
      f.precioVtex = v.precio;
      const dif = Math.round((f.precioJanis - v.precio) * 100) / 100;
      f.diferencia = dif;
      f.estado = Math.abs(dif) <= TOLERANCIA ? 'OK' : (dif < 0 ? 'MELI MAS BARATO (riesgo)' : 'MELI MAS CARO');
    }
  }

  const desfasados = filas.filter(f => f.estado === 'MELI MAS BARATO (riesgo)' || f.estado === 'MELI MAS CARO')
    .sort((a, b) => (a.diferencia || 0) - (b.diferencia || 0));
  const pegados = filas.filter(f => typeof f.diasSinCambio === 'number' && f.diasSinCambio >= DIAS_PEGADO)
    .sort((a, b) => b.diasSinCambio - a.diasSinCambio);

  console.log('========================================');
  console.log('Total SKUs en MELI 0002:  ' + filas.length);
  console.log('Desfasados vs VTEX:       ' + desfasados.length);
  console.log('Pegados (+' + DIAS_PEGADO + 'd):        ' + pegados.length);
  console.log('========================================\n');

  if (desfasados.length) {
    console.log('--- TOP 25 DESFASADOS ---');
    desfasados.slice(0, 25).forEach(f =>
      console.log('Janis ' + f.hexJanis + ' | $' + f.precioJanis + ' | VTEX ' + f.skuIdVtex + ' $' + f.precioVtex + ' | Dif $' + f.diferencia));
  }

  // ===== CSV con el orden de columnas pedido =====
  // id Janis (hex) | precio Janis | SKU VTEX | precio VTEX | ultima actualizacion
  const header = 'id_janis,precio_janis,sku_vtex,precio_vtex,ultima_actualizacion,ean,nombre,diferencia,estado,dias_sin_cambio\n';
  const toRow = f => [
    f.hexJanis,
    f.precioJanis,
    f.skuIdVtex || '',
    f.precioVtex !== '' && f.precioVtex != null ? f.precioVtex : '',
    f.ultimaActualizacion,
    f.ean,
    f.nombre,
    f.diferencia !== '' && f.diferencia != null ? f.diferencia : '',
    f.estado || '',
    f.diasSinCambio,
  ].join(',');

  fs.writeFileSync('meli0002-completo.csv', header + filas.map(toRow).join('\n'));
  fs.writeFileSync('meli0002-desfasados.csv', header + desfasados.map(toRow).join('\n'));
  fs.writeFileSync('meli0002-pegados.csv', header + pegados.map(toRow).join('\n'));
  console.log('\n-> Generados: meli0002-completo.csv / meli0002-desfasados.csv / meli0002-pegados.csv');
}

run().catch(e => { console.error(e); process.exit(1); });
