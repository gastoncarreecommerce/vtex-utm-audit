/**
 * Vercel Edge Middleware — protege los DATOS, no la pantalla.
 *
 * Por qué existe: el login de docs/app.html es JavaScript en el browser. Tapa
 * y destapa la UI, pero no impide nada: los archivos de datos se bajan
 * escribiendo la URL directa. Y `DATA_BASE` (app.html) apunta al mismo origen,
 * así que docs/data/daily/<fecha>-rows.json —103.229 filas, cada una con el
 * email del cliente— quedaba accesible sin loguearse. Este middleware corre en
 * el edge ANTES de servir cualquier archivo estático, así que también cubre los
 * JSON.
 *
 * Alcance a propósito CHICO: el matcher toma solo /data/ y /api/. El HTML, el
 * CSS y el JS siguen siendo públicos, así que la pantalla de login siempre
 * carga. Si algo de esto estuviera mal, el peor caso es que los datos den 401
 * —y el dashboard pide loguearse de nuevo— nunca una página en blanco.
 *
 * El token es el MISMO que ya emite /api/login (HMAC-SHA256 sobre
 * `usuario:expiry`, base64url). Lo único que se sumó es que login además lo
 * deja en una cookie httpOnly, porque un token en localStorage no viaja solo
 * en los fetch de los archivos estáticos y el edge no tiene forma de verlo.
 *
 * Env vars requeridas en Vercel (las mismas que ya usa /api/login):
 *   DASHBOARD_PASSWORD
 *   SESSION_SECRET
 */
export const config = {
  // Solo lo que hay que proteger. /api/login se deja pasar en el handler.
  matcher: ['/data/:path*', '/api/:path*'],
};

const COOKIE = 'appdash_session';

function toBytes(str) {
  return new TextEncoder().encode(str);
}

function hexOf(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey('raw', toBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hexOf(await crypto.subtle.sign('HMAC', key, toBytes(payload)));
}

/** Comparación en tiempo constante: evita filtrar la firma por diferencia de tiempos. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function isValidToken(token, secret) {
  if (!token) return false;
  let decoded;
  try {
    decoded = atob(token.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return false;
  }
  const idx = decoded.lastIndexOf(':');
  if (idx < 0) return false;
  const payload = decoded.slice(0, idx);
  const sig = decoded.slice(idx + 1);

  const expiry = Number(payload.slice(payload.lastIndexOf(':') + 1));
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;

  return safeEqual(sig, await hmacHex(secret, payload));
}

export default async function middleware(request) {
  const url = new URL(request.url);

  // El login tiene que quedar afuera o nadie puede entrar nunca más.
  if (url.pathname.startsWith('/api/login')) return;

  const secret = process.env.SESSION_SECRET;
  const password = process.env.DASHBOARD_PASSWORD;

  // Sin auth configurada NO se sirve dato sensible: se falla hacia el lado
  // seguro en vez de dejar todo abierto.
  if (!secret || !password) {
    return new Response(
      JSON.stringify({ error: 'Auth no configurado: faltan DASHBOARD_PASSWORD y SESSION_SECRET en Vercel.' }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    );
  }

  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (await isValidToken(match?.[1], secret)) return; // sesión válida: seguir

  // Siempre 401 en JSON, nunca un redirect: estas rutas las pide fetch(), y un
  // redirect a HTML haría que el cliente intente parsear una página como JSON.
  return new Response(JSON.stringify({ error: 'No autenticado' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}
