'use client';

import { useState } from 'react';

export function ThemeToggle() {
  const [theme, setTheme] = useState<'paper' | 'night'>('paper');
  return (
    <button
      aria-label={theme === 'paper' ? '切换暗夜主题' : '切换纸张主题'}
      className="collab-quiet-button"
      onClick={() => {
        const next = theme === 'paper' ? 'night' : 'paper';
        setTheme(next);
        document
          .querySelector('.project-settings-shell')
          ?.setAttribute('data-theme', next);
      }}
      type="button"
    >
      {theme === 'paper' ? '◐ 暗夜' : '◑ 纸张'}
    </button>
  );
}
