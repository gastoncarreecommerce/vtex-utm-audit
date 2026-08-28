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
  "RegularPrice",
  "SalePrice",
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
 * Paso 2: trae el detalle completo de un producto puntual (precio, imagen,
 * marca, categoría, link) vía Search API clásica filtrando por productId.
 * Un producto puede tener varios SKUs (items) -> devolvemos una fila por SKU.
 */
async function getProductDetail(productId) {
  const url = `${BASE_URL}/api/catalog_system/pub/products/search?fq=productId:${productId}&sc=${SALES_CHANNEL}`;
  const res = await fetch(url);

  if (!res.ok) {
    console.warn(`  [aviso] producto ${productId} falló (${res.status}), se omite.`);
    return [];
  }

  const products = await res.json();
  if (!Array.isArray(products) || products.length === 0) return [];

  const rows = [];

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
      const listPrice = offer.ListPrice ?? "";
      const price = offer.Price ?? "";
      // Si no hay descuento activo, dejamos SalePrice vacío en vez de repetir el precio.
      const salePrice = price && listPrice && price < listPrice ? price : "";
      const imageLink = (item.images && item.images[0] && item.images[0].imageUrl) || "";

      rows.push([
        sanitize(skuId),
        sanitize(product.productId),
        sanitize(item.nameComplete || product.productName),
        sanitize(categoryName),
        sanitize(product.link),
        sanitize(imageLink),
        sanitize(listPrice),
        sanitize(salePrice),
        sanitize(brandName),
        "", // Color: vacío por ahora
        sanitize(releaseDate),
        sanitize(keywords),
      ]);
    }
  }

  return rows;
}

async function main() {
  console.log(`Buscando IDs de productos en ${VTEX_ACCOUNT}...`);
  const productIds = await getAllProductIds();
  console.log(`Encontrados ${productIds.length} productos. Buscando detalle...`);

  const allRows = [];

  for (let i = 0; i < productIds.length; i += CONCURRENCY) {
    const batch = productIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((id) => getProductDetail(id)));
    results.forEach((rows) => allRows.push(...rows));

    if (i % (CONCURRENCY * 4) === 0 || i + CONCURRENCY >= productIds.length) {
      console.log(`  ...${Math.min(i + CONCURRENCY, productIds.length)}/${productIds.length} productos procesados`);
    }
    await sleep(BATCH_DELAY_MS);
  }

  const lines = [HEADER.join("|"), ...allRows.map((row) => row.join("|"))];

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, lines.join("\n"), "utf8");

  console.log(`Listo. ${allRows.length} SKUs escritos en ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Error armando el feed:", err);
  process.exit(1);
});
