// ============================================================
//  ATENTI — Envío automático semanal de DNIs
//  Pegar al FINAL del mismo proyecto atenti-github-push.gs
//  (reutiliza fetchLogsForDate, ya definido ahí — no pide permisos nuevos)
// ============================================================

// ▼▼▼  DESTINATARIOS — agregá los mails acá  ▼▼▼
var DESTINATARIOS = [
  "gaston_ruiz@carrefour.com",
  "daiana_molina@carrefour.com",
  "sabrina_liotti@carrefour.com",
  "luisina_manna@carrefour.com",
  "verena_sara@carrefour.com",
  "samuel_moreira_6@carrefour.com",
  // seguí agregando...
];
// ▲▲▲  ————————————————————————————————————  ▲▲▲

var ALIAS_EMISOR    = "Atenti_nps@carrefour.com";
var NOMBRE_EMISOR   = "Atenti 🤖";
var IMAGEN_HEADER   = "https://image.experiencia.carrefour.com.ar/lib/fe2c117371640579721374/m/1/30cc25ff-0e8f-48b2-b662-7e356d445c70.gif";
var MESES_ES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio",
                "Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

// ============================================================
//  Rango: lunes a domingo de la semana ANTERIOR a hoy (hora AR)
// ============================================================
function computeLastWeekRange_() {
  var hoy = new Date(Date.now() - 3 * 3600 * 1000); // aprox hora AR (UTC-3)
  hoy.setUTCHours(0, 0, 0, 0);
  var diaSemana    = hoy.getUTCDay();              // 0=domingo..6=sábado
  var offsetALunes = (diaSemana === 0) ? 6 : diaSemana - 1;
  var lunesActual  = new Date(hoy);
  lunesActual.setUTCDate(lunesActual.getUTCDate() - offsetALunes);

  var lunesPasado = new Date(lunesActual);
  lunesPasado.setUTCDate(lunesPasado.getUTCDate() - 7);
  var domingoPasado = new Date(lunesActual);
  domingoPasado.setUTCDate(domingoPasado.getUTCDate() - 1);

  return { desde: lunesPasado, hasta: domingoPasado };
}

function formatFechaEs_(d, conAnio) {
  var s = d.getUTCDate() + " de " + MESES_ES[d.getUTCMonth()];
  if (conAnio) s += " de " + d.getUTCFullYear();
  return s;
}

// DNIs únicos que hablaron con Atenti ese día (excluye "0" = sin login).
function getChatParticipantsFromLog_(chatLog) {
  var set = {};
  var re = /^\[[^\]]+\] (\d+): Llamada: /gm;
  var m;
  while ((m = re.exec(chatLog)) !== null) {
    if (m[1] !== "0") set[m[1]] = true;
  }
  return Object.keys(set);
}

// ============================================================
//  FUNCIÓN PRINCIPAL — llamar manual o desde el trigger semanal
// ============================================================
function enviarMailAtentiSemanal() {
  var rango  = computeLastWeekRange_();
  var dniSet = {};
  var diasConDatos = 0, diasSinDatos = 0;

  var d = new Date(rango.desde);
  while (d <= rango.hasta) {
    var fechaStr = Utilities.formatDate(d, "UTC", "yyyy-MM-dd");
    try {
      var logs = fetchLogsForDate(fechaStr); // ya definida en atenti-github-push.gs
      if (logs && logs.chatLog) {
        diasConDatos++;
        var dnis = getChatParticipantsFromLog_(logs.chatLog);
        for (var i = 0; i < dnis.length; i++) dniSet[dnis[i]] = true;
      } else {
        diasSinDatos++;
        Logger.log("⚠️  Sin mail/logs para " + fechaStr);
      }
    } catch (e) {
      diasSinDatos++;
      Logger.log("❌ Error " + fechaStr + ": " + e.message);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }

  var dniList = Object.keys(dniSet).sort(function (a, b) { return Number(a) - Number(b); });

  if (!dniList.length) {
    Logger.log("⚠️  0 DNIs en el rango (" + diasConDatos + " días con datos, " + diasSinDatos + " sin datos) — no se envía mail.");
    return;
  }

  var fechaDesdeStr  = formatFechaEs_(rango.desde, false);
  var fechaHastaStr  = formatFechaEs_(rango.hasta, true);
  var csv            = "DNI\n" + dniList.join("\n");
  var nombreArchivo  = "atenti-dnis-" + Utilities.formatDate(rango.desde, "UTC", "yyyyMMdd")
                      + "_" + Utilities.formatDate(rango.hasta, "UTC", "yyyyMMdd") + ".csv";
  var blob = Utilities.newBlob(csv, "text/csv", nombreArchivo);

  MailApp.sendEmail({
    to:        DESTINATARIOS.join(","),
    subject:   "🤖 Atenti — DNIs " + fechaDesdeStr + " al " + fechaHastaStr,
    htmlBody:  construirHtmlSemanal_(dniList.length, fechaDesdeStr, fechaHastaStr),
    attachments: [blob],
    name:      NOMBRE_EMISOR,
    replyTo:   ALIAS_EMISOR
  });

  Logger.log("✅ Mail enviado a: " + DESTINATARIOS.join(", ") + " | " + dniList.length + " DNIs | "
    + fechaDesdeStr + " → " + fechaHastaStr + " (" + diasConDatos + "/7 días con datos)");
}

// ============================================================
//  HTML DEL MAIL
// ============================================================
function construirHtmlSemanal_(totalDnis, fechaDesde, fechaHasta) {
  return '<!DOCTYPE html>' +
'<html lang="es"><head><meta charset="UTF-8"></head>' +
'<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">' +
'<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;padding:30px 0;">' +
'<tr><td align="center">' +
'<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.10);">' +

'<tr><td style="padding:36px 40px 32px 40px;">' +

'<table cellpadding="0" cellspacing="0" style="margin:0 0 28px 0;"><tr>' +
'<td style="padding:0;vertical-align:middle;width:60px;">' +
'<img src="' + IMAGEN_HEADER + '" alt="Atenti" width="56" height="56" style="display:block;width:56px;height:56px;object-fit:cover;object-position:top center;border-radius:50%;border:2px solid #e0e7ff;" />' +
'</td>' +
'<td style="padding:0 0 0 14px;vertical-align:middle;">' +
'<p style="margin:0;font-size:15px;font-weight:700;color:#1a1a2e;">Atenti</p>' +
'<p style="margin:2px 0 0 0;font-size:12px;color:#888;">Personal Shopper · Carrefour Argentina</p>' +
'</td>' +
'</tr></table>' +

'<p style="margin:0 0 16px 0;font-size:22px;font-weight:700;color:#1a1a2e;">¡Hola equipo! 👋</p>' +
'<p style="margin:0 0 24px 0;font-size:15px;line-height:1.7;color:#444444;">' +
'Acá va el listado automático de los DNIs de los clientes que charlaron conmigo la semana pasada. ' +
'Listo para mandar push 🚀' +
'</p>' +

'<table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#f0f4ff 0%,#e8f0fe 100%);border-radius:10px;margin:0 0 28px 0;">' +
'<tr><td style="padding:24px;">' +
'<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
'<td width="50%" style="text-align:center;padding:10px;">' +
'<p style="margin:0;font-size:34px;font-weight:800;color:#1a56db;">🧾 ' + totalDnis + '</p>' +
'<p style="margin:6px 0 0 0;font-size:13px;color:#555;text-transform:uppercase;letter-spacing:0.5px;">DNIs únicos</p>' +
'</td>' +
'<td width="50%" style="text-align:center;padding:10px;border-left:1px solid #d0d9f0;">' +
'<p style="margin:0;font-size:18px;font-weight:700;color:#1a56db;">📅 ' + fechaDesde + '</p>' +
'<p style="margin:4px 0;font-size:13px;color:#888;">al</p>' +
'<p style="margin:0;font-size:18px;font-weight:700;color:#1a56db;">' + fechaHasta + '</p>' +
'</td>' +
'</tr></table>' +
'</td></tr></table>' +

'<p style="margin:0;font-size:14px;line-height:1.6;color:#666;text-align:center;">' +
'📎 El CSV con el listado completo va adjunto en este mail.' +
'</p>' +

'</td></tr>' +

'<tr><td style="background:#f8f9fb;padding:20px 40px;border-top:1px solid #e9ecef;">' +
'<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
'<td><p style="margin:0;font-size:12px;color:#999;">' +
'Generado automáticamente por <strong>Atenti</strong> — Personal Shopper de Carrefour Argentina.<br>' +
'Período: <strong>' + fechaDesde + ' al ' + fechaHasta + '</strong>' +
'</p></td>' +
'<td align="right">' +
'<img src="' + IMAGEN_HEADER + '" alt="Atenti" width="48" height="48" style="border-radius:50%;border:2px solid #e0e7ff;object-fit:cover;object-position:top;" />' +
'</td>' +
'</tr></table>' +
'</td></tr>' +

'</table>' +
'</td></tr></table>' +
'</body></html>';
}

// ============================================================
//  Trigger: todos los lunes a las 8 AM (zona horaria del proyecto)
// ============================================================
function instalarTriggerSemanal() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "enviarMailAtentiSemanal") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("enviarMailAtentiSemanal")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(8)
    .create();
  Logger.log("✅ Trigger semanal instalado: todos los lunes ~8 AM");
}
