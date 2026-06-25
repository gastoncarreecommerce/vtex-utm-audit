/**
 * gmail-oauth-setup.js — Script de UNA SOLA VEZ para generar el refresh token
 * de Gmail API (proyecto "chimi"), usado luego por el GitHub Action de Atenti.
 *
 * Correr LOCAL (en tu compu, nunca en CI):
 *   npm install googleapis
 *   GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... node scripts/gmail-oauth-setup.js
 *
 * Abre el navegador, pedís consentimiento con la cuenta de Gmail que recibe
 * el mail de logs a la 1am, y al final imprime el refresh token — ese valor
 * se guarda como GitHub secret (GMAIL_REFRESH_TOKEN) y no se vuelve a generar.
 */

const { google } = require("googleapis");
const http = require("http");

const CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Faltan GMAIL_CLIENT_ID y/o GMAIL_CLIENT_SECRET en el entorno.");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/gmail.readonly"]
});

console.log("\nAbrí esta URL en el navegador y logueate con la cuenta de Gmail correcta:\n");
console.log(authUrl + "\n");

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/oauth2callback")) return;
  const code = new URL(req.url, REDIRECT_URI).searchParams.get("code");
  res.end("Listo, ya podés cerrar esta pestaña y volver a la terminal.");
  server.close();

  const { tokens } = await oauth2Client.getToken(code);
  console.log("\nREFRESH TOKEN (guardalo como secret GMAIL_REFRESH_TOKEN en GitHub):\n");
  console.log(tokens.refresh_token || "(no se recibió refresh_token — repetí el flujo, asegurate de que la app esté en modo Pruebas y que sea la primera vez que autorizás, o revocá el acceso previo en myaccount.google.com/permissions y reintentá)");
  console.log();
});

server.listen(PORT, () => {
  console.log(`Esperando el login en el navegador (puerto ${PORT})...`);
});
