'use server';

import {
  formField,
  formStringList,
  integerFormField,
  nullableFormField,
  optionalFormField,
  runInteractiveMutation,
  type InteractiveActionResult,
} from '@/features/cooking/shared/action-transport';
import { bugService } from '@/features/cooking/application/server';
import type {
  AssignBugInput,
  BugMutationResult,
  RequestRepairInput,
} from '../contract';

export type BugActionResult = InteractiveActionResult<BugMutationResult>;

export async function createBugAction(
  submissionId: string,
  formData: FormData,
): Promise<BugActionResult> {
  return runInteractiveMutation({
    validationEvent: 'cooking_bug_action_validation_failed',
    command: async ({ userId, uploadFiles }) => {
      const actualResultAttachmentIds = await uploadFiles(
        formData,
        'actualResultAttachments',
        {
          maxFiles: 5,
          maxFilesMessage: '实际结果和预期结果各最多上传 5 个附件',
        },
      );
      const expectedResultAttachmentIds = await uploadFiles(
        formData,
        'expectedResultAttachments',
        {
          maxFiles: 5,
          maxFilesMessage: '实际结果和预期结果各最多上传 5 个附件',
        },
      );
      const result = bugService().createBug(userId, submissionId, {
        mutationId: formField(formData, 'mutationId'),
        submissionItemId: nullableFormField(formData, 'submissionItemId'),
        title: formField(formData, 'title'),
        operationPath: optionalFormField(formData, 'operationPath'),
        actualResult: optionalFormField(formData, 'actualResult'),
        expectedResult: optionalFormField(formData, 'expectedResult'),
        actualResultAttachmentIds,
        expectedResultAttachmentIds,
      });
      return bugSuccess(result);
    },
  });
}

export async function updateBugReportAction(
  bugId: string,
  formData: FormData,
): Promise<BugActionResult> {
  return runInteractiveMutation({
    validationEvent: 'cooking_bug_action_validation_failed',
    command: async ({ userId, uploadFiles }) => {
      const uploadedActual = await uploadFiles(
        formData,
        'actualResultAttachments',
        {
          maxFiles: 5,
          maxFilesMessage: '实际结果和预期结果各最多上传 5 个附件',
        },
      );
      const uploadedExpected = await uploadFiles(
        formData,
        'expectedResultAttachments',
        {
          maxFiles: 5,
          maxFilesMessage: '实际结果和预期结果各最多上传 5 个附件',
        },
      );
      const result = bugService().updateReport(userId, bugId, {
        mutationId: formField(formData, 'mutationId'),
        expectedVersion: integerFormField(formData, 'expectedVersion'),
        submissionItemId: nullableFormField(formData, 'submissionItemId'),
        title: formField(formData, 'title'),
        operationPath: optionalFormField(formData, 'operationPath'),
        actualResult: optionalFormField(formData, 'actualResult'),
        expectedResult: optionalFormField(formData, 'expectedResult'),
        actualResultAttachmentIds: [
          ...formStringList(formData, 'existingActualResultAttachmentIds'),
          ...uploadedActual,
        ],
        expectedResultAttachmentIds: [
          ...formStringList(formData, 'existingExpectedResultAttachmentIds'),
          ...uploadedExpected,
        ],
      });
      return {
        ...bugSuccess(result),
        cleanupFileIds: result.unboundAttachmentIds,
      };
    },
  });
}

export async function assignBugAction(
  bugId: string,
  input: AssignBugInput,
): Promise<BugActionResult> {
  return simpleBugAction((userId) =>
    bugService().assignBug(userId, bugId, input),
  );
}

export async function requestRepairAction(
  bugId: string,
  input: RequestRepairInput,
): Promise<BugActionResult> {
  return simpleBugAction((userId) =>
    bugService().requestRepair(userId, bugId, input),
  );
}

function simpleBugAction(
  command: (userId: string) => BugMutationResult,
): Promise<BugActionResult> {
  return runInteractiveMutation({
    validationEvent: 'cooking_bug_action_validation_failed',
    command: ({ userId }) => bugSuccess(command(userId)),
  });
}

function bugSuccess(result: BugMutationResult) {
  return {
    result,
    boundFileIds: result.boundAttachmentIds,
    refreshPaths: ['/cooking', `/cooking/${result.bug.submissionId}`],
  };
}
