// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { badRequest, OperationOutcomeError, serverError } from '@medplum/core';
import type { Questionnaire } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as reactRouter from 'react-router';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as intakeForm from '../../utils/intake-form';
import { IntakeFormPage } from './IntakeFormPage';

const simpleQuestionnaire: Questionnaire = {
  resourceType: 'Questionnaire',
  status: 'active',
  title: 'Simple Test Questionnaire',
  item: [
    {
      linkId: 'demographics',
      text: 'Demographics',
      type: 'group',
      item: [
        {
          linkId: 'first-name',
          text: 'First Name',
          type: 'string',
          required: true,
        },
        {
          linkId: 'last-name',
          text: 'Last Name',
          type: 'string',
          required: true,
        },
        {
          linkId: 'ssn',
          text: 'Social Security Number',
          type: 'string',
          required: true,
        },
        {
          linkId: 'gender-identity',
          text: 'Gender Identity',
          type: 'choice',
          answerValueSet: 'http://example.com/gender',
          required: true,
        },
      ],
    },
    {
      linkId: 'emergency-contact',
      text: 'Emergency Contact',
      type: 'group',
      item: [
        {
          linkId: 'emergency-contact-first-name',
          text: 'First Name',
          type: 'string',
        },
      ],
    },
  ],
};

describe('IntakeFormPage', () => {
  let medplum: MockClient;
  let navigateSpy: ReturnType<typeof vi.fn>;
  let renderResult: ReturnType<typeof render> | null = null;

  beforeEach(() => {
    cleanup();
    medplum = new MockClient();
    vi.clearAllMocks();
    navigateSpy = vi.fn();
    vi.spyOn(reactRouter, 'useNavigate').mockReturnValue(navigateSpy as any);
    renderResult = null;

    // Use mockImplementation with immediate resolution to avoid async timing issues
    medplum.valueSetExpand = vi.fn().mockImplementation(() =>
      Promise.resolve({
        resourceType: 'ValueSet',
        expansion: {
          contains: [{ system: 'test', code: 'test-code', display: 'Test Display' }],
        },
      })
    );
  });

  afterEach(() => {
    if (renderResult) {
      renderResult.unmount();
      renderResult = null;
    }
    cleanup();
    vi.restoreAllMocks();
  });

  const setup = async (skipValueSetCheck = true, questionnaire?: Questionnaire): Promise<void> => {
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/onboarding']}>
          <MedplumProvider medplum={medplum}>
            <MantineProvider>
              <Notifications />
              <Routes>
                <Route
                  path="/onboarding"
                  element={<IntakeFormPage skipValueSetCheck={skipValueSetCheck} questionnaire={questionnaire} />}
                />
              </Routes>
            </MantineProvider>
          </MedplumProvider>
        </MemoryRouter>
      );
    });
  };

  test('Renders questionnaire form with all sections', async () => {
    await setup(true, simpleQuestionnaire);

    await waitFor(
      () => {
        expect(screen.getByText('Simple Test Questionnaire')).toBeInTheDocument();
      },
      { timeout: 10000 }
    );

    await waitFor(
      () => {
        expect(screen.getByText('Demographics')).toBeInTheDocument();
        expect(screen.getByText('Emergency Contact')).toBeInTheDocument();
      },
      { timeout: 10000 }
    );
  });

  test('focuses the first missing field using native validation without saving or losing answers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const createSpy = vi.spyOn(medplum, 'createResource');
    const batchSpy = vi.spyOn(medplum, 'executeBatch');
    await setup(true, simpleQuestionnaire);
    await screen.findByText('Simple Test Questionnaire');
    const firstName = screen.getAllByRole('textbox', { name: /First Name/i })[0];
    fireEvent.change(firstName, { target: { value: 'Keep my answer' } });
    fireEvent.submit(screen.getByTestId('questionnaire-form'));
    const lastName = screen.getAllByRole('textbox', { name: /Last Name/i })[0] as HTMLInputElement;
    await waitFor(() => expect(lastName).toHaveFocus());
    expect(lastName.validationMessage).toBe('Please complete this required field.');
    expect(screen.queryByText('Please review your submission')).not.toBeInTheDocument();
    fireEvent.change(lastName, { target: { value: 'Corrected' } });
    expect(lastName.validationMessage).toBe('');
    expect(screen.getAllByRole('textbox', { name: /First Name/i })[0]).toHaveValue('Keep my answer');
    expect(createSpy).not.toHaveBeenCalled();
    expect(batchSpy).not.toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  test('blocks duplicate submissions and replaces unexpected technical errors with useful guidance', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let rejectSave: (error: Error) => void = () => {};
    const submitSpy = vi.spyOn(intakeForm, 'onboardPatient').mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = reject;
        })
    );
    await setup(true, simpleQuestionnaire);
    await screen.findByText('Simple Test Questionnaire');
    const form = screen.getByTestId('questionnaire-form');
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    await act(async () => rejectSave(new TypeError("Cannot read properties of undefined (reading 'code')")));
    await screen.findByText(
      'We could not complete this form. Your answers are still here. Review them and contact support if the problem continues.',
      { selector: 'li' }
    );
    expect(screen.queryByText(/Cannot read properties/)).not.toBeInTheDocument();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  test('Shows alert when value sets are unavailable', async () => {
    medplum.valueSetExpand = vi.fn().mockImplementation(async (params: { url: string }) => {
      if (params.url === 'http://example.com/gender') {
        throw new OperationOutcomeError(badRequest('ValueSet http://example.com/gender not found'));
      }
      return {
        resourceType: 'ValueSet',
        expansion: { contains: [] },
      };
    });

    await setup(false, simpleQuestionnaire);

    await waitFor(
      () => {
        expect(screen.getByText('Simple Test Questionnaire')).toBeInTheDocument();
      },
      { timeout: 10000 }
    );

    await waitFor(
      () => {
        expect(screen.getByText(/Some valuesets are unavailable/i)).toBeInTheDocument();
      },
      { timeout: 10000 }
    );
  });

  test('Does not show alert for transient value set errors', async () => {
    medplum.valueSetExpand = vi.fn().mockImplementation(async (params: { url: string }) => {
      if (params.url === 'http://example.com/gender') {
        throw new OperationOutcomeError(serverError(new Error('boom')));
      }
      return {
        resourceType: 'ValueSet',
        expansion: { contains: [] },
      };
    });

    await setup(false, simpleQuestionnaire);

    await waitFor(
      () => {
        expect(screen.getByText('Simple Test Questionnaire')).toBeInTheDocument();
      },
      { timeout: 10000 }
    );

    expect(screen.queryByText(/Some valuesets are unavailable/i)).not.toBeInTheDocument();
  });

  test('Renders required demographic fields', async () => {
    await setup(true, simpleQuestionnaire);

    await waitFor(
      () => {
        expect(screen.getByText('Simple Test Questionnaire')).toBeInTheDocument();
      },
      { timeout: 10000 }
    );

    await waitFor(
      () => {
        expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument();
      },
      { timeout: 10000 }
    );

    await waitFor(
      () => {
        const firstNameInputs = screen.getAllByRole('textbox', { name: /First Name/i });
        expect(firstNameInputs.length).toBeGreaterThan(0);
      },
      { timeout: 10000 }
    );

    const firstNameInputs = screen.getAllByRole('textbox', { name: /First Name/i });
    expect(firstNameInputs[0]).toBeInTheDocument();

    const lastNameInputs = screen.getAllByRole('textbox', { name: /Last Name/i });
    expect(lastNameInputs.length).toBeGreaterThan(0);
    expect(lastNameInputs[0]).toBeInTheDocument();

    expect(screen.getByRole('textbox', { name: /Social Security Number/i })).toBeInTheDocument();
    const genderIdentityLabels = screen.getAllByText(/Gender Identity/i);
    expect(genderIdentityLabels.length).toBeGreaterThan(0);
  });

  test('Renders demographic group section', async () => {
    await setup(true, simpleQuestionnaire);

    await waitFor(
      () => {
        expect(screen.getByText('Demographics')).toBeInTheDocument();
      },
      { timeout: 10000 }
    );

    await waitFor(
      () => {
        expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument();
      },
      { timeout: 10000 }
    );

    await waitFor(
      () => {
        const firstNameInputs = screen.getAllByRole('textbox', { name: /First Name/i });
        expect(firstNameInputs.length).toBeGreaterThan(0);
      },
      { timeout: 10000 }
    );

    const firstNameInputs = screen.getAllByRole('textbox', { name: /First Name/i });
    expect(firstNameInputs.length).toBeGreaterThan(0);

    const lastNameInputs = screen.getAllByRole('textbox', { name: /Last Name/i });
    expect(lastNameInputs.length).toBeGreaterThan(0);

    expect(screen.getByRole('textbox', { name: /Social Security Number/i })).toBeInTheDocument();
    const genderIdentityLabels = screen.getAllByText(/Gender Identity/i);
    expect(genderIdentityLabels.length).toBeGreaterThan(0);
  });
});
