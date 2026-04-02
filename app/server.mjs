import express from 'express';
import fs from 'node:fs/promises';

const APP_NAME = process.env.APP_NAME || 'memlab-app';
const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const ALLOC_MB = Number.parseInt(process.env.ALLOC_MB || '100', 10);
const ENABLE_DIAG = (process.env.ENABLE_DIAG || 'true').toLowerCase() === 'true';

const startupDate = new Date();
const startupTime = startupDate.toISOString();

const app = express();

let requestCount = 0;
let errorCount = 0;
const allocatedChunks = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function allocateMemoryAtStartup(totalMb) {
  const safeTotal = Number.isFinite(totalMb) && totalMb > 0 ? totalMb : 0;
  for (let i = 0; i < safeTotal; i += 1) {
    allocatedChunks.push(Buffer.alloc(1024 * 1024, 0x42));
    if ((i + 1) % 10 === 0 || i + 1 === safeTotal) {
      console.log(`[startup] allocated ${i + 1}/${safeTotal} MB`);
    }
    await sleep(10);
  }
}

function parseKeyValueText(text) {
  const parsed = {};

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(/^([^:]+):\s+(.+)$/);
    if (match) {
      const key = match[1].trim();
      const rest = match[2].trim();
      const numeric = rest.match(/^(-?\d+(?:\.\d+)?)(?:\s+(\S+))?$/);
      if (numeric) {
        parsed[key] = {
          value: Number(numeric[1]),
          unit: numeric[2] || null,
        };
      } else {
        parsed[key] = rest;
      }
      continue;
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const key = parts[0];
      const num = Number(parts[1]);
      parsed[key] = Number.isNaN(num)
        ? { value: parts.slice(1).join(' '), unit: null }
        : { value: num, unit: null };
    }
  }

  return parsed;
}

function parsePressureMemory(text) {
  const parsed = {};

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const [category, ...metrics] = trimmed.split(/\s+/);
    if (!category) continue;

    const entry = {};
    for (const metric of metrics) {
      const [k, v] = metric.split('=');
      if (!k || v === undefined) continue;
      const numeric = Number(v);
      entry[k] = Number.isNaN(numeric) ? v : numeric;
    }

    parsed[category] = entry;
  }

  return parsed;
}

async function safeRead(path, parser) {
  try {
    const raw = await fs.readFile(path, 'utf8');
    return {
      path,
      available: true,
      raw,
      parsed: parser ? parser(raw) : null,
    };
  } catch (error) {
    return {
      path,
      available: false,
      error: error.message,
      raw: null,
      parsed: null,
    };
  }
}

app.use((req, res, next) => {
  requestCount += 1;
  res.on('finish', () => {
    if (res.statusCode >= 500) {
      errorCount += 1;
    }
  });
  next();
});

app.get('/ping', (_req, res) => {
  res.type('text/plain').send('pong');
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    app: APP_NAME,
    allocMb: ALLOC_MB,
    startupTime,
    uptimeSeconds: process.uptime(),
  });
});

app.get('/stats', (_req, res) => {
  res.json({
    app: APP_NAME,
    allocMb: ALLOC_MB,
    startupTime,
    requestCount,
    errorCount,
    pid: process.pid,
    memoryUsage: process.memoryUsage(),
    cpuUsage: process.cpuUsage(),
    uptime: process.uptime(),
    now: new Date().toISOString(),
  });
});

if (ENABLE_DIAG) {
  app.get('/diag/proc', async (_req, res) => {
    const [
      meminfo,
      vmstat,
      pressureMemory,
      cgroupMemoryCurrent,
      cgroupMemorySwapCurrent,
    ] = await Promise.all([
      safeRead('/proc/meminfo', parseKeyValueText),
      safeRead('/proc/vmstat', parseKeyValueText),
      safeRead('/proc/pressure/memory', parsePressureMemory),
      safeRead('/sys/fs/cgroup/memory.current', (raw) => ({
        value: Number(raw.trim()),
        unit: 'bytes',
      })),
      safeRead('/sys/fs/cgroup/memory.swap.current', (raw) => ({
        value: Number(raw.trim()),
        unit: 'bytes',
      })),
    ]);

    res.json({
      app: APP_NAME,
      allocMb: ALLOC_MB,
      now: new Date().toISOString(),
      pid: process.pid,
      proc: {
        meminfo,
        vmstat,
        pressureMemory,
      },
      cgroup: {
        memoryCurrent: cgroupMemoryCurrent,
        memorySwapCurrent: cgroupMemorySwapCurrent,
      },
    });
  });

  app.get('/diag/proc/raw', async (_req, res) => {
    const [meminfo, vmstat] = await Promise.all([
      safeRead('/proc/meminfo'),
      safeRead('/proc/vmstat'),
    ]);

    res.json({
      app: APP_NAME,
      allocMb: ALLOC_MB,
      now: new Date().toISOString(),
      meminfoRaw: meminfo.raw,
      vmstatRaw: vmstat.raw,
      errors: {
        meminfo: meminfo.available ? null : meminfo.error,
        vmstat: vmstat.available ? null : vmstat.error,
      },
    });
  });
}

let server;

process.on('SIGTERM', () => {
  console.log('[signal] SIGTERM received, shutting down gracefully');
  if (server) {
    server.close(() => {
      console.log('[signal] HTTP server closed');
      process.exit(0);
    });
    return;
  }
  process.exit(0);
});

async function start() {
  console.log(`[startup] app=${APP_NAME} pid=${process.pid} targetAllocMb=${ALLOC_MB}`);
  await allocateMemoryAtStartup(ALLOC_MB);

  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[startup] listening on 0.0.0.0:${PORT}`);
  });
}

start().catch((error) => {
  console.error('[startup] fatal error', error);
  process.exit(1);
});
