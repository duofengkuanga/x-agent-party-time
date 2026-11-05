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
  DeleteWaitingBugInput,
  DeleteWaitingBugResult,
  LinkedBugsMutationResult,
  RequestRepairInput,
} from '../../../contracts/submissions/bug';
import type { RouteBugInput } from '../../../contracts/submissions/bug';

export type BugActionResult = InteractiveActionResult<BugMutationResult>;
export type DeleteBugActionResult = InteractiveActionResult<DeleteWaitingBugResult>;

export async function deleteWaitingBugAction(
  bugId: string,
  input: DeleteWaitingBugInput,
): Promise<DeleteBugActionResult> {
  return runInteractiveMutation({
    validationEvent: 'submission_bug_action_validation_failed',
    command: ({ userId }) => {
      const result = bugService().deleteWaitingBug(userId, bugId, input);
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
  maxFilesMessage: '缺陷最多上传 5 个附件',
};

export async function createBugAction(
  submissionId: string,
  formData: FormData,
): Promise<InteractiveActionResult<BugMutationResult | LinkedBugsMutationResult>> {
  return runInteractiveMutation<BugMutationResult | LinkedBugsMutationResult>({
    validationEvent: 'submission_bug_action_validation_failed',
    command: async ({ userId, uploadFiles }) => {
      const attachmentIds = await uploadFiles(
        formData,
        'attachments',
        REPORT_UPLOAD_OPTIONS,
      );
      const report = {
        mutationId: formField(formData, 'mutationId'),
        startRepair: formField(formData, 'startRepair') === 'true',
        description: formField(formData, 'description'),
        attachmentIds,
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
      const result = bugService().createBug(userId, submissionId, {
        ...report,
        submissionItemId: nullableFormField(formData, 'submissionItemId'),
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
    validationEvent: 'submission_bug_action_validation_failed',
    command: async ({ userId, uploadFiles }) => {
      const uploaded = await uploadFiles(formData, 'attachments', REPORT_UPLOAD_OPTIONS);
      const result = bugService().updateReport(userId, bugId, {
        mutationId: formField(formData, 'mutationId'),
        expectedVersion: integerFormField(formData, 'expectedVersion'),
        submissionItemId: nullableFormField(formData, 'submissionItemId'),
        additionalSubmissionItemId: optionalFormField(
          formData,
          'additionalSubmissionItemId',
        ),
        description: formField(formData, 'description'),
        attachmentIds: [
          ...formStringList(formData, 'existingAttachmentIds'),
          ...uploaded,
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
