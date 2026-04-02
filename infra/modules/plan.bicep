@description('App Service Plan name')
param planName string

@description('Azure region')
param location string

@description('App Service Plan SKU')
param planSku string

@description('Number of worker instances for the plan')
param instanceCount int

resource plan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: planName
  location: location
  kind: 'linux'
  sku: {
    name: planSku
    capacity: instanceCount
  }
  properties: {
    reserved: true
  }
}

output planId string = plan.id
output planName string = plan.name
