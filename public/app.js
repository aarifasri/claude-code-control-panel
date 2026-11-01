// Browser UI. Plain JS, no framework.
// SECURITY: descriptions come from third-party plugins. Only ever insert them with
// textContent (via el()), never innerHTML, so they can't run script in this page.

const state = {
  items: [], tab: 'plugin', selectedId: null,
  costs: null, costsError: null,          // { [pluginId]: { alwaysOn, components: [{name, alwaysOn, onInvoke}], parseError } }
  mcp: null, mcpError: null,              // McpItem[]
  pendingId: null,                        // item with an action in flight
  restartNeeded: false,
  trash: [],                              // TrashEntry[]
  project: '',                            // '' = user view; else a project path from /api/projects
};

/** Query string for the current view; `fresh` asks the server to re-read the plugin list. */
function viewQuery(fresh = false) {
  const q = new URLSearchParams();
  if (state.project) q.set('project', state.project);
  if (fresh) q.set('fresh', '1');
  const s = q.toString();
  return s ? `?${s}` : '';
}
const $ = (sel) => document.querySelector(sel);
const TOKEN = document.querySelector('meta[name="ccp-token"]')?.content ?? '';

/** Create an element. Children may be strings (inserted as text) or nodes; null/undefined are skipped. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}

/** Replace a node's children, skipping null/undefined (replaceChildren would print them as "null"). */
function fill(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined));
}

const STATE_LABEL = { on: '● On', off: '○ Off', blocked: '⊘ Blocked', partial: '◐ Partial', unknown: '? Unknown' };
const MCP_LABEL = { connected: '● Connected', 'needs-auth': '◐ Needs sign-in', failed: '✘ Failed', 'not-configured': '○ Not configured', unknown: '? Unknown' };

function stateLabel(item) {
  return item.kind === 'mcp' ? MCP_LABEL[item.mcp.status] : STATE_LABEL[item.state] ?? item.state;
}

/** Where an item comes from: its plugin, the marketplace (for plugins), or standalone. */
function sourceLabel(item) {
  if (item.origin.type === 'plugin') return item.origin.pluginId.split('@')[0];
  if (item.origin.type === 'connector') return 'claude.ai';
  if (item.kind === 'plugin') return `marketplace: ${item.key.split('@')[1] ?? '?'}`;
  return 'standalone';
}

function fmtTokens(n) {
  if (n === undefined || n === null) return '';
  return n >= 1000 ? `~${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `~${n}`;
}

/** Token cost for an item, if the CLI reported one. Plugin components are matched by name. */
function costOf(item) {
  if (!state.costs) return undefined;
  if (item.kind === 'plugin') {
    const c = state.costs[item.key];
    return c && c.alwaysOn !== undefined ? { alwaysOn: c.alwaysOn } : undefined;
  }
  if (item.origin.type !== 'plugin') return undefined;
  const c = state.costs[item.origin.pluginId];
  const short = item.key.includes(':') ? item.key.slice(item.key.indexOf(':') + 1) : item.key;
  return c?.components.find((x) => x.name === short || x.name === item.name);
}

/** The action a switch click performs, or null when the item can't be toggled here. */
function toggleAction(item) {
  if (item.actions.disable?.allowed) return 'disable';
  if (item.actions.enable?.allowed) return 'enable';
  return null;
}

/** Why an item has no working switch (shown on hover/focus and in the detail panel). */
function lockedReason(item) {
  const a = item.actions.disable ?? item.actions.enable;
  return a && !a.allowed ? a.reason : null;
}

let toastTimer;
/** Show a message; `undo` adds a button that runs it (e.g. restore from trash). */
function toast(message, kind = 'ok', undo = null) {
  const t = $('#toast');
  t.className = `toast toast-${kind}`;
  fill(t, el('span', {}, message), undo ? el('button', { type: 'button', class: 'undo', onclick: () => { t.hidden = true; undo(); } }, 'Undo') : null);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 12000 : undo ? 15000 : 7000);
}

async function post(body, path = '/api/actions') {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CCP-Token': TOKEN },
    body: JSON.stringify({ ...body, ...(state.project ? { project: state.project } : {}) }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json;
}

async function loadTrash() {
  try {
    state.trash = (await getJson('/api/trash')).entries;
  } catch {
    state.trash = [];
  }
}

async function restore(entry) {
  if (state.pendingId) return;
  state.pendingId = `trash:${entry.id}`;
  render();
  try {
    const body = await post({ itemId: `trash:${entry.id}`, action: 'restore' });
    state.items = (await getJson(`/api/inventory${viewQuery()}`)).items;
    await loadTrash();
    state.restartNeeded ||= body.restartNeeded;
    toast([`${entry.name} restored to ${entry.originalPath}.`, ...body.warnings].join(' '), body.warnings.length ? 'warn' : 'ok');
  } catch (e) {
    toast(`Couldn't restore ${entry.name}: ${e.message}`, 'error');
  } finally {
    state.pendingId = null;
    render();
  }
}

/** Ask before an irreversible action. Uses a native <dialog>, not window.confirm(). */
function confirmDialog(title, message, confirmLabel) {
  const dialog = $('#confirm');
  dialog.querySelector('h2').textContent = title;
  dialog.querySelector('p').textContent = message;
  dialog.querySelector('[value=confirm]').textContent = confirmLabel;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}

async function act(item, action) {
  if (state.pendingId) return;
  if (action === 'delete') {
    const ok = item.kind === 'plugin'
      ? await confirmDialog(
        `Uninstall ${item.name}?`,
        `This runs "${item.actions.delete.target}". The plugin's saved data is kept, but this app can't undo the uninstall: you would reinstall it with /plugin in Claude Code.`,
        'Uninstall')
      : item.kind === 'mcp'
      ? await confirmDialog(
        `Remove the ${item.name} MCP server?`,
        `This runs "${item.actions.delete.target}". A backup of ~/.claude.json is kept in ~/.claude-control-panel/backups, but this app can't add the server back: you would re-add it with "claude mcp add".`,
        'Remove')
      : await confirmDialog(
        `Move ${item.name} to the trash?`,
        `${item.path} moves to the control panel's trash folder. You can restore it from the Trash tab.`,
        'Move to trash');
    if (!ok) return;
  }
  state.pendingId = item.id;
  render();
  try {
    const body = await post({ itemId: item.id, action, ...(action === 'delete' ? { confirm: true } : {}) });
    const i = state.items.findIndex((x) => x.id === item.id);
    if (body.item && i !== -1) state.items[i] = body.item;
    else if (i !== -1) state.items.splice(i, 1);
    if (item.kind === 'mcp' && !body.item && state.mcp) state.mcp = state.mcp.filter((x) => x.id !== item.id);
    // The "All hooks" switch changes the state of every hook: reload the list.
    if (item.kind === 'hook') state.items = (await getJson(`/api/inventory${viewQuery()}`)).items;
    if (!body.item && state.selectedId === item.id) state.selectedId = null;
    // A plugin change also changes the state of everything inside it: reload the list.
    if (item.kind === 'plugin') state.items = (await getJson(`/api/inventory${viewQuery()}`)).items;
    state.restartNeeded ||= body.restartNeeded;
    if (body.trashEntry) {
      await loadTrash();
      toast([`${item.name} moved to the trash.`, ...body.warnings].join(' '), 'ok', () => restore(body.trashEntry));
      return;
    }
    const now = body.item ? STATE_LABEL[body.item.state].replace(/^\S+ /, '').toLowerCase() : item.kind === 'plugin' ? 'uninstalled' : 'removed';
    const parts = [`${item.name} is now ${now}.`, ...body.warnings];
    if (body.backups.length) parts.push(`Backup: ${body.backups.join(', ')}`);
    toast(parts.join(' '), body.warnings.length ? 'warn' : 'ok');
  } catch (e) {
    toast(`Couldn't change ${item.name}: ${e.message}`, 'error');
  } finally {
    state.pendingId = null;
    render();
  }
}

function stateCell(item) {
  const action = toggleAction(item);
  if (!action) {
    const reason = lockedReason(item);
    return el('span', { title: reason ?? undefined }, stateLabel(item), reason && item.origin.type !== 'plugin' ? el('span', { class: 'visually-hidden' }, ` (${reason})`) : null);
  }
  const pending = state.pendingId === item.id;
  return el('button', {
    type: 'button', role: 'switch', class: 'switch',
    'aria-checked': String(item.state === 'on'),
    'aria-label': `${item.name}: ${pending ? 'working' : stateLabel(item).replace(/^\S+ /, '')}. Activate to ${action === 'disable' ? 'turn off' : 'turn on'}.`,
    disabled: pending || (state.pendingId !== null) ? true : undefined,
    onclick: () => act(item, action),
  }, el('span', { class: 'knob', 'aria-hidden': 'true' }), pending ? 'Working…' : stateLabel(item).replace(/^\S+ /, ''));
}

function allItems() {
  return state.mcp ? [...state.items, ...state.mcp] : state.items;
}

async function getJson(url) {
  // Every API call carries the page token (other sites can't add this header).
  const res = await fetch(url, { headers: { 'X-CCP-Token': TOKEN } });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  return body;
}

async function load(fresh = false) {
  $('#summary').textContent = 'Loading…';
  $('#error').hidden = true;
  state.costs = state.mcp = state.costsError = state.mcpError = null;
  // Ignore responses from an earlier load (e.g. the previous project, if the user switched quickly).
  const gen = ++loadGeneration;
  const current = () => gen === loadGeneration;
  try {
    const [items] = await Promise.all([getJson(`/api/inventory${viewQuery(fresh)}`).then((b) => b.items), loadTrash()]);
    if (!current()) return;
    state.items = items;
    renderSourceFilter();
    render();
  } catch (e) {
    if (!current()) return;
    $('#summary').textContent = '';
    $('#error').textContent = `Could not load inventory: ${e.message}`;
    $('#error').hidden = false;
    return;
  }
  // Slow sources load after the list is already usable.
  getJson('/api/costs').then((c) => { if (current()) state.costs = c; }, (e) => { if (current()) state.costsError = e.message; }).finally(render);
  getJson(`/api/mcp${viewQuery()}`).then((m) => { if (current()) state.mcp = m.items; }, (e) => { if (current()) state.mcpError = e.message; }).finally(render);
}
let loadGeneration = 0;

function renderSourceFilter() {
  const select = $('#f-source');
  const current = select.value;
  const plugins = [...new Set(state.items.filter((i) => i.origin.type === 'plugin').map(sourceLabel))].sort();
  select.replaceChildren(
    el('option', { value: '' }, 'All'),
    el('option', { value: 'standalone' }, 'Standalone'),
    ...plugins.map((p) => el('option', { value: p }, `Plugin: ${p}`)),
  );
  select.value = plugins.includes(current) || current === 'standalone' ? current : '';
}

function filtered() {
  const q = $('#search').value.trim().toLowerCase();
  const st = $('#f-state').value;
  const src = $('#f-source').value;
  const byCost = $('#sort').value === 'cost';
  return allItems()
    .filter((i) => i.kind === state.tab)
    .filter((i) => !st || i.state === st)
    .filter((i) => !src || sourceLabel(i) === src)
    .filter((i) => !q || i.name.toLowerCase().includes(q) || i.key.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))
    .sort((a, b) => (byCost ? (costOf(b)?.alwaysOn ?? -1) - (costOf(a)?.alwaysOn ?? -1) : 0) || a.name.localeCompare(b.name));
}

function renderSummary() {
  const items = allItems();
  const plugins = items.filter((i) => i.kind === 'plugin');
  const enabled = plugins.filter((p) => p.state === 'on');
  const count = (k) => items.filter((i) => i.kind === k).length;
  let text = `${plugins.length} plugins (${enabled.length} enabled) · ${count('skill')} skills · ${count('agent')} agents`;
  text += state.mcp ? ` · ${count('mcp')} MCP servers` : state.mcpError ? ' · MCP: failed to load' : ' · MCP: checking…';
  if (state.costs) {
    const total = enabled.reduce((sum, p) => sum + (costOf(p)?.alwaysOn ?? 0), 0);
    text += ` — enabled plugins add ${fmtTokens(total)} tokens to every session.`;
  } else {
    text += state.costsError ? ' — token costs failed to load.' : ' — measuring token costs…';
  }
  $('#summary').textContent = text;
}

function render() {
  $('#restart').hidden = !state.restartNeeded;
  for (const tab of document.querySelectorAll('[role=tab]')) {
    const kind = tab.dataset.tab;
    tab.setAttribute('aria-selected', String(kind === state.tab));
    tab.tabIndex = kind === state.tab ? 0 : -1; // roving tabindex: Tab enters the tab list once
    if (kind === state.tab) $('#panel').setAttribute('aria-labelledby', tab.id);
    const loading = kind === 'mcp' && !state.mcp;
    const count = kind === 'trash' ? state.trash.length : allItems().filter((i) => i.kind === kind).length;
    tab.querySelector('.count').textContent = loading ? (state.mcpError ? '(!)' : '(…)') : `(${count})`;
  }
  renderSummary();
  renderDetail();
  const heads = state.tab === 'trash' ? ['Action', 'Name', 'Type', 'Scope', 'Deleted'] : ['State', 'Name', 'Source', 'Scope', 'Always-on'];
  document.querySelectorAll('thead th').forEach((th, i) => { th.textContent = heads[i]; });
  if (state.tab === 'trash') return renderTrash();

  const rows = filtered();
  $('#rows').replaceChildren(...rows.map((item) => {
    const cost = costOf(item);
    return el('tr', { class: item.id === state.selectedId ? 'selected' : undefined },
      el('td', { class: `state state-${item.state}` }, stateCell(item)),
      el('td', {},
        el('button', { type: 'button', class: 'link', onclick: () => select(item.id), 'aria-pressed': String(item.id === state.selectedId) }, item.name),
        item.variant ? el('span', { class: 'tag' }, item.variant) : null,
        item.warnings.length ? el('span', { class: 'tag warn', title: item.warnings.join('; ') }, '⚠ warning') : null,
        el('div', { class: 'desc' }, item.description || '—'),
      ),
      el('td', {}, sourceLabel(item)),
      el('td', {}, item.scope),
      el('td', { class: 'num', title: cost?.onInvoke !== undefined ? `${fmtTokens(cost.onInvoke)} each time it runs` : undefined },
        cost ? fmtTokens(cost.alwaysOn) : item.kind === 'plugin' && !state.costs && !state.costsError ? '…' : ''),
    );
  }));

  const empty = $('#empty');
  const mcpPending = state.tab === 'mcp' && !state.mcp;
  empty.hidden = rows.length > 0 && !mcpPending;
  empty.textContent = mcpPending
    ? (state.mcpError ? `Could not list MCP servers: ${state.mcpError}` : 'Checking MCP servers… (Claude Code health-checks each one; this can take 20–60 seconds.)')
    : $('#search').value ? `No matches for "${$('#search').value}".` : 'Nothing here.';
}

function renderTrash() {
  const q = $('#search').value.trim().toLowerCase();
  const entries = state.trash
    .filter((e) => !q || e.name.toLowerCase().includes(q) || e.originalPath.toLowerCase().includes(q))
    .sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
  $('#rows').replaceChildren(...entries.map((e) => el('tr', {},
    el('td', {}, el('button', {
      type: 'button', class: 'switch', disabled: state.pendingId ? true : undefined,
      'aria-label': `Restore ${e.name} to ${e.originalPath}`, onclick: () => restore(e),
    }, state.pendingId === `trash:${e.id}` ? 'Restoring…' : 'Restore')),
    el('td', {}, el('strong', {}, e.name), el('div', { class: 'desc' }, `Was at ${e.originalPath}`)),
    el('td', {}, e.kind),
    el('td', {}, 'user'),
    el('td', { class: 'num' }, new Date(e.trashedAt).toLocaleString()),
  )));
  const empty = $('#empty');
  empty.hidden = entries.length > 0;
  empty.textContent = q ? `No trashed items match "${$('#search').value}".`
    : 'The trash is empty. Items you delete here are moved to ~/.claude-control-panel/trash and can be restored.';
}

function select(id) {
  state.selectedId = id;
  render();
}

function renderDetail() {
  const item = state.selectedId ? allItems().find((i) => i.id === state.selectedId) : undefined;
  if (!item) {
    // Nothing selected, or the selected item was deleted/uninstalled.
    $('#detail').replaceChildren(el('p', { class: 'muted' }, 'Select an item to see what it does.'));
    return;
  }
  const cost = costOf(item);
  const pluginCost = item.kind === 'plugin' ? state.costs?.[item.key] : undefined;
  const rows = [
    ['What it does', item.description || '(no description)'],
    ['Type', item.variant ? `${item.kind} (${item.variant})` : item.kind],
    item.hiddenFromMenu ? ['Menu', 'Hidden from the / menu (user-invocable: false); Claude can still use it'] : null,
    ['Identifier', item.key],
    ['Source', item.origin.type === 'plugin' ? `Plugin ${item.origin.pluginId}` : sourceLabel(item)],
    ['Scope', item.scope],
    ['State', stateLabel(item)],
    ['Why', item.stateSource ? `${item.stateSource.detail} (${item.stateSource.file})` : 'Default: nothing turns it off'],
    cost ? ['Token cost', `${fmtTokens(cost.alwaysOn)} in every session${cost.onInvoke !== undefined ? ` · ${fmtTokens(cost.onInvoke)} each time it runs` : ''}`] : null,
    pluginCost?.parseError ? ['Cost note', pluginCost.parseError] : null,
    item.contents ? ['Contains', `${item.contents.skills} skills · ${item.contents.commands} commands · ${item.contents.agents} agents`] : null,
    item.mcp ? ['Address', `${item.mcp.target || '—'}${item.mcp.transport ? ` (${item.mcp.transport})` : ''}`] : null,
    ['Location', item.path ?? '—'],
    item.warnings.length ? ['Warnings', item.warnings.join('; ')] : null,
  ].filter(Boolean);

  const top = pluginCost?.components?.length
    ? [...pluginCost.components].sort((a, b) => b.alwaysOn - a.alwaysOn).slice(0, 8)
    : null;
  const action = toggleAction(item);
  const note = item.origin.type === 'connector' ? 'A claude.ai connector: manage it in your claude.ai connector settings.'
    : item.kind === 'mcp' ? 'Use /mcp in Claude Code to turn MCP servers on or off.'
    : !action ? lockedReason(item) : null;
  const button = action ? el('button', {
    type: 'button', class: 'primary', disabled: state.pendingId ? true : undefined, onclick: () => act(item, action),
  }, state.pendingId === item.id ? 'Working…' : action === 'disable' ? (item.kind === 'agent' ? 'Block this agent' : 'Turn off') : (item.kind === 'agent' ? 'Unblock this agent' : 'Turn on')) : null;
  const target = action ? item.actions[action].target : null;
  const uninstall = item.actions.delete?.allowed
    ? el('button', { type: 'button', class: 'danger', disabled: state.pendingId ? true : undefined, onclick: () => act(item, 'delete') },
      item.kind === 'plugin' ? 'Uninstall…' : item.kind === 'mcp' ? 'Remove…' : 'Move to trash…')
    : null;

  fill($('#detail'),
    el('h2', {}, item.name),
    el('dl', {}, rows.map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
    button || uninstall ? el('div', { class: 'actions' }, button, uninstall,
      target ? el('p', { class: 'muted small' }, item.kind === 'plugin' ? `Runs: ${target}` : `Changes ${target} (backed up first)${state.project ? ': this project only.' : ': all projects.'}`) : null) : null,
    top ? [el('h3', {}, 'Largest always-on components'), el('ol', { class: 'top' }, top.map((c) => el('li', {}, `${c.name} — ${fmtTokens(c.alwaysOn)}`)))] : null,
    note ? el('p', { class: 'muted' }, note) : null,
  );
}

for (const tab of document.querySelectorAll('[role=tab]')) {
  tab.addEventListener('click', () => { state.tab = tab.dataset.tab; state.selectedId = null; render(); });
}
for (const id of ['#search', '#f-state', '#f-source', '#sort']) $(id).addEventListener('input', render);
$('#refresh').addEventListener('click', () => load(true));

// Verify: start Claude Code just long enough to read what it loaded, and compare (D-005).
async function verify() {
  const button = $('#verify');
  const out = $('#verify-result');
  button.disabled = true;
  button.textContent = 'Verifying… (up to a minute)';
  out.hidden = false;
  fill(out, el('p', {}, 'Starting Claude Code to see what it loads. It stops before answering, with hooks off, and saves no session.'));
  try {
    const r = await post({}, '/api/verify');
    const head = `Checked ${r.checked.plugins} plugins, ${r.checked.skills} skills and ${r.checked.agents} agents in ${r.folder} (${(r.durationMs / 1000).toFixed(0)} s).`;
    const notes = [
      r.uncheckedSkills ? `${r.uncheckedSkills} skill${r.uncheckedSkills === 1 ? ' is' : 's are'} hidden from the / menu (user-invocable: false), so Claude Code doesn't list ${r.uncheckedSkills === 1 ? 'it' : 'them'} at start-up and ${r.uncheckedSkills === 1 ? 'it' : 'they'} can't be checked this way.` : null,
      r.builtinPlugins.length ? `Claude Code also loads its own built-in plugins: ${r.builtinPlugins.join(', ')}.` : null,
    ].filter(Boolean);
    fill(out,
      el('p', {}, r.mismatches.length ? `${head} ${r.mismatches.length} difference${r.mismatches.length === 1 ? '' : 's'}:` : `${head} Everything matches what Claude Code loaded.`),
      r.mismatches.length ? el('ul', {}, r.mismatches.slice(0, 50).map((m) => el('li', {}, `${m.kind} "${m.name}": this page says ${m.app}, Claude Code: ${m.claude}`))) : null,
      r.mismatches.length > 50 ? el('p', { class: 'muted' }, `…and ${r.mismatches.length - 50} more.`) : null,
      notes.map((n) => el('p', { class: 'muted small' }, n)),
      el('button', { type: 'button', class: 'link', onclick: () => { out.hidden = true; } }, 'Close'));
  } catch (e) {
    fill(out, el('p', { class: 'state-blocked' }, `Verification failed: ${e.message}`));
  } finally {
    button.disabled = false;
    button.textContent = 'Verify with Claude Code';
  }
}
$('#verify').addEventListener('click', verify);

// Tabs follow the ARIA tab pattern: Left/Right/Home/End move between tabs.
$('[role=tablist]').addEventListener('keydown', (e) => {
  const tabs = [...document.querySelectorAll('[role=tab]')];
  const i = tabs.indexOf(document.activeElement);
  if (i === -1) return;
  const next = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  tabs[next].focus();
  tabs[next].click();
});

async function loadProjects() {
  try {
    const { projects } = await getJson('/api/projects');
    fill($('#scope'),
      el('option', { value: '' }, 'User (all projects)'),
      projects.length ? el('optgroup', { label: 'Project (changes only that project)' },
        projects.map((p) => el('option', { value: p.path, title: p.path }, p.name))) : null);
  } catch {
    // Project view is optional; user view keeps working.
  }
}

$('#scope').addEventListener('change', () => {
  state.project = $('#scope').value;
  state.selectedId = null;
  load();
});

loadProjects();
load();
