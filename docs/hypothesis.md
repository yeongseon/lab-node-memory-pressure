# Hypothesis: Kernel Page Reclaim Under Memory Pressure Causes CPU Increase

## Customer Scenario

An Azure App Service Plan (B1, Linux) hosts many Node.js applications. Over time,
worker-level memory usage accumulates to approximately 90%. The customer observes
unexpected CPU spikes even though application traffic load has not increased.

**Source metric**: Azure Portal → Diagnose and solve problems → Instance Memory Usage
(App Service Plan) shows `PercentPhysicalMemoryUsed` at ~90% across all worker instances.

## Causal Chain (Hypothesis)

```
1. Multiple Node.js apps share the same App Service Plan worker(s)
       ↓
2. Each app consumes memory over time (caches, buffers, V8 heap growth)
       ↓
3. Worker-level physical memory usage climbs toward ~90%
       ↓
4. Free memory decreases; OS buffer/cache shrinks
       ↓
5. Swap space (if available) gets progressively consumed
       ↓
6. Linux kernel activates page reclaim mechanisms:
   - kswapd (background page scanner)
   - direct reclaim (synchronous, blocks allocation)
   - page writeback (dirty pages flushed to disk)
       ↓
7. Page reclaim consumes CPU cycles independently of application workload
       ↓
8. CpuPercentage rises even though request throughput is flat or low
```

## What We Need to Prove or Disprove

### Proof criteria (ALL must be met):
1. **Memory sustained at ≥88%** for 30+ minutes on the worker/plan metric
2. **Traffic is flat**: request rate within ±10% of baseline, no bursts during observation
3. **CPU rises materially**: CpuPercentage ≥2x baseline OR +10 percentage points sustained for 15+ minutes
4. **Reclaim activity visible**: sustained increase in at least 2 of:
   - `pgscan_kswapd` (pages scanned by kswapd)
   - `pgscan_direct` (pages scanned by direct reclaim)
   - `pgsteal_kswapd` (pages reclaimed by kswapd)
   - `pgsteal_direct` (pages reclaimed by direct reclaim)
   - `allocstall` (allocation stalls due to reclaim)
   - PSI memory pressure (`/proc/pressure/memory`)
5. **Swap-specific proof** (only if SwapTotal > 0):
   - SwapFree decreases over time
   - pswpin/pswpout counters increase during CPU rise

### Disproof criteria (ANY sufficient):
- High memory is sustained with flat traffic, but CPU and reclaim counters stay near baseline across repeated runs
- CPU rises, but reclaim counters show no activity (CPU increase from another cause)
- SwapTotal = 0 AND no reclaim counters rise (no kernel memory pressure mechanism active)

## Variables

### Independent Variables (what we control):
- Number of apps on the plan (2 → 4 → 6 → 8)
- Memory allocation per app (ALLOC_MB: 50 → 100 → 150 → 200)
- Deployment mode (ZIP deploy vs Web App for Containers)
- Traffic rate (fixed light: 1 req/10s/app)

### Dependent Variables (what we measure):
- Plan CpuPercentage (Azure Monitor, 1-min granularity)
- Plan MemoryPercentage (Azure Monitor, 1-min granularity)
- PercentPhysicalMemoryUsed (Diagnostics blade, if accessible)
- /proc/meminfo: MemTotal, MemFree, MemAvailable, SwapTotal, SwapFree, Cached, Dirty, SReclaimable
- /proc/vmstat: pswpin, pswpout, pgscan_kswapd, pgscan_direct, pgsteal_kswapd, pgsteal_direct, pgfault, pgmajfault, allocstall
- /proc/pressure/memory: PSI metrics (some avg10, avg60, avg300, total)
- App-level: process.memoryUsage() (rss, heapUsed, external, arrayBuffers)
- App-level: requestCount, cpuUsage

### Controlled Variables (held constant):
- Plan SKU: B1 (1 vCPU, 1.75 GB RAM)
- Region: koreacentral
- Node.js version: 20-lts
- Traffic pattern: 1 request per 10 seconds per app (steady-traffic.mjs)
- App code: identical across all apps (only ALLOC_MB and APP_NAME differ)

## Experiment Matrix

| Phase | Deploy Mode | Apps | ALLOC_MB | Target Memory% | Traffic | Duration | Purpose |
|-------|------------|------|----------|----------------|---------|----------|---------|
| 0 | ZIP | 2 | 50 | ~40% | None→Light | 15 min | Discovery: verify swap, metrics pipeline |
| 1 | ZIP | 2 | 50 | ~50-60% | Light | 30-60 min | Baseline: CPU/memory/swap under low pressure |
| 2a | ZIP | 4 | 100 | ~80-85% | Light | 60 min | Approach plateau |
| 2b | ZIP | 6 | 100 | ~88-92% | Light | 60-120 min | **Core test**: high memory, flat traffic → CPU? |
| 3 | ZIP | (same as 2b) | (same) | ~88-92% | Burst 60s | 10 min | Traffic burst at high memory |
| 4 | Container | (repeat phases 0-3) | | | | | Compare deployment modes |

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| SwapTotal = 0 on B1 | Cannot prove swap-specific chain | Revise to "reclaim-driven CPU" hypothesis |
| /proc is container-scoped | Counters don't reflect host | Use plan-level Azure Monitor + cgroup stats as primary |
| MemoryPercentage doesn't reflect containers | Can't reach 90% target | Use ZIP deploy as primary evidence |
| Platform noise masks signal | Ambiguous results | Repeat 3x per configuration |
| B1 single vCPU | Reclaim competes directly with app | Actually supports hypothesis — single CPU makes it MORE visible |

## Key Metric Relationship

```
If hypothesis is TRUE, we expect this correlation:

MemoryUsed ↑ → SwapFree ↓ → pgscan_kswapd ↑ → CpuPercentage ↑
                              (while request_rate stays flat)

If hypothesis is FALSE:

MemoryUsed ↑ → SwapFree ↓ → pgscan_kswapd flat → CpuPercentage flat
                              (kernel handles pressure without CPU cost)
```
