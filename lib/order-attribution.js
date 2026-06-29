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
