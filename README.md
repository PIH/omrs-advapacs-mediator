# OpenMRS-AdvaPACS FHIR mediator (scaffold)

An OpenHIM mediator that sits between OpenMRS and AdvaPACS and moves radiology
orders and results between them as FHIR resources.

## Flow

1. An order is created in OpenMRS (`ServiceRequest`).
2. That order reaches this mediator one of two ways, controlled by
   `ORDER_INGESTION_MODE` (see `.env.example`):
   - **`push`**: something on the OpenMRS side POSTs it (or its id)
     to `POST /fhir/ServiceRequest` on this mediator (`src/routes/serviceRequest.js`),
     via OpenHIM's "OpenMRS to Mediator Order Push" inbound channel.
   - **`poll`** (default): `src/lib/orderPoller.js` periodically searches OpenMRS's FHIR
     `ServiceRequest` endpoint for anything new since the last poll, then POSTs
     each one to that same OpenHIM inbound channel.
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
- **The outbound AdvaPACS channel is `authType: "public"` — deliberately, not
  an oversight.** The inbound channel (OpenMRS/poller → mediator) has real
  OpenHIM Client auth (`authType: "private"`, an `openmrs` Client created by
  `scripts/setupOpenhim.js`, `orderPoller.js` authenticating via Basic auth —
  plus an independent app-level `X-Mediator-Secret` check in
  `src/lib/sharedSecretAuth.js` as a backstop against direct access). The
  outbound channel can't get the same treatment: confirmed directly in
  `openhim-core-js`'s source, every non-mTLS OpenHIM client-auth mechanism
  (Basic, Custom Token, JWT) rides on the same `Authorization` header that
  this channel's `forwardAuthHeader: true` already reserves for passing
  AdvaPACS's own `Authorization: ID=...,Secret=...` credentials through
  unchanged — adding OpenHIM auth here would either break that pass-through or
  never authenticate at all. Mutual TLS is the only OpenHIM-native way around
  that conflict, but stands up real cert issuance/rotation for a channel whose
  only caller is the mediator container itself on a private Docker network —
  disproportionate here. The actual compensating control is network isolation
  instead: `docker-compose.yml` binds OpenHIM's router/admin API/console ports
  to `127.0.0.1` only (see below), so nothing outside this Docker stack can
  reach this channel regardless of its `authType`. This holds even on a host
  shared with other apps — a compromised *container* elsewhere doesn't grant
  access to our loopback-bound ports or our `openhim` Docker network on its
  own (each `docker compose` project gets its own isolated bridge network by
  default). Revisit this reasoning only if this host's trust model changes —
  e.g. it becomes genuinely multi-tenant with untrusted operators, or any
  co-located app runs with `network_mode: host` or gets explicitly connected
  to this stack's `openhim` network. A PIH-controlled shared host running
  other PIH apps under normal Docker Compose isolation doesn't change this
  calculus.

## Step you still need to do on the OpenMRS side

OpenMRS doesn't push events anywhere on its own. Pick one, set via
`ORDER_INGESTION_MODE`:

- **`push`** (needs an OpenMRS-side change): build an event listener module
  using OpenMRS's event/AOP hooks to POST newly created `ServiceRequest`s to
  OpenHIM's inbound channel. Nothing on the mediator side needs to change to
  support this — `POST /fhir/ServiceRequest` is already mounted and its auth
  is already mode-agnostic (it's the same endpoint `orderPoller.js` posts to
  for `poll` mode). The exact contract, so a module can be built against this
  without reading the mediator's source:

  - **Request**: `POST /fhir/ServiceRequest` on OpenHIM's router (see port/
    scheme note below), `Content-Type: application/fhir+json`. Body is either
    a full `ServiceRequest` FHIR resource, or the minimal
    `{ "serviceRequestId": "<uuid>" }` form (`src/lib/orderRelay.js` fetches
    the full resource from OpenMRS itself in that case).
  - **Required headers** (that channel is `authType: "private"`, and the
    mediator's own route checks a second, independent secret):
    - `Authorization: Basic base64(OPENHIM_INBOUND_CLIENT_ID:OPENHIM_INBOUND_CLIENT_PASSWORD)`
      — OpenHIM Client credentials, from `.env`.
    - `X-Mediator-Secret: <MEDIATOR_INBOUND_SECRET>` — app-level backstop
      independent of OpenHIM, also from `.env`.
    - Both are the same values `orderPoller.js` already uses for the `poll`
      path — see `src/lib/orderPoller.js`'s `pollOnce()` for a working
      reference implementation of this exact contract.
  - **Responses**: `200 { status: 'ok', advapacsServiceRequestId }` on
    success; `401 { status: 'error', message: 'unauthorized' }` if either
    header is missing/wrong; `502 { status: 'error', message }` if the relay
    to AdvaPACS itself fails (e.g. patient resolution, AdvaPACS validation).
  - **Port/scheme**: if OpenMRS and this mediator stack are on the same
    Docker network (or otherwise mutually trusted), plain HTTP on port `5001`
    is fine. If OpenMRS is on a different, less-trusted host, use HTTPS on
    port `5000` instead — `5001` is plain HTTP and would send the credentials
    above in cleartext across that network. See the Docker Compose section
    below for what changes on this side to support that.
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
the two order-push channels and the `openmrs` OpenHIM Client the inbound
channel's `authType: "private"` requires (channels/clients aren't auto-created
from mediator registration — that only happens if you explicitly run this
script or import `mediatorConfig.json`'s `defaultChannelConfig` by hand).

All four host-published ports above (`8081`, `9000`, `5000`, `5001`) are bound
to `127.0.0.1` only, not `0.0.0.0` — reachable from this host (or an SSH
tunnel) for debugging/console access, not from the LAN or internet. Nothing
outside this Docker stack needs them in `poll` mode: both `orderPoller.js` and
`advapacsClient.js` already reach OpenHIM over the internal `openhim` network.
If `push` mode is used with OpenMRS on a different host, port `5000` (HTTPS —
not `5001`, see below) should be the one re-published on a real interface,
scoped/firewalled to that specific host. Keep `5001` loopback-only even then.

**Router traffic (`5001`) is plain HTTP, not HTTPS** — deliberately, not an
oversight. This means the Basic Auth credentials `orderPoller.js` sends to the
inbound channel travel as cleartext-equivalent base64, not encrypted. Accepted
as-is since this traffic never leaves the Docker network or a loopback-bound
host port (see above) — only the admin API (`8081`) uses HTTPS today. OpenHIM
core's router also listens on `5000` for HTTPS by default (same self-signed
cert as the admin API, currently unused) — use that instead of `5001` the
moment real router traffic (e.g. a `push`-mode OpenMRS module) crosses a
network segment broader than this Docker stack's own.

- `OPENMRS_BASE_URL` is read from `.env` here, same as elsewhere in the app —
  it's not hardcoded to any particular OpenMRS location. If OpenMRS runs on
  this same host, set it to `http://host.docker.internal:8080/openmrs`, not
  `localhost` (inside the mediator's container, `localhost` means the
  container itself). `host.docker.internal` is wired up via `extra_hosts` in
  `docker-compose.yml` — Linux needs Docker Engine 20.10+ for the
  `host-gateway` special value. If OpenMRS runs elsewhere, just point
  `OPENMRS_BASE_URL` at its real address instead.
- **First run on a fresh Mongo volume**: OpenHIM core auto-seeds a
  `root@openhim.org` user with its built-in default password
  `openhim-password`, regardless of whatever's set in `.env`'s
  `OPENHIM_PASSWORD`. `scripts/setupOpenhim.js` self-heals this automatically —
  it tries `.env`'s credentials first, and if those don't work yet, falls back
  to the known default, then rotates the account's password to match `.env`.
  No manual console step needed.
- This is a separate, self-contained compose stack from any other
  standalone OpenHIM instance you may have running elsewhere — it uses the
  same container names/ports (`8081`, `9000`, `5000`-`5001`), so stop any
  other instance first.

## Administering the server

Once this is running somewhere other than your own laptop (e.g. a CI server),
here's how to operate it day to day.

**Status**: `docker compose ps`. Only `openhim-core` and `openhim-console`
have a Docker `healthcheck:`, so those two show `(healthy)`/`(unhealthy)`;
`openmrs-advapacs-mediator` and `mongo-db` will only ever show the plain
container state (`running`, `exited`, ...) — don't wait for a "healthy"
mediator, it doesn't report one.

**Stopping — three different levels, not interchangeable**:
- `docker compose stop` — stops all containers, keeps them and all data
  intact. `docker compose start` resumes exactly where it left off.
- `docker compose down` — removes the containers and network, but keeps the
  `mongo-data` volume, so OpenHIM's registered channels/clients and its
  transaction history survive a `docker compose up -d` afterward.
- `docker compose down -v` — also deletes the `mongo-data` volume.
  **Destructive** — resets OpenHIM back to a completely fresh, unregistered
  state (this is how the admin-password self-heal behavior above was tested).
  Only do this deliberately.

**Picking up a code change**: a plain restart reuses the old image — you need
to rebuild first:
```bash
docker compose build openmrs-advapacs-mediator
docker compose up -d --force-recreate openmrs-advapacs-mediator
```

**Picking up a config change** (edited `mediatorConfig.json`, or changed an
env var that affects channel/client setup, e.g. `ADVAPACS_BASE_URL` or
`OPENHIM_INBOUND_CLIENT_*`): rerun the one-shot setup script —
```bash
docker compose run --rm openhim-setup
```
It idempotently upserts channels/clients and self-heals the admin password
(see above) — safe to run any time, not just after a fresh volume.

**Container logs** (each service's stdout/stderr — startup messages, this
app's own request handling, etc.):
```bash
docker compose logs -f openmrs-advapacs-mediator   # follow one service
docker compose logs --tail=50 openhim-core          # last 50 lines of another
docker compose logs                                 # everything
```
The five services are `mongo-db`, `openhim-core`, `openhim-console`,
`openmrs-advapacs-mediator`, and the one-shot `openhim-setup` (which has no
fixed `container_name`, so `docker compose ps`/`logs` refer to it by a
compose-generated name like `omrs-advapacs-mediator-openhim-setup-1`). The
mediator's own lines are winston JSON (`{"level":...,"message":...,"timestamp":...}`),
verbosity controlled by `.env`'s `LOG_LEVEL`.

**OpenHIM's transaction log — a different thing from container logs.** This
is the actual FHIR request/response history for every push through the two
channels (what's been used all through this project's development to debug
real order-push/AdvaPACS traffic) — persisted in Mongo, not visible via
`docker compose logs` at all. Two ways to see it:
- Console UI: `http://127.0.0.1:9000`, log in with `.env`'s
  `OPENHIM_USERNAME`/`OPENHIM_PASSWORD`.
- Admin API directly:
  ```bash
  curl -k -u "$OPENHIM_USERNAME:$OPENHIM_PASSWORD" \
    'https://127.0.0.1:8081/transactions?filterLimit=10&filterPage=0'   # list
  curl -k -u "$OPENHIM_USERNAME:$OPENHIM_PASSWORD" \
    'https://127.0.0.1:8081/transactions/<id>'                          # one transaction's full bodies
  ```
  (`-k` skips certificate validation for OpenHIM's self-signed cert — the same
  thing `OPENHIM_TRUST_SELF_SIGNED=true` does for the app itself.)

**Reaching any of this on a remote server**: every admin-facing port (`8081`,
`9000`, `5000`, `5001`) is deliberately bound to `127.0.0.1` only (see above),
so none of it is reachable directly from your own machine once this runs
somewhere other than localhost. Use an SSH tunnel instead:
```bash
ssh -L 8081:127.0.0.1:8081 -L 9000:127.0.0.1:9000 <user>@<server>
```
then browse/curl `127.0.0.1:8081` and `127.0.0.1:9000` on your own machine
exactly as if you were on the server itself.

## Running locally without OpenHIM core

```bash
cp .env.example .env      # fill in real credentials, set MEDIATOR_STANDALONE=true
npm install
npm start
```

Skips OpenHIM entirely. In `poll` mode this means `orderPoller.js`'s POST to
`OPENHIM_ROUTER_URL` will fail (nothing listening) — useful for exercising the
OpenMRS-polling side in isolation, not the full relay.

Since this runs directly on the host (not in a container), `OPENMRS_BASE_URL`
needs a value reachable from the host itself — `http://localhost:8080/openmrs`
if OpenMRS is local, not `http://host.docker.internal:...` (that hostname only
resolves inside a Docker container). If you're switching between this and the
Docker Compose flow above with OpenMRS on the same machine, you'll need to
change this value each time.

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
scripts/setupOpenhim.js     Idempotently creates/updates the two order-push channels + the "openmrs" OpenHIM Client via OpenHIM's API; self-heals a fresh volume's default admin password to match .env
Dockerfile                  Mediator's own container image
docker-compose.yml          Full local stack: mongo, openhim-core, openhim-console, mediator, one-shot channel setup
src/index.js                Registration + server bootstrap; always mounts the push endpoint, additionally starts the poller in 'poll' mode
src/lib/openmrsClient.js    OpenMRS FHIR2 client (read/search ServiceRequest/Patient, write results)
src/lib/advapacsClient.js   Calls OpenHIM's outbound channel (ADVAPACS_CHANNEL_URL), not AdvaPACS directly; upsertPatient + createServiceRequest (+ ensureSubscription, currently unused -- see Known limitations)
src/lib/orderRelay.js       Shared order-relay logic: upserts Patient first, then remaps ServiceRequest.subject to AdvaPACS's own Patient id and reshapes the rest of the ServiceRequest for AdvaPACS before pushing it
src/lib/orderPoller.js      Poll-based ingestion (ORDER_INGESTION_MODE=poll) -- submits via OpenHIM's inbound channel
src/lib/sharedSecretAuth.js Shared-secret Express middleware factory (crypto.timingSafeEqual compare) -- backs the inbound X-Mediator-Secret check
src/routes/serviceRequest.js       Inbound channel's target; always mounted regardless of ingestion mode; requires X-Mediator-Secret
src/routes/subscriptionWebhook.js  PLACEHOLDER result webhook handler -- not yet functional/tested, currently disabled (see Known limitations)
```
