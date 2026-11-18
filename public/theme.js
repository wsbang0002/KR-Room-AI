(() => {
  const key = 'knuroom-theme';
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = value => value === 'dark' || value === 'light';
  let choice = null;

  try {
    const saved = window.localStorage.getItem(key);
    if (valid(saved)) choice = saved;
  } catch {
    // The switch still works in browsers that disable persistent storage.
  }

  function apply() {
    const theme = choice || (system.matches ? 'dark' : 'light');
    const dark = theme === 'dark';
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#152521' : '#f1efe5');
    const button = document.getElementById('themeToggle');
    if (!button) return;
    const nextLabel = dark ? '라이트 모드' : '다크 모드';
    button.setAttribute('aria-label', nextLabel + '로 전환');
    const label = button.querySelector('.theme-label');
    if (label) label.textContent = nextLabel;
  }

  apply();
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('themeToggle')?.addEventListener('click', () => {
      choice = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { window.localStorage.setItem(key, choice); } catch {}
      apply();
    });
  });
  system.addEventListener('change', apply);
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    choice = valid(event.newValue) ? event.newValue : null;
    apply();
  });
})();
