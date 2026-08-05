const logger = require('./logger');
const openmrs = require('./openmrsClient');
const advapacs = require('./advapacsClient');

/**
 * Core order-relay logic, independent of how the ServiceRequest arrived
 * (HTTP push from routes/serviceRequest.js, or a scheduled poll from
 * lib/orderPoller.js). Accepts either a full ServiceRequest resource or
 * a minimal { serviceRequestId } reference.
 */
async function relayServiceRequest(input) {
  const serviceRequest = input.resourceType === 'ServiceRequest'
    ? input
    : await openmrs.getResource('ServiceRequest', input.serviceRequestId);

  const patientRef = serviceRequest.subject && serviceRequest.subject.reference;
  const patientId = patientRef && patientRef.split('/').pop();
  const patient = patientId ? await openmrs.getPatient(patientId) : null;

  // TODO: this is the piece that needs real mapping work -- AdvaPACS needs
  // a patient identifier it can match against modality worklist entries,
  // which may not be the raw OpenMRS Patient UUID. Confirm which
  // identifier system AdvaPACS expects (MRN, accession-linked id, etc.)
  // and substitute it here, along with Location/Practitioner references.
  const outboundServiceRequest = {
    ...serviceRequest,
    subject: patient
      ? { reference: `Patient/${patient.id}`, display: patientNameOf(patient) }
      : serviceRequest.subject
  };

  const created = await advapacs.createServiceRequest(outboundServiceRequest);

  // Keep a breadcrumb back to AdvaPACS's id so the webhook handler can
  // reconcile results without a second lookup. In a fuller implementation
  // this would be persisted (OpenHIM transaction store, or a small
  // mediator-owned lookup table) rather than just logged.
  logger.info('Order relayed to AdvaPACS', {
    openmrsServiceRequestId: serviceRequest.id,
    advapacsServiceRequestId: created.id
  });

  return { serviceRequest, created };
}

function patientNameOf(patient) {
  const name = patient.name && patient.name[0];
  if (!name) return undefined;
  return [...(name.given || []), name.family].filter(Boolean).join(' ');
}

module.exports = { relayServiceRequest };
