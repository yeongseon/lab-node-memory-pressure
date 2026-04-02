#!/usr/bin/env node

import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(new URL('../package.json', import.meta.url));
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

const PALETTE = {
  red: '#e74c3c',
  blue: '#3498db',
  green: '#2ecc71',
  orange: '#f39c12',
  purple: '#9b59b6',
  teal: '#1abc9c',
  gray: '#95a5a6',
  dark: '#2c3e50',
};

function parseArgs(argv) {
  const args = { input: 'results/', output: 'results/charts/' };
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

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

function parseJsonl(text) {
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function readCsvIfExists(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const rows = parseCsv(text);
    if (!rows.length) {
      console.warn(`[charts] warn empty file: ${filePath}`);
      return [];
    }
    return rows;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.warn(`[charts] warn missing file: ${filePath}`);
      return null;
    }
    throw error;
  }
}

async function readJsonlIfExists(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const rows = parseJsonl(text);
    if (!rows.length) {
      console.warn(`[charts] warn empty file: ${filePath}`);
      return [];
    }
    return rows;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function chartBaseOptions(title) {
  return {
    responsive: false,
    maintainAspectRatio: false,
    parsing: false,
    scales: {
      x: {
        grid: { color: 'rgba(127, 140, 141, 0.15)' },
        ticks: { maxRotation: 45, minRotation: 0, font: { family: 'sans-serif', size: 11 } },
      },
      y: {
        grid: { color: 'rgba(127, 140, 141, 0.2)' },
        ticks: { font: { family: 'sans-serif', size: 11 } },
      },
    },
    plugins: {
      title: {
        display: true,
        text: title,
        font: { family: 'sans-serif', size: 14, weight: '600' },
      },
      legend: {
        position: 'top',
        labels: { font: { family: 'sans-serif', size: 11 } },
      },
    },
    elements: {
      line: { borderWidth: 2, tension: 0.2 },
      point: { radius: 0 },
    },
  };
}

function sortByTs(rows, key = 'ts') {
  return [...rows].sort((a, b) => String(a[key] || '').localeCompare(String(b[key] || '')));
}

function deltaSeries(values) {
  const out = [];
  let prev = null;
  for (const v of values) {
    if (v === null) {
      out.push(null);
      prev = null;
      continue;
    }
    if (prev === null) {
      out.push(0);
    } else {
      out.push(Math.max(0, v - prev));
    }
    prev = v;
  }
  return out;
}

function rollingAverage(values, windowSize) {
  const out = [];
  let sum = 0;
  const q = [];
  for (const v of values) {
    const n = v ?? 0;
    q.push(n);
    sum += n;
    if (q.length > windowSize) {
      sum -= q.shift();
    }
    out.push(sum / q.length);
  }
  return out;
}

function rollingErrorRate(values, windowSize) {
  const out = [];
  const q = [];
  let sum = 0;
  for (const v of values) {
    q.push(v ? 1 : 0);
    sum += v ? 1 : 0;
    if (q.length > windowSize) {
      sum -= q.shift();
    }
    out.push((sum / q.length) * 100);
  }
  return out;
}

function makeLineDataset(label, data, color, yAxisID = 'y', extra = {}) {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: color,
    yAxisID,
    ...extra,
  };
}

async function renderPng({ outputFile, width, height, labels, datasets, title, scales }) {
  const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height, backgroundColour: 'white' });
  const config = {
    type: 'line',
    data: { labels, datasets },
    options: {
      ...chartBaseOptions(title),
      scales: scales || chartBaseOptions(title).scales,
    },
  };
  const buffer = await chartJSNodeCanvas.renderToBuffer(config, 'image/png');
  await fs.writeFile(outputFile, buffer);
}

async function generateCpuMemoryTimeline(inputDir, outputDir) {
  const filePath = path.join(inputDir, 'azure-metrics.csv');
  const rows = await readCsvIfExists(filePath);
  if (!rows || !rows.length) return null;

  const filtered = sortByTs(rows, 'snap_ts').filter(
    (r) => r.resource_type === 'plan' && (r.metric === 'CpuPercentage' || r.metric === 'MemoryPercentage'),
  );
  if (!filtered.length) {
    console.warn('[charts] warn no plan CpuPercentage/MemoryPercentage data');
    return null;
  }

  const byTs = new Map();
  for (const r of filtered) {
    const ts = r.snap_ts;
    if (!byTs.has(ts)) byTs.set(ts, { cpu: null, memory: null });
    const point = byTs.get(ts);
    if (r.metric === 'CpuPercentage') point.cpu = toNumber(r.value);
    if (r.metric === 'MemoryPercentage') point.memory = toNumber(r.value);
  }

  const labels = [...byTs.keys()];
  const cpu = labels.map((l) => byTs.get(l).cpu);
  const memory = labels.map((l) => byTs.get(l).memory);

  await renderPng({
    outputFile: path.join(outputDir, 'cpu-memory-timeline.png'),
    width: 1200,
    height: 600,
    labels,
    title: 'App Service Plan — CPU% vs Memory% Over Time',
    datasets: [
      makeLineDataset('CPU %', cpu, PALETTE.red, 'yCpu'),
      makeLineDataset('Memory %', memory, PALETTE.blue, 'yMem'),
    ],
    scales: {
      x: chartBaseOptions('').scales.x,
      yCpu: {
        type: 'linear',
        position: 'left',
        title: { display: true, text: 'CPU %' },
        grid: { color: 'rgba(127, 140, 141, 0.2)' },
      },
      yMem: {
        type: 'linear',
        position: 'right',
        title: { display: true, text: 'Memory %' },
        grid: { drawOnChartArea: false },
      },
    },
  });

  return 'cpu-memory-timeline.png';
}

async function loadDiagSummary(inputDir) {
  const filePath = path.join(inputDir, 'diag-summary.csv');
  const rows = await readCsvIfExists(filePath);
  if (!rows || !rows.length) return null;
  return sortByTs(rows, 'ts');
}

async function generateKernelReclaimTimeline(diagRows, outputDir) {
  if (!diagRows || !diagRows.length) return null;
  const labels = diagRows.map((r) => r.ts);
  const metrics = [
    ['pgscan_kswapd', PALETTE.purple],
    ['pgscan_direct', '#8e44ad'],
    ['pgsteal_kswapd', '#6c3483'],
    ['pgsteal_direct', '#af7ac5'],
  ];

  const datasets = metrics.map(([name, color]) => {
    const vals = deltaSeries(diagRows.map((r) => toNumber(r[name])));
    return makeLineDataset(name, vals, color);
  });

  if (!datasets.some((d) => d.data.some((v) => v !== null && v !== 0))) {
    console.warn('[charts] warn no kernel reclaim values in diag-summary.csv');
    return null;
  }

  await renderPng({
    outputFile: path.join(outputDir, 'kernel-reclaim-timeline.png'),
    width: 1200,
    height: 600,
    labels,
    datasets,
    title: 'Kernel Page Reclaim Activity (Δ per interval)',
  });
  return 'kernel-reclaim-timeline.png';
}

async function generateSwapActivityTimeline(diagRows, outputDir) {
  if (!diagRows || !diagRows.length) return null;
  const labels = diagRows.map((r) => r.ts);
  const pswpin = deltaSeries(diagRows.map((r) => toNumber(r.pswpin)));
  const pswpout = deltaSeries(diagRows.map((r) => toNumber(r.pswpout)));
  if (![...pswpin, ...pswpout].some((v) => v !== null && v !== 0)) {
    console.warn('[charts] warn no swap activity values in diag-summary.csv');
    return null;
  }

  await renderPng({
    outputFile: path.join(outputDir, 'swap-activity-timeline.png'),
    width: 1200,
    height: 600,
    labels,
    datasets: [
      makeLineDataset('pswpin (Δ)', pswpin, PALETTE.orange),
      makeLineDataset('pswpout (Δ)', pswpout, '#d35400'),
    ],
    title: 'Swap I/O Activity (Δ per interval)',
  });
  return 'swap-activity-timeline.png';
}

async function generateMemoryBreakdownTimeline(diagRows, outputDir) {
  if (!diagRows || !diagRows.length) return null;
  const labels = diagRows.map((r) => r.ts);
  const datasets = [
    makeLineDataset('MemTotal (KB)', diagRows.map((r) => toNumber(r.memTotal_kb)), PALETTE.dark),
    makeLineDataset('MemFree (KB)', diagRows.map((r) => toNumber(r.memFree_kb)), PALETTE.green),
    makeLineDataset('MemAvailable (KB)', diagRows.map((r) => toNumber(r.memAvailable_kb)), '#27ae60'),
    makeLineDataset('Cached (KB)', diagRows.map((r) => toNumber(r.cached_kb)), '#16a085'),
    makeLineDataset('SwapTotal (KB)', diagRows.map((r) => toNumber(r.swapTotal_kb)), PALETTE.orange),
    makeLineDataset('SwapFree (KB)', diagRows.map((r) => toNumber(r.swapFree_kb)), '#e67e22'),
  ];

  await renderPng({
    outputFile: path.join(outputDir, 'memory-breakdown-timeline.png'),
    width: 1200,
    height: 600,
    labels,
    datasets,
    title: 'OS Memory Breakdown Over Time (KB)',
  });
  return 'memory-breakdown-timeline.png';
}

async function generateLatencyTimeline(inputDir, outputDir) {
  const filePath = path.join(inputDir, 'traffic.csv');
  const rows = await readCsvIfExists(filePath);
  if (!rows || !rows.length) return null;

  const sorted = sortByTs(rows, 'ts');
  const labels = sorted.map((r) => r.ts);
  const elapsed = sorted.map((r) => toNumber(r.elapsed_ms)).map((v) => v ?? 0);
  const errors = sorted.map((r) => Boolean((r.error || '').trim()) || (toNumber(r.status) ?? 200) >= 400);

  const latencyAvg = rollingAverage(elapsed, 10);
  const errorRate = rollingErrorRate(errors, 10);

  await renderPng({
    outputFile: path.join(outputDir, 'latency-timeline.png'),
    width: 1200,
    height: 600,
    labels,
    datasets: [
      makeLineDataset('Elapsed ms (rolling avg 10)', latencyAvg, PALETTE.teal, 'yLatency'),
      makeLineDataset('Error rate % (rolling 10)', errorRate, PALETTE.red, 'yErr'),
    ],
    scales: {
      x: chartBaseOptions('').scales.x,
      yLatency: {
        type: 'linear',
        position: 'left',
        title: { display: true, text: 'Latency (ms)' },
        grid: { color: 'rgba(127, 140, 141, 0.2)' },
      },
      yErr: {
        type: 'linear',
        min: 0,
        max: 100,
        position: 'right',
        title: { display: true, text: 'Error rate %' },
        grid: { drawOnChartArea: false },
      },
    },
    title: 'Request Latency Over Time',
  });

  return 'latency-timeline.png';
}

async function generateAppRssTimeline(diagRows, outputDir) {
  if (!diagRows || !diagRows.length) return null;
  const appSet = new Set(diagRows.map((r) => r.app).filter(Boolean));
  const apps = [...appSet].sort();
  if (!apps.length) {
    console.warn('[charts] warn no app labels in diag-summary.csv');
    return null;
  }

  const labels = [...new Set(diagRows.map((r) => r.ts))].sort();
  const byAppTs = new Map();
  for (const row of diagRows) {
    const key = `${row.app}::${row.ts}`;
    byAppTs.set(key, toNumber(row.app_rss_bytes));
  }

  const colors = [PALETTE.blue, PALETTE.red, PALETTE.green, PALETTE.purple, PALETTE.orange, PALETTE.teal, '#34495e', '#7f8c8d'];
  const datasets = apps.map((app, idx) => {
    const mb = labels.map((ts) => {
      const n = byAppTs.get(`${app}::${ts}`);
      return n === null || n === undefined ? null : n / 1024 / 1024;
    });
    return makeLineDataset(app, mb, colors[idx % colors.length]);
  });

  await renderPng({
    outputFile: path.join(outputDir, 'app-rss-timeline.png'),
    width: 1200,
    height: 600,
    labels,
    datasets,
    title: 'Per-App RSS Memory (MB)',
  });
  return 'app-rss-timeline.png';
}

async function loadPhaseMarkers(inputDir) {
  const markerCsvCandidates = ['phase-markers.csv', 'phases.csv'];
  for (const name of markerCsvCandidates) {
    const rows = await readCsvIfExists(path.join(inputDir, name));
    if (rows?.length) return rows;
  }

  const markerJsonlCandidates = ['phase-markers.jsonl', 'phases.jsonl'];
  for (const name of markerJsonlCandidates) {
    const rows = await readJsonlIfExists(path.join(inputDir, name));
    if (rows?.length) return rows;
  }

  return null;
}

function normalizePhaseIntervals(markerRows) {
  if (!markerRows || !markerRows.length) return [];
  const direct = markerRows
    .map((r) => ({
      phase: String(r.phase || r.name || '').trim(),
      start: String(r.start_ts || r.start || '').trim(),
      end: String(r.end_ts || r.end || '').trim(),
      ts: String(r.ts || '').trim(),
    }))
    .filter((r) => r.phase);

  const intervals = [];
  for (const r of direct) {
    if (r.start && r.end) {
      intervals.push({ phase: r.phase, start: r.start, end: r.end });
    }
  }

  if (intervals.length) return intervals;

  const byPhase = new Map();
  for (const r of direct) {
    if (!r.ts) continue;
    if (!byPhase.has(r.phase)) byPhase.set(r.phase, []);
    byPhase.get(r.phase).push(r.ts);
  }

  for (const [phase, tsList] of byPhase.entries()) {
    tsList.sort();
    intervals.push({ phase, start: tsList[0], end: tsList[tsList.length - 1] });
  }

  return intervals;
}

function average(nums) {
  const clean = nums.filter((n) => Number.isFinite(n));
  if (!clean.length) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

function inRange(ts, start, end) {
  return ts >= start && ts <= end;
}

async function generatePhaseComparison(inputDir, outputDir) {
  const markers = await loadPhaseMarkers(inputDir);
  if (!markers || !markers.length) {
    console.warn('[charts] warn no phase markers found; skipping phase-comparison.png');
    return null;
  }

  const intervals = normalizePhaseIntervals(markers);
  if (!intervals.length) {
    console.warn('[charts] warn phase markers present but no usable intervals; skipping phase-comparison.png');
    return null;
  }

  const baseline = intervals.find((i) => /baseline|phase\s*1/i.test(i.phase));
  const core = intervals.find((i) => /core\s*test|phase\s*2b|2b/i.test(i.phase));
  if (!baseline || !core) {
    console.warn('[charts] warn baseline/core phase intervals missing; skipping phase-comparison.png');
    return null;
  }

  const metricsRows = await readCsvIfExists(path.join(inputDir, 'azure-metrics.csv'));
  const trafficRows = await readCsvIfExists(path.join(inputDir, 'traffic.csv'));
  if (!metricsRows || !trafficRows) {
    console.warn('[charts] warn missing metric files for phase comparison; skipping');
    return null;
  }

  function summarizePhase(interval) {
    const phaseMetrics = metricsRows.filter((r) => r.resource_type === 'plan' && inRange(r.snap_ts, interval.start, interval.end));
    const cpu = average(phaseMetrics.filter((r) => r.metric === 'CpuPercentage').map((r) => toNumber(r.value)));
    const mem = average(phaseMetrics.filter((r) => r.metric === 'MemoryPercentage').map((r) => toNumber(r.value)));
    const lat = average(
      trafficRows
        .filter((r) => inRange(r.ts, interval.start, interval.end))
        .map((r) => toNumber(r.elapsed_ms)),
    );
    return { cpu, mem, lat };
  }

  const base = summarizePhase(baseline);
  const corex = summarizePhase(core);
  if (![base.cpu, base.mem, base.lat, corex.cpu, corex.mem, corex.lat].some((v) => Number.isFinite(v))) {
    console.warn('[charts] warn no comparable values for phase comparison; skipping');
    return null;
  }

  const labels = ['Avg CPU %', 'Avg Memory %', 'Avg Latency ms'];
  const chartJSNodeCanvas = new ChartJSNodeCanvas({ width: 1200, height: 400, backgroundColour: 'white' });
  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: `Baseline (${baseline.phase})`,
          backgroundColor: PALETTE.blue,
          data: [base.cpu, base.mem, base.lat],
        },
        {
          label: `Core Test (${core.phase})`,
          backgroundColor: PALETTE.red,
          data: [corex.cpu, corex.mem, corex.lat],
        },
      ],
    },
    options: chartBaseOptions('Baseline vs Core Test Comparison'),
  };
  const buffer = await chartJSNodeCanvas.renderToBuffer(config, 'image/png');
  await fs.writeFile(path.join(outputDir, 'phase-comparison.png'), buffer);
  return 'phase-comparison.png';
}

async function generateBurstLatencyDistribution(inputDir, outputDir) {
  const rows = await readCsvIfExists(path.join(inputDir, 'burst.csv'));
  if (!rows || !rows.length) return null;

  const values = rows.map((r) => toNumber(r.elapsed_ms)).filter((n) => Number.isFinite(n));
  if (!values.length) {
    console.warn('[charts] warn burst.csv has no elapsed_ms values');
    return null;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const binCount = Math.max(8, Math.min(30, Math.ceil(Math.sqrt(values.length))));
  const width = Math.max(1, (max - min) / binCount);
  const bins = Array.from({ length: binCount }, () => 0);

  for (const v of values) {
    const idx = Math.min(binCount - 1, Math.floor((v - min) / width));
    bins[idx] += 1;
  }

  const labels = bins.map((_, i) => {
    const from = min + i * width;
    const to = from + width;
    return `${from.toFixed(0)}-${to.toFixed(0)}ms`;
  });

  const chartJSNodeCanvas = new ChartJSNodeCanvas({ width: 1200, height: 400, backgroundColour: 'white' });
  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Request count',
          backgroundColor: PALETTE.teal,
          borderColor: '#117a65',
          borderWidth: 1,
          data: bins,
        },
      ],
    },
    options: chartBaseOptions('Burst Traffic Latency Distribution'),
  };
  const buffer = await chartJSNodeCanvas.renderToBuffer(config, 'image/png');
  await fs.writeFile(path.join(outputDir, 'burst-latency-distribution.png'), buffer);
  return 'burst-latency-distribution.png';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputDir = path.resolve(args.input || 'results/');
  const outputDir = path.resolve(args.output || 'results/charts/');

  await fs.mkdir(outputDir, { recursive: true });

  const generated = [];

  const diagRows = await loadDiagSummary(inputDir);

  const fns = [
    () => generateCpuMemoryTimeline(inputDir, outputDir),
    () => generateKernelReclaimTimeline(diagRows, outputDir),
    () => generateSwapActivityTimeline(diagRows, outputDir),
    () => generateMemoryBreakdownTimeline(diagRows, outputDir),
    () => generateLatencyTimeline(inputDir, outputDir),
    () => generateAppRssTimeline(diagRows, outputDir),
    () => generatePhaseComparison(inputDir, outputDir),
    () => generateBurstLatencyDistribution(inputDir, outputDir),
  ];

  for (const fn of fns) {
    const name = await fn();
    if (name) generated.push(name);
  }

  console.log(`[charts] Generated ${generated.length} charts in ${outputDir}`);
  for (const name of generated) {
    console.log(` - ${name}`);
  }
}

main().catch((error) => {
  console.error(`[charts] fatal: ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
