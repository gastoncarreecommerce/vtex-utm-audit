/**
 * scripts/build-comercial-json.mjs
 *
 * Genera docs/data/comercial-app.json: los KPIs mensuales de la hoja "APP"
 * del Dashboard Comercial, ya calculados desde los datos del dashboard.
 *
 * Este JSON es público (docs/data/ se sirve en el dashboard) y lo consume el
 * Apps Script del Google Sheet, que corre con la cuenta de Carrefour y escribe
 * las celdas. Así no hace falta compartir el Sheet con ninguna cuenta externa.
 *
 * Solo contiene AGREGADOS (conteos, GMV, unidades, % de segmentos): nada de PII.
 *
 * Solo emite meses >= COMERCIAL_MIN_MONTH (default 2026-07), para NO pisar lo
 * ya cargado a mano en el Sheet (marzo–junio). Julio en adelante se llena solo.
 *
 * Uso:
 *   node scripts/build-comercial-json.mjs            # meses con datos, desde el piso
 *   node scripts/build-comercial-json.mjs 2026-08    # uno o varios meses puntuales
 *   COMERCIAL_MIN_MONTH=2026-08 node scripts/build-comercial-json.mjs   # cambiar el piso
 */
import fs from 'fs';
import path from 'path';
import { computeMonth, availableMonths, monthCol, ROW, ROW_LABELS, KPI_KEYS } from './comercial-lib.mjs';

const OUT = 'docs/data/comercial-app.json';
// Piso: no emitir meses anteriores a este (marzo–junio ya están cargados a mano).
const MIN_MONTH = process.env.COMERCIAL_MIN_MONTH || '2026-07';

function stampNow() {
  // Date.now()/new Date() no están disponibles en algunos entornos; usamos SOURCE_DATE si viene.
  return process.env.SOURCE_DATE || '';
}

function main() {
  let months = process.argv.slice(2).filter(a => /^\d{4}-\d{2}$/.test(a));
  if (!months.length) months = availableMonths();
  months = months.filter(m => m >= MIN_MONTH);   // no pisar lo cargado a mano
  if (!months.length) { console.error(`No hay datos desde ${MIN_MONTH} en docs/data/daily.`); process.exit(1); }

  const out = { generated_at: stampNow(),
    source: 'vtex-utm-audit dashboard (docs/data/daily) — solo agregados, sin PII',
    tab: 'APP', rows: ROW, row_labels: ROW_LABELS, kpi_keys: KPI_KEYS,
    col_by_month: {}, months: {} };

  for (const ym of months) {
    const d = computeMonth(ym);
    if (!d) { console.warn(`⚠ ${ym}: sin datos, salteo.`); continue; }
    out.col_by_month[ym] = monthCol(ym);
    const kobj = Object.fromEntries(KPI_KEYS.map(k => [k, d[k]]));
    // Recompra/frecuencia son tasas que suben a lo largo del mes: en meses
    // parciales quedan en blanco (null) hasta que el mes cierre, para no mostrar
    // un valor bajo engañoso. Los conteos (pedidos/VCT/unidades) sí se llenan.
    if (d.partial) { kobj.recompra = null; kobj.frecuencia = null; kobj.frecuencia_qc = null; }
    out.months[ym] = {
      name: d.name, days: d.days, through: d.through,
      days_in_month: d.days_in_month, partial: d.partial,
      ...kobj,
    };
    console.log(`${ym} ${d.name}${d.partial ? ` (PARCIAL, ${d.days}/${d.days_in_month} días, hasta ${d.through})` : ' (completo)'}`
      + `: Pedidos ${d.pedidos} · VCT ${d.vct.toLocaleString()} · Ticket ${d.ticket.toLocaleString()}`
      + ` · Part ${(d.participacion*100).toFixed(2)}% · Unid ${d.unidades.toLocaleString()}`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n💾 ${OUT} (${Object.keys(out.months).length} meses)`);
}

main();
