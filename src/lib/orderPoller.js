const logger = require('./logger');
const openmrs = require('./openmrsClient');
const { relayServiceRequest } = require('./orderRelay');

let lastPolledAt = null;
let timer = null;

/**
 * Pull-based alternative to routes/serviceRequest.js's push endpoint, for
 * sites where OpenMRS has no event/module hook to POST new orders to us.
 * Cursors on _lastUpdated rather than tracking processed ids, so a
 * mediator restart re-anchors to "now" and will not replay a backlog --
 * any ServiceRequest created while the mediator was down is missed.
 */
async function pollOnce() {
  const since = lastPolledAt;
  const polledAt = new Date().toISOString();

  try {
    const bundle = await openmrs.searchServiceRequests({
      status: 'active',
      lastUpdatedAfter: since
    });
    const serviceRequests = (bundle.entry || []).map((entry) => entry.resource);

    for (const serviceRequest of serviceRequests) {
      try {
        await relayServiceRequest(serviceRequest);
      } catch (err) {
        logger.error('Failed to relay polled ServiceRequest to AdvaPACS', {
          openmrsServiceRequestId: serviceRequest.id,
          error: err.message
        });
      }
    }

    if (serviceRequests.length) {
      logger.info(`Polled ${serviceRequests.length} ServiceRequest(s) from OpenMRS`);
    }
  } catch (err) {
    logger.error('OpenMRS ServiceRequest poll failed', { error: err.message });
  } finally {
    lastPolledAt = polledAt;
  }
}

function start(intervalMs) {
  if (timer) return;
  lastPolledAt = new Date().toISOString();
  timer = setInterval(pollOnce, intervalMs);
  logger.info(`Started OpenMRS ServiceRequest poller (every ${intervalMs}ms)`);
}

function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, pollOnce };
