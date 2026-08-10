const logger = require('./logger');
const openmrs = require('./openmrsClient');
const advapacs = require('./advapacsClient');

const PATIENT_IDENTIFIER_SYSTEM = process.env.PATIENT_IDENTIFIER_SYSTEM;

// TODO(UHM-9437, UHM-9439, UHM-9440): temporary workaround until OpenMRS
// itself generates a proper radiology order number / accession number.
// Once those tickets land, this identifier-stamping/duplication logic
// should be removed.
const ACCESSION_NUMBER_SYSTEM = 'http://www.pih.org/identifiers/lesotho/radiology-accession-number';

const PATIENT_INTERNAL_IDENTIFIER_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v2-0203';
const PATIENT_INTERNAL_IDENTIFIER_TYPE_CODE = 'PI';

const ADVAPACS_ORDER_DETAIL_PARAMETER_CODE_SYSTEM = 'http://advapacs.com/fhir/servicerequest-orderdetail-parameter-code';

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

  // TODO: Location references on the outbound ServiceRequest still carry raw
  // OpenMRS UUIDs -- confirm what AdvaPACS expects there too (the patient
  // side is resolved below via PATIENT_IDENTIFIER_SYSTEM; encounter/requester
  // are dropped entirely below since AdvaPACS can't resolve either).
  let outboundSubject = serviceRequest.subject;

  if (patient) {
    const emrIdentifier = (patient.identifier || []).find(
      (identifier) => identifier.system === PATIENT_IDENTIFIER_SYSTEM
    );
    if (!emrIdentifier) {
      throw new Error(`Patient ${patient.id} has no identifier for system ${PATIENT_IDENTIFIER_SYSTEM}`);
    }

    // Send the Patient first so AdvaPACS has a matching record before it
    // needs to resolve the ServiceRequest's subject reference. Upserted
    // (matched on emrIdentifier) rather than always created, since
    // re-relaying an order for a patient AdvaPACS already knows about would
    // otherwise fail with "identifier already exists".
    const outboundPatient = {
      ...patient,
      identifier: withPatientInternalIdentifierType(patient.identifier)
    };
    const createdPatient = await advapacs.upsertPatient(outboundPatient, emrIdentifier.system, emrIdentifier.value);

    // EXPERIMENT: a logical identifier-based subject reference ({identifier:
    // {...}}) made AdvaPACS's real ServiceRequest endpoint 500 with no
    // diagnostic detail. Trying a literal reference to the AdvaPACS-side
    // Patient id it just handed back from upsertPatient instead, to see if
    // that avoids whatever's crashing server-side there. Revert to the
    // identifier-based reference above if this doesn't fix it.
    outboundSubject = {
      reference: `Patient/${createdPatient.id}`,
      display: patientNameOf(patient)
    };
  }

  // HACK: OpenMRS ServiceRequests are arriving here already marked "completed"
  // (this mediator can't filter orderPoller.js's search by status server-side --
  // this OpenMRS FHIR2 module doesn't support a status search param on
  // ServiceRequest at all), so it needs overriding to something AdvaPACS will
  // accept for a new order. Any other status (cancelled, on-hold, etc.) passes
  // through unchanged. Remove this once OpenMRS-side order status handling is
  // fixed upstream so orders reach us with their real status.
  //
  // EXPERIMENT: debugging a persistent "Missing required modality from
  // orderDetail" error that didn't budge across two different modality values
  // and adding FHIR R5 CodeableReference wrapping to `code` -- a working
  // reference example creates orders with status "draft" rather than
  // "active", suggesting AdvaPACS may only fully validate/populate the
  // Modality Worklist entry (including orderDetail) at a later
  // scheduled/active stage, not on initial create. Trying "draft" here to see
  // if that's what's actually blocking modality recognition. Revert to
  // "active" if it isn't.
  const outboundStatus = serviceRequest.status === 'completed' ? 'draft' : serviceRequest.status;

  // EXPERIMENT: `id`/`meta`/`text` are OpenMRS's own resource metadata/narrative
  // -- a working reference example for AdvaPACS sends none of these on create.
  // Stripping them here while debugging the persistent "missing modality"
  // error, in case AdvaPACS's parser gets confused by an id it doesn't
  // recognize on what's meant to be a new resource. Revert if it doesn't help.
  const { encounter, requester, occurrencePeriod, occurrenceDateTime, id, meta, text, ...serviceRequestWithoutStrippedFields } = serviceRequest;

  const outboundServiceRequest = {
    ...serviceRequestWithoutStrippedFields,
    identifier: withAccessionNumber(serviceRequest.identifier),
    subject: outboundSubject,
    status: outboundStatus,
    // EXPERIMENT: debugging the persistent "Missing required modality from
    // orderDetail" error, which didn't change at all between two different
    // modality values (CR, then DX) -- strong signal the real problem isn't
    // the value. FHIR R5 changed ServiceRequest.code from a plain
    // CodeableConcept to a CodeableReference ({concept, reference}); AdvaPACS's
    // own docs example still shows the old flat shape, but a separately-found
    // working example wraps it as code.concept.coding. Trying that here in
    // case AdvaPACS's real (not documented) parser needs strict R5 typing for
    // *every* composite field, not just orderDetail, and a malformed `code`
    // is what's actually derailing validation downstream. Revert if this
    // doesn't help either.
    code: toCodeableReference(withoutSystemlessCoding(serviceRequest.code)),
    // AdvaPACS only accepts the occurrenceDateTime variant of this FHIR choice
    // type, not occurrencePeriod -- collapse to a single instant via .start
    // (OpenMRS only ever sends a point-in-time period, start === end).
    occurrenceDateTime: occurrenceDateTime || (occurrencePeriod && occurrencePeriod.start),
    // TODO(UHM-9445): hardcoded to X-ray (DICOM modality "CR") -- every order
    // this integration currently handles is an X-ray. OpenMRS's ServiceRequest
    // carries no field indicating imaging modality today, so there's nothing
    // to derive this from yet. Replace with a real per-order-type modality
    // mapping once that ticket is scoped. Shape is FHIR R5's ServiceRequest.
    // orderDetail.parameter structure, keyed via AdvaPACS's own custom coding
    // system -- see https://docs.advapacs.com/interfaces/fhir/r5/service-request.
    // "DX" was tried in place of "CR" while debugging a persistent "missing
    // modality" error that turned out unrelated to this value (see
    // toCodeableReference below) -- switched back to "CR".
    orderDetail: [{
      parameter: [{
        code: { coding: [{ system: ADVAPACS_ORDER_DETAIL_PARAMETER_CODE_SYSTEM, code: 'modality' }] },
        valueString: 'CR'
      }]
    }]
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

// EXPERIMENT: debugging the persistent "missing modality" error -- a working
// reference example sends only an accession-number identifier (no separate
// placer/order-number one) alongside a DICOM UID. Dropping the raw placer
// identifier entirely here (rather than stamping and keeping it, as before)
// to match that shape more closely. Revert if it doesn't help.
function withAccessionNumber(identifiers = []) {
  const isPlacer = (identifier) => identifier.type && identifier.type.coding &&
    identifier.type.coding.some((coding) => coding.code === 'PLAC');

  const placer = identifiers.find(isPlacer);
  const withoutPlacer = identifiers.filter((identifier) => !isPlacer(identifier));

  return placer
    ? [...withoutPlacer, {
      system: ACCESSION_NUMBER_SYSTEM,
      value: placer.value,
      type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'ACSN' }] }
    }]
    : withoutPlacer;
}

// TODO(UHM-9443): temporary stopgap until OpenMRS itself emits a correctly
// coded identifier type. AdvaPACS requires the patient's EMR-ID identifier
// to carry the standard HL7 "PI" (Patient Internal Identifier) coding in its
// type.coding array -- OpenMRS's own type.coding only has its internal
// concept UUID, no system. Added alongside the existing coding(s), not
// replacing them: CodeableConcept is designed to hold multiple equivalent
// representations of the same concept. Prepended rather than appended:
// live-testing against the real AdvaPACS API showed it only validates
// type.coding[0], so the added coding has to come first or AdvaPACS never
// sees it.
function withPatientInternalIdentifierType(identifiers = []) {
  return identifiers.map((identifier) => {
    if (identifier.system !== PATIENT_IDENTIFIER_SYSTEM) return identifier;

    const existingCoding = (identifier.type && identifier.type.coding) || [];
    const alreadyPresent = existingCoding.some(
      (coding) => coding.system === PATIENT_INTERNAL_IDENTIFIER_TYPE_SYSTEM &&
        coding.code === PATIENT_INTERNAL_IDENTIFIER_TYPE_CODE
    );
    if (alreadyPresent) return identifier;

    return {
      ...identifier,
      type: {
        ...identifier.type,
        coding: [{ system: PATIENT_INTERNAL_IDENTIFIER_TYPE_SYSTEM, code: PATIENT_INTERNAL_IDENTIFIER_TYPE_CODE }, ...existingCoding]
      }
    };
  });
}

// EXPERIMENT: debugging a bare 500 ("Internal server error", no diagnostics)
// from AdvaPACS's ServiceRequest create endpoint. OpenMRS's ServiceRequest.code
// includes its own system-less internal concept coding alongside the mapped
// LOINC/SNOMED codings -- similar shape to the Patient identifier coding issue
// worked around in withPatientInternalIdentifierType (AdvaPACS only reads
// coding[0]). Dropping the unresolvable coding entirely here, to see if
// that's what's crashing the ServiceRequest endpoint. Revert if it isn't --
// there's no diagnostic detail from AdvaPACS to confirm this is actually the
// cause.
function withoutSystemlessCoding(code) {
  if (!code || !Array.isArray(code.coding)) return code;

  return { ...code, coding: code.coding.filter((coding) => coding.system) };
}

// EXPERIMENT: FHIR R5 changed several ServiceRequest fields (including `code`)
// from a plain CodeableConcept to a CodeableReference ({concept, reference}).
// Wraps a CodeableConcept as a CodeableReference's `concept`, or passes
// through unchanged (undefined stays undefined) when there's nothing to wrap.
function toCodeableReference(concept) {
  return concept && { concept };
}

function patientNameOf(patient) {
  const name = patient.name && patient.name[0];
  if (!name) return undefined;
  return [...(name.given || []), name.family].filter(Boolean).join(' ');
}

module.exports = { relayServiceRequest };
