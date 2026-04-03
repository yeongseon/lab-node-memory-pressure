# Node.js Memory Pressure Lab

Azure App Service의 메모리 부하 상황에서 Linux kernel page reclaim으로 인해 CPU 사용량이 증가하는지 조사하는 실험입니다.

> "메모리 부하 상황에서 Linux kernel의 page reclaim 프로세스는 상당한 CPU 사이클을 소모하며, 애플리케이션 자체가 CPU 집약적이지 않더라도 성능 저하를 유발합니다."

!!! success "판정: 부분적으로 지지됨"
    가설은 부분적으로 지지되었습니다. kernel reclaim 동안 CPU 증가가 관찰되었으나, swap이 거의 고갈되었을 때 가장 두드러지게 나타났습니다.

### 주요 결과

- **ZIP Deploy**: kernel reclaim만으로 CPU가 1.75배 상승했으며, 이때 swap 고갈률은 99.2%였습니다.
- **Container Deploy**: 메모리 점유율 80%까지는 CPU가 안정적이었으나, 컨테이너 6개 실행 시 OOM 연쇄 반응이 발생했습니다.
- **버스트 지연 시간**: 부하 상황에서 ZIP Deploy의 평균 지연 시간은 16.8ms였던 반면, Container Deploy는 173.9ms를 기록했습니다.
- **권장 사항**: 성능 저하를 방지하려면 B1 Linux 플랜에서 메모리 사용률을 80% 미만으로 유지하십시오.

### 프로젝트 내비게이션

- [가설 (Hypothesis)](hypothesis.md): 상세한 문제 정의 및 예상 결과.
- [실험 결과 (Experiment Results)](experiment-log.md): ZIP 및 Container Deploy의 데이터 로그, 차트 및 분석.
- [런북 (Runbook)](runbook.md): 실험 재현을 위한 지침.

### 환경 요약

| 구성 요소 | 사양 |
|-----------|---------------|
| App Service Plan | Azure App Service B1 Linux |
| 리소스 | 1 vCPU, 1.75GB RAM |
| 런타임 | Node.js 20 |
| 리전 | Korea Central |
