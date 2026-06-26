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
    const zip = new AdmZip(Buffer.from(att.data.data, "base64"));
    const read = name => {
      const entry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith(name));
      return entry ? entry.getData().toString("utf8") : "";
    };

    const chatLog = read("chat.log");
    const ts = chatLog.match(/^\[(\d{2})-(\w{3})-(\d{4})/m);
    if (!ts) continue;
    const found = `${ts[3]}-${MONTHS[ts[2]]}-${ts[1]}`;
    if (found !== date) continue;

    return { chatLog, loginLog: read("login.log") };
  }
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
