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

const USERS = [
  { username: "gaston",   name: "Gastón Ruiz",   avatar: "GR" },
  { username: "daiana",   name: "Daiana Molina",  avatar: "DM" },
  { username: "berenice", name: "Berenice Fraga", avatar: "BF" },
  { username: "samuel",   name: "Samuel Moreira", avatar: "SM" },
  { username: "leonardo", name: "Leonardo Arcas", avatar: "LA" },
  { username: "mariano",  name: "Mariano Wegier", avatar: "MW" },
];

function makeToken(username) {
  const expiry  = Date.now() + 12 * 3600 * 1000;
  const payload = `${username}:${expiry}`;
  const sig     = createHmac("sha256", SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (!PASSWORD || !SECRET)  return res.status(500).json({ error: "Auth no configurado en Vercel env vars" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { username, password } = body || {};
  const user = USERS.find(u => u.username === username);

  if (!user || password !== PASSWORD) {
    return res.status(401).json({ error: "Credenciales incorrectas" });
  }

  res.json({
    token: makeToken(username),
    user:  { username: user.username, name: user.name, avatar: user.avatar }
  });
}
