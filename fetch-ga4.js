/**
 * fetch-ga4.js
 * Fetches daily GA4 event counts (sección "Compra Online" de la app) y los guarda
 * en docs/data/ga4/YYYY-MM-DD.json para que el dashboard arme tráfico + funnel.
 *
 * El tráfico de Compra Online se mide con el evento "switch_to_ecommerce"
 * (no el tráfico total de la app, que incluye la sección Sucursales).
 *
 * Env:
 *   GOOGLE_SERVICE_ACCOUNT  JSON del service account (el mismo que usa audit.js)
 *                           → hay que darle acceso de Viewer a la propiedad GA4
 *   GA4_PROPERTY_ID         ID numérico de la propiedad GA4 (ej: 123456789)
 *
 * Usage: node fetch-ga4.js [YYYY-MM-DD]   (default: ayer hora Argentina)
 */

const { google } = require("googleapis");
const fs   = require("fs");
const path = require("path");

const PROPERTY_ID = process.env.GA4_PROPERTY_ID;

function getTargetDate() {
  const arg = process.argv[2];
  if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  const ar = new Date(Date.now() - 3 * 60 * 60 * 1000);
  ar.setUTCDate(ar.getUTCDate() - 1);
  return ar.toISOString().slice(0, 10);
}

async function main() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT || !PROPERTY_ID) {
    console.log("⚠ GA4 no configurado (faltan GOOGLE_SERVICE_ACCOUNT y/o GA4_PROPERTY_ID). Salgo sin error.");
    return;
  }

  const date = getTargetDate();
  console.log(`\n📈 GA4 events for ${date} (property ${PROPERTY_ID})\n`);

  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth  = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"]
  });
  const analyticsdata = google.analyticsdata({ version: "v1beta", auth });

  const res = await analyticsdata.properties.runReport({
    property: `properties/${PROPERTY_ID}`,
    requestBody: {
      dateRanges: [{ startDate: date, endDate: date }],
      dimensions: [{ name: "eventName" }],
      metrics:    [{ name: "eventCount" }, { name: "totalUsers" }],
      limit: "1000"
    }
  });

  const events = {};
  for (const row of res.data.rows || []) {
    const name  = row.dimensionValues?.[0]?.value;
    if (!name) continue;
    events[name] = {
      count: parseInt(row.metricValues?.[0]?.value || "0", 10),
      users: parseInt(row.metricValues?.[1]?.value || "0", 10)
    };
  }

  const outDir  = path.join("docs", "data", "ga4");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${date}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ date, events }, null, 2));

  const traffic = events["switch_to_ecommerce"] || { count: 0, users: 0 };
  console.log(`💾 Saved: ${outPath}`);
  console.log(`   Eventos distintos:        ${Object.keys(events).length}`);
  console.log(`   switch_to_ecommerce:      ${traffic.count.toLocaleString()} eventos / ${traffic.users.toLocaleString()} usuarios`);
}

main().catch(err => { console.error("💥 Fatal GA4:", err.message); process.exit(1); });
