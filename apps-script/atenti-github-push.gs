/**
 * atenti-github-push.gs
 *
 * Lee los mails de Atenti en Gmail (@carrefour.com), procesa los logs y
 * pushea métricas agregadas DIRECTAMENTE a GitHub Pages via API REST.
 *
 * NO requiere ser deployado como Web App. Corre como trigger de tiempo
 * interno — sin acceso externo, sin restricciones de Workspace.
 *
 * SETUP (única vez):
 *   1. script.google.com → Nuevo proyecto → pegar este archivo.
 *   2. Engranaje (⚙) → Propiedades del proyecto → Propiedades de secuencia
 *      de comandos → añadir:
 *        GITHUB_TOKEN  =  ghp_...  (token GitHub con permiso "contents:write")
 *        GITHUB_REPO   =  gastoncarreecommerce/vtex-utm-audit
 *   3. Ejecutar setupTrigger() una sola vez desde el editor para instalar
 *      el trigger diario. Autorizar los permisos de Gmail cuando pregunte.
 *   4. Opcional: ejecutar runForDate("2025-06-20") para backfill manual.
 *
 * LOGS:  Ver → Registros de ejecución en el editor de Apps Script.
 */

// ---------------------------------------------------------------------------
// Constantes del mail
// ---------------------------------------------------------------------------
var SENDER           = "atenti@carrefour.com";
var DAILY_SUBJECT    = "Se envian los logs del dia";
var BACKFILL_SUBJECT = "Logs Atenti completo";
var MONTHS = { Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",
               Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12" };

// ---------------------------------------------------------------------------
// Punto de entrada — trigger diario
// ---------------------------------------------------------------------------
function runDaily() {
  // Ayer en horario AR (UTC-3)
  var arNow  = new Date(Date.now() - 3 * 3600 * 1000);
  var ayer   = new Date(arNow.getTime() - 86400 * 1000);
  var date   = Utilities.formatDate(ayer, "UTC", "yyyy-MM-dd");
  processDate(date);
}

// Backfill manual: llamar con la fecha deseada en formato "YYYY-MM-DD"
function runForDate(date) {
  if (!date) throw new Error("Pasá la fecha: runForDate('2025-06-20')");
  processDate(date);
}

// ---------------------------------------------------------------------------
// Instalar / desinstalar trigger
// ---------------------------------------------------------------------------
function setupTrigger() {
  // Borra triggers existentes de esta función para no duplicar
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "runDaily") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("runDaily")
    .timeBased()
    .everyDays(1)
    .atHour(9)       // 9 AM UTC ≈ 6 AM AR — los mails de ayer ya están
    .create();
  Logger.log("✅ Trigger instalado: runDaily todos los días a las 9 AM UTC");
}

function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "runDaily") ScriptApp.deleteTrigger(t);
  });
  Logger.log("Trigger removido");
}

// ---------------------------------------------------------------------------
// Pipeline principal
// ---------------------------------------------------------------------------
function processDate(date) {
  Logger.log("📬 Buscando logs de Atenti para " + date + "...");

  var logs = fetchLogsForDate(date);
  if (!logs) {
    Logger.log("⚠️  No se encontraron logs para " + date);
    return;
  }

  Logger.log("📦 Logs encontrados. Analizando...");

  var result = {
    date:             logs.date,
    chat:             analyzeChat(logs.chatLog            || ""),
    categorizar:      analyzeCategorizar(logs.categorizarLog    || ""),
    buscar_eans:      analyzeBuscarEans(logs.buscarEansLog      || ""),
    agregar:          analyzeAgregar(logs.agregarLog            || ""),
    buscar_similares: analyzeBuscarSimilares(logs.buscarSimilaresLog || ""),
    login:            analyzeLogin(logs.loginLog               || ""),
    origen:           analyzeOrigen(logs.origenLog             || ""),
    fetched_at:       new Date().toISOString()
  };

  var json = JSON.stringify(result, null, 2);
  pushToGitHub(logs.date, json);

  Logger.log("✅ Listo para " + logs.date
    + " | Chat: " + result.chat.llamadas + " llamadas"
    + " | Carritos: " + result.agregar.total_agregados
    + " ($" + result.agregar.valor_total + ")");
}

// ---------------------------------------------------------------------------
// GitHub API — sube el JSON al repo
// ---------------------------------------------------------------------------
function pushToGitHub(date, jsonContent) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty("GITHUB_TOKEN");
  var repo  = props.getProperty("GITHUB_REPO") || "gastoncarreecommerce/vtex-utm-audit";

  if (!token) throw new Error("Falta GITHUB_TOKEN en Script Properties");

  var filePath = "docs/data/atenti/" + date + ".json";
  var apiUrl   = "https://api.github.com/repos/" + repo + "/contents/" + filePath;
  var headers  = {
    "Authorization": "token " + token,
    "User-Agent":    "Apps-Script-Atenti",
    "Content-Type":  "application/json"
  };

  // Obtener SHA del archivo si ya existe (requerido para actualizarlo)
  var sha = null;
  var getResp = UrlFetchApp.fetch(apiUrl, { method:"GET", headers:headers, muteHttpExceptions:true });
  if (getResp.getResponseCode() === 200) {
    sha = JSON.parse(getResp.getContentText()).sha;
  }

  // Codificar contenido en base64 (UTF-8)
  var bytes   = Utilities.newBlob(jsonContent, "application/json").getBytes();
  var b64     = Utilities.base64Encode(bytes);
  var payload = { message: "data(atenti): " + date, content: b64 };
  if (sha) payload.sha = sha;

  var putResp = UrlFetchApp.fetch(apiUrl, {
    method:           "PUT",
    headers:          headers,
    payload:          JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = putResp.getResponseCode();
  if (code !== 200 && code !== 201) {
    throw new Error("GitHub API " + code + ": " + putResp.getContentText().slice(0, 300));
  }
  Logger.log("💾 Pusheado: " + filePath);
}

// ---------------------------------------------------------------------------
// Lectura de mails y unzip (portado de atenti-logs.gs)
// ---------------------------------------------------------------------------
function fetchLogsForDate(date) {
  var parts   = date.split("-");
  // El zip se nombra con la fecha del mail = fecha del dato + 1 día
  var mailDt  = new Date(Date.UTC(+parts[0], +parts[1]-1, +parts[2]));
  mailDt.setUTCDate(mailDt.getUTCDate() + 1);
  var targetFile = "logs_" + Utilities.formatDate(mailDt, "UTC", "yyyyMMdd") + ".zip";

  var base   = new Date(Date.UTC(+parts[0], +parts[1]-1, +parts[2]));
  var after  = Utilities.formatDate(base, "UTC", "yyyy/MM/dd");
  var before = Utilities.formatDate(new Date(base.getTime() + 3*86400000), "UTC", "yyyy/MM/dd");

  // 1 — Mail diario
  var threads = GmailApp.search(
    'from:' + SENDER + ' subject:"' + DAILY_SUBJECT + '" has:attachment' +
    ' after:' + after + ' before:' + before, 0, 10
  );
  for (var ti = 0; ti < threads.length; ti++) {
    var msgs = threads[ti].getMessages();
    for (var mi = 0; mi < msgs.length; mi++) {
      var atts = msgs[mi].getAttachments();
      for (var ai = 0; ai < atts.length; ai++) {
        if (atts[ai].getName().toLowerCase() !== targetFile.toLowerCase()) continue;
        var r = parseZipBlob(atts[ai].copyBlob(), date);
        if (r) return r;
      }
    }
  }

  // 2 — Mail de backfill (zip exterior que contiene un zip por día)
  var bfThreads = GmailApp.search('subject:"' + BACKFILL_SUBJECT + '" has:attachment', 0, 5);
  for (var ti2 = 0; ti2 < bfThreads.length; ti2++) {
    var bfMsgs = bfThreads[ti2].getMessages();
    for (var mi2 = 0; mi2 < bfMsgs.length; mi2++) {
      var bfAtts = bfMsgs[mi2].getAttachments();
      for (var ai2 = 0; ai2 < bfAtts.length; ai2++) {
        if (!bfAtts[ai2].getName().toLowerCase().endsWith(".zip")) continue;
        try {
          var outer = bfAtts[ai2].copyBlob().setContentType("application/zip");
          var inner = Utilities.unzip(outer);
          for (var bi = 0; bi < inner.length; bi++) {
            if (inner[bi].getName().toLowerCase() !== targetFile.toLowerCase()) continue;
            var r2 = parseZipBlob(inner[bi].setContentType("application/zip"), date);
            if (r2) return r2;
          }
        } catch(e) { Logger.log("Error backfill: " + e.message); }
      }
    }
  }
  return null;
}

function parseZipBlob(zipBlob, date) {
  var blobs;
  try { blobs = Utilities.unzip(zipBlob.setContentType("application/zip")); }
  catch(e) { Logger.log("Error unzip: " + e.message); return null; }

  function get(suffix) {
    for (var i = 0; i < blobs.length; i++) {
      if (blobs[i].getName().toLowerCase().endsWith(suffix))
        return blobs[i].getDataAsString("UTF-8");
    }
    return "";
  }

  var chatLog = get("chat.log");
  var ts = chatLog.match(/^\[(\d{2})-(\w{3})-(\d{4})/m);
  if (ts) {
    var found = ts[3] + "-" + MONTHS[ts[2]] + "-" + ts[1];
    if (found !== date) return null;
  }

  return {
    date:               ts ? (ts[3] + "-" + MONTHS[ts[2]] + "-" + ts[1]) : date,
    chatLog:            chatLog,
    loginLog:           get("login.log"),
    agregarLog:         get("agregar.log"),
    categorizarLog:     get("categorizar.log"),
    buscarEansLog:      get("buscar_eans.log"),
    buscarSimilaresLog: get("buscar_similares.log"),
    origenLog:          get("origen.log")
  };
}

// ---------------------------------------------------------------------------
// Análisis de logs (portado de fetch-atenti.js — solo métricas agregadas,
// nunca datos per-cliente)
// ---------------------------------------------------------------------------
var HEADER_RE = /^\[\d{2}-\w{3}-\d{4} \d{2}:\d{2}:\d{2} [^\]]+\] /;
var HOUR_RE   = /^\[\d{2}-\w{3}-\d{4} (\d{2}):\d{2}:\d{2}/;

function parseEntries(content) {
  var entries = [];
  var lines = content.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (HEADER_RE.test(line)) entries.push(line.replace(HEADER_RE, ""));
    else if (entries.length) entries[entries.length - 1] += "\n" + line;
  }
  return entries;
}

function extractJson(text, fromIndex) {
  fromIndex = fromIndex || 0;
  var o = text.indexOf("{", fromIndex);
  var a = text.indexOf("[", fromIndex);
  var begin;
  if (o === -1 && a === -1) return null;
  begin = (o === -1) ? a : (a === -1) ? o : Math.min(o, a);
  var open = text[begin], close = open === "{" ? "}" : "]";
  var depth = 0, inStr = false, esc = false;
  for (var i = begin; i < text.length; i++) {
    var c = text[i];
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
      if (depth === 0) { try { return JSON.parse(text.slice(begin, i + 1)); } catch(e) { return null; } }
    }
  }
  return null;
}

function countPhpIssues(content) {
  return (content.match(/PHP (Warning|Fatal error|Notice|Deprecated)/g) || []).length;
}

function topN(counter, n) {
  return Object.keys(counter)
    .map(function(k) { return { key: k, count: counter[k] }; })
    .sort(function(a, b) { return b.count - a.count; })
    .slice(0, n);
}

function analyzeChat(content) {
  var entries   = parseEntries(content);
  var users     = {};
  var porHora   = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  var llamadas  = 0, conProductos = 0, conSugerencia = 0;
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var m = e.match(/^(\d+): Llamada: /);
    if (m) { llamadas++; if (m[1] !== "0") users[m[1]] = 1; continue; }
    m = e.match(/^(\d+): Respuesta cruda: /);
    if (m) {
      var json = extractJson(e, m[0].length);
      if (json) {
        if (Array.isArray(json.productos_identificados) && json.productos_identificados.length) conProductos++;
        if (json.mostrar_sugerencia === true) conSugerencia++;
      }
    }
  }
  var lines = content.split(/\r?\n/);
  for (var li = 0; li < lines.length; li++) {
    if (!HEADER_RE.test(lines[li])) continue;
    if (!/\d+: Llamada: /.test(lines[li])) continue;
    var hm = lines[li].match(HOUR_RE);
    if (hm) porHora[Number(hm[1])]++;
  }
  return {
    llamadas:                    llamadas,
    usuarios_unicos:             Object.keys(users).length,
    con_productos_identificados: conProductos,
    con_sugerencia:              conSugerencia,
    por_hora:                    porHora,
    errores:                     countPhpIssues(content)
  };
}

function analyzeCategorizar(content) {
  var entries     = parseEntries(content);
  var total       = 0;
  var recetas     = {}, ingredientes = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.indexOf('"method":"categorizar"') !== -1) total++;
    if (/^\{"receta":/.test(e.trim())) {
      var json = extractJson(e);
      if (json && json.receta) recetas[json.receta] = (recetas[json.receta] || 0) + 1;
      if (json && Array.isArray(json.ingredientes)) {
        for (var j = 0; j < json.ingredientes.length; j++) {
          var ing = json.ingredientes[j];
          if (typeof ing === "string") ingredientes[ing] = (ingredientes[ing] || 0) + 1;
        }
      }
    }
  }
  return {
    total:            total,
    top_recetas:      topN(recetas, 10),
    top_ingredientes: topN(ingredientes, 15),
    errores:          countPhpIssues(content)
  };
}

function analyzeBuscarEans(content) {
  var busquedas   = (content.match(/Llamando: /g)             || []).length;
  var conResultado= (content.match(/\] \d+: \[\{"ranking"/g)  || []).length;
  var terminos    = {}, subcategorias = {};
  var re = /"prompt":"([^|"]+)(?:\|Sub Categoria: ([^"]+))?"/g;
  var m;
  while ((m = re.exec(content)) !== null) {
    var term = m[1].trim().toLowerCase();
    if (term) terminos[term] = (terminos[term] || 0) + 1;
    if (m[2]) {
      var sub = m[2].trim();
      if (sub) subcategorias[sub] = (subcategorias[sub] || 0) + 1;
    }
  }
  return {
    busquedas:        busquedas,
    sin_resultado:    Math.max(0, busquedas - conResultado),
    top_terminos:     topN(terminos, 15),
    top_subcategorias:topN(subcategorias, 10),
    errores:          countPhpIssues(content)
  };
}

function leafCategory(productCategories) {
  if (!productCategories || typeof productCategories !== "object") return null;
  var ids = Object.keys(productCategories).map(Number).filter(function(n){ return !isNaN(n); });
  if (!ids.length) return null;
  return productCategories[String(Math.max.apply(null, ids))];
}

function analyzeAgregar(content) {
  var entries       = parseEntries(content);
  var total         = 0, valorTotal = 0, descuentoTotal = 0, inmediato = 0, programado = 0;
  var productos     = {}, categorias = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var m = e.match(/^(\d+): Agregando al carrito: /);
    if (!m) continue;
    var json = extractJson(e, m[0].length);
    if (!json) continue;
    total++;
    valorTotal += Number(json.value) || 0;
    if (json.salesChannel === "IMMEDIATE") inmediato++;
    else if (json.salesChannel === "SCHEDULED") programado++;
    var items = json.items || [];
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      if (!item || !item.name) continue;
      var qty = Number(item.quantity) || 1;
      productos[item.name] = (productos[item.name] || 0) + qty;
      var cat = leafCategory(item.productCategories);
      if (cat) categorias[cat] = (categorias[cat] || 0) + qty;
      var badges = item.badges || [];
      for (var b = 0; b < badges.length; b++) {
        descuentoTotal += Number(badges[b].totalDiscount) || 0;
      }
    }
  }
  return {
    total_agregados:  total,
    valor_total:      Math.round(valorTotal   * 100) / 100,
    ticket_promedio:  total ? Math.round((valorTotal / total) * 100) / 100 : 0,
    descuento_total:  Math.round(descuentoTotal * 100) / 100,
    canal:            { inmediato: inmediato, programado: programado },
    top_productos:    topN(productos, 10),
    top_categorias:   topN(categorias, 10),
    errores:          countPhpIssues(content)
  };
}

function analyzeBuscarSimilares(content) {
  var total     = (content.match(/Respuesta Valtech similares/g) || []).length;
  var marcas    = {}, categorias = {};
  var re1 = /"brand":"([^"]+)"/g;
  var m1;
  while ((m1 = re1.exec(content)) !== null) {
    var b = m1[1].trim();
    if (b) marcas[b] = (marcas[b] || 0) + 1;
  }
  var re2 = /"categories":\["\/([^"/]+)\//g;
  var m2;
  while ((m2 = re2.exec(content)) !== null) {
    var c = m2[1].trim();
    if (c) categorias[c] = (categorias[c] || 0) + 1;
  }
  return {
    total:          total,
    top_marcas:     topN(marcas, 10),
    top_categorias: topN(categorias, 10),
    errores:        countPhpIssues(content)
  };
}

function analyzeLogin(content) {
  var users       = {};
  var re          = /\] (\d+) entro/g;
  var m;
  while ((m = re.exec(content)) !== null) users[m[1]] = 1;
  var conCarrito  = 0, totalCarritos = 0, valorTotal = 0;
  var re2         = /"cart":\{"id":"[^"]*","salesChannel":"[^"]*","value":([\d.]+)/g;
  var cm;
  while ((cm = re2.exec(content)) !== null) {
    totalCarritos++;
    var v = Number(cm[1]) || 0;
    valorTotal += v;
    if (v > 0) conCarrito++;
  }
  return {
    usuarios_unicos: Object.keys(users).length,
    carrito_promedio: totalCarritos ? Math.round((valorTotal / totalCarritos) * 100) / 100 : 0,
    pct_con_carrito:  totalCarritos ? Math.round((conCarrito / totalCarritos) * 1000) / 10 : 0,
    errores:          countPhpIssues(content)
  };
}

function analyzeOrigen(content) {
  var ips   = {}, total = 0;
  var re    = /Origen: ([\d.]+)/g;
  var m;
  while ((m = re.exec(content)) !== null) { total++; ips[m[1]] = 1; }
  return { total_requests: total, ips_unicas: Object.keys(ips).length };
}
