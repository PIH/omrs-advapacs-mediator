const axios = require('axios');
const logger = require('./logger');
const openmrs = require('./openmrsClient');

let lastPolledAt = null;
let timer = null;

/**
 * Pull-based alternative to routes/serviceRequest.js's push endpoint, for
 * sites where OpenMRS has no event/module hook to POST new orders to us.
 * Cursors on _lastUpdated rather than tracking processed ids, so a
 * mediator restart re-anchors to "now" and will not replay a backlog --
 * any ServiceRequest created while the mediator was down is missed.
 * TODO: this will need to be improved if we want to use in Production@!
 *
 * Submits each polled ServiceRequest to OpenHIM's inbound channel (same
 * urlPattern routes/serviceRequest.js's push endpoint sits behind) rather
 * than calling orderRelay.js directly, so this hop is logged/retryable as
 * an OpenHIM transaction instead of being invisible in-process.
 */
async function pollOnce() {
  const since = lastPolledAt;
  const polledAt = new Date().toISOString();

  try {
    const bundle = await openmrs.searchServiceRequests({
      lastUpdatedAfter: since
    });
    const serviceRequests = (bundle.entry || []).map((entry) => entry.resource);

    for (const serviceRequest of serviceRequests) {
      try {
        await axios.post(
          `${process.env.OPENHIM_ROUTER_URL}/fhir/ServiceRequest`,
          serviceRequest,
          { headers: { 'Content-Type': 'application/fhir+json' } }
        );
      } catch (err) {
        logger.error('Failed to submit polled ServiceRequest to OpenHIM', {
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
