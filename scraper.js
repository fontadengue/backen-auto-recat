const { chromium } = require('playwright');

const LOGIN_URL = 'https://auth.afip.gob.ar/contribuyente_/login.xhtml';
const PORTAL_URL_FRAGMENT = 'portalcf.cloud.afip.gob.ar';
const DEFAULT_DATE_RANGE = process.env.RANGO_FECHAS || '01/07/2025 - 30/06/2026';
const NAV_TIMEOUT = 45000;

function parseImporteArg(texto) {
  if (!texto) return 0;
  // "12.381,39" -> 12381.39 ; saca $ y espacios/no-break-space
  const limpio = texto.replace(/[^\d.,-]/g, '').replace(/\./g, '').replace(',', '.');
  const num = parseFloat(limpio);
  return Number.isNaN(num) ? 0 : num;
}

/**
 * Espera a que se abra una pestaña nueva (si la abre) al hacer una acción.
 * Si no se abre ninguna, devuelve la misma página.
 */
async function clickAndMaybeGetNewPage(context, page, clickFn, timeout = 8000) {
  const popupPromise = context.waitForEvent('page', { timeout }).catch(() => null);
  await clickFn();
  const newPage = await popupPromise;
  if (newPage) {
    await newPage.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
    return newPage;
  }
  return page;
}

async function buscarYAbrirServicio(context, portalPage, nombreServicio, textoParaClick) {
  const input = portalPage.locator('#buscadorInput');
  await input.click();
  await input.fill('');
  await input.type(nombreServicio, { delay: 60 });
  // Esperar a que aparezca la opción en el listado
  const opcion = portalPage.locator(`p.text-muted:has-text("${textoParaClick}")`).first();
  await opcion.waitFor({ state: 'visible', timeout: 15000 });

  const servicioPage = await clickAndMaybeGetNewPage(context, portalPage, async () => {
    await opcion.click();
  });
  return servicioPage;
}

async function login(context, cuit, clave) {
  const page = await context.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

  await page.locator('#F1\\:username').fill(cuit);
  await page.locator('#F1\\:btnSiguiente').click();

  await page.locator('#F1\\:password').waitFor({ state: 'visible', timeout: NAV_TIMEOUT });
  await page.locator('#F1\\:password').fill(clave);
  await page.locator('#F1\\:btnIngresar').click();

  // Esperar a que redirija al portal
  await page.waitForURL(new RegExp(PORTAL_URL_FRAGMENT), { timeout: NAV_TIMEOUT }).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});

  // Chequeo básico de error de login (usuario/clave incorrecta)
  const posibleError = await page.locator('text=/clave.*incorrect|usuario.*incorrect|CUIT.*inv[aá]lid/i').first();
  if (await posibleError.isVisible().catch(() => false)) {
    const msg = await posibleError.innerText().catch(() => 'Error de login');
    throw new Error(`Login falló: ${msg}`);
  }

  return page;
}

async function obtenerNombreCliente(portalPage) {
  const nombreLocator = portalPage.locator('strong.text-primary').first();
  await nombreLocator.waitFor({ state: 'visible', timeout: NAV_TIMEOUT }).catch(() => {});
  const nombre = await nombreLocator.innerText().catch(() => '');
  return nombre.trim();
}

async function obtenerFacturacionMonotributo(context, portalPage) {
  const monoPage = await buscarYAbrirServicio(context, portalPage, 'Monotributo', 'Monotributo');

  const facturometro = monoPage.locator('#spanFacturometroMontoMobile');
  await facturometro.waitFor({ state: 'visible', timeout: NAV_TIMEOUT });
  const texto = await facturometro.innerText();
  const monto = parseImporteArg(texto);

  if (monoPage !== portalPage) {
    await monoPage.close().catch(() => {});
  }
  return monto;
}

async function sumarComprobantesEnPaginaActual(page) {
  // Ajustar el selector de filas según la tabla real (#tablaDataTables)
  const filas = page.locator('#tablaDataTables tbody tr');
  const total = await filas.count();
  let acumulado = 0;

  for (let i = 0; i < total; i++) {
    const fila = filas.nth(i);
    const celdas = fila.locator('td');
    const tipoTexto = (await celdas.nth(0).innerText().catch(() => '')).toLowerCase();
    // El importe suele estar en una celda con class="alignRight" y span.moneda
    const importeTexto = await fila.locator('td.alignRight').first().innerText().catch(() => '0');
    const importe = parseImporteArg(importeTexto);

    if (tipoTexto.includes('nota de cr')) {
      acumulado -= importe;
    } else if (tipoTexto.includes('factura') || tipoTexto.includes('nota de d')) {
      acumulado += importe;
    }
  }
  return acumulado;
}

async function obtenerComprobantesRecibidos(context, portalPage, rangoFechas) {
  const comprobantesPage = await buscarYAbrirServicio(context, portalPage, 'Mis Comprobantes', 'Mis Comprobantes');

  // Click en "Recibidos"
  const recibidos = comprobantesPage.locator('div.panel-body:has(h3:text-is("Recibidos"))').first();
  await recibidos.waitFor({ state: 'visible', timeout: NAV_TIMEOUT });
  await recibidos.click();

  // Filtro de fecha
  const fechaInput = comprobantesPage.locator('#fechaEmision');
  await fechaInput.waitFor({ state: 'visible', timeout: NAV_TIMEOUT });
  await fechaInput.click();
  await fechaInput.fill('');
  await fechaInput.type(rangoFechas, { delay: 30 });

  await comprobantesPage.locator('button.applyBtn.btn-success').click();
  await comprobantesPage.locator('#buscarComprobantes').click();

  // Esperar a que cargue la tabla
  await comprobantesPage.locator('#tablaDataTables').waitFor({ state: 'visible', timeout: NAV_TIMEOUT });

  // Cambiar a 50 resultados por página
  const selectorCantidad = comprobantesPage.locator('span:has-text("5")').first();
  if (await selectorCantidad.isVisible().catch(() => false)) {
    await selectorCantidad.click();
    const opcion50 = comprobantesPage.locator('a:text-is("50")').first();
    if (await opcion50.isVisible().catch(() => false)) {
      await opcion50.click();
      await comprobantesPage.waitForTimeout(1500); // esperar recarga de tabla
    }
  }

  let total = 0;
  let pagina = 1;
  const MAX_PAGINAS = 200; // salvaguarda contra loops infinitos

  while (pagina <= MAX_PAGINAS) {
    total += await sumarComprobantesEnPaginaActual(comprobantesPage);

    const siguiente = comprobantesPage.locator('a[aria-controls="tablaDataTables"]:has-text("»")').first();
    const contenedorLi = siguiente.locator('xpath=..');
    const estaDeshabilitado = await contenedorLi.evaluate((el) => el.classList.contains('disabled')).catch(() => true);

    if (estaDeshabilitado) break;

    await siguiente.click();
    await comprobantesPage.waitForTimeout(1200); // esperar recarga de la tabla
    pagina++;
  }

  if (comprobantesPage !== portalPage) {
    await comprobantesPage.close().catch(() => {});
  }

  return total;
}

/**
 * Procesa un cliente completo: login, monotributo, mis comprobantes.
 * Devuelve un objeto resultado, nunca lanza (captura errores internamente).
 */
async function procesarCliente(browser, cuit, clave, rangoFechas = DEFAULT_DATE_RANGE) {
  const context = await browser.newContext();
  const resultado = { cuit, nombre: '', facturacionMonotributo: null, comprobantesRecibidos: null, error: null };

  try {
    const portalPage = await login(context, cuit, clave);
    resultado.nombre = await obtenerNombreCliente(portalPage);
    resultado.facturacionMonotributo = await obtenerFacturacionMonotributo(context, portalPage);
    resultado.comprobantesRecibidos = await obtenerComprobantesRecibidos(context, portalPage, rangoFechas);
  } catch (err) {
    resultado.error = err.message || String(err);
  } finally {
    await context.close().catch(() => {});
  }

  return resultado;
}

async function procesarClientes(clientes, onProgress, rangoFechas) {
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
  });

  const resultados = [];
  try {
    for (let i = 0; i < clientes.length; i++) {
      const { cuit, clave } = clientes[i];
      const resultado = await procesarCliente(browser, cuit, clave, rangoFechas);
      resultados.push(resultado);
      if (onProgress) onProgress({ index: i + 1, total: clientes.length, resultado });

      // Pausa entre clientes para no parecer un bot agresivo
      const delay = Number(process.env.DELAY_MS || 3000);
      if (delay > 0 && i < clientes.length - 1) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return resultados;
}

module.exports = { procesarClientes, procesarCliente };
