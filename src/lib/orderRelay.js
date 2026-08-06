const logger = require('./logger');
const openmrs = require('./openmrsClient');
const advapacs = require('./advapacsClient');

const PATIENT_IDENTIFIER_SYSTEM = process.env.PATIENT_IDENTIFIER_SYSTEM;

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

  // TODO: Location/Practitioner references on the outbound ServiceRequest
  // still carry raw OpenMRS UUIDs -- confirm what AdvaPACS expects for
  // those too (the patient side is resolved below via PATIENT_IDENTIFIER_SYSTEM).
  let outboundSubject = serviceRequest.subject;

  if (patient) {
    // Send the Patient first so AdvaPACS has a matching record before it
    // needs to resolve the ServiceRequest's subject identifier reference.
    await advapacs.createPatient(patient);

    const emrIdentifier = (patient.identifier || []).find(
      (identifier) => identifier.system === PATIENT_IDENTIFIER_SYSTEM
    );
    if (!emrIdentifier) {
      throw new Error(`Patient ${patient.id} has no identifier for system ${PATIENT_IDENTIFIER_SYSTEM}`);
    }

    outboundSubject = {
      identifier: { system: emrIdentifier.system, value: emrIdentifier.value },
      display: patientNameOf(patient)
    };
  }

  const outboundServiceRequest = {
    ...serviceRequest,
    subject: outboundSubject
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
