# 실험 실행 가이드

메모리 부하 실험을 위한 단계별 실행 가이드입니다.

## 사전 요구사항

| 도구 | 확인 방법 |
|------|-------------|
| Azure CLI ≥ 2.50 | `az version` |
| Bicep CLI | `az bicep version` |
| Node.js ≥ 20 | `node --version` |
| jq | `jq --version` |
| 활성 Azure 구독 | `az account show` |

```bash
az login
az account set --subscription "<YOUR_SUBSCRIPTION_ID>"
```

## 환경 변수

```bash
export RESOURCE_GROUP="rg-node-memory-lab"
export LOCATION="koreacentral"
export NAME_PREFIX="memlabnode"
export PLAN_SKU="B1"
export INSTANCE_COUNT=1
```

---

## 실험 A: ZIP 배포

### Phase 0 — 탐색 (15 min)

**Goal**: 메트릭 파이프라인 작동 여부 확인 및 swap 존재 여부 체크.

```bash
# 2개 앱 × 50MB 배포
export APP_COUNT=2 ALLOC_MB=50
bash scripts/deploy-zip.sh

# 앱이 정상이 될 때까지 대기 (2-3 min)
curl https://memlabnode-1.azurewebsites.net/health
curl https://memlabnode-2.azurewebsites.net/health

# /diag/proc 작동 여부 및 swap 존재 여부 확인
curl -s https://memlabnode-1.azurewebsites.net/diag/proc | jq '.proc.meminfo.parsed.SwapTotal'

# 탐색 결과 기록
curl -s https://memlabnode-1.azurewebsites.net/diag/proc | jq . > results/discovery-diag.json
```

**Decision point**: 만약 SwapTotal = 0 이라면, 이를 기록하고 가설을 "reclaim 기반 CPU 부하"(swap 특정적이지 않음)로 조정합니다.

### Phase 1 — 기준선 (30-60 min)

**Goal**: 낮은 메모리 압박 상태에서 가벼운 트래픽을 발생시켜 CPU/memory/swap 기준선을 설정합니다.

```bash
# Terminal 1: 가벼운 트래픽
node scripts/steady-traffic.mjs \
  --rg $RESOURCE_GROUP --prefix $NAME_PREFIX --count 2 \
  --interval 10 --output results/zip-phase1-traffic.csv

# Terminal 2: 5초마다 /diag/proc 데이터 수집
node scripts/collect-diag.mjs \
  --rg $RESOURCE_GROUP --prefix $NAME_PREFIX --count 2 \
  --interval 5 --output results/zip-phase1-diag.jsonl

# Terminal 3: 60초마다 Azure Monitor 메트릭 수집
bash scripts/collect-metrics.sh --watch 60

# 30-60분 동안 실행한 후 모든 터미널에서 Ctrl+C를 누릅니다.
```

**Expected**: CPU 10-20%, Memory ~50-60%, swap 카운터 변화 없음, pgscan 카운터는 0에 가까움.

### Phase 2a — 접근 구간 (60 min)

**Goal**: 메모리 사용량을 80-85%까지 높입니다.

```bash
# 4개 앱 × 100MB로 스케일링
bash scripts/scale-apps.sh 4 100

# 업데이트된 개수로 모든 데이터 수집 재시작:
# Terminal 1: 트래픽 (--count 4로 업데이트)
node scripts/steady-traffic.mjs \
  --rg $RESOURCE_GROUP --prefix $NAME_PREFIX --count 4 \
  --interval 10 --output results/zip-phase2a-traffic.csv

# Terminal 2: 진단 데이터 수집 (--count 4로 업데이트)
node scripts/collect-diag.mjs \
  --rg $RESOURCE_GROUP --prefix $NAME_PREFIX --count 4 \
  --interval 5 --output results/zip-phase2a-diag.jsonl

# Terminal 3: Azure 메트릭 (이미 실행 중이거나 재시작)
bash scripts/collect-metrics.sh --watch 60

# 60분 동안 실행
```

**Expected**: CPU가 약간 상승할 수 있으며, Memory는 ~80-85% 수준.

### Phase 2b — 정적 구간 / 핵심 테스트 (60-120 min)

**Goal**: 가장 중요한 테스트 단계입니다. 트래픽을 일정하게 유지하면서 메모리를 ~88-92%로 유지합니다. CPU의 변화를 독립적으로 관찰합니다.

```bash
# 6개 앱 × 100MB로 스케일링 (또는 Phase 2a 결과에 따라 조정)
bash scripts/scale-apps.sh 6 100

# 동일한 데이터 수집 패턴 사용, --count 6으로 업데이트
node scripts/steady-traffic.mjs \
  --rg $RESOURCE_GROUP --prefix $NAME_PREFIX --count 6 \
  --interval 10 --output results/zip-phase2b-traffic.csv

node scripts/collect-diag.mjs \
  --rg $RESOURCE_GROUP --prefix $NAME_PREFIX --count 6 \
  --interval 5 --output results/zip-phase2b-diag.jsonl

bash scripts/collect-metrics.sh --watch 60

# 최소 60분 동안 실행. 가급적 120분 권장.
# 이 단계는 매우 중요한 관찰 기간입니다.
```

**What to watch for**:
- MemoryPercentage ≥ 88% 지속 유지
- CpuPercentage 추세: 트래픽이 일정한데 CPU가 상승하는가?
- /proc/vmstat: pgscan_kswapd, pgsteal_kswapd가 증가하는가?
- /proc/meminfo: MemAvailable이 감소하는가? SwapFree가 감소하는가?

**Success**: 트래픽이 일정한 상태에서 15분 이상 CPU가 기준선 대비 2배 이상(또는 10pp 이상) 상승하고 reclaim 카운터가 함께 상승하는 경우.

### Phase 3 — 트래픽 버스트 비교 (10 min)

**Goal**: 높은 메모리 상태와 기준선 상태에서의 요청당 CPU 사용량을 비교합니다.

```bash
# 현재의 높은 메모리 상태에서 짧은 버스트 트래픽 전송
node scripts/burst-traffic.mjs \
  --rg $RESOURCE_GROUP --prefix $NAME_PREFIX --count 6 \
  --rps 10 --duration 60 --output results/zip-burst-high-memory.csv

# Phase 1 버스트와 비교 (먼저 다시 스케일 다운 필요)
bash scripts/scale-apps.sh 2 50
# 안정화를 위해 5분 대기
node scripts/burst-traffic.mjs \
  --rg $RESOURCE_GROUP --prefix $NAME_PREFIX --count 2 \
  --rps 10 --duration 60 --output results/zip-burst-low-memory.csv
```

**Analysis**: 낮은 메모리 상태와 높은 메모리 상태에서의 버스트 중 평균 CPU를 비교합니다. 만약 높은 메모리 상태에서 요청당 CPU가 유의미하게 높다면, 이는 가설을 뒷받침합니다.

### Phase 4 — 정리

```bash
# 모든 ZIP 배포 앱 삭제 (나중에 컨테이너로 재배포 예정)
az group delete --name $RESOURCE_GROUP --yes --no-wait
```

---

## 실험 B: Web App for Containers

컨테이너 배포를 사용하여 동일한 단계를 정확히 반복합니다.

### Setup

```bash
export RESOURCE_GROUP="rg-node-memory-lab"
export DEPLOY_MODE="container"
export APP_COUNT=2 ALLOC_MB=50
bash scripts/deploy-container.sh
```

### Phase 0-3 실행

위와 동일하지만 다음 사항을 유의합니다:
- scale-apps.sh 실행 시 `--mode container` 플래그를 사용합니다.
- MemoryPercentage를 주의 깊게 관찰합니다. 이전 실험에서는 컨테이너의 경우 73-77%에 머물렀습니다.
- ZIP과 컨테이너 간의 /diag/proc 데이터를 비교하여 /proc이 동일한 값을 반영하는지 아니면 다른 값을 반영하는지 확인합니다.
- Azure Monitor에서 보이지 않더라도 진단 블레이드의 PercentPhysicalMemoryUsed는 여전히 높은 메모리 사용량을 보일 수 있습니다.

### 주요 비교 포인트:
1. 컨테이너 모드에서 Azure Monitor MemoryPercentage가 90%에 도달하는가?
2. /proc/meminfo가 ZIP 모드와 동일한 값을 보여주는가?
3. 비슷한 메모리 수준에서 ZIP과 컨테이너의 CPU 동작이 다른가?
4. /proc은 컨테이너 범위(scoped)인가 아니면 호스트 범위인가?

---

## 데이터 수집 요약

| 레이어 | 도구 | 빈도 | 형식 | 핵심 메트릭 |
|-------|------|-----------|--------|-------------|
| Azure Monitor (plan) | collect-metrics.sh | 60s | JSON + CSV | CpuPercentage, MemoryPercentage |
| Azure Monitor (app) | collect-metrics.sh | 60s | JSON + CSV | MemoryWorkingSet, Requests, Http5xx |
| App 프로세스 | collect-diag.mjs (/stats) | 5s | JSONL | rss, heapUsed, cpuUsage, requestCount |
| OS /proc | collect-diag.mjs (/diag/proc) | 5s | JSONL | meminfo, vmstat, pressure, cgroup |
| 트래픽 로그 | steady-traffic.mjs | 요청당 | CSV | status, elapsed_ms, error |
| 버스트 트래픽 | burst-traffic.mjs | 요청당 | CSV | status, elapsed_ms, RPS |

---

## 의사결정 트리

```
Phase 2b 이후:

CPU 상승 + reclaim 카운터 상승?
├─ 예 → 가설 뒷받침됨 (SUPPORTED)
│   └─ 기록: "메모리 X%에서 트래픽은 일정했지만 CPU가 Y% 증가함.
│      커널 페이지 reclaim (kswapd) 활동이 CPU 상승과 상관관계가 있음."
│
├─ CPU는 상승했지만 reclaim 카운터는 그대로임?
│   └─ 가설 부분적 일치 — 다른 메커니즘에 의한 CPU 증가
│      └─ 조사: GC 압박? 플랫폼 오버헤드? 워커 스케줄링?
│
└─ CPU가 그대로임?
    └─ 가설 뒷받침되지 않음 (NOT SUPPORTED)
        └─ 기록: "X% 메모리를 Y분 동안 유지했지만 CPU가 증가하지 않음.
           커널 reclaim은 [활성/비활성] 상태였음."

만약 SwapTotal = 0 이라면:
└─ swap 특정적인 인과관계를 증명할 수 없음
   └─ 가설을 "메모리 압박 → reclaim → CPU"로 수정
      (swap은 하나의 메커니즘일 뿐 유일한 원인은 아님)
```