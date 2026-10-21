'use client';

import { useEffect, useState, useTransition, type FormEvent } from 'react';
import { createClientId } from '@/cooking/shared/ui/clientId';
import type { CookingWorkspaceSnapshot } from '@/cooking/workspace/contract';
import type { BugView } from '../contract';
import { FormChoice } from '@/cooking/shared/ui/formChoice';
import {
  createBugFormDraft,
  type BugFormDraft,
  type BugOwnershipDraft,
  type BugRegistration,
} from './bugFormDraft';
import {
  assignBugAction,
  createBugAction,
  updateBugReportAction,
} from '../server/actions';
import type { BugFeedbackIntent } from './boardModel';
import type { LinkedReviewPair } from './linkedReviewModel';
import {
  LinkedOwnershipChoice,
  type LinkedOwnership,
} from './linkedOwnershipChoice';
import { AttachmentPicker } from './attachments';
import { messageOf } from '@/cooking/shared/ui/actionError';

export function BugReworkDialog({
  bug,
  error,
  kind,
  pair,
  onCancel,
  onSubmit,
  pending,
}: {
  bug: BugView;
  error: string | null;
  kind: BugFeedbackIntent['kind'];
  pair: LinkedReviewPair | null;
  onCancel: () => void;
  onSubmit: (formData: FormData) => void;
  pending: boolean;
}) {
  const [feedback, setFeedback] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [ownership, setOwnership] = useState<LinkedOwnership>('BOTH');
  const reopening = kind === 'REOPEN';
  const title = reopening ? '重新打开' : '还有问题';
  return (
    <div
      className="collab-dialog-backdrop collab-drawer-scrim"
      role="presentation"
    >
      <form
        aria-label={title}
        aria-modal="true"
        className="collab-dialog collab-bug-rework-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData();
          formData.set('mutationId', createClientId());
          formData.set('expectedVersion', String(bug.version));
          formData.set('feedback', feedback);
          if (pair?.ready) {
            const other =
              pair.frontend.id === bug.id ? pair.backend : pair.frontend;
            formData.set('relatedExpectedVersion', String(other.version));
            formData.set('decision', 'ISSUE');
            formData.set('ownership', ownership);
          }
          files.forEach((file) => formData.append('attachments', file));
          onSubmit(formData);
        }}
        role="dialog"
      >
        <header>
          <div>
            <small>{reopening ? '完成状态复核' : '验证结果'}</small>
            <h2>{title}</h2>
          </div>
          <button
            aria-label={reopening ? '关闭重新打开表单' : '关闭返修表单'}
            onClick={onCancel}
            type="button"
          >
            ×
          </button>
        </header>
        <div className="collab-dialog__body collab-form collab-bug-rework-dialog__body">
          <p>{bug.report.title}</p>
          {pair?.ready ? (
            <LinkedOwnershipChoice
              disabled={pending}
              onChange={setOwnership}
              value={ownership}
            />
          ) : null}
          <label>
            <span>{reopening ? '重新出现的问题' : '仍然存在的问题'}</span>
            <textarea
              autoFocus
              maxLength={8_000}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder={
                reopening
                  ? '描述问题重新出现的情况，开发将据此继续修复'
                  : '描述复现结果，开发将据此进入下一轮修复'
              }
              rows={4}
              value={feedback}
            />
          </label>
          <AttachmentPicker files={files} onChange={setFiles} />
          {error ? (
            <p className="collab-form__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="collab-dialog__actions">
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button disabled={pending || !feedback.trim()} type="submit">
            {pending ? '提交中…' : reopening ? '确认重新打开' : '确认返修'}
          </button>
        </footer>
      </form>
    </div>
  );
}

export function BugForm({
  bug,
  onCancel,
  onChanged,
  snapshot,
  savedDraft,
  preferredOwnership,
  onDraftChange,
  onSavingChange,
}: {
  bug: BugView | null;
  onCancel: () => void;
  onChanged: (
    revision: number,
    message: string,
    registration?: BugRegistration,
  ) => void;
  snapshot: CookingWorkspaceSnapshot;
  savedDraft: BugFormDraft | null;
  preferredOwnership: BugOwnershipDraft | null;
  onDraftChange: (draft: BugFormDraft) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const [initial] = useState(() =>
    createBugFormDraft(bug, snapshot, savedDraft, preferredOwnership),
  );
  const canEditReport = !bug || bug.availableActions.includes('EDIT_REPORT');
  const canAssign = !bug || bug.availableActions.includes('ASSIGN');
  const frontendItems = snapshot.submission.items.filter(
    ({ engineering }) => engineering.type === 'FRONTEND',
  );
  const backendItems = snapshot.submission.items.filter(
    ({ engineering }) => engineering.type === 'BACKEND',
  );
  const [submissionItemId, setSubmissionItemId] = useState(
    initial.submissionItemId,
  );
  const [joint, setJoint] = useState(initial.joint);
  const [frontItemId, setFrontItemId] = useState(initial.frontItemId);
  const [backItemId, setBackItemId] = useState(initial.backItemId);
  const mutationId = initial.mutationId;
  const [title, setTitle] = useState(initial.title);
  const [operationPath, setOperationPath] = useState(initial.operationPath);
  const [actualResult, setActualResult] = useState(initial.actualResult);
  const [expectedResult, setExpectedResult] = useState(initial.expectedResult);
  const [keptActualResultAttachmentIds, setKeptActualResultAttachmentIds] =
    useState(initial.keptActualResultAttachmentIds);
  const [keptExpectedResultAttachmentIds, setKeptExpectedResultAttachmentIds] =
    useState(initial.keptExpectedResultAttachmentIds);
  const [actualResultFiles, setActualResultFiles] = useState<File[]>(
    initial.actualResultFiles,
  );
  const [expectedResultFiles, setExpectedResultFiles] = useState<File[]>(
    initial.expectedResultFiles,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  useEffect(() => {
    onSavingChange(saving);
    return () => onSavingChange(false);
  }, [saving, onSavingChange]);
  useEffect(
    () =>
      onDraftChange({
        mutationId,
        expectedVersion: initial.expectedVersion,
        submissionItemId,
        joint,
        frontItemId,
        backItemId,
        title,
        operationPath,
        actualResult,
        expectedResult,
        keptActualResultAttachmentIds,
        keptExpectedResultAttachmentIds,
        actualResultFiles,
        expectedResultFiles,
      }),
    [
      onDraftChange,
      mutationId,
      initial.expectedVersion,
      submissionItemId,
      joint,
      frontItemId,
      backItemId,
      title,
      operationPath,
      actualResult,
      expectedResult,
      keptActualResultAttachmentIds,
      keptExpectedResultAttachmentIds,
      actualResultFiles,
      expectedResultFiles,
    ],
  );
  const canCreateAndRepair =
    !bug &&
    (joint ? Boolean(frontItemId && backItemId) : Boolean(submissionItemId));

  function submit(event: FormEvent) {
    event.preventDefault();
    const startRepair =
      canCreateAndRepair &&
      (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') ===
        'repair';
    startSaving(async () => {
      try {
        const primaryItemId = joint
          ? bug?.submissionItemId &&
            [frontItemId, backItemId].includes(bug.submissionItemId)
            ? bug.submissionItemId
            : frontItemId
          : submissionItemId;
        const additionalSubmissionItemId = joint
          ? primaryItemId === frontItemId
            ? backItemId
            : frontItemId
          : undefined;
        if (bug && !canEditReport) {
          const result = await assignBugAction(bug.id, {
            mutationId,
            expectedVersion: initial.expectedVersion!,
            submissionItemId: primaryItemId || null,
            additionalSubmissionItemId,
          });
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          onChanged(
            result.result.revision,
            joint
              ? '已调整为前端＋后端，两张关联单分别待修复。'
              : '问题归属已更新。',
          );
          return;
        }
        const formData = new FormData();
        formData.set('mutationId', mutationId);
        formData.set('startRepair', String(startRepair));
        if (bug)
          formData.set('expectedVersion', String(initial.expectedVersion));
        formData.set('submissionItemId', primaryItemId);
        if (bug && additionalSubmissionItemId)
          formData.set(
            'additionalSubmissionItemId',
            additionalSubmissionItemId,
          );
        if (!bug && joint) {
          formData.append('submissionItemIds', frontItemId);
          formData.append('submissionItemIds', backItemId);
        }
        formData.set('title', title);
        formData.set('operationPath', operationPath);
        formData.set('actualResult', actualResult);
        formData.set('expectedResult', expectedResult);
        for (const fileId of keptActualResultAttachmentIds)
          formData.append('existingActualResultAttachmentIds', fileId);
        for (const fileId of keptExpectedResultAttachmentIds)
          formData.append('existingExpectedResultAttachmentIds', fileId);
        for (const file of actualResultFiles)
          formData.append('actualResultAttachments', file);
        for (const file of expectedResultFiles)
          formData.append('expectedResultAttachments', file);
        const result = bug
          ? await updateBugReportAction(bug.id, formData)
          : await createBugAction(snapshot.submission.submission.id, formData);
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        onChanged(
          result.result.revision,
          bug
            ? joint
              ? '缺陷已保存，并补建另一工程的关联单。'
              : '缺陷已保存。'
            : startRepair
              ? joint
                ? '已登记两张前后端关联单，并加入修复队列。'
                : '缺陷已登记，并加入修复队列。'
              : joint
                ? '已登记两张前后端关联单。'
                : '缺陷已登记。',
          !bug
            ? {
                ownership: { submissionItemId, joint, frontItemId, backItemId },
              }
            : undefined,
        );
      } catch (submitError) {
        setError(messageOf(submitError, '无法保存缺陷。'));
      }
    });
  }

  return (
    <>
      <form
        className="collab-dialog__body collab-form collab-bug-drawer__body collab-bug-form"
        id="collab-bug-form"
        onSubmit={submit}
      >
        <fieldset disabled={!canAssign || saving}>
          <legend>问题归属</legend>
          {frontendItems.length > 0 &&
          backendItems.length > 0 &&
          canAssign &&
          (!bug ||
            (!bug.collaborationLocked &&
              bug.stage === 'WAITING_FOR_REPAIR')) ? (
            <label className="collab-joint-choice">
              <input
                type="checkbox"
                checked={joint}
                onChange={(event) => setJoint(event.target.checked)}
              />
              <span>
                {bug
                  ? '前端＋后端（保留本单，新增关联单）'
                  : '前端＋后端（自动登记两张关联单）'}
              </span>
            </label>
          ) : null}
          {joint ? (
            <>
              <FormChoice
                label="前端工程"
                value={frontItemId}
                onChange={setFrontItemId}
                options={frontendItems.map((item) => ({
                  value: item.id,
                  label: `${item.engineering.name}（${item.engineering.identifier}）`,
                }))}
              />
              <FormChoice
                label="后端工程"
                value={backItemId}
                onChange={setBackItemId}
                options={backendItems.map((item) => ({
                  value: item.id,
                  label: `${item.engineering.name}（${item.engineering.identifier}）`,
                }))}
              />
              <p>两张单分别进入待修复，各自更新和验收。</p>
            </>
          ) : (
            <label>
              <span>具体工程</span>
              {snapshot.submission.items.length === 1 && submissionItemId ? (
                <output aria-label="具体工程" className="collab-form__value">
                  {snapshot.submission.items[0]!.engineering.name}（
                  {snapshot.submission.items[0]!.engineering.identifier}）
                </output>
              ) : (
                <select
                  onChange={(event) => setSubmissionItemId(event.target.value)}
                  value={submissionItemId}
                >
                  <option value="">暂不确定</option>
                  {frontendItems.length ? (
                    <optgroup label="前端">
                      {frontendItems.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.engineering.name}（{item.engineering.identifier}
                          ）
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {backendItems.length ? (
                    <optgroup label="后端">
                      {backendItems.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.engineering.name}（{item.engineering.identifier}
                          ）
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              )}
            </label>
          )}
        </fieldset>
        <fieldset disabled={!canEditReport || saving}>
          <legend>缺陷内容</legend>
          <label>
            <span>标题</span>
            <input
              maxLength={240}
              onChange={(event) => setTitle(event.target.value)}
              required
              value={title}
            />
          </label>
          <div className="collab-form__grid collab-bug-form__grid">
            <fieldset className="collab-bug-result-field">
              <legend>预期结果</legend>
              <label>
                <span>文本说明</span>
                <textarea
                  maxLength={8_000}
                  onChange={(event) => setExpectedResult(event.target.value)}
                  rows={4}
                  value={expectedResult}
                />
              </label>
              <AttachmentPicker
                ariaLabel="预期结果附件"
                existingAttachments={bug?.report.expectedResultAttachments}
                files={expectedResultFiles}
                keptExistingIds={keptExpectedResultAttachmentIds}
                onChange={setExpectedResultFiles}
                onExistingChange={setKeptExpectedResultAttachmentIds}
              />
            </fieldset>
            <fieldset className="collab-bug-result-field">
              <legend>实际结果</legend>
              <label>
                <span>文本说明</span>
                <textarea
                  maxLength={8_000}
                  onChange={(event) => setActualResult(event.target.value)}
                  rows={4}
                  value={actualResult}
                />
              </label>
              <AttachmentPicker
                ariaLabel="实际结果附件"
                existingAttachments={bug?.report.actualResultAttachments}
                files={actualResultFiles}
                keptExistingIds={keptActualResultAttachmentIds}
                onChange={setActualResultFiles}
                onExistingChange={setKeptActualResultAttachmentIds}
              />
            </fieldset>
          </div>
          <label>
            <span>操作路径</span>
            <textarea
              maxLength={8_000}
              onChange={(event) => setOperationPath(event.target.value)}
              rows={3}
              value={operationPath}
            />
          </label>
        </fieldset>
        {error ? (
          <p className="collab-form__error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
      <footer className="collab-dialog__actions collab-bug-drawer__actions">
        <button disabled={saving} onClick={onCancel} type="button">
          关闭
        </button>
        <button
          disabled={saving || (!canEditReport && !canAssign)}
          form="collab-bug-form"
          type="submit"
        >
          {saving ? '保存中…' : '确认'}
        </button>
        {!bug ? (
          <button
            disabled={saving || !canCreateAndRepair || !title.trim()}
            form="collab-bug-form"
            name="intent"
            type="submit"
            value="repair"
          >
            {saving ? '保存中…' : '确认并修复'}
          </button>
        ) : null}
      </footer>
    </>
  );
}
