import {
  engineeringCreatePath,
  engineeringSettingsPath,
  projectPanelPath,
} from '@/cooking/projects/ui/route-state';

export function settingsHref(
  projectId: string,
  panel: 'project' | 'collaboration' | 'engineering',
): string {
  return projectPanelPath(projectId, panel);
}

export function engineeringHref(
  projectId: string,
  engineeringId: string,
): string {
  return engineeringSettingsPath(projectId, engineeringId);
}

export function engineeringCreateHref(projectId: string): string {
  return engineeringCreatePath(projectId);
}

export function deploymentLabel(kind: 'LOCAL_SCRIPT' | 'CI_CD'): string {
  return kind === 'LOCAL_SCRIPT' ? '本地脚本' : '持续集成';
}

export function bindingRequestLabel(
  state: 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
): string {
  return {
    PENDING: '等待 Agent 响应',
    PROCESSING: '等待选择仓库',
    SUCCEEDED: '工程绑定已完成',
    FAILED: '工程绑定未完成',
    CANCELLED: '工程绑定已取消',
  }[state];
}

export function bindingRequestMessage(
  state: 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
): string {
  return {
    PENDING: '等待本机 Agent 领取请求。',
    PROCESSING: '请在本机选择要绑定的 Git 仓库。',
    SUCCEEDED: '工程绑定已完成。',
    FAILED: '请根据提示重新发起工程绑定。',
    CANCELLED: '如需继续，请重新发起工程绑定。',
  }[state];
}

export function invitationStatus(status: string): string {
  return (
    {
      PENDING: '等待处理',
      ACCEPTED: '已接受',
      REJECTED: '已拒绝',
      REVOKED: '已撤销',
    }[status] ?? '未知状态'
  );
}
