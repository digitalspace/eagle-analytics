# Migration from penguin-analytics, and retiring it

Do these in order. Nothing here is reversible after step 9, so the count check in step 3 is the gate.

Scope: only the EPIC namespaces `6cdc9e-dev`, `6cdc9e-test`, `6cdc9e-prod`. `c72cba` is epic-engage's
own namespace on the Gold cluster and it keeps running penguin; never touch it, and never touch the
GC Notify webhook.

## 1. Deploy the test estate and the API

```bash
export APIM_SHARED_HEADER_VALUE='…'   # same value as the APIM policy
./scripts/deploy-infra.sh test --what-if   # read it first
./scripts/deploy-infra.sh test --live
```

Copy `eventsDcrEndpoint` and `eventsDcrImmutableId` out of the deployment outputs. A Direct rule's
endpoint is assigned at create time and cannot be composed from the name. Run this by hand from an
operator login: CI deploys the application only.

Then publish the API, by hand for the first one — a Bicep-only change triggers no deploy:

```bash
gh workflow run azure-deploy-staging-api.yaml -R digitalspace/eagle-analytics --ref main
```

Every later push to `main` that touches the application publishes the Function onto the settings this
step wrote.

## 2. Dual-write on test for one week

Point the client at both: eagle-public and eagle-admin keep sending to penguin and also send to
`/analytics/events`. Nothing is switched off yet.

Since eao-nginx v2.7.32 (2026-09-06), the browser-facing prefix is `/api/usage/`; rproxy rewrites it
to `/analytics/` for the gateway, because ad blockers refuse paths containing "analytics". Config
`EAGLE_ANALYTICS_URL` is `/api/usage` on test.

## 3. Compare the counts

In penguin:

```bash
oc --context epic-test -n 6cdc9e-test exec deploy/penguin-analytics-database -- bash -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
   "select source_app, event_type, count(*) from events where timestamp > now() - interval '"'"'7 days'"'"' group by 1,2 order by 3 desc"'
```

In the analytics workspace:

```kql
EagleEvents_CL
| where TimeGenerated > ago(7d)
| summarize count() by SourceApp, EventName
| order by count_ desc
```

Accept a gap under 2 %: beacons are lost on tab close, and the two pipelines drop different ones. A
bigger gap means a producer is missing events, not that the numbers are noisy.

## 4. Import the history

Only the daily aggregates come over. Raw penguin events are not migrated.

Export both views, one CSV each:

```bash
oc --context epic-test -n 6cdc9e-test exec deploy/penguin-analytics-database -- bash -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
   "\copy (select * from daily_events_summary) to stdout csv header"' > daily_events_summary.csv

oc --context epic-test -n 6cdc9e-test exec deploy/penguin-analytics-database -- bash -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
   "\copy (select * from page_views) to stdout csv header"' > page_views.csv
```

Keep the CSVs as the provenance of the imported rows:

```bash
az storage blob upload --auth-mode login --account-name <analyticsfc…> \
  --container-name history --name 2026-09/daily_events_summary.csv --file daily_events_summary.csv
```

The import posts from your own login, not the Function's identity, so that login needs
`Monitoring Metrics Publisher` on `analytics-dcr-<env>`. Owner does not cover it: sending data to a
data collection rule is a data action, and the template grants the role only to the principals in
`publisherPrincipalIds`. Grant it to yourself, once per environment:

```bash
DCR=$(az resource show -g <rg> -n analytics-dcr-test \
  --resource-type Microsoft.Insights/dataCollectionRules --query id -o tsv)
az role assignment create --role "Monitoring Metrics Publisher" \
  --assignee-object-id "$(az ad signed-in-user show --query id -o tsv)" \
  --assignee-principal-type User --scope "$DCR"
```

Give it a few minutes to propagate. Until it does, the upload fails with 403 and the script prints
the status code and the service's message on one `[import]` line.

Then import. Check the counts first, post second:

```bash
export EVENTS_DCR_ENDPOINT='…'      # from step 1
export EVENTS_DCR_IMMUTABLE_ID='…'
node scripts/import-penguin-history.js --env test --file daily_events_summary.csv --dry-run
node scripts/import-penguin-history.js --env test --file daily_events_summary.csv
```

Two things to know about imported rows:

- `TimeGenerated` is the time of the import, because the Logs Ingestion API rewrites the timestamp on
  anything older than two days. The historical date is in `Day`, which is the column the live rollup
  rule fills too, so charts read both the same way.
- `page_views` totals a page over all time and carries no day, so its rows land on the day the page
  was last seen. Time series come from `daily_events_summary`.

Confirm the row count matches the CSV, then check a twelve month chart renders.

## 5. Production estate and application

```bash
CONFIRM_PROD=yes ./scripts/deploy-infra.sh prod --live
```

Then run the production deploy workflow with the tag verified on staging. Never deploy production from
a branch.

## 6. Cut over one app at a time

`ANALYTICS_API_URL` lives in the eagle-api `Config` document, so the switch needs no redeploy.
eagle-public first, eagle-admin a week later.

```bash
oc --context epic-prod port-forward -n 6cdc9e-prod svc/eagle-api-mongodb 27017:27017
# credentials: see eagle-api/migrations/README.md
mongosh "mongodb://localhost:27017/epic" --eval \
  'db.epic.updateOne({ _schemaName: "Config" }, { $set: { ANALYTICS_API_URL: "/analytics" } })'
```

The path stays `/analytics`; what changes is where the proxy in front of it sends the traffic.

## 7. Repoint the proxy

eao-nginx serves `/analytics` from `NGINX__EPIC__PROXY__ANALYTICS`
(`conf.d/server.conf.tmpl`). Change it from the penguin service to the APIM host, deploy eao-nginx
**before** the frontends, then restart rproxy so the template is re-rendered. eagle-public traffic
that arrives through Front Door is routed by eagle-edge instead, in its own change.

Check both paths answer:

```bash
curl -fsS https://projects.eao.gov.bc.ca/analytics/health
```

## 8. Two quiet weeks

Watch the penguin API logs. No eagle traffic for two weeks before anything is deleted.

## 9. Final dump, then remove penguin

Take a last TimescaleDB dump into the `history` container, then:

```bash
helm uninstall penguin-analytics -n 6cdc9e-dev
helm uninstall penguin-analytics -n 6cdc9e-test
helm uninstall penguin-analytics -n 6cdc9e-prod
```

Only those three namespaces.

## 10. Clean up what is left

- Delete the Metabase route and the PVCs in `6cdc9e-*`.
- Remove the penguin keys from the eagle-api `Config` document and the penguin rows from the
  `values-*.yaml` files.
- Archive `digitalspace/penguin-analytics` once the Engage team confirms it runs from its own
  namespace.
- Update `eagle-dev-guides.wiki` `Analytics-Architecture` so it describes the pipeline that exists.
