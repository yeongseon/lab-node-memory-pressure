#!/usr/bin/env node

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

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

function resolveUrls(args) {
  if (args.urls) {
    return args.urls
      .split(',')
      .map((u) => normalizeBaseUrl(u.trim()))
      .filter(Boolean);
  }

  if (!args.rg) {
    return [];
  }

  const prefix = args.prefix || 'memlabnode';
  const count = Number.parseInt(args.count || '0', 10);
  const query = `[?starts_with(name,'${prefix}')].defaultHostName`;
  const cmd = `az webapp list --resource-group "${args.rg}" --query "${query}" --output json`;
  const raw = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const hostnames = JSON.parse(raw);

  if (!Array.isArray(hostnames)) return [];
  const normalized = hostnames.map((h) => normalizeBaseUrl(h)).filter(Boolean);
  if (Number.isFinite(count) && count > 0) {
    return normalized.slice(0, count);
  }
  return normalized;
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

function numOrEmpty(v) {
  return Number.isFinite(v) ? v : '';
}

function readNested(obj, keys) {
  let cur = obj;
  for (const key of keys) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const intervalSec = Number.parseInt(args.interval || '5', 10);
  const outputPath = path.resolve(args.output || 'results/diag.jsonl');
  const summaryPath = path.resolve('results/diag-summary.csv');
  const urls = resolveUrls(args);

  if (!urls.length) {
    console.log('[diag] no urls provided/resolved; use --urls or --rg');
    process.exit(1);
  }
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    console.log('[diag] invalid --interval, expected positive integer seconds');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });

  const jsonlStream = fs.createWriteStream(outputPath, { flags: 'a' });
  ensureFileWithHeader(
    summaryPath,
    'ts,app,memTotal_kb,memFree_kb,memAvailable_kb,swapTotal_kb,swapFree_kb,cached_kb,dirty_kb,sReclaimable_kb,pswpin,pswpout,pgscan_kswapd,pgscan_direct,pgsteal_kswapd,pgsteal_direct,pgfault,pgmajfault,allocstall,app_rss_bytes,app_heapUsed_bytes,app_external_bytes,app_requestCount',
  );
  const summaryStream = fs.createWriteStream(summaryPath, { flags: 'a' });

  let stopping = false;
  const startedAt = Date.now();
  let totalRecords = 0;
  let totalErrors = 0;
  let totalCycles = 0;

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[diag] stopping... cycles=${totalCycles} records=${totalRecords} errors=${totalErrors} duration_s=${durationSec}`);
    await Promise.all([
      new Promise((resolve) => jsonlStream.end(resolve)),
      new Promise((resolve) => summaryStream.end(resolve)),
    ]);
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  console.log(`[diag] start apps=${urls.length} interval_s=${intervalSec} jsonl=${outputPath} summary=${summaryPath}`);

  while (!stopping) {
    const cycleStart = Date.now();
    totalCycles += 1;

    for (const app of urls) {
      if (stopping) break;

      const collectTs = new Date().toISOString();
      const record = { collectTs, app, diag: null, stats: null };

      try {
        record.diag = await fetchJsonWithTimeout(`${app}/diag/proc`, 5_000);
      } catch (error) {
        totalErrors += 1;
        record.diag = { error: error?.name === 'AbortError' ? 'timeout' : (error?.message || 'diag_fetch_failed') };
        console.log(`[diag] warn app=${app} endpoint=/diag/proc err=${record.diag.error}`);
      }

      try {
        record.stats = await fetchJsonWithTimeout(`${app}/stats`, 5_000);
      } catch (error) {
        totalErrors += 1;
        record.stats = { error: error?.name === 'AbortError' ? 'timeout' : (error?.message || 'stats_fetch_failed') };
        console.log(`[diag] warn app=${app} endpoint=/stats err=${record.stats.error}`);
      }

      jsonlStream.write(`${JSON.stringify(record)}\n`);
      totalRecords += 1;

      const meminfo = readNested(record, ['diag', 'proc', 'meminfo', 'parsed']) || {};
      const vmstat = readNested(record, ['diag', 'proc', 'vmstat', 'parsed']) || {};
      const memoryUsage = readNested(record, ['stats', 'memoryUsage']) || {};

      const summaryLine = [
        csvEscape(collectTs),
        csvEscape(app),
        csvEscape(numOrEmpty(readNested(meminfo, ['MemTotal', 'value']))),
        csvEscape(numOrEmpty(readNested(meminfo, ['MemFree', 'value']))),
        csvEscape(numOrEmpty(readNested(meminfo, ['MemAvailable', 'value']))),
        csvEscape(numOrEmpty(readNested(meminfo, ['SwapTotal', 'value']))),
        csvEscape(numOrEmpty(readNested(meminfo, ['SwapFree', 'value']))),
        csvEscape(numOrEmpty(readNested(meminfo, ['Cached', 'value']))),
        csvEscape(numOrEmpty(readNested(meminfo, ['Dirty', 'value']))),
        csvEscape(numOrEmpty(readNested(meminfo, ['SReclaimable', 'value']))),
        csvEscape(numOrEmpty(readNested(vmstat, ['pswpin', 'value']))),
        csvEscape(numOrEmpty(readNested(vmstat, ['pswpout', 'value']))),
        csvEscape(numOrEmpty(readNested(vmstat, ['pgscan_kswapd', 'value']))),
        csvEscape(numOrEmpty(readNested(vmstat, ['pgscan_direct', 'value']))),
        csvEscape(numOrEmpty(readNested(vmstat, ['pgsteal_kswapd', 'value']))),
        csvEscape(numOrEmpty(readNested(vmstat, ['pgsteal_direct', 'value']))),
        csvEscape(numOrEmpty(readNested(vmstat, ['pgfault', 'value']))),
        csvEscape(numOrEmpty(readNested(vmstat, ['pgmajfault', 'value']))),
        csvEscape(numOrEmpty(readNested(vmstat, ['allocstall', 'value']))),
        csvEscape(numOrEmpty(memoryUsage.rss)),
        csvEscape(numOrEmpty(memoryUsage.heapUsed)),
        csvEscape(numOrEmpty(memoryUsage.external)),
        csvEscape(numOrEmpty(readNested(record, ['stats', 'requestCount']))),
      ].join(',');
      summaryStream.write(`${summaryLine}\n`);

      const diagOk = !readNested(record, ['diag', 'error']);
      const statsOk = !readNested(record, ['stats', 'error']);
      console.log(`[diag] ts=${collectTs} app=${app} diag=${diagOk ? 'ok' : 'err'} stats=${statsOk ? 'ok' : 'err'}`);
    }

    const elapsed = Date.now() - cycleStart;
    const waitMs = Math.max(0, intervalSec * 1000 - elapsed);
    if (waitMs > 0 && !stopping) {
      await sleep(waitMs);
    }
  }
}

main().catch((error) => {
  console.log(`[diag] fatal: ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
