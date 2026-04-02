#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $(basename "$0") <new_app_count> [alloc_mb] [--mode zip|container]" >&2
  echo "Defaults: alloc_mb=100, mode=zip" >&2
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-node-memory-lab}"
LOCATION="${LOCATION:-koreacentral}"
NAME_PREFIX="${NAME_PREFIX:-memlabnode}"
PLAN_SKU="${PLAN_SKU:-B1}"
INSTANCE_COUNT="${INSTANCE_COUNT:-1}"

ACR_NAME="${ACR_NAME:-${NAME_PREFIX}acr}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
IMAGE_NAME="memlab-node"
CONTAINER_IMAGE="${CONTAINER_IMAGE:-${ACR_NAME}.azurecr.io/${IMAGE_NAME}:${IMAGE_TAG}}"

MODE="zip"
NEW_COUNT="${1:-}"

[[ -n "${NEW_COUNT}" ]] || {
  usage
  exit 1
}

shift
ALLOC_MB="100"
if [[ "${1:-}" != "" && "${1}" != --* ]]; then
  ALLOC_MB="${1}"
  shift
fi

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --mode)
      shift
      [[ "$#" -gt 0 ]] || fail "--mode requires a value: zip or container"
      MODE="$1"
      shift
      ;;
    *)
      usage
      fail "Unknown argument: $1"
      ;;
  esac
done

if [[ "${MODE}" != "zip" && "${MODE}" != "container" ]]; then
  fail "Invalid mode '${MODE}'. Use --mode zip or --mode container."
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${SCRIPT_DIR}/../infra"
APP_DIR="${SCRIPT_DIR}/../app"

trap 'echo "ERROR: Scaling failed at line ${LINENO}." >&2' ERR

command -v az >/dev/null 2>&1 || fail "Azure CLI (az) is required."
command -v jq >/dev/null 2>&1 || fail "jq is required."

[[ -f "${INFRA_DIR}/main.bicep" ]] || fail "Bicep template not found: ${INFRA_DIR}/main.bicep"

echo "=== Node Memory Pressure Lab - Scale Apps ==="
echo "  Resource Group : ${RESOURCE_GROUP}"
echo "  Location       : ${LOCATION}"
echo "  Name Prefix    : ${NAME_PREFIX}"
echo "  Plan SKU       : ${PLAN_SKU}"
echo "  Plan Instances : ${INSTANCE_COUNT}"
echo "  New App Count  : ${NEW_COUNT}"
echo "  Alloc MB/App   : ${ALLOC_MB}"
echo "  Mode           : ${MODE}"
if [[ "${MODE}" == "container" ]]; then
  echo "  Container Image: ${CONTAINER_IMAGE}"
fi
echo

echo "[1/4] Re-deploying infrastructure with new appCount and allocMbPerApp..."
if [[ "${MODE}" == "zip" ]]; then
  DEPLOY_OUTPUT="$(az deployment group create \
    --resource-group "${RESOURCE_GROUP}" \
    --template-file "${INFRA_DIR}/main.bicep" \
    --parameters \
      location="${LOCATION}" \
      namePrefix="${NAME_PREFIX}" \
      planSku="${PLAN_SKU}" \
      appCount="${NEW_COUNT}" \
      allocMbPerApp="${ALLOC_MB}" \
      instanceCount="${INSTANCE_COUNT}" \
      deployMode='zip' \
    --output json)"
else
  DEPLOY_OUTPUT="$(az deployment group create \
    --resource-group "${RESOURCE_GROUP}" \
    --template-file "${INFRA_DIR}/main.bicep" \
    --parameters \
      location="${LOCATION}" \
      namePrefix="${NAME_PREFIX}" \
      planSku="${PLAN_SKU}" \
      appCount="${NEW_COUNT}" \
      allocMbPerApp="${ALLOC_MB}" \
      instanceCount="${INSTANCE_COUNT}" \
      deployMode='container' \
      deployAcr=false \
      containerImage="${CONTAINER_IMAGE}" \
    --output json)"
fi

mapfile -t APP_NAMES < <(jq -r '.properties.outputs.appNames.value[]' <<<"${DEPLOY_OUTPUT}")
mapfile -t APP_HOSTNAMES < <(jq -r '.properties.outputs.appHostnames.value[]' <<<"${DEPLOY_OUTPUT}")

[[ "${#APP_NAMES[@]}" -gt 0 ]] || fail "No app names returned from deployment outputs."

if [[ "${MODE}" == "zip" ]]; then
  echo "[2/4] ZIP mode: ensuring deployment package exists..."
  command -v npm >/dev/null 2>&1 || fail "npm is required in ZIP mode."
  command -v zip >/dev/null 2>&1 || fail "zip is required in ZIP mode."

  [[ -f "${APP_DIR}/server.mjs" ]] || fail "Missing app entry file: ${APP_DIR}/server.mjs"
  [[ -f "${APP_DIR}/package.json" ]] || fail "Missing package.json: ${APP_DIR}/package.json"
  [[ -f "${APP_DIR}/package-lock.json" ]] || fail "Missing package-lock.json: ${APP_DIR}/package-lock.json (required for npm ci)"

  if [[ ! -f "${APP_DIR}/app.zip" ]]; then
    echo "  app.zip not found. Building package..."
    if [[ ! -d "${APP_DIR}/node_modules" ]]; then
      echo "  node_modules not found. Running npm ci --omit=dev..."
      npm ci --omit=dev --prefix "${APP_DIR}"
    fi

    (
      cd "${APP_DIR}"
      zip -rq app.zip server.mjs package.json package-lock.json node_modules
    )
  else
    echo "  Reusing existing package: ${APP_DIR}/app.zip"
  fi

  echo "[3/4] Deploying ZIP package to all apps..."
  for app_name in "${APP_NAMES[@]}"; do
    echo "  Deploying to ${app_name}..."
    az webapp deploy \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${app_name}" \
      --src-path "${APP_DIR}/app.zip" \
      --type zip \
      --output none
  done
else
  echo "[2/4] Container mode: restarting all apps to pull existing image..."
  for app_name in "${APP_NAMES[@]}"; do
    echo "  Restarting ${app_name}..."
    az webapp restart \
      --name "${app_name}" \
      --resource-group "${RESOURCE_GROUP}" \
      --output none
  done
fi

echo "[4/4] Scale operation complete. App status endpoints:"
for hostname in "${APP_HOSTNAMES[@]}"; do
  echo "  https://${hostname}/health"
done

echo "Done."
