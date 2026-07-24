import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(
  new URL('../../app/globals.css', import.meta.url),
  'utf8',
);

function ruleBody(selector: RegExp) {
  const match = css.match(selector);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

test('人工介入状态使用稳定警示色且不播放运行态呼吸动画', () => {
  const cardRule = ruleBody(
    /\.collab-bug-card\[data-visual-state='waiting-interaction'\]\s*\{([^}]*)\}/s,
  );
  const stateRule = ruleBody(
    /\.collab-bug-card\[data-visual-state='waiting-interaction'\]\s+\.collab-bug-card__state\s*\{([^}]*)\}/s,
  );
  const runningRule = ruleBody(
    /\.collab-bug-card\[data-visual-state='running'\]\s*\{([^}]*)\}/s,
  );

  expect(cardRule).toContain('background:');
  expect(cardRule).toContain('var(--warning)');
  expect(stateRule).not.toContain('animation:');
  expect(runningRule).toContain('animation: collab-running-pulse');
});
