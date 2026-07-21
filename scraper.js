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

/**
 * Busca un selector tanto en la página principal como dentro de cualquier
 * iframe que tenga (muchos servicios de AFIP se cargan embebidos en un
 * iframe dentro de la misma pestaña, en vez de abrir una pestaña nueva).
 * Devuelve { scope, locator } donde scope es la Page o el Frame donde
 * apareció, o null si no lo encontró en el tiempo dado.
 */
async function waitForSelectorAnywhere(page, selector, timeout = 25000, state = 'visible') {
  const deadline = Date.now() + timeout;
  const checks = {
    visible: async (loc) => loc.isVisible().catch(() => false),
    attached: async (loc) => (await loc.count().catch(() => 0)) > 0,
    'attached-nonempty': async (loc) => {
      if ((await loc.count().catch(() => 0)) === 0) return false;
      const texto = await loc.textContent().catch(() => '');
      return !!(texto && texto.trim().length > 0);
    },
  };
  const check = checks[state] || checks.visible;

  while (Date.now() < deadline) {
    const mainLoc = page.locator(selector).first();
    if (await check(mainLoc)) return { scope: page, locator: mainLoc };

    for (const frame of page.frames()) {
      const loc = frame.locator(selector).first();
      if (await check(loc)) return { scope: frame, locator: loc };
    }
    await page.waitForTimeout(500);
  }
  return null;
}

/**
 * Guarda un screenshot en el array de debug del resultado, con un label
 * descriptivo. Nunca lanza error (si falla el screenshot, sigue de largo).
 */
async function capturarDebug(page, label, debugArr) {
  try {
    const buffer = await page.screenshot({ fullPage: true, timeout: 8000 });
    debugArr.push({ label, buffer, url: page.url() });
  } catch (_) {
    // si no se puede sacar el screenshot, no interrumpe el flujo
  }
}

async function buscarYAbrirServicio(context, portalPage, nombreServicio, textoParaClick, debugArr) {
  const input = portalPage.locator('#buscadorInput');
  await input.click();
  await input.fill('');
  await input.type(nombreServicio, { delay: 60 });

  // Le damos un respiro al debounce del buscador antes de mirar los resultados,
  // para no clickear una lista vieja (recientes/frecuentes) que todavía no
  // se actualizó con el filtro que acabamos de tipear.
  await portalPage.waitForTimeout(900);

  if (debugArr) await capturarDebug(portalPage, `buscador-resultados-${textoParaClick}`, debugArr);

  // Coincidencia EXACTA de texto (no substring) para no clickear un resultado
  // parecido por error (ej: la descripción de otro servicio menciona la palabra).
  const opcion = portalPage.locator(`p.small.text-muted:text-is("${textoParaClick}")`).first();
  await opcion.waitFor({ state: 'visible', timeout: 15000 });
  await opcion.scrollIntoViewIfNeeded().catch(() => {});

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

async function obtenerFacturacionMonotributo(context, portalPage, debugArr) {
  // Ya no se busca "Monotributo" por el buscador: hay un botón "Ingresar"
  // directo en el home del portal (tarjeta de Monotributo) que abre la
  // pestaña del sistema de Monotributo.
  const botonIngresar = await waitForSelectorAnywhere(
    portalPage,
    'button.btn-primary.btn-breakline:text-is("Ingresar")',
    NAV_TIMEOUT,
    'visible'
  );
  if (!botonIngresar) {
    await capturarDebug(portalPage, 'boton-ingresar-monotributo-no-encontrado', debugArr);
    throw new Error(`No se encontró el botón "Ingresar" de Monotributo en el home (url: ${portalPage.url()}). Revisar screenshot de debug.`);
  }

  const monoPage = await clickAndMaybeGetNewPage(context, portalPage, async () => {
    await botonIngresar.locator.click();
  });
  await capturarDebug(monoPage, 'monotributo-abierto', debugArr);

  // Antes de que aparezca el monto hay que clickear "Recategorizarme"
  // (dispara un __doPostBack de ASP.NET, puede recargar la página)
  const botonRecategorizar = await waitForSelectorAnywhere(monoPage, '#bBtn1', NAV_TIMEOUT, 'visible');
  if (!botonRecategorizar) {
    await capturarDebug(monoPage, 'boton-recategorizarme-no-encontrado', debugArr);
    if (monoPage !== portalPage) await monoPage.close().catch(() => {});
    throw new Error(`No se encontró el botón #bBtn1 "Recategorizarme" (url: ${monoPage.url()}). Revisar screenshot de debug.`);
  }

  await Promise.all([
    monoPage.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {}),
    botonRecategorizar.locator.click(),
  ]);
  await capturarDebug(monoPage, 'monotributo-post-recategorizarme', debugArr);

  // El id incluye "Mobile": puede estar oculto por CSS en viewport de escritorio.
  // Por eso esperamos que esté "attached" (presente en el DOM) en vez de "visible",
  // y leemos con textContent, que funciona aunque el elemento esté oculto.
  const encontrado = await waitForSelectorAnywhere(
    monoPage,
    '#spanMontoCalculado',
    NAV_TIMEOUT,
    'attached-nonempty'
  );

  if (!encontrado) {
    await capturarDebug(monoPage, 'monotributo-facturometro-no-encontrado', debugArr);
    if (monoPage !== portalPage) await monoPage.close().catch(() => {});
    throw new Error(
      `No se encontró #spanMontoCalculado en Monotributo (url: ${monoPage.url()}). Revisar screenshot de debug.`
    );
  }

  const texto = await encontrado.locator.textContent();
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

async function abrirMisComprobantesDesdePortal(context, portalPage, debugArr) {
  const verTodos = await waitForSelectorAnywhere(portalPage, 'a:text-is("Ver todos")', NAV_TIMEOUT, 'visible');
  if (!verTodos) {
    await capturarDebug(portalPage, 'link-ver-todos-no-encontrado', debugArr);
    throw new Error(`No se encontró el link "Ver todos" en el home (url: ${portalPage.url()}). Revisar screenshot de debug.`);
  }
  await verTodos.locator.click();
  await portalPage.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
  await capturarDebug(portalPage, 'mis-servicios-listado', debugArr);

  const tarjeta = await waitForSelectorAnywhere(
    portalPage,
    'div.media:has(h3:text-is("MIS COMPROBANTES"))',
    NAV_TIMEOUT,
    'visible'
  );
  if (!tarjeta) {
    await capturarDebug(portalPage, 'tarjeta-mis-comprobantes-no-encontrada', debugArr);
    throw new Error(`No se encontró la tarjeta "MIS COMPROBANTES" en /mis-servicios (url: ${portalPage.url()}). Revisar screenshot de debug.`);
  }

  const comprobantesPage = await clickAndMaybeGetNewPage(context, portalPage, async () => {
    await tarjeta.locator.click();
  });
  await capturarDebug(comprobantesPage, 'mis-comprobantes-abierto', debugArr);
  return comprobantesPage;
}

async function obtenerComprobantesRecibidos(context, portalPage, rangoFechas, debugArr) {
  const comprobantesPage = await abrirMisComprobantesDesdePortal(context, portalPage, debugArr);

  // Click en "Recibidos"
  const panelRecibidos = await waitForSelectorAnywhere(
    comprobantesPage,
    'div.panel-body:has(h3:text-is("Recibidos"))',
    NAV_TIMEOUT
  );
  if (!panelRecibidos) {
    await capturarDebug(comprobantesPage, 'panel-recibidos-no-encontrado', debugArr);
    if (comprobantesPage !== portalPage) await comprobantesPage.close().catch(() => {});
    throw new Error(`No se encontró el panel "Recibidos" (url: ${comprobantesPage.url()}). Revisar screenshot de debug.`);
  }
  await panelRecibidos.locator.click();

  // Filtro de fecha
  const fechaEncontrado = await waitForSelectorAnywhere(comprobantesPage, '#fechaEmision', NAV_TIMEOUT);
  if (!fechaEncontrado) {
    await capturarDebug(comprobantesPage, 'filtro-fecha-no-encontrado', debugArr);
    if (comprobantesPage !== portalPage) await comprobantesPage.close().catch(() => {});
    throw new Error(`No se encontró #fechaEmision (url: ${comprobantesPage.url()}). Revisar screenshot de debug.`);
  }
  const fechaInput = fechaEncontrado.locator;
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
  const debug = [];
  const resultado = {
    cuit,
    nombre: '',
    facturacionMonotributo: null,
    comprobantesRecibidos: null,
    error: null,
    debug,
  };

  try {
    const portalPage = await login(context, cuit, clave);
    await capturarDebug(portalPage, 'post-login-portal', debug);

    resultado.nombre = await obtenerNombreCliente(portalPage);
    resultado.facturacionMonotributo = await obtenerFacturacionMonotributo(context, portalPage, debug);
    resultado.comprobantesRecibidos = await obtenerComprobantesRecibidos(context, portalPage, rangoFechas, debug);
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
