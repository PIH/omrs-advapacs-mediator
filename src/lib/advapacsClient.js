const axios = require('axios');
const logger = require('./logger');

const client = axios.create({
  baseURL: process.env.ADVAPACS_CHANNEL_URL,
  headers: {
    'Content-Type': 'application/fhir+json',
    // AdvaPACS uses its own ID/Secret scheme rather than OAuth2 bearer tokens.
    Authorization: `ID=${process.env.ADVAPACS_CLIENT_ID},Secret=${process.env.ADVAPACS_CLIENT_SECRET}`
  }
});

/**
 * Push a ServiceRequest (radiology order) into AdvaPACS. AdvaPACS creates
 * the corresponding worklist entry and returns the resource with its
 * own id, which we should store against the OpenMRS order for reconciliation.
 *
 * Goes through OpenHIM's outbound channel (ADVAPACS_CHANNEL_URL), which
 * auto-retries connection failures/timeouts to the real AdvaPACS host (see
 * scripts/setupOpenhim.js). It does NOT retry a 4xx/5xx *response* from
 * AdvaPACS itself -- that surfaces here as a normal rejected promise, caught
 * by callers (orderRelay.js's callers) with no further retry or alerting.
 */
async function createServiceRequest(serviceRequest) {
  const { data } = await client.post('/ServiceRequest', serviceRequest);
  logger.info('Pushed ServiceRequest to AdvaPACS', { advapacsId: data.id });
  return data;
}

/**
 * Fetch a resource by absolute reference URL, used when a Subscription
 * notification arrives as a lightweight ping rather than a full resource
 * payload and we need to go fetch the ImagingStudy/DiagnosticReport ourselves.
 */
async function getResourceByUrl(url) {
  const { data } = await axios.get(url, { headers: client.defaults.headers });
  return data;
}

/**
 * Register (or refresh) a FHIR Subscription with AdvaPACS so it will
 * rest-hook our webhook endpoint whenever an ImagingStudy or DiagnosticReport
 * changes. Run this once at mediator startup / deploy time, not per-request.
 */
async function ensureSubscription(webhookUrl, webhookSecret, criteria = 'ImagingStudy') {
  const subscription = {
    resourceType: 'Subscription',
    status: 'active',
    reason: 'openmrs-advapacs-mediator result delivery',
    criteria,
    channel: {
      type: 'rest-hook',
      endpoint: webhookUrl,
      payload: 'application/fhir+json',
      header: [`Authorization: Bearer ${webhookSecret}`]
    }
  };
  const { data } = await client.post('/Subscription', subscription);
  logger.info('Registered AdvaPACS subscription', { criteria, id: data.id });
  return data;
}

module.exports = { createServiceRequest, getResourceByUrl, ensureSubscription };
