// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { createReference } from '@medplum/core';
import type { AllergyIntolerance, Coding, Observation } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { expect, test, vi } from 'vitest';
import { createIntakeTransaction } from './intake-transaction';
import { addAllergy, addConsent, addCoverage, upsertObservation } from './intake-utils';

test('prepares real helper writes atomically, rewrites references and keeps upsert deduplication', async () => {
  const medplum = new MockClient();
  const createSpy = vi.spyOn(medplum, 'createResource');
  const transaction = createIntakeTransaction(medplum);
  const patient = await transaction.writer.createResource({ resourceType: 'Patient' });
  const answers = {
    'allergy-substance': { valueCoding: { system: 'test', code: 'peanut' } },
    'allergy-reaction': { valueString: 'first' },
  };
  await addAllergy(transaction.writer, patient, answers);
  await addAllergy(transaction.writer, patient, { ...answers, 'allergy-reaction': { valueString: 'last' } });
  await addCoverage(transaction.writer, patient, {
    'insurance-provider': { valueReference: { reference: 'Organization/insurer' } },
    'subscriber-id': { valueString: 'test' },
    'relationship-to-subscriber': { valueCoding: { code: 'self' } },
  });
  for (let i = 0; i < 6; i++) {
    const value: Coding = { code: 'answer' };
    await upsertObservation(
      transaction.writer,
      patient,
      { coding: [{ system: 'test', code: String(i) }] },
      {},
      'valueCodeableConcept',
      value
    );
  }
  await addConsent(transaction.writer, patient, false, {}, {}, undefined, undefined);
  const bundle = transaction.build();
  expect(bundle.type).toBe('transaction');
  expect(bundle.entry).toHaveLength(10);
  expect(bundle.entry?.every((entry) => entry.request?.method === 'POST')).toBe(true);
  expect(bundle.entry?.[0].resource?.id).toBeUndefined();
  const allergies = bundle.entry?.filter((entry) => entry.resource?.resourceType === 'AllergyIntolerance');
  expect(allergies).toHaveLength(1);
  expect((allergies?.[0].resource as AllergyIntolerance).reaction?.[0].manifestation[0].text).toBe('last');
  expect((allergies?.[0].resource as AllergyIntolerance).patient.reference).toBe(bundle.entry?.[0].fullUrl);
  expect((bundle.entry?.[3].resource as Observation).subject?.reference).toBe(bundle.entry?.[0].fullUrl);
  expect(createSpy).not.toHaveBeenCalled();
  await expect(
    transaction.writer.upsertResource({ resourceType: 'Patient' }, { name: 'other-patient' })
  ).rejects.toThrow('scoped to the new patient');
  expect(createReference(patient).reference).not.toContain('urn:');
});
