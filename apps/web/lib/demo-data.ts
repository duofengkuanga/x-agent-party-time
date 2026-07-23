import type { TaskState } from '@agent-party-time/shared';

export type AgentTone = 'coral' | 'ink' | 'olive' | 'blue';

export interface DemoChannel {
  id: string;
  name: string;
  transport: 'local' | 'slack' | 'telegram';
  unread: number;
  activeAgents: number;
  connected: boolean;
}

export interface DemoFeedItem {
  id: string;
  channelId: string;
  kind: 'agent' | 'human' | 'system';
  author: string;
  role?: string;
  tone: AgentTone;
  time: string;
  body: string;
  detail?: string;
  chips?: string[];
}

export interface DemoTask {
  id: string;
  title: string;
  state: TaskState;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  assignee: string;
  progress: number;
}

export const demoChannels: DemoChannel[] = [
  {
    id: 'product-room',
    name: '产品间',
    transport: 'local',
    unread: 3,
    activeAgents: 3,
    connected: true,
  },
  {
    id: 'release-watch',
    name: '发布观察',
    transport: 'slack',
    unread: 0,
    activeAgents: 2,
    connected: true,
  },
  {
    id: 'research-lab',
    name: '研究室',
    transport: 'telegram',
    unread: 1,
    activeAgents: 1,
    connected: false,
  },
];

export const demoFeed: DemoFeedItem[] = [
  {
    id: 'feed-1',
    channelId: 'product-room',
    kind: 'system',
    author: '派对时刻',
    tone: 'ink',
    time: '09:41:08',
    body: '频道已连接，3 个智能体正在监听直接提及。',
    chips: ['频道已连接', '游标：418'],
  },
  {
    id: 'feed-2',
    channelId: 'product-room',
    kind: 'human',
    author: '你',
    tone: 'blue',
    time: '09:42:16',
    body: '@主控 帮我检查发布流程，先找出最可能阻塞上线的环节。',
  },
  {
    id: 'feed-3',
    channelId: 'product-room',
    kind: 'agent',
    author: '米拉',
    role: '主控',
    tone: 'coral',
    time: '09:42:31',
    body: '收到。我来持有球权并拆分检查面：构建、配置、回滚与冒烟测试。',
    detail: '已创建任务-42，并将构建检查分派给洛文。',
    chips: ['任务已创建', '运行-018'],
  },
  {
    id: 'feed-4',
    channelId: 'product-room',
    kind: 'agent',
    author: '洛文',
    role: '专项 · 构建',
    tone: 'olive',
    time: '09:44:02',
    body: '构建通过。发现预发布环境缺少回滚前快照步骤，我正在补一份最小验证清单。',
    detail: '工作智能体的结果会先回传给主控智能体，不会直接回复频道。',
    chips: ['构建：28.4 秒', '2 个产物'],
  },
  {
    id: 'feed-5',
    channelId: 'release-watch',
    kind: 'agent',
    author: '米拉',
    role: '主控',
    tone: 'coral',
    time: '08:17:48',
    body: '0.1.0 版本的发布窗口已建立，等待人工批准。',
    chips: ['待验收'],
  },
  {
    id: 'feed-6',
    channelId: 'research-lab',
    kind: 'system',
    author: '派对时刻',
    tone: 'ink',
    time: '昨天',
    body: '消息频道已断开，下一次重试将在 30 秒后进行。',
    chips: ['频道异常', '等待重试'],
  },
];

export const demoTasks: DemoTask[] = [
  {
    id: '任务-42',
    title: '发布前阻塞项检查',
    state: 'in_progress',
    priority: 'urgent',
    assignee: '米拉',
    progress: 68,
  },
  {
    id: '任务-39',
    title: '整理适配器错误边界',
    state: 'needs_review',
    priority: 'high',
    assignee: '洛文',
    progress: 100,
  },
  {
    id: '任务-31',
    title: '频道游标恢复演练',
    state: 'waiting',
    priority: 'normal',
    assignee: '诺瓦',
    progress: 35,
  },
];
