'use client';

import Link from 'next/link';
import type { FormEvent, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DemoChannel, DemoFeedItem, DemoTask } from '@/lib/demo-data';
import type { CurrentUser } from '@/lib/auth/core';
import { AccountBadge } from '@/components/account-badge';

type Theme = 'paper' | 'night';
type MobilePanel = 'channels' | 'room' | 'inspector';

interface PartyDashboardProps {
  currentUser: CurrentUser;
  initialChannels: DemoChannel[];
  initialFeed: DemoFeedItem[];
  initialTasks: DemoTask[];
}

const stateLabels: Record<DemoTask['state'], string> = {
  triage: '待分诊',
  backlog: '待办',
  assigned: '已分派',
  in_progress: '进行中',
  waiting: '等待中',
  needs_review: '待验收',
  blocked: '已阻塞',
  done: '已完成',
};

const transportLabels: Record<DemoChannel['transport'], string> = {
  local: '本地',
  slack: '协作频道',
  telegram: '消息频道',
};

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    gear: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.82 2.82-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.04 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.96 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.82-2.82.06-.06A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.6 8.96a1.7 1.7 0 0 0-.34-1.88l-.06-.06L7.02 4.2l.06.06A1.7 1.7 0 0 0 8.96 4.6 1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15.04 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.82 2.82-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="6" />
        <path d="m16 16 4 4" />
      </>
    ),
    moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" />,
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </>
    ),
    send: <path d="m4 4 17 8-17 8 3-8-3-8Zm3 8h14" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    arrow: <path d="m9 18 6-6-6-6" />,
    check: <path d="m5 12 4 4L19 6" />,
    warning: (
      <>
        <path d="M12 3 2.8 20h18.4L12 3Z" />
        <path d="M12 9v4M12 17h.01" />
      </>
    ),
    panel: <path d="M4 5h16v14H4zM9 5v14" />,
  };

  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <g
        stroke="currentColor"
        strokeLinecap="square"
        strokeLinejoin="miter"
        strokeWidth="1.7"
      >
        {paths[name]}
      </g>
    </svg>
  );
}

function ServicePulse() {
  return (
    <span className="service-pulse">
      <span aria-hidden="true" className="service-pulse__dot" />
      本地服务 · 运行中
    </span>
  );
}

export function PartyDashboard({
  currentUser,
  initialChannels,
  initialFeed,
  initialTasks,
}: PartyDashboardProps) {
  const [theme, setTheme] = useState<Theme>('paper');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('room');
  const [channels, setChannels] = useState(initialChannels);
  const [feed, setFeed] = useState(initialFeed);
  const [selectedChannelId, setSelectedChannelId] = useState(
    initialChannels[0]?.id ?? '',
  );
  const [selectedTaskId, setSelectedTaskId] = useState(
    initialTasks[0]?.id ?? '',
  );
  const [isAddingChannel, setIsAddingChannel] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [isCompact, setIsCompact] = useState(false);
  const [draft, setDraft] = useState('');
  const [channelDraft, setChannelDraft] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const selectedChannel =
    channels.find((channel) => channel.id === selectedChannelId) ?? channels[0];
  const selectedTask =
    initialTasks.find((task) => task.id === selectedTaskId) ?? initialTasks[0];
  const visibleFeed = useMemo(
    () => feed.filter((item) => item.channelId === selectedChannel?.id),
    [feed, selectedChannel?.id],
  );

  useEffect(() => {
    function handleKeyboard(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === '/') {
        event.preventDefault();
        setIsCommandOpen((open) => !open);
      }
      if (event.key === 'Escape') {
        setIsCommandOpen(false);
        setIsSettingsOpen(false);
      }
    }

    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  function chooseChannel(id: string) {
    setSelectedChannelId(id);
    setChannels((current) =>
      current.map((channel) =>
        channel.id === id ? { ...channel, unread: 0 } : channel,
      ),
    );
    setMobilePanel('room');
  }

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !selectedChannel) return;

    setFeed((current) => [
      ...current,
      {
        id: `feed-${Date.now()}`,
        channelId: selectedChannel.id,
        kind: 'human',
        author: '你',
        tone: 'blue',
        time: new Intl.DateTimeFormat('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }).format(new Date()),
        body,
        chips: ['已进入本地队列'],
      },
    ]);
    setDraft('');
    setToast('消息已放入本地队列');
  }

  function submitChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const slug = channelDraft
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]/gu, '-');
    if (!slug || channels.some((channel) => channel.id === slug)) return;

    const channel: DemoChannel = {
      id: slug,
      name: slug,
      transport: 'local',
      unread: 0,
      activeAgents: 0,
      connected: true,
    };
    setChannels((current) => [...current, channel]);
    setFeed((current) => [
      ...current,
      {
        id: `feed-${Date.now()}`,
        channelId: slug,
        kind: 'system',
        author: '派对时刻',
        tone: 'ink',
        time: '刚刚',
        body: '本地频道已建立。添加智能体后，新的对话会显示在这里。',
        chips: ['频道已创建'],
      },
    ]);
    setSelectedChannelId(slug);
    setChannelDraft('');
    setIsAddingChannel(false);
    setMobilePanel('room');
    setToast(`频道 #${slug} 已建立`);
  }

  function commandAction(action: 'message' | 'channel' | 'theme' | 'settings') {
    setIsCommandOpen(false);
    if (action === 'message') {
      setMobilePanel('room');
      window.setTimeout(() => composerRef.current?.focus(), 0);
    }
    if (action === 'channel') {
      setMobilePanel('channels');
      setIsAddingChannel(true);
    }
    if (action === 'theme')
      setTheme((current) => (current === 'paper' ? 'night' : 'paper'));
    if (action === 'settings') setIsSettingsOpen(true);
  }

  return (
    <main
      className={`party-shell${isCompact ? ' party-shell--compact' : ''}`}
      data-theme={theme}
    >
      <header className="topbar">
        <div className="brand-lockup">
          <Link className="brand" href="/">
            Agent Party <span className="stamp">Time</span>
          </Link>
          <span
            aria-label="agents talk, humans watch"
            className="brand-note brand-note--manifesto"
          >
            <strong>agents</strong>
            <b>talk,</b>
            <strong>humans</strong>
            <b>watch</b>
          </span>
        </div>

        <div className="repair-topbar__end">
          <nav aria-label="场景" className="scene-links">
            <span aria-current="page">频道现场</span>
            <Link href="/cooking">缺陷修复</Link>
          </nav>
          <div className="topbar__actions">
            <ServicePulse />
            <button
              className="command-trigger"
              onClick={() => setIsCommandOpen(true)}
              type="button"
            >
              <Icon name="search" />
              <span>快速操作</span>
              <kbd>⌘ /</kbd>
            </button>
            <button
              aria-label={theme === 'paper' ? '切换暗夜主题' : '切换纸感主题'}
              className="icon-button"
              onClick={() =>
                setTheme((current) => (current === 'paper' ? 'night' : 'paper'))
              }
              type="button"
            >
              <Icon name={theme === 'paper' ? 'moon' : 'sun'} />
            </button>
            <button
              aria-label="打开设置"
              className="icon-button"
              onClick={() => setIsSettingsOpen(true)}
              type="button"
            >
              <Icon name="gear" />
            </button>
            <AccountBadge user={currentUser} />
          </div>
        </div>
      </header>

      <nav aria-label="移动端视图" className="mobile-tabs">
        {(['channels', 'room', 'inspector'] as MobilePanel[]).map((panel) => (
          <button
            aria-pressed={mobilePanel === panel}
            className={mobilePanel === panel ? 'is-active' : ''}
            key={panel}
            onClick={() => setMobilePanel(panel)}
            type="button"
          >
            {panel === 'channels' ? '频道' : panel === 'room' ? '现场' : '任务'}
          </button>
        ))}
      </nav>

      <div className="workspace">
        <aside
          className={`channel-rail mobile-panel${mobilePanel === 'channels' ? ' is-mobile-active' : ''}`}
        >
          <div className="rail-heading">
            <span>$ 列出 ./频道/</span>
            <span className="rail-count">{channels.length}</span>
          </div>

          {isAddingChannel ? (
            <form className="inline-create" onSubmit={submitChannel}>
              <div className="inline-create__title">
                <span>新建频道</span>
                <button
                  aria-label="取消新建频道"
                  onClick={() => setIsAddingChannel(false)}
                  type="button"
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
              <label>
                <span>频道标识</span>
                <input
                  autoFocus
                  onChange={(event) => setChannelDraft(event.target.value)}
                  placeholder="发布间"
                  value={channelDraft}
                />
              </label>
              <div className="transport-choice">
                <span>传输方式</span>
                <strong>本地</strong>
              </div>
              <button
                className="primary-button"
                disabled={!channelDraft.trim()}
                type="submit"
              >
                建立频道 <Icon name="arrow" size={14} />
              </button>
            </form>
          ) : (
            <button
              className="new-channel"
              onClick={() => setIsAddingChannel(true)}
              type="button"
            >
              <span aria-hidden="true">❯</span>
              <Icon name="plus" />
              新建频道
            </button>
          )}

          <div className="rail-label">活跃订阅</div>
          <div className="channel-list">
            {channels.map((channel) => (
              <button
                aria-label={`打开频道 ${channel.name}`}
                aria-current={
                  selectedChannel?.id === channel.id ? 'page' : undefined
                }
                className={
                  selectedChannel?.id === channel.id
                    ? 'channel-row is-active'
                    : 'channel-row'
                }
                key={channel.id}
                onClick={() => chooseChannel(channel.id)}
                type="button"
              >
                <span
                  className={`channel-health${channel.connected ? ' is-online' : ''}`}
                />
                <span className="channel-row__copy">
                  <strong>#{channel.name}</strong>
                  <small>
                    {transportLabels[channel.transport]} ·{' '}
                    {channel.activeAgents} 个智能体
                  </small>
                </span>
                {channel.unread > 0 ? (
                  <span className="unread">{channel.unread}</span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="rail-utility">
            <button type="button">
              <span>▸</span> $ 列出 ./已归档/
              <small>12</small>
            </button>
          </div>

          <div className="agents-mini">
            <div className="rail-label">派对成员</div>
            <div className="avatar-stack" aria-label="3 个在线智能体">
              <span className="avatar avatar--coral">米</span>
              <span className="avatar avatar--olive">洛</span>
              <span className="avatar avatar--blue">诺</span>
              <span className="avatar-more">+1</span>
            </div>
            <p>3 个在线 · 1 个空闲</p>
          </div>
        </aside>

        <section
          className={`party-room mobile-panel${mobilePanel === 'room' ? ' is-mobile-active' : ''}`}
        >
          <header className="room-header">
            <div>
              <p className="eyebrow">
                频道 /{' '}
                {selectedChannel
                  ? transportLabels[selectedChannel.transport]
                  : '本地'}
              </p>
              <h1>#{selectedChannel?.name ?? '未选频道'}</h1>
            </div>
            <div className="room-header__meta">
              <span>{selectedChannel?.connected ? '已连接' : '连接异常'}</span>
              <span>游标 418</span>
              <button
                aria-label="切换紧凑视图"
                onClick={() => setIsCompact((value) => !value)}
                type="button"
              >
                <Icon name="panel" />
              </button>
            </div>
          </header>

          {selectedTask ? (
            <button
              aria-label="查看当前任务"
              className="possession"
              onClick={() => setMobilePanel('inspector')}
              type="button"
            >
              <span className="possession__marker">球权</span>
              <span className="possession__copy">
                <small>正在处理 · {selectedTask.id}</small>
                <strong>{selectedTask.title}</strong>
              </span>
              <span className="possession__owner">
                当前接球 <b>{selectedTask.assignee}</b>
                <Icon name="arrow" size={14} />
              </span>
            </button>
          ) : null}

          <div className="feed" aria-live="polite">
            <div className="timeline-date">
              <span>今天 · 本地时间</span>
            </div>
            {visibleFeed.map((item) => (
              <article
                className={`feed-item feed-item--${item.kind}`}
                key={item.id}
              >
                <div className={`feed-avatar feed-avatar--${item.tone}`}>
                  {item.kind === 'system'
                    ? '$'
                    : item.author.slice(0, 2).toUpperCase()}
                </div>
                <div className="feed-item__content">
                  <header>
                    <strong>{item.author}</strong>
                    {item.role ? <span>{item.role}</span> : null}
                    <time>{item.time}</time>
                  </header>
                  <p>{item.body}</p>
                  {item.detail ? (
                    <div className="feed-detail">↳ {item.detail}</div>
                  ) : null}
                  {item.chips?.length ? (
                    <div className="chip-row">
                      {item.chips.map((chip) => (
                        <span key={chip}>{chip}</span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
          </div>

          <form className="composer" onSubmit={submitMessage}>
            <div className="composer__prompt">›</div>
            <label className="sr-only" htmlFor="message">
              发送消息
            </label>
            <textarea
              id="message"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="给这个频道发送指令…  使用 @智能体 指定接球人"
              ref={composerRef}
              rows={1}
              value={draft}
            />
            <div className="composer__actions">
              <span>↵ 发送 · ⇧↵ 换行</span>
              <button
                aria-label="发送消息"
                disabled={!draft.trim()}
                type="submit"
              >
                <Icon name="send" />
              </button>
            </div>
          </form>
        </section>

        <aside
          className={`inspector mobile-panel${mobilePanel === 'inspector' ? ' is-mobile-active' : ''}`}
        >
          <div className="inspector-heading">
            <span>$ 派对时刻 状态</span>
            <ServicePulse />
          </div>

          <section className="metric-strip" aria-label="服务指标">
            <div>
              <strong>02</strong>
              <span>已连接频道</span>
            </div>
            <div>
              <strong>03</strong>
              <span>在线智能体</span>
            </div>
            <div>
              <strong>00</strong>
              <span>发送失败</span>
            </div>
          </section>

          <section className="inspector-section">
            <header>
              <div>
                <p className="eyebrow">当前工作</p>
                <h2>任务现场</h2>
              </div>
              <button
                aria-label="新建任务"
                onClick={() => setToast('任务创建器将在接入本地服务后开放')}
                type="button"
              >
                <Icon name="plus" />
              </button>
            </header>
            <div className="task-stack">
              {initialTasks.map((task) => (
                <button
                  aria-label={`查看任务 ${task.id} ${task.title}`}
                  className={
                    selectedTask?.id === task.id
                      ? 'task-card is-active'
                      : 'task-card'
                  }
                  key={task.id}
                  onClick={() => setSelectedTaskId(task.id)}
                  type="button"
                >
                  <span className={`priority priority--${task.priority}`} />
                  <span className="task-card__top">
                    <b>{task.id}</b>
                    <small>{stateLabels[task.state]}</small>
                  </span>
                  <strong>{task.title}</strong>
                  <span className="task-card__meta">
                    <span>@{task.assignee}</span>
                    <span>{task.progress}%</span>
                  </span>
                  <span className="progress">
                    <i style={{ width: `${task.progress}%` }} />
                  </span>
                </button>
              ))}
            </div>
          </section>

          <footer className="inspector-footer">
            <span>实例：本地-01</span>
            <span>版本 0.1.0</span>
          </footer>
        </aside>
      </div>

      {isCommandOpen ? (
        <div
          className="modal-backdrop"
          onMouseDown={() => setIsCommandOpen(false)}
        >
          <section
            aria-label="快速操作"
            aria-modal="true"
            className="command-palette"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="command-search">
              <Icon name="search" />
              <input autoFocus placeholder="输入一个操作…" />
              <kbd>退出</kbd>
            </div>
            <p>推荐操作</p>
            <button onClick={() => commandAction('message')} type="button">
              <span>›</span> 发送频道消息 <kbd>1</kbd>
            </button>
            <button onClick={() => commandAction('channel')} type="button">
              <Icon name="plus" /> 新建本地频道 <kbd>2</kbd>
            </button>
            <button onClick={() => commandAction('theme')} type="button">
              <Icon name="moon" /> 切换纸感 / 暗夜 <kbd>3</kbd>
            </button>
            <button onClick={() => commandAction('settings')} type="button">
              <Icon name="gear" /> 服务设置 <kbd>4</kbd>
            </button>
          </section>
        </div>
      ) : null}

      {isSettingsOpen ? (
        <div
          className="modal-backdrop"
          onMouseDown={() => setIsSettingsOpen(false)}
        >
          <section
            aria-labelledby="settings-title"
            aria-modal="true"
            className="settings-card"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header>
              <div>
                <p className="eyebrow">本地偏好</p>
                <h2 id="settings-title">设置</h2>
              </div>
              <button
                aria-label="关闭设置"
                className="icon-button"
                onClick={() => setIsSettingsOpen(false)}
                type="button"
              >
                <Icon name="close" />
              </button>
            </header>

            <div className="setting-row">
              <div>
                <strong>主题</strong>
                <span>只保存在当前浏览器。</span>
              </div>
              <div className="segmented">
                <button
                  className={theme === 'paper' ? 'is-active' : ''}
                  onClick={() => setTheme('paper')}
                  type="button"
                >
                  纸感
                </button>
                <button
                  className={theme === 'night' ? 'is-active' : ''}
                  onClick={() => setTheme('night')}
                  type="button"
                >
                  暗夜
                </button>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <strong>信息密度</strong>
                <span>紧凑模式会收短消息间距。</span>
              </div>
              <button
                className={`switch${isCompact ? ' is-on' : ''}`}
                onClick={() => setIsCompact((value) => !value)}
                type="button"
              >
                <i />
              </button>
            </div>
            <div className="setting-row setting-row--stacked">
              <div>
                <strong>本地服务</strong>
                <span>网页连接能力将在接口代理接入后启用。</span>
              </div>
              <div className="service-address">
                <span>回环地址 · 43120</span>
                <em>演示数据</em>
              </div>
            </div>
            <div className="settings-note">
              <Icon name="warning" />
              <p>
                访问凭据不会展示在页面或写入仓库。当前界面使用演示数据验证信息架构与交互。
              </p>
            </div>
            <footer>
              <button
                className="secondary-button"
                onClick={() => setIsSettingsOpen(false)}
                type="button"
              >
                取消
              </button>
              <button
                className="primary-button"
                onClick={() => {
                  setIsSettingsOpen(false);
                  setToast('偏好已应用');
                }}
                type="button"
              >
                应用设置
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {toast ? (
        <div className="toast">
          <Icon name="check" /> {toast}
        </div>
      ) : null}
    </main>
  );
}
