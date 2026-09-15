/**
 * api/private-data.js — Sirve los datos con PII desde el repo PRIVADO.
 *
 * GET /api/private-data?date=YYYY-MM-DD  →  el array de filas de ese día
 *
 * Los `daily/<fecha>-rows.json` traen el email del cliente, así que no pueden
 * vivir en el repo público ni servirse como archivo estático (Vercel publica
 * todo `docs/` sin credenciales). Viven en gastoncarreecommerce/appdash-private-data
 * y salen por acá, detrás de la sesión.
 *
 * El token de GitHub se lee de env vars y nunca llega al browser.
 */
import { exigirSesion } from "./_auth.js";

const REPO  = process.env.PRIVATE_DATA_REPO || "gastoncarreecommerce/appdash-private-data";
const TOKEN = process.env.PRIVATE_DATA_TOKEN;
const RAMA  = process.env.PRIVATE_DATA_REF  || "main";

export default async function handler(req, res) {
  // 1) Sesión primero: sin esto el endpoint sería tan público como el archivo
  //    estático que vino a reemplazar.
  if (!exigirSesion(req, res)) return;

  if (!TOKEN) {
    return res.status(500).json({ error: "PRIVATE_DATA_TOKEN no configurado en Vercel env vars" });
  }

  // 2) La fecha se valida con regex estricto y se usa sólo para armar el nombre
  //    del archivo. Sin esto, un `date` como "../../.." armaría una ruta a
  //    cualquier archivo del repo privado.
  const date = String(req.query.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Parámetro date inválido, se espera YYYY-MM-DD" });
  }

  const url = `https://api.github.com/repos/${REPO}/contents/daily/${date}-rows.json?ref=${encodeURIComponent(RAMA)}`;

  let r;
  try {
    r = await fetch(url, {
      headers: {
        // `raw` evita que GitHub devuelva el JSON en base64 dentro de otro JSON:
        // estos archivos pesan hasta 4MB y el base64 los infla un 33%.
        Accept: "application/vnd.github.raw",
        Authorization: `Bearer ${TOKEN}`,
        "User-Agent": "appdash",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (e) {
    return res.status(502).json({ error: `No se pudo contactar GitHub: ${e.message}` });
  }

  // 404 = ese día no tiene archivo de filas. Es normal (día sin backfill), no un
  // error: el cliente ya sabe tratar la lista vacía como "sin detalle".
  if (r.status === 404) {
    res.setHeader("Cache-Control", "private, max-age=60");
    return res.json([]);
  }

  if (!r.ok) {
    // El cuerpo del error de GitHub puede nombrar el repo privado; no se reenvía.
    const detalle = r.status === 401 || r.status === 403
      ? "PRIVATE_DATA_TOKEN inválido o sin permiso de lectura sobre el repo privado"
      : `GitHub respondió ${r.status}`;
    return res.status(502).json({ error: detalle });
  }

  let filas;
  try { filas = JSON.parse(await r.text()); }
  catch { return res.status(502).json({ error: "El archivo del repo privado no es JSON válido" }); }

  if (!Array.isArray(filas)) {
    return res.status(502).json({ error: "Se esperaba un array de filas" });
  }

  // `private` para que no quede en una CDN compartida. Los días cerrados no
  // cambian, así que el browser puede guardarlos un rato.
  const esHoy = date === new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  res.setHeader("Cache-Control", esHoy ? "private, max-age=60" : "private, max-age=3600");
  res.json(filas);
}
