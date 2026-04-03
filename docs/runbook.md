# Experiment Runbook

Step-by-step execution guide for the memory pressure experiment.

## Prerequisites

| Tool | Verification |
|------|-------------|
| Azure CLI ≥ 2.50 | `az version` |
| Bicep CLI | `az bicep version` |
| Node.js ≥ 20 | `node --version` |
| jq | `jq --version` |
| Active Azure subscription | `az account show` |

```bash
az login
az account set --subscription "<YOUR_SUBSCRIPTION_ID>"
```

## Environment Variables

```bash
export RESOURCE_GROUP="rg-node-memory-lab"
export LOCATION="koreacentral"
export NAME_PREFIX="memlabnode"
export PLAN_SKU="B1"
export INSTANCE_COUNT=1
```

---

## Experiment A: ZIP Deploy

### Phase 0 — Discovery (15 min)

**Goal**: Verify metrics pipeline works, check if swap exists.

```bash
# Deploy 2 apps × 50MB
export APP_COUNT=2 ALLOC_MB=50
bash scripts/deploy-zip.sh

# Wait for apps to be healthy (2-3 min)
curl https://memlabnode-1.azurewebsites.net/health
curl https://memlabnode-2.azurewebsites.net/health

# Check if /diag/proc works and if swap exists
curl -s https://memlabnode-1.azurewebsites.net/diag/proc | jq '.proc.meminfo.parsed.SwapTotal'

# Record discovery results
curl -s https://memlabnode-1.azurewebsites.net/diag/proc | jq . > results/discovery-diag.json
```

**Decision point**: If SwapTotal = 0, note this and adjust hypothesis to "reclaim-driven CPU" (not swap-specific).

### Phase 1 — Baseline (30-60 min)

**Goal**: Establish CPU/memory/swap baseline under light traffic at low memory pressure.

```bash
# Terminal 1: Light traffic
node scripts/steady-traffic.mjs \
  --rg $RESOURCE_GROUP --prefix $NAME_PREFIX --count 2 \
  --interval 10 --output results/zip-phase1-traffic.csv

# Terminal 2: Collect /diag/proc data every 5 seconds
node scripts/collect-diag.mjs \
  --rg $RESOURCE_GROUP --prefix $NAME_PREFIX --count 2 \
  --interval 5 --output results/zip-phase1-diag.jsonl

# Terminal 3: Azure Monitor metrics every 60 seconds
bash scripts/collect-metrics.sh --watch 60

# Run for 30-60 minutes, then Ctrl+C all terminals
```

**Expected**: CPU 10-20%, Memory ~50-60%, swap counters flat, pgscan counters near zero.

### Phase 2a — Approach Plateau (60 min)

**Goal**: Increase memory toward 80-85%.

```bash
# Scale to 4 apps × 100MB
bash scripts/scale-apps.sh 4 100

# Restart all data collection with updated counts:
# Terminal 1: Traffic (update --count 4)
node scripts/steady-traffic.mjs \
  --rg $RESOURCE_GROUP --prefix $NAME_PREFIX --count 4 \
  --interval 10 --output results/zip-phase2a-traffic.csv

# Terminal 2: Diag collection (update --count 4)
node scripts/collect-diag.mjs \
  --rg $RESOURCE_GROUP --prefix $NAME_PREFIX --count 4 \
  --interval 5 --output results/zip-phase2a-diag.jsonl

# Terminal 3: Azure metrics (already running, or restart)
bash scripts/collect-metrics.sh --watch 60

# Run for 60 minutes
```

**Expected**: CPU may rise slightly, Memory ~80-85%.

### Phase 2b — Static Plateau / Core Test (60-120 min)

**Goal**: THE KEY TEST. Hold memory at ~88-92% with flat traffic. Observe CPU independently.

```bash
# Scale to 6 apps × 100MB (or adjust based on Phase 2a results)
bash scripts/scale-apps.sh 6 100

# Same data collection pattern, update --count 6
node scripts/steady-traffic.mjs \
  --rg $RESOURCE_GROUP --prefix $NAME_PREFIX --count 6 \
  --interval 10 --output results/zip-phase2b-traffic.csv

node scripts/collect-diag.mjs \
  --rg $RESOURCE_GROUP --prefix $NAME_PREFIX --count 6 \
  --interval 5 --output results/zip-phase2b-diag.jsonl

bash scripts/collect-metrics.sh --watch 60

# RUN FOR AT LEAST 60 MINUTES. Ideally 120 minutes.
# This is the critical observation window.
```

**What to watch for**:
- MemoryPercentage ≥ 88% sustained
- CpuPercentage trend: is it rising while traffic is flat?
- /proc/vmstat: are pgscan_kswapd, pgsteal_kswapd increasing?
- /proc/meminfo: is MemAvailable decreasing? Is SwapFree decreasing?

**Success**: CPU rises ≥2x baseline (or +10pp) for 15+ min while traffic is flat AND reclaim counters rise.

### Phase 3 — Traffic Burst Comparison (10 min)

**Goal**: Compare CPU-per-request at high memory vs baseline.

```bash
# At current high memory state, send a short burst
node scripts/burst-traffic.mjs \
  --rg $RESOURCE_GROUP --prefix $NAME_PREFIX --count 6 \
  --rps 10 --duration 60 --output results/zip-burst-high-memory.csv

# Compare with Phase 1 burst (need to scale back down first)
bash scripts/scale-apps.sh 2 50
# Wait 5 min for stabilization
node scripts/burst-traffic.mjs \
  --rg $RESOURCE_GROUP --prefix $NAME_PREFIX --count 2 \
  --rps 10 --duration 60 --output results/zip-burst-low-memory.csv
```

**Analysis**: Compare avg CPU during burst at low memory vs high memory. If CPU-per-request is significantly higher at high memory, this supports the hypothesis.

### Phase 4 — Cleanup

```bash
# Delete all ZIP deploy apps (will redeploy as containers)
az group delete --name $RESOURCE_GROUP --yes --no-wait
```

---

## Experiment B: Web App for Containers

Repeat the exact same phases using container deployment.

### Setup

```bash
export RESOURCE_GROUP="rg-node-memory-lab"
export DEPLOY_MODE="container"
export APP_COUNT=2 ALLOC_MB=50
bash scripts/deploy-container.sh
```

### Run Phases 0-3

Same as above but:
- Use `--mode container` flag on scale-apps.sh
- Pay special attention to MemoryPercentage — previous experiment showed it stayed at 73-77% for containers
- Compare /diag/proc data between ZIP and container to see if /proc reflects the same or different values
- The diagnostics blade PercentPhysicalMemoryUsed may still show high memory even if Azure Monitor doesn't

### Key comparison points:
1. Does Azure Monitor MemoryPercentage reach 90% in container mode?
2. Does /proc/meminfo show same values as ZIP mode?
3. Does CPU behavior differ between ZIP and container at similar memory levels?
4. Is /proc container-scoped or host-scoped?

---

## Data Collection Summary

| Layer | Tool | Frequency | Format | Key Metrics |
|-------|------|-----------|--------|-------------|
| Azure Monitor (plan) | collect-metrics.sh | 60s | JSON + CSV | CpuPercentage, MemoryPercentage |
| Azure Monitor (app) | collect-metrics.sh | 60s | JSON + CSV | MemoryWorkingSet, Requests, Http5xx |
| App process | collect-diag.mjs (/stats) | 5s | JSONL | rss, heapUsed, cpuUsage, requestCount |
| OS /proc | collect-diag.mjs (/diag/proc) | 5s | JSONL | meminfo, vmstat, pressure, cgroup |
| Traffic log | steady-traffic.mjs | per-request | CSV | status, elapsed_ms, error |
| Burst traffic | burst-traffic.mjs | per-request | CSV | status, elapsed_ms, RPS |

---

## Decision Tree

```
After Phase 2b:

CPU rose + reclaim counters rose?
├─ YES → Hypothesis SUPPORTED
│   └─ Document: "At X% memory, CPU increased by Y% while traffic remained
│      flat. Kernel page reclaim (kswapd) activity correlated with CPU rise."
│
├─ CPU rose but reclaim counters flat?
│   └─ Hypothesis PARTIAL — CPU increase from another mechanism
│      └─ Investigate: GC pressure? Platform overhead? Worker scheduling?
│
└─ CPU stayed flat?
    └─ Hypothesis NOT SUPPORTED
        └─ Document: "At X% memory sustained for Y minutes, CPU did not
           increase. Kernel reclaim was [active/inactive]."

If SwapTotal = 0:
└─ Cannot prove swap-specific chain
   └─ Revise hypothesis to "memory pressure → reclaim → CPU"
      (swap is one mechanism, not the only one)
```
