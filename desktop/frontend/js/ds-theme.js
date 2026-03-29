/**
 * ChatUCY Design System — Theme Toggle
 * Apply this script to pages that use the design system CSS.
 */
(function () {
  // Apply stored theme before paint to avoid flicker
  const stored = localStorage.getItem('chatucy-theme');
  const theme = stored === 'dark' || stored === 'light' ? stored : 'light';
  document.documentElement.dataset.theme = theme;

  function applyTheme(nextTheme) {
    const t = nextTheme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
    localStorage.setItem('chatucy-theme', t);
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.dataset.themeToggle === t);
    });
    window.dispatchEvent(new Event('themechange'));
  }

  document.addEventListener('DOMContentLoaded', function () {
    // Wire up all theme toggle buttons
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        applyTheme(btn.dataset.themeToggle);
      });
    });
    // Set initial active state
    applyTheme(document.documentElement.dataset.theme);
  });
})();
