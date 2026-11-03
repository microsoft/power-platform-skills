(function () {
  'use strict';

  const STORAGE_KEY = 'power-platform-skills.assistant';
  const COPIED_MS = 2000;
  const announcer = document.getElementById('announcer');

  function announce(message) {
    if (!announcer) return;
    // Clearing first makes screen readers repeat a message that is identical to the last one.
    announcer.textContent = '';
    window.setTimeout(() => {
      announcer.textContent = message;
    }, 50);
  }

  // ── Copy buttons ─────────────────────────────────────────────
  // The Clipboard API needs a secure context, which a file:// preview is not, so fall back to
  // a temporary textarea and execCommand there.
  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) throw new Error('Copy failed');
  }

  document.querySelectorAll('.copy-button[hidden]').forEach((button) => {
    button.hidden = false;
  });

  document.addEventListener('click', async (event) => {
    const trigger = event.target.closest('[data-copy]');
    if (!trigger) return;
    event.preventDefault();
    // Buttons with hidden context text keep their visible label in [data-button-label], so
    // only that part changes to "Copied".
    const labelEl = trigger.querySelector('[data-button-label]') || trigger;
    const label = trigger.dataset.label || labelEl.textContent;
    try {
      await copyText(trigger.dataset.copy);
    } catch {
      // A link with data-copy also points at the plugin page, where the text can be selected.
      if (trigger.tagName === 'A') {
        window.location.href = trigger.href;
        return;
      }
      announce('Copy failed. Select the text and copy it instead.');
      return;
    }
    labelEl.textContent = 'Copied';
    trigger.setAttribute('data-copied', '');
    announce('Copied to the clipboard');
    window.setTimeout(() => {
      labelEl.textContent = label;
      trigger.removeAttribute('data-copied');
    }, COPIED_MS);
  });

  // ── Assistant choice ────────────────────────────────────────
  // styles.css shows the matching install options with :has(), so this only remembers the
  // choice between pages. Storage can be blocked in private windows, which is not an error.
  function readChoice() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function saveChoice(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // The choice simply resets on the next page.
    }
  }

  const saved = readChoice();
  document.querySelectorAll('[data-assistant-picker]').forEach((picker) => {
    if (saved) {
      picker.querySelectorAll('input[type="radio"]').forEach((input) => {
        if (input.value === saved) input.checked = true;
      });
    }
    picker.addEventListener('change', (event) => {
      if (event.target.matches('input[type="radio"]')) saveChoice(event.target.value);
    });
  });

  // ── Hero prompt ─────────────────────────────────────────────
  const hero = document.querySelector('[data-hero]');
  const pageData = document.getElementById('page-data');
  if (!hero || !pageData) return;

  const items = JSON.parse(pageData.textContent).hero || [];
  const textEl = hero.querySelector('[data-hero-text]');
  const linkEl = hero.querySelector('[data-hero-link]');
  const buttons = Array.from(hero.querySelectorAll('[data-hero-index]'));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let timer = null;

  function show(index, animate) {
    const item = items[index];
    if (!item) return;
    window.clearTimeout(timer);
    buttons.forEach((button) => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.heroIndex) === index));
    });
    linkEl.textContent = item.title;
    linkEl.href = item.href;
    if (!animate || reduceMotion) {
      textEl.textContent = item.prompt;
      return;
    }
    // Type at a slightly uneven pace so it reads like someone typing. A full prompt takes
    // about two seconds, well under the five seconds after which moving content needs a
    // pause control (WCAG 2.2.2).
    let shown = 0;
    const step = () => {
      shown += 1;
      textEl.textContent = item.prompt.slice(0, shown);
      if (shown < item.prompt.length) timer = window.setTimeout(step, 24 + Math.random() * 36);
    };
    textEl.textContent = '';
    step();
  }

  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.heroIndex);
      show(index, true);
      const item = items[index];
      if (item) announce(`${item.prompt}. Your assistant uses the ${item.title} plugin.`);
    });
  });

  show(0, true);
}());
