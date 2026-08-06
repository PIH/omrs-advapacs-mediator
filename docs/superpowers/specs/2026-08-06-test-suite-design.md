# Test suite design

## Context

This repo has zero test tooling today (no devDependencies, no test files, no
`test` script). Recent work reshaped several core modules — `orderRelay.js`
now pushes a `Patient` to AdvaPACS before the `ServiceRequest` and references
it via a configurable FHIR identifier instead of an OpenMRS UUID;
`orderPoller.js` submits polled orders through OpenHIM's inbound channel
instead of calling relay logic in-process; `advapacsClient.js` calls
OpenHIM's outbound channel instead of AdvaPACS directly. A real bug slipped
through this work (`src/index.js` never mounted the push route in poll mode)
and was only caught by live testing against Docker/OpenHIM — the goal here is
a fast, mockable unit test suite that would catch this class of regression
without needing live infrastructure.

## Scope

**In scope** — unit tests, all HTTP calls mocked, runnable with no Docker/
OpenHIM/OpenMRS running:

- `src/lib/orderRelay.js`
- `src/lib/advapacsClient.js`
- `src/lib/openmrsClient.js` (included for symmetry with `advapacsClient.js`
  — same thin axios-wrapper shape, already in scope)
- `src/lib/orderPoller.js`
- `src/routes/serviceRequest.js`

**Explicitly out of scope**:

- `src/index.js`'s route-mounting / ingestion-mode-selection logic. This is
  exactly where the recent real bug lived, but the file executes side
  effects at module load (starts an HTTP server, or calls out to OpenHIM
  registration) with no exported seam to call in isolation. Testing it
  properly needs a small refactor first (e.g. extracting `startServer`/mode
  selection into a testable function, guarding the file's bottom-level
  execution with `require.main === module`) — that's a code change beyond
  "add tests," and is flagged here as a follow-up, not built now.
- `src/routes/subscriptionWebhook.js` — pre-existing, untouched by the
  Patient-first-push / OpenHIM-channel-routing work this suite targets.
- Any live integration test against real Docker/OpenHIM/OpenMRS (the
  fast-feedback unit layer this suite provides is deliberately the
  trade-off — user confirmed this scope during brainstorming).

## Tooling

- **Jest** as the only new devDependency besides **supertest** (for
  `routes/serviceRequest.js`'s HTTP-level behavior). No `jest.config.js` —
  Jest's zero-config defaults (test discovery via `**/*.test.js`,
  `testEnvironment: node` as of Jest 27+) are sufficient for a plain
  CommonJS/Node backend project.
- New `test/` directory at the repo root, mirroring `src/`'s structure:
  `test/lib/*.test.js`, `test/routes/*.test.js`. Kept out of the Docker
  build context via `.dockerignore` (devDependencies are already excluded
  from the production image via `npm ci --omit=dev`; this just trims the
  build context too).
- `package.json`: add `"test": "jest"` to `scripts`.
- Each env-dependent module under test (`orderRelay.js` reads
  `PATIENT_IDENTIFIER_SYSTEM` at module load; `advapacsClient.js` reads
  `ADVAPACS_CHANNEL_URL`/`ADVAPACS_CLIENT_ID`/`ADVAPACS_CLIENT_SECRET` at
  module load) gets `jest.resetModules()` + a fresh `require()` per test
  (typically in `beforeEach`), after setting the relevant `process.env`
  vars for that test — avoids a shared/global env setup file and keeps each
  test's config explicit and self-contained.
- Dependencies (`openmrsClient`, `advapacsClient`) are mocked with
  `jest.mock(...)` + per-test `mockResolvedValue`/`mockRejectedValue`, not
  real HTTP calls — these are unit tests, not integration tests.

## Test cases by file

### `test/lib/orderRelay.test.js`

- Full `ServiceRequest` resource as input → used directly, no
  `openmrs.getResource` lookup.
- Minimal `{ serviceRequestId }` input → `openmrs.getResource('ServiceRequest', id)`
  called to resolve the full resource.
- Patient resolved (subject reference present) → `advapacs.createPatient`
  is called **before** `advapacs.createServiceRequest` (assert call order,
  not just that both were called).
- Outbound `ServiceRequest.subject` becomes `{ identifier: { system, value },
  display }` sourced from the patient's identifier matching
  `PATIENT_IDENTIFIER_SYSTEM` — not a `Patient/<uuid>` reference.
- Patient has no identifier matching `PATIENT_IDENTIFIER_SYSTEM` → throws a
  clear error; `advapacs.createServiceRequest` is never called.
- `advapacs.createPatient` rejects → the rejection propagates out of
  `relayServiceRequest`; `advapacs.createServiceRequest` is never called
  (the fail-fast dependency).
- No `subject.reference` on the input `ServiceRequest` (no patient to
  resolve) → `subject` passed through unchanged, `createPatient` not called,
  `createServiceRequest` still called with the original subject.
- Successful relay → resolves with `{ serviceRequest, created }` and logs
  include both OpenMRS and AdvaPACS ids (via a mocked `logger`).

### `test/lib/advapacsClient.test.js`

- `axios.create` is called with `baseURL: ADVAPACS_CHANNEL_URL` and the
  `ID=...,Secret=...` `Authorization` header built from
  `ADVAPACS_CLIENT_ID`/`ADVAPACS_CLIENT_SECRET`.
- `createPatient(patient)` → POSTs to `/Patient` with the patient body,
  returns `response.data`.
- `createServiceRequest(serviceRequest)` → POSTs to `/ServiceRequest`,
  returns `response.data`.
- `ensureSubscription(webhookUrl, secret, criteria)` → POSTs to
  `/Subscription` with a body matching the expected `Subscription` shape
  (`channel.endpoint === webhookUrl`, `channel.header` carries the bearer
  secret, `criteria` passed through, default `criteria` of `'ImagingStudy'`
  when omitted).
- `getResourceByUrl(url)` → GETs the absolute URL (not relative to
  `baseURL`) with the client's headers, returns `response.data`.

### `test/lib/openmrsClient.test.js`

- `getResource(type, id)` → GET `/{type}/{id}`, returns `response.data`.
- `getPatient(id)` → delegates to `getResource('Patient', id)`.
- `createResource(type, resource)` → POST `/{type}`, returns
  `response.data`, logs the created id.
- `updateServiceRequestStatus(id, status)` → fetches the current resource,
  sets `.status`, PUTs the updated resource back.
- `searchServiceRequests({ status, lastUpdatedAfter })` → builds the
  correct query params (`status` only when given; `_lastUpdated=gt<date>`
  only when `lastUpdatedAfter` given; neither param when both omitted).

### `test/lib/orderPoller.test.js`

- `pollOnce()` with a bundle of N entries → `axios.post` called once per
  entry, each to `${OPENHIM_ROUTER_URL}/fhir/ServiceRequest` with that
  entry's resource as the body.
- One entry's POST rejects → the remaining entries are still submitted
  (per-item catch, not a single try/catch around the whole loop).
- `lastPolledAt` cursor: first `pollOnce()` call passes `lastUpdatedAfter:
  null`(no prior cursor); a second call passes the previous call's
  timestamp — verified via the params `openmrs.searchServiceRequests` was
  called with across two sequential `pollOnce()` calls.
- Cursor still advances even when the OpenMRS search itself throws (the
  `finally` block's job) — verified via a third `pollOnce()` call's params
  after a rejected middle call.
- `start(intervalMs)` with fake timers (`jest.useFakeTimers()`): calls
  `setInterval` with the given interval; calling `start()` again while
  already running does not create a second timer (existing `if (timer)
  return` guard).
- `stop()` clears the timer.

### `test/routes/serviceRequest.test.js`

- Minimal Express app mounting only this router, driven with `supertest`.
- `orderRelay.relayServiceRequest` mocked.
- Successful relay → `POST /fhir/ServiceRequest` responds `200` with
  `{ status: 'ok', advapacsServiceRequestId }`.
- Relay rejects → responds `502` with `{ status: 'error', message }`
  carrying the rejection's message.

## Documentation

Add a "Running tests" section to `README.md` (after the existing "Running
..." sections): `npm install` then `npm test`, one sentence noting these are
unit tests with all HTTP calls mocked — no Docker/OpenHIM/OpenMRS needs to be
running.

## Verification

`npm test` passes locally with no other services running (proves the mocking
is real, not accidentally hitting live infra). Spot-check that deleting the
`src/index.js` route-mount line (the actual historical bug) does **not**
cause any of these new tests to fail — confirms the documented out-of-scope
gap is real and not accidentally covered, so nobody mistakes this suite for
covering more than it does.
