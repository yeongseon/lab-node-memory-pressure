#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const METRICS = new Set(['CpuPercentage', 'MemoryPercentage']);
const CSV_HEADER = 'snap_ts,resource,resource_type,metric,value';

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

function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function getPlanResource(metricId) {
  if (typeof metricId !== 'string' || !metricId.length) return null;
  const splitToken = '/providers/Microsoft.Insights/';
  const idx = metricId.indexOf(splitToken);
  if (idx === -1) return metricId;
  return metricId.slice(0, idx);
}

function buildFileSortKey(fileName) {
  const match = fileName.match(/^azure-plan-(.+)\.json$/);
  return match ? match[1] : fileName;
}

async function readAppRows(csvPath) {
  const text = await fs.readFile(csvPath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];

  const appRows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const cols = parseCsvLine(line);
    if (cols[2] === 'app') {
      appRows.push(line);
    }
  }
  return appRows;
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(scriptDir, '..');
  const resultsDir = path.join(rootDir, 'results', 'container-deploy');
  const outputCsvPath = path.join(resultsDir, 'azure-metrics.csv');

  const entries = await fs.readdir(resultsDir, { withFileTypes: true });
  const planFiles = entries
    .filter((entry) => entry.isFile() && /^azure-plan-.*\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => buildFileSortKey(a).localeCompare(buildFileSortKey(b)));

  if (!planFiles.length) {
    throw new Error('No plan JSON files found: results/container-deploy/azure-plan-*.json');
  }

  const appRows = await readAppRows(outputCsvPath);

  const dedup = new Map();
  let parsedFiles = 0;
  let skippedParseFiles = 0;

  for (const fileName of planFiles) {
    const filePath = path.join(resultsDir, fileName);
    let payload;
    try {
      const text = await fs.readFile(filePath, 'utf8');
      payload = JSON.parse(text);
    } catch (error) {
      skippedParseFiles += 1;
      console.warn(`[rebuild-container-csv] warn parse failed, skipping ${fileName}: ${error.message}`);
      continue;
    }

    parsedFiles += 1;
    const values = Array.isArray(payload?.value) ? payload.value : [];
    for (const metricObj of values) {
      const metric = metricObj?.name?.value;
      if (!METRICS.has(metric)) continue;

      const resource = getPlanResource(metricObj?.id);
      if (!resource) continue;

      const points = metricObj?.timeseries?.[0]?.data;
      if (!Array.isArray(points)) continue;

      for (const point of points) {
        if (!Object.hasOwn(point ?? {}, 'average')) continue;
        const snapTs = point?.timeStamp;
        if (!snapTs) continue;

        const key = `${snapTs}__${metric}`;
        dedup.set(key, {
          snapTs,
          resource,
          resourceType: 'plan',
          metric,
          value: point.average,
        });
      }
    }
  }

  const planRows = [...dedup.values()].sort((a, b) => {
    const tsCmp = String(a.snapTs).localeCompare(String(b.snapTs));
    if (tsCmp !== 0) return tsCmp;
    return String(a.metric).localeCompare(String(b.metric));
  });

  const planRowLines = planRows.map((row) => [
    csvEscape(row.snapTs),
    csvEscape(row.resource),
    csvEscape(row.resourceType),
    csvEscape(row.metric),
    csvEscape(row.value),
  ].join(','));

  const combinedLines = [
    ...planRowLines,
    ...appRows,
  ].sort((a, b) => {
    const aTs = parseCsvLine(a)[0] ?? '';
    const bTs = parseCsvLine(b)[0] ?? '';
    const tsCmp = aTs.localeCompare(bTs);
    if (tsCmp !== 0) return tsCmp;
    return a.localeCompare(b);
  });

  const output = `${CSV_HEADER}\n${combinedLines.join('\n')}\n`;
  await fs.writeFile(outputCsvPath, output, 'utf8');

  const uniqueTimestamps = new Set(planRows.map((row) => row.snapTs));
  console.log(`[rebuild-container-csv] plan files found=${planFiles.length}, parsed=${parsedFiles}, parse_skipped=${skippedParseFiles}`);
  console.log(`[rebuild-container-csv] extracted unique_timestamps=${uniqueTimestamps.size}, plan_rows=${planRows.length}, preserved_app_rows=${appRows.length}`);
  console.log(`[rebuild-container-csv] wrote ${outputCsvPath} total_rows=${combinedLines.length}`);
}

main().catch((error) => {
  console.error(`[rebuild-container-csv] error: ${error.message}`);
  process.exitCode = 1;
});
