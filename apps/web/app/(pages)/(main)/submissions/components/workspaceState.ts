'use client';

import { type SubmissionWorkspaceSnapshot } from '@/contracts/submissions/workspace';
import {
  WorkspaceInvalidationSchema,
  type SubmissionSummary,
} from '../../../../../contracts/submissions/submission';

export type SyncState = 'connected' | 'reconnecting' | 'syncing';

type WorkspaceState = {
  snapshot: SubmissionWorkspaceSnapshot | null;
  submissions: SubmissionSummary[];
  syncState: SyncState;
};

type WorkspaceAction =
  | {
      type: 'RESET';
      snapshot: SubmissionWorkspaceSnapshot | null;
      submissions: SubmissionSummary[];
    }
  | { type: 'REPLACE_SNAPSHOT'; snapshot: SubmissionWorkspaceSnapshot }
  | { type: 'SET_SYNC_STATE'; syncState: SyncState }
  | { type: 'UPDATE_SUBMISSION'; submission: SubmissionSummary['submission'] };

export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case 'RESET':
      return {
        snapshot: action.snapshot,
        submissions: action.submissions,
        syncState: 'connected',
      };
    case 'REPLACE_SNAPSHOT':
      if (
        !state.snapshot ||
        state.snapshot.submission.submission.id !==
          action.snapshot.submission.submission.id ||
        action.snapshot.revision < state.snapshot.revision
      )
        return state;
      return {
        snapshot: action.snapshot,
        submissions: action.snapshot.submissions,
        syncState: state.syncState,
      };
    case 'SET_SYNC_STATE':
      return { ...state, syncState: action.syncState };
    case 'UPDATE_SUBMISSION':
      return {
        ...state,
        snapshot:
          state.snapshot?.submission.submission.id === action.submission.id
            ? {
                ...state.snapshot,
                revision: action.submission.workspaceRevision,
                submission: {
                  ...state.snapshot.submission,
                  submission: action.submission,
                },
              }
            : state.snapshot,
        submissions: state.submissions.map((summary) =>
          summary.submission.id === action.submission.id
            ? { ...summary, submission: action.submission }
            : summary,
        ),
      };
  }
}

export function parseInvalidation(value: string) {
  try {
    const parsed = WorkspaceInvalidationSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
