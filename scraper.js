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
    'div.media:has(h4.title:text-is("Recategorización")) button.btn-primary.btn-breakline:text-is("Ingresar")',
    NAV_TIMEOUT,
    'visible'
  );
  if (!botonIngresar) {
    await capturarDebug(portalPage, 'boton-ingresar-monotributo-no-encontrado', debugArr);
    throw new Error(`No se encontró el botón "Ingresar" de Monotributo en el home (url: ${portalPage.url()}). Revisar screenshot de debug.`);
  }

  await botonIngresar.locator.scrollIntoViewIfNeeded().catch(() => {});
  const urlAntesDelClick = portalPage.url();
  const monoPage = await clickAndMaybeGetNewPage(context, portalPage, async () => {
    await botonIngresar.locator.click();
  }, 20000);

  if (monoPage === portalPage) {
    // No se abrió pestaña nueva: puede haber navegado en la misma pestaña,
    // le damos un margen para que termine de cargar.
    await portalPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  }
  await capturarDebug(monoPage, 'monotributo-abierto', debugArr);

  if (monoPage === portalPage && portalPage.url() === urlAntesDelClick) {
    throw new Error(
      `El click en "Ingresar" (Recategorización) no abrió pestaña nueva ni navegó (sigue en ${portalPage.url()}). Revisar screenshot de debug "monotributo-abierto".`
    );
  }

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
  let categorizadas = 0;
  let importeNoParseado = 0;

  for (let i = 0; i < total; i++) {
    const fila = filas.nth(i);
    const celdas = fila.locator('td');
    const tipoTexto = (await celdas.nth(1).innerText().catch(() => '')).toLowerCase();
    // El importe suele estar en una celda con class="alignRight" y span.moneda
    const importeTexto = await fila.locator('td.alignRight').first().innerText().catch(() => '');
    const importe = parseImporteArg(importeTexto);
    if (importeTexto.trim() && importe === 0 && !/^[\s$.,0]*$/.test(importeTexto)) {
      importeNoParseado++;
    }

    let signo = 0;
    if (tipoTexto.includes('nota de cr')) {
      acumulado -= importe;
      signo = -1;
      categorizadas++;
    } else if (tipoTexto.includes('factura') || tipoTexto.includes('nota de d')) {
      acumulado += importe;
      signo = 1;
      categorizadas++;
    }
    console.log(`  fila ${i}: tipo="${tipoTexto.trim()}" importeTexto="${importeTexto.trim()}" importe=${importe} signo=${signo}`);
  }
  console.log(`  subtotal de la página: ${acumulado} (${total} filas, ${categorizadas} categorizadas, ${importeNoParseado} importes sin parsear bien)`);
  return { subtotal: acumulado, filas: total, categorizadas, importeNoParseado };
}

async function abrirServicioDesdeMisServicios(context, portalPage, tituloTarjeta, debugArr) {
  const yaEnMisServicios = portalPage.url().includes('/mis-servicios');

  if (!yaEnMisServicios) {
    const verTodos = await waitForSelectorAnywhere(portalPage, 'a:text-is("Ver todos")', NAV_TIMEOUT, 'visible');
    if (!verTodos) {
      await capturarDebug(portalPage, 'link-ver-todos-no-encontrado', debugArr);
      throw new Error(`No se encontró el link "Ver todos" en el home (url: ${portalPage.url()}). Revisar screenshot de debug.`);
    }
    await verTodos.locator.click();
    await portalPage.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
    await capturarDebug(portalPage, 'mis-servicios-listado', debugArr);
  }

  const tarjeta = await waitForSelectorAnywhere(
    portalPage,
    `div.media:has(h3:text-is("${tituloTarjeta}"))`,
    NAV_TIMEOUT,
    'visible'
  );
  if (!tarjeta) {
    await capturarDebug(portalPage, `tarjeta-no-encontrada-${tituloTarjeta}`, debugArr);
    throw new Error(`No se encontró la tarjeta "${tituloTarjeta}" en /mis-servicios (url: ${portalPage.url()}). Revisar screenshot de debug.`);
  }

  const servicioPage = await clickAndMaybeGetNewPage(context, portalPage, async () => {
    await tarjeta.locator.click();
  });

  // Estas apps suelen tardar en cargar del todo; esperamos a que la red se
  // calme (detección), no un tiempo fijo arbitrario.
  await servicioPage.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  await servicioPage.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

  return servicioPage;
}

const TITULO_CCMA = "CCMA - CUENTA CORRIENTE DE CONTRIBUYENTES MONOTRIBUTISTAS Y AUTONOMOS";

async function abrirMisComprobantesDesdePortal(context, portalPage, debugArr) {
  return abrirServicioDesdeMisServicios(context, portalPage, 'MIS COMPROBANTES', debugArr);
}

async function obtenerDeudaCCMA(context, portalPage, debugArr) {
  const ccmaPage = await abrirServicioDesdeMisServicios(context, portalPage, TITULO_CCMA, debugArr);
  await capturarDebug(ccmaPage, 'ccma-abierto', debugArr);

  // Borrar el período y cargar 01/2004
  const perInput = await waitForSelectorAnywhere(ccmaPage, 'input[name="perdesde2"]', 60000, 'visible');
  if (!perInput) {
    await capturarDebug(ccmaPage, 'ccma-input-periodo-no-encontrado', debugArr);
    if (ccmaPage !== portalPage) await ccmaPage.close().catch(() => {});
    throw new Error(`No se encontró el input de período (perdesde2) en CCMA (url: ${ccmaPage.url()}). Revisar screenshot de debug.`);
  }
  await perInput.locator.click();
  await perInput.locator.fill('');
  await perInput.locator.type('01/2004', { delay: 40 });
  await capturarDebug(ccmaPage, 'ccma-periodo-cargado', debugArr);

  // Click en "CALCULO DE DEUDA"
  const botonCalculo = await waitForSelectorAnywhere(ccmaPage, 'input[name="CalDeud"]', 30000, 'visible');
  if (!botonCalculo) {
    await capturarDebug(ccmaPage, 'ccma-boton-calculo-no-encontrado', debugArr);
    if (ccmaPage !== portalPage) await ccmaPage.close().catch(() => {});
    throw new Error(`No se encontró el botón "CALCULO DE DEUDA" en CCMA (url: ${ccmaPage.url()}). Revisar screenshot de debug.`);
  }
  await botonCalculo.locator.click();

  // Esperar a que cargue la página de resultados
  await ccmaPage.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  await ccmaPage.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  await capturarDebug(ccmaPage, 'ccma-calculo-deuda-cargado', debugArr);

  // Si no aparece la sección de Monotributo - Obligaciones, el cliente no
  // tiene deuda de monotributo: deuda CCMA = 0, sin marcar error.
  const filaObligaciones = await waitForSelectorAnywhere(
    ccmaPage,
    'tr:has-text("MONOTRIBUTO - OBLIGACIONES")',
    20000,
    'attached'
  );
  if (!filaObligaciones) {
    await capturarDebug(ccmaPage, 'ccma-sin-monotributo', debugArr);
    if (ccmaPage !== portalPage) await ccmaPage.close().catch(() => {});
    return 0;
  }

  // Click en "VOLANTE DE PAGO"
  const botonVolante = await waitForSelectorAnywhere(ccmaPage, 'input[name="GENVOL"]', 30000, 'visible');
  if (!botonVolante) {
    await capturarDebug(ccmaPage, 'ccma-boton-volante-no-encontrado', debugArr);
    if (ccmaPage !== portalPage) await ccmaPage.close().catch(() => {});
    throw new Error(`No se encontró el botón "VOLANTE DE PAGO" en CCMA (url: ${ccmaPage.url()}). Revisar screenshot de debug.`);
  }

  const urlAntesDeVolante = ccmaPage.url();
  const volantePage = await clickAndMaybeGetNewPage(context, ccmaPage, async () => {
    await botonVolante.locator.click();
  }, 20000);

  if (volantePage === ccmaPage) {
    // No se abrió pestaña nueva: puede haber navegado en la misma pestaña,
    // le damos margen a que termine de cargar antes de decidir si falló.
    await ccmaPage.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  }
  await volantePage.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  await volantePage.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  await capturarDebug(volantePage, 'ccma-volante-abierto', debugArr);

  if (volantePage === ccmaPage && volantePage.url() === urlAntesDeVolante) {
    if (ccmaPage !== portalPage) await ccmaPage.close().catch(() => {});
    throw new Error(
      `El click en "VOLANTE DE PAGO" no abrió pestaña nueva ni navegó (sigue en ${ccmaPage.url()}). Revisar screenshot "ccma-volante-abierto".`
    );
  }

  // Seleccionar todos en Monotributo - Obligaciones. Si no aparece este link
  // acá, algo salió mal con la navegación (no es un caso válido de "sin
  // monotributo", porque ya confirmamos antes que existía la fila de
  // obligaciones en la página anterior) — lo tratamos como error, no como 0.
  const linkMC = await waitForSelectorAnywhere(volantePage, 'a[href*="select_todos(\'MC\')"]', 30000, 'visible');
  if (!linkMC) {
    await capturarDebug(volantePage, 'ccma-link-mc-no-encontrado', debugArr);
    if (volantePage !== ccmaPage) await volantePage.close().catch(() => {});
    if (ccmaPage !== portalPage) await ccmaPage.close().catch(() => {});
    throw new Error(
      `No se encontró el link "Seleccionar todos" de Monotributo Obligaciones en el volante de pago (url: ${volantePage.url()}). Revisar screenshot "ccma-link-mc-no-encontrado".`
    );
  }
  await linkMC.locator.click();

  // Seleccionar todos en Monotributo - Intereses (puede no existir si no hay intereses)
  const linkMI = await waitForSelectorAnywhere(volantePage, 'a[href*="select_todos(\'MI\')"]', 15000, 'visible');
  if (linkMI) {
    await linkMI.locator.click();
  }

  // Click en "GENERAR VEP O QR"
  const botonVEP = await waitForSelectorAnywhere(volantePage, '#GenerarVEP', 30000, 'visible');
  if (!botonVEP) {
    await capturarDebug(volantePage, 'ccma-boton-generar-vep-no-encontrado', debugArr);
    if (ccmaPage !== portalPage) await ccmaPage.close().catch(() => {});
    if (volantePage !== ccmaPage) await volantePage.close().catch(() => {});
    throw new Error(`No se encontró el botón "GENERAR VEP O QR" (url: ${volantePage.url()}). Revisar screenshot de debug.`);
  }
  await botonVEP.locator.click();

  // Leer el importe total a pagar
  const importeEncontrado = await waitForSelectorAnywhere(
    volantePage,
    'div:has(strong:has-text("Importe Total a pagar"))',
    60000,
    'attached-nonempty'
  );
  await capturarDebug(volantePage, 'ccma-importe-total', debugArr);

  if (!importeEncontrado) {
    await capturarDebug(volantePage, 'ccma-importe-no-encontrado', debugArr);
    if (volantePage !== ccmaPage) await volantePage.close().catch(() => {});
    if (ccmaPage !== portalPage) await ccmaPage.close().catch(() => {});
    throw new Error(
      `No se encontró el "Importe Total a pagar" después de Generar VEP (url: ${volantePage.url()}). Revisar screenshot "ccma-importe-no-encontrado" — no confiar en un 0 acá, hay que revisar qué pasó.`
    );
  }
  const texto = await importeEncontrado.locator.textContent();
  const monto = parseImporteArg(texto);

  if (volantePage !== ccmaPage) await volantePage.close().catch(() => {});
  if (ccmaPage !== portalPage) await ccmaPage.close().catch(() => {});

  return monto;
}

async function esperarProcesamientoTabla(page, timeout = 20000) {
  // DataTables muestra un overlay "Processing..." mientras recarga la tabla;
  // si existe, esperamos a que se oculte. Si no existe, no hacemos nada más
  // (el próximo waitFor de la fila ya se encarga de esperar contenido real).
  const processing = page.locator('#tablaDataTables_processing');
  const hayProcessing = await processing.count().catch(() => 0);
  if (hayProcessing > 0) {
    await processing.waitFor({ state: 'hidden', timeout }).catch(() => {});
  }
}

async function obtenerComprobantesRecibidos(context, portalPage, rangoFechas, debugArr) {
  const comprobantesPage = await abrirMisComprobantesDesdePortal(context, portalPage, debugArr);
  await capturarDebug(comprobantesPage, 'mis-comprobantes-cargado', debugArr);

  // Click en "Recibidos" — se espera a que el panel aparezca, sin tiempo fijo
  const panelRecibidos = await waitForSelectorAnywhere(
    comprobantesPage,
    'div.panel-body:has(h3:text-is("Recibidos"))',
    120000
  );
  if (!panelRecibidos) {
    await capturarDebug(comprobantesPage, 'panel-recibidos-no-encontrado', debugArr);
    if (comprobantesPage !== portalPage) await comprobantesPage.close().catch(() => {});
    throw new Error(`No se encontró el panel "Recibidos" (url: ${comprobantesPage.url()}). Revisar screenshot de debug.`);
  }
  await panelRecibidos.locator.click();

  // Filtro de fecha — se espera a que el input exista, sin tiempo fijo
  const fechaEncontrado = await waitForSelectorAnywhere(comprobantesPage, '#fechaEmision', 60000);
  if (!fechaEncontrado) {
    await capturarDebug(comprobantesPage, 'filtro-fecha-no-encontrado', debugArr);
    if (comprobantesPage !== portalPage) await comprobantesPage.close().catch(() => {});
    throw new Error(`No se encontró #fechaEmision (url: ${comprobantesPage.url()}). Revisar screenshot de debug.`);
  }
  const fechaInput = fechaEncontrado.locator;
  await fechaInput.click();
  await fechaInput.fill('');
  await fechaInput.type(rangoFechas, { delay: 40 });

  // Click afuera del calendario para que se cierre el date picker (en el
  // label del campo, que siempre está visible y no dispara ninguna acción)
  const scopeFecha = fechaEncontrado.scope;
  await scopeFecha
    .locator('label[for="fechaEmision"]')
    .first()
    .click({ timeout: 10000 })
    .catch(() => scopeFecha.locator('body').click({ timeout: 10000 }).catch(() => {}));

  await capturarDebug(comprobantesPage, 'fecha-completada', debugArr);

  await comprobantesPage.locator('button.applyBtn.btn-success').click();
  await comprobantesPage.locator('#buscarComprobantes').click();

  // Esperar a que cargue la tabla (por detección, no por tiempo fijo)
  await comprobantesPage.locator('#tablaDataTables').waitFor({ state: 'visible', timeout: 60000 });
  await esperarProcesamientoTabla(comprobantesPage);
  await comprobantesPage.locator('#tablaDataTables tbody tr').first().waitFor({ state: 'visible', timeout: 60000 });
  await capturarDebug(comprobantesPage, 'tabla-comprobantes-cargada', debugArr);

  // Cambiar a 50 resultados por página (ícono de barras -> opción "50")
  const iconoBarras = comprobantesPage.locator('i.fa-bars').first();
  if (await iconoBarras.isVisible().catch(() => false)) {
    await iconoBarras.click();
    const opcion50 = comprobantesPage.locator('li.button-page-length a:text-is("50")').first();
    const dropdownAbierto = await opcion50.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
    await capturarDebug(comprobantesPage, 'selector-cantidad-abierto', debugArr);

    if (dropdownAbierto) {
      await opcion50.click();
      await esperarProcesamientoTabla(comprobantesPage);
      await comprobantesPage.locator('#tablaDataTables tbody tr').first().waitFor({ state: 'visible', timeout: 60000 });
      await capturarDebug(comprobantesPage, 'tabla-50-aplicado', debugArr);
    } else {
      // No se pudo confirmar el dropdown de cantidad; seguimos igual, la
      // paginación con "»" va a recorrer todas las páginas de todos modos,
      // solo que con más páginas (más lento, no incorrecto).
      await capturarDebug(comprobantesPage, 'selector-cantidad-no-confirmado', debugArr);
    }
  } else {
    await capturarDebug(comprobantesPage, 'icono-bars-no-encontrado', debugArr);
  }

  let total = 0;
  let filasTotales = 0;
  let categorizadasTotales = 0;
  let pagina = 1;
  const MAX_PAGINAS = 200; // salvaguarda contra loops infinitos

  async function fingerprintPrimeraFila() {
    return comprobantesPage.locator('#tablaDataTables tbody tr').first().innerText().catch(() => '');
  }

  while (pagina <= MAX_PAGINAS) {
    const { subtotal, filas, categorizadas } = await sumarComprobantesEnPaginaActual(comprobantesPage);
    total += subtotal;
    filasTotales += filas;
    categorizadasTotales += categorizadas;

    const siguiente = comprobantesPage.locator('a[aria-controls="tablaDataTables"]:has-text("»")').first();
    const contenedorLi = siguiente.locator('xpath=..');
    const estaDeshabilitado = await contenedorLi.evaluate((el) => el.classList.contains('disabled')).catch(() => true);

    if (estaDeshabilitado) break;

    const fingerprintAntes = await fingerprintPrimeraFila();
    await siguiente.click();

    // Esperamos a que el contenido de la tabla realmente cambie (no solo que
    // el overlay de "processing" desaparezca), para no sumar dos veces la
    // misma página si el cambio de contenido es más lento que el overlay.
    await esperarProcesamientoTabla(comprobantesPage);
    const deadline = Date.now() + 60000;
    let cambio = false;
    while (Date.now() < deadline) {
      const fingerprintAhora = await fingerprintPrimeraFila();
      if (fingerprintAhora && fingerprintAhora !== fingerprintAntes) {
        cambio = true;
        break;
      }
      await comprobantesPage.waitForTimeout(300);
    }
    if (!cambio) {
      await capturarDebug(comprobantesPage, `pagina-${pagina}-no-cambio-contenido`, debugArr);
      if (comprobantesPage !== portalPage) await comprobantesPage.close().catch(() => {});
      throw new Error(
        `Al pasar a la página siguiente (#${pagina + 1}) la tabla no cambió de contenido en 60s. Revisar screenshot "pagina-${pagina}-no-cambio-contenido" — puede haber quedado sumando la misma página repetida.`
      );
    }
    pagina++;
  }

  await capturarDebug(comprobantesPage, `resultado-final-${filasTotales}-filas-${categorizadasTotales}-categorizadas`, debugArr);

  if (filasTotales === 0) {
    // Un total de 0 sin ninguna fila leída es sospechoso: puede ser que el
    // cliente realmente no tenga comprobantes en el rango, o puede ser que
    // el filtro de fecha o la búsqueda hayan fallado silenciosamente.
    // Preferimos marcarlo como error para revisión manual antes que cargar
    // un 0 que parezca un dato confiable sin serlo.
    if (comprobantesPage !== portalPage) await comprobantesPage.close().catch(() => {});
    throw new Error(
      'No se encontró NINGUNA fila de comprobantes en el rango de fechas. Puede ser que el cliente realmente no tenga comprobantes, o que el filtro de fecha/búsqueda haya fallado. Revisar screenshot "resultado-final-0-filas" antes de confiar en este dato.'
    );
  }

  if (filasTotales > 0 && categorizadasTotales === 0) {
    // Hay filas pero ninguna coincidió con Factura/Nota de Débito/Nota de
    // Crédito: esto es lo que estaba dando un "0" falso. Lo marcamos como
    // error en vez de reportar 0, para que se revise manualmente el
    // formato real de la columna "Tipo" en el screenshot de debug.
    if (comprobantesPage !== portalPage) await comprobantesPage.close().catch(() => {});
    throw new Error(
      `Se encontraron ${filasTotales} comprobantes pero NINGUNO coincidió con "Factura"/"Nota de Débito"/"Nota de Crédito" en la columna Tipo. Revisar los logs de Railway (texto exacto de cada fila) y el screenshot "resultado-final-${filasTotales}-filas-0-categorizadas" antes de confiar en este dato — probablemente el formato de esa columna cambió.`
    );
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
async function procesarCliente(browser, cuit, clave, rangoFechas = DEFAULT_DATE_RANGE, numeroCliente = '') {
  const context = await browser.newContext();
  const debug = [];
  const resultado = {
    cuit,
    numeroCliente,
    nombre: '',
    facturacionMonotributo: null,
    comprobantesRecibidos: null,
    deudaCCMA: null,
    error: null,
    debug,
  };

  try {
    const portalPage = await login(context, cuit, clave);
    await capturarDebug(portalPage, 'post-login-portal', debug);

    resultado.nombre = await obtenerNombreCliente(portalPage);
    resultado.facturacionMonotributo = await obtenerFacturacionMonotributo(context, portalPage, debug);
    resultado.comprobantesRecibidos = await obtenerComprobantesRecibidos(context, portalPage, rangoFechas, debug);
    resultado.deudaCCMA = await obtenerDeudaCCMA(context, portalPage, debug);
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

  const MAX_INTENTOS = Number(process.env.MAX_INTENTOS_POR_CLIENTE || 2);
  const resultados = [];
  try {
    for (let i = 0; i < clientes.length; i++) {
      const { cuit, clave, numeroCliente } = clientes[i];

      let resultado;
      for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
        resultado = await procesarCliente(browser, cuit, clave, rangoFechas, numeroCliente);
        if (!resultado.error) break;

        console.log(`Cliente ${cuit} — intento ${intento}/${MAX_INTENTOS} falló: ${resultado.error}`);
        if (intento < MAX_INTENTOS) {
          // Pausa un poco más larga antes de reintentar, por si fue un
          // problema transitorio de carga/red.
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
      if (resultado.error) {
        resultado.error = `[Falló tras ${MAX_INTENTOS} intentos] ${resultado.error}`;
      }

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
