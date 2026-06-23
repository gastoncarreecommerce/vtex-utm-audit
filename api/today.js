/**
 * api/today.js — Vercel serverless proxy para datos VTEX en vivo.
 * Credenciales se leen de las env vars de Vercel (nunca expuestas al browser).
 *
 * GET /api/today?date=YYYY-MM-DD[&since=ISO]   (default date: hoy en hora Argentina)
 * Responde: { summary: {...}, rows: [...], window_to, fetched_at }
 *
 * Sin `since`: consulta el día completo desde medianoche hasta ahora.
 * Con `since`: consulta solo la VENTANA [since, ahora] — `summary`/`rows` son
 * SOLO de esa ventana, no acumulados. El servidor nunca cachea ni guarda nada;
 * la acumulación de pedidos ya vistos vive en memoria del browser (ver fetchTodayLive
 * en docs/app.html), que también recalcula el resumen completo desde cero en cada
 * tick para no repetir el bug de mergear porcentajes ya calculados.
 */

const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT || "carrefourar";
const VTEX_KEY     = process.env.VTEX_APP_KEY;
const VTEX_TOKEN   = process.env.VTEX_APP_TOKEN;

const MARKETPLACE_SELLERS = new Set([
  "abaco284","aircomputers546","americanwood705","anubisdecoracion261","Autodo",
  "awaresolutions923","awaresolutionssrl189","bangho","beautysas","Bebitos",
  "bigstarsar","blackmusic902","brogas700","buhl040","bulonfer","bydsudamericana031",
  "calefactorescalden943","calm328","carrelloar624","clubdigital656","codini088",
  "colchonesysommier288","CRF","ctcgroup940","ctcproductos740","dehuka404","demelf394",
  "derpacomar064","dielfe771","districolor768","districolor804","donacero930","dvigi943",
  "eczanepharma170","electroluxar","emcmuebles005","emoodmarket","enasport189",
  "estelar454","exosa541","ferreydeco793","gasei472","grupomarquez012","haustore986",
  "hidrolit736","hispanos470","hogarisnova327","homekong441","intecnova657",
  "internationalhomesa717","kamadoargentino563","kiluga771","kitsolar316",
  "laplanchetta301","lilasense516","limansky653","lumina946","luxom345","magazzinoar",
  "mantra171","mgsolucionsa519","microbell122","mueblesespeciales315","mundopino165",
  "neba791","neoseg957","ohgiftcard537","ortopedialibertad288","outin691",
  "pampadeacero948","phidigital143","pinataar","pinataarCRF","potenzaemarketsa179",
  "praga278","prestigio1","Producteca225119","Producteca232302","Producteca232621",
  "Producteca237680","Producteca238451","Producteca238567","Producteca238818",
  "Producteca239254","Producteca241872","Producteca241968","Producteca242766",
  "Producteca246251","Producteca246437","Producteca246519","Producteca246643",
  "Producteca247492","Producteca247683","Producteca249023","Producteca249357",
  "Producteca249773","Producteca251086","Producteca251428","Producteca252062",
  "Producteca70438","puntodeportivoar","rockinroll106","rua839","sccortinasrollers240",
  "sharecomputacion867","shopwide119","soportar561","springwall441","sungreensrl102",
  "tecnofull391","tenacta582","tiendasdigitalesar","todotodo061","topmega421",
  "turboblender168","tutiendaonline271","unitecsa564","universopinturerias","Vexi",
  "vexistore751","vexistorear","vinson363","vmpsa473","whirlpoolarg","wolke303",
  "wsabiskin470","xcientoargentino189"
]);

function categorize(order) {
  if (String(order.salesChannel || "") === "3") return "quickcommerce";
  const sellers = new Set((order.items || []).map(i => i.seller).filter(Boolean));
  for (const s of sellers) if (MARKETPLACE_SELLERS.has(s)) return "marketplace";
  if (sellers.has("carrefourar0899")) return "non_food";
  return "food";
}

function getAppFrom(order) {
  for (const app of order?.customData?.customApps || []) {
    if (app?.fields?.from !== undefined) return String(app.fields.from).trim();
  }
  return "";
}

function todayAR() {
  return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
}

function formatFechaAR(iso) {
  const d = new Date(new Date(iso).getTime() - 3 * 60 * 60 * 1000);
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCDate()}/${d.getUTCMonth()+1}/${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function emptyWindowSummary(date) {
  return {
    date, total_ecomm_orders: 0, total_ecomm_gmv: 0,
    app: {
      total: 0, gmv: 0, con_utm: 0, sin_utm: 0,
      segments: {
        food:          { orders: 0, gmv: 0 },
        non_food:      { orders: 0, gmv: 0 },
        marketplace:   { orders: 0, gmv: 0 },
        quickcommerce: { orders: 0, gmv: 0 }
      }
    }
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Timeout corto por request — si VTEX se cuelga en una sola llamada no queremos
// que eso bloquee un worker entero del pool y arrastre todo el fetch.
async function vtexFetch(url, retries = 5, timeoutMs = 12000) {
  for (let i = 0; i < retries; i++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { "X-VTEX-API-AppKey": VTEX_KEY, "X-VTEX-API-AppToken": VTEX_TOKEN },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      if (i < retries - 1) await sleep(300 * Math.pow(1.8, i));
      continue;
    }
    if (res.ok) return res.json();
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw new Error(`VTEX ${res.status}`);
    }
    if (i < retries - 1) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 300 * Math.pow(1.8, i));
    }
  }
  throw new Error("VTEX fetch failed after retries");
}

// Pool de concurrencia fija — evita disparar miles de requests a la vez (rate limit)
// pero mantiene siempre `limit` requests en vuelo para terminar lo antes posible.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await fn(items[i], i); }
      catch { results[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export default async function handler(req, res) {
  if (!VTEX_KEY || !VTEX_TOKEN) {
    return res.status(500).json({ error: "VTEX credentials not configured in Vercel env vars" });
  }

  const date      = (req.query.date || todayAR()).slice(0, 10);
  const dayStartMs = new Date(`${date}T03:00:00.000Z`).getTime();
  const dayEndMs    = dayStartMs + 86400000 - 1;

  // `since` permite traer solo la VENTANA de pedidos nuevos desde el último fetch
  // exitoso del browser (que acumula los pedidos crudos en memoria, nunca en disco).
  // El total y los agregados de esta respuesta son SOLO de esta ventana — el cliente
  // los suma a lo que ya tiene y recalcula el resumen completo desde cero, nunca
  // mergea porcentajes ya calculados (esa mezcla fue la causa del bug de >100%).
  let fromMs = dayStartMs;
  const sinceMs = req.query.since ? new Date(req.query.since).getTime() : NaN;
  if (!isNaN(sinceMs)) fromMs = Math.max(fromMs, sinceMs + 1);
  const toMs = Math.min(dayEndMs, Date.now());

  if (toMs < fromMs) {
    // Ya pedimos todo lo que existe hasta ahora — nada nuevo en esta ventana.
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      summary: emptyWindowSummary(date),
      rows: [],
      window_to: new Date(fromMs - 1).toISOString(),
      fetched_at: new Date().toISOString()
    });
  }

  const fromDT   = new Date(fromMs).toISOString();
  const toDT     = new Date(toMs).toISOString();
  const filter   = `creationDate:[${fromDT} TO ${toDT}]`;
  const base     = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br`;
  const listUrl  = page => `${base}/api/oms/pvt/orders?f_creationDate=${encodeURIComponent(filter)}&orderBy=creationDate,desc&page=${page}&per_page=100`;

  // 1) Página 1 → conocer el total y cuántas páginas más faltan
  let firstPage;
  try { firstPage = await vtexFetch(listUrl(1)); }
  catch (e) { return res.status(502).json({ error: `VTEX list error: ${e.message}` }); }

  const total      = firstPage?.paging?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / 100));
  const ids        = (firstPage?.list || []).map(o => o.orderId).filter(Boolean);

  const detailUrl = id => `${base}/api/oms/pvt/orders/${id}`;

  // 2) Resto de páginas de listado y detalle de la página 1 en PARALELO entre sí —
  // no hay motivo para esperar a tener todos los ids antes de empezar a pedir detalle.
  const restPages = totalPages > 1 ? Array.from({ length: totalPages - 1 }, (_, i) => i + 2) : [];
  const [restLists, firstDetails] = await Promise.all([
    mapLimit(restPages, 10, p => vtexFetch(listUrl(p))),
    mapLimit(ids, 70, id => vtexFetch(detailUrl(id)))
  ]);

  const restIds = [];
  for (const data of restLists) {
    if (data?.list) restIds.push(...data.list.map(o => o.orderId).filter(Boolean));
  }

  // 3) Detalle del resto de páginas (concurrencia alta — es lo que determina el tiempo total)
  const restDetails = await mapLimit(restIds, 70, id => vtexFetch(detailUrl(id)));
  const details = [...firstDetails, ...restDetails];

  const result = {
    date,
    total_ecomm_orders: total,
    total_ecomm_gmv:    0,
    app: {
      total: 0, gmv: 0, con_utm: 0, sin_utm: 0,
      segments: {
        food:          { orders: 0, gmv: 0 },
        non_food:      { orders: 0, gmv: 0 },
        marketplace:   { orders: 0, gmv: 0 },
        quickcommerce: { orders: 0, gmv: 0 }
      }
    }
  };
  const rows = [];
  const seen = new Set();

  for (const d of details) {
    if (!d?.orderId || getAppFrom(d) !== "app" || seen.has(d.orderId)) continue;
    seen.add(d.orderId);
    const seg = categorize(d);
    const gmv = typeof d.value === "number" ? d.value / 100 : 0;
    const utm = d.marketingData?.utmSource || "";
    result.app.total++;
    result.app.gmv += gmv;
    utm ? result.app.con_utm++ : result.app.sin_utm++;
    result.app.segments[seg].orders++;
    result.app.segments[seg].gmv += gmv;
    rows.push({
      order_id:     d.orderId,
      fecha:        formatFechaAR(d.creationDate),
      estado:       d.status || "",
      total:        Math.round(gmv),
      utm_source:   utm,
      utm_medium:   d.marketingData?.utmMedium   || "",
      utm_campaign: d.marketingData?.utmCampaign || "",
      coupon:       d.marketingData?.coupon      || "",
      segment:      seg,
      email:        d.clientProfileData?.email   || "",
      utm_status:   utm ? "CON UTM" : "SIN UTM",
      items: (d.items || []).map(i => ({
        id: i.id, name: i.name, sku: i.refId || i.id,
        qty: i.quantity, price: (i.price || 0) / 100, seller: i.seller
      }))
    });
  }

  // Cerrar totales
  result.app.gmv = Math.round(result.app.gmv);
  ["food","non_food","marketplace","quickcommerce"].forEach(s => {
    result.app.segments[s].gmv = Math.round(result.app.segments[s].gmv);
  });
  result.total_ecomm_orders = Math.max(result.total_ecomm_orders, result.app.total);
  result.participation_pct = result.total_ecomm_orders > 0
    ? Math.min(100, Math.round(result.app.total / result.total_ecomm_orders * 1000) / 10) : 0;
  result.utm_pct_sin = result.app.total > 0
    ? Math.round(result.app.sin_utm / result.app.total * 1000) / 10 : 0;

  res.setHeader("Cache-Control", "no-store");
  res.json({ summary: result, rows, window_to: toDT, fetched_at: new Date().toISOString() });
}
