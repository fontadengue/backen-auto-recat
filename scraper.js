const { chromium } = require('playwright');

const LOGIN_URL = 'https://auth.afip.gob.ar/contribuyente_/login.xhtml';
const PORTAL_URL_FRAGMENT = 'portalcf.cloud.afip.gob.ar';
const DEFAULT_DATE_RANGE = process.env.RANGO_FECHAS || '01/07/2025 - 30/06/2026';
const NAV_TIMEOUT = 90000;

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

async function intentarObtenerFacturacionMonotributo(context, portalPage, debugArr) {
  // Igual que Mis Comprobantes y CCMA: entra por "Ver todos" -> tarjeta
  // "Monotributo", en vez del botón "Ingresar" de la card de
  // Recategorización (que cambió de estructura con el rediseño AFIP -> ARCA
  // y dejó de ser confiable).
  const monoPage = await abrirServicioDesdeMisServicios(context, portalPage, 'MONOTRIBUTO', debugArr);

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

  // Método principal: #spanMontoCalculado. El id incluye "Mobile": puede
  // estar oculto por CSS en viewport de escritorio, por eso esperamos
  // "attached" en vez de "visible", y leemos con textContent.
  const encontrado = await waitForSelectorAnywhere(
    monoPage,
    '#spanMontoCalculado',
    NAV_TIMEOUT,
    'attached-nonempty'
  );

  let monto;
  let comprobantesRecibidosDesdeMonotributo = null;

  if (encontrado) {
    const texto = await encontrado.locator.textContent();
    monto = parseImporteArg(texto);
  } else {
    // Método de respaldo: tabla "Ingresos en el período", fila de Facturas
    // electrónicas emitidas (#trFeEmitida).
    const filaRespaldo = await waitForSelectorAnywhere(
      monoPage,
      '#trFeEmitida',
      30000,
      'attached-nonempty'
    );
    if (!filaRespaldo) {
      if (monoPage !== portalPage) await monoPage.close().catch(() => {});
      throw new Error(
        `No se encontró #spanMontoCalculado ni el respaldo #trFeEmitida en Monotributo (url: ${monoPage.url()}).`
      );
    }
    const textoRespaldo = await filaRespaldo.locator.textContent();
    monto = parseImporteArg(textoRespaldo);

    // Esta misma tabla también trae "Comprobantes electrónicos recibidos":
    // si está, la aprovechamos y nos ahorramos todo el flujo separado de
    // Mis Comprobantes para este cliente.
    const filaRecibidos = await waitForSelectorAnywhere(
      monoPage,
      'tr:has-text("Comprobantes electrónicos recibidos")',
      10000,
      'attached-nonempty'
    );
    if (filaRecibidos) {
      const textoRecibidos = await filaRecibidos.locator.textContent();
      comprobantesRecibidosDesdeMonotributo = parseImporteArg(textoRecibidos);
    }
  }

  // Única captura de debug para este dato: justo al obtener la facturación.
  await capturarDebug(monoPage, 'facturacion-monotributo-obtenida', debugArr);

  if (monoPage !== portalPage) {
    await monoPage.close().catch(() => {});
  }
  return { monto, comprobantesRecibidosDesdeMonotributo };
}

async function obtenerFacturacionMonotributo(context, portalPage, debugArr) {
  const MAX_INTENTOS_MONOTRIBUTO = 2;
  let ultimoError;

  for (let intento = 1; intento <= MAX_INTENTOS_MONOTRIBUTO; intento++) {
    try {
      return await intentarObtenerFacturacionMonotributo(context, portalPage, debugArr);
    } catch (err) {
      ultimoError = err;
      if (intento < MAX_INTENTOS_MONOTRIBUTO) {
        // No detectó el dato ni por el método principal ni por el de
        // respaldo: volvemos a la página principal del portal y repetimos
        // todo el flujo de Monotributo una vez más antes de darlo por fallido.
        console.log(`Monotributo — intento ${intento} falló (${err.message}), reintentando desde la página principal...`);
        await portalPage.goto(`https://${PORTAL_URL_FRAGMENT}/portal/app/`, {
          waitUntil: 'domcontentloaded',
          timeout: NAV_TIMEOUT,
        }).catch(() => {});
        await portalPage.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
      }
    }
  }

  // Si el error final es específicamente "no se encontró el dato en ningún
  // lado de la página" (llegamos bien a Monotributo, pero ni el método
  // principal ni el de respaldo detectaron nada) — no un error de
  // navegación/click — colocamos 0 con una nota para verificar a mano, en
  // vez de marcar todo el cliente como fallido.
  const noHabiaDatoEnLaPagina = ultimoError && ultimoError.message.includes('ni el respaldo #trFeEmitida');
  if (noHabiaDatoEnLaPagina) {
    console.log('Monotributo — no se encontró el dato en ningún lado de la página tras los reintentos; se coloca 0 (verificar).');
    return { monto: '0 (verificar)', comprobantesRecibidosDesdeMonotributo: null };
  }

  throw ultimoError;
}

function extraerImporteConTipoCambio(importeTexto) {
  const lineas = importeTexto
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const primeraLinea = lineas[0] || '';
  const esDolar = /USD/i.test(primeraLinea);

  let importe = parseImporteArg(primeraLinea);
  let tc = null;

  if (esDolar) {
    const lineaTC = lineas.find((l) => /TC:/i.test(l)) || importeTexto;
    const tcMatch = lineaTC.match(/TC:\s*([\d.,]+)/i);
    if (tcMatch) {
      tc = parseImporteArg(tcMatch[1]);
      if (tc) importe = importe * tc;
    }
  }

  return { importe, esDolar, tc };
}

async function sumarComprobantesEnPaginaActual(page) {
  // Ajustar el selector de filas según la tabla real (#tablaDataTables)
  const filas = page.locator('#tablaDataTables tbody tr');
  const total = await filas.count();
  let acumulado = 0;
  let categorizadas = 0;
  let importeNoParseado = 0;
  const tiposNoReconocidos = {}; // { "5 - recibo x": { cantidad, totalImporte } }

  for (let i = 0; i < total; i++) {
    const fila = filas.nth(i);
    const celdas = fila.locator('td');
    const tipoTexto = (await celdas.nth(1).innerText().catch(() => '')).toLowerCase().trim();
    // El importe suele estar en una celda con class="alignRight" y span.moneda.
    // Si la moneda no es "$" (ej: USD), hay que multiplicar por el tipo de
    // cambio (TC) que aparece debajo, en la misma celda.
    const importeTexto = await fila.locator('td.alignRight').first().innerText().catch(() => '');
    const { importe, esDolar, tc } = extraerImporteConTipoCambio(importeTexto);
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
    } else if (tipoTexto) {
      // Tipo de comprobante que NO reconocemos como Factura/N.Débito/N.Crédito.
      // No lo sumamos ni restamos, pero lo registramos para que quede a la
      // vista en vez de desaparecer silenciosamente del total.
      if (!tiposNoReconocidos[tipoTexto]) {
        tiposNoReconocidos[tipoTexto] = { cantidad: 0, totalImporte: 0 };
      }
      tiposNoReconocidos[tipoTexto].cantidad++;
      tiposNoReconocidos[tipoTexto].totalImporte += importe;
    }
    const notaDolar = esDolar ? ` [USD, TC=${tc}]` : '';
    console.log(`  fila ${i}: tipo="${tipoTexto}" importeTexto="${importeTexto.trim().replace(/\n/g, ' | ')}" importe=${importe}${notaDolar} signo=${signo}`);
  }
  console.log(`  subtotal de la página: ${acumulado} (${total} filas, ${categorizadas} categorizadas, ${importeNoParseado} importes sin parsear bien)`);
  return { subtotal: acumulado, filas: total, categorizadas, importeNoParseado, tiposNoReconocidos };
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
    await portalPage.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
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
  await tarjeta.locator.scrollIntoViewIfNeeded().catch(() => {});

  // El click en la tarjeta puede tardar en abrir pestaña/navegar bajo carga
  // (AFIP responde más lento con muchos clientes seguidos). Reintentamos el
  // click varias veces, verificando de verdad que algo cambió, antes de
  // darlo por perdido — no seguimos de largo si no confirmamos la apertura.
  const MAX_INTENTOS_CLICK = 3;
  let servicioPage = portalPage;
  const urlAntesDelClick = portalPage.url();

  for (let intento = 1; intento <= MAX_INTENTOS_CLICK; intento++) {
    servicioPage = await clickAndMaybeGetNewPage(context, portalPage, async () => {
      await tarjeta.locator.click();
    }, 30000);

    if (servicioPage !== portalPage) break; // se abrió pestaña nueva, listo

    // No se abrió pestaña nueva: puede haber navegado en la misma pestaña,
    // le damos margen a que cargue antes de decidir si hubo que reintentar.
    await portalPage.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    if (portalPage.url() !== urlAntesDelClick) break; // navegó en la misma pestaña, listo

    if (intento < MAX_INTENTOS_CLICK) {
      await portalPage.waitForTimeout(2000);
    }
  }

  if (servicioPage === portalPage && portalPage.url() === urlAntesDelClick) {
    throw new Error(
      `El click en la tarjeta "${tituloTarjeta}" no abrió pestaña nueva ni navegó después de ${MAX_INTENTOS_CLICK} intentos (sigue en ${portalPage.url()}).`
    );
  }

  // Estas apps suelen tardar en cargar del todo; esperamos a que la red se
  // calme (detección), no un tiempo fijo arbitrario.
  await servicioPage.waitForLoadState('domcontentloaded', { timeout: 90000 }).catch(() => {});
  await servicioPage.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});

  return servicioPage;
}

const TITULO_CCMA = "CCMA - CUENTA CORRIENTE DE CONTRIBUYENTES MONOTRIBUTISTAS Y AUTONOMOS";

async function abrirMisComprobantesDesdePortal(context, portalPage, debugArr) {
  return abrirServicioDesdeMisServicios(context, portalPage, 'MIS COMPROBANTES', debugArr);
}

async function obtenerDeudaCCMA(context, portalPage, debugArr, cuit) {
  const ccmaPage = await abrirServicioDesdeMisServicios(context, portalPage, TITULO_CCMA, debugArr);

  // En algunos casos CCMA pide elegir a qué CUIT representar (cuando la
  // clave fiscal tiene más de un CUIT relacionado). Si aparece ese selector,
  // elegimos el CUIT que corresponde a este cliente puntual.
  const selectCuit = await waitForSelectorAnywhere(ccmaPage, 'select[name="selectCuit"]', 10000, 'visible');
  if (selectCuit) {
    await selectCuit.locator.selectOption(cuit).catch(async () => {
      // Por si el value no matchea exacto (espacios, ceros, etc.), probamos
      // seleccionar por el texto visible de la opción.
      await selectCuit.locator.selectOption({ label: cuit }).catch(() => {});
    });

    const botonElegirCuit = await waitForSelectorAnywhere(ccmaPage, 'input[name="btnEnvia"]', 10000, 'visible');
    if (botonElegirCuit) {
      await botonElegirCuit.locator.click();
      await ccmaPage.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
      await ccmaPage.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
    }
  }

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
  if (linkMC) {
    await linkMC.locator.click();
  }
  // Verificamos que realmente haya quedado todo tildado; si el link no
  // existía o el click no marcó todo, marcamos casilla por casilla como
  // flujo de respaldo (cada fila de MONOTRIBUTO - OBLIGACIONES usa
  // name="check_mon_capital").
  const obligacionesOk = await confirmarTodosMarcados(volantePage, 'check_mon_capital');
  if (!obligacionesOk) {
    await marcarTodosLosCheckboxes(volantePage, 'check_mon_capital');
  }

  // Seleccionar todos en Monotributo - Intereses (puede no existir si no hay intereses)
  const linkMI = await waitForSelectorAnywhere(volantePage, 'a[href*="select_todos(\'MI\')"]', 15000, 'visible');
  if (linkMI) {
    await linkMI.locator.click();
  }
  // Mismo respaldo para MONOTRIBUTO - INTERESES (name="check_mon_interes")
  const interesesOk = await confirmarTodosMarcados(volantePage, 'check_mon_interes');
  if (!interesesOk) {
    await marcarTodosLosCheckboxes(volantePage, 'check_mon_interes');
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

async function marcarTodosLosCheckboxes(page, name) {
  const checkboxes = page.locator(`input[type="checkbox"][name="${name}"]`);
  const total = await checkboxes.count();
  for (let i = 0; i < total; i++) {
    const casilla = checkboxes.nth(i);
    const yaMarcada = await casilla.isChecked().catch(() => false);
    if (!yaMarcada) {
      await casilla.check({ force: true }).catch(() => {});
    }
  }
  return total;
}

async function confirmarTodosMarcados(page, name) {
  const checkboxes = page.locator(`input[type="checkbox"][name="${name}"]`);
  const total = await checkboxes.count();
  if (total === 0) return true;
  for (let i = 0; i < total; i++) {
    const marcada = await checkboxes.nth(i).isChecked().catch(() => false);
    if (!marcada) return false;
  }
  return true;
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

function formatCuitConGuiones(cuit) {
  const digits = String(cuit).replace(/\D/g, '');
  if (digits.length !== 11) return cuit;
  return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
}

async function elegirPersonaSiCorresponde(page, cuit, debugArr) {
  const cuitConGuiones = formatCuitConGuiones(cuit);
  const tituloPersona = await waitForSelectorAnywhere(
    page,
    'h1:has-text("Elegí una persona para ingresar")',
    10000,
    'visible'
  );
  if (!tituloPersona) return false;

  const tarjetaPersona = await waitForSelectorAnywhere(
    page,
    `div.media-body:has(p:text-is("${cuitConGuiones}"))`,
    15000,
    'visible'
  );
  if (!tarjetaPersona) {
    throw new Error(
      `Apareció "Elegí una persona para ingresar" pero no se encontró la tarjeta con CUIT ${cuitConGuiones} (url: ${page.url()}).`
    );
  }
  await tarjetaPersona.locator.click();
  await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
  return true;
}

async function obtenerComprobantesRecibidos(context, portalPage, rangoFechas, debugArr, cuit) {
  const comprobantesPage = await abrirMisComprobantesDesdePortal(context, portalPage, debugArr);

  // Click en "Recibidos" — se espera a que el panel aparezca, sin tiempo fijo
  let panelRecibidos = await waitForSelectorAnywhere(
    comprobantesPage,
    'div.panel-body:has(h3:text-is("Recibidos"))',
    120000
  );

  if (!panelRecibidos) {
    // Recuperación: puede haber saltado la pantalla "Elegí una persona para
    // ingresar" (cuando la clave fiscal representa a más de una persona).
    // Solo la manejamos acá, como respaldo ante el error de no encontrar
    // el panel "Recibidos".
    const eligioPersona = await elegirPersonaSiCorresponde(comprobantesPage, cuit, debugArr);
    if (eligioPersona) {
      panelRecibidos = await waitForSelectorAnywhere(
        comprobantesPage,
        'div.panel-body:has(h3:text-is("Recibidos"))',
        60000
      );
    }
  }

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

  async function sumarPaginaConReintento() {
    let resultado = await sumarComprobantesEnPaginaActual(comprobantesPage);
    if (resultado.filas > 0 && resultado.categorizadas === 0) {
      // Sospechoso: hay filas pero ninguna categorizada. Puede ser que el
      // contenido todavía no terminó de renderizar (bajo carga tarda más).
      // Le damos un margen extra y volvemos a leer una vez antes de aceptar
      // este resultado como definitivo.
      await comprobantesPage.waitForTimeout(3000);
      resultado = await sumarComprobantesEnPaginaActual(comprobantesPage);
    }
    return resultado;
  }

  const tiposNoReconocidosTotal = {};

  while (pagina <= MAX_PAGINAS) {
    const { subtotal, filas, categorizadas, tiposNoReconocidos } = await sumarPaginaConReintento();
    total += subtotal;
    filasTotales += filas;
    categorizadasTotales += categorizadas;

    for (const [tipo, datos] of Object.entries(tiposNoReconocidos || {})) {
      if (!tiposNoReconocidosTotal[tipo]) {
        tiposNoReconocidosTotal[tipo] = { cantidad: 0, totalImporte: 0 };
      }
      tiposNoReconocidosTotal[tipo].cantidad += datos.cantidad;
      tiposNoReconocidosTotal[tipo].totalImporte += datos.totalImporte;
    }

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

  // Si hay tipos de comprobante que NO reconocemos y que además tienen un
  // importe distinto de cero, el total podría estar incompleto sin que nos
  // demos cuenta. Preferimos frenar acá con un error explícito (que se ve
  // en el excel y en los logs) antes que entregar un número que parezca
  // confiable pero le falte algo.
  const tiposConImporte = Object.entries(tiposNoReconocidosTotal).filter(
    ([, datos]) => Math.abs(datos.totalImporte) > 0.009
  );
  if (tiposConImporte.length > 0) {
    if (comprobantesPage !== portalPage) await comprobantesPage.close().catch(() => {});
    const detalle = tiposConImporte
      .map(([tipo, datos]) => `"${tipo}" (${datos.cantidad} fila/s, importe total ${datos.totalImporte.toFixed(2)})`)
      .join('; ');
    throw new Error(
      `Se encontraron tipos de comprobante NO reconocidos (no son Factura/N.Débito/N.Crédito) con importe distinto de 0, que por eso NO se sumaron ni restaron: ${detalle}. Revisar si corresponde incluirlos en la lógica de suma antes de confiar en el total. Screenshot "comprobantes-recibidos-totalizado".`
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
    const facturacionResultado = await obtenerFacturacionMonotributo(context, portalPage, debug);
    resultado.facturacionMonotributo = facturacionResultado.monto;

    if (
      facturacionResultado.comprobantesRecibidosDesdeMonotributo !== null &&
      facturacionResultado.comprobantesRecibidosDesdeMonotributo !== undefined
    ) {
      // Ya conseguimos el dato de comprobantes recibidos desde la propia
      // pantalla de Monotributo (método de respaldo): nos ahorramos todo
      // el flujo separado de "Mis Comprobantes" y vamos directo a CCMA.
      resultado.comprobantesRecibidos = facturacionResultado.comprobantesRecibidosDesdeMonotributo;
    } else {
      resultado.comprobantesRecibidos = await obtenerComprobantesRecibidos(context, portalPage, rangoFechas, debug, cuit);
    }
    resultado.deudaCCMA = await obtenerDeudaCCMA(context, portalPage, debug, cuit);
  } catch (err) {
    resultado.error = err.message || String(err);
  } finally {
    await context.close().catch(() => {});
  }

  return resultado;
}

async function procesarClientes(clientes, onProgress, rangoFechas) {
  const RECICLAR_BROWSER_CADA = Number(process.env.RECICLAR_BROWSER_CADA || 6);

  async function lanzarBrowser() {
    return chromium.launch({
      headless: process.env.HEADLESS !== 'false',
      args: ['--disable-dev-shm-usage'], // evita que /dev/shm limitado tire OOM en contenedores chicos
    });
  }

  let browser = await lanzarBrowser();

  const MAX_INTENTOS = Number(process.env.MAX_INTENTOS_POR_CLIENTE || 3);
  const resultados = [];
  try {
    for (let i = 0; i < clientes.length; i++) {
      const { cuit, clave, numeroCliente } = clientes[i];

      // Reciclamos el navegador cada tanto: Chromium acumula memoria en
      // procesos largos con muchas pestañas/contextos, y en lotes grandes
      // esto puede tirar abajo el contenedor (Railway lo reinicia, y el
      // frontend ve un "failed to fetch" / DNS por unos segundos).
      if (i > 0 && i % RECICLAR_BROWSER_CADA === 0) {
        console.log(`Reciclando navegador tras ${i} clientes procesados...`);
        await browser.close().catch(() => {});
        browser = await lanzarBrowser();
      }

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
      const delay = Number(process.env.DELAY_MS || 8000);
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
