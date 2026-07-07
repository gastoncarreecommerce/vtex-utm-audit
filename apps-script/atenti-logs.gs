/**
 * Google Apps Script — Atenti Log Fetcher
 * Lee los mails de Atenti en Gmail y devuelve los logs crudos como JSON.
 * Sin OAuth externo: corre autenticado como el dueño del script.
 *
 * DEPLOYMENT (hacerlo una sola vez):
 *   1. https://script.google.com → "Nuevo proyecto" → pegar este archivo como Code.gs
 *   2. Engranaje (⚙) → "Propiedades del proyecto" → "Propiedades de secuencia de comandos"
 *      → Añadir propiedad: ATENTI_SECRET = <string aleatoria, ej: openssl rand -hex 20>
 *   3. "Implementar" → "Nueva implementación" → Tipo: App web
 *      · Ejecutar como: Yo
 *      · Quién puede acceder: Cualquier persona
 *      → Copiar la URL de implementación
 *   4. En Vercel y GitHub Actions Secrets añadir:
 *      APPSCRIPT_URL   = <URL copiada>
 *      APPSCRIPT_SECRET = <mismo valor que ATENTI_SECRET>
 *   5. Eliminar GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN de Vercel
 *
 * ACTUALIZAR EL SCRIPT (cuando cambies código):
 *   "Implementar" → "Administrar implementaciones" → editar → "Nueva versión" → Implementar
 */

var SENDER           = "atenti@carrefour.com";
var DAILY_SUBJECT    = "Se envian los logs del dia";
var BACKFILL_SUBJECT = "Logs Atenti completo";
var MONTHS = { Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",
               Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12" };

// ---------------------------------------------------------------------------
// Endpoint principal
// ---------------------------------------------------------------------------
function doGet(e) {
  var props  = PropertiesService.getScriptProperties();
  var secret = props.getProperty("ATENTI_SECRET");

  if (!e.parameter.key || e.parameter.key !== secret) {
    return resp({ error: "unauthorized" });
  }

  var date = e.parameter.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return resp({ error: "invalid_date" });
  }

  try {
    var logs = fetchLogsForDate(date);
    if (!logs) return resp({ error: "not_found" });
    return resp(logs);
  } catch (err) {
    Logger.log("Error en doGet: " + err.message);
    return resp({ error: err.message });
  }
}

function resp(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Busca los logs para `date` (YYYY-MM-DD).
// Devuelve { date, chatLog, loginLog, agregarLog, categorizarLog,
//            buscarEansLog, buscarSimilaresLog, origenLog } o null.
// ---------------------------------------------------------------------------
function fetchLogsForDate(date) {
  var parts = date.split("-");

  // El zip se nombra con la fecha del mail = fecha del dato + 1 día
  var mailDt = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
  mailDt.setUTCDate(mailDt.getUTCDate() + 1);
  var targetFile = "logs_" + Utilities.formatDate(mailDt, "UTC", "yyyyMMdd") + ".zip";

  // 1 — Mail diario (ventana de 3 días para cubrir zonas horarias)
  var base   = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
  var after  = Utilities.formatDate(base, "UTC", "yyyy/MM/dd");
  var before = Utilities.formatDate(new Date(base.getTime() + 3 * 86400000), "UTC", "yyyy/MM/dd");

  var threads = GmailApp.search(
    'from:' + SENDER + ' subject:"' + DAILY_SUBJECT + '" has:attachment' +
    ' after:' + after + ' before:' + before,
    0, 10
  );

  for (var ti = 0; ti < threads.length; ti++) {
    var msgs = threads[ti].getMessages();
    for (var mi = 0; mi < msgs.length; mi++) {
      var atts = msgs[mi].getAttachments();
      for (var ai = 0; ai < atts.length; ai++) {
        if (atts[ai].getName().toLowerCase() !== targetFile.toLowerCase()) continue;
        var result = parseZipBlob(atts[ai].copyBlob(), date);
        if (result) return result;
      }
    }
  }

  // 2 — Mail de backfill (zip exterior que contiene un zip por día)
  var bfThreads = GmailApp.search('subject:"' + BACKFILL_SUBJECT + '" has:attachment', 0, 5);

  for (var ti = 0; ti < bfThreads.length; ti++) {
    var msgs = bfThreads[ti].getMessages();
    for (var mi = 0; mi < msgs.length; mi++) {
      var atts = msgs[mi].getAttachments();
      for (var ai = 0; ai < atts.length; ai++) {
        if (!atts[ai].getName().toLowerCase().endsWith(".zip")) continue;
        try {
          var outerBlob = atts[ai].copyBlob().setContentType("application/zip");
          var innerBlobs = Utilities.unzip(outerBlob);
          for (var bi = 0; bi < innerBlobs.length; bi++) {
            if (innerBlobs[bi].getName().toLowerCase() !== targetFile.toLowerCase()) continue;
            var result = parseZipBlob(innerBlobs[bi].setContentType("application/zip"), date);
            if (result) return result;
          }
        } catch (err) {
          Logger.log("Error al descomprimir backfill: " + err.message);
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Descomprime un zip blob y devuelve los textos de cada log.
// Retorna null si el zip no corresponde a `date` (verificado contra chat.log).
// ---------------------------------------------------------------------------
function parseZipBlob(zipBlob, date) {
  var blobs;
  try {
    blobs = Utilities.unzip(zipBlob.setContentType("application/zip"));
  } catch (err) {
    Logger.log("Error unzip: " + err.message);
    return null;
  }

  function get(suffix) {
    for (var i = 0; i < blobs.length; i++) {
      if (blobs[i].getName().toLowerCase().endsWith(suffix)) {
        return blobs[i].getDataAsString("UTF-8");
      }
    }
    return "";
  }

  var chatLog = get("chat.log");

  // Verificar que la fecha dentro del zip coincide con la pedida
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
