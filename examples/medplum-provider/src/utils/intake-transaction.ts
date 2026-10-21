// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient, WithId } from '@medplum/core';
import { generateId, getReferenceString } from '@medplum/core';
import type { Bundle, BundleEntry, Resource } from '@medplum/fhirtypes';

export type IntakeWriter = Pick<MedplumClient, 'createResource' | 'upsertResource'>;

export function createIntakeTransaction(medplum: MedplumClient): { writer: IntakeWriter; build: () => Bundle } {
  const entries: BundleEntry[] = [];
  const references = new Map<string, string>();
  const upserts = new Map<string, BundleEntry>();
  let patientReference: string | undefined;

  function create<T extends Resource>(resource: T): WithId<T> {
    const id = generateId();
    const pending = { ...resource, id };
    const reference = getReferenceString(pending);
    const fullUrl = 'urn:uuid:' + id;
    references.set(reference, fullUrl);
    entries.push({ fullUrl, resource: { ...resource }, request: { method: 'POST', url: resource.resourceType } });
    if (resource.resourceType === 'Patient') {
      if (patientReference) {
        throw new Error('Intake must create exactly one new patient');
      }
      patientReference = reference;
    }
    return pending;
  }

  const writer: IntakeWriter = {
    createResource: async (resource) => create(resource),
    upsertResource: async (resource, query) => {
      const url = medplum.fhirSearchUrl(resource.resourceType, query);
      if (!patientReference || ![...url.searchParams.values()].includes(patientReference)) {
        throw new Error('Intake upserts must be scoped to the new patient');
      }
      url.searchParams.sort();
      const key = url.toString();
      const existing = upserts.get(key);
      // All upserts target a newly created patient, so only entries in this submission can match.
      if (existing) {
        existing.resource = { ...resource };
        return { ...resource, id: existing.fullUrl?.slice('urn:uuid:'.length) as string };
      }
      const pending = create(resource);
      upserts.set(key, entries[entries.length - 1]);
      return pending;
    },
  };

  return {
    writer,
    build: () =>
      JSON.parse(
        JSON.stringify({ resourceType: 'Bundle', type: 'transaction', entry: entries }, (_key, value) =>
          typeof value === 'string' ? (references.get(value) ?? value) : value
        )
      ) as Bundle,
  };
}
