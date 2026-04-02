#!/usr/bin/env bash
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-node-memory-lab}"
LOCATION="${LOCATION:-koreacentral}"
NAME_PREFIX="${NAME_PREFIX:-memlabnode}"
PLAN_SKU="${PLAN_SKU:-B1}"
APP_COUNT="${APP_COUNT:-2}"
ALLOC_MB="${ALLOC_MB:-100}"
INSTANCE_COUNT="${INSTANCE_COUNT:-1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${SCRIPT_DIR}/../infra"
APP_DIR="${SCRIPT_DIR}/../app"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

trap 'echo "ERROR: Deployment failed at line ${LINENO}." >&2' ERR

command -v az >/dev/null 2>&1 || fail "Azure CLI (az) is required."
command -v jq >/dev/null 2>&1 || fail "jq is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."
command -v zip >/dev/null 2>&1 || fail "zip is required."

[[ -f "${INFRA_DIR}/main.bicep" ]] || fail "Bicep template not found: ${INFRA_DIR}/main.bicep"
[[ -f "${APP_DIR}/server.mjs" ]] || fail "Missing app entry file: ${APP_DIR}/server.mjs"
[[ -f "${APP_DIR}/package.json" ]] || fail "Missing package.json: ${APP_DIR}/package.json"
[[ -f "${APP_DIR}/package-lock.json" ]] || fail "Missing package-lock.json: ${APP_DIR}/package-lock.json (required for npm ci)"

echo "=== Node Memory Pressure Lab - ZIP Deploy ==="
echo "  Resource Group : ${RESOURCE_GROUP}"
echo "  Location       : ${LOCATION}"
echo "  Name Prefix    : ${NAME_PREFIX}"
echo "  Plan SKU       : ${PLAN_SKU}"
echo "  App Count      : ${APP_COUNT}"
echo "  Alloc MB/App   : ${ALLOC_MB}"
echo "  Plan Instances : ${INSTANCE_COUNT}"
echo

echo "[1/7] Creating resource group..."
az group create \
  --name "${RESOURCE_GROUP}" \
  --location "${LOCATION}" \
  --output none

echo "[2/7] Deploying infrastructure (Bicep) in ZIP mode..."
DEPLOY_OUTPUT="$(az deployment group create \
  --resource-group "${RESOURCE_GROUP}" \
  --template-file "${INFRA_DIR}/main.bicep" \
  --parameters \
    location="${LOCATION}" \
    namePrefix="${NAME_PREFIX}" \
    planSku="${PLAN_SKU}" \
    appCount="${APP_COUNT}" \
    allocMbPerApp="${ALLOC_MB}" \
    instanceCount="${INSTANCE_COUNT}" \
    deployMode='zip' \
  --output json)"

echo "[3/7] Parsing deployment outputs..."
mapfile -t APP_NAMES < <(jq -r '.properties.outputs.appNames.value[]' <<<"${DEPLOY_OUTPUT}")
mapfile -t APP_HOSTNAMES < <(jq -r '.properties.outputs.appHostnames.value[]' <<<"${DEPLOY_OUTPUT}")

[[ "${#APP_NAMES[@]}" -gt 0 ]] || fail "No app names returned from deployment outputs."

echo "[4/7] Preparing ZIP package..."
if [[ ! -d "${APP_DIR}/node_modules" ]]; then
  echo "  node_modules not found. Running npm ci --omit=dev..."
  npm ci --omit=dev --prefix "${APP_DIR}"
fi

(
  cd "${APP_DIR}"
  rm -f app.zip
  zip -rq app.zip server.mjs package.json package-lock.json node_modules
)

echo "[5/7] Deploying ZIP package to web apps..."
for app_name in "${APP_NAMES[@]}"; do
  echo "  Deploying to ${app_name}..."
  az webapp deploy \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${app_name}" \
    --src-path "${APP_DIR}/app.zip" \
    --type zip \
    --output none
done

echo "[6/7] Deployment complete. Endpoints:"
for hostname in "${APP_HOSTNAMES[@]}"; do
  echo "  https://${hostname}/health"
done

echo "[7/7] Cleaning up ZIP artifact..."
rm -f "${APP_DIR}/app.zip"

echo "Done."
