// Browser UI. Plain JS, no framework.
// SECURITY: descriptions come from third-party plugins. Only ever insert them with
// textContent (via el()), never innerHTML, so they can't run script in this page.

const state = {
  items: [], tab: 'plugin', selectedId: null,
  costs: null, costsError: null,          // { [pluginId]: { alwaysOn, components: [{name, alwaysOn, onInvoke}], parseError } }
  mcp: null, mcpError: null,              // McpItem[]
};
const $ = (sel) => document.querySelector(sel);

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

function allItems() {
  return state.mcp ? [...state.items, ...state.mcp] : state.items;
}

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  return body;
}

async function load() {
  $('#summary').textContent = 'Loading…';
  $('#error').hidden = true;
  state.costs = state.mcp = state.costsError = state.mcpError = null;
  try {
    state.items = (await getJson('/api/inventory')).items;
    renderSourceFilter();
    render();
  } catch (e) {
    $('#summary').textContent = '';
    $('#error').textContent = `Could not load inventory: ${e.message}`;
    $('#error').hidden = false;
    return;
  }
  // Slow sources load after the list is already usable.
  getJson('/api/costs').then((c) => { state.costs = c; }, (e) => { state.costsError = e.message; }).finally(render);
  getJson('/api/mcp').then((m) => { state.mcp = m.items; }, (e) => { state.mcpError = e.message; }).finally(render);
}

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
  for (const tab of document.querySelectorAll('[role=tab]')) {
    const kind = tab.dataset.tab;
    tab.setAttribute('aria-selected', String(kind === state.tab));
    const loading = kind === 'mcp' && !state.mcp;
    tab.querySelector('.count').textContent = loading ? (state.mcpError ? '(!)' : '(…)') : `(${allItems().filter((i) => i.kind === kind).length})`;
  }
  renderSummary();

  const rows = filtered();
  $('#rows').replaceChildren(...rows.map((item) => {
    const cost = costOf(item);
    return el('tr', { class: item.id === state.selectedId ? 'selected' : undefined },
      el('td', { class: `state state-${item.state}` }, stateLabel(item)),
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
  if (state.selectedId) renderDetail();
}

function select(id) {
  state.selectedId = id;
  render();
}

function renderDetail() {
  const item = allItems().find((i) => i.id === state.selectedId);
  if (!item) return;
  const cost = costOf(item);
  const pluginCost = item.kind === 'plugin' ? state.costs?.[item.key] : undefined;
  const rows = [
    ['What it does', item.description || '(no description)'],
    ['Type', item.variant ? `${item.kind} (${item.variant})` : item.kind],
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
  const note = item.origin.type === 'plugin' ? 'Part of a plugin: it can only be turned off by disabling the whole plugin.'
    : item.origin.type === 'connector' ? 'A claude.ai connector: manage it in your claude.ai connector settings.'
    : item.kind === 'mcp' ? 'Use /mcp in Claude Code to turn MCP servers on or off.' : null;

  // replaceChildren() would print null as text, so build the list through el()'s null filtering.
  $('#detail').replaceChildren(...el('div', {},
    el('h2', {}, item.name),
    el('dl', {}, rows.map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
    top ? [el('h3', {}, 'Largest always-on components'), el('ol', { class: 'top' }, top.map((c) => el('li', {}, `${c.name} — ${fmtTokens(c.alwaysOn)}`)))] : null,
    note ? el('p', { class: 'muted' }, note) : null,
  ).childNodes);
}

for (const tab of document.querySelectorAll('[role=tab]')) {
  tab.addEventListener('click', () => { state.tab = tab.dataset.tab; state.selectedId = null; $('#detail').replaceChildren(el('p', { class: 'muted' }, 'Select an item to see what it does.')); render(); });
}
for (const id of ['#search', '#f-state', '#f-source', '#sort']) $(id).addEventListener('input', render);
$('#refresh').addEventListener('click', load);
load();
