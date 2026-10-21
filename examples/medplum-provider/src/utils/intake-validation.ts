// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type {
  Questionnaire,
  QuestionnaireItem,
  QuestionnaireResponse,
  QuestionnaireResponseItem,
} from '@medplum/fhirtypes';
import { isQuestionEnabled } from '@medplum/react-hooks';

export class IntakeValidationError extends Error {
  constructor(
    readonly fields: string[],
    readonly targets: { linkId: string; index: number }[] = []
  ) {
    super('Please complete the required fields: ' + fields.join('; '));
    this.name = 'IntakeValidationError';
  }
}

export class IntakeSaveError extends Error {}

export function validateIntakeResponse(questionnaire: Questionnaire, response: QuestionnaireResponse): void {
  const fields: string[] = [];
  const targets: { linkId: string; index: number }[] = [];
  const occurrences = new Map<string, number>();
  function visit(items: QuestionnaireItem[] = [], answers: QuestionnaireResponseItem[] = [], path = ''): void {
    for (const item of items) {
      if (!isQuestionEnabled(item, response) || item.type === 'display') {
        continue;
      }
      const label = path + (item.text || item.linkId);
      const index = occurrences.get(item.linkId) ?? 0;
      occurrences.set(item.linkId, index + 1);
      const matches = answers.filter((answer) => answer.linkId === item.linkId);
      if (item.type === 'group') {
        if (item.repeats && matches.length === 0) {
          if (item.required) {
            fields.push(label);
            targets.push({ linkId: item.linkId, index });
          }
          continue;
        }
        for (const [index, match] of (matches.length ? matches : [undefined]).entries()) {
          visit(item.item, match?.item, label + (item.repeats ? ` (${index + 1})` : '') + ' → ');
        }
      } else {
        const hasAnswer = matches.some((match) =>
          match.answer?.some((answer) => {
            if (item.type === 'choice' || item.type === 'open-choice') {
              return !!(answer.valueCoding?.code || answer.valueString?.trim());
            }
            if (item.type === 'reference') {
              return !!(answer.valueReference?.reference || answer.valueReference?.identifier?.value);
            }
            return Object.entries(answer).some(([key, value]) => key.startsWith('value') && hasValue(value));
          })
        );
        if (item.required && !hasAnswer) {
          fields.push(label);
          targets.push({ linkId: item.linkId, index });
        }
        for (const match of matches) {
          for (const answer of match.answer ?? []) {
            visit(item.item, answer.item, label + ' → ');
          }
        }
      }
    }
  }
  visit(questionnaire.item, response.item);
  if (fields.length) {
    throw new IntakeValidationError(fields, targets);
  }
}

function hasValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some(hasValue);
  }
  return value !== undefined && value !== null;
}
