/**
 * Dashboard Comercial · auto-fill de la hoja "APP" desde el dashboard.
 *
 * Corre DENTRO del Sheet, con tu cuenta de Carrefour (no se comparte con nadie
 * externo). Lee un JSON público de KPIs que genera el repo vtex-utm-audit y
 * escribe las celdas de la hoja APP (Pedidos, VCT, Ticket, % Participación,
 * Unidades y los 4 segmentos), mes a mes.
 *
 * Instalación (una vez):
 *   1) En el Sheet: Extensiones → Apps Script.
 *   2) Pegá este archivo completo. Guardá (Ctrl+S).
 *   3) Ejecutá syncComercialAPP  → te pide autorizar permisos, aceptá.
 *   4) Ejecutá crearTriggerMensual  → queda corriendo solo el día 2 de cada mes.
 *
 * Para actualizar a mano cuando quieras: ejecutá syncComercialAPP.
 */

// URL del JSON público (repo público → se puede leer sin credenciales).
// Si GitHub estuviera bloqueado por red, usá la de Vercel (segunda línea).
var COMERCIAL_JSON_URL =
  'https://raw.githubusercontent.com/gastoncarreecommerce/vtex-utm-audit/main/docs/data/comercial-app.json';
// var COMERCIAL_JSON_URL = 'https://appnativa-dashboard.vercel.app/data/comercial-app.json';

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

  var rowMap = data.rows;              // { pedidos:2, vct:3, ticket:4, ... }
  var colByMonth = data.col_by_month;  // { "2026-06":"F", "2026-07":"G", ... }
  var written = 0, months = [];

  Object.keys(data.months).forEach(function (ym) {
    var col = colByMonth[ym];
    if (!col) return;
    var kpis = data.months[ym];
    Object.keys(rowMap).forEach(function (key) {
      var v = kpis[key];
      if (v === undefined || v === null) return;
      sh.getRange(col + rowMap[key]).setValue(v);
      written++;
    });
    months.push(ym);
  });

  Logger.log('OK · ' + written + ' celdas escritas · meses: ' + months.join(', '));
  return written;
}

// Disparador mensual: corre syncComercialAPP el día 2 de cada mes ~09:00.
function crearTriggerMensual() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncComercialAPP') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncComercialAPP').timeBased().onMonthDay(2).atHour(9).create();
  Logger.log('Trigger mensual creado (día 2, 09:00).');
}
