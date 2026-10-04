const listNode = document.getElementById('paper-list');
const detailNode = document.getElementById('detail');
const searchNode = document.getElementById('paper-search');
const countNode = document.getElementById('paper-count');
const filterNode = document.getElementById('filter-count');
const updatedNode = document.getElementById('last-updated');

let papers = [];
let selectedId = location.hash.slice(1);
let detailRequest = 0;
let selectedFingerprint = '';

const node = (tag, className, value) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined && value !== null) element.textContent = String(value);
  return element;
};
const append = (parent, ...children) => { parent.append(...children.filter(Boolean)); return parent; };
const dateLabel = value => {
  if (!value) return 'Date unavailable';
  const date = new Date(value + 'T00:00:00');
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined,
    { year: 'numeric', month: 'short', day: 'numeric' });
};
const statusLabel = status => ({completed:'Simulated', skipped:'Assessed', failed:'Failed',
  processing:'Processing', waiting:'Queued', source_unavailable:'No PDF', assessed:'Assessed'})[status] || 'Pending';
const safeLink = value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
};
const formatNumber = (value, digits = 2) => typeof value === 'number' && Number.isFinite(value)
  ? value.toFixed(digits) : '—';

function renderList() {
  const query = searchNode.value.trim().toLowerCase();
  const filtered = papers.filter(paper =>
    [paper.title, paper.id, paper.date].some(value => String(value || '').toLowerCase().includes(query)));
  countNode.textContent = papers.length;
  filterNode.textContent = `${filtered.length} of ${papers.length} papers`;
  const scroll = listNode.scrollTop;
  listNode.replaceChildren();
  if (!filtered.length) {
    listNode.append(node('div', 'no-match', 'No papers match your search.'));
    return;
  }
  for (const paper of filtered) {
    const button = node('button', 'paper-item' + (paper.id === selectedId ? ' active' : ''));
    button.type = 'button';
    button.setAttribute('aria-current', paper.id === selectedId ? 'true' : 'false');
    const top = node('div', 'paper-item-top');
    append(top, node('span', 'paper-date', dateLabel(paper.date)),
      node('span', `paper-status ${paper.status}`, statusLabel(paper.status)));
    append(button, top, node('div', 'paper-title', paper.title));
    button.addEventListener('click', () => selectPaper(paper.id));
    listNode.append(button);
  }
  listNode.scrollTop = scroll;
}

function emptyDetail(title, message, error = false) {
  detailNode.replaceChildren(append(node('div', 'empty-state'),
    node('div', 'empty-icon', error ? '!' : '▦'), node('h2', '', title), node('p', '', message)));
}

async function selectPaper(id, updateHash = true, preserveScroll = false) {
  selectedId = id;
  document.body.classList.add('has-selection');
  if (updateHash) history.replaceState(null, '', '#' + id);
  renderList();
  const request = ++detailRequest;
  const previousScroll = detailNode.scrollTop;
  if (!preserveScroll) detailNode.replaceChildren(node('div', 'detail-loading', 'Loading latest result…'));
  try {
    const response = await fetch(`/api/papers/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!response.ok) throw Error('The paper could not be loaded.');
    const paper = await response.json();
    if (request === detailRequest && selectedId === id) {
      selectedFingerprint = JSON.stringify(papers.find(item => item.id === id) || {});
      renderDetail(paper, preserveScroll ? previousScroll : 0);
    }
  } catch (error) {
    if (request === detailRequest) emptyDetail('Unable to load paper', error.message, true);
  }
}

function section(title, label) {
  const wrapper = node('section', 'section');
  const heading = node('div', 'section-header');
  append(heading, node('h2', '', title), label ? node('span', 'section-label', label) : null);
  wrapper.append(heading);
  return wrapper;
}

function quiet(title, message) {
  return append(node('div', 'quiet-card'), node('strong', '', title), node('span', '', message));
}

function renderDetail(paper, scrollTop = 0) {
  const root = node('div', 'detail-inner');
  const top = node('div', 'detail-topline');
  const back = node('button', 'back-button', '← All papers');
  back.type = 'button';
  back.addEventListener('click', () => {
    selectedId = '';
    selectedFingerprint = '';
    detailRequest++;
    history.replaceState(null, '', location.pathname + location.search);
    document.body.classList.remove('has-selection');
    renderList();
  });
  append(top, append(node('div', ''), back,
    node('div', 'crumb', `Paper inbox / ${paper.id}`)));
  const actions = node('div', 'detail-actions');
  const url = safeLink(paper.paper_url);
  if (url) {
    const link = node('a', 'link-button', 'Open paper ↗');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    actions.append(link);
  }
  top.append(actions);
  append(root, top, node('h1', 'detail-title', paper.title));

  const metadata = node('div', 'metadata');
  append(metadata,
    append(node('span', ''), node('strong', '', 'Published  '), node('span', '', dateLabel(paper.date))),
    append(node('span', ''), node('strong', '', 'Citations  '), node('span', '', paper.citations)),
    append(node('span', 'authors'), node('strong', '', 'Author  '),
      node('span', '', paper.author || 'Not available'),
      paper.author_source ? node('span', 'source-note', ` · ${paper.author_source}`) : null));
  root.append(metadata);
  const strip = node('div', 'status-strip');
  append(strip, node('span', `status-chip ${paper.status}`, statusLabel(paper.status)),
    node('span', '', paper.attempt ? `Latest attempt · ${paper.attempt}` : 'No run recorded yet'));
  root.append(strip);

  const assessment = section('Reproducibility assessment', 'Latest attempt');
  if (paper.assessment) {
    const cards = node('div', 'assessment-grid');
    const verdict = append(node('div', 'assessment-card'), node('span', 'label', 'Verdict'),
      node('span', 'value ' + (paper.assessment.verdict?.startsWith('candidate') ? 'green' : 'amber'),
        paper.assessment.verdict || 'Not recorded'));
    const feasibility = append(node('div', 'assessment-card'), node('span', 'label', 'Feasibility decision'),
      node('span', 'value', paper.feasibility?.decision || 'Not recorded'));
    append(cards, verdict, feasibility);
    assessment.append(cards);
    if (paper.assessment.summary) assessment.append(node('p', 'summary', paper.assessment.summary));
  } else if (paper.status === 'failed') {
    assessment.append(quiet('The latest attempt failed',
      [paper.error?.stage, paper.error?.message].filter(Boolean).join(' · ') || 'Check stage-error.json.'));
  } else if (paper.status === 'processing') {
    assessment.append(quiet('Pilot in progress', 'The inbox will refresh when this attempt finishes.'));
  } else if (paper.status === 'source_unavailable') {
    assessment.append(quiet('Source unavailable', paper.source_note || 'No local PDF is available for this paper.'));
  } else {
    assessment.append(quiet('Awaiting pilot result', 'This paper is in the manifest but has no saved attempt yet.'));
  }
  root.append(assessment);

  const results = section('Reproduction results', paper.results?.studio_run_id || 'Studio');
  if (paper.results?.status === 'completed') renderResults(results, paper.results);
  else results.append(quiet('No simulation result', paper.results?.reason ||
    (paper.status === 'failed' ? 'The latest pilot attempt failed before a result was saved.' :
      'Studio has not completed a simulation for the latest attempt.')));
  root.append(results);

  const limitations = section('Limitations', `${paper.limitations.length} recorded`);
  if (paper.limitations.length) {
    const wrap = node('div', 'table-wrap');
    const table = node('table', 'data-table');
    const head = node('thead', '');
    append(head, append(node('tr', ''), node('th', '', '#'), node('th', '', 'Limitation')));
    const body = node('tbody', '');
    paper.limitations.forEach((limitation, index) => {
      append(body, append(node('tr', ''), node('td', 'limitation-index', String(index + 1).padStart(2, '0')),
        node('td', 'limitation-text', limitation)));
    });
    append(table, head, body); wrap.append(table); limitations.append(wrap);
  } else limitations.append(quiet('No limitations recorded', paper.assessment
    ? 'The latest assessment contains no limitation entries.' : 'An assessment has not been saved yet.'));
  root.append(limitations);
  root.append(node('div', 'detail-footer', `OpenAlex ID ${paper.id} · Citation count from the local manifest · Latest attempt only`));
  detailNode.replaceChildren(root);
  detailNode.scrollTop = scrollTop;
}

function renderResults(sectionNode, results) {
  const rows = [...results.rows].sort((a, b) => (b.kelvin || 0) - (a.kelvin || 0));
  const peak = rows.length ? rows[0].kelvin : null;
  const metrics = node('div', 'run-grid');
  append(metrics,
    append(node('div', 'metric'), node('span', '', 'Peak temperature'),
      append(node('strong', ''), document.createTextNode(formatNumber(peak)), node('small', '', ' K'))),
    append(node('div', 'metric'), node('span', '', 'Floorplan blocks'),
      node('strong', '', rows.length)),
    append(node('div', 'metric'), node('span', '', 'Run type'),
      node('strong', '', results.run_kind === 'custom_2d_steady' || results.run_kind === 'custom'
        ? '2D steady' : 'Bundled')));
  sectionNode.append(metrics);
  if (results.visualization_url) {
    const viewer = node('iframe', 'viewer');
    viewer.title = 'Interactive floorplan temperature visualization';
    viewer.src = results.visualization_url;
    viewer.loading = 'lazy';
    viewer.setAttribute('sandbox', 'allow-scripts');
    sectionNode.append(viewer);
    sectionNode.append(node('p', 'run-note', results.power_trace_present
      ? 'The heatmap uses input.flp and temperatures.steady. Input.ptrace is a power snapshot in watts, shown below; it is not a transient temperature trace.'
      : results.thermal_trace_present
        ? 'The heatmap uses the bundled EV6 floorplan, gcc.steady, and gcc.ttrace. Use the trace controls in the visualization to inspect samples.'
        : 'The heatmap uses the saved floorplan and steady temperatures.'));
  }
  if (!rows.length) return;
  const wrap = node('div', 'table-wrap');
  const table = node('table', 'data-table');
  const head = append(node('thead', ''), append(node('tr', ''), node('th', '', 'Block'),
    node('th', 'right', 'Power · W'), node('th', 'right', 'Temp · K'), node('th', 'right', 'Temp · °C')));
  const body = node('tbody', '');
  for (const row of rows) append(body, append(node('tr', ''), node('td', '', row.name || '—'),
    node('td', 'number', formatNumber(row.power_w)), node('td', 'number', formatNumber(row.kelvin)),
    node('td', 'number', formatNumber(row.celsius))));
  append(table, head, body); wrap.append(table); sectionNode.append(wrap);
}

async function refresh() {
  try {
    const response = await fetch('/api/papers', { cache: 'no-store' });
    if (!response.ok) throw Error('Unable to refresh');
    papers = await response.json();
    renderList();
    updatedNode.textContent = `Updated ${new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} · refreshes every 15s`;
    const current = papers.find(paper => paper.id === selectedId);
    if (current && JSON.stringify(current) !== selectedFingerprint) {
      await selectPaper(selectedId, false, true);
    } else if (papers.length && !selectedId && window.innerWidth > 680) {
      await selectPaper(papers[0].id);
    }
  } catch (error) {
    updatedNode.textContent = 'Refresh failed · try again';
    if (!papers.length) emptyDetail('Cannot load papers', error.message, true);
  }
}

searchNode.addEventListener('input', renderList);
document.getElementById('refresh').addEventListener('click', refresh);
document.addEventListener('keydown', event => {
  if (event.key === '/' && document.activeElement !== searchNode) {
    event.preventDefault(); searchNode.focus();
  }
});
window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && papers.some(paper => paper.id === id)) selectPaper(id, false);
});
refresh();
setInterval(refresh, 15000);
