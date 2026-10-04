import { createHash } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const LABELS = ['candidate_2d_snapshot', 'conditional_2d_snapshot',
  'illustrative_2d_only', 'not_2d_applicable', 'source_unavailable'];
export const CHECKS = ['methods', 'code', 'parameters', 'config', 'data'];
const GEOMETRY = ['x_m', 'y_m', 'width_m', 'height_m'];
const REQUIRED = [...GEOMETRY, 'power_w'];
const SUPPORTED_PROVENANCE = new Set(['explicit_text', 'table', 'figure_digitized',
  'linked_code', 'linked_data', 'supplement']);

export function reviewDigest(packet, extraction, adversarial) {
  return sha256(JSON.stringify({ pdf_sha256: packet.pdf_sha256,
    assets: (packet.assets || []).map(({ id, sha256: hash, version }) => ({ id, sha256: hash, version })),
    extraction, adversarial }));
}

export function parseConfig(config) {
  const values = {};
  for (const raw of config.split('\n')) {
    const line = raw.split('#', 1)[0].trim();
    if (!line) continue;
    const match = /^-([A-Za-z0-9_]+)\s+(\S+)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) throw Error('Invalid or duplicate HotSpot config line');
    values[match[1]] = match[2];
  }
  return values;
}

export function validateExperiment(experiment, config) {
  const errors = [];
  if (experiment?.kind !== 'custom_2d_steady' || !Array.isArray(experiment.floorplan) ||
      experiment.floorplan.length < 1 || experiment.floorplan.length > 128 ||
      !experiment.power_w || typeof experiment.power_w !== 'object' || Array.isArray(experiment.power_w)) {
    return ['A custom experiment needs 1–128 blocks and a power_w object'];
  }
  const names = new Set();
  let totalPower = 0;
  for (const [index, block] of experiment.floorplan.entries()) {
    if (!block || Object.keys(block).sort().join() !== 'height_m,name,width_m,x_m,y_m' ||
        typeof block.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(block.name)) {
      errors.push(`Invalid block ${index}`); continue;
    }
    if (names.has(block.name)) errors.push(`Duplicate block ${block.name}`);
    names.add(block.name);
    for (const field of GEOMETRY) {
      const value = block[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
          value > 0.1 || (field.endsWith('width_m') || field.endsWith('height_m')) && value === 0) {
        errors.push(`${block.name}.${field} is outside Studio limits`);
      }
    }
    if (block.x_m + block.width_m > 0.1 || block.y_m + block.height_m > 0.1) {
      errors.push(`${block.name} exceeds the 0.1 m extent`);
    }
    const power = experiment.power_w[block.name];
    if (typeof power !== 'number' || !Number.isFinite(power) || power < 0 || power > 10000) {
      errors.push(`${block.name} needs finite power from 0 to 10000 W`);
    } else totalPower += power;
  }
  if (totalPower > 100000) errors.push('Total power exceeds 100000 W');
  if (Object.keys(experiment.power_w).sort().join() !== [...names].sort().join()) {
    errors.push('Floorplan and power names differ');
  }
  for (let i = 0; i < experiment.floorplan.length; i++) {
    const a = experiment.floorplan[i];
    if (!a || GEOMETRY.some(field => !Number.isFinite(a[field]))) continue;
    for (const b of experiment.floorplan.slice(0, i)) {
      if (b && GEOMETRY.every(field => Number.isFinite(b[field])) &&
          a.x_m < b.x_m + b.width_m && b.x_m < a.x_m + a.width_m &&
          a.y_m < b.y_m + b.height_m && b.y_m < a.y_m + a.height_m) {
        errors.push(`${a.name} overlaps ${b.name}`);
      }
    }
  }
  const values = parseConfig(config);
  if (values.model_secondary !== '0') errors.push('Custom runs require model_secondary=0');
  if (!['block', 'grid'].includes(values.model_type)) errors.push('Custom runs require block or grid mode');
  if (values.model_type === 'grid') {
    for (const key of ['grid_rows', 'grid_cols']) {
      const n = Number(values[key]);
      if (!Number.isInteger(n) || n < 1 || n > 128 || (n & (n - 1)) !== 0) {
        errors.push(`${key} must be a power of two from 1 to 128`);
      }
    }
  }
  const blocks = experiment.floorplan.filter(b => b && GEOMETRY.every(field => Number.isFinite(b[field])));
  if (blocks.length) {
    const width = Math.max(...blocks.map(b => b.x_m + b.width_m)) - Math.min(...blocks.map(b => b.x_m));
    const height = Math.max(...blocks.map(b => b.y_m + b.height_m)) - Math.min(...blocks.map(b => b.y_m));
    for (const key of ['s_spreader', 's_sink']) {
      const limit = Number(values[key]);
      if (!Number.isFinite(limit) || limit <= 0 || width > limit || height > limit) {
        errors.push(`Floorplan exceeds ${key}`);
      }
    }
  }
  return errors;
}

function cited(item, packet) {
  if (!item || typeof item.locator !== 'string' || !item.locator.trim() ||
      !SUPPORTED_PROVENANCE.has(item.provenance)) return false;
  if (Number.isInteger(item.pdf_page) && item.pdf_page >= 1 && item.pdf_page <= packet.pages.length) return true;
  return typeof item.asset_id === 'string' && packet.assets?.some(asset => asset.id === item.asset_id &&
    asset.sha256 && asset.version && asset.status === 'downloaded' && item.locator.includes(':'));
}

function evidenceErrors(extraction, packet) {
  const errors = [];
  if (!Array.isArray(extraction.evidence)) return ['Evidence ledger is missing'];
  for (const [index, item] of extraction.evidence.entries()) {
    if (!cited(item, packet)) errors.push(`Evidence ${index} lacks a valid page or pinned asset locator`);
  }
  const blocks = extraction.experiment?.floorplan || [];
  for (const block of blocks) {
    for (const field of REQUIRED) {
      const expected = field === 'power_w' ? extraction.experiment.power_w?.[block.name] : block[field];
      const matching = extraction.evidence.filter(item => item.field === field &&
        item.block_name === block.name && cited(item, packet) &&
        typeof item.normalized_value === 'number' && Number.isFinite(item.normalized_value) &&
        Math.abs(item.normalized_value - expected) <= Math.max(1e-12, Math.abs(expected) * 1e-9) &&
        typeof item.source_value === 'number' && Number.isFinite(item.source_value) &&
        typeof item.source_unit === 'string' && item.source_unit &&
        typeof item.conversion_factor === 'number' && Number.isFinite(item.conversion_factor) &&
        Math.abs(item.source_value * item.conversion_factor - item.normalized_value) <=
          Math.max(1e-12, Math.abs(item.normalized_value) * 1e-9));
      if (!matching.length) errors.push(`No cited, normalized ${field} for ${block.name}`);
    }
  }
  if (!extraction.evidence.some(item => item.field === 'thermal_observable' && cited(item, packet))) {
    errors.push('No cited paper thermal observable');
  }
  if (!Number.isInteger(extraction.thermal_observable?.pdf_page) ||
      extraction.thermal_observable.pdf_page < 1 ||
      extraction.thermal_observable.pdf_page > packet.pages.length ||
      !extraction.thermal_observable.unit || !extraction.thermal_observable.location ||
      !extraction.thermal_observable.aggregation) {
    errors.push('Thermal observable needs a valid page, unit, location, and aggregation');
  }
  if (!extraction.evidence.some(item => item.field === 'regime' && cited(item, packet))) {
    errors.push('No cited steady/transient regime');
  }
  return errors;
}

export function reviewFeasibility(extraction, adversarial, packet, config, independentReview = null) {
  if (extraction?.paper_id !== packet.paper_id) throw Error('Extraction paper ID differs from manifest');
  const blockers = [];
  const inputErrors = validateExperiment(extraction.experiment, config);
  const ledgerErrors = evidenceErrors(extraction, packet);
  blockers.push(...inputErrors, ...ledgerErrors, ...(extraction.missing_inputs || []));
  if (!Number.isInteger(extraction.scenario?.pdf_page) ||
      extraction.scenario.pdf_page < 1 || extraction.scenario.pdf_page > packet.pages.length ||
      !extraction.scenario.description || !extraction.scenario.figure_or_table) {
    blockers.push('Selected scenario needs a valid PDF page and locator');
  }
  if (!['checked_links_found', 'checked_no_links', 'blocked'].includes(extraction.artifact_search_status)) {
    blockers.push('Paper-linked code/data search has no recorded status');
  }
  if (extraction.artifact_search_status === 'blocked') blockers.push('Paper-linked resource search is blocked');
  if (extraction.artifact_search_status === 'checked_links_found' &&
      !extraction.linked_assets?.length) blockers.push('Linked resources were found but not itemized');
  for (const link of extraction.linked_assets || []) {
    if (!packet.assets?.some(asset => asset.id === link.id && asset.status === 'downloaded' &&
      asset.sha256 && asset.version)) blockers.push(`Linked asset ${link.id || link.url} is not pinned and available`);
  }
  for (const key of CHECKS) {
    const check = adversarial?.checklist?.[key];
    if (!check || !['verified', 'not_applicable'].includes(check.status) ||
        typeof check.note !== 'string' || !check.note.trim()) {
      blockers.push(`Adversarial ${key} check is unresolved`);
    }
  }
  if (adversarial?.approved !== true || !Array.isArray(adversarial.findings) || adversarial.findings.length) {
    blockers.push('Adversarial reviewer did not approve all extracted claims');
  }
  const criticalPages = new Set(extraction.evidence.filter(item =>
    [...REQUIRED, 'thermal_observable'].includes(item.field) && Number.isInteger(item.pdf_page))
    .map(item => item.pdf_page));
  if (Number.isInteger(extraction.scenario?.pdf_page)) criticalPages.add(extraction.scenario.pdf_page);
  const neededAssets = new Set(extraction.evidence.filter(item =>
    [...REQUIRED, 'thermal_observable'].includes(item.field) && item.asset_id).map(item => item.asset_id));
  if (![...criticalPages].every(page => adversarial?.checked_pdf_pages?.includes(page)) ||
      ![...neededAssets].every(id => adversarial?.checked_assets?.includes(id))) {
    blockers.push('Adversarial reviewer did not check every critical page or asset');
  }
  const digest = reviewDigest(packet, extraction, adversarial);
  const independentlyVerified = independentReview?.approved === true &&
    typeof independentReview.reviewer === 'string' && independentReview.reviewer.trim() &&
    !Number.isNaN(Date.parse(independentReview.completed_at)) &&
    independentReview.evidence_sha256 === digest &&
    Array.isArray(independentReview.corrections) && independentReview.corrections.length === 0 &&
    [...criticalPages].every(page => independentReview.reviewed_pdf_pages?.includes(page)) &&
    [...neededAssets].every(id => independentReview.reviewed_assets?.includes(id));
  if (!independentlyVerified) blockers.push('Independent page/asset review is pending or does not match this evidence');
  const mismatch = Array.isArray(extraction.physical_mismatches) ? extraction.physical_mismatches : [];
  const essential = mismatch.some(item => item.essential === true);
  const relevant = extraction.scenario?.steady_2d_relevant === true;
  let decision;
  if (!relevant) decision = 'not_2d_applicable';
  else if (essential) decision = 'illustrative_2d_only';
  else if (blockers.length) decision = 'conditional_2d_snapshot';
  else decision = 'candidate_2d_snapshot';
  return { paper_id: packet.paper_id, decision, input_gate_pass: inputErrors.length === 0,
    scientific_gate_pass: relevant && !essential, independently_verified: Boolean(independentlyVerified),
    input_errors: inputErrors, blocking_facts: blockers, physical_mismatches: mismatch,
    studio_assumptions: extraction.studio_assumptions || [], evidence_sha256: digest,
    simulation_allowed: decision === 'candidate_2d_snapshot',
    comparison_valid: false,
    reason: decision === 'candidate_2d_snapshot'
      ? 'A reviewed paper-derived 2D snapshot can be run under Studio bundled package/material assumptions.'
      : [...blockers, ...mismatch.map(item => item.reason)].join('; ') || 'The selected scenario is outside steady 2D scope.' };
}
