#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = 'true';
    }
  }
  return args;
}

function normalizeBaseUrl(value) {
  if (!value) return null;
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value.replace(/\/+$/, '');
  }
  return `https://${value.replace(/\/+$/, '')}`;
}

function ensureFileWithHeader(filePath, headerLine) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let needsHeader = true;
  if (fs.existsSync(filePath)) {
    needsHeader = fs.statSync(filePath).size === 0;
  }
  if (needsHeader) {
    fs.appendFileSync(filePath, `${headerLine}\n`, 'utf8');
  }
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((acc, n) => acc + n, 0) / values.length;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = process.hrtime.bigint();
  try {
    const response = await fetch(url, { signal: controller.signal });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    return {
      status: response.status,
      elapsedMs: Math.round(elapsedMs),
      error: '',
    };
  } catch (error) {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    return {
      status: '',
      elapsedMs: Math.round(elapsedMs),
      error: error?.name === 'AbortError' ? 'timeout' : (error?.message || 'fetch_failed'),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const urls = (args.urls || '')
    .split(',')
    .map((u) => normalizeBaseUrl(u.trim()))
    .filter(Boolean);
  const rps = Number.parseInt(args.rps || '0', 10);
  const durationSec = Number.parseInt(args.duration || '60', 10);
  const outputPath = path.resolve(args.output || 'results/burst.csv');

  if (!urls.length) {
    console.log('[burst] missing --urls');
    process.exit(1);
  }
  if (!Number.isFinite(rps) || rps <= 0) {
    console.log('[burst] invalid --rps, expected positive integer');
    process.exit(1);
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    console.log('[burst] invalid --duration, expected positive integer seconds');
    process.exit(1);
  }

  ensureFileWithHeader(outputPath, 'ts,url,status,elapsed_ms,error');
  const stream = fs.createWriteStream(outputPath, { flags: 'a' });

  let stopping = false;
  let urlIndex = 0;
  let totalSent = 0;
  let completed = 0;
  let errorCount = 0;
  const latencies = [];
  const inFlight = new Set();

  const startedAt = Date.now();
  const spacingMs = Math.max(1, Math.floor(1000 / rps));

  function launchRequest() {
    const url = `${urls[urlIndex % urls.length]}/health`;
    urlIndex += 1;
    totalSent += 1;

    const p = (async () => {
      const ts = new Date().toISOString();
      const result = await fetchWithTimeout(url, 10_000);
      completed += 1;
      latencies.push(result.elapsedMs);
      if (result.error || (result.status && result.status >= 400)) {
        errorCount += 1;
      }

      const line = [
        csvEscape(ts),
        csvEscape(url),
        csvEscape(result.status),
        csvEscape(result.elapsedMs),
        csvEscape(result.error),
      ].join(',');
      stream.write(`${line}\n`);
    })().finally(() => {
      inFlight.delete(p);
    });

    inFlight.add(p);
  }

  async function finish(exitCode = 0) {
    if (stopping) return;
    stopping = true;
    clearInterval(fireTimer);
    clearInterval(statsTimer);
    clearTimeout(endTimer);

    await Promise.allSettled([...inFlight]);
    await new Promise((resolve) => stream.end(resolve));

    const duration = (Date.now() - startedAt) / 1000;
    const avg = average(latencies);
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);
    const actualRps = duration > 0 ? completed / duration : 0;

    console.log(`[burst] done sent=${totalSent} completed=${completed} errors=${errorCount}`);
    console.log(`[burst] latency_ms avg=${avg.toFixed(2)} p50=${p50.toFixed(2)} p95=${p95.toFixed(2)} p99=${p99.toFixed(2)}`);
    console.log(`[burst] actual_rps=${actualRps.toFixed(2)} duration_s=${duration.toFixed(2)}`);
    process.exit(exitCode);
  }

  process.on('SIGINT', () => {
    console.log('[burst] SIGINT received, stopping');
    finish(0);
  });

  console.log(`[burst] start urls=${urls.length} rps=${rps} duration_s=${durationSec} output=${outputPath}`);

  const fireTimer = setInterval(() => {
    if (!stopping) {
      launchRequest();
    }
  }, spacingMs);

  const statsTimer = setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    const currentRps = elapsed > 0 ? completed / elapsed : 0;
    const avgLatency = average(latencies);
    console.log(`[burst] live total_sent=${totalSent} errors=${errorCount} avg_latency_ms=${avgLatency.toFixed(2)} current_rps=${currentRps.toFixed(2)}`);
  }, 5_000);

  const endTimer = setTimeout(() => {
    finish(0);
  }, durationSec * 1000);
}

main().catch((error) => {
  console.log(`[burst] fatal: ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
