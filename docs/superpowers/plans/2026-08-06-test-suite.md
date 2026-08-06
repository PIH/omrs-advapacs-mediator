# Test Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Jest-based unit test suite (all HTTP calls mocked, no live infra needed) covering `orderRelay.js`, `advapacsClient.js`, `openmrsClient.js`, `orderPoller.js`, and `routes/serviceRequest.js`, plus a README section documenting how to run it.

**Architecture:** `test/` at the repo root, mirroring `src/`'s structure (`test/lib/*.test.js`, `test/routes/*.test.js`). Each test file mocks its module's HTTP-facing dependencies (`axios`, sibling client modules, `logger`) with `jest.mock`, and re-`require`s its subject module fresh per test via `jest.resetModules()` so module-load-time `process.env` reads are picked up correctly per test case.

**Tech Stack:** Jest (test runner + assertions + mocking), supertest (HTTP-level testing of the Express route in `routes/serviceRequest.js`). No other devDependencies, no `jest.config.js`.

**Note on task shape:** This plan adds tests to already-working production code, not new features built test-first. So "steps" below read as "write the test, run the suite, confirm it passes" rather than red-green-refactor — there is no new production code to implement in these tasks; a failure would mean either a test bug or (interesting!) a real bug in existing code worth investigating before moving on.

## Global Constraints

- Jest and supertest are the only two new devDependencies — nothing else.
- No `jest.config.js` — Jest's zero-config defaults (test discovery via `**/*.test.js`, `testEnvironment: node` as of Jest 27+) are sufficient.
- New tests live under `test/`, mirroring `src/`'s directory structure exactly.
- `src/index.js` and `src/routes/subscriptionWebhook.js` are explicitly OUT OF SCOPE — do not add tests for them in this plan (see the spec's Context/Scope sections for why: `index.js` has no testable seam without a refactor that's out of scope here).
- No live Docker/OpenHIM/OpenMRS integration tests — every test in this plan mocks its HTTP-facing dependencies.
- Every env-dependent module under test (`orderRelay.js` reads `PATIENT_IDENTIFIER_SYSTEM`; `advapacsClient.js` reads `ADVAPACS_CHANNEL_URL`/`ADVAPACS_CLIENT_ID`/`ADVAPACS_CLIENT_SECRET`; `openmrsClient.js` reads `OPENMRS_BASE_URL`/`OPENMRS_FHIR_PATH`/`OPENMRS_USERNAME`/`OPENMRS_PASSWORD`; `orderPoller.js` reads `OPENHIM_ROUTER_URL`) — these are all read at module-load time, so every test file sets `process.env` values then calls `jest.resetModules()` and a fresh `require()` in `beforeEach`, never relying on a previous test's module cache.

---

### Task 1: Test tooling + `advapacsClient.js` tests

**Files:**
- Modify: `package.json` (add `devDependencies`, add `"test": "jest"` script)
- Modify: `.dockerignore` (add `test`)
- Test: `test/lib/advapacsClient.test.js`

**Interfaces:**
- Consumes: `src/lib/advapacsClient.js`'s exports — `createServiceRequest(serviceRequest)`, `createPatient(patient)`, `getResourceByUrl(url)`, `ensureSubscription(webhookUrl, webhookSecret, criteria = 'ImagingStudy')`, all `async`, all returning the AdvaPACS response body (`response.data`).
- Produces: working `npm test` command (Jest + supertest installed) — every later task in this plan depends on this.

- [ ] **Step 1: Add devDependencies and the test script to `package.json`**

Edit `package.json` so it reads exactly:

```json
{
  "name": "omrs-openhim-advapacs",
  "version": "0.1.0",
  "description": "OpenHIM mediator routing radiology ServiceRequests between OpenMRS and AdvaPACS as FHIR resources.",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "test": "jest"
  },
  "dependencies": {
    "axios": "^1.7.7",
    "dotenv": "^16.4.5",
    "express": "^4.21.1",
    "openhim-mediator-utils": "^1.0.0",
    "winston": "^3.14.2"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "supertest": "^7.0.0"
  }
}
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: installs `jest` and `supertest` into `node_modules`, updates `package-lock.json`.

- [ ] **Step 3: Add `test` to `.dockerignore`**

`.dockerignore` should read:

```
node_modules
.env
.git
.idea
test
```

- [ ] **Step 4: Write `test/lib/advapacsClient.test.js`**

```javascript
jest.mock('axios');
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const axios = require('axios');

describe('advapacsClient', () => {
  let mockClient;
  let advapacs;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    process.env.ADVAPACS_CHANNEL_URL = 'http://openhim-core:5001/advapacs';
    process.env.ADVAPACS_CLIENT_ID = 'test-client-id';
    process.env.ADVAPACS_CLIENT_SECRET = 'test-secret';

    mockClient = {
      post: jest.fn(),
      defaults: {
        headers: {
          'Content-Type': 'application/fhir+json',
          Authorization: 'ID=test-client-id,Secret=test-secret'
        }
      }
    };
    axios.create.mockReturnValue(mockClient);

    advapacs = require('../../src/lib/advapacsClient');
  });

  test('creates the axios client with ADVAPACS_CHANNEL_URL as baseURL and an ID/Secret Authorization header', () => {
    expect(axios.create).toHaveBeenCalledWith({
      baseURL: 'http://openhim-core:5001/advapacs',
      headers: {
        'Content-Type': 'application/fhir+json',
        Authorization: 'ID=test-client-id,Secret=test-secret'
      }
    });
  });

  test('createPatient posts the patient to /Patient and returns response data', async () => {
    const patient = { resourceType: 'Patient', id: 'p1' };
    mockClient.post.mockResolvedValue({ data: { resourceType: 'Patient', id: 'advapacs-p1' } });

    const result = await advapacs.createPatient(patient);

    expect(mockClient.post).toHaveBeenCalledWith('/Patient', patient);
    expect(result).toEqual({ resourceType: 'Patient', id: 'advapacs-p1' });
  });

  test('createServiceRequest posts the ServiceRequest to /ServiceRequest and returns response data', async () => {
    const serviceRequest = { resourceType: 'ServiceRequest', id: 'sr1' };
    mockClient.post.mockResolvedValue({ data: { resourceType: 'ServiceRequest', id: 'advapacs-sr1' } });

    const result = await advapacs.createServiceRequest(serviceRequest);

    expect(mockClient.post).toHaveBeenCalledWith('/ServiceRequest', serviceRequest);
    expect(result).toEqual({ resourceType: 'ServiceRequest', id: 'advapacs-sr1' });
  });

  test('ensureSubscription posts a Subscription with the webhook endpoint and bearer secret', async () => {
    mockClient.post.mockResolvedValue({ data: { resourceType: 'Subscription', id: 'sub1' } });

    const result = await advapacs.ensureSubscription('http://mediator/webhooks/advapacs', 'shh-secret', 'ImagingStudy');

    expect(mockClient.post).toHaveBeenCalledWith('/Subscription', {
      resourceType: 'Subscription',
      status: 'active',
      reason: 'openmrs-advapacs-mediator result delivery',
      criteria: 'ImagingStudy',
      channel: {
        type: 'rest-hook',
        endpoint: 'http://mediator/webhooks/advapacs',
        payload: 'application/fhir+json',
        header: ['Authorization: Bearer shh-secret']
      }
    });
    expect(result).toEqual({ resourceType: 'Subscription', id: 'sub1' });
  });

  test('ensureSubscription defaults criteria to ImagingStudy when not given', async () => {
    mockClient.post.mockResolvedValue({ data: { id: 'sub1' } });

    await advapacs.ensureSubscription('http://mediator/webhooks/advapacs', 'shh-secret');

    expect(mockClient.post).toHaveBeenCalledWith('/Subscription', expect.objectContaining({ criteria: 'ImagingStudy' }));
  });

  test('getResourceByUrl GETs the given absolute URL with the client headers', async () => {
    axios.get.mockResolvedValue({ data: { resourceType: 'ImagingStudy', id: 'img1' } });

    const result = await advapacs.getResourceByUrl('https://advapacs.example.com/fhir/ImagingStudy/img1');

    expect(axios.get).toHaveBeenCalledWith(
      'https://advapacs.example.com/fhir/ImagingStudy/img1',
      { headers: mockClient.defaults.headers }
    );
    expect(result).toEqual({ resourceType: 'ImagingStudy', id: 'img1' });
  });
});
```

- [ ] **Step 5: Run the test file**

Run: `npx jest test/lib/advapacsClient.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .dockerignore test/lib/advapacsClient.test.js
git commit -m "test: add advapacsClient unit tests, wire up Jest + supertest"
```

---

### Task 2: `openmrsClient.js` tests

**Files:**
- Test: `test/lib/openmrsClient.test.js`

**Interfaces:**
- Consumes: `src/lib/openmrsClient.js`'s exports — `getResource(resourceType, id)`, `getPatient(patientId)`, `createResource(resourceType, resource)`, `updateServiceRequestStatus(serviceRequestId, status)`, `searchServiceRequests({ status, lastUpdatedAfter } = {})`, all `async`.
- Produces: nothing later tasks directly consume (independent test file); relies on Task 1's Jest/supertest install.

- [ ] **Step 1: Write `test/lib/openmrsClient.test.js`**

```javascript
jest.mock('axios');
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const axios = require('axios');

describe('openmrsClient', () => {
  let mockClient;
  let openmrs;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    process.env.OPENMRS_BASE_URL = 'http://localhost:8080/openmrs';
    process.env.OPENMRS_FHIR_PATH = '/ws/fhir2/R4';
    process.env.OPENMRS_USERNAME = 'admin';
    process.env.OPENMRS_PASSWORD = 'Admin123';

    mockClient = { get: jest.fn(), post: jest.fn(), put: jest.fn() };
    axios.create.mockReturnValue(mockClient);

    openmrs = require('../../src/lib/openmrsClient');
  });

  test('creates the axios client with OPENMRS_BASE_URL + OPENMRS_FHIR_PATH as baseURL and basic auth', () => {
    expect(axios.create).toHaveBeenCalledWith({
      baseURL: 'http://localhost:8080/openmrs/ws/fhir2/R4',
      auth: { username: 'admin', password: 'Admin123' },
      headers: { 'Content-Type': 'application/fhir+json' }
    });
  });

  test('getResource GETs /{resourceType}/{id} and returns response data', async () => {
    mockClient.get.mockResolvedValue({ data: { resourceType: 'ServiceRequest', id: 'sr1' } });

    const result = await openmrs.getResource('ServiceRequest', 'sr1');

    expect(mockClient.get).toHaveBeenCalledWith('/ServiceRequest/sr1');
    expect(result).toEqual({ resourceType: 'ServiceRequest', id: 'sr1' });
  });

  test('getPatient delegates to getResource with resourceType Patient', async () => {
    mockClient.get.mockResolvedValue({ data: { resourceType: 'Patient', id: 'p1' } });

    const result = await openmrs.getPatient('p1');

    expect(mockClient.get).toHaveBeenCalledWith('/Patient/p1');
    expect(result).toEqual({ resourceType: 'Patient', id: 'p1' });
  });

  test('createResource POSTs /{resourceType} and returns response data', async () => {
    const resource = { resourceType: 'ImagingStudy' };
    mockClient.post.mockResolvedValue({ data: { resourceType: 'ImagingStudy', id: 'img1' } });

    const result = await openmrs.createResource('ImagingStudy', resource);

    expect(mockClient.post).toHaveBeenCalledWith('/ImagingStudy', resource);
    expect(result).toEqual({ resourceType: 'ImagingStudy', id: 'img1' });
  });

  test('updateServiceRequestStatus fetches the current resource, sets status, and PUTs it back', async () => {
    mockClient.get.mockResolvedValue({ data: { resourceType: 'ServiceRequest', id: 'sr1', status: 'active' } });
    mockClient.put.mockResolvedValue({ data: { resourceType: 'ServiceRequest', id: 'sr1', status: 'completed' } });

    const result = await openmrs.updateServiceRequestStatus('sr1', 'completed');

    expect(mockClient.get).toHaveBeenCalledWith('/ServiceRequest/sr1');
    expect(mockClient.put).toHaveBeenCalledWith('/ServiceRequest/sr1', {
      resourceType: 'ServiceRequest', id: 'sr1', status: 'completed'
    });
    expect(result).toEqual({ resourceType: 'ServiceRequest', id: 'sr1', status: 'completed' });
  });

  test('searchServiceRequests builds _lastUpdated param when lastUpdatedAfter given', async () => {
    mockClient.get.mockResolvedValue({ data: { resourceType: 'Bundle', entry: [] } });

    await openmrs.searchServiceRequests({ lastUpdatedAfter: '2026-08-05T00:00:00.000Z' });

    expect(mockClient.get).toHaveBeenCalledWith('/ServiceRequest', {
      params: { _lastUpdated: 'gt2026-08-05T00:00:00.000Z' }
    });
  });

  test('searchServiceRequests builds status param when given', async () => {
    mockClient.get.mockResolvedValue({ data: { resourceType: 'Bundle', entry: [] } });

    await openmrs.searchServiceRequests({ status: 'active' });

    expect(mockClient.get).toHaveBeenCalledWith('/ServiceRequest', { params: { status: 'active' } });
  });

  test('searchServiceRequests builds no params when neither status nor lastUpdatedAfter given', async () => {
    mockClient.get.mockResolvedValue({ data: { resourceType: 'Bundle', entry: [] } });

    await openmrs.searchServiceRequests();

    expect(mockClient.get).toHaveBeenCalledWith('/ServiceRequest', { params: {} });
  });
});
```

- [ ] **Step 2: Run the test file**

Run: `npx jest test/lib/openmrsClient.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 3: Commit**

```bash
git add test/lib/openmrsClient.test.js
git commit -m "test: add openmrsClient unit tests"
```

---

### Task 3: `orderRelay.js` tests

**Files:**
- Test: `test/lib/orderRelay.test.js`

**Interfaces:**
- Consumes: `src/lib/orderRelay.js`'s export — `relayServiceRequest(input)` (async, `input` is either a full `ServiceRequest` resource or `{ serviceRequestId }`), and (as mocked dependencies) `src/lib/openmrsClient.js`'s `getResource`/`getPatient`, `src/lib/advapacsClient.js`'s `createPatient`/`createServiceRequest`.
- Produces: nothing later tasks directly consume; relies on Task 1's Jest install.

- [ ] **Step 1: Write `test/lib/orderRelay.test.js`**

```javascript
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/lib/openmrsClient');
jest.mock('../../src/lib/advapacsClient');

describe('orderRelay', () => {
  let openmrs;
  let advapacs;
  let orderRelay;

  const patientWithEmrId = {
    resourceType: 'Patient',
    id: 'omrs-patient-uuid',
    name: [{ given: ['Bob'], family: 'Dylan' }],
    identifier: [
      { system: 'http://www.pih.org/identifiers/lesotho/emr-id', value: 'CAAKH7' }
    ]
  };

  const serviceRequestWithSubject = {
    resourceType: 'ServiceRequest',
    id: 'sr1',
    subject: { reference: 'Patient/omrs-patient-uuid' }
  };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    process.env.PATIENT_IDENTIFIER_SYSTEM = 'http://www.pih.org/identifiers/lesotho/emr-id';

    openmrs = require('../../src/lib/openmrsClient');
    advapacs = require('../../src/lib/advapacsClient');
    orderRelay = require('../../src/lib/orderRelay');
  });

  test('uses the input directly when it is already a full ServiceRequest', async () => {
    openmrs.getPatient.mockResolvedValue(patientWithEmrId);
    advapacs.createPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
    advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

    await orderRelay.relayServiceRequest(serviceRequestWithSubject);

    expect(openmrs.getResource).not.toHaveBeenCalled();
  });

  test('resolves the full ServiceRequest when given only a serviceRequestId', async () => {
    openmrs.getResource.mockResolvedValue(serviceRequestWithSubject);
    openmrs.getPatient.mockResolvedValue(patientWithEmrId);
    advapacs.createPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
    advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

    await orderRelay.relayServiceRequest({ serviceRequestId: 'sr1' });

    expect(openmrs.getResource).toHaveBeenCalledWith('ServiceRequest', 'sr1');
  });

  test('pushes the Patient to AdvaPACS before the ServiceRequest', async () => {
    openmrs.getPatient.mockResolvedValue(patientWithEmrId);
    const callOrder = [];
    advapacs.createPatient.mockImplementation(async () => {
      callOrder.push('patient');
      return { id: 'advapacs-patient-1' };
    });
    advapacs.createServiceRequest.mockImplementation(async () => {
      callOrder.push('serviceRequest');
      return { id: 'advapacs-sr-1' };
    });

    await orderRelay.relayServiceRequest(serviceRequestWithSubject);

    expect(callOrder).toEqual(['patient', 'serviceRequest']);
  });

  test('references the patient on the outbound ServiceRequest by the EMR-ID identifier, not the OpenMRS UUID', async () => {
    openmrs.getPatient.mockResolvedValue(patientWithEmrId);
    advapacs.createPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
    advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

    await orderRelay.relayServiceRequest(serviceRequestWithSubject);

    expect(advapacs.createServiceRequest).toHaveBeenCalledWith(expect.objectContaining({
      subject: {
        identifier: { system: 'http://www.pih.org/identifiers/lesotho/emr-id', value: 'CAAKH7' },
        display: 'Bob Dylan'
      }
    }));
  });

  test('throws when the patient has no identifier matching PATIENT_IDENTIFIER_SYSTEM, and never sends the ServiceRequest', async () => {
    openmrs.getPatient.mockResolvedValue({ ...patientWithEmrId, identifier: [] });
    advapacs.createPatient.mockResolvedValue({ id: 'advapacs-patient-1' });

    await expect(orderRelay.relayServiceRequest(serviceRequestWithSubject))
      .rejects.toThrow('Patient omrs-patient-uuid has no identifier for system http://www.pih.org/identifiers/lesotho/emr-id');

    expect(advapacs.createServiceRequest).not.toHaveBeenCalled();
  });

  test('when createPatient rejects, the error propagates and createServiceRequest is never called', async () => {
    openmrs.getPatient.mockResolvedValue(patientWithEmrId);
    advapacs.createPatient.mockRejectedValue(new Error('AdvaPACS unreachable'));

    await expect(orderRelay.relayServiceRequest(serviceRequestWithSubject)).rejects.toThrow('AdvaPACS unreachable');

    expect(advapacs.createServiceRequest).not.toHaveBeenCalled();
  });

  test('when the ServiceRequest has no subject reference, subject passes through unchanged and no Patient is pushed', async () => {
    const noSubjectServiceRequest = { resourceType: 'ServiceRequest', id: 'sr2' };
    advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-2' });

    await orderRelay.relayServiceRequest(noSubjectServiceRequest);

    expect(openmrs.getPatient).not.toHaveBeenCalled();
    expect(advapacs.createPatient).not.toHaveBeenCalled();

    const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
    expect(outboundArg.subject).toBeUndefined();
  });

  test('resolves with the serviceRequest and the AdvaPACS-created resource', async () => {
    openmrs.getPatient.mockResolvedValue(patientWithEmrId);
    advapacs.createPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
    advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

    const result = await orderRelay.relayServiceRequest(serviceRequestWithSubject);

    expect(result).toEqual({
      serviceRequest: serviceRequestWithSubject,
      created: { id: 'advapacs-sr-1' }
    });
  });
});
```

- [ ] **Step 2: Run the test file**

Run: `npx jest test/lib/orderRelay.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 3: Verify the out-of-scope gap is real**

Temporarily comment out the line `app.use('/', serviceRequestRoute);` in `src/index.js`, then run the *full* suite: `npm test`. Expected: still all PASS — confirms this test suite does not cover `index.js`'s route-mounting logic (the historical bug lived there and would NOT be caught here). Revert the comment-out afterward (`git checkout -- src/index.js` or undo the edit) — do not leave `src/index.js` broken.

- [ ] **Step 4: Commit**

```bash
git add test/lib/orderRelay.test.js
git commit -m "test: add orderRelay unit tests (Patient-first push, identifier reference, fail-fast)"
```

---

### Task 4: `orderPoller.js` tests

**Files:**
- Test: `test/lib/orderPoller.test.js`

**Interfaces:**
- Consumes: `src/lib/orderPoller.js`'s exports — `start(intervalMs)`, `stop()`, `pollOnce()` (async); mocked dependency `src/lib/openmrsClient.js`'s `searchServiceRequests`; mocked `axios.post`.
- Produces: nothing later tasks directly consume; relies on Task 1's Jest install.

- [ ] **Step 1: Write `test/lib/orderPoller.test.js`**

```javascript
jest.mock('axios');
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/lib/openmrsClient');

const axios = require('axios');

describe('orderPoller', () => {
  let openmrs;
  let orderPoller;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.useFakeTimers();

    process.env.OPENHIM_ROUTER_URL = 'http://openhim-core:5001';

    openmrs = require('../../src/lib/openmrsClient');
    orderPoller = require('../../src/lib/orderPoller');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('pollOnce POSTs each entry in the search bundle to the OpenHIM inbound channel', async () => {
    const sr1 = { resourceType: 'ServiceRequest', id: 'sr1' };
    const sr2 = { resourceType: 'ServiceRequest', id: 'sr2' };
    openmrs.searchServiceRequests.mockResolvedValue({ entry: [{ resource: sr1 }, { resource: sr2 }] });
    axios.post.mockResolvedValue({ status: 200 });

    await orderPoller.pollOnce();

    expect(axios.post).toHaveBeenCalledWith(
      'http://openhim-core:5001/fhir/ServiceRequest',
      sr1,
      { headers: { 'Content-Type': 'application/fhir+json' } }
    );
    expect(axios.post).toHaveBeenCalledWith(
      'http://openhim-core:5001/fhir/ServiceRequest',
      sr2,
      { headers: { 'Content-Type': 'application/fhir+json' } }
    );
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('one entry failing to submit does not stop the remaining entries', async () => {
    const sr1 = { resourceType: 'ServiceRequest', id: 'sr1' };
    const sr2 = { resourceType: 'ServiceRequest', id: 'sr2' };
    openmrs.searchServiceRequests.mockResolvedValue({ entry: [{ resource: sr1 }, { resource: sr2 }] });
    axios.post
      .mockRejectedValueOnce(new Error('502 from OpenHIM'))
      .mockResolvedValueOnce({ status: 200 });

    await orderPoller.pollOnce();

    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('the first pollOnce searches with no lastUpdatedAfter cursor', async () => {
    openmrs.searchServiceRequests.mockResolvedValue({ entry: [] });

    await orderPoller.pollOnce();

    expect(openmrs.searchServiceRequests).toHaveBeenCalledWith({ lastUpdatedAfter: null });
  });

  test("a second pollOnce searches with the previous call's timestamp as the cursor", async () => {
    jest.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
    openmrs.searchServiceRequests.mockResolvedValue({ entry: [] });
    await orderPoller.pollOnce();

    jest.setSystemTime(new Date('2026-08-05T12:00:15.000Z'));
    await orderPoller.pollOnce();

    expect(openmrs.searchServiceRequests).toHaveBeenNthCalledWith(2, {
      lastUpdatedAfter: '2026-08-05T12:00:00.000Z'
    });
  });

  test('the cursor still advances even when the OpenMRS search itself throws', async () => {
    jest.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
    openmrs.searchServiceRequests.mockRejectedValueOnce(new Error('OpenMRS unreachable'));
    await orderPoller.pollOnce();

    jest.setSystemTime(new Date('2026-08-05T12:00:15.000Z'));
    openmrs.searchServiceRequests.mockResolvedValueOnce({ entry: [] });
    await orderPoller.pollOnce();

    expect(openmrs.searchServiceRequests).toHaveBeenNthCalledWith(2, {
      lastUpdatedAfter: '2026-08-05T12:00:00.000Z'
    });
  });

  test('start() schedules pollOnce on the given interval', async () => {
    openmrs.searchServiceRequests.mockResolvedValue({ entry: [] });

    orderPoller.start(15000);

    expect(openmrs.searchServiceRequests).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(15000);
    expect(openmrs.searchServiceRequests).toHaveBeenCalledTimes(1);

    orderPoller.stop();
  });

  test('calling start() twice does not schedule a second timer', async () => {
    openmrs.searchServiceRequests.mockResolvedValue({ entry: [] });

    orderPoller.start(15000);
    orderPoller.start(15000);
    await jest.advanceTimersByTimeAsync(15000);

    expect(openmrs.searchServiceRequests).toHaveBeenCalledTimes(1);

    orderPoller.stop();
  });

  test('stop() clears the timer so pollOnce is not called again', async () => {
    openmrs.searchServiceRequests.mockResolvedValue({ entry: [] });

    orderPoller.start(15000);
    orderPoller.stop();
    await jest.advanceTimersByTimeAsync(15000);

    expect(openmrs.searchServiceRequests).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test file**

Run: `npx jest test/lib/orderPoller.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 3: Commit**

```bash
git add test/lib/orderPoller.test.js
git commit -m "test: add orderPoller unit tests"
```

---

### Task 5: `routes/serviceRequest.js` tests

**Files:**
- Test: `test/routes/serviceRequest.test.js`

**Interfaces:**
- Consumes: `src/routes/serviceRequest.js`'s default export (an Express `Router` with `POST /fhir/ServiceRequest` mounted); mocked `src/lib/orderRelay.js`'s `relayServiceRequest`.
- Produces: nothing later tasks directly consume; relies on Task 1's Jest/supertest install.

- [ ] **Step 1: Write `test/routes/serviceRequest.test.js`**

```javascript
jest.mock('../../src/lib/orderRelay');
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const request = require('supertest');
const orderRelay = require('../../src/lib/orderRelay');
const serviceRequestRoute = require('../../src/routes/serviceRequest');

describe('POST /fhir/ServiceRequest', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json({ type: ['application/json', 'application/fhir+json'] }));
    app.use(serviceRequestRoute);
  });

  test('responds 200 with the AdvaPACS id when the relay succeeds', async () => {
    orderRelay.relayServiceRequest.mockResolvedValue({
      serviceRequest: { id: 'sr1' },
      created: { id: 'advapacs-sr-1' }
    });

    const response = await request(app)
      .post('/fhir/ServiceRequest')
      .send({ resourceType: 'ServiceRequest', id: 'sr1' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', advapacsServiceRequestId: 'advapacs-sr-1' });
  });

  test('responds 502 with the error message when the relay fails', async () => {
    orderRelay.relayServiceRequest.mockRejectedValue(new Error('AdvaPACS unreachable'));

    const response = await request(app)
      .post('/fhir/ServiceRequest')
      .send({ resourceType: 'ServiceRequest', id: 'sr1' });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ status: 'error', message: 'AdvaPACS unreachable' });
  });
});
```

- [ ] **Step 2: Run the test file**

Run: `npx jest test/routes/serviceRequest.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 3: Commit**

```bash
git add test/routes/serviceRequest.test.js
git commit -m "test: add routes/serviceRequest HTTP-level tests via supertest"
```

---

### Task 6: README documentation + full suite check

**Files:**
- Modify: `README.md` (new "Running tests" section)

**Interfaces:**
- Consumes: nothing new — documents `npm test` (Task 1).
- Produces: nothing later tasks consume (final task in this plan).

- [ ] **Step 1: Add a "Running tests" section to `README.md`**

Insert this new section directly after the existing "Running registered with OpenHIM core (no Docker)" section (before "## Files"):

```markdown
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
```
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS, all 5 test files, 33 tests total.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document how to run the test suite"
```

---

## Self-Review

**Spec coverage:** Every file listed in the spec's Scope section (`orderRelay.js`, `advapacsClient.js`, `openmrsClient.js`, `orderPoller.js`, `routes/serviceRequest.js`) has a task with real test code. Every test case listed in the spec's "Test cases by file" section is present verbatim above. The spec's "Verification" section (README doc + the `index.js`-gap sanity check) is Task 6 Step 1 and Task 3 Step 3 respectively. Tooling section (Jest + supertest only, no config file, `test/` mirroring `src/`, `jest.resetModules()` pattern) is Task 1 + the Global Constraints section.

**Placeholder scan:** No TBD/TODO/"add appropriate X" phrases in any task — every step has real, complete code.

**Type/signature consistency:** Verified every mocked function name and call signature against the actual current source of `advapacsClient.js`, `openmrsClient.js`, `orderRelay.js`, `orderPoller.js`, and `routes/serviceRequest.js` (all re-read immediately before writing this plan) — no drift between what a task assumes and what the real files export.
