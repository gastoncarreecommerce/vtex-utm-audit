// Configuración de tu arquitectura
const VTEX_ACCOUNT = 'carrefourar'; 
const SELLER_ID = 'carrefourar0002'; // La sucursal
const SALES_CHANNEL = 5; // La política de MELI

// Tus secrets de GitHub
const API_KEY = process.env.VTEX_API_KEY;
const API_TOKEN = process.env.VTEX_API_TOKEN;

// Acá ponés los SKUs que querés auditar (podés inyectarlos leyendo un CSV o JSON en tu action)
const skusToCheck = ["24725", "204145"];

async function getVtexRealPrice(sku) {
  // Endpoint de simulación (forzando la política comercial 5)
  const url = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br/api/checkout/pub/orderForms/simulation?sc=${SALES_CHANNEL}`;
  
  // Le decimos a VTEX: "Simulame una compra de 1 unidad de este SKU en la sucursal carrefourar0002"
  const payload = {
    items: [{
      id: sku,
      quantity: 1,
      seller: SELLER_ID
    }]
  };

  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-VTEX-API-AppKey': API_KEY,
      'X-VTEX-API-AppToken': API_TOKEN
    },
    body: JSON.stringify(payload)
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    
    // Si el item tiene precio y stock en ese seller, VTEX lo devuelve en el array 'items'
    if (data.items && data.items.length > 0) {
      // OJO: VTEX devuelve los precios multiplicados por 100 (ej: 648300). Hay que dividirlo.
      const price = data.items[0].price / 100; 
      return price;
    } else {
      return "Sin stock / No disponible en este seller";
    }
  } catch (error) {
    console.error(`Error consultando SKU ${sku} en VTEX:`, error);
    return null;
  }
}

async function runAudit() {
  console.log(`--- Iniciando Auditoría de Precios ---`);
  console.log(`Tienda: ${SELLER_ID} | Política: ${SALES_CHANNEL}\n`);
  
  for (const sku of skusToCheck) {
    const vtexPrice = await getVtexRealPrice(sku);
    
    console.log(`SKU: ${sku} | Precio VTEX: $${vtexPrice}`);
    
    // ACÁ ES DONDE CRUZÁS LA DATA:
    // Podés agregar una llamada a la API de Janis para traer el precio que ellos tienen,
    // o compararlo contra un JSON exportado de Janis.
    // Ejemplo lógico:
    // const janisPrice = await getJanisPrice(sku);
    // if (vtexPrice !== janisPrice) {
    //    console.log(`-> ALERTA: Desfasaje en SKU ${sku}. VTEX: $${vtexPrice} vs JANIS: $${janisPrice}`);
    // }
  }
}

// Ejecutar
runAudit();
