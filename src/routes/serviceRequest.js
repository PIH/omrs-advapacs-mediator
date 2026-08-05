const express = require('express');
const logger = require('../lib/logger');
const { relayServiceRequest } = require('../lib/orderRelay');

const router = express.Router();

/**
 * Push-based ingestion: expects OpenMRS (or an event listener module sitting
 * on OpenMRS) to POST either a full ServiceRequest resource, or a minimal
 * { serviceRequestId } body if you'd rather keep OpenMRS-side coupling to a
 * single id lookup. The actual relay logic lives in lib/orderRelay.js so it
 * can be shared with lib/orderPoller.js's pull-based ingestion -- see
 * ORDER_INGESTION_MODE in .env.example for switching between the two.
 */
router.post('/fhir/ServiceRequest', async (req, res) => {
  try {
    const { created } = await relayServiceRequest(req.body);
    res.status(200).json({ status: 'ok', advapacsServiceRequestId: created.id });
  } catch (err) {
    logger.error('Failed to relay ServiceRequest to AdvaPACS', { error: err.message });
    res.status(502).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
