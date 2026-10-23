'use server';

import {
  formField,
  formStringList,
  integerFormField,
  nullableFormField,
  optionalFormField,
  runInteractiveMutation,
  type InteractiveActionResult,
} from '@/app/actions/actionTransport';
import { bugService } from '@/server/runtime/services';
import type {
  AssignBugInput,
  BugMutationResult,
  DeleteUnassignedBugInput,
  DeleteUnassignedBugResult,
  LinkedBugsMutationResult,
  RequestRepairInput,
} from '../../../contracts/submissions/bug';
import type { RouteBugInput } from '../../../contracts/submissions/bug';

export type BugActionResult = InteractiveActionResult<BugMutationResult>;
export type DeleteBugActionResult = InteractiveActionResult<DeleteUnassignedBugResult>;

export async function deleteUnassignedBugAction(
  bugId: string,
  input: DeleteUnassignedBugInput,
): Promise<DeleteBugActionResult> {
  return runInteractiveMutation({
    validationEvent: 'submission_bug_action_validation_failed',
    command: ({ userId }) => {
      const result = bugService().deleteUnassignedBug(userId, bugId, input);
      return {
        result,
        cleanupFileIds: result.unboundAttachmentIds,
        refreshPaths: ['/submissions', `/submissions/${result.submissionId}`],
      };
    },
  });
}

const REPORT_UPLOAD_OPTIONS = {
  maxFiles: 5,
  maxFilesMessage: '实际结果和预期结果各最多上传 5 个附件',
};

export async function createBugAction(
  submissionId: string,
  formData: FormData,
): Promise<InteractiveActionResult<BugMutationResult | LinkedBugsMutationResult>> {
  return runInteractiveMutation<BugMutationResult | LinkedBugsMutationResult>({
    validationEvent: 'submission_bug_action_validation_failed',
    command: async ({ userId, uploadFiles }) => {
      const actualResultAttachmentIds = await uploadFiles(
        formData,
        'actualResultAttachments',
        REPORT_UPLOAD_OPTIONS,
      );
      const expectedResultAttachmentIds = await uploadFiles(
        formData,
        'expectedResultAttachments',
        REPORT_UPLOAD_OPTIONS,
      );
      const report = {
        mutationId: formField(formData, 'mutationId'),
        startRepair: formField(formData, 'startRepair') === 'true',
        submissionItemId: nullableFormField(formData, 'submissionItemId'),
        title: formField(formData, 'title'),
        operationPath: optionalFormField(formData, 'operationPath'),
        actualResult: optionalFormField(formData, 'actualResult'),
        expectedResult: optionalFormField(formData, 'expectedResult'),
        actualResultAttachmentIds,
        expectedResultAttachmentIds,
      };
      const submissionItemIds = formStringList(formData, 'submissionItemIds');
      if (submissionItemIds.length) {
        const result = bugService().createLinkedBugs(userId, submissionId, {
          ...report,
          submissionItemIds,
        });
        return {
          result,
          boundFileIds: result.boundAttachmentIds,
          refreshPaths: ['/submissions', `/submissions/${submissionId}`],
        };
      }
      const result = bugService().createBug(userId, submissionId, report);
      return bugSuccess(result);
    },
  });
}

export async function updateBugReportAction(
  bugId: string,
  formData: FormData,
): Promise<BugActionResult> {
  return runInteractiveMutation({
    validationEvent: 'submission_bug_action_validation_failed',
    command: async ({ userId, uploadFiles }) => {
      const uploadedActual = await uploadFiles(
        formData,
        'actualResultAttachments',
        REPORT_UPLOAD_OPTIONS,
      );
      const uploadedExpected = await uploadFiles(
        formData,
        'expectedResultAttachments',
        REPORT_UPLOAD_OPTIONS,
      );
      const result = bugService().updateReport(userId, bugId, {
        mutationId: formField(formData, 'mutationId'),
        expectedVersion: integerFormField(formData, 'expectedVersion'),
        submissionItemId: nullableFormField(formData, 'submissionItemId'),
        additionalSubmissionItemId: optionalFormField(
          formData,
          'additionalSubmissionItemId',
        ),
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
  return simpleBugAction((userId) => bugService().assignBug(userId, bugId, input));
}

export async function requestRepairAction(
  bugId: string,
  input: RequestRepairInput,
): Promise<BugActionResult> {
  return simpleBugAction((userId) => bugService().requestRepair(userId, bugId, input));
}

export async function routeBugAction(
  bugId: string,
  input: RouteBugInput,
): Promise<BugActionResult> {
  return simpleBugAction((userId) => bugService().routeBug(userId, bugId, input));
}

function simpleBugAction(
  command: (userId: string) => BugMutationResult,
): Promise<BugActionResult> {
  return runInteractiveMutation({
    validationEvent: 'submission_bug_action_validation_failed',
    command: ({ userId }) => bugSuccess(command(userId)),
  });
}

function bugSuccess(result: BugMutationResult) {
  return {
    result,
    boundFileIds: result.boundAttachmentIds,
    refreshPaths: ['/submissions', `/submissions/${result.bug.submissionId}`],
  };
}
