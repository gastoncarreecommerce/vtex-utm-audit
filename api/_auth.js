/**
 * api/_auth.js — Verificación de sesión compartida por los endpoints que
 * devuelven datos con PII.
 *
 * El token lo emite api/login.js: base64url("<usuario>:<expiry>:<hmac>"), firmado
 * con SESSION_SECRET. Viaja en la cookie HttpOnly `appdash_session`, que el
 * browser manda sola en cada fetch al mismo origen — por eso sirve para proteger
 * endpoints, a diferencia del token en localStorage, que el JS tiene que adjuntar
 * a mano y no viaja en los fetch de archivos estáticos.
 *
 * Se acepta además el header `Authorization: Bearer <token>` para los clientes
 * que ya guardaban el token en localStorage y para poder probar con curl.
 */
import { createHmac, timingSafeEqual } from "crypto";

const SECRET = process.env.SESSION_SECRET;

function leerCookie(req, nombre) {
  const raw = req.headers?.cookie || "";
  for (const parte of raw.split(";")) {
    const i = parte.indexOf("=");
    if (i === -1) continue;
    if (parte.slice(0, i).trim() === nombre) return parte.slice(i + 1).trim();
  }
  return "";
}

/**
 * Devuelve el usuario si el token es válido, o null.
 * Compara la firma con timingSafeEqual para no filtrar información por tiempos.
 */
export function verificarToken(token) {
  if (!token || !SECRET) return null;

  let plano;
  try { plano = Buffer.from(token, "base64url").toString("utf8"); }
  catch { return null; }

  // El usuario puede contener ":"? No: login.js sólo emite usuarios de una lista
  // fija sin ":". Aun así partimos desde la derecha para no depender de eso.
  const partes = plano.split(":");
  if (partes.length < 3) return null;
  const sig      = partes.pop();
  const expiry   = partes.pop();
  const username = partes.join(":");

  const esperado = createHmac("sha256", SECRET).update(`${username}:${expiry}`).digest("hex");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(esperado, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const ms = Number(expiry);
  if (!Number.isFinite(ms) || Date.now() > ms) return null;

  return username;
}

/**
 * Guard para usar al principio de un handler:
 *
 *   const user = exigirSesion(req, res);
 *   if (!user) return;            // exigirSesion ya respondió 401/500
 *
 * Devuelve el usuario, o null habiendo ya escrito la respuesta de error.
 */
export function exigirSesion(req, res) {
  if (!SECRET) {
    res.status(500).json({ error: "SESSION_SECRET no configurado en Vercel env vars" });
    return null;
  }

  const bearer = (req.headers?.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const user   = verificarToken(leerCookie(req, "appdash_session")) || verificarToken(bearer);

  if (!user) {
    res.setHeader("Cache-Control", "no-store");
    res.status(401).json({ error: "Sesión inválida o vencida. Volvé a iniciar sesión." });
    return null;
  }
  return user;
}
