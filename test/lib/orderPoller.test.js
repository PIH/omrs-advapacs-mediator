jest.mock('axios');
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/lib/openmrsClient');

let axios;

describe('orderPoller', () => {
  let openmrs;
  let orderPoller;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.useFakeTimers();

    process.env.OPENHIM_ROUTER_URL = 'http://openhim-core:5001';
    process.env.OPENHIM_INBOUND_CLIENT_ID = 'openmrs';
    process.env.OPENHIM_INBOUND_CLIENT_PASSWORD = 'test-client-password';
    process.env.MEDIATOR_INBOUND_SECRET = 'test-inbound-secret';

    axios = require('axios');
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

    const expectedConfig = {
      headers: {
        'Content-Type': 'application/fhir+json',
        'X-Mediator-Secret': 'test-inbound-secret'
      },
      auth: {
        username: 'openmrs',
        password: 'test-client-password'
      }
    };
    expect(axios.post).toHaveBeenCalledWith(
      'http://openhim-core:5001/fhir/ServiceRequest',
      sr1,
      expectedConfig
    );
    expect(axios.post).toHaveBeenCalledWith(
      'http://openhim-core:5001/fhir/ServiceRequest',
      sr2,
      expectedConfig
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
