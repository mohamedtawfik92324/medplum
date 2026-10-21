// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { allOk, badRequest, OperationOutcomeError, serverError } from '@medplum/core';
import type {
  Patient,
  Questionnaire,
  QuestionnaireResponse,
  QuestionnaireResponseItemAnswer,
} from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockAnswers = {
  'first-name': { valueString: 'Jamie' },
  'last-name': { valueString: 'Doe' },
  dob: { valueDate: '1990-01-01' },
  phone: { valueString: '555-5555' },
  ssn: { valueString: '123-45-6789' },
  street: { valueString: '1 Main St' },
  city: { valueString: 'Springfield' },
  state: { valueCoding: { code: 'CA' } },
  zip: { valueString: '90210' },
  'languages-spoken': { valueCoding: { code: 'en' } },
  'preferred-language': { valueCoding: { code: 'en' } },
  race: { valueCoding: { code: 'race-code', display: 'Race' } },
  ethnicity: { valueCoding: { code: 'eth-code', display: 'Ethnicity' } },
  'veteran-status': { valueBoolean: true },
  'consent-for-treatment-signature': { valueBoolean: true },
  'consent-for-treatment-date': { valueDate: '2024-01-01' },
  'agreement-to-pay-for-treatment-help': { valueBoolean: true },
  'agreement-to-pay-for-treatment-date': { valueDate: '2024-01-02' },
  'notice-of-privacy-practices-signature': { valueBoolean: true },
  'notice-of-privacy-practices-date': { valueDate: '2024-01-03' },
  'acknowledgement-for-advance-directives-signature': { valueBoolean: true },
  'acknowledgement-for-advance-directives-date': { valueDate: '2024-01-04' },
  'preferred-pharmacy-reference': { valueReference: { reference: 'Organization/pharmacy-1' } },
} satisfies Record<string, QuestionnaireResponseItemAnswer>;

const mockIntakeUtils = vi.hoisted(() => ({
  addAllergy: vi.fn(),
  addCondition: vi.fn(),
  addConsent: vi.fn(),
  addCoverage: vi.fn(),
  addExtension: vi.fn(),
  addFamilyMemberHistory: vi.fn(),
  addImmunization: vi.fn(),
  addLanguage: vi.fn(),
  addMedication: vi.fn(),
  addPharmacy: vi.fn(),
  consentCategoryMapping: {
    med: { coding: [] },
    pay: { coding: [] },
    nopp: { coding: [] },
    acd: { coding: [] },
  },
  consentPolicyRuleMapping: {
    cric: { coding: [] },
    hipaaSelfPay: { coding: [] },
    hipaaNpp: { coding: [] },
    adr: { coding: [] },
  },
  consentScopeMapping: {
    treatment: { coding: [] },
    patientPrivacy: { coding: [] },
    adr: { coding: [] },
  },
  convertDateToDateTime: vi.fn((date?: string) => (date ? `${date}T00:00:00Z` : undefined)),
  extensionURLMapping: {
    race: 'race-url',
    ethnicity: 'ethnicity-url',
    veteran: 'veteran-url',
  },
  getGroupRepeatedAnswers: vi.fn((_, __, groupId) => {
    if (groupId === 'coverage-information') {
      return [
        {
          'insurance-provider': { valueReference: { reference: 'Organization/org-1' } },
          'subscriber-id': { valueString: 'sub-1' },
          'relationship-to-subscriber': { valueCoding: { code: 'self' } },
        },
      ];
    }
    if (groupId === 'allergies') {
      return [{ 'allergy-substance': { valueCoding: { code: 'peanut' } } }];
    }
    return [];
  }),
  getHumanName: vi.fn(() => ({ given: ['Jamie'], family: 'Doe' })),
  getPatientAddress: vi.fn(() => ({ line: ['1 Main St'] })),
  observationCategoryMapping: {
    socialHistory: { coding: [] },
    sdoh: { coding: [] },
  },
  observationCodeMapping: {
    sexualOrientation: { coding: [] },
    housingStatus: { coding: [] },
    educationLevel: { coding: [] },
    smokingStatus: { coding: [] },
    pregnancyStatus: { coding: [] },
    estimatedDeliveryDate: { coding: [] },
  },
  PROFILE_URLS: {
    Patient: 'patient-profile',
    ObservationSexualOrientation: 'obs-profile',
  },
  upsertObservation: vi.fn(),
}));

vi.mock('./intake-utils', () => mockIntakeUtils);

import { onboardPatient } from './intake-form';

describe('onboardPatient', () => {
  let medplum: MockClient;

  beforeEach(() => {
    medplum = new MockClient();
    vi.clearAllMocks();
    vi.spyOn(medplum, 'validateResource').mockResolvedValue(allOk);
    vi.spyOn(medplum, 'getProject').mockReturnValue({ resourceType: 'Project', features: ['transaction-bundles'] });
    vi.spyOn(medplum, 'executeBatch').mockImplementation(async (bundle) => ({
      resourceType: 'Bundle',
      type: 'transaction-response',
      entry: bundle.entry?.map((entry, index) => ({
        resource: { ...entry.resource, id: index === 0 ? 'patient-1' : 'response-1' } as Patient,
        response: { status: '201' },
      })),
    }));
  });

  test.each(['outcome', 'rejection'])('does not write resources on validation %s', async (failure) => {
    const response = buildResponseFromAnswers({ 'insurance-provider': {} });
    const outcome = badRequest('Invalid empty non-primitive value (QuestionnaireResponse.item[0].answer[0])');
    const error = new OperationOutcomeError(outcome);
    if (failure === 'outcome') {
      vi.mocked(medplum.validateResource).mockResolvedValue(outcome);
    } else {
      vi.mocked(medplum.validateResource).mockRejectedValue(error);
    }
    const createSpy = vi.spyOn(medplum, 'createResource');
    const upsertSpy = vi.spyOn(medplum, 'upsertResource');

    await expect(onboardPatient(medplum, { resourceType: 'Questionnaire' } as Questionnaire, response)).rejects.toThrow(
      error.message
    );

    expect(medplum.validateResource).toHaveBeenCalledWith(response);
    expect(createSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(mockIntakeUtils.getHumanName).not.toHaveBeenCalled();
  });

  test('creates patient and invokes onboarding helpers', async () => {
    const createSpy = vi.spyOn(medplum, 'createResource');

    const questionnaire = { resourceType: 'Questionnaire' } as Questionnaire;
    const response = buildResponseFromAnswers(mockAnswers);

    const patient = await onboardPatient(medplum, questionnaire, response);

    expect(patient.id).toBe('patient-1');
    expect(response.subject).toBeUndefined();
    expect(medplum.validateResource).toHaveBeenCalledWith(response);
    expect(createSpy).not.toHaveBeenCalled();
    const bundle = vi.mocked(medplum.executeBatch).mock.calls[0][0];
    expect(bundle.type).toBe('transaction');
    expect(bundle.entry?.map((entry) => entry.resource?.resourceType)).toEqual(['Patient', 'QuestionnaireResponse']);
    expect((bundle.entry?.[1]?.resource as QuestionnaireResponse).subject?.reference).toBe(bundle.entry?.[0]?.fullUrl);
    expect(mockIntakeUtils.addExtension).toHaveBeenCalledWith(
      expect.objectContaining({}),
      'race-url',
      'valueCoding',
      mockAnswers['race'],
      'ombCategory'
    );
    expect(mockIntakeUtils.addLanguage).toHaveBeenCalledTimes(2);
    expect(mockIntakeUtils.addCoverage).toHaveBeenCalledWith(
      expect.objectContaining({ createResource: expect.any(Function), upsertResource: expect.any(Function) }),
      expect.objectContaining({ resourceType: 'Patient' }),
      expect.any(Object)
    );
    expect(mockIntakeUtils.addAllergy).toHaveBeenCalled();
    expect(mockIntakeUtils.addConsent).toHaveBeenCalled();
    expect(mockIntakeUtils.addPharmacy).toHaveBeenCalled();
  });

  test('refuses to send any writes when transactions are unavailable', async () => {
    vi.mocked(medplum.getProject).mockReturnValue({ resourceType: 'Project' });
    await expect(
      onboardPatient(medplum, { resourceType: 'Questionnaire' } as Questionnaire, buildResponseFromAnswers(mockAnswers))
    ).rejects.toThrow('Safe intake saving is unavailable');
    expect(medplum.executeBatch).not.toHaveBeenCalled();
  });

  test('a helper failure during preparation cannot save a patient', async () => {
    mockIntakeUtils.addCoverage.mockRejectedValueOnce(new Error('preparation failed'));
    const createSpy = vi.spyOn(medplum, 'createResource');
    await expect(
      onboardPatient(medplum, { resourceType: 'Questionnaire' } as Questionnaire, buildResponseFromAnswers(mockAnswers))
    ).rejects.toThrow('preparation failed');
    expect(createSpy).not.toHaveBeenCalled();
    expect(medplum.executeBatch).not.toHaveBeenCalled();
  });

  test.each([
    [new OperationOutcomeError(badRequest('Invalid Coverage')), 'Nothing was saved'],
    [
      new OperationOutcomeError(serverError(new Error('Internal failure'))),
      'Check the patient list before trying again',
    ],
    [new Error('Failed to fetch'), 'Check the patient list before trying again'],
  ])('distinguishes a rejected transaction from an uncertain connection failure', async (error, message) => {
    vi.mocked(medplum.executeBatch).mockRejectedValueOnce(error);
    await expect(
      onboardPatient(medplum, { resourceType: 'Questionnaire' } as Questionnaire, buildResponseFromAnswers(mockAnswers))
    ).rejects.toThrow(message);
    expect(medplum.executeBatch).toHaveBeenCalledTimes(1);
  });

  test('does not report success for an unexpected transaction response', async () => {
    vi.mocked(medplum.executeBatch).mockResolvedValueOnce({ resourceType: 'Bundle', type: 'batch-response' });
    await expect(
      onboardPatient(medplum, { resourceType: 'Questionnaire' } as Questionnaire, buildResponseFromAnswers(mockAnswers))
    ).rejects.toThrow('Check the patient list before trying again');
  });
});

function buildResponseFromAnswers(answers: Record<string, QuestionnaireResponseItemAnswer>): QuestionnaireResponse {
  return {
    resourceType: 'QuestionnaireResponse',
    status: 'completed',
    item: Object.entries(answers).map(([linkId, answer]) => ({
      linkId,
      answer: [answer],
    })),
  };
}
