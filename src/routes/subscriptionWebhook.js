const express = require('express');
const logger = require('../lib/logger');
const openmrs = require('../lib/openmrsClient');
const advapacs = require('../lib/advapacsClient');

const router = express.Router();

/**
 * AdvaPACS rest-hooks this endpoint per the Subscription registered via
 * advapacsClient.ensureSubscription(). The payload may be the full resource
 * (since we requested payload: 'application/fhir+json') or, depending on
 * configuration, a lightweight ping with just a reference -- handle both.
 */
router.post('/webhooks/advapacs', verifyWebhookSecret, async (req, res) => {
  try {
    const payload = req.body;

    const resource = payload.resourceType
      ? payload
      : await advapacs.getResourceByUrl(payload.reference);

    if (resource.resourceType === 'ImagingStudy') {
      await handleImagingStudy(resource);
    } else if (resource.resourceType === 'DiagnosticReport') {
      await handleDiagnosticReport(resource);
    } else {
      logger.warn('Ignoring unsupported webhook resource type', {
        resourceType: resource.resourceType
      });
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    logger.error('Failed to process AdvaPACS webhook', { error: err.message });
    res.status(502).json({ status: 'error', message: err.message });
  }
});

async function handleImagingStudy(imagingStudy) {
  // TODO: map imagingStudy.basedOn (the AdvaPACS ServiceRequest reference)
  // back to the originating OpenMRS ServiceRequest id using whatever
  // reconciliation store replaces the log-line breadcrumb in
  // routes/serviceRequest.js, then call openmrs.updateServiceRequestStatus(...).
  await openmrs.createResource('ImagingStudy', imagingStudy);
}

async function handleDiagnosticReport(diagnosticReport) {
  await openmrs.createResource('DiagnosticReport', diagnosticReport);

  const serviceRequestRef = diagnosticReport.basedOn && diagnosticReport.basedOn[0];
  if (serviceRequestRef) {
    const openmrsServiceRequestId = serviceRequestRef.reference.split('/').pop();
    await openmrs.updateServiceRequestStatus(openmrsServiceRequestId, 'completed');
  }
}

function verifyWebhookSecret(req, res, next) {
  const expected = `Bearer ${process.env.ADVAPACS_WEBHOOK_SECRET}`;
  if (req.headers.authorization !== expected) {
    logger.warn('Rejected webhook with invalid Authorization header');
    return res.status(401).json({ status: 'error', message: 'unauthorized' });
  }
  next();
}

module.exports = router;
