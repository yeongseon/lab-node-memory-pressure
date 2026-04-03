#!/usr/bin/env bash

set -u

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-node-memory-lab}"
NAME_PREFIX="${NAME_PREFIX:-memlabnode}"
APP_COUNT="${APP_COUNT:-2}"
OUTPUT_DIR="${OUTPUT_DIR:-results}"
PLAN_NAME="${PLAN_NAME:-${NAME_PREFIX}-plan}"

WATCH_SECONDS=""
STOP_REQUESTED=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --watch)
      WATCH_SECONDS="${2:-}"
      shift 2
      ;;
    *)
      echo "[metrics] unknown arg: $1"
      exit 1
      ;;
  esac
done

if [[ -n "$WATCH_SECONDS" ]] && ! [[ "$WATCH_SECONDS" =~ ^[0-9]+$ ]] ; then
  echo "[metrics] --watch must be an integer seconds"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

SUMMARY_CSV="$OUTPUT_DIR/azure-metrics.csv"
if [[ ! -f "$SUMMARY_CSV" ]] || [[ ! -s "$SUMMARY_CSV" ]]; then
  printf 'snap_ts,resource,resource_type,metric,value\n' >> "$SUMMARY_CSV"
fi

on_sigint() {
  STOP_REQUESTED=1
  echo "[metrics] SIGINT received, finishing current loop and exiting"
}
trap on_sigint INT TERM

resolve_apps() {
  local query="[?starts_with(name,'${NAME_PREFIX}')].name"
  mapfile -t ALL_APPS < <(az webapp list --resource-group "$RESOURCE_GROUP" --query "$query" --output tsv | tr -d '\r')

  APPS=()
  local max_count="$APP_COUNT"
  local i=0
  for app in "${ALL_APPS[@]}"; do
    [[ -z "$app" ]] && continue
    APPS+=("$app")
    i=$((i + 1))
    if [[ "$max_count" =~ ^[0-9]+$ ]] && [[ "$max_count" -gt 0 ]] && [[ "$i" -ge "$max_count" ]]; then
      break
    fi
  done
}

append_summary_from_metrics() {
  local snap_ts="$1"
  local resource_name="$2"
  local resource_type="$3"
  local resource_id="$4"
  local metric_list="$5"
  local interval="${6:-PT1M}"
  local offset="${7:-5m}"

  az monitor metrics list \
    --resource "$resource_id" \
    --metric "$metric_list" \
    --aggregation Average Maximum \
    --interval "$interval" \
    --offset "$offset" \
    --output json 2>/dev/null \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
snap_ts = sys.argv[1]
resource_name = sys.argv[2]
resource_type = sys.argv[3]
for v in data.get('value', []):
    metric = v.get('name', {}).get('value', 'unknown')
    ts_list = v.get('timeseries', [])
    if not ts_list:
        continue
    dp_list = ts_list[0].get('data', [])
    if not dp_list:
        continue
    last = dp_list[-1]
    val = last.get('average') or last.get('maximum') or last.get('total') or ''
    if val == '' or val is None:
        continue
    print(f'{snap_ts},{resource_name},{resource_type},{metric},{val}')
" "$snap_ts" "$resource_name" "$resource_type" >> "$SUMMARY_CSV" 2>/dev/null || true
}

collect_once() {
  local timestamp
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  resolve_apps
  if [[ ${#APPS[@]} -eq 0 ]]; then
    echo "[metrics] no apps found for prefix=$NAME_PREFIX in rg=$RESOURCE_GROUP"
    return 1
  fi

  local plan_id
  plan_id="$(az appservice plan show --resource-group "$RESOURCE_GROUP" --name "$PLAN_NAME" --query id --output tsv 2>/dev/null | tr -d '\r' || true)"
  if [[ -z "$plan_id" ]]; then
    echo "[metrics] could not resolve plan id for plan=$PLAN_NAME in rg=$RESOURCE_GROUP"
    return 1
  fi

  local plan_file="$OUTPUT_DIR/azure-plan-${timestamp}.json"
  plan_file="${plan_file//:/-}"

  echo "[metrics] collect plan metrics ts=$timestamp"
  az monitor metrics list \
    --resource "$plan_id" \
    --metric "CpuPercentage,MemoryPercentage" \
    --aggregation Average Maximum \
    --interval PT1M \
    --offset 5m \
    --output json > "$plan_file"

  append_summary_from_metrics "$timestamp" "$plan_id" "plan" "$plan_id" "CpuPercentage,MemoryPercentage"

  for app in "${APPS[@]}"; do
    local app_id="/subscriptions/$(az account show --query id --output tsv 2>/dev/null | tr -d '\r')/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.Web/sites/${app}"
    if [[ -z "$app_id" || "$app_id" == */sites/ ]]; then
      echo "[metrics] skip app=$app (no resource id)"
      continue
    fi

    local app_file="$OUTPUT_DIR/azure-app-${app}-${timestamp}.json"
    app_file="${app_file//:/-}"

    echo "[metrics] collect app metrics app=$app ts=$timestamp"
    az monitor metrics list \
      --resource "$app_id" \
      --metric "CpuTime,Requests,MemoryWorkingSet,AverageMemoryWorkingSet,Http5xx,HealthCheckStatus" \
      --aggregation Average Maximum \
      --interval PT5M \
      --offset 10m \
      --output json > "$app_file"

    append_summary_from_metrics "$timestamp" "$app" "app" "$app_id" "CpuTime,Requests,MemoryWorkingSet,AverageMemoryWorkingSet,Http5xx,HealthCheckStatus" "PT5M" "10m"
  done

  echo "[metrics] collection complete ts=$timestamp apps=${#APPS[@]}"
  return 0
}

if [[ -n "$WATCH_SECONDS" ]]; then
  echo "[metrics] watch mode enabled every ${WATCH_SECONDS}s"
  while true; do
    collect_once || true
    [[ "$STOP_REQUESTED" -eq 1 ]] && break
    sleep "$WATCH_SECONDS"
    [[ "$STOP_REQUESTED" -eq 1 ]] && break
  done
  echo "[metrics] stopped"
else
  collect_once
fi
