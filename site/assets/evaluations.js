(function () {
  'use strict';
  const form = document.querySelector('[data-filters]');
  const search = document.getElementById('search');
  const pluginFilter = document.getElementById('plugin');
  const modelFilter = document.getElementById('model');
  const evidenceFilter = document.getElementById('evidence');
  const count = document.getElementById('result-count');
  const groups = [...document.querySelectorAll('[data-plugin]')];

  function applyFilters() {
    const query = search.value.trim().toLowerCase();
    let skills = 0;
    let plugins = 0;
    for (const group of groups) {
      const pluginMatches = !pluginFilter.value || group.dataset.plugin === pluginFilter.value;
      const pluginTextMatches = group.dataset.pluginSearch.includes(query);
      const rows = [...group.querySelectorAll('[data-skill]')];
      let visible = 0;
      for (const row of rows) {
        const evidence = [...row.querySelectorAll('[data-evidence-model]')];
        const mode = evidenceFilter.value;
        let matchingEvidence = 0;
        for (const result of evidence) {
          const modelMatches = !modelFilter.value || result.dataset.evidenceModel === modelFilter.value;
          const stateMatches = !mode || mode === 'evaluated' ||
            (mode === 'current' && result.dataset.current === 'true') ||
            (mode === 'attention' && result.dataset.attention === 'true');
          result.hidden = !(modelMatches && stateMatches);
          if (!result.hidden) matchingEvidence += 1;
        }
        const evidenceMatches = evidence.length ? matchingEvidence > 0 :
          !modelFilter.value && (!mode || mode === 'not-evaluated');
        row.hidden = !(pluginMatches && evidenceMatches && (pluginTextMatches || row.dataset.search.includes(query)));
        if (!row.hidden) visible += 1;
      }
      // External inventories stay visible without pretending their featured catalog
      // entries are discovered skills. A model/evidence filter cannot match unknowns.
      group.hidden = rows.length ? visible === 0 : !(pluginMatches && pluginTextMatches && !modelFilter.value && !evidenceFilter.value);
      if (!group.hidden) plugins += 1;
      skills += visible;
    }
    count.textContent = `${skills} skill${skills === 1 ? '' : 's'} across ${plugins} plugin${plugins === 1 ? '' : 's'}`;
    document.getElementById('no-results').hidden = plugins > 0;
  }
  form.hidden = false;
  form.addEventListener('input', applyFilters);
  form.addEventListener('change', applyFilters);
  form.addEventListener('submit', (event) => event.preventDefault());
  form.addEventListener('reset', () => window.setTimeout(applyFilters, 0));
}());
