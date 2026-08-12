/**
 * Dashboard Comercial · auto-fill de la hoja "APP" desde el dashboard.
 *
 * Corre DENTRO del Sheet, con tu cuenta de Carrefour (no se comparte con nadie
 * externo). Lee un JSON público de KPIs que genera el repo vtex-utm-audit y
 * escribe las celdas de la hoja APP (Pedidos, VCT, Ticket, % Participación,
 * Unidades y los 4 segmentos), mes a mes.
 *
 * Ubica las celdas por CONTENIDO, no por letra fija:
 *   - la COLUMNA por el nombre del mes en el encabezado (fila 1). Si existe una
 *     columna "<mes> Script" la usa (modo comparación); si no, usa la de "<mes>".
 *     Nunca pisa "<mes> original".
 *   - la FILA por la etiqueta del KPI en la columna B.
 * Así podés insertar/mover columnas y filas sin romper nada.
 *
 * Instalación (una vez):
 *   1) En el Sheet: Extensiones → Apps Script.
 *   2) Pegá este archivo completo. Guardá (Ctrl+S).
 *   3) Ejecutá syncComercialAPP  → autorizá permisos. Mirá el registro (Ver → Registro).
 *   4) Ejecutá crearTriggerMensual  → queda corriendo solo el día 2 de cada mes.
 */

var COMERCIAL_JSON_URL =
  'https://raw.githubusercontent.com/gastoncarreecommerce/vtex-utm-audit/main/docs/data/comercial-app.json';
// Alternativa si GitHub estuviera bloqueado por red:
// var COMERCIAL_JSON_URL = 'https://appnativa-dashboard.vercel.app/data/comercial-app.json';

function norm_(s) {
  return String(s == null ? '' : s)
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Devuelve el nº de columna (1-indexed) para un mes, mirando la fila de encabezados.
// Prioridad: "<mes> script"  >  "<mes>" exacto  >  empieza con "<mes>" (pero no "original").
function findMonthColumn_(header, monthName) {
  var m = norm_(monthName);
  var exactScript = -1, exactName = -1, startsWith = -1;
  for (var i = 0; i < header.length; i++) {
    var h = norm_(header[i]);
    if (!h) continue;
    if (h === m + ' script') exactScript = i + 1;
    else if (h === m) exactName = i + 1;
    else if (h.indexOf(m) === 0 && h.indexOf('original') === -1 && startsWith === -1) startsWith = i + 1;
  }
  return exactScript !== -1 ? exactScript : (exactName !== -1 ? exactName : startsWith);
}

function syncComercialAPP() {
  var res = UrlFetchApp.fetch(COMERCIAL_JSON_URL + '?t=' + new Date().getTime(),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('No pude leer el JSON de KPIs (HTTP ' + res.getResponseCode() + ').');
  }
  var data = JSON.parse(res.getContentText());

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(data.tab || 'APP');
  if (!sh) throw new Error('No existe la hoja "' + (data.tab || 'APP') + '" en este Sheet.');

  // Encabezados (fila 1) y etiquetas de KPI (columna B), leídos una sola vez.
  var lastCol = sh.getLastColumn(), lastRow = sh.getLastRow();
  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var colB = sh.getRange(1, 2, lastRow, 1).getValues();

  var rowByLabel = {};
  for (var r = 0; r < colB.length; r++) {
    var lbl = norm_(colB[r][0]);
    if (lbl && rowByLabel[lbl] === undefined) rowByLabel[lbl] = r + 1;
  }
  function rowForKey(key) {
    var lbl = data.row_labels && data.row_labels[key];
    var found = lbl ? rowByLabel[norm_(lbl)] : undefined;
    return found || (data.rows ? data.rows[key] : undefined); // fallback a fila fija
  }

  var log = [], written = 0;
  Object.keys(data.months).forEach(function (ym) {
    var mo = data.months[ym];
    var col = findMonthColumn_(header, mo.name || ym);
    if (!col) { log.push('· ' + (mo.name || ym) + ': sin columna en el encabezado, salteo.'); return; }

    var n = 0;
    (data.kpi_keys || Object.keys(data.rows || {})).forEach(function (key) {
      var v = mo[key];
      if (v === undefined || v === null) return;
      var row = rowForKey(key);
      if (!row) return;
      sh.getRange(row, col).setValue(v);
      n++; written++;
    });
    log.push('✓ ' + (mo.name || ym) + (mo.partial ? ' (PARCIAL ' + mo.days + '/' + mo.days_in_month + ', hasta ' + mo.through + ')' : ' (completo)')
      + ' → col ' + col + ', ' + n + ' celdas');
  });

  Logger.log('Sync OK · ' + written + ' celdas\n' + log.join('\n'));
  return log.join('\n');
}

// Disparador mensual: corre syncComercialAPP el día 2 de cada mes ~09:00.
function crearTriggerMensual() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncComercialAPP') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncComercialAPP').timeBased().onMonthDay(2).atHour(9).create();
  Logger.log('Trigger mensual creado (día 2, 09:00).');
}
