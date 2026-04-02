@description('Web App name. Must be globally unique.')
param appName string

@description('Azure region')
param location string

@description('App Service Plan resource ID')
param planId string

@description('Memory to allocate on startup (MB)')
param allocMb int

@description('Deployment mode: zip or container')
@allowed([
  'zip'
  'container'
])
param deployMode string

@description('Container image reference. Used only when deployMode=container.')
param containerImage string = ''

@description('ACR login server (e.g. myregistry.azurecr.io).')
param acrLoginServer string = ''

@description('ACR name for resolving admin credentials.')
param acrName string = ''

@description('Resource group name containing ACR.')
param acrResourceGroupName string

var useContainer = deployMode == 'container'
var useAcrCredentials = useContainer && !empty(acrName)

var linuxFxVersion = useContainer
  ? 'DOCKER|${containerImage}'
  : 'NODE|20-lts'

var startupCommand = useContainer
  ? ''
  : 'node server.mjs'

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = if (useAcrCredentials) {
  name: acrName
  scope: resourceGroup(acrResourceGroupName)
}

var dockerRegistryServerUrl = !empty(acrLoginServer) ? 'https://${acrLoginServer}' : ''
var dockerRegistryUsername = useAcrCredentials ? acr!.listCredentials().username : ''
var dockerRegistryPassword = useAcrCredentials ? acr!.listCredentials().passwords[0].value : ''

var baseAppSettings = [
  {
    name: 'ALLOC_MB'
    value: string(allocMb)
  }
  {
    name: 'APP_NAME'
    value: appName
  }
  {
    name: 'ENABLE_DIAG'
    value: 'true'
  }
  {
    name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
    value: 'false'
  }
  {
    name: 'ENABLE_ORYX_BUILD'
    value: 'false'
  }
  {
    name: 'WEBSITES_PORT'
    value: '8080'
  }
]

var zipOnlyAppSettings = !useContainer
  ? [
      {
        name: 'WEBSITE_NODE_DEFAULT_VERSION'
        value: '~20'
      }
    ]
  : []

var containerOnlyAppSettings = useContainer
  ? [
      {
        name: 'DOCKER_REGISTRY_SERVER_URL'
        value: dockerRegistryServerUrl
      }
      {
        name: 'DOCKER_REGISTRY_SERVER_USERNAME'
        value: dockerRegistryUsername
      }
      {
        name: 'DOCKER_REGISTRY_SERVER_PASSWORD'
        value: dockerRegistryPassword
      }
    ]
  : []

resource webApp 'Microsoft.Web/sites@2023-01-01' = {
  name: appName
  location: location
  kind: useContainer ? 'app,linux,container' : 'app,linux'
  properties: {
    serverFarmId: planId
    reserved: true
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: linuxFxVersion
      alwaysOn: true
      appCommandLine: startupCommand
      appSettings: concat(baseAppSettings, zipOnlyAppSettings, containerOnlyAppSettings)
      healthCheckPath: '/health'
    }
  }
}

output defaultHostname string = webApp.properties.defaultHostName
output appName string = webApp.name
