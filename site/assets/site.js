(function () {
  'use strict';

  const root = document.documentElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const announcer = document.getElementById('announcer');

  function announce(message) {
    if (!announcer) return;
    // Clearing first makes screen readers repeat a message that is identical to the last one.
    announcer.textContent = '';
    window.setTimeout(() => {
      announcer.textContent = message;
    }, 50);
  }

  // Storage can be blocked in private windows. Every choice then lasts only for the page.
  function readStored(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStored(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch {
      // Nothing to do; the choice resets on the next page.
    }
  }

  // ── Color theme ─────────────────────────────────────────────
  // theme.js already applied the saved theme before paint. "system" removes data-theme so the
  // stylesheet follows prefers-color-scheme again.
  const THEME_KEY = 'power-platform-skills.theme';
  const THEME_COLORS = { light: '#f4f7f7', dark: '#08161f' };
  const themeSwitch = document.querySelector('[data-theme-switch]');

  function applyTheme(choice) {
    if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice);
    else root.removeAttribute('data-theme');
    // The browser chrome color follows the same choice. Each meta keeps its own media query,
    // so pinning a theme means giving both the chosen theme's color.
    document.querySelectorAll('meta[data-theme-color]').forEach((meta) => {
      meta.setAttribute('content', THEME_COLORS[choice in THEME_COLORS ? choice : meta.dataset.themeColor]);
    });
    if (themeSwitch) {
      themeSwitch.querySelectorAll('[data-theme-choice]').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.themeChoice === choice));
      });
    }
  }

  if (themeSwitch) {
    themeSwitch.hidden = false;
    applyTheme(root.getAttribute('data-theme') || 'system');
    themeSwitch.addEventListener('click', (event) => {
      const button = event.target.closest('[data-theme-choice]');
      if (!button) return;
      const choice = button.dataset.themeChoice;
      applyTheme(choice);
      writeStored(THEME_KEY, choice === 'system' ? null : choice);
      announce(choice === 'system' ? 'Theme matches your system' : `${choice === 'light' ? 'Light' : 'Dark'} theme`);
    });
  }

  // ── Mobile menu ─────────────────────────────────────────────
  const header = document.querySelector('.site-header');
  const menuButton = document.querySelector('[data-menu-button]');
  const nav = document.getElementById('site-nav');

  function setMenu(open, { returnFocus = false } = {}) {
    if (!header || !menuButton) return;
    menuButton.setAttribute('aria-expanded', String(open));
    if (open) {
      header.setAttribute('data-menu-open', '');
      const first = nav && nav.querySelector('a');
      if (first) first.focus();
    } else {
      header.removeAttribute('data-menu-open');
      if (returnFocus) menuButton.focus();
    }
  }

  if (menuButton && nav) {
    menuButton.addEventListener('click', () => {
      setMenu(menuButton.getAttribute('aria-expanded') !== 'true');
    });
    nav.addEventListener('click', (event) => {
      if (event.target.closest('a')) setMenu(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menuButton.getAttribute('aria-expanded') === 'true') {
        setMenu(false, { returnFocus: true });
      }
    });
    // The desktop layout shows the links inline, so an open menu state must not linger.
    window.matchMedia('(min-width: 64rem)').addEventListener('change', (event) => {
      if (event.matches) setMenu(false);
    });
  }

  // ── Copy buttons ────────────────────────────────────────────
  const COPIED_MS = 2000;

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
  // choice between pages.
  const ASSISTANT_KEY = 'power-platform-skills.assistant';
  const savedAssistant = readStored(ASSISTANT_KEY);
  document.querySelectorAll('[data-assistant-picker]').forEach((picker) => {
    if (savedAssistant) {
      picker.querySelectorAll('input[type="radio"]').forEach((input) => {
        if (input.value === savedAssistant) input.checked = true;
      });
    }
    picker.addEventListener('change', (event) => {
      if (event.target.matches('input[type="radio"]')) writeStored(ASSISTANT_KEY, event.target.value);
    });
  });

  // ── Install everything: pick the visitor's computer ─────────
  // Preselects the computer the browser reports, so most visitors see one command and two
  // steps. They can still pick another; styles.css swaps the steps with :has().
  const osPicker = document.querySelector('[data-os-picker]');
  const osHint = document.querySelector('[data-os-hint]');
  const installLinks = window.PowerPlatformSkillsInstallLinks;
  if (osPicker && osHint && installLinks) {
    const detected = installLinks.detectOs(window.navigator);
    const input = detected && osPicker.querySelector(`input[value="${detected}"]`);
    if (input) {
      input.checked = true;
      osHint.textContent = `Showing the steps for ${input.parentElement.textContent.trim()}, based on your browser. On a different computer? Pick it above.`;
    } else {
      osHint.textContent = 'Run this on the computer where you use your AI assistant. Pick its system above.';
    }
    osHint.hidden = false;
    // Once the visitor picks a system themselves, the hint must stop crediting the browser.
    osPicker.addEventListener('change', (event) => {
      if (!event.target.matches('input[type="radio"]')) return;
      osHint.textContent = `Showing the steps for ${event.target.parentElement.textContent.trim()}.`;
    });
  }

  // ── Hero session (the signature moment) ─────────────────────
  // The server renders the first example finished. With motion allowed, this replays it: the
  // request types in, the plugin answers, and each step lands in order, ending on the point
  // where the assistant waits for approval. The whole run takes about four seconds and then
  // stops, so it needs no pause control (WCAG 2.2.2).
  const session = document.querySelector('[data-session]');
  const pageData = document.getElementById('page-data');
  if (!session || !pageData) return;

  const scenarios = JSON.parse(pageData.textContent).scenarios || [];
  const promptEl = session.querySelector('[data-session-prompt]');
  const replyEl = session.querySelector('[data-session-reply]');
  const iconEl = session.querySelector('[data-session-icon]');
  const productEl = session.querySelector('[data-session-product]');
  const pluginEl = session.querySelector('[data-session-plugin]');
  const stepsEl = session.querySelector('[data-session-steps]');
  const linkEl = session.querySelector('[data-session-link]');
  const barEl = session.querySelector('.session-bar');
  const tabList = document.querySelector('[data-scenario-tabs]');
  const tabs = tabList ? Array.from(tabList.querySelectorAll('[role="tab"]')) : [];
  const panel = document.getElementById('session-panel');
  const doneIcon = document.getElementById('icon-done');
  const waitingIcon = document.getElementById('icon-waiting');

  let run = 0;
  const wait = (ms) => new Promise((resolve) => { window.setTimeout(resolve, ms); });

  function stepItem(text, state) {
    const item = document.createElement('li');
    item.className = `step is-${state}`;
    item.appendChild((state === 'waiting' ? waitingIcon : doneIcon).content.cloneNode(true));
    const label = document.createElement('span');
    label.className = 'step-text';
    label.textContent = text;
    item.appendChild(label);
    if (state === 'waiting') {
      const badge = document.createElement('span');
      badge.className = 'step-badge';
      badge.textContent = 'Your turn';
      item.appendChild(badge);
    }
    return item;
  }

  function setProgress(value) {
    if (barEl) barEl.style.setProperty('--progress', String(value));
  }

  async function play(index, animate) {
    const scenario = scenarios[index];
    if (!scenario) return;
    run += 1;
    const current = run;
    const stale = () => current !== run;

    tabs.forEach((tab, tabIndex) => {
      const selected = tabIndex === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    if (panel && tabs[index]) panel.setAttribute('aria-labelledby', tabs[index].id);
    iconEl.src = scenario.icon;
    productEl.textContent = scenario.product;
    pluginEl.textContent = `${scenario.title} plugin`;
    linkEl.href = scenario.href;
    linkEl.textContent = `See the ${scenario.title} plugin`;

    const states = scenario.steps.map((text) => [text, 'done']);
    if (scenario.waiting) states.push([scenario.waiting, 'waiting']);

    if (!animate || reduceMotion) {
      promptEl.textContent = scenario.prompt;
      stepsEl.replaceChildren(...states.map(([text, state]) => stepItem(text, state)));
      replyEl.removeAttribute('data-pending');
      session.removeAttribute('data-typing');
      setProgress(1);
      return;
    }

    // Every step is in place from the start, invisible, so the window keeps its final height
    // while the steps reveal. Appending them one by one would collapse the window and shift
    // the tabs under the pointer and the page below it.
    const items = states.map(([text, state]) => {
      const item = stepItem(text, state);
      item.setAttribute('data-entering', '');
      return item;
    });
    stepsEl.replaceChildren(...items);
    replyEl.setAttribute('data-pending', '');
    // Reserve the finished prompt's height too, so retyping it does not shrink the box.
    const promptBox = promptEl.parentElement;
    promptBox.style.minHeight = '';
    promptEl.textContent = scenario.prompt;
    promptBox.style.minHeight = `${promptBox.offsetHeight}px`;
    promptEl.textContent = '';
    setProgress(0);
    session.setAttribute('data-typing', '');

    const perChar = Math.min(38, Math.max(14, 1100 / scenario.prompt.length));
    for (let shown = 1; shown <= scenario.prompt.length; shown += 1) {
      promptEl.textContent = scenario.prompt.slice(0, shown);
      await wait(perChar);
      if (stale()) return;
    }
    session.removeAttribute('data-typing');
    // The full prompt now holds the height itself; dropping the reservation lets a later
    // resize reflow the box naturally.
    promptBox.style.minHeight = '';
    await wait(220);
    if (stale()) return;
    replyEl.removeAttribute('data-pending');

    for (const [position, item] of items.entries()) {
      await wait(position === 0 ? 260 : 460);
      if (stale()) return;
      item.removeAttribute('data-entering');
      setProgress((position + 1) / items.length);
    }
  }

  if (tabList && tabs.length > 1) {
    tabList.hidden = false;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tabs[0].id);
    tabList.addEventListener('click', (event) => {
      const tab = event.target.closest('[role="tab"]');
      if (tab) play(Number(tab.dataset.scenario), true);
    });
    // Arrow keys move between tabs and select them, per the ARIA tabs pattern.
    // https://www.w3.org/WAI/ARIA/apg/patterns/tabs/
    tabList.addEventListener('keydown', (event) => {
      const currentIndex = tabs.indexOf(document.activeElement);
      if (currentIndex === -1) return;
      const last = tabs.length - 1;
      const next = {
        ArrowRight: currentIndex === last ? 0 : currentIndex + 1,
        ArrowLeft: currentIndex === 0 ? last : currentIndex - 1,
        Home: 0,
        End: last,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      tabs[next].focus();
      play(next, true);
    });
  }

  play(0, true);
}());
