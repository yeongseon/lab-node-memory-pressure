targetScope = 'resourceGroup'

@description('Azure region. Defaults to resource group location.')
param location string = resourceGroup().location

@description('Prefix for all resource names. Must be lowercase letters and numbers only.')
@maxLength(12)
param namePrefix string = 'memlabnode'

@description('App Service Plan SKU. B1/B2 for Basic, S1 for Standard.')
@allowed([
  'B1'
  'B2'
  'S1'
])
param planSku string = 'B1'

@description('Number of Web Apps to deploy on the same plan.')
@minValue(1)
@maxValue(15)
param appCount int = 2

@description('Memory to allocate per app at startup (MB).')
@minValue(10)
@maxValue(500)
param allocMbPerApp int = 100

@description('Deployment mode: zip for ZIP deploy, container for Web App for Containers.')
@allowed([
  'zip'
  'container'
])
param deployMode string = 'zip'

@description('Container image reference (for example myregistry.azurecr.io/app:latest). Used only when deployMode=container.')
param containerImage string = ''

@description('Deploy Azure Container Registry module.')
param deployAcr bool = false

@description('ACR name. Must be globally unique and alphanumeric only.')
param acrName string = '${namePrefix}acr'

@description('Number of App Service Plan workers (instances).')
@minValue(1)
@maxValue(3)
param instanceCount int = 1

var planName = '${namePrefix}-plan'
var acrLoginServer = deployAcr ? acr!.outputs.acrLoginServer : ''

module plan 'modules/plan.bicep' = {
  name: 'deploy-plan'
  params: {
    planName: planName
    location: location
    planSku: planSku
    instanceCount: instanceCount
  }
}

module acr 'modules/acr.bicep' = if (deployAcr) {
  name: 'deploy-acr'
  params: {
    acrName: acrName
    location: location
  }
}

module webApps 'modules/webapp.bicep' = [for i in range(0, appCount): {
  name: 'deploy-webapp-${i + 1}'
  params: {
    appName: '${namePrefix}-${i + 1}'
    location: location
    planId: plan.outputs.planId
    allocMb: allocMbPerApp
    deployMode: deployMode
    containerImage: containerImage
    acrLoginServer: acrLoginServer
    acrName: deployAcr ? acr!.outputs.acrName : ''
    acrResourceGroupName: resourceGroup().name
  }
}]

output planName string = plan.outputs.planName
output planId string = plan.outputs.planId
output appHostnames array = [for i in range(0, appCount): webApps[i].outputs.defaultHostname]
output appNames array = [for i in range(0, appCount): webApps[i].outputs.appName]
output acrLoginServer string = deployAcr ? acr!.outputs.acrLoginServer : ''
