/**
 * api/today.js — Vercel serverless proxy para datos VTEX en vivo.
 * Credenciales se leen de las env vars de Vercel (nunca expuestas al browser).
 *
 * GET /api/today?date=YYYY-MM-DD   (default: hoy en hora Argentina)
 * Responde: { summary: {...}, rows: [...] }
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function vtexFetch(url, retries = 5) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, {
      headers: { "X-VTEX-API-AppKey": VTEX_KEY, "X-VTEX-API-AppToken": VTEX_TOKEN }
    });
    if (res.ok) return res.json();
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw new Error(`VTEX ${res.status}`);
    }
    if (i < retries - 1) await sleep(1000 * Math.pow(2, i));
  }
  throw new Error("VTEX fetch failed after retries");
}

export default async function handler(req, res) {
  if (!VTEX_KEY || !VTEX_TOKEN) {
    return res.status(500).json({ error: "VTEX credentials not configured in Vercel env vars" });
  }

  const date    = (req.query.date || todayAR()).slice(0, 10);
  const fromDT  = `${date}T03:00:00.000Z`;
  const toDT    = new Date(new Date(fromDT).getTime() + 86400000 - 1).toISOString();
  const filter  = `creationDate:[${fromDT} TO ${toDT}]`;
  const base    = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br`;

  const result = {
    date,
    total_ecomm_orders: 0,
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

  let page = 1, totalPages = null;

  while (true) {
    try {
      const url  = `${base}/api/oms/pvt/orders?f_creationDate=${encodeURIComponent(filter)}&orderBy=creationDate,desc&page=${page}&per_page=100`;
      const data = await vtexFetch(url);
      if (!data?.list) break;

      if (totalPages === null) {
        result.total_ecomm_orders = data.paging?.total || 0;
        totalPages = Math.max(1, Math.ceil(result.total_ecomm_orders / 100));
      }

      const ids = data.list.map(o => o.orderId).filter(Boolean);

      // Detalles en paralelo en bloques de 20
      for (let i = 0; i < ids.length; i += 20) {
        const batch   = ids.slice(i, i + 20);
        const details = await Promise.all(
          batch.map(id => vtexFetch(`${base}/api/oms/pvt/orders/${id}`).catch(() => null))
        );
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
      }

      if (page >= totalPages) break;
      page++;
    } catch {
      break;
    }
  }

  // Cerrar totales
  result.app.gmv = Math.round(result.app.gmv);
  ["food","non_food","marketplace","quickcommerce"].forEach(s => {
    result.app.segments[s].gmv = Math.round(result.app.segments[s].gmv);
  });
  result.participation_pct = result.total_ecomm_orders > 0
    ? Math.round(result.app.total / result.total_ecomm_orders * 1000) / 10 : 0;
  result.utm_pct_sin = result.app.total > 0
    ? Math.round(result.app.sin_utm / result.app.total * 1000) / 10 : 0;

  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  res.json({ summary: result, rows });
}
