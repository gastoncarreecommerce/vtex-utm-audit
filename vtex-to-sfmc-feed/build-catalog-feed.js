/**
 * build-catalog-feed.js
 *
 * Arma el catálogo de productos en formato PSV (pipe-separated) que espera
 * Salesforce Marketing Cloud - Einstein Recommendations (Email Recommendations
 * > Admin > Implementación > Carga por lotes).
 *
 * Estrategia (2 pasos, para evitar el límite de 2500 resultados de la Search API clásica):
 *   1) Enumerar TODOS los productId + skuId del catálogo con la Catalog API
 *      (GetProductAndSkuIds), que pagina sin ese límite.
 *   2) Por cada productId, pedir el detalle completo (precio, imagen, marca,
 *      categoría, link) a la Search API clásica filtrando por ese producto
 *      puntual (fq=productId:{id}), así conseguimos todos los campos en una
 *      sola llamada por producto.
 *
 * Columnas de salida (definidas por la muestra descargada desde Marketing Cloud):
 *   SkuID|ProductCode|ProductName|ProductType|ProductLink|ImageLink|RegularPrice|SalePrice|BrandName|Color|ReleaseDate|Keywords
 *
 * Nota: "Color" queda vacío por ahora (se puede sumar después desde specifications).
 * Nota: "Rating"/"NumReviews" se excluyeron del feed (VTEX no tiene reviews nativas).
 *
 * Requiere Node 18+ (usa fetch nativo). Sin dependencias externas.
 */

const fs = require("fs");
const path = require("path");

// ---- Configuración (viene de variables de entorno / GitHub Secrets) ----
const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT; // ej: "carrefourar"
const VTEX_ENVIRONMENT = process.env.VTEX_ENVIRONMENT || "vtexcommercestable.com.br";
const VTEX_APP_KEY = process.env.VTEX_APP_KEY; // requerido: GetProductAndSkuIds es un endpoint privado
const VTEX_APP_TOKEN = process.env.VTEX_APP_TOKEN; // requerido
const SALES_CHANNEL = process.env.VTEX_SALES_CHANNEL || "1";
// Código postal de referencia para calcular el regionId (regionalización de precios/stock).
// Sin esto, VTEX devuelve el precio de un seller genérico que puede no representar ninguna
// tienda real -> precios incorrectos como el que encontramos en la prueba (gaseosa a $46,50).
const REFERENCE_POSTAL_CODE = process.env.VTEX_POSTAL_CODE || "C1426AJS"; // CABA
const REFERENCE_COUNTRY = process.env.VTEX_COUNTRY || "ARG";
const OUTPUT_PATH = process.env.OUTPUT_PATH || path.join(__dirname, "output", "catalog.psv");

// Para probar rápido sin correr sobre todo el catálogo: si seteás esta variable,
// corta después de juntar esta cantidad de productos (no de SKUs).
const MAX_PRODUCTS_FOR_TEST = process.env.FEED_MAX_PRODUCTS ? Number(process.env.FEED_MAX_PRODUCTS) : null;
// Cuántos productos pedir en paralelo al ir a buscar el detalle (para no saturar la API)
const CONCURRENCY = Number(process.env.FEED_CONCURRENCY || 5);
// Pausa entre tandas, en ms, como colchón extra de rate limit
const BATCH_DELAY_MS = Number(process.env.FEED_BATCH_DELAY_MS || 200);

if (!VTEX_ACCOUNT) {
  console.error("Falta la variable de entorno VTEX_ACCOUNT (ej: 'carrefourar').");
  process.exit(1);
}
if (!VTEX_APP_KEY || !VTEX_APP_TOKEN) {
  console.error(
    "Faltan VTEX_APP_KEY y/o VTEX_APP_TOKEN. GetProductAndSkuIds es un endpoint privado y" +
      " necesita un par de credenciales de un usuario de aplicación de VTEX (Admin > Cuenta > Claves de aplicación)."
  );
  process.exit(1);
}

const BASE_URL = `https://${VTEX_ACCOUNT}.${VTEX_ENVIRONMENT}`;

// Headers de autenticación para los endpoints privados (pvt).
// Los endpoints públicos (pub), como la Search API, no los necesitan pero no molesta enviarlos igual.
const AUTH_HEADERS = {
  "X-VTEX-API-AppKey": VTEX_APP_KEY,
  "X-VTEX-API-AppToken": VTEX_APP_TOKEN,
  Accept: "application/json",
};

const HEADER = [
  "SkuID",
  "ProductCode",
  "ProductName",
  "ProductType",
  "ProductLink",
  "ImageLink",
  "BrandName",
  "Color",
  "ReleaseDate",
  "Keywords",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// El pipe (|) es el separador de columna y "~" el separador de multivalor,
// así que hay que sacarlos de cualquier texto libre para no romper el archivo.
function sanitize(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\|/g, "-").replace(/~/g, "-").replace(/[\r\n]+/g, " ").trim();
}

/**
 * Paso 1: trae TODOS los pares productId/skuId del catálogo.
 * Catalog API - GetProductAndSkuIds pagina con _from/_to y no tiene el
 * límite de 2500 de la Search API clásica.
 * OJO: es un endpoint PRIVADO (/pvt/), necesita AppKey/AppToken.
 * Docs: https://developers.vtex.com/docs/api-reference/catalog-api#get-/api/catalog_system/pvt/products/GetProductAndSkuIds
 */
async function getAllProductIds() {
  const productIds = new Set();
  const PAGE_SIZE = 250; // límite real de la API: "Page can have at most 250 registers"
  let from = 0;
  let total = null; // lo sacamos de la respuesta (range.total) para saber cuándo cortar

  while (true) {
    const to = from + PAGE_SIZE - 1;
    const url = `${BASE_URL}/api/catalog_system/pvt/products/GetProductAndSkuIds?_from=${from}&_to=${to}`;
    const res = await fetch(url, { headers: AUTH_HEADERS });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `GetProductAndSkuIds falló (${res.status}) en el rango ${from}-${to}. ` +
          `Revisá que VTEX_APP_KEY/VTEX_APP_TOKEN tengan permiso de lectura sobre Catálogo. Respuesta: ${body.slice(0, 300)}`
      );
    }

    const json = await res.json();
    const pageIds = Object.keys(json.data || {});
    total = json.range && typeof json.range.total === "number" ? json.range.total : total;

    if (pageIds.length === 0) break;

    pageIds.forEach((id) => productIds.add(id));
    console.log(
      `  ...${productIds.size} productos juntados hasta ahora` + (total !== null ? ` (de ${total} totales)` : "")
    );

    // Si estamos en modo de prueba, no hace falta seguir pidiendo más páginas.
    if (MAX_PRODUCTS_FOR_TEST && productIds.size >= MAX_PRODUCTS_FOR_TEST) break;

    from += PAGE_SIZE;
    if (total !== null && from > total) break;
    if (total === null && pageIds.length < PAGE_SIZE) break; // fallback si la API no devuelve "range"

    await sleep(BATCH_DELAY_MS);
  }

  const ids = Array.from(productIds);
  return MAX_PRODUCTS_FOR_TEST ? ids.slice(0, MAX_PRODUCTS_FOR_TEST) : ids;
}

/**
 * Busca el regionId correspondiente a un código postal real. VTEX usa esto para saber
 * qué sellers/depósito atienden esa zona y así devolver el precio y stock correctos
 * (lo mismo que hace la sesión del navegador cuando alguien navega la PWA).
 * Docs: https://developers.vtex.com/docs/guides/get-sellers-by-region-or-address
 */
async function getRegionId(postalCode, country) {
  const url = `${BASE_URL}/api/checkout/pub/regions?country=${country}&postalCode=${encodeURIComponent(postalCode)}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`No se pudo resolver el regionId para ${postalCode} (${res.status})`);
  }

  const sellers = await res.json();

  if (!Array.isArray(sellers) || sellers.length === 0) {
    throw new Error(
      `La API de regiones no devolvió sellers para el código postal ${postalCode}. ` +
        `Probá con otro código postal real dentro de la cobertura de Carrefour.`
    );
  }

  // La respuesta trae la lista de sellers habilitados para esa dirección; tomamos el
  // regionId del primero (todos los sellers de la lista comparten el mismo regionId).
  const regionId = sellers[0].id;
  console.log(`regionId resuelto para ${postalCode}: ${regionId} (${sellers.length} sellers)`);
  return regionId;
}

/**
 * Paso 2: trae el detalle completo de un producto puntual (precio, imagen,
 * marca, categoría, link) vía Search API clásica filtrando por productId.
 * Un producto puede tener varios SKUs (items) -> devolvemos una fila por SKU.
 */
async function getProductDetail(productId) {
  const url = `${BASE_URL}/api/catalog_system/pub/products/search?fq=productId:${productId}&sc=${SALES_CHANNEL}`;
  const res = await fetch(url);

  if (!res.ok) {
    console.warn(`  [aviso] producto ${productId} falló (${res.status}), se omite.`);
    return { rows: [], skipped: 0 };
  }

  const products = await res.json();
  if (!Array.isArray(products) || products.length === 0) return { rows: [], skipped: 0 };

  const rows = [];
  let skipped = 0;

  for (const product of products) {
    const productType = (product.categories && product.categories[0]) || "";
    // VTEX devuelve las categorías como "/Departamento/Categoria/Subcategoria/"
    const categoryName = productType.split("/").filter(Boolean).pop() || "";
    const brandName = product.brand || "";
    const releaseDate = product.releaseDate
      ? new Date(product.releaseDate).toLocaleDateString("en-US")
      : "";
    const keywords = Array.isArray(product.Keywords) ? product.Keywords.join("~") : "";

    for (const item of product.items || []) {
      const skuId = item.itemId;
      const seller = (item.sellers && item.sellers[0]) || {};
      const offer = seller.commertialOffer || {};

      // Sin precio en el feed (decisión: mostrar solo producto+link en el mail,
      // no arriesgar mostrar un precio regionalizado incorrecto). Igual usamos el
      // ListPrice como señal de disponibilidad: si viene en 0, el SKU no tiene
      // oferta activa y no tiene sentido recomendarlo.
      if (!offer.ListPrice || Number(offer.ListPrice) <= 0) {
        skipped += 1;
        continue;
      }

      const imageLink = (item.images && item.images[0] && item.images[0].imageUrl) || "";

      rows.push([
        sanitize(skuId),
        sanitize(product.productId),
        sanitize(item.nameComplete || product.productName),
        sanitize(categoryName),
        sanitize(product.link),
        sanitize(imageLink),
        sanitize(brandName),
        "", // Color: vacío por ahora
        sanitize(releaseDate),
        sanitize(keywords),
      ]);
    }
  }

  return { rows, skipped };
}

/**
 * Trae la lista completa de sellers de la cuenta (Seller Register API). La usamos
 * una sola vez, de forma manual, para identificar cuáles tienen precio fijo nacional
 * (Hogar&Electro + los 3P) y cuáles son tiendas de food con precio regionalizado —
 * esa clasificación no se puede inferir de forma confiable solo por el nombre.
 * Docs: https://developers.vtex.com/docs/api-reference/seller-register-api
 */
async function listAllSellers() {
  const allSellers = [];
  let page = 1;
  let previousPageIds = null;
  const MAX_PAGES = 10; // salvavidas: nunca debería haber más de ~1000 sellers

  while (page <= MAX_PAGES) {
    const url = `${BASE_URL}/api/seller-register/pvt/sellers?page=${page}`;
    const res = await fetch(url, { headers: AUTH_HEADERS });

    if (!res.ok) {
      throw new Error(`No se pudo traer la lista de sellers (${res.status}) en la página ${page}`);
    }

    const data = await res.json();
    const pageItems = Array.isArray(data) ? data : data.items || [];

    if (pageItems.length === 0) break;

    // Si esta página trae exactamente los mismos ids que la anterior, es que el
    // parámetro "page" no lo soporta esta API y nos está devolviendo lo mismo
    // en loop. Cortamos acá para no generar un log infinito.
    const currentPageIds = pageItems.map((s) => s.id ?? s.sellerId).join(",");
    if (currentPageIds === previousPageIds) {
      console.log(
        `  [aviso] La página ${page} es idéntica a la anterior. Esta API no pagina con ` +
          `"page" en esta cuenta — los ${allSellers.length} sellers ya juntados son la lista completa.`
      );
      break;
    }
    previousPageIds = currentPageIds;

    allSellers.push(...pageItems);
    console.log(`  ...página ${page}: ${pageItems.length} sellers (${allSellers.length} acumulados)`);

    if (pageItems.length < 100) break;

    page += 1;
    await sleep(BATCH_DELAY_MS);
  }

  if (page > MAX_PAGES) {
    console.log(`  [aviso] Se llegó al límite de ${MAX_PAGES} páginas por seguridad. Revisar manualmente.`);
  }

  console.log(`\n=== ${allSellers.length} sellers encontrados en total ===`);
  allSellers.forEach((s) => {
    console.log(`  id: ${s.id ?? s.sellerId}  |  name: ${s.name}`);
  });
  console.log("=== fin de la lista ===\n");

  return allSellers;
}

/**
 * En vez de depender del endpoint administrativo de sellers (que no pudimos paginar
 * de forma confiable), recorremos el catálogo real y juntamos los sellers que
 * efectivamente aparecen vendiendo productos. Es más confiable: son los sellers
 * activos de verdad, no una lista administrativa que puede incluir dados de baja.
 */
async function collectSellersFromCatalog(productIds, regionId) {
  const sellersSeen = new Map(); // id -> { name, exampleProduct }

  for (let i = 0; i < productIds.length; i += CONCURRENCY) {
    const batch = productIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (productId) => {
        const url = `${BASE_URL}/api/catalog_system/pub/products/search?fq=productId:${productId}&sc=${SALES_CHANNEL}&regionId=${regionId}`;
        const res = await fetch(url);
        if (!res.ok) return [];
        const products = await res.json();
        if (!Array.isArray(products)) return [];

        const found = [];
        for (const product of products) {
          for (const item of product.items || []) {
            const seller = (item.sellers && item.sellers[0]) || {};
            if (seller.sellerId) {
              found.push({
                id: seller.sellerId,
                name: seller.sellerName || "(sin nombre)",
                example: item.nameComplete || product.productName || "",
              });
            }
          }
        }
        return found;
      })
    );

    results.flat().forEach((s) => {
      if (!sellersSeen.has(s.id)) {
        sellersSeen.set(s.id, { name: s.name, example: s.example });
      }
    });

    if (i % (CONCURRENCY * 4) === 0 || i + CONCURRENCY >= productIds.length) {
      console.log(
        `  ...${Math.min(i + CONCURRENCY, productIds.length)}/${productIds.length} productos revisados ` +
          `(${sellersSeen.size} sellers distintos hasta ahora)`
      );
    }
    await sleep(BATCH_DELAY_MS);
  }

  console.log(`\n=== ${sellersSeen.size} sellers distintos encontrados en el catálogo ===`);
  Array.from(sellersSeen.entries())
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .forEach(([id, info]) => {
      console.log(`  id: ${id}  |  name: ${info.name}  |  ej: ${info.example}`);
    });
  console.log("=== fin de la lista ===\n");

  return sellersSeen;
}

async function main() {
  // Modo especial: si seteás LIST_SELLERS_ONLY=true, el script recorre el catálogo
  // (o el subconjunto de FEED_MAX_PRODUCTS) y solo imprime los sellers distintos que
  // encuentra vendiendo productos, sin generar el archivo final.
  if (process.env.LIST_SELLERS_ONLY === "true") {
    console.log(`Buscando IDs de productos en ${VTEX_ACCOUNT}...`);
    const productIds = await getAllProductIds();
    const regionId = await getRegionId(REFERENCE_POSTAL_CODE, REFERENCE_COUNTRY);
    await collectSellersFromCatalog(productIds, regionId);
    return;
  }


  console.log(`Buscando IDs de productos en ${VTEX_ACCOUNT}...`);
  const productIds = await getAllProductIds();
  console.log(`Encontrados ${productIds.length} productos. Buscando detalle...`);

  const allRows = [];
  let totalSkipped = 0;

  for (let i = 0; i < productIds.length; i += CONCURRENCY) {
    const batch = productIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((id) => getProductDetail(id)));
    results.forEach(({ rows, skipped }) => {
      allRows.push(...rows);
      totalSkipped += skipped;
    });

    if (i % (CONCURRENCY * 4) === 0 || i + CONCURRENCY >= productIds.length) {
      console.log(`  ...${Math.min(i + CONCURRENCY, productIds.length)}/${productIds.length} productos procesados`);
    }
    await sleep(BATCH_DELAY_MS);
  }

  const lines = [HEADER.join("|"), ...allRows.map((row) => row.join("|"))];

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, lines.join("\n"), "utf8");

  console.log(`Listo. ${allRows.length} SKUs escritos en ${OUTPUT_PATH}`);
  console.log(`(${totalSkipped} SKUs sin stock/oferta activa fueron excluidos del feed)`);
}

main().catch((err) => {
  console.error("Error armando el feed:", err);
  process.exit(1);
});
