import { resolveLocale, persistLocale, translate, formatTimestamp, stateKey } from '@supervisor/core/i18n';
'use strict';
// Pure policy functions shared with the Node unit tests.
export const SupervisorLive = Object.freeze({
  needsRefresh(event, current) {
    return event?.type === 'changed' && Number.isSafeInteger(event.version) && event.version >= 0 && event.version > current;
  },
  reconnectDelay(attempt, random = Math.random()) {
    const ceiling = Math.min(30000, 1000 * 2 ** Math.min(16, Math.max(0, attempt)));
    return Math.round(ceiling * (0.5 + Math.min(1, Math.max(0, random)) * 0.5));
  },
  // MCP/DO records may carry partial or malformed links (e.g. only slack/changes);
  // every renderer expects all five slots as arrays of objects.
  normalizeLinks(links) {
    const source = links && typeof links === 'object' && !Array.isArray(links) ? links : {};
    const out = {};
    for (const key of ['slack', 'changes', 'preview', 'issues', 'other']) {
      out[key] = Array.isArray(source[key]) ? source[key].filter(item => item && typeof item === 'object') : [];
    }
    return out;
  },
  normalizeRecords(records) {
    return (Array.isArray(records) ? records : []).filter(r => r && typeof r === 'object').map(r => ({ ...r, links: SupervisorLive.normalizeLinks(r.links) }));
  },
});
// Theme policy stays independent of the DOM and resilient to blocked storage.
export const SupervisorTheme = Object.freeze({
  resolve(storage) {
    try {
      const value = storage().getItem('supervisor.theme');
      if (['light', 'dark', 'system'].includes(value)) return value;
    } catch { /* Storage can be unavailable. */ }
    return 'system';
  },
  persist(storage, value) {
    if (!['light', 'dark', 'system'].includes(value)) return;
    try { storage().setItem('supervisor.theme', value); } catch { /* Keep the in-memory choice. */ }
  },
  effective(choice, dark) { return choice === 'system' ? (dark ? 'dark' : 'light') : choice; },
});
if (typeof document !== 'undefined') {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let theme = SupervisorTheme.resolve(() => window.localStorage);
  const applyTheme = () => {
    document.documentElement.dataset.theme = SupervisorTheme.effective(theme, media.matches);
    const control = /** @type {HTMLSelectElement} */ (document.getElementById('theme'));
    if (control) control.value = theme;
    const wrapper = document.querySelector('.theme-control');
    if (wrapper instanceof HTMLElement) wrapper.dataset.themeChoice = theme;
  };
  // The external bundle runs in the head before the stylesheet and first paint.
  applyTheme();
  media.addEventListener('change', () => { if (theme === 'system') applyTheme(); });
  document.addEventListener('DOMContentLoaded', async () => {
  const themeControl = /** @type {HTMLSelectElement} */ (document.getElementById('theme'));
  themeControl.addEventListener('change', () => {
    const value = themeControl.value;
    if (!['light', 'dark', 'system'].includes(value)) return;
    theme = value;
    SupervisorTheme.persist(() => window.localStorage, theme);
    applyTheme();
  });
  applyTheme();
  const serverLocale = document.querySelector('meta[name="supervisor-locale"]')?.getAttribute('content');
  let locale = resolveLocale(() => window.localStorage, serverLocale, navigator.languages);
  const localeControl = /** @type {HTMLSelectElement} */ (document.getElementById('locale'));
  const t = (key, values = {}) => translate(locale, key, values);
  function applyShell() {
    document.documentElement.lang = locale;
    document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.getAttribute('data-i18n')); });
    for (const attribute of ['content', 'placeholder', 'aria-label', 'title']) {
      document.querySelectorAll('[data-i18n-' + attribute + ']').forEach(node => node.setAttribute(attribute, t(node.getAttribute('data-i18n-' + attribute))));
    }
    localeControl.value = locale;
  }
  let localeChanged = () => {};
  localeControl.addEventListener('change', () => {
    const value = localeControl.value;
    if (value !== 'en' && value !== 'cs') return;
    locale = value; persistLocale(() => window.localStorage, locale); applyShell(); localeChanged();
  });
  applyShell();
  const configuredDataUrl = (/** @type {HTMLMetaElement} */ (document.querySelector('meta[name="supervisor-data-url"]')))?.content;
  const dataUrl = configuredDataUrl || './data.json';
  let data = window.SUPERVISOR_DATA;
  if (configuredDataUrl) {
    try {
      const response = await fetch(dataUrl, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
      if (!response.ok) throw new Error('Data unavailable');
      data = await response.json();
    } catch { data = null; }
  }
  if (!data || !Array.isArray(data.records)) {
    const error = document.getElementById('result-count');
    error.dataset.i18n = 'dataError'; error.textContent = t('dataError');
    return;
  }
  let records = SupervisorLive.normalizeRecords(data.records);
  /** @type {<T extends string>(id: T) => SupervisorElement<T>} */
  const $ = (id) => /** @type {any} */ (document.getElementById(id));
  const controls = { search: $('search'), state: $('state'), sort: $('sort'), done: $('include-done'), you: $('waiting-you') };
  const params = new URLSearchParams(location.search);
  let agent = params.get('agent');
  const fold = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const formatDate = value => formatTimestamp(value, locale, data.timezone || 'UTC');
  const stateLabel = record => record.generatedLabels?.state ? t(record.generatedLabels.state, record.generatedLabels.values) : record.stateLabel || t(stateKey(record.state));
  const kindLabel = record => record.generatedLabels?.kind ? t(record.generatedLabels.kind) : record.kind;
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  function safeLink(item) {
    let parsed;
    try { parsed = new URL(item.url); } catch { return null; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    const link = el('a', item.label);
    link.href = parsed.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }
  function linkList(container, items, missing = t('missing')) {
    if (!items.length) { container.append(el('span', missing, 'missing')); return; }
    const list = el('div', undefined, 'link-list');
    items.forEach(item => { const link = safeLink(item); if (link) list.append(link); });
    container.append(list);
  }
  function updateStates() {
    const selected = controls.state.selectedIndex > 0 ? controls.state.value : null;
    const labels = new Map(records.map(r => [r.state, stateLabel(r)]));
    const all = el('option', t('allStates')); all.value = '';
    controls.state.replaceChildren(all);
    [...labels].sort((a, b) => a[1].localeCompare(b[1], locale)).forEach(([value, label]) => {
      const option = el('option', label); option.value = value; controls.state.append(option);
    });
    controls.state.selectedIndex = Math.max(0, [...controls.state.options].findIndex((option, index) => index > 0 && option.value === selected));
  }
  updateStates();
  controls.search.value = params.get('q') || '';
  controls.state.selectedIndex = Math.max(0, [...controls.state.options].findIndex((option, index) => index > 0 && option.value === params.get('state')));
  const selectedState = () => controls.state.selectedIndex > 0 ? controls.state.value : null;
  controls.sort.value = ['checked-desc', 'checked-asc', 'name'].includes(params.get('sort')) ? params.get('sort') : 'checked-desc';
  controls.done.checked = params.get('done') === '1' || selectedState() === 'done';
  controls.you.checked = params.get('you') === '1';
  function updateAgents() {
    const actors = [...new Set(records.map(r => r.agent || r.project).filter(Boolean))].sort();
    if (!actors.includes(agent)) agent = null;
    const tabs = document.querySelector('.agent-tabs');
    tabs.replaceChildren();
    for (const actor of [null, ...actors]) {
      const button = el('button', actor === null ? t('allAgents') + ' ' : actor + ' ');
      button.type = 'button'; button.dataset.agent = actor ?? '';
      button.append(el('span', String(records.filter(r => actor === null || (r.agent || r.project) === actor).length)));
      button.addEventListener('click', () => { agent = actor; render(); });
      tabs.append(button);
    }
  }
  updateAgents();
  function cell(label, cls) {
    const td = el('td', undefined, cls); td.dataset.label = label; return td;
  }
  const SLOTS = [['issue', 'issueSlot'], ['change', 'changeSlot'], ['preview', 'previewSlot']];
  const priorityLabels = { highest: 'priorityHighest', high: 'priorityHigh', medium: 'priorityMedium', low: 'priorityLow', lowest: 'priorityLowest' };
  const priorityRank = { highest: 5, high: 4, medium: 3, low: 2, lowest: 1 };

  function nextActionBlock(action) {
    const box = el('div', undefined, 'owner-action');
    // Action badge is shown with task metadata; links share one column.
    const list = el('ul', undefined, 'review-links');
    list.setAttribute('aria-label', t('linksFor', { label: action.label }));
    SLOTS.forEach(([slot, label]) => {
      const item = (action.links || {})[slot] || { state: 'missing' };
      const li = el('li'); li.append(el('span', t(label) + ': ', 'slot-label'));
      const links = item.state === 'linked' && Array.isArray(item.items) ? item.items.filter(entry => entry && typeof entry === 'object').map(entry => [entry, safeLink(entry)]).filter(([, link]) => link) : [];
      if (links.length) links.forEach(([entry, link], index) => {
        if (index) li.append(document.createTextNode(', '));
        li.append(link);
        if (slot === 'preview' && !entry.revisionVerified) li.append(el('span', t('unverifiedRevision'), 'missing'));
      });
      else li.append(el('span', item.state === 'not_relevant' ? t('notRelevant') : t('missing'), 'missing'));
      list.append(li);
    });
    box.append(list);
    return box;
  }
  const priorityLevelOf = record => String(typeof record.priority === 'string' ? record.priority : record.priority?.level || '').trim().toLowerCase();
  // All attention UI consumes the authenticated per-viewer server projection.
  const needsYou = record => record.waitingOnYou === true;
  function recordActionBlock(record) {
    const fallback = { label: t('task'), links: {} };
    [['issue', record.links.issues], ['change', record.links.changes], ['preview', record.links.preview]].forEach(([slot, items]) => {
      fallback.links[slot] = { state: items.length ? 'linked' : 'missing', items };
    });
    return nextActionBlock(record.nextAction || fallback);
  }
  // The modal is the only detail view; keep its evidence layout in one builder.
  function detailContent(record) {
    const grid = el('div', undefined, 'detail-grid');
    function section(titleText, text) {
      const section = el('section'); section.append(el('h3', titleText), el('p', text || t('missing'))); grid.append(section); return section;
    }
    const next = section(t('nextStep'), record.nextStep);
    next.className = 'modal-next-action';
    if (record.nextAction?.label || record.waitingOn) next.append(el('p', record.nextAction?.label || t('waitingOn', { who: record.waitingOn }), 'waiting'));
    next.append(recordActionBlock(record));
    section(t('lastResult'), record.status);
    const context = section(t('context'), record.goal);
    const metadata = el('dl', undefined, 'record-metadata');
    [[t('owner'), record.owner || t('missing')], [t('checked'), formatDate(record.checkedAt)],
      [t('evidenceDate'), formatDate(record.sourceAt)], [t('updated'), formatDate(record.updatedAt)]].forEach(([label, value]) => {
      const item = el('div'); item.append(el('dt', label), el('dd', value)); metadata.append(item);
    });
    context.append(metadata);
    const sources = el('section'); sources.append(el('h3', t('evidenceLinks')));
    [[t('slackThreads'), record.links.slack], [t('changes'), record.links.changes], [t('previews'), record.links.preview], [t('otherSources'), [...record.links.issues, ...record.links.other]]].forEach(([label, items]) => {
      if (!items.length) return;
      sources.append(el('h4', label)); linkList(sources, items);
    });
    if (record.links.preview.length) sources.append(el('p', t('previewNote'), 'preview-note'));
    if (record.relatedRecords && record.relatedRecords.length > 1) {
      const related = section(t('related'), ''); related.lastChild.remove();
      record.relatedRecords.forEach(item => related.append(el('p', item.name + ': ' + item.status)));
    }
    grid.append(sources);
    return grid;
  }
  function recordRow(record) {
    const tr = el('tr', undefined, 'summary-row'); tr.dataset.recordId = record.id;
    const name = cell(t('taskAgent'), 'task-cell');
    if (needsYou(record)) tr.classList.add('needs-you');
    const title = el('h2', undefined, 'task-title');
    const titleButton = el('button', record.name, 'record-title-button'); titleButton.type = 'button';
    titleButton.setAttribute('aria-haspopup', 'dialog');
    titleButton.addEventListener('click', () => openRecord(record.id, titleButton));
    title.append(titleButton);
    title.title = record.name;
    const tags = el('div', undefined, 'tags');
    tags.append(el('span', record.agent, 'agent-tag ' + record.project));
    if (kindLabel(record)) tags.append(el('span', kindLabel(record), 'kind'));
    if (needsYou(record)) {
      const attention = el('span', t('attention'), 'attention-tag');
      attention.title = record.nextAction?.label || record.waitingOn;
      tags.prepend(attention);
    }
    name.append(title, tags);
    const priorityLevel = priorityLevelOf(record);
    const priority = priorityLabels[priorityLevel] ? t(priorityLabels[priorityLevel]) : null;
    const priorityBadge = el('span', t('priority', { value: priority || t('unspecified') }), 'badge' + (priority ? '' : ' missing'));
    priorityBadge.title = record.priority?.source || (priority ? t('prioritySource') : t('priorityMissing'));
    tags.append(priorityBadge);
    if (record.implementer || record.nextAction) tags.append(el('span', t('implementer', { who: record.implementer || t('missing') }), record.implementer ? 'person' : 'person missing'));
    if (record.jiraAssignee) tags.append(el('span', t('jiraAssignee', { who: record.jiraAssignee }), 'person'));
    if (record.nextAction) name.append(el('span', record.nextAction.label, 'badge ' + (needsYou(record) ? 'waiting-you' : 'waiting-other')));
    const status = cell(t('state'), 'status-cell');
    status.append(el('span', stateLabel(record), 'badge state-' + record.state));
    const checked = cell(t('checked'), 'checked-cell');
    const time = el('time', formatDate(record.checkedAt));
    if (record.checkedAt) time.dateTime = record.checkedAt;
    checked.append(time);
    const links = cell(t('links'), 'summary-links');
    const shortLinks = [];
    if (record.links.slack.length) shortLinks.push({ ...record.links.slack[0], label: t('slack') });
    linkList(links, shortLinks, t('slackMissing'));
    links.append(recordActionBlock(record));
    const action = cell(t('link'), 'action-cell');
    action.append(copyLinkControl(record.id, record.name));
    tr.addEventListener('click', event => { if (!event.target.closest('a,button,input,select,label')) openRecord(record.id, titleButton); });
    tr.append(name, status, checked, links, action);
    return tr;
  }
  function render() {
    const query = fold(controls.search.value.trim());
    const state = selectedState();
    const filtered = records.filter(record =>
      (agent === null || (record.agent || record.project) === agent) &&
      (state === null || record.state === state) &&
      (controls.done.checked || record.state !== 'done' || state === 'done') &&
      (!controls.you.checked || needsYou(record)) &&
      (!query || fold([record.nextAction ? record.nextAction.label : '', record.implementer, record.jiraAssignee, record.name, record.goal, record.agent, record.owner, record.status, record.nextStep, record.waitingOn, record.recordId].join(' ')).includes(query))
    );
    filtered.sort((a, b) => {
      const attentionOrder = Number(needsYou(b)) - Number(needsYou(a));
      if (attentionOrder) return attentionOrder;
      const priorityOrder = (priorityRank[priorityLevelOf(b)] || 0) - (priorityRank[priorityLevelOf(a)] || 0);
      if (priorityOrder) return priorityOrder;
      if (controls.sort.value === 'name') return a.name.localeCompare(b.name, locale);
      const at = Date.parse(a.checkedAt) || 0, bt = Date.parse(b.checkedAt) || 0;
      return (controls.sort.value === 'checked-asc' ? at - bt : bt - at) || a.name.localeCompare(b.name, locale);
    });
    $('rows').replaceChildren(...filtered.map(recordRow));
    $('empty').hidden = filtered.length > 0;
    $('result-count').textContent = t('resultCount', { shown: filtered.length, total: records.length });
    (/** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('[data-agent]'))).forEach(button => button.setAttribute('aria-pressed', String(button.dataset.agent === (agent ?? ''))));
    const nextParams = new URLSearchParams();
    if (agent !== null) nextParams.set('agent', agent);
    if (controls.search.value.trim()) nextParams.set('q', controls.search.value.trim());
    if (state !== null) nextParams.set('state', state);
    if (controls.done.checked) nextParams.set('done', '1');
    if (controls.you.checked) nextParams.set('you', '1');
    if (controls.sort.value !== 'checked-desc') nextParams.set('sort', controls.sort.value);
    if (selectedRecordId !== null) nextParams.set('record', selectedRecordId);
    try { history.replaceState(history.state, '', location.pathname + (nextParams.size ? '?' + nextParams.toString() : '') + location.hash); } catch { /* file demo may disallow history */ }
  }
  // replaceState keeps transient details out of the history stack. Filters and
  // the selected DO id share the same query; copied links deliberately do not.
  let selectedRecordId = params.has('record') ? params.get('record') : null;
  const dialog = $('record-dialog'), modalContent = $('record-modal-content');
  let returnTrigger = null, returnRecordId = null, renderedRecordId = null;
  function syncRecordUrl() {
    const url = new URL(location.href);
    if (selectedRecordId === null) url.searchParams.delete('record');
    else url.searchParams.set('record', selectedRecordId);
    try { history.replaceState(history.state, '', url); } catch { /* file demo may disallow history */ }
  }
  function directRecordUrl(id) {
    // A file demo still supports details and manual copying without throwing.
    const root = location.protocol === 'file:' ? location.href.split(/[?#]/)[0] : location.origin + '/';
    return root + '?record=' + encodeURIComponent(id);
  }
  function linkIcon() {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.7');
    icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(icon.namespaceURI, 'path');
    path.setAttribute('d', 'M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7');
    icon.append(path); return icon;
  }
  let messageTimer;
  function linkStatus(status, message) {
    clearTimeout(messageTimer);
    $('link-status').textContent = ''; $('modal-link-status').textContent = '';
    status.textContent = message;
    messageTimer = setTimeout(() => { status.textContent = ''; }, 2000);
  }
  function copyLinkControl(id, name) {
    const group = el('div', undefined, 'copy-link-control');
    const button = el('button', undefined, 'copy-link-button icon-button'); button.type = 'button';
    button.setAttribute('aria-label', name ? t('copyFor', { name }) : t('copy'));
    button.title = t('copy'); button.append(linkIcon());
    const fallback = el('label', t('copyField'), 'copy-link-fallback'); fallback.hidden = true;
    const input = el('input'); input.type = 'text'; input.readOnly = true; input.value = directRecordUrl(id);
    input.addEventListener('click', () => input.select());
    fallback.append(input); group.append(button, fallback);
    button.addEventListener('click', async () => {
      const status = dialog.open ? $('modal-link-status') : $('link-status');
      try {
        await navigator.clipboard.writeText(directRecordUrl(id));
        fallback.hidden = true; linkStatus(status, t('copied'));
      } catch {
        fallback.hidden = false; input.focus(); input.select();
        linkStatus(status, t('copyFallback'));
      }
    });
    return group;
  }
  function openRecord(id, trigger) {
    selectedRecordId = id; returnTrigger = trigger; returnRecordId = id;
    syncRecordUrl(); renderRecordModal();
  }
  function closeRecord() {
    selectedRecordId = null; syncRecordUrl();
    if (dialog.open) dialog.close();
    document.body.classList.remove('record-modal-open');
    clearTimeout(messageTimer); $('modal-link-status').textContent = '';
    // Snapshot rendering replaces row nodes. Find the same trigger again if needed.
    const row = [...(/** @type {NodeListOf<HTMLTableRowElement>} */ ($('rows').querySelectorAll('.summary-row')))].find(node => node.dataset.recordId === returnRecordId);
    const trigger = returnTrigger?.isConnected ? returnTrigger : row?.querySelector('.record-title-button');
    (trigger || $('records')).focus({ preventScroll: true });
    returnTrigger = null; returnRecordId = null; renderedRecordId = null;
  }
  function renderRecordModal() {
    if (selectedRecordId === null) return;
    const record = records.find(item => item.id === selectedRecordId);
    $('record-modal-title').textContent = record ? record.name : t('notFoundTitle');
    const meta = [];
    if (record) {
      const rev = el('span', t('revision'), 'record-revision'), value = el('span', record.rev ?? t('missing'));
      value.dataset.field = 'rev'; rev.append(value);
      meta.push(el('span', stateLabel(record), 'badge state-' + record.state), el('span', record.agent, 'agent-tag ' + record.project), rev);
    }
    const id = el('code', selectedRecordId, 'record-id'); id.id = 'record-modal-id'; id.setAttribute('aria-label', t('recordId'));
    $('record-modal-meta').replaceChildren(...meta, id);
    if (renderedRecordId !== selectedRecordId) {
      $('record-modal-actions').replaceChildren(copyLinkControl(selectedRecordId));
      if (typeof navigator.share === 'function') {
        const share = el('button', t('share'), 'text-button'); share.type = 'button';
        share.addEventListener('click', async () => {
          try { await navigator.share({ title: $('record-modal-title').textContent, url: directRecordUrl(selectedRecordId) }); }
          catch (error) { if (error.name !== 'AbortError') linkStatus($('modal-link-status'), t('shareError')); }
        });
        $('record-modal-share').replaceChildren(share);
      }
      $('modal-link-status').textContent = '';
      renderedRecordId = selectedRecordId;
    }
    const scroll = modalContent.scrollTop;
    const focused = modalContent.contains(document.activeElement) ? document.activeElement : null;
    const focusedHref = focused?.getAttribute('href');
    if (record) {
      modalContent.replaceChildren(detailContent(record));
    } else modalContent.replaceChildren(el('p', t('notFound'), 'record-not-found'));
    // Keep the dialog shell, copy controls, focus and reading position during WS updates.
    if (focused) {
      const replacement = focusedHref && [...modalContent.querySelectorAll('a')].find(link => link.getAttribute('href') === focusedHref);
      (replacement || $('record-modal-close')).focus({ preventScroll: true });
    }
    modalContent.scrollTop = scroll;
    if (!dialog.open) {
      dialog.showModal(); document.body.classList.add('record-modal-open');
      $('record-modal-close').focus({ preventScroll: true });
    }
  }
  $('record-modal-close').addEventListener('click', closeRecord);
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeRecord(); });
  let backdropPointer = false;
  function outsideDialog(event) {
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  }
  dialog.addEventListener('pointerdown', event => { backdropPointer = event.target === dialog && outsideDialog(event); });
  dialog.addEventListener('click', event => { if (backdropPointer && event.target === dialog && outsideDialog(event)) closeRecord(); backdropPointer = false; });
  window.addEventListener('popstate', () => {
    const urlParams = new URLSearchParams(location.search);
    selectedRecordId = urlParams.has('record') ? urlParams.get('record') : null;
    if (selectedRecordId === null) closeRecord(); else renderRecordModal();
  });
  $('filters').addEventListener('submit', event => event.preventDefault());
  controls.search.addEventListener('input', render);
  [controls.state, controls.sort, controls.done, controls.you].forEach(control => control.addEventListener('change', render));
  $('reset').addEventListener('click', () => {
    agent = null; controls.search.value = ''; controls.state.selectedIndex = 0; controls.sort.value = 'checked-desc'; controls.done.checked = false; controls.you.checked = false; render();
  });
  function updateTab() {
    const attentionCount = records.filter(needsYou).length;
    document.title = attentionCount ? '(' + attentionCount + ') ' + t('appTitle') : t('appTitle');
    const icon = $('supervisor-favicon');
    const href = attentionCount ? './favicon-review.svg' : './favicon.svg';
    if (icon.getAttribute('href') !== href) icon.setAttribute('href', href);
  }
  function updateSummary() {
    updateTab();
    $('published').textContent = formatDate(data.generatedAt) + ' · ' + (data.timezone || 'UTC');
    $('published').dateTime = data.generatedAt;
    $('stat-all').textContent = String(records.length);
    $('stat-open').textContent = String(records.filter(r => r.state !== 'done').length);
    $('stat-review').textContent = String(records.filter(r => ['review', 'verification'].includes(r.state)).length);
    $('stat-done').textContent = String(records.filter(r => r.state === 'done').length);
    updateAgents(); updateStates();
    $('revision').textContent = data.sourceRevision ? t('sourceRevision', { revision: data.sourceRevision.slice(0, 8) }) : '';
  }
  function setStatus(node, key) { node.dataset.i18n = key; node.textContent = t(key); }
  let refreshing = false, refreshAgain = false;
  let currentVersion = Number.isSafeInteger(data.version) ? data.version : 0;
  async function checkForUpdate() {
    if (location.protocol === 'file:') return;
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    try {
      const response = await fetch(dataUrl, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
      if (!response.ok) throw new Error('Update unavailable');
      const next = await response.json();
      if (!Array.isArray(next.records) || next.schemaVersion !== 1) throw new Error('Invalid update');
      if (Number.isSafeInteger(next.version) && next.version < currentVersion) return;
      if (next.generatedAt !== data.generatedAt || next.version !== data.version) {
        const { scrollX, scrollY } = window;
        data = next; records = SupervisorLive.normalizeRecords(next.records);
        if (Number.isSafeInteger(next.version)) currentVersion = next.version;
        updateSummary(); render(); renderRecordModal();
        window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
        setStatus($('refresh-status'), 'refreshNew');
      } else setStatus($('refresh-status'), 'refreshIdle');
    } catch { setStatus($('refresh-status'), 'refreshError'); }
    finally {
      refreshing = false;
      if (refreshAgain) { refreshAgain = false; queueMicrotask(checkForUpdate); }
    }
  }
  setInterval(checkForUpdate, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
  localeChanged = () => {
    updateSummary(); render(); renderedRecordId = null; renderRecordModal();
    $('link-status').textContent = ''; $('modal-link-status').textContent = '';
  };
  updateSummary();
  render();
  renderRecordModal();
  // Static builds contain no opt-in meta: no connection attempts or UI changes.
  const wsPath = (/** @type {HTMLMetaElement} */ (document.querySelector('meta[name="supervisor-ws-url"]')))?.content;
  if (wsPath && typeof WebSocket !== 'undefined' && location.protocol !== 'file:') {
    const wsUrl = new URL(wsPath, location.href);
    if (wsUrl.origin !== location.origin) return;
    wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const indicator = el('span', t('reconnecting'), 'connection-status');
    indicator.id = 'connection-status'; indicator.setAttribute('role', 'status');
    $('refresh-status').after(indicator);
    let socket, timer, heartbeat, attempt = 0, stopped = false, lastPong = 0;
    function status(value) { setStatus(indicator, value); }
    status('reconnecting');
    function reconnect() {
      clearInterval(heartbeat);
      if (stopped) return;
      status(navigator.onLine ? 'reconnecting' : 'offline');
      clearTimeout(timer);
      if (navigator.onLine) timer = setTimeout(connect, SupervisorLive.reconnectDelay(attempt++));
    }
    function connect() {
      if (stopped || !navigator.onLine) { reconnect(); return; }
      try { socket = new WebSocket(wsUrl); } catch { reconnect(); return; }
      socket.onopen = () => {
        attempt = 0; lastPong = Date.now(); status('live');
        checkForUpdate(); // Also catches writes made while disconnected.
        heartbeat = setInterval(() => {
          if (Date.now() - lastPong > 60000) { socket.close(); return; }
          if (socket.readyState === WebSocket.OPEN) socket.send('ping');
        }, 25000);
      };
      socket.onmessage = event => {
        if (event.data === 'pong') { lastPong = Date.now(); return; }
        try { if (SupervisorLive.needsRefresh(JSON.parse(event.data), currentVersion)) checkForUpdate(); } catch { /* ignore malformed frames */ }
      };
      socket.onclose = reconnect;
      socket.onerror = () => { status(navigator.onLine ? 'reconnecting' : 'offline'); };
    }
    window.addEventListener('offline', () => { status('offline'); clearTimeout(timer); socket?.close(); });
    window.addEventListener('online', () => { clearTimeout(timer); if (!socket || socket.readyState > WebSocket.OPEN) connect(); });
    window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); clearInterval(heartbeat); socket?.close(); });
    window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; connect(); } });
    connect();
  }
  }, { once: true });
}
