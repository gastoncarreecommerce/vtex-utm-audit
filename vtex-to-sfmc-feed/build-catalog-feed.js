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
      "
