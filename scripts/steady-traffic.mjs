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
    const stat = fs.statSync(filePath);
    needsHeader = stat.size === 0;
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
  const intervalSec = Number.parseInt(args.interval || '10', 10);
  const outputPath = path.resolve(args.output || 'results/traffic.csv');
  const urls = resolveUrls(args);

  if (!urls.length) {
    console.log('[steady] no urls provided/resolved; use --urls or --rg');
    process.exit(1);
  }
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    console.log('[steady] invalid --interval, expected positive integer seconds');
    process.exit(1);
  }

  ensureFileWithHeader(outputPath, 'ts,url,status,elapsed_ms,error');
  const stream = fs.createWriteStream(outputPath, { flags: 'a' });

  const endpoints = ['/health', '/ping'];
  const endpointIndexByApp = new Map(urls.map((u) => [u, 0]));
  let stopping = false;
  let totalRequests = 0;
  let errorCount = 0;
  const startedAt = Date.now();

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[steady] stopping... requests=${totalRequests} errors=${errorCount} duration_s=${durationSec}`);
    await new Promise((resolve) => stream.end(resolve));
    process.exit(0);
  }

  process.on('SIGINT', shutdown);

  console.log(`[steady] start apps=${urls.length} interval_s=${intervalSec} output=${outputPath}`);

  while (!stopping) {
    const cycleStart = Date.now();

    for (const baseUrl of urls) {
      if (stopping) break;

      const endpointIdx = endpointIndexByApp.get(baseUrl) || 0;
      const endpoint = endpoints[endpointIdx % endpoints.length];
      endpointIndexByApp.set(baseUrl, (endpointIdx + 1) % endpoints.length);

      const target = `${baseUrl}${endpoint}`;
      const ts = new Date().toISOString();
      const result = await fetchWithTimeout(target, 10_000);

      totalRequests += 1;
      if (result.error || (result.status && result.status !== 200)) {
        errorCount += 1;
      }

      const line = [
        csvEscape(ts),
        csvEscape(target),
        csvEscape(result.status),
        csvEscape(result.elapsedMs),
        csvEscape(result.error),
      ].join(',');
      stream.write(`${line}\n`);

      const marker = result.status === 200 ? '  ' : '!!';
      console.log(`${marker} [steady] ${target} status=${result.status || '-'} elapsed_ms=${result.elapsedMs} err=${result.error || '-'}`);
    }

    const elapsed = Date.now() - cycleStart;
    const waitMs = Math.max(0, intervalSec * 1000 - elapsed);
    if (waitMs > 0 && !stopping) {
      await sleep(waitMs);
    }
  }
}

main().catch((error) => {
  console.log(`[steady] fatal: ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
