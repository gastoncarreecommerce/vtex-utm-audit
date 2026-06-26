/**
 * api/atenti-search.js — Búsqueda EN VIVO de clientes que usaron Atenti.
 * Re-lee y re-parsea el mail de Gmail de la fecha pedida en cada request.
 * NUNCA escribe nada a disco ni a docs/data/ — el resultado (DNI, email,
 * conversación, ranking) vive solo en memoria de esta función y se descarta
 * al responder. Requiere sesión válida del dashboard (mismo token de /api/login).
 *
 * GET /api/atenti-search?date=YYYY-MM-DD                → ranking de uso ese día
 * GET /api/atenti-search?date=YYYY-MM-DD&dni=12345678   → perfil + conversación
 * GET /api/atenti-search?format=csv&from=...&to=...     → CSV (1 columna, sin header)
 *                                                          de DNIs que usaron Atenti
 *                                                          en el rango (máx 31 días)
 */
import { createHmac, timingSafeEqual } from "crypto";
import { fetchLogsForDate, getLoginMap, getRanking, getConversation, getChatParticipants } from "../lib/atenti-source.js";

const SECRET = process.env.SESSION_SECRET;

function verifyToken(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ") || !SECRET) return false;
  let decoded;
  try { decoded = Buffer.from(auth.slice(7), "base64url").toString("utf8"); } catch { return false; }
  const parts = decoded.split(":");
  if (parts.length !== 3) return false;
  const [username, expiry, sig] = parts;
  const expected = createHmac("sha256", SECRET).update(`${username}:${expiry}`).digest("hex");
  const expectedBuf = Buffer.from(expected), sigBuf = Buffer.from(sig);
  if (expectedBuf.length !== sigBuf.length) return false;
  if (!timingSafeEqual(expectedBuf, sigBuf)) return false;
  return Date.now() <= Number(expiry);
}

function enumerateDates(from, to) {
  const dates = [];
  let d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400000);
  }
  return dates;
}

export default async function handler(req, res) {
  if (!verifyToken(req)) return res.status(401).json({ error: "No autorizado" });
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) {
    return res.status(500).json({ error: "Faltan credenciales de Gmail en las env vars de Vercel" });
  }

  res.setHeader("Cache-Control", "no-store");
  const { date, dni, from, to, format } = req.query;

  if (format === "csv") {
    if (!from || !to) return res.status(400).json({ error: "Faltan from/to" });
    const dates = enumerateDates(from, to);
    if (dates.length > 31) return res.status(400).json({ error: "Rango máximo: 31 días" });

    const dniSet = new Set();
    for (const d of dates) {
      let logs;
      try { logs = await fetchLogsForDate(d); } catch (e) { return res.status(502).json({ error: e.message }); }
      if (!logs) continue;
      for (const x of getChatParticipants(logs.chatLog)) dniSet.add(x);
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="atenti-dnis-${from}_${to}.csv"`);
    return res.send([...dniSet].join("\n"));
  }

  if (!date) return res.status(400).json({ error: "Falta date" });

  let logs;
  try { logs = await fetchLogsForDate(date); } catch (e) { return res.status(502).json({ error: e.message }); }
  if (!logs) return res.status(404).json({ error: `No se encontraron logs de Atenti para ${date}` });

  if (dni) {
    if (!/^\d+$/.test(dni)) return res.status(400).json({ error: "DNI inválido" });
    const perfil = getLoginMap(logs.loginLog).get(dni) || null;
    const conversacion = getConversation(logs.chatLog, dni);
    return res.json({ date, dni, perfil, conversacion });
  }

  const loginMap = getLoginMap(logs.loginLog);
  const ranking = getRanking(logs.chatLog).slice(0, 50)
    .map(r => ({ ...r, perfil: loginMap.get(r.dni) || null }));
  return res.json({ date, ranking });
}
