# Event schema

What producers send, what gets stored, and what is deliberately not stored.

## Ingest endpoints

| Method | Path | Who calls it | Auth |
|---|---|---|---|
| POST | `/events` | browsers and server apps | gateway header, anonymous APIM product |
| POST | `/audit` | server apps | gateway header, its own `X-Analytics-Audit` header, and APIM's keyed product in front of it |
| GET | `/health` | deploy checks | none |

Every route except `/health` needs the gateway header, the read routes included.

Both POST endpoints take at most 50 entries. A bad entry is dropped on its own and the rest are kept:
the answer is `202 {"accepted": n, "dropped": n, "rejected": [{"index": n, "error": "…"}]}`. `400`
comes back only when nothing at all was accepted, or when the envelope itself is wrong. Rows are
buffered in the Function and posted to Log Analytics on a timer, so `202` means accepted, not stored.

`POST /events` also answers `429` with `Retry-After: 60` once one client address has sent more than
`IP_EVENT_CAP` events in a minute. Audit rows are never refused for volume.

## What the client sends

`POST /events` with `{"events": [ … ]}`. One event:

```json
{
  "timestamp": "2026-09-06T18:30:00.000Z",
  "eventType": "Page Viewed",
  "sessionId": "8f7c0f3a-2b6e-4b5a-9d21-6f1f0a2c9e77",
  "sourceApp": "eagle-public",
  "userId": "a3f2…",
  "properties": {
    "path": "/projects/123",
    "title": "Project detail",
    "referrer": "https://www.google.com/",
    "project_id": "6570c4dd…",
    "screen_width": 1512,
    "screen_height": 982,
    "user_agent": "Mozilla/5.0 …"
  }
}
```

Limits: `eventType` 100 characters, `sessionId` and `userId` 255, `sourceApp` 50 and drawn from the
allow-list (`eagle-public`, `eagle-admin`, `eagle-api`, `eagle-demi`), `properties` 8000 bytes
serialised, and the properties behind the `Page`, `Referrer`, `ProjectId` and `DocumentId` columns
2048 characters each. `userId` is set only by the staff apps, after Keycloak login.

`sessionId` is required from a browser app. A server-side producer — `sourceApp` of `eagle-api` or
`eagle-demi` — may leave it out, and the column is stored empty.

`timestamp` must be a real ISO 8601 instant, no more than 5 minutes in the future and no older than
2 days: the Logs Ingestion API rewrites anything older, so a row outside that window would be stored
under a date nobody sent.

Event names the client sends by itself: `Page Viewed`, `Link Clicked`, `Button Clicked`, `User Active`
(30 second heartbeat), `Session Started`, `Session Ended`, `User Identified`. Anything else comes from
a `track()` call in the producing app.

## EagleEvents_CL

400 day retention. Every column below is filled by the Function, not by the caller.

| Column | Source |
|---|---|
| `TimeGenerated` | the event's own `timestamp` |
| `EventName` | `eventType` |
| `SourceApp` | `sourceApp` |
| `SessionId` | `sessionId` |
| `UserId` | `userId` |
| `Page` | `properties.path`, or `properties.url` when there is no path |
| `Referrer` | `properties.referrer` |
| `ProjectId` | `properties.project_id` |
| `DocumentId` | `properties.document_id` |
| `DurationMs` | `properties.duration_ms`, left out when absent |
| `Country`, `Region`, `City` | GeoLite2 lookup on the caller's address |
| `DeviceType`, `Browser` | read off `properties.user_agent` |
| `ScreenW`, `ScreenH` | `properties.screen_width`, `properties.screen_height` |
| `Env` | the Function's `ENVIRONMENT` setting |
| `Detail` | every remaining property, as one dynamic value |

A property that gets a column of its own is taken out of `Detail`, so it is stored once. `user_agent`,
`screen_width` and `screen_height` are consumed the same way: the coarse values stay, the raw user
agent does not.

There is no `SourceIp` column, so `EagleEvents_CL | where isnotempty(SourceIp)` cannot return rows.

`EagleEventsDaily_CL` is the 730 day rollup of this table, one row per day, app, event, page, project,
country, device and environment, carrying `Events`, `Sessions` and `Users`. Its `Day` column is the
bucket. Ranges longer than 30 days read it instead of scanning raw events.

## EagleAudit_CL

Staff actions, EPIC-wide, 730 days interactive and seven years total. `POST /audit` with
`{"rows": [ … ]}`; a row carries `action` and `sourceApp` at minimum, plus optional `eventId`,
`outcome` (default `success`), `actorId`, `actorName`, `actorType`, `actorRoles`, `targetType`,
`targetId`, `projectId`, `correlationId`, `timestamp` and `detail`. Fields are capped at 255
characters, `detail` at 8000 bytes.

`ActorId` is the Keycloak `sub` and `ActorName` is the readable name: an audit trail should answer
"who did this" without a second system online.

`SourceIp` is filled from the connection, never from the body, and the data collection rule masks it
to the first two octets before it is stored. Anything that is not a dotted quad is stored as
`redacted`. Audit rows are never dropped: one outside the accepted timestamp window keeps the row and
takes the server's time instead, with a warning logged.

Reads are not audited. `POST /query` and the dashboard routes write no `EagleAudit_CL` row.

## Privacy

- No cookies and no consent banner. The session id lives in `sessionStorage`, so it is per tab and
  gone when the tab closes.
- No IP address is stored on product events. The address is used once, in memory, to resolve country,
  region and city, and is never logged or returned.
- No raw user agent. Only a device form factor and a browser family.
- Full URLs only under enhanced tracking, because a query string can hold search terms. The path is
  what is normally sent.
- `userId` on `POST /events` is asserted by the producing app, not authenticated. The route checks the
  gateway header and the browser `Origin`, and nothing more, so treat the field as a claim. Audit rows
  are the attributable record, and their actor comes from a server-side producer.
