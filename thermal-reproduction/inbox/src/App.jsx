import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AnchorButton, Button, Card, Callout, HTMLSelect, HTMLTable, InputGroup, Navbar,
  NavbarGroup, Spinner, Tab, Tabs, Tag,
} from '@blueprintjs/core';
import FloorplanComparison from './FloorplanComparison.jsx';
import chipFryLogo from './assets/chip_fry_logo.png';

const FILTERS = ['All', 'Assessed', 'Queued', 'Processing', 'Simulated', 'No PDF', 'Failed'];
const STATUS = {
  assessed: 'Assessed', skipped: 'Assessed', waiting: 'Queued',
  processing: 'Processing', completed: 'Simulated',
  source_unavailable: 'No PDF', failed: 'Failed',
};

function statusLabel(value) { return STATUS[value] || 'Queued'; }
function statusIntent(value) {
  if (value === 'completed') return 'success';
  if (value === 'failed') return 'danger';
  if (value === 'skipped' || value === 'assessed') return 'warning';
  return 'none';
}
function dateLabel(value) {
  if (!value) return 'Date unavailable';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined,
    { year: 'numeric', month: 'short', day: 'numeric' });
}
function safeLink(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}
function formatNumber(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function EmptyState({ title, message, error = false }) {
  return <div className="empty-state">
    <span className={`empty-icon ${error ? 'error' : ''}`} aria-hidden="true">{error ? '!' : '▦'}</span>
    <h2>{title}</h2><p>{message}</p>
  </div>;
}

function Section({ title, note, children }) {
  return <section className="section">
    <div className="section-header"><h2>{title}</h2>{note && <span>{note}</span>}</div>
    {children}
  </section>;
}

function Quiet({ title, message }) {
  return <Callout className="quiet-card" title={title}>{message}</Callout>;
}

export function LinkedAssets({ assets = [], extractedAssets = [], extractionSource = 'extraction.json' }) {
  const present = value => Array.isArray(value) ? value.length > 0 : value != null;
  if (!present(assets) && !present(extractedAssets)) {
    return <Section title="Linked assets" note="Latest attempt">
      <Quiet title="No linked assets recorded" message="No linked assets are recorded for this paper's latest result." />
    </Section>;
  }
  return <>
    {present(extractedAssets) && <AssetList assets={extractedAssets} title="Links found in paper" source={extractionSource} />}
    {present(assets) && <AssetList assets={assets} title="Saved asset metadata" source="manifest.json" />}
  </>;
}

function AssetList({ assets, title, source }) {
  const entries = Array.isArray(assets) ? assets : [assets];
  const display = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return <Section title={title} note={source}>
    <div className="linked-assets">
      {entries.map((asset, index) => <Card className="linked-asset" key={index}>
        <h3>Asset {index + 1}</h3>
        {asset && typeof asset === 'object' && !Array.isArray(asset) && Object.keys(asset).length > 0
          ? <dl>{Object.entries(asset).map(([field, value]) => {
            const url = typeof value === 'string' ? safeLink(value) : null;
            return <div className="asset-field" key={field}>
              <dt>{field}</dt><dd>{url
                ? <a href={url} target="_blank" rel="noopener noreferrer">{value}</a>
                : <pre>{display(value)}</pre>}</dd>
            </div>;
          })}</dl>
          : <pre>{display(asset)}</pre>}
      </Card>)}
    </div>
  </Section>;
}

function Results({ results }) {
  if (results?.status !== 'completed') {
    return <Quiet title="No simulation result" message={results?.reason || 'Studio has not completed a simulation for the latest attempt.'} />;
  }
  const rows = [...(results.rows || [])].sort((a, b) => (b.kelvin || 0) - (a.kelvin || 0));
  const runType = ['custom', 'custom_2d_steady'].includes(results.run_kind) ? '2D steady' : 'Bundled';
  return <>
    <div className="run-grid">
      <Card className="metric"><span>Peak temperature</span><strong>{formatNumber(rows[0]?.kelvin)} <small>K</small></strong></Card>
      <Card className="metric"><span>Floorplan blocks</span><strong>{rows.length}</strong></Card>
      <Card className="metric"><span>Run type</span><strong>{runType}</strong></Card>
    </div>
    {results.visualization_url && <>
      <iframe className="viewer" title="Interactive floorplan temperature visualization"
        src={results.visualization_url} loading="lazy" sandbox="allow-scripts" />
      <p className="run-note">{results.power_trace_present
        ? 'The heatmap uses input.flp and temperatures.steady. Input.ptrace is a power snapshot in watts, shown below; it is not a transient temperature trace.'
        : results.thermal_trace_present
          ? 'The heatmap uses the bundled EV6 floorplan, gcc.steady, and gcc.ttrace. Use the trace controls to inspect samples.'
          : 'The heatmap uses the saved floorplan and steady temperatures.'}</p>
    </>}
    {rows.length > 0 && <div className="table-wrap"><HTMLTable striped compact className="data-table">
      <thead><tr><th>Block</th><th className="number">Power · W</th><th className="number">Temp · K</th><th className="number">Temp · °C</th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={`${row.name}-${index}`}>
        <td>{row.name || '—'}</td><td className="number">{formatNumber(row.power_w)}</td>
        <td className="number">{formatNumber(row.kelvin)}</td><td className="number">{formatNumber(row.celsius)}</td>
      </tr>)}</tbody>
    </HTMLTable></div>}
  </>;
}

function Detail({ paper, loading, error, onBack, onCompare }) {
  if (loading) return <div className="detail-loading"><Spinner size={22} /> Loading latest result…</div>;
  if (error) return <EmptyState title="Unable to load paper" message={error} error />;
  if (!paper) return <EmptyState title="Select a paper" message="Choose a paper from the inbox to inspect its latest assessment and simulation." />;
  const url = safeLink(paper.paper_url);
  const assessmentMessage = paper.status === 'failed'
    ? [paper.error?.stage, paper.error?.message].filter(Boolean).join(' · ') || 'Check stage-error.json.'
    : paper.status === 'processing' ? 'This attempt is still running. Visit the page again to see its result.'
      : paper.status === 'source_unavailable' ? paper.source_note || 'No local PDF is available for this paper.'
        : 'This paper is in the manifest but has no saved attempt yet.';
  const limitations = paper.limitations || [];
  return <div className="detail-inner">
    <div className="detail-topline">
      <div><Button minimal small icon="arrow-left" className="back-button" onClick={onBack}>All papers</Button>
        <span className="crumb">Paper inbox / {paper.id}</span></div>
      {url && <AnchorButton small outlined icon="document-open" rightIcon="arrow-top-right"
        href={url} target="_blank" rel="noopener noreferrer">Open paper</AnchorButton>}
    </div>
    <h1 className="detail-title">{paper.title}</h1>
    <div className="metadata">
      <span><strong>Published </strong>{dateLabel(paper.date)}</span>
      <span><strong>Citations </strong>{paper.citations}</span>
      <span className="authors"><strong>Author </strong>{paper.author || 'Not available'}
        {paper.author_source && <span className="source-note"> · {paper.author_source}</span>}</span>
    </div>
    <div className="status-strip"><Tag intent={statusIntent(paper.status)}>{statusLabel(paper.status)}</Tag>
      <span className="attempt-label">{paper.attempt ? `Latest attempt · ${paper.attempt}` : 'No run recorded yet'}</span>
      <div className="input-actions">
        <AnchorButton small outlined icon="download" href={paper.inputs?.download_url}
          download={`${paper.id}-inputs.zip`} disabled={!paper.inputs?.download_url}
          title={paper.inputs?.files?.length ? `Download ${paper.inputs.files.join(' and ')} as a ZIP` : 'No saved input files for this attempt'}>
          Download inputs
        </AnchorButton>
        <Button small outlined icon="comparison" onClick={() => onCompare(paper)}
          disabled={!paper.inputs?.compare_url} title={paper.inputs?.compare_url ? undefined : 'No saved input.flp for this attempt'}>
          Compare my Floorplan
        </Button>
      </div>
    </div>

    <Tabs className="paper-tabs" id={`paper-tabs-${paper.id}`} key={`${paper.id}-${paper.attempt}`}
      defaultSelectedTabId="overview" renderActiveTabPanelOnly>
      <Tab id="overview" title="Overview" panel={<>
    <Section title="Reproducibility assessment" note="Latest attempt">
      {paper.assessment ? <>
        <div className="assessment-grid">
          <Card className="assessment-card"><span>Verdict</span><strong>{paper.assessment.verdict || 'Not recorded'}</strong></Card>
          <Card className="assessment-card"><span>Feasibility decision</span><strong>{paper.feasibility?.decision || 'Not recorded'}</strong></Card>
        </div>
        {paper.assessment.summary && <p className="summary">{paper.assessment.summary}</p>}
      </> : <Quiet title={paper.status === 'failed' ? 'The latest attempt failed'
        : paper.status === 'processing' ? 'Pilot in progress'
          : paper.status === 'source_unavailable' ? 'Source unavailable' : 'Awaiting pilot result'}
        message={assessmentMessage} />}
    </Section>

    <Section title="Reproduction results" note={paper.results?.studio_run_id || 'Studio'}>
      <Results results={paper.results} />
    </Section>

    <Section title="Limitations" note={`${limitations.length} recorded`}>
      {limitations.length ? <div className="table-wrap"><HTMLTable striped compact className="data-table">
        <thead><tr><th>#</th><th>Limitation</th></tr></thead>
        <tbody>{limitations.map((item, index) => <tr key={index}>
          <td className="limitation-index">{String(index + 1).padStart(2, '0')}</td><td>{item}</td>
        </tr>)}</tbody>
      </HTMLTable></div> : <Quiet title="No limitations recorded" message={paper.assessment
        ? 'The latest assessment contains no limitation entries.' : 'An assessment has not been saved yet.'} />}
    </Section>
      </>} />
      <Tab id="linked-assets" title="Linked assets" panel={<LinkedAssets assets={paper.linked_assets}
        extractedAssets={paper.extracted_linked_assets} extractionSource={paper.extracted_linked_assets_source} />} />
    </Tabs>
    <div className="detail-footer">OpenAlex ID {paper.id} · Citation count from the local manifest · Latest attempt only</div>
  </div>;
}

export default function App() {
  const [papers, setPapers] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All');
  const [selectedId, setSelectedId] = useState(decodeURIComponent(location.hash.slice(1)));
  const [paper, setPaper] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [mobileOpen, setMobileOpen] = useState(Boolean(location.hash));
  const [comparisonPaper, setComparisonPaper] = useState(null);
  const searchRef = useRef(null);
  const detailRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/papers', { cache: 'no-store', signal: controller.signal })
      .then(response => { if (!response.ok) throw Error('The paper list could not be loaded.'); return response.json(); })
      .then(items => {
        setPapers(items);
        setSelectedId(current => items.some(item => item.id === current) ? current : (items[0]?.id || ''));
      })
      .catch(error => { if (error.name !== 'AbortError') setListError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError('');
    setPaper(null);
    fetch(`/api/papers/${encodeURIComponent(selectedId)}`, { cache: 'no-store', signal: controller.signal })
      .then(response => { if (!response.ok) throw Error('The paper could not be loaded.'); return response.json(); })
      .then(setPaper)
      .catch(error => { if (error.name !== 'AbortError') setDetailError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selectedId]);

  useEffect(() => {
    const onHashChange = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (papers.some(item => item.id === id)) { setSelectedId(id); setMobileOpen(true); }
    };
    const onKeyDown = event => {
      if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
        event.preventDefault(); searchRef.current?.focus();
      }
    };
    window.addEventListener('hashchange', onHashChange);
    document.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('hashchange', onHashChange); document.removeEventListener('keydown', onKeyDown); };
  }, [papers]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return papers.filter(item => (filter === 'All' || statusLabel(item.status) === filter)
      && [item.title, item.id, item.date].some(value => String(value || '').toLowerCase().includes(term)));
  }, [papers, query, filter]);

  function selectPaper(id) {
    setSelectedId(id);
    setMobileOpen(true);
    history.replaceState(null, '', `#${id}`);
    detailRef.current?.scrollTo(0, 0);
  }
  function showList() {
    setMobileOpen(false);
    history.replaceState(null, '', location.pathname + location.search);
  }

  return <div className={`shell ${mobileOpen ? 'mobile-detail-open' : ''}`}>
    <Navbar className="topbar">
      <NavbarGroup>
        <img className="brand-logo" src={chipFryLogo} alt="" width="64" height="64" />
        <div className="brand"><strong>Chip Fry</strong>
          <small>Replicate, Reproduce and Reuse published results for your own application</small></div>
      </NavbarGroup>
    </Navbar>
    <div className="workspace">
      <aside className="sidebar" aria-label="Papers">
        <div className="sidebar-heading"><p className="eyebrow">RESEARCH QUEUE</p>
          <div className="heading-row"><h1>Papers</h1><Tag minimal round>{papers.length || '—'}</Tag></div>
          <p>Browse the manifest and its latest pilot results.</p></div>
        <div className="sidebar-controls">
          <InputGroup inputRef={searchRef} leftIcon="search" type="search" placeholder="Search papers…"
            aria-label="Search papers" value={query} onChange={event => setQuery(event.target.value)} />
          <label className="filter-label" htmlFor="status-filter">Status</label>
          <HTMLSelect id="status-filter" fill value={filter} onChange={event => setFilter(event.target.value)}
            options={FILTERS.map(value => ({ label: value === 'All' ? 'All statuses' : value, value }))} />
        </div>
        <div className="list-meta"><span>{listLoading ? 'Loading papers' : `${visible.length} of ${papers.length} papers`}</span><span>Newest first</span></div>
        <nav className="paper-list" aria-label="Paper list">
          {listError ? <div className="no-match error-text">{listError}</div>
            : visible.length ? visible.map(item => <button key={item.id} type="button"
              className={`paper-item ${item.id === selectedId ? 'active' : ''}`}
              aria-current={item.id === selectedId ? 'true' : undefined} onClick={() => selectPaper(item.id)}>
              <span className="paper-item-top"><span className="paper-date">{dateLabel(item.date)}</span>
                <Tag minimal intent={statusIntent(item.status)}>{statusLabel(item.status)}</Tag></span>
              <span className="paper-title">{item.title}</span>
            </button>)
              : !listLoading && <div className="no-match">No papers match your search and status filter.</div>}
        </nav>
      </aside>
      <main className="detail" ref={detailRef} aria-live="polite">
        <Detail paper={paper} loading={detailLoading} error={detailError || (listError && !selectedId ? listError : '')}
          onBack={showList} onCompare={setComparisonPaper} />
      </main>
    </div>
    {comparisonPaper && <FloorplanComparison key={`${comparisonPaper.id}-${comparisonPaper.attempt}`}
      paper={comparisonPaper} onClose={() => setComparisonPaper(null)} />}
  </div>;
}
