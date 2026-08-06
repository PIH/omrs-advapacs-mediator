jest.mock('axios');
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

describe('advapacsClient', () => {
  let axios;
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

    // Re-require axios after resetModules to get the correct mock reference
    axios = require('axios');
    axios.create.mockReturnValue(mockClient);
    // Also set up axios.get mock
    axios.get.mockResolvedValue({ data: { resourceType: 'ImagingStudy', id: 'img1' } });

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
