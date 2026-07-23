const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const { readInputExcel, buildZipBuffer } = require('./excelHandler');
const { procesarClientes } = require('./scraper');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const ALLOWED_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN }));

// Guarda en memoria el estado de cada job. Si escalás a más de una instancia
// de Railway vas a necesitar mover esto a Redis o similar.
const jobs = new Map();

function checkApiKey(req, res, next) {
  const requiredKey = process.env.API_KEY;
  if (!requiredKey) return next(); // si no configuraste API_KEY, no exige nada
  const provided = req.header('x-api-key');
  if (provided !== requiredKey) {
    return res.status(401).json({ error: 'API key inválida o faltante' });
  }
  next();
}

app.post('/upload', checkApiKey, upload.single('excel'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Falta el archivo excel (campo "excel")' });
  }

  let clientes;
  try {
    clientes = readInputExcel(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ error: `No se pudo leer el excel: ${err.message}` });
  }

  if (clientes.length === 0) {
    return res.status(400).json({ error: 'No se encontraron filas válidas (CUIT de 11 dígitos + clave)' });
  }

  const jobId = uuidv4();
  jobs.set(jobId, {
    status: 'processing',
    total: clientes.length,
    processed: 0,
    currentCuit: null,
    resultados: [],
    zipBuffer: null,
    error: null,
    createdAt: Date.now(),
  });

  res.json({ jobId, total: clientes.length });

  // Procesamiento asincrónico, no bloquea la respuesta
  const rangoFechas = req.body.rangoFechas || undefined;
  procesarClientes(
    clientes,
    ({ index, resultado }) => {
      const job = jobs.get(jobId);
      if (!job) return;
      job.processed = index;
      job.currentCuit = resultado.cuit;
      job.resultados.push(resultado);
    },
    rangoFechas
  )
    .then(async (resultados) => {
      const job = jobs.get(jobId);
      if (!job) return;
      job.zipBuffer = await buildZipBuffer(resultados);
      job.status = 'done';
    })
    .catch((err) => {
      const job = jobs.get(jobId);
      if (!job) return;
      job.status = 'error';
      job.error = err.message || String(err);
    });
});

app.get('/status/:jobId', checkApiKey, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });

  res.json({
    status: job.status,
    total: job.total,
    processed: job.processed,
    currentCuit: job.currentCuit,
    error: job.error,
    resultados: job.resultados.map((r) => ({
      cuit: r.cuit,
      numeroCliente: r.numeroCliente,
      nombre: r.nombre,
      error: r.error,
    })),
  });
});

app.get('/download/:jobId', checkApiKey, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  if (job.status !== 'done' || !job.zipBuffer) {
    return res.status(409).json({ error: 'El job todavía no terminó' });
  }

  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="clientes_afip_${req.params.jobId}.zip"`);
  res.send(job.zipBuffer);
});

// Limpieza de jobs viejos (más de 2 horas) para no acumular memoria
setInterval(() => {
  const seisHoras = 6 * 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (Date.now() - job.createdAt > seisHoras) jobs.delete(id);
  }
}, 15 * 60 * 1000);

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend AFIP scraper escuchando en puerto ${PORT}`));
