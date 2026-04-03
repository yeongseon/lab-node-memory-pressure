# Node.js Memory Pressure Lab

Experiment investigating whether Linux kernel page reclaim causes CPU increases under memory pressure on Azure App Service.

> "Under memory pressure, the Linux kernel's page reclaim process consumes significant CPU cycles, leading to application performance degradation even if the application itself is not CPU-bound."

!!! success "Verdict: PARTIALLY SUPPORTED"
    The hypothesis was partially supported. While CPU increases were observed during kernel reclaim, they were most pronounced when swap was nearly exhausted.

### Key Findings

- **ZIP Deploy**: CPU rose 1.75x from kernel reclaim alone at 99.2% swap exhaustion.
- **Container Deploy**: CPU remained stable at 80% memory but suffered an OOM cascade at 6 containers.
- **Burst Latency**: ZIP deployment showed 16.8ms average latency vs 173.9ms for Container deployment under pressure.
- **Recommendation**: Keep memory utilization below 80% on B1 Linux plans to avoid performance degradation.

### Project Navigation

- [Hypothesis](hypothesis.md): Detailed problem statement and expected outcomes.
- [Experiment Results](experiment-log.md): Data logs, charts, and analysis from ZIP and Container deployments.
- [Runbook](runbook.md): Instructions for reproducing the experiment.

### Environment Summary

| Component | Specification |
|-----------|---------------|
| Plan | Azure App Service B1 Linux |
| Resources | 1 vCPU, 1.75GB RAM |
| Runtime | Node.js 20 |
| Region | Korea Central |
