// Anomaly detector sized to the run rate, not a limit; the EPIC ceiling is eagle-edge azure/budget-mg.bicep.
// CAD: a budget uses the subscription's billing currency, and both subscriptions bill in CAD.

@description('Environment name (e.g. test, prod)')
param environmentName string

// Run rate is about 10 CAD/month on test and 17 on prod. 60 allows a busy month and still catches a
// client loop billing 3.83 CAD/GB into the uncapped workspace.
@description('Monthly anomaly guard in CAD. Set above the measured run rate, not a multiple of it.')
param budgetAmount int = 60

@description('Email addresses to receive budget threshold alerts. Passed in, never defaulted: an address in a public repository is a spam target.')
param contactEmails array

@description('Tag key and value every resource in this estate carries. main.bicep passes both from the same defaultTags entry, so the filter key and the tags cannot drift apart.')
@minLength(1)
param applicationTagKey string
@minLength(1)
param applicationTagValue string

// utcNow() is legal only as a parameter default.
@description('First day of the budget period. Defaults to the first of the current month for a NEW budget; an existing budget REJECTS any startDate change, so param files pin the live value.')
param startDate string = ''
param nowMonth string = utcNow('yyyy-MM-01')
var effectiveStartDate = empty(startDate) ? nowMonth : startDate

resource costBudget 'Microsoft.Consumption/budgets@2021-10-01' = {
  name: 'analytics-budget-${environmentName}'
  properties: {
    category: 'Cost'
    amount: budgetAmount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: '${effectiveStartDate}T00:00:00Z'
    }
    // Unfiltered, a budget measures the whole resource group, which both environments share with other
    // estates. Every billable resource carries main.bicep's defaultTags; `In` is the only operator.
    filter: {
      tags: {
        name: applicationTagKey
        operator: 'In'
        values: [applicationTagValue]
      }
    }
    notifications: {
      Actual_80_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        contactEmails: contactEmails
      }
      Actual_100_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        contactEmails: contactEmails
      }
      // Forecast is the only alert that arrives before a runaway event loop has spent the money.
      Forecasted_100_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        contactEmails: contactEmails
        thresholdType: 'Forecasted'
      }
    }
  }
}

output budgetName string = costBudget.name
