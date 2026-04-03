# Experiment Log: Node.js Memory Pressure on Azure App Service

This document provides a comprehensive scientific record of memory pressure experiments conducted on Azure App Service (Linux B1 SKU). The study investigates the relationship between high memory utilization, Linux kernel page reclaim activity, and unexpected CPU consumption.

## Experiment Overview

### Hypothesis
When an Azure B1 Linux App Service Plan hosts multiple Node.js applications that push aggregate memory utilization toward 90%, the Linux kernel's page reclaim mechanisms (kswapd, direct reclaim, and swap I/O) cause CPU usage to increase significantly, independent of application traffic levels.

### Environment Details
- **Experiment Period**: ~4-5 hours (including deployment transitions and recovery)
- **Subscription ID**: *(redacted)*
- **Resource Group**: rg-node-memory-lab
- **Region**: Korea Central
- **Plan SKU**: B1 (1 vCPU, 1.75 GB RAM, Linux)
- **Runtime**: Node.js 20 LTS
- **Host MemTotal**: ~1,855 MB
- **SwapTotal**: 2,048 MB (Confirmed via /proc/meminfo)

---

## ZIP Deploy Experiment

The first experiment used standard ZIP deployment for Node.js applications.

### Phase 0: Discovery
Deployed 2 Node.js applications (50MB RSS each). Verified that the `/diag/proc` endpoint successfully captures `/proc/meminfo` and `/proc/vmstat`. Confirmed the presence of Pressure Stall Information (PSI) at `/proc/pressure/memory`.

### Phase 1: Baseline
- **Duration**: ~25 minutes
- **Configuration**: 2 apps x 50MB
- **CPU**: 15-25% (Avg 20%)
- **Memory**: 79-80%
- **SwapFree**: ~1,063 MB
- **Cumulative pgscan_kswapd**: ~16.5M
- **Cumulative pgscan_direct**: 1,164
- **Avg Latency**: 56-70ms
- **Data Points**: 321 traffic rows, 641 diag rows, 106 azure-metrics rows

### Phase 2a: Approach
- **Duration**: ~20 minutes
- **Configuration**: 4 apps x 100MB
- **CPU**: 48-87% (Massive increase from baseline)
- **Memory**: 78-89%
- **SwapFree**: 417 MB (Down from 1,063 MB)
- **pgscan_kswapd**: 29.0M (+76% over baseline)
- **pgscan_direct**: 14,609 (+1155% over baseline)
- **pswpout**: 833,768 (+460% over baseline)
- **Latency**: 53-70ms (Stable despite CPU spike)

### Phase 2b: Core Test (Steady State)
- **Duration**: 60 minutes
- **Configuration**: 6 apps x 100MB
- **CPU Avg**: 35.2% (Steady range 20-56%, initial spike to 98% during scaling)
- **Memory Avg**: 84.3% (Stable between 82-88%)
- **SwapFree**: 12-17 MB (99.2% swap exhausted)
- **pgscan_kswapd Growth**: 14.5M to 40.4M (+179%)
- **pgscan_direct Growth**: 233 to 33,372 (+14,200%)
- **pgsteal_kswapd**: 8.1M to ~32M
- **pswpin Growth**: 121K to 1.94M (+1,500%)
- **pswpout Growth**: 321K to 2.41M (+650%)
- **allocstall**: Present (50 normal + 71 movable)
- **Memory Pressure (PSI)**: some avg300=5.79, full avg300=1.03
- **Observation**: CPU rose from a 20% baseline to 35% average (1.75x increase) with periodic spikes up to 87%, driven purely by kernel reclaim activity as request rates remained steady at 1 req/10s per app.

### Phase 3: Traffic Burst
- **Load**: 10 RPS for 60 seconds at high memory pressure.
- **Results**: 587 requests, 0 errors.
- **Latency**: Avg 16.8ms, p50 14ms, p95 30ms, p99 62ms.
- **CPU Impact**: Hit 56-71% during the burst. The system remained resilient under load.

### Visualizations (ZIP Deploy)

![CPU and Memory Timeline](assets/charts/zip-deploy/cpu-memory-timeline.png)
*Figure 1: App Service Plan CPU% (orange) and Memory% (red) on a shared 0-100% scale. Both metrics rise together as apps are scaled up, with CPU climbing from ~15% to 47% while memory reaches 92%.*

![Kernel Reclaim Activity](assets/charts/zip-deploy/kernel-reclaim-timeline.png)
*Figure 2: Linux kernel page reclaim counters (Δ per interval). Sharp escalation of pgscan_kswapd and pgscan_direct confirms the kernel was actively reclaiming pages under memory pressure.*

![Swap Activity](assets/charts/zip-deploy/swap-activity-timeline.png)
*Figure 3: Swap I/O activity (Δ per interval). Intense pswpin/pswpout spikes correlate with high memory phases, confirming swap thrashing as the kernel moves pages between RAM and disk.*

![Memory Breakdown](assets/charts/zip-deploy/memory-breakdown-timeline.png)
*Figure 4: OS-level memory breakdown from /proc/meminfo. Shows MemFree, MemAvailable, Cached, and SwapFree declining as app memory allocation increases.*

![App RSS](assets/charts/zip-deploy/app-rss-timeline.png)
*Figure 5: Per-app resident set size (RSS) in MB. Each app's memory footprint grows as ALLOC_MB is increased across phases.*

![Burst Latency Distribution](assets/charts/zip-deploy/burst-latency-distribution.png)
*Figure 6: Latency histogram during Phase 3 traffic burst (10 RPS × 60s). Shows request latency distribution under memory pressure.*

![Traffic Volume vs CPU vs Memory](assets/charts/zip-deploy/traffic-cpu-timeline.png)
*Figure 7: Memory pressure experiment — ZIP deploy. Request rate remained essentially flat (~6 RPM) throughout all phases, while memory utilization climbed from ~80% to ~92% and CPU increased from ~15% to 35%+ in tandem — confirming the CPU rise was driven by memory pressure, not traffic.*

---

## Container Deploy Experiment

The second experiment evaluated the same scenarios using Docker containers.

### Phase 0-1: Baseline
- **Configuration**: 2 containers x 50MB
- **CPU**: 9-36% (Avg 20%)
- **Memory**: Settled at 76%
- **SwapFree**: 1,341 MB
- **Latency**: 59-117ms (Notably higher than ZIP)

### Phase 2a: Approach
- **Configuration**: 4 containers x 100MB
- **CPU**: 12-85% (Settled to 12-28%)
- **Memory**: 80-93% (Settled to 82-84%)
- **SwapFree**: 1,076 MB

### Phase 2b: Core Test (Failed Attempt)
An attempt to run 6 containers at 100MB each caused complete plan destabilization. Apps 1-4 returned 503 errors, and new containers (5-6) triggered the OOM killer on existing ones. This indicates that container runtime overhead is significantly higher than ZIP deployment on the B1 SKU.

### Phase 2b: Core Test (Adjusted)
- **Duration**: 28 minutes
- **Configuration**: 4 containers x 75MB
- **CPU Avg**: 18.8% (Range 10-51%)
- **Memory Avg**: 80.7%
- **SwapFree**: ~1,050 MB (49% swap used)
- **pgscan_kswapd Growth**: 14.2M to 15.3M (+1.1M)
- **pgscan_direct Growth**: 26,163 to 28,792 (+2,629)
- **pswpin Growth**: 203,756 to 259,687 (+55,931)
- **pswpout Growth**: 391,304 to 450,206 (+58,902)
- **Memory Pressure (PSI)**: some avg300=1.57, full avg300=0.51
- **Observation**: Container isolation resulted in lower swap utilization (49% vs 99.2%) and less intense reclaim activity compared to the ZIP experiment at similar memory percentages.

### Phase 3: Traffic Burst
- **Load**: 10 RPS for 60 seconds.
- **Results**: 590 requests, 0 errors.
- **Latency**: Avg 173.9ms, p50 159ms, p95 185ms, p99 715ms.
- **Observation**: Container latency under pressure was 10x higher than ZIP deployment.

### Visualizations (Container Deploy)

![CPU and Memory Timeline](assets/charts/container-deploy/cpu-memory-timeline.png)
*Figure 8: App Service Plan CPU% (orange) and Memory% (red) for container deploy on a shared 0-100% scale. Memory remains ~75-82% while CPU spikes to 84% during container scaling events (Phase 2a), then stabilizes at 10-24%.*

![Kernel Reclaim Activity](assets/charts/container-deploy/kernel-reclaim-timeline.png)
*Figure 9: Kernel page reclaim activity in the container environment. pgscan_kswapd and pgscan_direct counters show moderate reclaim compared to ZIP deploy.*

![Swap Activity](assets/charts/container-deploy/swap-activity-timeline.png)
*Figure 10: Swap I/O during container experiment. Lower intensity than ZIP deploy due to container isolation limiting swap utilization to ~49%.*

![Burst Latency Distribution](assets/charts/container-deploy/burst-latency-distribution.png)
*Figure 11: Latency histogram during container Phase 3 burst. Higher variance (avg 174ms vs 17ms for ZIP) shows containers are more sensitive to memory pressure.*

![Traffic Volume vs CPU vs Memory](assets/charts/container-deploy/traffic-cpu-timeline.png)
*Figure 12: Memory pressure experiment — container deploy. Request rate remained consistently low (~12 RPM) while memory held steady at ~80% and CPU fluctuated between 10-51% during pressure phases. Note: metric cadence is sparser than ZIP deploy (~2 min intervals).*

---

## Why Is Baseline Memory Already High?

Before interpreting the results, it is important to understand why memory utilization starts at 79-80% even with only 2 apps allocating 50MB each.

The B1 SKU provides ~1,855 MB of physical RAM (as seen via `/proc/meminfo` MemTotal). However, a significant portion is consumed before any user application starts:

- **Platform / host runtime overhead**: The App Service Linux sandbox, Kudu (SCM) sidecar, and container runtime processes consume a baseline amount of memory.
- **Language runtime footprint**: Each Node.js 20 process has a base RSS of ~30-40 MB before any user-allocated memory, due to V8 heap initialization, libuv, and loaded modules.
- **Linux page cache**: The kernel uses available memory for file-system caching (`Cached` in `/proc/meminfo`). This is reclaimable under pressure, but it is counted toward the Azure Monitor `MemoryPercentage` metric.
- **MemoryPercentage ≠ app RSS sum**: Azure Monitor reports plan-level physical memory usage, which includes all of the above. The sum of app-level RSS values from `process.memoryUsage()` will always be significantly less than what the platform reports.

This is visible in the **Memory Breakdown** chart (Figure 4) and the **App RSS** chart (Figure 5), which show that app RSS accounts for only a fraction of total memory usage. The gap is platform overhead and cached pages.

---

## Comparison: ZIP vs. Container

!!! warning "Scope of Comparison"
    The following comparison reflects behavior observed **under this specific B1 Linux lab setup**. Results may differ on higher SKUs, different runtimes, or production workloads with different memory profiles.

Under this B1 Linux lab setup, ZIP deployment tolerated a denser memory-pressure experiment than container deployment. This should not be generalized to all deployment scenarios.

| Metric | ZIP Deploy (6x100MB) | Container Deploy (4x75MB) |
| :--- | :--- | :--- |
| **Max Capacity (B1)** | 6 apps @ 100MB | 4 apps @ 75MB (6 apps failed) |
| **Steady State CPU** | 35.2% average | 18.8% average |
| **Memory Avg** | 84.3% | 80.7% |
| **Swap Utilization** | 99.2% (Nearly Full) | 49.0% |
| **pgscan_kswapd Delta** | +25.9M (in 60 min) | +1.1M (in 28 min) |
| **Burst Latency (Avg)** | 16.8 ms | 173.9 ms |
| **Burst Latency (p99)** | 62 ms | 715 ms |
| **PSI (Some/Full)** | 5.79 / 1.03 | 1.57 / 0.51 |

---

## Final Verdict and Recommendations

### Hypothesis Status: PARTIALLY SUPPORTED

This lab strongly supports the claim that aggregate memory pressure on low-tier Linux App Service Plans can drive non-application CPU consumption through kernel reclaim and swap activity. In this specific setup, the effect on steady-state request latency was limited for ZIP deployment, while container deployment tended to destabilize earlier rather than degrade gradually.

- **ZIP Deploy**: The hypothesis is strongly supported. CPU usage increased by 1.75x (from 20% to 35% avg) purely due to kernel activity. The near-total exhaustion of swap triggered massive increases in `pgscan_direct` (+14,200%) and `pswpin` (+1,500%), correlating directly with CPU spikes.
- **Container Deploy**: The primary risk is destabilization rather than gradual CPU creep. The container runtime introduces enough overhead that a B1 plan fails to reach the same level of sustained memory pressure before applications crash. However, request latency is significantly worse (10x) for containers under pressure compared to ZIP.

### Limitations

This experiment successfully demonstrates the CPU/reclaim mechanism, but has limitations regarding proof of user-visible service degradation:

1. **Latency impact was limited for ZIP**: Despite a 1.75x CPU increase, burst latency remained low (avg 16.8ms, p99 62ms). The CPU overhead was real but did not cause measurable request degradation in this test.
2. **Short observation windows**: Phase 2b ran for 60 minutes (ZIP) and 28 minutes (container). Longer steady-state observation (hours to days) may reveal cumulative effects not captured here.
3. **Synthetic workload**: The test app serves simple HTTP responses. Real applications with heavier computation, database queries, or file I/O may be more sensitive to CPU contention from kernel reclaim.
4. **Single burst test**: Phase 3 tested one 60-second burst at 10 RPS. A more thorough evaluation would include varied request patterns, lower timeout margins, and separation of warm-path vs cold-path responses.

To make a stronger claim about user-visible degradation, future experiments should include longer observation periods, more realistic workloads, and fine-grained latency percentile tracking over extended time.

### Customer Recommendations

1. **Maintain Memory Buffer**: Keep `MemoryPercentage` below 80% on B1 Linux plans. Crossing this threshold triggers aggressive kernel reclaim and swap I/O, which steals CPU cycles from your application.
2. **Monitor Reclaim Counters**: If CPU spikes occur without a corresponding increase in traffic, check for `pgscan_kswapd` and `pgscan_direct` activity. These are leading indicators of memory-driven performance degradation.
3. **Container Limitations**: Avoid hosting more than 2-3 containers on a single B1 plan if they have non-trivial memory requirements. The startup overhead and runtime isolation lead to earlier OOM events and higher latency variance.
4. **Scaling Strategy**: If your application consistently operates above 80% memory, scale up to the B2 or B3 SKU. The additional RAM will reduce reliance on the 2GB swap partition and stabilize CPU performance.

---

## Data Summary

### ZIP Deploy
- **Result Directory**: `results/zip-deploy/`
- **Total Files**: 284 (~110 MB)
- **Traffic Rows**: 3,289
- **Diag Rows**: 6,561
- **Metrics Samples**: 1,204
- **Burst Samples**: 588

### Container Deploy
- **Result Directory**: `results/container-deploy/`
- **Total Files**: 100
- **Traffic Rows**: 684
- **Diag Rows**: 1,041
- **Metrics Samples**: 157
- **Burst Samples**: 591
