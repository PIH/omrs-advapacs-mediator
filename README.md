# OpenMRS-AdvaPACS FHIR mediator (scaffold)

An OpenHIM mediator that sits between OpenMRS and AdvaPACS and moves radiology
orders and results between them as FHIR resources.

## Flow

1. An order is created in OpenMRS (`ServiceRequest`).
2. That order reaches this mediator one of two ways, controlled by
   `ORDER_INGESTION_MODE` (see `.env.example`):
   - **`push`** (default): something on the OpenMRS side POSTs it (or its id)
     to `POST /fhir/ServiceRequest` on this mediator (`src/routes/serviceRequest.js`),
     via OpenHIM's "OpenMRS to Mediator Order Push" inbound channel.
   - **`poll`**: `src/lib/orderPoller.js` periodically searches OpenMRS's FHIR
     `ServiceRequest` endpoint for anything new since the last poll, then POSTs
looks     each one to that same OpenHIM inbound channel.
3. Either way, `routes/serviceRequest.js` hands off to `src/lib/orderRelay.js`,
   which resolves the OpenMRS `Patient` and, before touching the
   `ServiceRequest` at all, pushes/updates that `Patient` in AdvaPACS first
   (`advapacsClient.js`'s `upsertPatient` — searches by identifier, then
   `PUT`s if AdvaPACS already has that patient or `POST`s to create) — if
   that fails, the `ServiceRequest` is never sent (fail-fast: AdvaPACS needs
   the patient record to exist before it can match an order to it). Only
   then does `orderRelay.js` remap the `ServiceRequest.subject` to a
   **literal reference at AdvaPACS's own Patient id**
   (`Patient/{advapacs-id}`, taken from `upsertPatient`'s response) instead
   of the OpenMRS UUID — a logical identifier-based reference was tried
   first but made AdvaPACS's real ServiceRequest endpoint 500 with no
   diagnostic detail. Several other OpenMRS-specific fields are also
   stripped or reshaped before the outbound `ServiceRequest` is sent
   (`encounter`/`requester`/`id`/`meta`/`text` dropped; `code`,
   `occurrenceDateTime`, and `orderDetail` reshaped to what AdvaPACS's FHIR
   R5 API actually expects) — see the inline `TODO`/`HACK`/`EXPERIMENT`
   comments in `orderRelay.js` for the current state and ticket numbers
   behind each. `advapacsClient.js` then pushes the `ServiceRequest` itself.
   Both pushes go through a second, **outbound** OpenHIM channel ("Mediator
   to AdvaPACS Order Push", `^/advapacs/.*$`) rather than calling AdvaPACS
   directly, so each leg is logged and auto-retried by OpenHIM (see Known
   limitations).
4. AdvaPACS would perform/read the study, then fire its own FHIR
   `Subscription` (rest-hook) at `POST /webhooks/advapacs` on this mediator,
   carrying an `ImagingStudy` or `DiagnosticReport` — **this leg is currently
   disabled and untested end-to-end, see Known limitations.**
5. `src/routes/subscriptionWebhook.js` would write that resource into
   OpenMRS and flip the originating `ServiceRequest` to `completed` — it's a
   placeholder today, not yet functional (see Known limitations).

```
orderPoller.js (every ORDER_POLL_INTERVAL_MS)
  --HTTP POST--> OpenHIM inbound channel  ^/fhir/ServiceRequest$
    --routes to--> mediator's POST /fhir/ServiceRequest (routes/serviceRequest.js)
      --calls--> orderRelay.js (resolve patient, reshape ServiceRequest for AdvaPACS)
        --calls--> advapacsClient.js upsertPatient()          [1: Patient, first]
          --HTTP GET/POST/PUT--> OpenHIM outbound channel  ^/advapacs/.*$  (auto-retry enabled)
        --calls--> advapacsClient.js createServiceRequest()   [2: ServiceRequest, only if #1 succeeded]
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
- **Location identifier mapping**: the patient side of this is resolved
  (`orderRelay.js` references the patient via AdvaPACS's own Patient id —
  see Flow), and `encounter`/`requester` (Practitioner) references are
  dropped from the outbound `ServiceRequest` entirely, since AdvaPACS can't
  resolve OpenMRS UUIDs for either. `Location` references aren't handled at
  all yet — confirm what AdvaPACS expects there if/when that becomes
  relevant.
- **Several other fields are temporarily hardcoded or reshaped** just to get
  a `ServiceRequest` past AdvaPACS's validation — accession-number
  identifier duplication (UHM-9437/9439/9440), an HL7 "PI" coding stamped
  onto the patient's EMR-ID identifier (UHM-9443), and the imaging modality
  hardcoded to X-ray/`CR` since OpenMRS doesn't expose it today (UHM-9445).
  See the `TODO`/`HACK`/`EXPERIMENT` comments in `orderRelay.js` for the
  reasoning and ticket numbers behind each.

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
- **The AdvaPACS result-delivery path (webhook) is disabled and untested.**
  `src/routes/subscriptionWebhook.js` is a placeholder — written but never
  exercised against a real AdvaPACS webhook delivery, since all effort so
  far has gone into the outbound order-push path. It isn't mounted in
  `src/index.js`, `advapacsClient.js`'s `ensureSubscription` isn't called on
  startup, and its channel/endpoint entries have been removed from
  `mediatorConfig.json`. Each disabled spot is marked with a matching
  comment — re-enable all three once this path is ready to test.
- **End-to-end order creation against AdvaPACS's real sandbox is still being
  worked through.** A sequence of `ServiceRequest` validation errors has
  been fixed one at a time (subject reference shape, `encounter`/
  `requester`, concept coding, occurrence type, accession-number coding,
  imaging modality, ...) — as of this writing, that process isn't yet
  confirmed complete. Check `orderRelay.js`'s inline comments (and recent
  git history) for the current state; remove this bullet once a full order
  round-trips successfully.
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
OpenHIM core and activates its heartbeat. (It used to also register a FHIR
`Subscription` with AdvaPACS pointed at its own webhook URL on startup, but
that's currently disabled along with the rest of the result-delivery path —
see Known limitations.) You'd still need to run `node scripts/setupOpenhim.js`
yourself (once) to create the two order-push channels, and make sure
`OPENHIM_ROUTER_URL`/`ADVAPACS_CHANNEL_URL` in `.env` point at wherever that
OpenHIM instance's router actually is.

## Running tests

```bash
npm install
npm test
```

Unit tests only — every HTTP call (to OpenMRS, AdvaPACS/OpenHIM's outbound
channel) is mocked with Jest, so nothing needs to be running: no Docker, no
OpenHIM, no OpenMRS. Covers `orderRelay.js`, `advapacsClient.js`,
`openmrsClient.js`, `orderPoller.js`, and `routes/serviceRequest.js`. Does
**not** cover `src/index.js`'s route-mounting/ingestion-mode logic (no
testable seam without a refactor) or `subscriptionWebhook.js` — see
`docs/superpowers/specs/2026-08-06-test-suite-design.md` for why.

## Files

```
mediatorConfig.json         OpenHIM mediator registration (endpoints, channels, config defs)
scripts/setupOpenhim.js     Idempotently creates/updates the two order-push channels via OpenHIM's API
Dockerfile                  Mediator's own container image
docker-compose.yml          Full local stack: mongo, openhim-core, openhim-console, mediator, one-shot channel setup
src/index.js                Registration + server bootstrap; always mounts the push endpoint, additionally starts the poller in 'poll' mode
src/lib/openmrsClient.js    OpenMRS FHIR2 client (read/search ServiceRequest/Patient, write results)
src/lib/advapacsClient.js   Calls OpenHIM's outbound channel (ADVAPACS_CHANNEL_URL), not AdvaPACS directly; upsertPatient + createServiceRequest (+ ensureSubscription, currently unused -- see Known limitations)
src/lib/orderRelay.js       Shared order-relay logic: upserts Patient first, then remaps ServiceRequest.subject to AdvaPACS's own Patient id and reshapes the rest of the ServiceRequest for AdvaPACS before pushing it
src/lib/orderPoller.js      Poll-based ingestion (ORDER_INGESTION_MODE=poll) -- submits via OpenHIM's inbound channel
src/routes/serviceRequest.js       Inbound channel's target; always mounted regardless of ingestion mode
src/routes/subscriptionWebhook.js  PLACEHOLDER result webhook handler -- not yet functional/tested, currently disabled (see Known limitations)
```
