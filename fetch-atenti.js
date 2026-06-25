/**
 * fetch-atenti.js
 * Lee el mail diario de Atenti (logs del chat de IA) vía Gmail API, parsea el
 * zip adjunto y guarda SOLO métricas agregadas en docs/data/atenti/YYYY-MM-DD.json.
 *
 * Los logs crudos traen PII real (email, nombre, teléfono, DNI/CUIL — sobre
 * todo en login.log y partes de chat.log/categorizar.log). Como docs/ se sirve
 * público vía GitHub Pages, este script NUNCA debe escribir nada per-cliente:
 * solo conteos y rankings agregados (productos, recetas, ingredientes — nunca
 * emails/nombres/teléfonos/documentos/IPs individuales).
 *
 * Env:
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN  (proyecto "chimi")
 *
 * Usage: node fetch-atenti.js
 */

const { google } = require("googleapis");
const AdmZip = require("adm-zip");
const fs   = require("fs");
const path = require("path");

const SENDER  = "atenti@carrefour.com";
const SUBJECT = "Se envian los logs del dia";

function gmailClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error("Faltan GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN");
  }
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth });
}

async function findZipAttachment(gmail) {
  const q = `from:${SENDER} subject:"${SUBJECT}" has:attachment newer_than:2d`;
  const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 5 });
  const msgId = list.data.messages?.[0]?.id;
  if (!msgId) throw new Error(`No se encontró ningún mail reciente de ${SENDER} con asunto "${SUBJECT}"`);

  const msg = await gmail.users.messages.get({ userId: "me", id: msgId });
  const parts = msg.data.payload?.parts || [];
  const zipPart = parts.find(p => p.filename && p.filename.toLowerCase().endsWith(".zip"));
  if (!zipPart) throw new Error("El mail no tiene ningún adjunto .zip");

  const att = await gmail.users.messages.attachments.get({
    userId: "me", messageId: msgId, id: zipPart.body.attachmentId
  });
  return Buffer.from(att.data.data, "base64");
}

// --- Parser genérico de logs: agrupa líneas de continuación (JSON pretty-printed
// multilínea) bajo la entrada cuyo timestamp las encabeza. ---
const HEADER_RE = /^\[\d{2}-\w{3}-\d{4} \d{2}:\d{2}:\d{2} [^\]]+\] /;
function parseEntries(content) {
  const entries = [];
  for (const line of content.split(/\r?\n/)) {
    if (HEADER_RE.test(line)) entries.push(line.replace(HEADER_RE, ""));
    else if (entries.length) entries[entries.length - 1] += "\n" + line;
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

function countPhpIssues(content) {
  return (content.match(/PHP (Warning|Fatal error|Notice|Deprecated)/g) || []).length;
}

function topN(counter, n) {
  return Object.entries(counter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

// Hora (00-23, horario AR) de cada línea con timestamp — solo para detectar
// picos de uso, nunca se asocia a ningún usuario puntual.
const HOUR_RE = /^\[\d{2}-\w{3}-\d{4} (\d{2}):\d{2}:\d{2}/;
function hourOf(line) { const m = line.match(HOUR_RE); return m ? Number(m[1]) : null; }

function analyzeChat(content) {
  const entries = parseEntries(content);
  const users = new Set();
  const porHora = Array(24).fill(0);
  let llamadas = 0, conProductos = 0, conSugerencia = 0;
  for (const e of entries) {
    let m = e.match(/^(\d+): Llamada: /);
    if (m) { llamadas++; if (m[1] !== "0") users.add(m[1]); continue; }
    m = e.match(/^(\d+): Respuesta cruda: /);
    if (m) {
      const json = extractJson(e, m[0].length);
      if (json) {
        if (Array.isArray(json.productos_identificados) && json.productos_identificados.length) conProductos++;
        if (json.mostrar_sugerencia === true) conSugerencia++;
      }
    }
  }
  // Distribución horaria de "Llamada" (recalculada sobre el contenido crudo,
  // ya que parseEntries descarta el timestamp original al agrupar entradas).
  for (const line of content.split(/\r?\n/)) {
    if (!HEADER_RE.test(line)) continue;
    if (!/\d+: Llamada: /.test(line)) continue;
    const h = hourOf(line);
    if (h !== null) porHora[h]++;
  }
  return {
    llamadas,
    usuarios_unicos: users.size,
    con_productos_identificados: conProductos,
    con_sugerencia: conSugerencia,
    por_hora: porHora,
    errores: countPhpIssues(content)
  };
}

function analyzeCategorizar(content) {
  const entries = parseEntries(content);
  let total = 0;
  const recetas = {}, ingredientes = {};
  for (const e of entries) {
    if (e.includes('"method":"categorizar"')) total++;
    if (/^\{"receta":/.test(e.trim())) {
      const json = extractJson(e);
      if (json?.receta) recetas[json.receta] = (recetas[json.receta] || 0) + 1;
      if (Array.isArray(json?.ingredientes)) {
        for (const ing of json.ingredientes) {
          if (typeof ing === "string") ingredientes[ing] = (ingredientes[ing] || 0) + 1;
        }
      }
    }
  }
  return {
    total,
    top_recetas: topN(recetas, 10),
    top_ingredientes: topN(ingredientes, 15),
    errores: countPhpIssues(content)
  };
}

function analyzeBuscarEans(content) {
  const busquedas = (content.match(/Llamando: /g) || []).length;
  const conResultado = (content.match(/\] \d+: \[\{"ranking"/g) || []).length;
  const terminos = {};
  for (const m of content.matchAll(/"prompt":"([^|"]+)/g)) {
    const term = m[1].trim().toLowerCase();
    if (term) terminos[term] = (terminos[term] || 0) + 1;
  }
  return {
    busquedas,
    sin_resultado: Math.max(0, busquedas - conResultado),
    top_terminos: topN(terminos, 15),
    errores: countPhpIssues(content)
  };
}

function analyzeAgregar(content) {
  const entries = parseEntries(content);
  let total = 0, valorTotal = 0;
  const productos = {};
  for (const e of entries) {
    const m = e.match(/^(\d+): Agregando al carrito: /);
    if (!m) continue;
    const json = extractJson(e, m[0].length);
    if (!json) continue;
    total++;
    valorTotal += Number(json.value) || 0;
    for (const item of (json.items || [])) {
      if (!item?.name) continue;
      productos[item.name] = (productos[item.name] || 0) + (Number(item.quantity) || 1);
    }
  }
  return {
    total_agregados: total,
    valor_total: Math.round(valorTotal * 100) / 100,
    ticket_promedio: total ? Math.round((valorTotal / total) * 100) / 100 : 0,
    top_productos: topN(productos, 10),
    errores: countPhpIssues(content)
  };
}

function analyzeBuscarSimilares(content) {
  const total = (content.match(/Respuesta Valtech similares/g) || []).length;
  const marcas = {};
  for (const m of content.matchAll(/"brand":"([^"]+)"/g)) {
    const b = m[1].trim();
    if (b) marcas[b] = (marcas[b] || 0) + 1;
  }
  return { total, top_marcas: topN(marcas, 10), errores: countPhpIssues(content) };
}

function analyzeLogin(content) {
  const users = new Set();
  const re = /\] (\d+) entro/g;
  let m;
  while ((m = re.exec(content))) users.add(m[1]);
  return { usuarios_unicos: users.size, errores: countPhpIssues(content) };
}

function analyzeOrigen(content) {
  const ips = new Set();
  let total = 0;
  const re = /Origen: ([\d.]+)/g;
  let m;
  while ((m = re.exec(content))) { total++; ips.add(m[1]); }
  return { total_requests: total, ips_unicas: ips.size };
}

async function main() {
  const gmail = gmailClient();
  console.log(`📬 Buscando mail de ${SENDER}...`);
  const zipBuffer = await findZipAttachment(gmail);
  console.log(`📦 Adjunto descargado (${(zipBuffer.length / 1024).toFixed(0)} KB)`);

  const zip = new AdmZip(zipBuffer);
  const read = name => {
    const entry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith(name));
    return entry ? entry.getData().toString("utf8") : "";
  };

  // El propio chat.log tiene timestamps reales — de ahí sacamos la fecha de los logs
  // (el mail llega a la 1am con los logs del día anterior).
  const chatLog = read("chat.log");
  const firstTs = chatLog.match(/^\[(\d{2})-(\w{3})-(\d{4})/m);
  const MONTHS = { Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12" };
  const date = firstTs ? `${firstTs[3]}-${MONTHS[firstTs[2]]}-${firstTs[1]}` : new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

  const result = {
    date,
    chat:             analyzeChat(chatLog),
    categorizar:      analyzeCategorizar(read("categorizar.log")),
    buscar_eans:      analyzeBuscarEans(read("buscar_eans.log")),
    agregar:          analyzeAgregar(read("agregar.log")),
    buscar_similares: analyzeBuscarSimilares(read("buscar_similares.log")),
    login:            analyzeLogin(read("login.log")),
    origen:           analyzeOrigen(read("origen.log")),
    fetched_at: new Date().toISOString()
  };

  const outDir = path.join("docs", "data", "atenti");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${date}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`💾 Guardado: ${outPath}`);
  console.log(`   Chat: ${result.chat.llamadas} llamadas, ${result.chat.usuarios_unicos} usuarios únicos`);
  console.log(`   Agregar: ${result.agregar.total_agregados} carritos, $${result.agregar.valor_total.toLocaleString()}`);
}

main().catch(err => { console.error("💥 Fatal Atenti:", err.message); process.exit(1); });
