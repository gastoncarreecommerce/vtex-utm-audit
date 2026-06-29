/**
 * lib/order-attribution.js — Cruce EN VIVO entre un DNI de Atenti y los pedidos
 * VTEX, para ver si una sugerencia del chat se tradujo en una compra real.
 *
 * Consulta la API de VTEX directo (mismas credenciales que fetch-orders.js) en
 * cada request — el documento/DNI NUNCA se persiste a disco ni a docs/data/
 * (esos archivos son públicos vía GitHub Pages/Vercel). Mismo principio que
 * lib/atenti-source.js: todo vive en memoria del request y se descarta al
 * responder.
 */
const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT || "carrefourar";
const VTEX_KEY      = process.env.VTEX_APP_KEY;
const VTEX_TOKEN    = process.env.VTEX_APP_TOKEN;

const vtexHeaders = {
  "X-VTEX-API-AppKey":   VTEX_KEY,
  "X-VTEX-API-AppToken": VTEX_TOKEN,
  "Accept":              "application/json"
};

function getCustomAppFrom(order) {
  for (const app of order?.customData?.customApps || []) {
    if (app?.fields?.from !== undefined) return String(app.fields.from).trim();
  }
  return "";
}

const DIACRITICS_RE = new RegExp("[\\u0300-\\u036f]", "g");

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(DIACRITICS_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

// No hay EAN/SKU en común entre los logs de Atenti y los items de VTEX, así que
// el único cruce posible es por nombre de producto (match exacto o de substring).
function matchSuggestedItems(cartItems, orderItems) {
  const matched = [];
  for (const ci of cartItems) {
    const n = normName(ci.nombre);
    if (!n) continue;
    const hit = orderItems.find(oi => {
      const on = normName(oi.name);
      return on && (on === n || on.includes(n) || n.includes(on));
    });
    if (hit) matched.push({ sugerido: ci.nombre, comprado: hit.name, cantidad_comprada: hit.quantity });
  }
  return matched;
}

/**
 * Busca, en una ventana de `days` días desde `date` (inclusive), un pedido de
 * la app cuyo `clientProfileData.document` coincida con `document`. Si lo
 * encuentra, devuelve qué items del carrito sugerido por Atenti aparecen en
 * ese pedido. Devuelve null si no hay pedido; lanza si VTEX no responde.
 */
export async function findAttributedOrder(document, date, cartItems, days = 7) {
  if (!VTEX_KEY || !VTEX_TOKEN) throw new Error("Faltan credenciales VTEX en las env vars de Vercel");

  const from = `${date}T00:00:00.000Z`;
  const toDate = new Date(`${date}T00:00:00.000Z`);
  toDate.setUTCDate(toDate.getUTCDate() + days);
  const to = `${toDate.toISOString().slice(0, 10)}T23:59:59.999Z`;

  const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/oms/pvt/orders`
    + `?q=${encodeURIComponent(document)}`
    + `&f_creationDate=creationDate%3A%5B${from}%20TO%20${to}%5D`
    + `&per_page=50&page=1`;

  const listRes = await fetch(url, { headers: vtexHeaders });
  if (!listRes.ok) throw new Error(`VTEX list ${listRes.status}`);
  const list = await listRes.json();

  for (const o of (list?.list || [])) {
    const detailRes = await fetch(
      `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/oms/pvt/orders/${o.orderId}`,
      { headers: vtexHeaders }
    );
    if (!detailRes.ok) continue;
    const detail = await detailRes.json();
    if (String(detail.clientProfileData?.document || "") !== String(document)) continue;
    if (getCustomAppFrom(detail) !== "app") continue;

    const items = detail.items || [];
    return {
      pedido: {
        order_id: detail.orderId,
        fecha:    detail.creationDate,
        total:    typeof detail.value === "number" ? Math.round(detail.value / 100) : 0
      },
      productos_sugeridos_comprados: matchSuggestedItems(cartItems, items)
    };
  }
  return null;
}

// Pool de concurrencia fija para no disparar cientos de requests a VTEX a la vez.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Estadística agregada: de TODOS los DNIs que metieron al carrito un producto
 * sugerido por Atenti en `date`, ¿cuántos terminaron comprando (en la app, en
 * los `days` días siguientes) un pedido que incluya al menos uno de esos
 * productos? Solo devuelve conteos — ningún DNI individual sale de esta
 * función, para no exponer PII ni siquiera de forma agregada por usuario.
 */
export async function getAttributionStats(cartAddsByDni, date, days = 7) {
  const dnis = [...cartAddsByDni.keys()];
  const stats = { usuarios_con_sugerencia: dnis.length, compraron: 0, compraron_con_sugerido: 0, errores: 0 };
  if (!dnis.length) return stats;

  // Un error de VTEX (rate-limit, timeout, etc.) NO es lo mismo que "no compró":
  // si se confunden, una falla sistémica se ve idéntica a 0% de conversión real.
  const results = await mapLimit(dnis, 5, async dni => {
    try {
      return { ok: true, order: await findAttributedOrder(dni, date, cartAddsByDni.get(dni), days) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  for (const r of results) {
    if (!r.ok) { stats.errores++; continue; }
    if (!r.order) continue;
    stats.compraron++;
    if (r.order.productos_sugeridos_comprados.length) stats.compraron_con_sugerido++;
  }
  return stats;
}
