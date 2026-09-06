// Monthly cost anomaly guard for the analytics estate.
//
// The absolute annual ceiling for everything EPIC owns lives at the c4b0a8 management group
// (digitalspace/eagle-edge `azure/budget-mg.bicep`). This is an anomaly detector sized to the run
// rate, not a limit.
//
// CAD, not USD: a Consumption Budget is denominated in the subscription's BILLING currency, which
// both subscriptions here report as CAD. The parameter name cannot pick a currency, so mislabelling
// it is how a 60 ceiling gets read as ~82.

@description('Environment name (e.g. test, prod)')
param environmentName string

// Estimated run rate is about 10 CAD/month on test and 17 on prod: Log Analytics ingest and
// retention, Flex Consumption, storage. 60 leaves room for a busy month and still catches the
// failure that costs real money — a client loop billing 3.83 CAD/GB into an uncapped workspace.
@description('Monthly anomaly guard in CAD. Set above the measured run rate, not a multiple of it.')
param budgetAmount int = 60

@description('Email addresses to receive budget threshold alerts. Passed in, never defaulted: an address in a public repository is a spam target.')
param contactEmails array

@description('Value of the `Application` tag every resource in this estate carries. main.bicep passes its own defaultTags.Application, so the filter and the tags cannot drift apart.')
param applicationTag string

// utcNow() is only legal as a parameter default in Bicep, which is the shape wanted here: evaluated
// once at deployment, never drifting on a redeploy of an unchanged template.
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
    // A budget with no filter measures the WHOLE resource group, and both groups are shared: test
    // sits with eagle-demi (about 150 CAD/month on its own), prod with the eagle-public estate. That
    // is what fired all three thresholds on 2026-09-06 without analytics spending anything near 60.
    // Every billable resource here is stamped by main.bicep's defaultTags and its usage records
    // carry the tag; `In` is the only operator a budget filter accepts.
    filter: {
      tags: {
        name: 'Application'
        operator: 'In'
        values: [applicationTag]
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
      // Forecast, not actual: the only notification that can arrive while the money is still
      // unspent, which is what makes it useful against a runaway event loop.
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
