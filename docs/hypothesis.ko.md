# 가설: 메모리 압박 상황에서의 커널 페이지 회수가 CPU 증가를 유발함

## 고객 시나리오

Azure App Service Plan (B1, Linux)에서 여러 Node.js 애플리케이션을 호스팅하고 있습니다. 시간이 지나면서 워커 레벨의 메모리 사용량이 약 90%까지 누적됩니다. 고객은 애플리케이션 트래픽 부하가 증가하지 않았음에도 불구하고 예상치 못한 CPU 스파이크를 관찰합니다.

**소스 메트릭**: Azure Portal → 문제 해결 및 진단 → Instance Memory Usage (App Service Plan)에서 모든 워커 인스턴스의 `PercentPhysicalMemoryUsed`가 약 90%로 표시됩니다.

## 인과 관계 체인 (가설)

```
1. 여러 Node.js 앱이 동일한 App Service Plan 워커를 공유함
       ↓
2. 각 앱이 시간이 지남에 따라 메모리를 소비함 (캐시, 버퍼, V8 힙 성장)
       ↓
3. 워커 레벨의 물리 메모리 사용량이 약 90%에 도달함
       ↓
4. 여유 메모리가 감소하고 OS 버퍼/캐시가 축소됨
       ↓
5. Swap 공간(사용 가능한 경우)이 점진적으로 소비됨
       ↓
6. Linux 커널이 페이지 회수(page reclaim) 메커니즘을 활성화함:
   - kswapd (백그라운드 페이지 스캐너)
   - direct reclaim (동기식, 할당 차단)
   - page writeback (더티 페이지를 디스크로 플러시)
       ↓
7. 페이지 회수가 애플리케이션 워크로드와 무관하게 CPU 사이클을 소비함
       ↓
8. 요청 처리량은 일정하거나 낮음에도 불구하고 CpuPercentage가 상승함
```

## 증명 또는 반증이 필요한 사항

### 증명 기준 (모두 충족해야 함):
1. **메모리가 88% 이상 유지**: 워커/플랜 메트릭에서 30분 이상 지속
2. **트래픽이 일정함**: 요청률이 기준치 대비 ±10% 이내이며, 관찰 기간 동안 버스트가 없음
3. **CPU가 실질적으로 상승**: CpuPercentage가 기준치의 2배 이상 또는 10%포인트 이상 상승하여 15분 이상 유지
4. **회수 활동 확인**: 다음 중 최소 2개 이상의 메트릭이 지속적으로 증가:
   - `pgscan_kswapd` (kswapd에 의해 스캔된 페이지)
   - `pgscan_direct` (direct reclaim에 의해 스캔된 페이지)
   - `pgsteal_kswapd` (kswapd에 의해 회수된 페이지)
   - `pgsteal_direct` (direct reclaim에 의해 회수된 페이지)
   - `allocstall` (회수로 인한 할당 지연)
   - PSI 메모리 압박 (`/proc/pressure/memory`)
5. **Swap 관련 증명** (SwapTotal > 0인 경우에만 해당):
   - 시간이 지남에 따라 SwapFree 감소
   - CPU 상승 중 pswpin/pswpout 카운터 증가

### 반증 기준 (하나라도 해당되면 충분):
- 트래픽이 일정한 상태에서 높은 메모리가 유지되지만, 반복된 실행 과정에서 CPU 및 회수 카운터가 기준치 근처에 머무는 경우
- CPU는 상승하지만 회수 카운터에 활동이 없는 경우 (다른 원인으로 인한 CPU 증가)
- SwapTotal = 0 이며 회수 카운터가 상승하지 않는 경우 (커널 메모리 압박 메커니즘이 작동하지 않음)

## 변수

### 독립 변수 (제어하는 요소):
- 플랜 내 앱 개수 (2 → 4 → 6 → 8)
- 앱당 메모리 할당량 (ALLOC_MB: 50 → 100 → 150 → 200)
- 배포 모드 (ZIP 배포 vs Web App for Containers)
- 트래픽률 (고정된 가벼운 부하: 앱당 10초당 1개 요청)

### 종속 변수 (측정하는 요소):
- 플랜 CpuPercentage (Azure Monitor, 1분 단위)
- 플랜 MemoryPercentage (Azure Monitor, 1분 단위)
- PercentPhysicalMemoryUsed (접근 가능한 경우 진단 블레이드 활용)
- /proc/meminfo: MemTotal, MemFree, MemAvailable, SwapTotal, SwapFree, Cached, Dirty, SReclaimable
- /proc/vmstat: pswpin, pswpout, pgscan_kswapd, pgscan_direct, pgsteal_kswapd, pgsteal_direct, pgfault, pgmajfault, allocstall
- /proc/pressure/memory: PSI 메트릭 (avg10, avg60, avg300, total 등)
- 앱 레벨: process.memoryUsage() (rss, heapUsed, external, arrayBuffers)
- 앱 레벨: requestCount, cpuUsage

### 통제 변수 (일정하게 유지하는 요소):
- 플랜 SKU: B1 (1 vCPU, 1.75 GB RAM)
- 리전: koreacentral
- Node.js 버전: 20-lts
- 트래픽 패턴: 앱당 10초당 1개 요청 (steady-traffic.mjs)
- 앱 코드: 모든 앱이 동일함 (ALLOC_MB 및 APP_NAME만 다름)

## 실험 매트릭스

| 단계 | 배포 모드 | 앱 개수 | ALLOC_MB | 대상 메모리% | 트래픽 | 기간 | 목적 |
|-------|------------|------|----------|----------------|---------|----------|---------|
| 0 | ZIP | 2 | 50 | ~40% | 없음→가벼움 | 15분 | 탐색: swap 및 메트릭 파이프라인 확인 |
| 1 | ZIP | 2 | 50 | ~50-60% | 가벼움 | 30-60분 | 기준치: 낮은 압박에서의 CPU/메모리/swap |
| 2a | ZIP | 4 | 100 | ~80-85% | 가벼움 | 60분 | 고점 접근 |
| 2b | ZIP | 6 | 100 | ~88-92% | 가벼움 | 60-120분 | **핵심 테스트**: 높은 메모리, 일정한 트래픽 → CPU? |
| 3 | ZIP | (2b와 동일) | (동일) | ~88-92% | 60초 버스트 | 10분 | 높은 메모리 상황에서의 트래픽 버스트 |
| 4 | Container | (0-3단계 반복) | | | | | 배포 모드 간 비교 |

## 리스크 레지스터

| 리스크 | 영향 | 완화 방안 |
|------|--------|------------|
| B1에서 SwapTotal = 0 | swap 관련 체인을 증명할 수 없음 | "회수 주도형 CPU(reclaim-driven CPU)" 가설로 수정 |
| /proc이 컨테이너 범위로 제한됨 | 카운터가 호스트를 반영하지 못함 | 플랜 레벨의 Azure Monitor + cgroup 통계를 주 지표로 사용 |
| MemoryPercentage가 컨테이너를 반영하지 않음 | 목표치인 90%에 도달하지 못함 | ZIP 배포를 주요 증거로 활용 |
| 플랫폼 노이즈가 신호를 가림 | 결과가 모호해짐 | 설정당 3회 반복 실시 |
| B1 싱글 vCPU | 회수 활동이 앱과 직접 경쟁함 | 가설을 오히려 뒷받침함 — 싱글 CPU 환경에서 현상이 더 잘 드러남 |

## 주요 메트릭 관계

```
가설이 참(TRUE)일 경우 기대되는 상관관계:

MemoryUsed ↑ → SwapFree ↓ → pgscan_kswapd ↑ → CpuPercentage ↑
                               (request_rate가 일정하게 유지되는 동안)

가설이 거짓(FALSE)일 경우:

MemoryUsed ↑ → SwapFree ↓ → pgscan_kswapd 일정 → CpuPercentage 일정
                               (커널이 CPU 비용 없이 압박을 처리함)
```
