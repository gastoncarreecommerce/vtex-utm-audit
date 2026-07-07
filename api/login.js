/**
 * api/login.js — Valida credenciales contra DASHBOARD_PASSWORD (env var de Vercel).
 * POST { username, password } → { token, user } | 401
 *
 * El token es HMAC-SHA256 firmado con SESSION_SECRET, expira en 12hs.
 * Nunca viaja la contraseña real al browser.
 */
import { createHmac } from "crypto";

const PASSWORD = process.env.DASHBOARD_PASSWORD;
const SECRET   = process.env.SESSION_SECRET;

function makeToken(username) {
  const expiry  = Date.now() + 12 * 3600 * 1000;
  const payload = `${username}:${expiry}`;
  const sig     = createHmac("sha256", SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

function buildUser(username) {
  const parts  = username.replace(/_/g, " ").split(" ");
  const name   = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
  const avatar = parts.map(p => p.charAt(0).toUpperCase()).join("").slice(0, 2);
  return { username, name, avatar };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (!PASSWORD || !SECRET)  return res.status(500).json({ error: "Auth no configurado en Vercel env vars" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { username, password } = body || {};

  if (!username || !username.trim() || password !== PASSWORD) {
    return res.status(401).json({ error: "Credenciales incorrectas" });
  }

  const user = buildUser(username.trim().toLowerCase());
  res.json({ token: makeToken(user.username), user });
}
