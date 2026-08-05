# OpenMRS-AdvaPACS FHIR mediator (scaffold)

An OpenHIM mediator that sits between OpenMRS and AdvaPACS and moves radiology
orders and results between them as FHIR resources.

## Flow

1. An order is created in OpenMRS (`ServiceRequest`).
2. That order reaches this mediator one of two ways, controlled by
   `ORDER_INGESTION_MODE` (see `.env.example`):
   - **`push`** (default): something on the OpenMRS side POSTs it (or its id)
     to `POST /fhir/ServiceRequest` on this mediator (`src/routes/serviceRequest.js`).
   - **`poll`**: `src/lib/orderPoller.js` periodically searches OpenMRS's FHIR
     `ServiceRequest` endpoint for anything new since the last poll.

   Either way, both hand off to `src/lib/orderRelay.js`, which resolves the
   patient, remaps references, and pushes the resource to AdvaPACS via
   `POST /ServiceRequest` on AdvaPACS's FHIR API.
3. AdvaPACS performs/reads the study, then fires its own FHIR `Subscription`
   (rest-hook) at `POST /webhooks/advapacs` on this mediator, carrying an
   `ImagingStudy` or `DiagnosticReport`.
4. `src/routes/subscriptionWebhook.js` writes that resource into OpenMRS and
   flips the originating `ServiceRequest` to `completed`.

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

## Step you still need to do on the OpenMRS side

OpenMRS doesn't push events anywhere on its own. Pick one, set via
`ORDER_INGESTION_MODE`:

- **`push`** (needs an OpenMRS-side change): build an event listener module
  using OpenMRS's event/AOP hooks to POST newly created `ServiceRequest`s to
  this mediator's `/fhir/ServiceRequest`.
- **`poll`** (needs no OpenMRS-side change): `src/lib/orderPoller.js` already
  implements this — it calls
  `GET {OPENMRS_BASE_URL}/ws/fhir2/R4/ServiceRequest?status=active&_lastUpdated=gt...`
  on an interval (`ORDER_POLL_INTERVAL_MS`) and relays anything new. Simpler
  to stand up and works today, at the cost of up-to-`ORDER_POLL_INTERVAL_MS`
  latency and missing anything created while the mediator was down (the
  poll cursor resets to "now" on restart, it isn't persisted).

## Running locally without OpenHIM core

```bash
cp .env.example .env      # fill in real credentials
npm install
MEDIATOR_STANDALONE=true npm start
```

## Running registered with OpenHIM core

```bash
cp .env.example .env      # set OPENHIM_* vars to point at your instance
npm install
npm start
```

On startup the mediator registers itself and `mediatorConfig.json` with
OpenHIM core, activates its heartbeat, and attempts to register a FHIR
`Subscription` with AdvaPACS pointed at its own webhook URL.

## Files

```
mediatorConfig.json         OpenHIM mediator registration (channels, config defs)
src/index.js                Registration + server bootstrap, picks push vs. poll ingestion
src/lib/openmrsClient.js    OpenMRS FHIR2 client (read/search ServiceRequest/Patient, write results)
src/lib/advapacsClient.js   AdvaPACS FHIR client (push orders, manage Subscription)
src/lib/orderRelay.js       Shared order-relay logic used by both ingestion modes
src/lib/orderPoller.js      Poll-based ingestion (ORDER_INGESTION_MODE=poll)
src/routes/serviceRequest.js       Push-based ingestion (ORDER_INGESTION_MODE=push)
src/routes/subscriptionWebhook.js  Result webhook handler
```
