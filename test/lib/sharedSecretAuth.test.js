jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../../src/lib/logger');
const { requireSharedSecret } = require('../../src/lib/sharedSecretAuth');

describe('requireSharedSecret', () => {
  let req;
  let res;
  let next;
  let middleware;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TEST_SHARED_SECRET = 'correct-secret';
    middleware = requireSharedSecret({
      headerName: 'x-mediator-secret',
      envVar: 'TEST_SHARED_SECRET',
      label: 'test'
    });
    req = { headers: {} };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    next = jest.fn();
  });

  test('calls next() when the header matches the configured secret', () => {
    req.headers['x-mediator-secret'] = 'correct-secret';

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('responds 401 and does not call next() when the header is missing', () => {
    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ status: 'error', message: 'unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  test('responds 401 when the header value does not match', () => {
    req.headers['x-mediator-secret'] = 'wrong-secret';

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('responds 401 when the header value is a different length than the secret', () => {
    req.headers['x-mediator-secret'] = 'short';

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('responds 401 when the configured env var is unset, even with a header present', () => {
    delete process.env.TEST_SHARED_SECRET;
    req.headers['x-mediator-secret'] = 'anything';

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('logs a warning with the given label when rejecting', () => {
    middleware(req, res, next);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('test')
    );
  });
});
