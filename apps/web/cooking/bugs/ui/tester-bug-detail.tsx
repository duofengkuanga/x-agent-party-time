'use client';

import { useRef, useState } from 'react';
import type { CookingWorkspaceSnapshot } from '@/cooking/workspace/contract';
import {
  reopenBugAction,
  restoreBugAction,
  unarchiveBugAction,
  verifyBugAction,
} from '@/cooking/lifecycle/server/actions';
import { createClientId } from '@/cooking/shared/ui/client-id';
import type { BugView } from '../contract';
import { requestRepairAction } from '../server/actions';
import { AttachmentPicker } from './attachments';
import { BugResultDetail } from './repair-timeline';
import {
  bugLabel,
  formatDateTime,
  verificationPassTransition,
  type WorkspaceActionResult,
} from './board-model';
import { latestTesterFeedback, testerBugStatus } from './tester-detail-model';

export type RunTesterAction = (
  command: () => Promise<WorkspaceActionResult>,
  message: string,
  onSuccess?: () => void,
) => void;

export function TesterBugDetail({
  bug,
  error,
  onClearError,
  onEdit,
  onOpen,
  pending,
  run,
  snapshot,
}: {
  bug: BugView;
  error: string | null;
  onClearError: () => void;
  onEdit: () => void;
  onOpen: (bugId: string) => void;
  pending: boolean;
  run: RunTesterAction;
  snapshot: CookingWorkspaceSnapshot;
}) {
  const [feedbackKind, setFeedbackKind] = useState<
    'VERIFY_FAIL' | 'REOPEN' | null
  >(null);
  const [feedback, setFeedback] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const feedbackInput = useRef<HTMLInputElement>(null);
  const feedbackButton = useRef<HTMLButtonElement>(null);
  const latestFeedback = latestTesterFeedback(bug.id, snapshot);
  const canEdit = bug.availableActions.some((action) =>
    ['EDIT_REPORT', 'ASSIGN'].includes(action),
  );
  const feedbackAllowed =
    feedbackKind !== null && bug.availableActions.includes(feedbackKind);
  const showActions =
    canEdit ||
    bug.availableActions.some((action) =>
      [
        'REQUEST_REPAIR',
        'VERIFY_PASS',
        'VERIFY_FAIL',
        'REOPEN',
        'RESTORE',
        'UNARCHIVE',
      ].includes(action),
    );
  const mutation = () => ({
    mutationId: createClientId(),
    expectedVersion: bug.version,
  });
  return (
    <>
      <div className="collab-dialog__body collab-tester-detail">
        <section
          aria-label="当前情况"
          className="collab-tester-detail__status"
          aria-live="polite"
        >
          <span>{bug.presentation.stageLabel}</span>
          <p>{testerBugStatus(bug, snapshot)}</p>
        </section>
        <div className="collab-tester-detail__report">
          <dl className="collab-tester-detail__comparison">
            {bug.report.expectedResult ||
            bug.report.expectedResultAttachments.length ? (
              <div>
                <dt>预期结果</dt>
                <dd>
                  <BugResultDetail
                    text={bug.report.expectedResult}
                    attachments={bug.report.expectedResultAttachments}
                  />
                </dd>
              </div>
            ) : null}
            {bug.report.actualResult ||
            bug.report.actualResultAttachments.length ? (
              <div>
                <dt>原始实际结果</dt>
                <dd>
                  <BugResultDetail
                    text={bug.report.actualResult}
                    attachments={bug.report.actualResultAttachments}
                  />
                </dd>
              </div>
            ) : null}
          </dl>
          {bug.report.operationPath ? (
            <section className="collab-tester-detail__path">
              <h3>操作路径</h3>
              <p>{bug.report.operationPath}</p>
            </section>
          ) : null}
          {bug.stage === 'WAITING_FOR_VERIFICATION' && latestFeedback ? (
            <section
              className="collab-tester-detail__feedback"
              aria-label="上次仍存在的问题"
            >
              <h3>上次仍存在的问题</h3>
              <BugResultDetail
                text={latestFeedback.text ?? undefined}
                attachments={latestFeedback.attachments}
              />
              <time dateTime={latestFeedback.createdAt}>
                {formatDateTime(latestFeedback.createdAt)}
              </time>
            </section>
          ) : null}
          {bug.relatedBugs.length ? (
            <section
              className="collab-tester-detail__related"
              aria-label="关联缺陷"
            >
              <h3>关联缺陷</h3>
              {bug.relatedBugs.map((related, index) => (
                <div key={related.id ?? `deleted-${index}`}>
                  {related.id ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => onOpen(related.id!)}
                    >
                      {related.title}
                    </button>
                  ) : (
                    <p>{related.title}（已删除）</p>
                  )}
                  <small>
                    {related.engineeringName} · {related.stageLabel}
                  </small>
                </div>
              ))}
            </section>
          ) : null}
        </div>
        {feedbackAllowed ? (
          <form
            aria-label={feedbackKind === 'REOPEN' ? '重新打开' : '还有问题'}
            className="collab-form collab-tester-detail__form"
            id="collab-tester-feedback"
            onSubmit={(event) => {
              event.preventDefault();
              if (pending || !feedback.trim()) return;
              const formData = new FormData();
              formData.set('mutationId', createClientId());
              formData.set('expectedVersion', String(bug.version));
              formData.set('feedback', feedback);
              if (feedbackKind === 'VERIFY_FAIL')
                formData.set('result', 'FAILED');
              files.forEach((file) => formData.append('attachments', file));
              run(
                () =>
                  feedbackKind === 'REOPEN'
                    ? reopenBugAction(bug.id, formData)
                    : verifyBugAction(bug.id, formData),
                `${bugLabel(bug)} 已反馈，等待继续修复。`,
                () => {
                  setFeedbackKind(null);
                  setFeedback('');
                  setFiles([]);
                  if (feedbackInput.current) feedbackInput.current.value = '';
                },
              );
            }}
          >
            <label>
              <span>
                {feedbackKind === 'REOPEN'
                  ? '重新出现的问题'
                  : '仍然存在的问题'}
              </span>
              <textarea
                autoFocus
                disabled={pending}
                maxLength={8_000}
                required
                rows={3}
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder="描述这次复测的结果"
              />
            </label>
            <fieldset disabled={pending}>
              <AttachmentPicker
                files={files}
                inputRef={feedbackInput}
                onChange={setFiles}
              />
            </fieldset>
          </form>
        ) : null}
      </div>
      {showActions || error ? (
        <footer
          aria-busy={pending}
          aria-label="缺陷操作"
          className="collab-tester-detail__actions"
        >
          {error ? (
            <p className="collab-form__error" role="alert">
              {error}
            </p>
          ) : null}
          {pending ? <span role="status">正在提交…</span> : null}
          <div>
            {feedbackAllowed ? (
              <>
                <button
                  disabled={pending}
                  type="button"
                  onClick={() => {
                    onClearError();
                    setFeedbackKind(null);
                    window.requestAnimationFrame(() =>
                      feedbackButton.current?.focus(),
                    );
                  }}
                >
                  取消
                </button>
                <button
                  form="collab-tester-feedback"
                  type="submit"
                  disabled={pending || !feedback.trim()}
                >
                  {feedbackKind === 'REOPEN' ? '确认重新打开' : '确认返修'}
                </button>
              </>
            ) : (
              <>
                {canEdit ? (
                  <button disabled={pending} onClick={onEdit} type="button">
                    {bug.availableActions.includes('EDIT_REPORT')
                      ? '编辑资料'
                      : '调整归属'}
                  </button>
                ) : null}
                {bug.availableActions.includes('REQUEST_REPAIR') ? (
                  <button
                    disabled={pending}
                    type="button"
                    onClick={() =>
                      run(
                        () => requestRepairAction(bug.id, mutation()),
                        '缺陷已提交修复。',
                      )
                    }
                  >
                    开始修复
                  </button>
                ) : null}
                {bug.availableActions.includes('VERIFY_PASS') ? (
                  <button
                    disabled={pending}
                    type="button"
                    onClick={() => {
                      const transition = verificationPassTransition(bug);
                      if (transition)
                        run(transition.command, transition.message);
                    }}
                  >
                    通过
                  </button>
                ) : null}
                {bug.availableActions.some((action) =>
                  ['VERIFY_FAIL', 'REOPEN'].includes(action),
                ) ? (
                  <button
                    ref={feedbackButton}
                    disabled={pending}
                    type="button"
                    onClick={() => {
                      onClearError();
                      setFeedbackKind(
                        bug.availableActions.includes('REOPEN')
                          ? 'REOPEN'
                          : 'VERIFY_FAIL',
                      );
                    }}
                  >
                    {bug.availableActions.includes('REOPEN')
                      ? '重新打开'
                      : '还有问题'}
                  </button>
                ) : null}
                {bug.availableActions.includes('RESTORE') ? (
                  <button
                    disabled={pending}
                    type="button"
                    onClick={() =>
                      run(
                        () => restoreBugAction(bug.id, mutation()),
                        '缺陷已恢复到待修复。',
                      )
                    }
                  >
                    恢复到待修复
                  </button>
                ) : null}
                {bug.availableActions.includes('UNARCHIVE') ? (
                  <button
                    disabled={pending}
                    type="button"
                    onClick={() =>
                      run(
                        () => unarchiveBugAction(bug.id, mutation()),
                        '缺陷已移出归档。',
                      )
                    }
                  >
                    移出归档
                  </button>
                ) : null}
              </>
            )}
          </div>
        </footer>
      ) : null}
    </>
  );
}
