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
    newPage.on('dialog', (dialog) => dialog.accept().catch(() => {}));
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
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
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
  // Igual que Mis Comprobantes y CCMA: entra por "Ver todos" -> tarjeta
  // "Monotributo", en vez del botón "Ingresar" de la card de
  // Recategorización (que cambió de estructura con el rediseño AFIP -> ARCA
  // y dejó de ser confiable).
  const monoPage = await abrirServicioDesdeMisServicios(context, portalPage, 'Monotributo', debugArr);

  // Antes de que aparezca el monto hay que clickear "Recategorizarme"
  // (dispara un __doPostBack de ASP.NET, puede recargar la página)
  const botonRecategorizar = await waitForSelectorAnywhere(monoPage, '#bBtn1', NAV_TIMEOUT, 'visible');
  if (!botonRecategorizar) {
    if (monoPage !== portalPage) await monoPage.close().catch(() => {});
    throw new Error(`No se encontró el botón #bBtn1 "Recategorizarme" (url: ${monoPage.url()}).`);
  }

  await Promise.all([
    monoPage.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {}),
    botonRecategorizar.locator.click(),
  ]);

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
    if (monoPage !== portalPage) await monoPage.close().catch(() => {});
    throw new Error(`No se encontró #spanMontoCalculado en Monotributo (url: ${monoPage.url()}).`);
  }

  const texto = await encontrado.locator.textContent();
  const monto = parseImporteArg(texto);

  // Única captura de debug para este dato: justo al obtener la facturación.
  await capturarDebug(monoPage, 'facturacion-monotributo-obtenida', debugArr);

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
      throw new Error(`No se encontró el link "Ver todos" en el home (url: ${portalPage.url()}).`);
    }
    await verTodos.locator.click();
    await portalPage.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
  }

  const tarjeta = await waitForSelectorAnywhere(
    portalPage,
    `div.media:has(h3:text-is("${tituloTarjeta}"))`,
    NAV_TIMEOUT,
    'visible'
  );
  if (!tarjeta) {
    throw new Error(`No se encontró la tarjeta "${tituloTarjeta}" en /mis-servicios (url: ${portalPage.url()}).`);
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

  // Borrar el período y cargar 01/2004
  const perInput = await waitForSelectorAnywhere(ccmaPage, 'input[name="perdesde2"]', 60000, 'visible');
  if (!perInput) {
    if (ccmaPage !== portalPage) await ccmaPage.close().catch(() => {});
    throw new Error(`No se encontró el input de período (perdesde2) en CCMA (url: ${ccmaPage.url()}).`);
  }
  await perInput.locator.click();
  await perInput.locator.fill('');
  await perInput.locator.type('01/2004', { delay: 40 });

  // Click en "CALCULO DE DEUDA"
  const botonCalculo = await waitForSelectorAnywhere(ccmaPage, 'input[name="CalDeud"]', 30000, 'visible');
  if (!botonCalculo) {
    if (ccmaPage !== portalPage) await ccmaPage.close().catch(() => {});
    throw new Error(`No se encontró el botón "CALCULO DE DEUDA" en CCMA (url: ${ccmaPage.url()}).`);
  }
  await botonCalculo.locator.click();

  // Esperar a que cargue la página de resultados
  await ccmaPage.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  await ccmaPage.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

  // Click en "VOLANTE DE PAGO" (siempre se clickea; la detección de si el
  // cliente tiene o no Monotributo se hace en la pantalla siguiente, que es
  // donde realmente aparece la sección "MONOTRIBUTO - OBLIGACIONES")
  const botonVolante = await waitForSelectorAnywhere(ccmaPage, 'input[name="GENVOL"]', 30000, 'visible');
  if (!botonVolante) {
    if (ccmaPage !== portalPage) await ccmaPage.close().catch(() => {});
    throw new Error(`No se encontró el botón "VOLANTE DE PAGO" en CCMA (url: ${ccmaPage.url()}).`);
  }

  // Puede estar deshabilitado hasta que termine de calcular la deuda;
  // esperamos a que quede habilitado antes de clickear.
  const deadlineHabilitado = Date.now() + 30000;
  let habilitado = await botonVolante.locator.isEnabled().catch(() => false);
  while (!habilitado && Date.now() < deadlineHabilitado) {
    await ccmaPage.waitForTimeout(500);
    habilitado = await botonVolante.locator.isEnabled().catch(() => false);
  }
  if (!habilitado) {
    if (ccmaPage !== portalPage) await ccmaPage.close().catch(() => {});
    throw new Error(`El botón "VOLANTE DE PAGO" nunca quedó habilitado (url: ${ccmaPage.url()}).`);
  }

  await botonVolante.locator.scrollIntoViewIfNeeded().catch(() => {});
  const volantePage = await clickAndMaybeGetNewPage(context, ccmaPage, async () => {
    await botonVolante.locator.click({ force: true });
  }, 20000);

  await volantePage.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  await volantePage.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

  // Acá es donde realmente hay que detectar si aparece la sección
  // "MONOTRIBUTO - OBLIGACIONES". Si no aparece, el cliente no tiene
  // deuda de monotributo: deuda CCMA = 0, sin marcar error.
  const filaObligaciones = await waitForSelectorAnywhere(
    volantePage,
    'tr:has-text("MONOTRIBUTO - OBLIGACIONES")',
    20000,
    'attached'
  );
  if (!filaObligaciones) {
    // Única captura de debug para este dato: al obtener la deuda CCMA (acá, 0).
    await capturarDebug(volantePage, 'deuda-ccma-obtenida', debugArr);
    if (volantePage !== ccmaPage) await volantePage.close().catch(() => {});
    if (ccmaPage !== portalPage) await ccmaPage.close().catch(() => {});
    return 0;
  }

  // Seleccionar todos en Monotributo - Obligaciones
  const linkMC = await waitForSelectorAnywhere(volantePage, 'a[href*="select_todos(\'MC\')"]', 30000, 'visible');
  if (!linkMC) {
    if (volantePage !== ccmaPage) await volantePage.close().catch(() => {});
    if (ccmaPage !== portalPage) await ccmaPage.close().catch(() => {});
    throw new Error(
      `Se detectó la sección "MONOTRIBUTO - OBLIGACIONES" pero no su link "Seleccionar todos" (url: ${volantePage.url()}).`
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
    if (ccmaPage !== portalPage) await ccmaPage.close().catch(() => {});
    if (volantePage !== ccmaPage) await volantePage.close().catch(() => {});
    throw new Error(`No se encontró el botón "GENERAR VEP O QR" (url: ${volantePage.url()}).`);
  }
  await botonVEP.locator.click();

  // Leer el importe total a pagar. Apuntamos directo al <strong> con la
  // etiqueta, y leemos SOLO el texto de su padre inmediato (no un div
  // ancestro grande, que puede arrastrar toda la tabla de arriba —
  // incluido el CUIT del contribuyente— y arruinar el parseo del monto).
  const strongEncontrado = await waitForSelectorAnywhere(
    volantePage,
    'strong:has-text("Importe Total a pagar")',
    60000,
    'attached'
  );

  if (!strongEncontrado) {
    if (volantePage !== ccmaPage) await volantePage.close().catch(() => {});
    if (ccmaPage !== portalPage) await ccmaPage.close().catch(() => {});
    throw new Error(
      `No se encontró el "Importe Total a pagar" después de Generar VEP (url: ${volantePage.url()}). No confiar en un 0 acá, hay que revisar qué pasó.`
    );
  }

  // El monto suele estar como texto hermano después del <strong>, dentro del
  // mismo padre inmediato. Esperamos a que ese padre tenga contenido
  // numérico real (no solo la etiqueta) antes de leerlo, por si carga con
  // un pequeño delay después de Generar VEP.
  const padreImporte = strongEncontrado.locator.locator('xpath=..');
  let texto = '';
  const deadlineImporte = Date.now() + 30000;
  while (Date.now() < deadlineImporte) {
    texto = await padreImporte.textContent().catch(() => '');
    const soloElMonto = texto.replace(/Importe Total a pagar:?/i, '');
    if (/\d/.test(soloElMonto)) break;
    await volantePage.waitForTimeout(500);
  }

  const monto = parseImporteArg(texto);

  // Única captura de debug para este dato: al obtener la deuda CCMA (importe real).
  await capturarDebug(volantePage, 'deuda-ccma-obtenida', debugArr);

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

  // Click en "Recibidos" — se espera a que el panel aparezca, sin tiempo fijo
  const panelRecibidos = await waitForSelectorAnywhere(
    comprobantesPage,
    'div.panel-body:has(h3:text-is("Recibidos"))',
    120000
  );
  if (!panelRecibidos) {
    if (comprobantesPage !== portalPage) await comprobantesPage.close().catch(() => {});
    throw new Error(`No se encontró el panel "Recibidos" (url: ${comprobantesPage.url()}).`);
  }
  await panelRecibidos.locator.click();

  // Filtro de fecha — se espera a que el input exista, sin tiempo fijo
  const fechaEncontrado = await waitForSelectorAnywhere(comprobantesPage, '#fechaEmision', 60000);
  if (!fechaEncontrado) {
    if (comprobantesPage !== portalPage) await comprobantesPage.close().catch(() => {});
    throw new Error(`No se encontró #fechaEmision (url: ${comprobantesPage.url()}).`);
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

  await comprobantesPage.locator('button.applyBtn.btn-success').click();
  await comprobantesPage.locator('#buscarComprobantes').click();

  // Esperar a que cargue la tabla (por detección, no por tiempo fijo)
  await comprobantesPage.locator('#tablaDataTables').waitFor({ state: 'visible', timeout: 60000 });
  await esperarProcesamientoTabla(comprobantesPage);
  await comprobantesPage.locator('#tablaDataTables tbody tr').first().waitFor({ state: 'visible', timeout: 60000 });

  // Cambiar a 50 resultados por página (ícono de barras -> opción "50")
  const iconoBarras = comprobantesPage.locator('i.fa-bars').first();
  if (await iconoBarras.isVisible().catch(() => false)) {
    await iconoBarras.click();
    const opcion50 = comprobantesPage.locator('li.button-page-length a:text-is("50")').first();
    const dropdownAbierto = await opcion50.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);

    if (dropdownAbierto) {
      await opcion50.click();
      await esperarProcesamientoTabla(comprobantesPage);
      await comprobantesPage.locator('#tablaDataTables tbody tr').first().waitFor({ state: 'visible', timeout: 60000 });
    }
    // Si no se pudo confirmar el dropdown de cantidad, seguimos igual: la
    // paginación con "»" va a recorrer todas las páginas de todos modos,
    // solo que con más páginas (más lento, no incorrecto).
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
      if (comprobantesPage !== portalPage) await comprobantesPage.close().catch(() => {});
      throw new Error(
        `Al pasar a la página siguiente (#${pagina + 1}) la tabla no cambió de contenido en 60s. Puede haber quedado sumando la misma página repetida.`
      );
    }
    pagina++;
  }

  // Única captura de debug para este dato: al totalizar los comprobantes recibidos.
  await capturarDebug(comprobantesPage, 'comprobantes-recibidos-totalizado', debugArr);

  if (filasTotales === 0) {
    // Un total de 0 sin ninguna fila leída es sospechoso: puede ser que el
    // cliente realmente no tenga comprobantes en el rango, o puede ser que
    // el filtro de fecha o la búsqueda hayan fallado silenciosamente.
    // Preferimos marcarlo como error para revisión manual antes que cargar
    // un 0 que parezca un dato confiable sin serlo.
    if (comprobantesPage !== portalPage) await comprobantesPage.close().catch(() => {});
    throw new Error(
      'No se encontró NINGUNA fila de comprobantes en el rango de fechas. Puede ser que el cliente realmente no tenga comprobantes, o que el filtro de fecha/búsqueda haya fallado. Revisar screenshot "comprobantes-recibidos-totalizado" antes de confiar en este dato.'
    );
  }

  if (filasTotales > 0 && categorizadasTotales === 0) {
    // Hay filas pero ninguna coincidió con Factura/Nota de Débito/Nota de
    // Crédito: esto es lo que estaba dando un "0" falso. Lo marcamos como
    // error en vez de reportar 0, para que se revise manualmente el
    // formato real de la columna "Tipo" en el screenshot de debug.
    if (comprobantesPage !== portalPage) await comprobantesPage.close().catch(() => {});
    throw new Error(
      `Se encontraron ${filasTotales} comprobantes pero NINGUNO coincidió con "Factura"/"Nota de Débito"/"Nota de Crédito" en la columna Tipo. Revisar los logs de Railway (texto exacto de cada fila) y el screenshot "comprobantes-recibidos-totalizado" antes de confiar en este dato — probablemente el formato de esa columna cambió.`
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
