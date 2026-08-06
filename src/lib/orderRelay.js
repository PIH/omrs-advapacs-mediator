const logger = require('./logger');
const openmrs = require('./openmrsClient');
const advapacs = require('./advapacsClient');

const PATIENT_IDENTIFIER_SYSTEM = process.env.PATIENT_IDENTIFIER_SYSTEM;

// TODO(UHM-9437, UHM-9439, UHM-9440): temporary workaround until OpenMRS
// itself generates a proper radiology order number / accession number.
// Once those tickets land, this identifier-stamping/duplication logic
// should be removed.
const PLACER_ORDER_NUMBER_SYSTEM = 'http://www.pih.org/identifiers/lesotho/radiology-order-number';
const ACCESSION_NUMBER_SYSTEM = 'http://www.pih.org/identifiers/lesotho/radiology-accession-number';

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

  // HACK: OpenMRS ServiceRequests are arriving here already marked "completed"
  // (this mediator can't filter orderPoller.js's search by status server-side --
  // this OpenMRS FHIR2 module doesn't support a status search param on
  // ServiceRequest at all). AdvaPACS needs "active" to treat the order as
  // actionable and create a worklist entry, so we force completed -> active
  // here. Any other status (cancelled, on-hold, etc.) passes through
  // unchanged. Remove this once OpenMRS-side order status handling is fixed
  // upstream so orders reach us with their real status.
  const outboundStatus = serviceRequest.status === 'completed' ? 'active' : serviceRequest.status;

  const outboundServiceRequest = {
    ...serviceRequest,
    identifier: withAccessionNumber(serviceRequest.identifier),
    subject: outboundSubject,
    status: outboundStatus
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

function withAccessionNumber(identifiers = []) {
  const stamped = identifiers.map((identifier) => {
    const isPlacer = identifier.type && identifier.type.coding &&
      identifier.type.coding.some((coding) => coding.code === 'PLAC');
    return isPlacer ? { ...identifier, system: PLACER_ORDER_NUMBER_SYSTEM } : identifier;
  });

  const placer = stamped.find((identifier) => identifier.system === PLACER_ORDER_NUMBER_SYSTEM);
  return placer
    ? [...stamped, { system: ACCESSION_NUMBER_SYSTEM, value: placer.value }]
    : stamped;
}

function patientNameOf(patient) {
  const name = patient.name && patient.name[0];
  if (!name) return undefined;
  return [...(name.given || []), name.family].filter(Boolean).join(' ');
}

module.exports = { relayServiceRequest };
