# Experiment Log

## Overview

| Field | Value |
|-------|-------|
| Hypothesis | Memory pressure on B1 Linux ASP causes CPU increase via kernel page reclaim |
| Start Date | TBD |
| End Date | TBD |
| Azure Subscription | ***REDACTED*** |
| Resource Group | rg-node-memory-lab |
| Region | Korea Central |
| Plan SKU | B1 |

---

## ZIP Deploy Experiment

### Phase 0 — Discovery

**Objective**: Deploy 2 apps × 50MB, verify `/diag/proc` works, check SwapTotal.

| Timestamp | Action | Result |
|-----------|--------|--------|
| | Deploy 2 apps via ZIP | |
| | Verify /health endpoints | |
| | Check /diag/proc response | |
| | Record SwapTotal from /proc/meminfo | |

**Observations**:


**Raw Data Files**:
- `results/azure-plan-*.json`
- `results/diag.jsonl`

---

### Phase 1 — Baseline

**Objective**: 30-60 min steady state at low memory (~50-60%).

| Metric | Value |
|--------|-------|
| Duration | |
| Avg CPU% | |
| Avg Memory% | |
| pgscan_kswapd (start → end) | |
| pgscan_direct (start → end) | |
| pswpin/pswpout | |

**Charts**:
<!-- Charts will be inserted here after generation -->

**Raw Data Files**:
- `results/traffic.csv`
- `results/diag.jsonl`
- `results/diag-summary.csv`
- `results/azure-metrics.csv`
- `results/azure-plan-*.json`

---

### Phase 2a — Approach

**Objective**: Scale to 4 apps × 100MB, target ~80-85% memory.

| Metric | Value |
|--------|-------|
| Apps × Alloc | |
| Avg CPU% | |
| Avg Memory% | |
| pgscan_kswapd delta | |
| pgscan_direct delta | |

**Charts**:
<!-- Charts will be inserted here -->

---

### Phase 2b — Core Test (KEY PHASE)

**Objective**: Scale to 6 apps × 100MB, target ~88-92% memory. Observe 60-120 min.

**THIS IS THE CRITICAL TEST** — Does CPU rise without increased traffic?

| Metric | Value |
|--------|-------|
| Apps × Alloc | |
| Duration | |
| Baseline CPU% (from Phase 1) | |
| Observed CPU% (min/avg/max) | |
| CPU Δ from baseline | |
| Memory% (min/avg/max) | |
| pgscan_kswapd (start → end) | |
| pgscan_direct (start → end) | |
| pgsteal_kswapd (start → end) | |
| pgsteal_direct (start → end) | |
| pswpin/pswpout | |
| allocstall delta | |
| Request rate (steady) | |

**Verdict**: [ ] Hypothesis SUPPORTED — CPU ≥ 2× baseline with reclaim counters rising
            [ ] Hypothesis REJECTED — CPU stable despite high memory

**Charts**:
<!-- Charts will be inserted here -->

---

### Phase 3 — Traffic Burst

**Objective**: Short burst at high memory, compare CPU-per-request vs baseline.

| Metric | Low Memory (Phase 1) | High Memory (Phase 2b) |
|--------|---------------------|----------------------|
| Burst RPS | | |
| Avg latency (ms) | | |
| P95 latency (ms) | | |
| P99 latency (ms) | | |
| CPU% during burst | | |
| Error rate | | |

**Charts**:
<!-- Charts will be inserted here -->

---

## Container Deploy Experiment

### Phase 0 — Discovery (Container)

| Timestamp | Action | Result |
|-----------|--------|--------|
| | Deploy via container | |
| | Verify endpoints | |
| | Check SwapTotal | |

---

### Phase 1 — Baseline (Container)

| Metric | Value |
|--------|-------|
| Duration | |
| Avg CPU% | |
| Avg Memory% | |

---

### Phase 2b — Core Test (Container)

| Metric | Value |
|--------|-------|
| Apps × Alloc | |
| Duration | |
| Observed CPU% | |
| Memory% | |
| pgscan_kswapd delta | |

**Verdict**: [ ] SUPPORTED [ ] REJECTED

---

### Phase 3 — Traffic Burst (Container)

| Metric | Low Memory | High Memory |
|--------|-----------|-------------|
| Burst RPS | | |
| Avg latency | | |
| P95 latency | | |

---

## ZIP vs Container Comparison

| Metric | ZIP Deploy | Container |
|--------|-----------|-----------|
| Memory% at 6 apps × 100MB | | |
| CPU% at rest (high memory) | | |
| pgscan_kswapd activity | | |
| pgscan_direct activity | | |
| Swap usage | | |
| Latency impact | | |

**Charts**:
<!-- Comparison charts will be inserted here -->

---

## Final Conclusion

### Hypothesis Status: **TBD**

### Summary of Evidence


### Recommendations for Customer

