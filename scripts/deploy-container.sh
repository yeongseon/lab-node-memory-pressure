#!/usr/bin/env bash
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-node-memory-lab}"
LOCATION="${LOCATION:-koreacentral}"
NAME_PREFIX="${NAME_PREFIX:-memlabnode}"
PLAN_SKU="${PLAN_SKU:-B1}"
APP_COUNT="${APP_COUNT:-2}"
ALLOC_MB="${ALLOC_MB:-100}"
INSTANCE_COUNT="${INSTANCE_COUNT:-1}"

ACR_NAME="${ACR_NAME:-${NAME_PREFIX}acr}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
IMAGE_NAME="memlab-node"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${SCRIPT_DIR}/../infra"
APP_DIR="${SCRIPT_DIR}/../app"
FULL_IMAGE="${ACR_NAME}.azurecr.io/${IMAGE_NAME}:${IMAGE_TAG}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

trap 'echo "ERROR: Deployment failed at line ${LINENO}." >&2' ERR

command -v az >/dev/null 2>&1 || fail "Azure CLI (az) is required."
command -v jq >/dev/null 2>&1 || fail "jq is required."

[[ -f "${INFRA_DIR}/main.bicep" ]] || fail "Bicep template not found: ${INFRA_DIR}/main.bicep"
[[ -f "${APP_DIR}/Dockerfile" ]] || fail "Missing Dockerfile: ${APP_DIR}/Dockerfile"

echo "=== Node Memory Pressure Lab - Container Deploy ==="
echo "  Resource Group : ${RESOURCE_GROUP}"
echo "  Location       : ${LOCATION}"
echo "  Name Prefix    : ${NAME_PREFIX}"
echo "  Plan SKU       : ${PLAN_SKU}"
echo "  App Count      : ${APP_COUNT}"
echo "  Alloc MB/App   : ${ALLOC_MB}"
echo "  Plan Instances : ${INSTANCE_COUNT}"
echo "  ACR Name       : ${ACR_NAME}"
echo "  Image          : ${FULL_IMAGE}"
echo

echo "[1/5] Creating resource group..."
az group create \
  --name "${RESOURCE_GROUP}" \
  --location "${LOCATION}" \
  --output none

echo "[2/5] Deploying infrastructure (Bicep) in container mode..."
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
    deployMode='container' \
    deployAcr=true \
    acrName="${ACR_NAME}" \
    containerImage="${FULL_IMAGE}" \
  --output json)"

mapfile -t APP_NAMES < <(jq -r '.properties.outputs.appNames.value[]' <<<"${DEPLOY_OUTPUT}")
mapfile -t APP_HOSTNAMES < <(jq -r '.properties.outputs.appHostnames.value[]' <<<"${DEPLOY_OUTPUT}")

[[ "${#APP_NAMES[@]}" -gt 0 ]] || fail "No app names returned from deployment outputs."

echo "[3/5] Building and pushing image with az acr build..."
az acr build \
  --registry "${ACR_NAME}" \
  --image "${IMAGE_NAME}:${IMAGE_TAG}" \
  "${APP_DIR}" \
  --output none

echo "[4/5] Restarting all web apps to pull new image..."
for app_name in "${APP_NAMES[@]}"; do
  echo "  Restarting ${app_name}..."
  az webapp restart \
    --name "${app_name}" \
    --resource-group "${RESOURCE_GROUP}" \
    --output none
done

echo "[5/5] Deployment complete. Endpoints:"
for hostname in "${APP_HOSTNAMES[@]}"; do
  echo "  https://${hostname}/health"
done

echo "Done."
