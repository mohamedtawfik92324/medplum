// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Questionnaire, QuestionnaireResponse } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { IntakeValidationError, validateIntakeResponse } from './intake-validation';

describe('intake required fields', () => {
  const questionnaire: Questionnaire = {
    resourceType: 'Questionnaire',
    status: 'active',
    item: [
      {
        linkId: 'coverage',
        text: 'Coverage Information',
        type: 'group',
        repeats: true,
        item: [{ linkId: 'relationship', text: 'Relationship to Subscriber', type: 'choice', required: true }],
      },
    ],
  };

  test('identifies the repeated group and missing dropdown instead of crashing', () => {
    const response: QuestionnaireResponse = {
      resourceType: 'QuestionnaireResponse',
      status: 'completed',
      item: [
        { linkId: 'coverage', item: [{ linkId: 'relationship', answer: [{ valueCoding: { code: 'self' } }] }] },
        { linkId: 'coverage', item: [{ linkId: 'relationship', answer: [{}] }] },
      ],
    };
    expect(() => validateIntakeResponse(questionnaire, response)).toThrow(
      'Coverage Information (2) → Relationship to Subscriber'
    );
    try {
      validateIntakeResponse(questionnaire, response);
    } catch (error) {
      expect((error as IntakeValidationError).targets).toEqual([{ linkId: 'relationship', index: 1 }]);
    }
  });

  test('accepts false and zero, and ignores disabled required questions', () => {
    const questionnaire: Questionnaire = {
      resourceType: 'Questionnaire',
      status: 'active',
      item: [
        { linkId: 'flag', type: 'boolean', required: true },
        { linkId: 'number', type: 'integer', required: true },
        {
          linkId: 'disabled',
          type: 'string',
          required: true,
          enableWhen: [{ question: 'flag', operator: '=', answerBoolean: true }],
        },
      ],
    };
    const response: QuestionnaireResponse = {
      resourceType: 'QuestionnaireResponse',
      status: 'completed',
      item: [
        { linkId: 'flag', answer: [{ valueBoolean: false }] },
        { linkId: 'number', answer: [{ valueInteger: 0 }] },
      ],
    };
    expect(() => validateIntakeResponse(questionnaire, response)).not.toThrow();
    response.item = [{ linkId: 'flag', answer: [] }];
    expect(() => validateIntakeResponse(questionnaire, response)).toThrow(IntakeValidationError);
  });
});
