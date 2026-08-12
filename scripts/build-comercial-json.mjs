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
 * Uso:
 *   node scripts/build-comercial-json.mjs            # todos los meses con datos
 *   node scripts/build-comercial-json.mjs 2026-06    # uno o varios meses puntuales
 */
import fs from 'fs';
import path from 'path';
import { computeMonth, availableMonths, monthCol, ROW, KPI_KEYS } from './comercial-lib.mjs';

const OUT = 'docs/data/comercial-app.json';

function stampNow() {
  // Date.now()/new Date() no están disponibles en algunos entornos; usamos SOURCE_DATE si viene.
  return process.env.SOURCE_DATE || '';
}

function main() {
  let months = process.argv.slice(2).filter(a => /^\d{4}-\d{2}$/.test(a));
  if (!months.length) months = availableMonths();
  if (!months.length) { console.error('No hay datos en docs/data/daily.'); process.exit(1); }

  const out = { generated_at: stampNow(),
    source: 'vtex-utm-audit dashboard (docs/data/daily) — solo agregados, sin PII',
    tab: 'APP', rows: ROW, kpi_keys: KPI_KEYS,
    col_by_month: {}, months: {} };

  for (const ym of months) {
    const d = computeMonth(ym);
    if (!d) { console.warn(`⚠ ${ym}: sin datos, salteo.`); continue; }
    out.col_by_month[ym] = monthCol(ym);
    out.months[ym] = Object.fromEntries(KPI_KEYS.map(k => [k, d[k]]));
    console.log(`${ym} (col ${monthCol(ym)}, ${d.days} días): Pedidos ${d.pedidos} · VCT ${d.vct.toLocaleString()}`
      + ` · Ticket ${d.ticket.toLocaleString()} · Part ${(d.participacion*100).toFixed(2)}% · Unid ${d.unidades.toLocaleString()}`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n💾 ${OUT} (${Object.keys(out.months).length} meses)`);
}

main();
