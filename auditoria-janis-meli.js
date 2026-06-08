const fs = require('fs');

// ===================== CONFIG =====================
const PRICING_BASE = 'https://pricing.janis.in/api';
const CATALOG_BASE = 'https://catalog.janis.in/api';

const JANIS_KEY    = process.env.JANIS_API_KEY;
const JANIS_SECRET = process.env.JANIS_API_SECRET;
const JANIS_CLIENT = process.env.JANIS_CLIENT;

const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;
const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;

// Price-sheet de MELI sucursal 0002 (confirmado en diagnostico)
const PRICE_SHEET_MELI = '68cd5054eaa341977f783fef';
// Sales channel de VTEX para comparar (MELI 0002)
const VTEX_SALES_CHANNEL = '5';
const VTEX_SELLER = 'carrefourar0002';

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

// ===================== HELPERS =====================
async function fetchAllPaged(label, baseUrl) {
  const all = [];
  let page = 1;
  const pageSize = 100;
  while (true) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const res = await fetch(baseUrl, {
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

// Traduce lote de EANs -> skuId VTEX
async function eansToSkuIds(eans) {
  const url = 'https://' + VTEX_ACCOUNT + '.vtexcommercestable.com.br/api/catalog_system/pvt/sku/stockkeepingunitidsbyrefids';
  try {
    const res = await fetch(url, { method: 'POST', headers: vtexHeaders, body: JSON.stringify(eans) });
    if (!res.ok) return {};
    return await res.json();
  } catch { return {}; }
}

// Precio VTEX por skuId
async function vtexPrice(skuId) {
  const url = 'https://api.vtex.com/' + VTEX_ACCOUNT + '/pricing/prices/' + skuId;
  try {
    const res = await fetch(url, { headers: vtexHeaders });
    if (res.status === 404) return { skuId, sinPrecio: true };
    if (!res.ok) return { skuId, error: 'HTTP ' + res.status };
    const data = await res.json();
    // Buscar fixedPrice de la trade policy 5; si no hay, basePrice
    let precio = data.basePrice;
    let origen = 'base';
    if (Array.isArray(data.fixedPrices)) {
      const fp = data.fixedPrices.find(p => String(p.tradePolicyId) === VTEX_SALES_CHANNEL);
      if (fp) { precio = fp.value; origen = 'pc5'; }
    }
    return { skuId, precio, origen };
  } catch (e) { return { skuId, error: e.message }; }
}

async function mapConcurrency(items, fn, concurrency) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
      if (idx % 500 === 0 && idx > 0) console.log('    VTEX precios: ' + idx + '/' + items.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ===================== MAIN =====================
async function run() {
  console.log('=== AUDITORIA MELI carrefourar0002-5 ===\n');

  // 1) Catalog: hex -> { referenceId(EAN), nombre }
  console.log('1) Catalogo...');
  const skus = await fetchAllPaged('catalog/sku', CATALOG_BASE + '/sku');
  const catalogMap = new Map();
  for (const s of skus) {
    catalogMap.set(String(s.id), {
      ean: s.referenceId != null ? String(s.referenceId) : '',
      nombre: s.name || '',
    });
  }
  console.log('   ' + catalogMap.size + ' SKUs mapeados\n');

  // 2) Precios del price-sheet MELI 0002
  console.log('2) Precios Janis (price-sheet MELI 0002)...');
  const precios = await fetchAllPaged('price', PRICING_BASE + '/price?filters[priceSheet]=' + PRICE_SHEET_MELI);
  console.log('');

  // 3) Enriquecer con EAN + nombre
  const ahora = Date.now();
  const filas = precios.map(p => {
    const cat = catalogMap.get(String(p.sku));
    const mod = p.dateModified ? new Date(p.dateModified) : null;
    return {
      ean: cat ? cat.ean : '',
      nombre: cat ? (cat.nombre || '').replace(/[",;\n]/g, ' ') : '',
      hex: String(p.sku),
      precioJanis: Number(p.price),
      status: p.status || '',
      dateModified: p.dateModified || '',
      diasSinCambio: mod ? Math.floor((ahora - mod.getTime()) / 86400000) : '',
    };
  });

  // 4) Traducir EANs -> skuId VTEX (en lotes)
  console.log('3) Traduciendo EAN -> SKU VTEX...');
  const eansValidos = [...new Set(filas.map(f => f.ean).filter(Boolean))];
  const eanToSku = {};
  for (let i = 0; i < eansValidos.length; i += 200) {
    const lote = eansValidos.slice(i, i + 200);
    Object.assign(eanToSku, await eansToSkuIds(lote));
  }
  console.log('   ' + Object.keys(eanToSku).length + ' EANs traducidos\n');

  // 5) Precio VTEX por skuId (concurrente)
  console.log('4) Trayendo precios VTEX...');
  const skuIdsUnicos = [...new Set(Object.values(eanToSku).filter(Boolean))];
  const preciosVtex = await mapConcurrency(skuIdsUnicos, vtexPrice, CONCURRENCIA);
  const vtexMap = new Map();
  for (const r of preciosVtex) {
    if (r && r.skuId) vtexMap.set(String(r.skuId), r);
  }
  console.log('   ' + vtexMap.size + ' precios VTEX obtenidos\n');

  // 6) Cruce final
  for (const f of filas) {
    const skuId = eanToSku[f.ean];
    f.skuIdVtex = skuId || '';
    const v = skuId ? vtexMap.get(String(skuId)) : null;
    if (!v) { f.precioVtex = ''; f.estado = 'SIN SKU VTEX'; continue; }
    if (v.sinPrecio) { f.precioVtex = ''; f.estado = 'SIN PRECIO EN VTEX'; continue; }
    if (v.error) { f.precioVtex = ''; f.estado = 'ERROR VTEX'; continue; }
    f.precioVtex = v.precio;
    const dif = Math.round((f.precioJanis - v.precio) * 100) / 100;
    f.diferencia = dif;
    f.estado = Math.abs(dif) <= TOLERANCIA ? 'OK'
             : (dif < 0 ? 'MELI MAS BARATO (riesgo)' : 'MELI MAS CARO');
  }

  // 7) Reportes
  const desfasados = filas.filter(f => f.estado === 'MELI MAS BARATO (riesgo)' || f.estado === 'MELI MAS CARO')
    .sort((a, b) => (a.diferencia || 0) - (b.diferencia || 0));
  const pegados = filas.filter(f => typeof f.diasSinCambio === 'number' && f.diasSinCambio >= DIAS_PEGADO)
    .sort((a, b) => b.diasSinCambio - a.diasSinCambio);

  console.log('========================================');
  console.log('Total SKUs en MELI 0002: ' + filas.length);
  console.log('Desfasados vs VTEX:      ' + desfasados.length);
  console.log('Pegados (+' + DIAS_PEGADO + 'd sin cambio): ' + pegados.length);
  console.log('========================================\n');

  console.log('--- TOP 25 DESFASADOS ---');
  desfasados.slice(0, 25).forEach(f =>
    console.log('EAN ' + f.ean + ' | Janis $' + f.precioJanis + ' | VTEX $' + f.precioVtex + ' | Dif $' + f.diferencia + ' | ' + f.estado + ' | ' + f.nombre.slice(0,35))
  );

  // 8) CSVs
  const header = 'ean,nombre,sku_vtex,hex_janis,precio_janis_meli,precio_vtex,diferencia,estado,status,date_modified,dias_sin_cambio\n';
  const toRow = f => [f.ean, f.nombre, f.skuIdVtex, f.hex, f.precioJanis, f.precioVtex, f.diferencia != null ? f.diferencia : '', f.estado, f.status, f.dateModified, f.diasSinCambio].join(',');

  fs.writeFileSync('meli0002-completo.csv', header + filas.map(toRow).join('\n'));
  fs.writeFileSync('meli0002-desfasados.csv', header + desfasados.map(toRow).join('\n'));
  fs.writeFileSync('meli0002-pegados.csv', header + pegados.map(toRow).join('\n'));
  console.log('\n-> Generados: meli0002-completo.csv / meli0002-desfasados.csv / meli0002-pegados.csv');
}

run().catch(e => { console.error(e); process.exit(1); });
