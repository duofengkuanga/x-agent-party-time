import type {
  CodexInteractionRequest,
  EngineeringBindingSummary,
  EngineeringDetail,
  SubmissionBug,
  SubmissionRepairTask,
  SubmissionUpdateBatch,
  TestSubmissionDetail,
} from '@agent-party-time/shared/control-plane';

export type Theme = 'paper' | 'night';
export type SubmissionItem = TestSubmissionDetail['items'][number];
export type BugStatus = SubmissionBug['status'];

export const SUBMISSION_STATUS_LABELS = {
  ACTIVE: '进行中',
  CLOSED: '已关闭',
} as const satisfies Record<TestSubmissionDetail['status'], string>;

export const ENGINEERING_TYPE_LABELS = {
  FRONTEND: '前端',
  BACKEND: '后端',
} as const satisfies Record<SubmissionItem['engineeringType'], string>;

export const DEPLOYMENT_TYPE_LABELS = {
  LOCAL_SCRIPT: '本地脚本',
  CI_CD: '持续集成与部署',
} as const satisfies Record<
  NonNullable<SubmissionItem['technical']>['environment']['deploymentType'],
  string
>;

export const RUNNER_AVAILABILITY_LABELS = {
  online: '在线',
  offline: '离线',
} as const satisfies Record<
  EngineeringBindingSummary['runner']['availability'],
  string
>;

export const UPDATE_BATCH_STATE_LABELS = {
  QUEUED: '排队中',
  RUNNING: '执行中',
  WAITING_EXTERNAL: '等待外部更新',
  COMPLETED: '已完成',
  FAILED: '已失败',
  CANCELLED: '已取消',
} as const satisfies Record<SubmissionUpdateBatch['state'], string>;

export const INTERACTION_KIND_LABELS = {
  PERMISSION: '权限确认',
  USER_INPUT: '用户输入',
} as const satisfies Record<CodexInteractionRequest['kind'], string>;

export const EXECUTION_KIND_LABELS = {
  REPAIR: '修复',
  UPDATE: '更新',
  CLEANUP: '清理',
} as const satisfies Record<CodexInteractionRequest['executionKind'], string>;

export type ItemCatalog = {
  engineering: EngineeringDetail;
  bindings: EngineeringBindingSummary[];
};

export type CreateItemDraft = {
  engineeringId: string;
  responsibleDeveloperUserId: string;
  bindingId: string;
  targetBranch: string;
  environmentId: string;
};

export type WorkspaceSnapshot = {
  submission: TestSubmissionDetail;
  bugs: SubmissionBug[];
  repairQueues: Record<string, SubmissionRepairTask[]>;
  updateBatches: Record<string, SubmissionUpdateBatch[]>;
  interactions: Record<string, CodexInteractionRequest[]>;
};

export const STATUS_COLUMNS: ReadonlyArray<{
  status: BugStatus;
  label: string;
  note: string;
}> = [
  { status: 'WAITING_FOR_REPAIR', label: '待修复', note: '录入' },
  { status: 'REPAIRING', label: '修复中', note: '修复' },
  { status: 'WAITING_FOR_UPDATE', label: '待更新', note: '批次' },
  { status: 'UPDATING', label: '更新中', note: '交付' },
  {
    status: 'WAITING_FOR_VERIFICATION',
    label: '待验证',
    note: '测试',
  },
  { status: 'DONE', label: '已完成', note: '完成' },
];
