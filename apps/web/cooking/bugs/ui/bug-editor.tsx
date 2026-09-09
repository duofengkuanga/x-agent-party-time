'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { createClientId } from '@/cooking/shared/ui/client-id';
import type { CookingWorkspaceSnapshot } from '@/cooking/workspace/contract';
import type { BugView } from '../contract';
import {
  assignBugAction,
  createBugAction,
  updateBugReportAction,
} from '../server/actions';
import type { BugFeedbackIntent } from './board-model';
import { AttachmentPicker } from './attachments';
import { messageOf } from './board-model';

export function BugReworkDialog({
  bug,
  error,
  kind,
  onCancel,
  onSubmit,
  pending,
}: {
  bug: BugView;
  error: string | null;
  kind: BugFeedbackIntent['kind'];
  onCancel: () => void;
  onSubmit: (formData: FormData) => void;
  pending: boolean;
}) {
  const [feedback, setFeedback] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const reopening = kind === 'REOPEN';
  const title = reopening ? '重新打开' : '不通过并返修';
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
}: {
  bug: BugView | null;
  onCancel: () => void;
  onChanged: (revision: number, message: string) => void;
  snapshot: CookingWorkspaceSnapshot;
}) {
  const canEditReport = !bug || bug.availableActions.includes('EDIT_REPORT');
  const canAssign = !bug || bug.availableActions.includes('ASSIGN');
  const frontendItems = snapshot.submission.items.filter(
    ({ engineering }) => engineering.type === 'FRONTEND',
  );
  const backendItems = snapshot.submission.items.filter(
    ({ engineering }) => engineering.type === 'BACKEND',
  );
  const [submissionItemId, setSubmissionItemId] = useState(
    bug?.submissionItemId ?? '',
  );
  const [title, setTitle] = useState(bug?.report.title ?? '');
  const [operationPath, setOperationPath] = useState(
    bug?.report.operationPath ?? '',
  );
  const [actualResult, setActualResult] = useState(
    bug?.report.actualResult ?? '',
  );
  const [expectedResult, setExpectedResult] = useState(
    bug?.report.expectedResult ?? '',
  );
  const [keptActualResultAttachmentIds, setKeptActualResultAttachmentIds] =
    useState(bug?.report.actualResultAttachments.map(({ id }) => id) ?? []);
  const [keptExpectedResultAttachmentIds, setKeptExpectedResultAttachmentIds] =
    useState(bug?.report.expectedResultAttachments.map(({ id }) => id) ?? []);
  const [actualResultFiles, setActualResultFiles] = useState<File[]>([]);
  const [expectedResultFiles, setExpectedResultFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  function submit(event: FormEvent) {
    event.preventDefault();
    startSaving(async () => {
      try {
        if (bug && !canEditReport) {
          const result = await assignBugAction(bug.id, {
            mutationId: createClientId(),
            expectedVersion: bug.version,
            submissionItemId: submissionItemId || null,
          });
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          onChanged(result.result.revision, '问题归属已更新。');
          return;
        }
        const formData = new FormData();
        formData.set('mutationId', createClientId());
        if (bug) formData.set('expectedVersion', String(bug.version));
        formData.set('submissionItemId', submissionItemId);
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
          bug ? '缺陷已保存。' : '缺陷已登记。',
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
          <label>
            <span>具体工程</span>
            <select
              onChange={(event) => setSubmissionItemId(event.target.value)}
              value={submissionItemId}
            >
              <option value="">暂不确定</option>
              {frontendItems.length ? (
                <optgroup label="前端">
                  {frontendItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.engineering.name}（{item.engineering.identifier}）
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {backendItems.length ? (
                <optgroup label="后端">
                  {backendItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.engineering.name}（{item.engineering.identifier}）
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </label>
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
        <button onClick={onCancel} type="button">
          取消
        </button>
        <button
          disabled={saving || (!canEditReport && !canAssign)}
          form="collab-bug-form"
          type="submit"
        >
          {saving ? '保存中…' : bug ? '保存修改' : '登记缺陷'}
        </button>
      </footer>
    </>
  );
}
