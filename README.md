# OpenMRS-AdvaPACS FHIR mediator (scaffold)

An OpenHIM mediator that sits between OpenMRS and AdvaPACS and moves radiology
orders and results between them as FHIR resources.

## Flow

1. An order is created in OpenMRS (`ServiceRequest`).
2. That order reaches this mediator one of two ways, controlled by
   `ORDER_INGESTION_MODE` (see `.env.example`):
   - **`push`** (default): something on the OpenMRS side POSTs it (or its id)
     to `POST /fhir/ServiceRequest` on this mediator (`src/routes/serviceRequest.js`),
     via OpenHIM's "OpenMRS to AdvaPACS order push" inbound channel.
   - **`poll`**: `src/lib/orderPoller.js` periodically searches OpenMRS's FHIR
     `ServiceRequest` endpoint for anything new since the last poll, then POSTs
     each one to that same OpenHIM inbound channel — it no longer calls the
     relay logic in-process, so this hop is logged (and retryable) as a real
     OpenHIM transaction instead of being invisible.
3. Either way, `routes/serviceRequest.js` hands off to `src/lib/orderRelay.js`,
   which resolves the patient and remaps references, then
   `src/lib/advapacsClient.js` pushes the resource to AdvaPACS's FHIR API —
   but through a second, **outbound** OpenHIM channel ("Mediator to AdvaPACS
   order push", `^/advapacs/.*$`) rather than calling AdvaPACS directly, so
   that leg is logged and auto-retried by OpenHIM too (see Known limitations).
4. AdvaPACS performs/reads the study, then fires its own FHIR `Subscription`
   (rest-hook) at `POST /webhooks/advapacs` on this mediator, carrying an
   `ImagingStudy` or `DiagnosticReport`. (This leg is *not* routed through an
   OpenHIM channel today — see Known limitations.)
5. `src/routes/subscriptionWebhook.js` writes that resource into OpenMRS and
   flips the originating `ServiceRequest` to `completed`.

```
orderPoller.js (every ORDER_POLL_INTERVAL_MS)
  --HTTP POST--> OpenHIM inbound channel  ^/fhir/ServiceRequest$
    --routes to--> mediator's POST /fhir/ServiceRequest (routes/serviceRequest.js)
      --calls--> orderRelay.js (resolve patient, remap subject)
        --calls--> advapacsClient.js createServiceRequest()
          --HTTP POST--> OpenHIM outbound channel  ^/advapacs/.*$  (auto-retry enabled)
            --pathTransform strips /advapacs, routes to--> real AdvaPACS host
```

## What's real vs. stubbed

This scaffold wires up the transport, auth, and registration plumbing
end-to-end and will run. Two things are intentionally left as `TODO`s because
they need your actual data model, not boilerplate:

- **Identifier reconciliation** (`serviceRequest.js`, `subscriptionWebhook.js`):
  right now the AdvaPACS-side id returned on order push is only logged. You'll
  want a small lookup store (a table, or OpenHIM's own transaction/orchestration
  log) mapping OpenMRS `ServiceRequest.id` ↔ AdvaPACS `ServiceRequest.id`, so
  the webhook handler can find the right OpenMRS order to update instead of
  relying on `DiagnosticReport.basedOn` alone.
- **Patient/location identifier mapping**: confirm which identifier AdvaPACS
  actually wants for worklist matching (MRN vs. OpenMRS UUID vs. an
  accession-linked id) and substitute it in the outbound `ServiceRequest.subject`.

## Known limitations

- **OpenHIM's auto-retry only covers connection failures/timeouts to
  AdvaPACS, not AdvaPACS returning an HTTP error.** The outbound channel has
  `autoRetryEnabled`/`autoRetryPeriodMinutes`/`autoRetryMaxAttempts` set (see
  `mediatorConfig.json`, `scripts/setupOpenhim.js`), but OpenHIM only
  auto-retries a transaction when the request to the destination itself fails
  (network error, timeout) or the destination responds with OpenHIM's own
  mediator-error envelope — a plain 4xx/5xx from AdvaPACS doesn't qualify. A
  real AdvaPACS error today just surfaces as a failed transaction with no
  further retry or alerting (see the comment above `advapacsClient.js`'s
  `createServiceRequest`). If that needs to be retried too, it'd need either a
  translation layer that emits OpenHIM's error envelope, or a separate
  retry/alerting mechanism — not built here.
- **The AdvaPACS result webhook isn't routed through an OpenHIM channel.**
  `mediatorConfig.json` still lists one (`AdvaPACS result webhook`), but
  `scripts/setupOpenhim.js` doesn't create it — only the two order-push
  channels are wired up and tested. `POST /webhooks/advapacs` still works if
  hit directly, just not via OpenHIM.
- **Both order-push channels are `authType: "public"`** — no OpenHIM client/
  RBAC is set up. That's fine for a trusted local dev network, but also
  avoids a real conflict: layering OpenHIM's own client Basic-auth on the
  outbound leg would collide with AdvaPACS's own `Authorization:
  ID=...,Secret=...` header on the same request. A production deployment
  would want real per-channel client credentials.

## Step you still need to do on the OpenMRS side

OpenMRS doesn't push events anywhere on its own. Pick one, set via
`ORDER_INGESTION_MODE`:

- **`push`** (needs an OpenMRS-side change): build an event listener module
  using OpenMRS's event/AOP hooks to POST newly created `ServiceRequest`s to
  OpenHIM's inbound channel.
- **`poll`** (needs no OpenMRS-side change): `src/lib/orderPoller.js` already
  implements this — it calls
  `GET {OPENMRS_BASE_URL}/ws/fhir2/R4/ServiceRequest?_lastUpdated=gt...`
  on an interval (`ORDER_POLL_INTERVAL_MS`) and submits anything new to
  OpenHIM. Simpler to stand up and works today, at the cost of
  up-to-`ORDER_POLL_INTERVAL_MS` latency and missing anything created while
  the mediator was down (the poll cursor resets to "now" on restart, it
  isn't persisted). Note: some OpenMRS FHIR2 module versions don't support a
  `status` search parameter on `ServiceRequest` at all (confirmed via that
  endpoint's `metadata`) — this poller intentionally doesn't filter by
  `status` for that reason.

## Running with Docker Compose (recommended)

```bash
cp .env.example .env      # fill in real credentials
docker compose up --build -d
```

Brings up four containers on one `openhim` network: `mongo-db`,
`openhim-core` (API on `localhost:8081`, router on `5000`/`5001`),
`openhim-console` (`localhost:9000`), and this mediator
(`openmrs-advapacs-mediator`, built from the repo's `Dockerfile`). A one-shot
`openhim-setup` service runs `scripts/setupOpenhim.js` to idempotently create
the two order-push channels (channels aren't auto-created from mediator
registration — that only happens if you explicitly run this script or import
`mediatorConfig.json`'s `defaultChannelConfig` by hand).

- The mediator container reaches OpenMRS on the host machine via
  `host.docker.internal` (wired up with `extra_hosts` in `docker-compose.yml`
  — Linux needs Docker Engine 20.10+ for the `host-gateway` special value).
- **First run on a fresh Mongo volume**: OpenHIM core auto-seeds a
  `root@openhim.org` user with its built-in default password
  `openhim-password` — not whatever you may have set via the console on a
  previous instance's (now-discarded) volume. Log into the console once to
  change it if you want something else.
- This is a separate, self-contained compose stack from any other
  standalone OpenHIM instance you may have running elsewhere — it uses the
  same container names/ports (`8081`, `9000`, `5000`-`5001`), so stop any
  other instance first.

## Running locally without OpenHIM core

```bash
cp .env.example .env      # fill in real credentials, set MEDIATOR_STANDALONE=true
npm install
npm start
```

Skips OpenHIM entirely. In `poll` mode this means `orderPoller.js`'s POST to
`OPENHIM_ROUTER_URL` will fail (nothing listening) — useful for exercising the
OpenMRS-polling side in isolation, not the full relay.

## Running registered with OpenHIM core (no Docker)

```bash
cp .env.example .env      # set OPENHIM_* vars to point at your instance
npm install
npm start
```

On startup the mediator registers itself and `mediatorConfig.json` with
OpenHIM core, activates its heartbeat, and attempts to register a FHIR
`Subscription` with AdvaPACS pointed at its own webhook URL. You'd still need
to run `node scripts/setupOpenhim.js` yourself (once) to create the two
order-push channels, and make sure `OPENHIM_ROUTER_URL`/`ADVAPACS_CHANNEL_URL`
in `.env` point at wherever that OpenHIM instance's router actually is.

## Files

```
mediatorConfig.json         OpenHIM mediator registration (endpoints, channels, config defs)
scripts/setupOpenhim.js     Idempotently creates/updates the two order-push channels via OpenHIM's API
Dockerfile                  Mediator's own container image
docker-compose.yml          Full local stack: mongo, openhim-core, openhim-console, mediator, one-shot channel setup
src/index.js                Registration + server bootstrap; always mounts the push endpoint, additionally starts the poller in 'poll' mode
src/lib/openmrsClient.js    OpenMRS FHIR2 client (read/search ServiceRequest/Patient, write results)
src/lib/advapacsClient.js   Calls OpenHIM's outbound channel (ADVAPACS_CHANNEL_URL), not AdvaPACS directly
src/lib/orderRelay.js       Shared order-relay logic used by both ingestion modes
src/lib/orderPoller.js      Poll-based ingestion (ORDER_INGESTION_MODE=poll) -- submits via OpenHIM's inbound channel
src/routes/serviceRequest.js       Inbound channel's target; always mounted regardless of ingestion mode
src/routes/subscriptionWebhook.js  Result webhook handler (not yet routed through OpenHIM -- see Known limitations)
```
