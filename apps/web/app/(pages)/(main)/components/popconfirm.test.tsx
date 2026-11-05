import { expect, test } from 'bun:test';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Popconfirm, type PopconfirmProps } from './popconfirm';

const props: PopconfirmProps = {
  label: '确认操作',
  title: '执行这个操作？',
  confirmLabel: '确认执行',
  pendingLabel: '正在执行…',
  open: true,
  onOpenChange: () => {},
  onConfirm: () => {},
};

test('回调确认可以放在已有表单内，不生成嵌套表单或意外提交按钮', () => {
  const html = renderToStaticMarkup(
    createElement('form', null, createElement(Popconfirm, props)),
  );
  expect(html.match(/<form\b/gu)).toHaveLength(1);
  expect(html.match(/type="button"/gu)).toHaveLength(3);
  expect(html).not.toContain('type="submit"');
});

test('表单确认只让确认按钮提交，取消按钮保留原生关闭行为', () => {
  const html = renderToStaticMarkup(
    createElement(Popconfirm, {
      label: props.label,
      title: props.title,
      confirmLabel: props.confirmLabel,
      pendingLabel: props.pendingLabel,
      open: true,
      onOpenChange: props.onOpenChange,
      submit: true,
    }),
  );
  expect(html.match(/type="submit"/gu)).toHaveLength(1);
  expect(html.match(/type="button"/gu)).toHaveLength(2);
  expect(html).toContain('popover="auto"');
  expect(html).toMatch(/popovertargetaction="hide"/iu);
});

test('提交中禁用所有操作并展示调用方的状态和错误', () => {
  const html = renderToStaticMarkup(
    createElement(Popconfirm, {
      ...props,
      pending: true,
      error: '该记录已更新',
    }),
  );
  expect(html.match(/disabled=""/gu)).toHaveLength(3);
  expect(html).toContain('正在执行…');
  expect(html).toContain('role="alert">该记录已更新');
  expect(html).toContain('aria-busy="true"');
});

test('操作不可用时仍可取消，确认面板始终使用脱离布局的原生浮层', () => {
  const open = renderToStaticMarkup(
    createElement(Popconfirm, {
      ...props,
      disabled: true,
    }),
  );
  expect(open.match(/disabled=""/gu)).toHaveLength(2);
  expect(open).toContain('popover="auto"');
  const closed = renderToStaticMarkup(
    createElement(Popconfirm, {
      ...props,
      open: false,
    }),
  );
  expect(closed).toContain('popover="auto"');
  expect(closed).toMatch(/popovertarget=/iu);
  expect(closed).toContain('aria-expanded="false"');
});

test('多处确认的标题、描述和触发按钮各自关联独立标识', () => {
  const html = renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      createElement(Popconfirm, { ...props, description: '不可恢复' }),
      createElement(Popconfirm, { ...props, description: '保留历史' }),
    ),
  );
  const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
  expect(ids).toHaveLength(6);
  expect(new Set(ids).size).toBe(6);
  const controls = [...html.matchAll(/aria-controls="([^"]+)"/gu)].map(
    (match) => match[1],
  );
  expect(controls).toHaveLength(2);
  expect(controls.every((id) => ids.includes(id))).toBe(true);
});
