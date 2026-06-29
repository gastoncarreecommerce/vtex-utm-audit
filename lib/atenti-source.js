/**
 * lib/atenti-source.js — Helpers para leer los logs crudos de Atenti EN VIVO
 * desde Gmail, por fecha puntual. Usado SOLO por api/atenti-search.js.
 *
 * A diferencia de fetch-atenti.js (que corre por cron y commitea agregados a
 * docs/data/), este módulo nunca escribe nada a disco — todo se calcula en
 * memoria por request y se descarta al responder. Pensado para que el dato
 * con PII (DNI, email, conversaciones) jamás llegue al repo de git.
 */
import { google } from "googleapis";
import AdmZip from "adm-zip";

const SENDER  = "atenti@carrefour.com";
const SUBJECT = "Se envian los logs del dia";
// Mail único con un .zip adjunto por día viejo (logs_YYYYMMDD.zip), para fechas
// que ya no llegan por el mail diario normal — fallback de fetchLogsForDate.
const BACKFILL_SUBJECT = "Logs Atenti completo";
const MONTHS  = { Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12" };

export function gmailClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error("Faltan GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN en Vercel");
  }
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth });
}

function gmailDateStr(d) {
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Busca el mail de logs correspondiente al día `date` (YYYY-MM-DD). El mail
 * llega ~1am AR del día siguiente, pero no confiamos en el límite de día de
 * Gmail (zona horaria ambigua): bajamos los candidatos en una ventana de 3
 * días y verificamos contra el timestamp real dentro de chat.log.
 */
function readZipIfDateMatches(zipBuffer, date) {
  const zip = new AdmZip(zipBuffer);
  const read = name => {
    const entry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith(name));
    return entry ? entry.getData().toString("utf8") : "";
  };

  const chatLog = read("chat.log");
  const ts = chatLog.match(/^\[(\d{2})-(\w{3})-(\d{4})/m);
  if (!ts) return null;
  const found = `${ts[3]}-${MONTHS[ts[2]]}-${ts[1]}`;
  if (found !== date) return null;

  return {
    chatLog,
    loginLog:      read("login.log"),
    agregarLog:    read("agregar.log"),
    categorizarLog: read("categorizar.log"),
    buscarEansLog: read("buscar_eans.log")
  };
}

// Mail de backfill: un solo mail con varios adjuntos logs_YYYYMMDD.zip, uno
// por día viejo que ya no llega por el mail diario normal.
async function fetchBackfillZip(gmail, date) {
  const q = `subject:"${BACKFILL_SUBJECT}" has:attachment`;
  const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 5 });
  const filename = `logs_${date.replace(/-/g, "")}.zip`;

  for (const m of (list.data.messages || [])) {
    const msg = await gmail.users.messages.get({ userId: "me", id: m.id });
    const parts = msg.data.payload?.parts || [];
    const zipPart = parts.find(p => p.filename && p.filename.toLowerCase() === filename);
    if (!zipPart) continue;
    const att = await gmail.users.messages.attachments.get({
      userId: "me", messageId: m.id, id: zipPart.body.attachmentId
    });
    return Buffer.from(att.data.data, "base64");
  }
  return null;
}

export async function fetchLogsForDate(date) {
  const gmail = gmailClient();
  const base   = new Date(`${date}T00:00:00Z`);
  const after  = gmailDateStr(base);
  const before = gmailDateStr(new Date(base.getTime() + 3 * 86400000));
  const q = `from:${SENDER} subject:"${SUBJECT}" has:attachment after:${after} before:${before}`;
  const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 10 });
  const msgIds = (list.data.messages || []).map(m => m.id);

  for (const id of msgIds) {
    const msg = await gmail.users.messages.get({ userId: "me", id });
    const parts = msg.data.payload?.parts || [];
    const zipPart = parts.find(p => p.filename && p.filename.toLowerCase().endsWith(".zip"));
    if (!zipPart) continue;

    const att = await gmail.users.messages.attachments.get({
      userId: "me", messageId: id, id: zipPart.body.attachmentId
    });
    const result = readZipIfDateMatches(Buffer.from(att.data.data, "base64"), date);
    if (result) return result;
  }

  const backfillZip = await fetchBackfillZip(gmail, date);
  if (backfillZip) return readZipIfDateMatches(backfillZip, date);

  return null;
}

const HEADER_RE = /^\[([^\]]+)\] /;

function parseEntriesWithTs(content) {
  const entries = [];
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(HEADER_RE);
    if (m) entries.push({ ts: m[1], text: line.slice(m[0].length) });
    else if (entries.length) entries[entries.length - 1].text += "\n" + line;
  }
  return entries;
}

// Extrae el primer objeto/array JSON balanceado a partir de `fromIndex`.
function extractJson(text, fromIndex = 0) {
  const o = text.indexOf("{", fromIndex);
  const a = text.indexOf("[", fromIndex);
  let begin = -1;
  if (o === -1 && a === -1) return null;
  begin = (o === -1) ? a : (a === -1) ? o : Math.min(o, a);
  const open = text[begin], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = begin; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) { try { return JSON.parse(text.slice(begin, i + 1)); } catch { return null; } }
    }
  }
  return null;
}

// DNI/CUIL/email/nombre por usuario — extraído de los bloques "customerProfile"
// de login.log. Nunca se persiste: vive solo en memoria de este request.
export function getLoginMap(loginLog) {
  const map = new Map();
  const marker = '"customerProfile":';
  let idx = 0;
  while (true) {
    const pos = loginLog.indexOf(marker, idx);
    if (pos === -1) break;
    idx = pos + marker.length;
    const json = extractJson(loginLog, idx);
    if (json?.document) {
      map.set(String(json.document), {
        nombre:   [json.firstName, json.lastName].filter(Boolean).join(" "),
        email:    json.email || "",
        telefono: json.phone || json.homePhone || "",
        cuil:     json.cuil || ""
      });
    }
  }
  return map;
}

// Ranking de uso de Atenti por DNI (excluye "0" = sesión anónima/sin login).
export function getRanking(chatLog) {
  const entries = parseEntriesWithTs(chatLog);
  const counts = new Map();
  for (const e of entries) {
    const m = e.text.match(/^(\d+): Llamada: /);
    if (m && m[1] !== "0") counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([dni, mensajes]) => ({ dni, mensajes }));
}

// Set de DNIs que usaron Atenti ese día (para el export de push).
export function getChatParticipants(chatLog) {
  const set = new Set();
  for (const m of chatLog.matchAll(/^\[[^\]]+\] (\d+): Llamada: /gm)) {
    if (m[1] !== "0") set.add(m[1]);
  }
  return set;
}

// Reconstruye la conversación completa (burbujas user/model en orden) de un
// DNI puntual a partir de los pares Llamada → Respuesta cruda del chat.log.
export function getConversation(chatLog, dni) {
  const entries = parseEntriesWithTs(chatLog);
  const conv = [];
  for (const e of entries) {
    let m = e.text.match(/^(\d+): Llamada: /);
    if (m && m[1] === dni) {
      const json = extractJson(e.text, m[0].length);
      if (json?.message) conv.push({ role: "user", text: json.message, ts: e.ts });
      continue;
    }
    m = e.text.match(/^(\d+): Respuesta cruda: /);
    if (m && m[1] === dni) {
      const json = extractJson(e.text, m[0].length);
      if (json?.response) conv.push({ role: "model", text: json.response, ts: e.ts });
    }
  }
  return conv;
}

function parseTsToMs(ts) {
  const MONTHS_NUM = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
  const m = ts.match(/^(\d{2})-(\w{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return 0;
  return Date.UTC(Number(m[3]), MONTHS_NUM[m[2]], Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
}

// Inicios de sesión de un DNI ese día, con el valor/canal del carrito que
// tenía en ese momento (mismo bloque "customerProfile"+"cart" de login.log).
export function getLoginEvents(loginLog, dni) {
  const out = [];
  for (const hm of loginLog.matchAll(/^\[([^\]]+)\] /gm)) {
    const lineStart = hm.index + hm[0].length;
    if (!loginLog.startsWith('{"customerProfile":', lineStart)) continue;
    const json = extractJson(loginLog, lineStart);
    if (String(json?.customerProfile?.document) !== dni) continue;
    const cart = json.cart || {};
    out.push({
      ts: hm[1],
      valor_carrito: typeof cart.value === "number" ? cart.value : 0,
      canal: cart.salesChannel || ""
    });
  }
  return out;
}

// Carritos agregados por un DNI ese día (productos, cantidad, valor, canal).
export function getCartAdds(agregarLog, dni) {
  const entries = parseEntriesWithTs(agregarLog);
  const out = [];
  for (const e of entries) {
    const m = e.text.match(/^(\d+): Agregando al carrito: /);
    if (!m || m[1] !== dni) continue;
    const json = extractJson(e.text, m[0].length);
    if (!json) continue;
    out.push({
      ts: e.ts,
      valor: Math.round((Number(json.value) || 0) * 100) / 100,
      canal: json.salesChannel || "",
      items: (json.items || []).filter(i => i?.name).map(i => ({ nombre: i.name, cantidad: Number(i.quantity) || 1 }))
    });
  }
  return out;
}

// Búsquedas de productos por EAN/nombre que hizo un DNI ese día.
export function getEanSearches(buscarEansLog, dni) {
  const entries = parseEntriesWithTs(buscarEansLog);
  const out = [];
  for (const e of entries) {
    if (!e.text.startsWith("{")) continue;
    const json = extractJson(e.text, 0);
    if (!json || String(json.client) !== dni) continue;
    const [term, sub] = String(json.prompt || "").split("|Sub Categoria: ");
    out.push({ ts: e.ts, termino: (term || "").trim(), subcategoria: (sub || "").trim() });
  }
  return out;
}

// Pedidos de "categorizar/armame una receta" de un DNI ese día.
export function getCategorizarRequests(categorizarLog, dni) {
  const entries = parseEntriesWithTs(categorizarLog);
  const out = [];
  for (const e of entries) {
    if (!e.text.startsWith('{"method":"categorizar"')) continue;
    const json = extractJson(e.text, 0);
    if (!json || String(json.doc) !== dni) continue;
    out.push({
      ts: e.ts,
      contexto: json.contexto || "",
      productos: (json.productos || []).map(p => String(p).split("|")[0])
    });
  }
  return out;
}

// Línea de tiempo completa de un DNI ese día: login, mensajes de chat,
// búsquedas, pedidos de receta y agregados al carrito, todo en orden
// cronológico. Esto es lo que ve un agente de soporte al inspeccionar un caso.
export function getTimeline(logs, dni) {
  const items = [];

  for (const e of getLoginEvents(logs.loginLog, dni)) {
    const canalTxt = e.canal === "IMMEDIATE" ? "inmediato" : e.canal === "SCHEDULED" ? "programado" : e.canal;
    items.push({
      tipo: "login", ts: e.ts,
      detalle: `Inició sesión${e.valor_carrito ? ` · carrito de $${Math.round(e.valor_carrito).toLocaleString("es-AR")}${canalTxt ? ` (${canalTxt})` : ""}` : ""}`
    });
  }
  for (const c of getConversation(logs.chatLog, dni)) {
    items.push({ tipo: c.role === "user" ? "mensaje_cliente" : "mensaje_atenti", ts: c.ts, detalle: c.text });
  }
  for (const r of getCategorizarRequests(logs.categorizarLog, dni)) {
    items.push({
      tipo: "categorizar", ts: r.ts,
      detalle: `Pidió armar receta/categorizar: "${r.contexto}"${r.productos.length ? ` (${r.productos.join(", ")})` : ""}`
    });
  }
  for (const s of getEanSearches(logs.buscarEansLog, dni)) {
    items.push({ tipo: "busqueda", ts: s.ts, detalle: `Buscó: "${s.termino}"${s.subcategoria ? ` · ${s.subcategoria}` : ""}` });
  }
  for (const a of getCartAdds(logs.agregarLog, dni)) {
    const canalTxt = a.canal === "IMMEDIATE" ? "inmediato" : a.canal === "SCHEDULED" ? "programado" : a.canal;
    const lista = a.items.map(i => `${i.cantidad}x ${i.nombre}`).join(", ") || "(sin detalle de items)";
    items.push({
      tipo: "carrito", ts: a.ts,
      detalle: `Agregó al carrito${canalTxt ? ` (${canalTxt})` : ""} · $${Math.round(a.valor).toLocaleString("es-AR")}: ${lista}`
    });
  }

  return items.sort((a, b) => parseTsToMs(a.ts) - parseTsToMs(b.ts));
}
