# eagle-analytics

Product analytics for EPIC. An Azure Functions app (Node 22, Flex Consumption) that:

- takes batched events from eagle-public, eagle-admin, eagle-api and eagle-demi,
- writes them into custom tables in a Log Analytics workspace through a Direct data collection rule,
- answers metric queries for the dashboard screens in eagle-demi-admin,
- stores saved dashboards in Table Storage.

It replaces penguin-analytics.

## Endpoints

Every route is served both under `/analytics` and at the root, because APIM and the nginx proxy mount
the API under the prefix while the Function host serves it at the root.

| Route | Auth | What it takes and answers |
|---|---|---|
| `GET /health` | none | nothing in, `200 {status, env}` out |
| `POST /events` | APIM shared header | `{ "events": [...] }`, at most 50. `202 {accepted, dropped, rejected}`, or `429` past the per-address cap |
| `POST /audit` | APIM shared header, `X-Analytics-Audit`, keyed APIM product | `{ "rows": [...] }`, at most 50. `202 {accepted, rejected}` |
| `POST /query` | APIM shared header, staff bearer token | a builder request. `200 {rows}`, plus `kql` for a sysadmin on `?debug=1` |
| `GET /query/schema` | APIM shared header, staff bearer token | nothing in, `200` with the measures, dimensions and operators the builder may offer |
| `GET /dashboards` | APIM shared header, staff bearer token | nothing in, `200 {dashboards}` — own, plus what others shared |
| `GET /dashboards/:id` | APIM shared header, staff bearer token | nothing in, `200` with the dashboard, or `404` |
| `PUT /dashboards/:id` | APIM shared header, staff bearer token | a dashboard. `201` on create, `200` on update, `403` for somebody else's |
| `DELETE /dashboards/:id` | APIM shared header, staff bearer token | nothing in, `204`, or `403` for somebody else's |

Every route except `/health` needs the gateway header, so the Function host is not callable directly.
`POST /audit` needs a second header on top of it: the `analytics-machine` API in `demi-apim-<env>` must
stamp `X-Analytics-Audit` on what it forwards, which is set on the eagle-demi side.

CORS belongs to APIM. The Function App declares none, and `POST /events` separately refuses a request
whose `Origin` header is set to something outside `ALLOWED_ORIGINS`.

A staff bearer token is a Keycloak token from a client named in `KEYCLOAK_ALLOWED_CLIENTS` carrying
one of the `sysadmin`, `staff` or `demi-admin` realm roles. Authentication is the route table's job
(`src/http/routes.js`); a controller reads the identity off `req.user` and never verifies a second
time.

An event is `{timestamp, eventType, sessionId, sourceApp, userId?, properties?}`. Properties named
`path`, `url`, `referrer`, `project_id`, `document_id` and `duration_ms` become their own columns;
`user_agent`, `screen_width` and `screen_height` become the device columns and are not stored as
sent. Everything else is kept in `Detail`. The caller's address is used to look up country, region
and city, and is then thrown away.

A `POST /query` body names a measure, a bin, a range and optional dimensions and filters. Every one
is a key into `src/query/schema.js`; no column, table or operator name can come out of a request
body, and the time range never reaches the query text at all.

## Run it locally

Needs Node 22 and [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local).
Yarn 4 through Corepack; do not use npm.

```bash
corepack enable
yarn install
yarn start          # func start, serves http://localhost:7071
curl http://localhost:7071/health
```

Lint and test:

```bash
yarn check          # yarn lint && yarn test
```

Local settings go in `local.settings.json` (git-ignored). With no DCR endpoint set, events are
discarded and a warning is logged, so the app runs offline.

## Environment variables

`src/config.js` is the only reader of these, apart from `index.js`, which reads
`APPLICATIONINSIGHTS_CONNECTION_STRING` before anything else is required so the telemetry distro can
instrument what loads after it. Outside `ENVIRONMENT=dev` the
app refuses to start without `APIM_SHARED_HEADER_VALUE`, `AUDIT_SHARED_HEADER_VALUE`,
`KEYCLOAK_ALLOWED_CLIENTS` or `ANALYTICS_WORKSPACE_CUSTOMER_ID`, so a deploy that forgot one fails
instead of serving an open or a permanently-401 API.

| Name | Default | What it does |
|---|---|---|
| `ALLOWED_ORIGINS` | empty | Comma list of origins `POST /events` accepts a browser request from. No `Origin` header means a server-side producer and is allowed; empty refuses every browser origin |
| `ALLOWED_SOURCE_APPS` | the four EPIC apps | Comma list. An event from anything else is refused |
| `ANALYTICS_FLUSH_MS` | `1000` | How long a buffered row waits before it is sent |
| `ANALYTICS_MAX_BATCH` | `100` | Rows per request to the ingestion API |
| `ANALYTICS_MAX_BATCH_BYTES` | `800000` | Byte ceiling per request, under the 1 MB API limit |
| `ANALYTICS_WORKSPACE_CUSTOMER_ID` | empty | Workspace GUID the query API reads. Empty answers `503` |
| `APIM_SHARED_HEADER_NAME` | `X-Analytics-Gateway` | Header APIM stamps on what it forwards |
| `APIM_SHARED_HEADER_VALUE` | empty | Value every route but `/health` requires. Empty skips the check |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | empty | Set by the Function App. Empty means no telemetry |
| `AUDIT_SHARED_HEADER_VALUE` | empty | Value `POST /audit` requires in `X-Analytics-Audit`, on top of the gateway header. Empty skips the check |
| `DEMI_AUDIT_WORKSPACE` | empty | Customer id (GUID) of `demi-audit-<env>`, unioned in for pre-cutover audit rows |
| `EAGLE_LOGS_WORKSPACE` | empty | Customer id (GUID) of the workspace behind `eagle-insights-<env>`, where the error measure reads |
| `ENVIRONMENT` | `dev` | Labels every row and picks per-environment behaviour |
| `EVENTS_DCR_ENDPOINT` | empty | Data collection endpoint for the events and audit tables. Empty turns ingest off |
| `EVENTS_DCR_IMMUTABLE_ID` | empty | Immutable id of the data collection rule |
| `FRONT_DOOR_ID` | empty | Front Door's own id. Only on a match is `X-Azure-SocketIP` trusted over `X-Forwarded-For` |
| `IP_EVENT_CAP` | `600` | Events one client address may send per minute per instance; over that, `POST /events` answers `429` |
| `KEYCLOAK_ALLOWED_CLIENTS` | empty | Comma list of client ids the read API accepts, matched on `aud` and `azp`. Empty admits nobody |
| `KEYCLOAK_REALM` | `eao-epic` | Realm the read API validates staff tokens against |
| `KEYCLOAK_URL` | empty | Keycloak base URL. Empty refuses every staff request |
| `LOG_LEVEL` | `info` | winston level |
| `NODE_ENV` | empty | Set to `production` by the Function App, which picks the JSON log format over the readable one |
| `SESSION_EVENT_CAP` | `2000` | Events one session may contribute per hour per instance; the rest are dropped |
| `STORAGE_ACCOUNT_NAME` | empty | Holds the GeoLite2 database and the saved dashboards. Empty means no location lookup |

`ALLOWED_SOURCE_APPS`, `SESSION_EVENT_CAP` and `IP_EVENT_CAP` are readable but unset by the template:
`src/config.js` owns those defaults, and a second copy in the Bicep would drift from it.

Authentication to Azure is managed identity only. There are no keys or secrets in this repo. The
secret-shaped settings — `APIM_SHARED_HEADER_VALUE`, `AUDIT_SHARED_HEADER_VALUE` and `FRONT_DOOR_ID` —
are read from the environment by the param files and never written into one.

## Deploy

Infrastructure and application deploy separately, and only the application deploys from CI.

| When | What runs |
|---|---|
| Pull request | `.github/workflows/pr.yaml` — lint and test, the client package, `az bicep build` |
| Push to `main` | `.github/workflows/azure-deploy-staging-api.yaml` — the Function on test |
| Release | `.github/workflows/azure-deploy-prod.yaml`, dispatch only, with a tag verified on test |
| Estate change | `bash scripts/deploy-infra.sh <test\|prod>`, by hand |

### The estate

`scripts/deploy-infra.sh` runs from an operator login, never from CI. The management group forbids
granting Contributor to anyone, so a CI identity cannot hold the rights an ARM deployment of this
group needs; the reason is Azure policy, not caution about automation.

The script needs `APIM_SHARED_HEADER_VALUE`, `AUDIT_SHARED_HEADER_VALUE`, `FRONT_DOOR_ID` and
`BUDGET_CONTACT_EMAIL` exported in that shell, and `CONFIRM_PROD=yes` for a live prod deploy. The
param files read all four with no fallback, so a missing export fails the Bicep build instead of
blanking a live app setting. The script also refuses a value carrying whitespace or a literal
backslash-n, which is what `export X="$(…)"` and `echo` without `-n` leave behind: the app settings
would take it verbatim while APIM stamps the clean value, and every request would answer 401. The two header values are the same strings eagle-demi's APIM deploy
reads — its `azure/main.<env>.bicepparam` takes them from the same variable names, and both estates
must be deployed with the same values or APIM's forwarded requests are refused. They are held as
secrets on the eagle-demi `test` GitHub environment; nothing in either repo carries a value.

The operator also needs read on `demi-audit-<env>`, whose customer id the template reads at deploy
time, and which in production lives in `rg-demi-prod`. Log Analytics Reader for the analytics identity
on that workspace is the one grant made by hand, because a resource-group deployment cannot assign a
role outside its own group.

### The application

CI authenticates as the user-assigned managed identity `analytics-cicd-<env>` through a federated
credential, with no client secret anywhere.

| | |
|---|---|
| Federated credential | issuer `https://token.actions.githubusercontent.com`, subject `repo:digitalspace/eagle-analytics:environment:<env>`, audience `api://AzureADTokenExchange` |
| RBAC | Website Contributor on `analytics-api-fc-<env>` **individually**, plus Storage Blob Data Contributor and Storage Account Contributor on the Function's storage account. Nothing at resource-group scope |
| Config | Secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `MAXMIND_LICENSE_KEY`; variables `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_STORAGE_ACCOUNT`. All on the GitHub environment, nothing at repository scope |

The template cannot make those assignments — it does not know the CI identity — so they are granted
by hand after the first `./scripts/deploy-infra.sh <env> --live`, once the app and the account exist.

Declaring `environment:` in a workflow changes the OIDC subject claim to
`repo:digitalspace/eagle-analytics:environment:<env>`, and the subject is the whole contract: rename
the environment and Azure Login fails with `AADSTS700213`. Create the credential for the new subject
before renaming, prove a deploy green, and only then remove the old one.

`.github/workflows/refresh-geoip.yaml` authenticates as the same identity and uploads to the `geoip`
container on that same storage account, so those two storage roles cover it as well. It needs
`MAXMIND_LICENSE_KEY` and `AZURE_STORAGE_ACCOUNT` on the environment: the account is named rather
than looked up by resource group, because the identity holds nothing at that scope and the name
carries a uniqueString suffix.

The template grants the DEMI identity two things on this estate: publish on the analytics DCR, so
eagle-demi writes audit rows into the same pipeline, and Log Analytics Reader on
`analytics-logs-<env>`, so its `GET /admin/audit` can read the half of the union that lives here.
