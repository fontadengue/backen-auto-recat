const XLSX = require('xlsx');
const archiver = require('archiver');
const { PassThrough } = require('stream');

/**
 * Lee el excel subido por el usuario.
 * Columna A: CUIT | Columna B: Clave fiscal
 * Asume que puede o no tener fila de encabezado; si la primera celda
 * de la columna A no es un CUIT válido (11 dígitos), la salta.
 */
function readInputExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

  const clientes = [];
  for (const row of rows) {
    const cuitRaw = String(row[0] ?? '').trim();
    const clave = String(row[1] ?? '').trim();
    const numeroCliente = String(row[2] ?? '').trim();
    const cuitDigits = cuitRaw.replace(/\D/g, '');

    if (cuitDigits.length === 11 && clave) {
      clientes.push({ cuit: cuitDigits, clave, numeroCliente });
    }
  }
  return clientes;
}

/**
 * Genera el buffer de un excel individual para un cliente.
 */
function buildClientExcelBuffer(resultado) {
  const {
    nombre,
    cuit,
    numeroCliente,
    facturacionMonotributo,
    comprobantesRecibidos,
    deudaCCMA,
    error,
  } = resultado;

  const data = [
    ['Número de Cliente', numeroCliente || ''],
    ['Cliente', nombre || ''],
    ['CUIT', cuit],
    ['Facturación Monotributo (Facturómetro)', facturacionMonotributo ?? ''],
    ['Comprobantes Recibidos (Facturas + N. Débito - N. Crédito)', comprobantesRecibidos ?? ''],
    ['Deuda CCMA', deudaCCMA ?? ''],
    ['Fecha de proceso', new Date().toLocaleString('es-AR')],
  ];

  if (error) {
    data.push(['ERROR', error]);
  }

  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 55 }, { wch: 30 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Datos AFIP');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Arma un zip en memoria con un excel por cliente.
 * Devuelve un Buffer.
 */
function buildZipBuffer(resultados) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const stream = new PassThrough();
    const chunks = [];

    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);

    archive.pipe(stream);

    resultados.forEach((resultado, idx) => {
      const nombreBase = (resultado.nombre || `cliente_${resultado.cuit}`)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9 _-]/g, '')
        .trim() || `cliente_${idx + 1}`;

      const prefijo = resultado.numeroCliente ? `${resultado.numeroCliente} - ` : '';
      const safeName = `${prefijo}${nombreBase}`;

      const buf = buildClientExcelBuffer(resultado);
      archive.append(buf, { name: `${safeName} - ${resultado.cuit}.xlsx` });

      if (Array.isArray(resultado.debug)) {
        resultado.debug.forEach((shot, i) => {
          const nombreArchivo = `debug/${resultado.cuit}/${String(i).padStart(2, '0')}-${shot.label}.png`;
          archive.append(shot.buffer, { name: nombreArchivo });
        });
      }
    });

    archive.finalize();
  });
}

module.exports = { readInputExcel, buildClientExcelBuffer, buildZipBuffer };
