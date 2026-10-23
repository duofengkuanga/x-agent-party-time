import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionFacts } from './sessionFacts';

test('同一修复会话和 Agent 在多轮记录中只展示一次', () => {
  const html = renderToStaticMarkup(
    <SessionFacts
      label="修复会话"
      attempts={[
        { attempt: 1, sessionId: 'repair-session-a', agentName: '测试 Agent' },
        { attempt: 2, sessionId: 'repair-session-a', agentName: '测试 Agent' },
      ]}
    />,
  );
  expect(html.match(/repair-session-a/g)).toHaveLength(1);
  expect(html.match(/测试 Agent/g)).toHaveLength(1);
});

test('不同更新会话保留并标明对应轮次', () => {
  const html = renderToStaticMarkup(
    <SessionFacts
      label="更新会话"
      attempts={[
        { attempt: 1, sessionId: 'update-session-a' },
        { attempt: 2, sessionId: 'update-session-a' },
        { attempt: 3, sessionId: 'update-session-b' },
      ]}
    />,
  );
  expect(html.match(/update-session-a/g)).toHaveLength(1);
  expect(html.match(/update-session-b/g)).toHaveLength(1);
  expect(html).toContain('第 1、2 轮');
  expect(html).toContain('第 3 轮');
});

test('没有可见会话信息时不显示空配置区', () => {
  expect(
    renderToStaticMarkup(
      <SessionFacts
        label="更新会话"
        attempts={[{ attempt: 1, sessionId: null }]}
      />,
    ),
  ).toBe('');
});
