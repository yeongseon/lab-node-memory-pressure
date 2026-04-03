# lab-node-memory-pressure

[![Documentation](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://yeongseon.github.io/lab-node-memory-pressure/)

> **Documentation Site**: [https://yeongseon.github.io/lab-node-memory-pressure/](https://yeongseon.github.io/lab-node-memory-pressure/)

Experiment to validate (or disprove) the hypothesis that **memory pressure on an Azure App Service Plan (B1 Linux) causes CPU increases independent of application traffic** due to Linux kernel page reclaim activity.

## Hypothesis

> When multiple Node.js apps on a single B1 App Service Plan push memory usage to ~90%, the Linux kernel's page reclaim mechanisms (kswapd, direct reclaim, swap I/O) consume CPU cycles, causing CPU percentage to rise even without increased application load.

See [`docs/hypothesis.md`](docs/hypothesis.md) for the full hypothesis with proof/disproof criteria.

## Experiment Design

### Two Deployment Modes
| Mode | Runtime Stack | Deploy Method |
|------|--------------|---------------|
| ZIP  | `NODE\|20-lts` | `az webapp deploy --type zip` |
| Container | `DOCKER\|image` | `az acr build` → Web App for Containers |

### Phases
| Phase | Goal | Apps × MB | Target Memory |
|-------|------|-----------|---------------|
| 0 — Discovery | Verify /diag/proc, check swap | 2 × 50 | ~30% |
| 1 — Baseline | Steady-state metrics at low memory | 2 × 50 | ~50-60% |
| 2a — Approach | Ramp memory toward threshold | 4 × 100 | ~80-85% |
| 2b — Core Test | **Observe CPU at high memory, no load increase** | 6 × 100 | ~88-92% |
| 3 — Traffic Burst | Compare CPU-per-request at low vs high memory | 6 × 100 | ~88-92% |

### Three Measurement Layers
1. **Azure Monitor** (1 min granularity): `CpuPercentage`, `MemoryPercentage`, `MemoryWorkingSet`
2. **App-level** (5s granularity): `/diag/proc` endpoint → `/proc/meminfo`, `/proc/vmstat`, cgroup stats
3. **Traffic** (per-request): latency, status, RPS

## Project Structure

```
├── app/
│   ├── server.mjs          # Express app with memory holder + /diag/proc
│   ├── package.json
│   ├── package-lock.json
│   └── Dockerfile           # Multi-stage node:20-slim
├── infra/
│   ├── main.bicep           # Orchestrator: plan + N webapps + optional ACR
│   └── modules/
│       ├── plan.bicep        # B1 Linux App Service Plan
│       ├── webapp.bicep      # Per-app: ZIP or container mode
│       └── acr.bicep         # Azure Container Registry (Basic)
├── scripts/
│   ├── deploy-zip.sh         # Full ZIP deploy pipeline
│   ├── deploy-container.sh   # Full container deploy pipeline
│   ├── scale-apps.sh         # Scale app count / memory allocation
│   ├── steady-traffic.mjs    # Light traffic: 1 req/10s/app → CSV
│   ├── collect-diag.mjs      # Poll /diag/proc + /stats → JSONL + CSV
│   ├── collect-metrics.sh    # Azure Monitor metrics → JSON + CSV
│   ├── burst-traffic.mjs     # Short burst for Phase 3 → CSV
│   └── generate-charts.mjs   # Generate PNG charts from collected data
├── results/                   # Raw data (JSONL, JSON, CSV) + charts (PNG)
├── docs/
│   ├── hypothesis.md          # Full hypothesis with proof criteria
│   ├── runbook.md             # Step-by-step execution guide
│   └── experiment-log.md      # Results, observations, charts
└── README.md
```

## Quick Start

### Prerequisites
- Azure CLI (`az`) logged in with active subscription
- Node.js 20+
- `jq`, `zip`

### ZIP Deploy
```bash
export RESOURCE_GROUP=rg-node-memory-lab
export LOCATION=koreacentral
export NAME_PREFIX=memlabnode
export APP_COUNT=2
export ALLOC_MB=50

bash scripts/deploy-zip.sh
```

### Container Deploy
```bash
export RESOURCE_GROUP=rg-node-memory-lab
export LOCATION=koreacentral
export NAME_PREFIX=memlabnode
export APP_COUNT=2
export ALLOC_MB=50

bash scripts/deploy-container.sh
```

### Data Collection (run in parallel terminals)
```bash
# Terminal 1: Light traffic
node scripts/steady-traffic.mjs --rg $RESOURCE_GROUP --prefix $NAME_PREFIX

# Terminal 2: OS-level diagnostics
node scripts/collect-diag.mjs --rg $RESOURCE_GROUP --prefix $NAME_PREFIX

# Terminal 3: Azure Monitor metrics
bash scripts/collect-metrics.sh --watch 60
```

### Scale Up (trigger memory pressure)
```bash
bash scripts/scale-apps.sh 6 100 --mode zip
```

### Generate Charts
```bash
node scripts/generate-charts.mjs --input results/ --output results/charts/
```

## Key Metrics

### Proof Criteria (Hypothesis Supported)
- CPU ≥ 2× baseline (or +10 percentage points) sustained for ≥15 min
- Concurrent rise in `pgscan_kswapd`, `pgscan_direct`, `pgsteal_*` counters
- `pswpin`/`pswpout` > 0 (if swap is available)
- No corresponding increase in application request rate

### Disproof Criteria (Hypothesis Rejected)
- CPU remains stable (< +5pp from baseline) despite memory ≥ 88%
- Reclaim counters flat
- CPU rises only when request rate rises

## Azure Resources

| Resource | SKU | Region |
|----------|-----|--------|
| App Service Plan | B1 (Linux) | Korea Central |
| Web Apps | 2-6 Node.js apps | Korea Central |
| Container Registry | Basic (container mode only) | Korea Central |

## Results

See [`docs/experiment-log.md`](docs/experiment-log.md) for full results with charts.
