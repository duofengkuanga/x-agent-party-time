'use client';

import { useRef, useState } from 'react';
import type { SubmissionWorkspaceSnapshot } from '@/contracts/submissions/workspace';
import {
  cancelBugAction,
  reopenBugAction,
  reviewLinkedBugsAction,
  restoreBugAction,
  unarchiveBugAction,
  verifyBugAction,
} from '@/app/actions/submissions/lifecycle';
import { createClientId } from '@/app/(pages)/(main)/components/clientId';
import type { BugView } from '../../../../../../contracts/submissions/bug';
import { requestRepairAction } from '../../../../../actions/submissions/bugs';
import { AttachmentPicker } from './attachments';
import { BugResultDetail } from './repairTimeline';
import {
  bugLabel,
  formatDateTime,
  verificationPassTransition,
  type WorkspaceActionResult,
} from './boardModel';
import { latestTesterFeedback, linkedReviewPairFor } from './testerDetailModel';
import { PassConfirmButton } from './passConfirmButton';
import { Popconfirm } from '@/app/(pages)/(main)/components/popconfirm';
import { TesterChecklist } from './testerChecklist';
import { TesterAttachments } from './testerAttachments';
import {
  LinkedOwnershipChoice,
  type LinkedOwnership,
} from './linkedOwnershipChoice';

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
  snapshot: SubmissionWorkspaceSnapshot;
}) {
  const [feedbackKind, setFeedbackKind] = useState<
    'VERIFY_FAIL' | 'REOPEN' | null
  >(null);
  const [feedback, setFeedback] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [ownership, setOwnership] = useState<LinkedOwnership>('BOTH');
  const [files, setFiles] = useState<File[]>([]);
  const feedbackInput = useRef<HTMLInputElement>(null);
  const feedbackButton = useRef<HTMLButtonElement>(null);
  const latestFeedback = latestTesterFeedback(bug.id, snapshot);
  const pair = linkedReviewPairFor(bug, snapshot.bugs);
  const canPass = pair
    ? pair.ready && pair.column === 'WAITING_FOR_VERIFICATION'
    : bug.availableActions.includes('VERIFY_PASS');
  const canIssue = pair
    ? pair.ready
    : bug.availableActions.some((action) =>
        ['VERIFY_FAIL', 'REOPEN'].includes(action),
      );
  const issueLabel =
    pair?.column === 'DONE' || (!pair && bug.stage === 'DONE')
      ? '重新打开'
      : '还有问题';
  const canEdit = bug.availableActions.some((action) =>
    ['EDIT_REPORT', 'ASSIGN'].includes(action),
  );
  const feedbackAllowed =
    feedbackKind !== null &&
    (pair ? pair.ready : bug.availableActions.includes(feedbackKind));
  const showActions =
    canEdit ||
    (bug.stage === 'REPAIRING' && bug.availableActions.includes('CANCEL')) ||
    Boolean(pair?.ready) ||
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
  const submitPass = () => {
    if (pair?.ready) {
      const related =
        pair.frontend.id === bug.id ? pair.backend : pair.frontend;
      const formData = new FormData();
      formData.set('mutationId', createClientId());
      formData.set('expectedVersion', String(bug.version));
      formData.set('relatedExpectedVersion', String(related.version));
      formData.set('decision', 'PASSED');
      run(
        () => reviewLinkedBugsAction(bug.id, formData),
        '前后端关联缺陷已完成本次验收。',
      );
      return;
    }
    const transition = verificationPassTransition(bug);
    if (transition) run(transition.command, transition.message);
  };
  return (
    <>
      <div className="collab-dialog__body collab-tester-detail">
        <TesterChecklist
          bug={bug}
          relatedBug={
            pair
              ? pair.frontend.id === bug.id
                ? pair.backend
                : pair.frontend
              : undefined
          }
          snapshot={snapshot}
        />
        {pair ? (
          <section
            className="collab-tester-detail__pair"
            aria-label="前后端关联进度"
          >
            {[pair.frontend, pair.backend].map((side) => (
              <div key={side.id}>
                <strong>
                  {side.assignment?.engineeringType === 'FRONTEND'
                    ? '前端'
                    : '后端'}
                </strong>
                <span>{side.presentation.stageLabel}</span>
              </div>
            ))}
          </section>
        ) : null}
        <div className="collab-tester-detail__report">
          <dl className="collab-tester-detail__comparison">
            <div>
              <dt>缺陷描述</dt>
              <dd>
                <BugResultDetail
                  text={bug.report.description}
                  attachments={[]}
                />
              </dd>
            </div>
            <div>
              <dt>附件</dt>
              <dd>
                <TesterAttachments attachments={bug.report.attachments} />
              </dd>
            </div>
          </dl>
          {bug.stage === 'WAITING_FOR_VERIFICATION' && latestFeedback ? (
            <section
              className="collab-tester-detail__feedback"
              aria-label="上次仍存在的问题"
            >
              <h3>上次仍存在的问题</h3>
              <BugResultDetail
                text={latestFeedback.text ?? undefined}
                attachments={[]}
              />
              <TesterAttachments attachments={latestFeedback.attachments} />
              <time dateTime={latestFeedback.createdAt}>
                {formatDateTime(latestFeedback.createdAt)}
              </time>
            </section>
          ) : null}
          {!pair && bug.relatedBugs.length ? (
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
              if (pair?.ready) {
                const related =
                  pair.frontend.id === bug.id ? pair.backend : pair.frontend;
                formData.set('relatedExpectedVersion', String(related.version));
                formData.set('decision', 'ISSUE');
                formData.set('ownership', ownership);
              }
              files.forEach((file) => formData.append('attachments', file));
              run(
                () =>
                  pair?.ready
                    ? reviewLinkedBugsAction(bug.id, formData)
                    : feedbackKind === 'REOPEN'
                      ? reopenBugAction(bug.id, formData)
                      : verifyBugAction(bug.id, formData),
                pair?.ready
                  ? '已按所选归属提交返修，未选中的待验证缺陷继续等待。'
                  : `${bugLabel(bug)} 已反馈，等待继续修复。`,
                () => {
                  setFeedbackKind(null);
                  setFeedback('');
                  setOwnership('BOTH');
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
            {pair?.ready ? (
              <LinkedOwnershipChoice
                disabled={pending}
                onChange={setOwnership}
                value={ownership}
              />
            ) : null}
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
                {canPass ? (
                  <PassConfirmButton
                    disabled={pending}
                    message={
                      pair?.ready
                        ? '确认前端和后端的待验证缺陷都已通过测试？已完成的缺陷保持原状。'
                        : '确认这张缺陷已通过测试？'
                    }
                    onConfirm={submitPass}
                  />
                ) : null}
                {canIssue ? (
                  <button
                    ref={feedbackButton}
                    disabled={pending}
                    type="button"
                    onClick={() => {
                      onClearError();
                      setFeedbackKind(
                        issueLabel === '重新打开' ? 'REOPEN' : 'VERIFY_FAIL',
                      );
                    }}
                  >
                    {issueLabel}
                  </button>
                ) : null}
                {bug.stage === 'REPAIRING' &&
                bug.availableActions.includes('CANCEL') ? (
                  <Popconfirm
                    label="取消等待"
                    title="确认取消这个缺陷？"
                    description="取消后移出修复队列，已有问题和答复不再触发恢复，处理记录会保留。"
                    confirmLabel="确认取消"
                    pendingLabel="正在取消…"
                    open={cancelOpen}
                    onOpenChange={setCancelOpen}
                    pending={pending}
                    error={error}
                    onConfirm={() =>
                      run(
                        () => cancelBugAction(bug.id, mutation()),
                        '缺陷已取消，旧确认已失效。',
                        () => setCancelOpen(false),
                      )
                    }
                  />
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
