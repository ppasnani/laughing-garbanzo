import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { runGraphInFile } from '@ironclad/rivet-node';
import { anthropicJson, anthropicExtraction, execute, parseCsv, runStudio, normalizeExtraction,
  EXTRACTION_SCHEMA, EXTRACTION_SECTION_SCHEMAS } from '../pilot.mjs';
import { reviewDigest, reviewFeasibility, suitableVerdict, sha256, validateExperiment } from '../screening.mjs';
import { referenceSelection, loadReferenceInputs, loadEv6Example, referenceExperiment,
  applyReferenceInputs, referenceConfig } from '../reference-inputs.mjs';

const config = await readFile(resolve('../hotspot-studio/dist/example.config'), 'utf8');
const packet = { paper_id: 'W123', pdf_sha256: 'pdfhash',
  pages: [{ pdf_page: 1, text: 'methods, coordinates, power' },
    { pdf_page: 2, text: 'thermal results' }], assets: [], page_count: 2 };
const experiment = { kind: 'custom_2d_steady', floorplan: [
  { name: 'core0', x_m: 0, y_m: 0, width_m: 0.005, height_m: 0.005 },
  { name: 'core1', x_m: 0.005, y_m: 0, width_m: 0.005, height_m: 0.005 },
], power_w: { core0: 8, core1: 6 } };
const cited = (field, block_name, value) => ({
  field, block_name, source_value: value, source_unit: field === 'power_w' ? 'W' : 'm',
  conversion_factor: 1, normalized_value: value, pdf_page: 1,
  asset_id: null, locator: 'Table 1', provenance: 'table',
});
const extraction = { paper_id: 'W123', paper_title: 'Test paper',
  artifact_search_status: 'checked_no_links', linked_assets: [],
  scenario: { pdf_page: 1, figure_or_table: 'Table 1', description: 'One planar run',
    steady_2d_relevant: true },
  evidence: [
    ...experiment.floorplan.flatMap(block => [
      ...['x_m', 'y_m', 'width_m', 'height_m'].map(field => cited(field, block.name, block[field])),
      cited('power_w', block.name, experiment.power_w[block.name]),
    ]),
    { field: 'regime', pdf_page: 1, locator: 'Methods', provenance: 'explicit_text' },
    { field: 'thermal_observable', pdf_page: 2, locator: 'Figure 2', provenance: 'figure_digitized' },
  ],
  experiment, thermal_observable: { value: 345, unit: 'K', location: 'core0',
    aggregation: 'peak block', pdf_page: 2 },
  physical_mismatches: [], studio_assumptions: ['Bundled materials and package'], missing_inputs: [] };
const adversarial = { approved: true, checklist: Object.fromEntries(
  ['methods', 'code', 'parameters', 'config', 'data'].map(key => [key,
    { status: key === 'code' || key === 'data' ? 'not_applicable' : 'verified',
      note: key + ' checked against supplied pages' }])),
  findings: [], checked_pdf_pages: [1, 2], checked_assets: [] };
const review = { reviewer: 'second reader', completed_at: '2026-10-03T12:00:00Z',
  evidence_sha256: reviewDigest(packet, extraction, adversarial), approved: true,
  reviewed_pdf_pages: [1, 2], reviewed_assets: [], corrections: [] };

test('manifest parser preserves quoted article titles and current paper rows', async () => {
  const text = await readFile(resolve('../chip_thermal_management_papers/download_manifest.csv'), 'utf8');
  const rows = parseCsv(text);
  assert.ok(rows.length > 0);
  assert.equal(new Set(rows.map(row => row.openalex_id)).size, rows.length);
  assert.ok(rows.some(row => row.title.startsWith('ATPlace2.5D')));
  assert.ok(rows.some(row => row.title.startsWith('RLPlanner')));
  assert.equal(parseCsv('openalex_id,title\nW1,"Power, heat, and data"\n')[0].title,
    'Power, heat, and data');
});

test('structured extraction schema uses fixed properties and normalizes named power rows', () => {
  const visit = schema => {
    if (schema?.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      for (const child of Object.values(schema.properties)) visit(child);
    }
    if (schema?.type === 'array') visit(schema.items);
  };
  visit(EXTRACTION_SCHEMA);
  const result = normalizeExtraction({ experiment: { kind: 'custom_2d_steady',
    floorplan: experiment.floorplan, power_rows: [{ name: 'core0', watts: 8 },
      { name: 'core1', watts: 6 }] } });
  assert.deepEqual(result.experiment, experiment);
});

test('scientific verdict and Studio inputs both control simulation permission', () => {
  for (const verdict of ['candidate_2d_snapshot', 'conditional_2d_snapshot',
    'conditional_with_caveats', 'illustrative_2d_only', 'adapted_only']) {
    assert.equal(suitableVerdict(verdict), true, verdict);
  }
  for (const verdict of ['not_2d_applicable', 'source_unavailable',
    'unsupported_current_backend', '', null]) {
    assert.equal(suitableVerdict(verdict), false, String(verdict));
  }
  assert.equal(reviewFeasibility(extraction, adversarial, packet, config).decision,
    'conditional_2d_snapshot');
  const accepted = reviewFeasibility(extraction, adversarial, packet, config, review);
  assert.equal(accepted.decision, 'candidate_2d_snapshot');
  assert.equal(accepted.simulation_allowed, true);
  const challenged = structuredClone(adversarial);
  challenged.checklist.parameters.status = 'contradicted';
  challenged.findings.push({ field: 'power_w', reason: 'wrong scenario', locator: 'Table 1' });
  challenged.approved = false;
  assert.equal(reviewFeasibility(extraction, challenged, packet, config, review).simulation_allowed, true);
  const invented = structuredClone(extraction);
  invented.evidence = invented.evidence.filter(item =>
    !(item.field === 'power_w' && item.block_name === 'core1'));
  assert.equal(reviewFeasibility(invented, adversarial, packet, config, review).simulation_allowed, true);
  const changed = structuredClone(extraction);
  changed.experiment.power_w.core0 = 10;
  assert.equal(reviewFeasibility(changed, adversarial, packet, config, review).simulation_allowed, true);
  const illustrative = structuredClone(extraction);
  illustrative.physical_mismatches.push({ reason: 'Vertical cooling affects the result', essential: true });
  const illustrativeReview = reviewFeasibility(illustrative, adversarial, packet, config, review);
  assert.equal(illustrativeReview.decision, 'illustrative_2d_only');
  assert.equal(illustrativeReview.scientific_gate_pass, false);
  assert.equal(illustrativeReview.simulation_allowed, true);
  const unsuitable = structuredClone(extraction);
  unsuitable.scenario.steady_2d_relevant = false;
  const unsuitableReview = reviewFeasibility(unsuitable, adversarial, packet, config, review);
  assert.equal(unsuitableReview.decision, 'not_2d_applicable');
  assert.equal(unsuitableReview.input_gate_pass, true);
  assert.equal(unsuitableReview.simulation_allowed, false);
  const invalid = structuredClone(extraction);
  invalid.experiment.floorplan[1].x_m = invalid.experiment.floorplan[0].x_m;
  assert.equal(reviewFeasibility(invalid, adversarial, packet, config, review).simulation_allowed, false);
});

test('descriptive provenance with a valid page is accepted without hiding missing citations', () => {
  const described = structuredClone(extraction);
  described.evidence[0].provenance = 'Paper Table 1, manually checked in the PDF';
  const result = reviewFeasibility(described, adversarial, packet, config);
  assert.equal(result.blocking_facts.some(item => item.startsWith('Evidence 0 lacks')), false);
  described.evidence[0].provenance = '  ';
  const invalid = reviewFeasibility(described, adversarial, packet, config);
  assert.equal(invalid.blocking_facts.some(item => item.startsWith('Evidence 0 lacks')), true);
});

test('Ascend910 source dimensions and watts create an illustrative valid snapshot', () => {
  const reference = { kind: 'ascend910', repo: 'weiweihook/RLPlanner', commit: 'test-revision',
    caseName: null, assets: [{ id: 'ref_ascend910_cfg', path: 'config/Ascend910.cfg',
      text: '[chiplets]\nchiplet_count = 2\nwidths = 10, 8\nheights = 9, 7\npowers = 40, 20\n' }] };
  const prepared = referenceExperiment(reference);
  assert.deepEqual(Object.values(prepared.experiment.power_w), [40, 20]);
  const adapted = applyReferenceInputs({ ...structuredClone(extraction),
    scenario: { ...extraction.scenario, description: 'Ascend 910 System' },
    experiment: { kind: 'custom_2d_steady', floorplan: [], power_w: {} } }, reference, prepared);
  assert.equal(adapted.experiment.floorplan.length, 2);
  assert.equal(adapted.physical_mismatches.at(-1).essential, true);
  assert.equal(adapted.evidence.filter(item => item.asset_id === 'ref_ascend910_cfg').length, 6);
  assert.equal(adapted.evidence.find(item => item.field === 'x_m' &&
    item.block_name === 'chiplet_1').source_value, null);
  const tuned = referenceConfig(config, reference, prepared);
  assert.deepEqual(validateExperiment(adapted.experiment, tuned), []);
  const reviewed = reviewFeasibility(adapted, adversarial, packet, tuned);
  assert.equal(reviewed.decision, 'illustrative_2d_only');
  assert.equal(reviewed.simulation_allowed, true);
  assert.deepEqual(applyReferenceInputs(adapted, reference, prepared), adapted);
});

test('ATPlace zero placement is replaced with a cited-size illustrative layout', () => {
  const reference = { kind: 'atplace', repo: 'PKU-IDEA/ATPlace_pub', commit: 'test-revision',
    caseName: 'Case3', assets: [
      { id: 'ref_atplace_blocks', path: 'cases/Case3/Case3.blocks', text:
        'NumHardRectilinearBlocks : 2\nCPU_0 hardrectilinear 4 (0, 0) (0, 9000) (8000, 9000) (8000, 0)\nDRAM_0 hardrectilinear 4 (0, 0) (0, 9000) (9000, 9000) (9000, 0)\n' },
      { id: 'ref_atplace_power', path: 'cases/Case3/Case3.power', text: 'CPU_0 150\nDRAM_0 20\n' },
      { id: 'ref_atplace_placement', path: 'cases/Case3/Case3.pl', text: 'CPU_0 0 0\nDRAM_0 0 0\n' },
      { id: 'ref_atplace_hotspot_config', path: 'thermal/hotspot.config', text:
        '-r_convec 0.01\n-s_spreader 0.01\n-s_sink 0.06\n-model_type block\n-model_secondary 0\n' },
      { id: 'ref_atplace_reproduce', path: 'reproduce.py', text:
        'CASE_INTERPOSER_SIZE = {"Case3": [39000.0, 39000.0]}\n' },
    ] };
  const prepared = referenceExperiment(reference);
  assert.equal(prepared.generated, true);
  assert.deepEqual(prepared.experiment.power_w, { CPU_0: 150, DRAM_0: 20 });
  assert.equal(prepared.evidence.find(item => item.field === 'x_m').source_value, null);
  assert.notDeepEqual(prepared.experiment.floorplan.map(block => block.x_m), [0, 0]);
  const tuned = referenceConfig(config, reference, prepared);
  assert.deepEqual(validateExperiment(prepared.experiment, tuned), []);
  assert.match(tuned, /-r_convec\s+0\.01/);
  assert.throws(() => applyReferenceInputs({ ...extraction,
    scenario: { ...extraction.scenario, description: 'Case 2' } }, reference, prepared),
    /does not match/);
});

test('bundled EV6 and GCC inputs are available only as an illustrative fallback', async () => {
  const reference = await loadEv6Example();
  const prepared = referenceExperiment(reference);
  assert.equal(prepared.experiment.floorplan.length, 30);
  assert.deepEqual(validateExperiment(prepared.experiment,
    referenceConfig(config, reference, prepared)), []);
  const adapted = applyReferenceInputs({ ...structuredClone(extraction),
    experiment: { kind: 'custom_2d_steady', floorplan: [], power_w: {} } }, reference, prepared);
  assert.equal(adapted.physical_mismatches.at(-1).essential, true);
  assert.match(adapted.physical_mismatches.at(-1).reason, /unrelated to this paper/);
  assert.equal(referenceSelection({ title: 'ATPlace2.5D example' }).caseName, 'Case3');
  assert.throws(() => referenceSelection({ title: 'ATPlace2.5D example' }, 'Case11'));
  await assert.rejects(loadReferenceInputs(referenceSelection({ title: 'RLPlanner paper' }),
    async () => new Response('changed source')),
    /SHA-256 mismatch/);
});

test('backend input gate rejects overlapping blocks and mismatched names', () => {
  const overlap = structuredClone(experiment);
  overlap.floorplan[1].x_m = 0.004;
  assert.match(validateExperiment(overlap, config).join(' '), /overlaps/);
  const names = structuredClone(experiment);
  names.power_w = { other: 6, core0: 8 };
  assert.match(validateExperiment(names, config).join(' '), /names differ/);
});

test('Anthropic call carries the Rivet prompt and rejects truncated output', async () => {
  const result = await anthropicJson({ system: 'Challenge claims', user: '{"paper_id":"W123"}',
    schema: { type: 'object' }, apiKey: 'test-key', fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(options.headers['x-api-key'], 'test-key');
      const body = JSON.parse(options.body);
      assert.equal(body.system, 'Challenge claims');
      assert.equal(body.output_config.format.type, 'json_schema');
      return new Response(JSON.stringify({ stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"ok":true}' }] }));
    } });
  assert.deepEqual(result, { ok: true });
  await assert.rejects(anthropicJson({ system: 'test', user: 'test', schema: {},
    apiKey: 'test-key', fetchImpl: async () => new Response(JSON.stringify({
      stop_reason: 'max_tokens', content: [{ type: 'text', text: '{}' }] })) }), /max_tokens/);
});

test('live extraction uses small typed sections and retains the full evidence contract', async () => {
  const source = { ...extraction, original_setup: { solver: '', optimizer: '', controller: '', benchmark: '' },
    experiment: { kind: 'custom_2d_steady',
    floorplan: experiment.floorplan,
    power_rows: [{ name: 'core0', watts: 8 }, { name: 'core1', watts: 6 }] } };
  const sections = Object.entries(EXTRACTION_SECTION_SCHEMAS);
  let call = 0;
  const result = await anthropicExtraction({ system: 'Extract cited evidence', packet,
    apiKey: 'test-key',
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        const [name, schema] = sections[call++];
        assert.deepEqual(request.output_config.format.schema, schema);
        assert.match(request.system, /Extract cited evidence/);
        assert.match(request.system, new RegExp(name + ' section'));
        assert.equal(JSON.parse(request.messages[0].content).paper_packet.paper_id, 'W123');
        return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [
          { type: 'text', text: JSON.stringify(Object.fromEntries(
            Object.keys(schema.properties).map(key => [key, source[key]]))) },
        ] }));
      } });
  assert.equal(call, sections.length);
  assert.equal(result.paper_id, 'W123');
  assert.equal(result.evidence.length, extraction.evidence.length);
  assert.deepEqual(Object.keys(result).sort(), Object.keys(EXTRACTION_SCHEMA.properties).sort());
});

test('Rivet graph executes extraction, adversarial review, gate, run, and assessment in order', async () => {
  const graph = resolve('paper-pilot.rivet-project');
  const calls = [];
  const output = await runGraphInFile(graph, { graph: 'Paper pilot',
    inputs: { paper_packet: { type: 'object', value: packet } },
    externalFunctions: {
      extractPaper: async (_ctx, input, prompt) => {
        calls.push('extract'); assert.deepEqual(input, packet);
        assert.match(prompt, /one identifiable published scenario/);
        return { type: 'object', value: extraction };
      },
      adversarialReview: async (_ctx, input, prompt) => {
        calls.push('adversarial'); assert.deepEqual(input, extraction);
        assert.match(prompt, /method.*code.*parameter.*config.*data/);
        return { type: 'object', value: adversarial };
      },
      reviewFeasibility: async (_ctx, input) => {
        calls.push('gate'); assert.deepEqual(input, adversarial);
        return { type: 'object', value: reviewFeasibility(extraction, input, packet, config) };
      },
      runHotspot: async (_ctx, input) => {
        calls.push('run'); assert.equal(input.simulation_allowed, true);
        return { type: 'object', value: { status: 'completed' } };
      },
      assessResult: async (_ctx, input, prompt) => {
        calls.push('assess'); assert.equal(input.status, 'completed');
        assert.match(prompt, /conservatively/);
        return { type: 'object', value: { verdict: 'conditional_2d_snapshot' } };
      },
    } });
  assert.deepEqual(calls, ['extract', 'adversarial', 'gate', 'run', 'assess']);
  assert.equal(output.feasibility.value.decision, 'conditional_2d_snapshot');
});

function studioFetch({ tamper = false } = {}) {
  const runId = 'a'.repeat(32);
  const files = {
    'submitted.experiment.json': JSON.stringify(experiment),
    'input.flp': 'core0 0.005 0.005 0 0\ncore1 0.005 0.005 0.005 0\n',
    'input.ptrace': 'core0 core1\n8 6\n',
    'temperatures.steady': 'core0 345\ncore1 340\n',
  };
  const artifacts = Object.fromEntries(Object.entries(files).map(([name, data]) => [name,
    { url: '/api/runs/' + runId + '/artifacts/' + name, bytes: Buffer.byteLength(data),
      sha256: tamper && name === 'input.ptrace' ? 'wrong' : sha256(data) }]));
  return async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/api/status') return new Response(JSON.stringify({ ready: true, token: 'test' }));
    if (path === '/api/runs' && options.method === 'POST') {
      assert.deepEqual(JSON.parse(options.body), { config, experiment });
      return new Response(JSON.stringify({ id: runId }), { status: 201 });
    }
    if (path === '/api/runs/' + runId) return new Response(JSON.stringify({
      id: runId, status: 'completed', log: 'solver ok', experiment: {
        kind: 'custom_2d_steady', model_type: 'block', input_sha256: 'server-input-hash',
        assumptions: 'Bundled package/materials' }, rows: [
        { name: 'core0', kelvin: 345, celsius: 71.85 },
        { name: 'core1', kelvin: 340, celsius: 66.85 }], artifacts }));
    if (path === '/api/runs/' + runId + '/config') return new Response(config);
    const name = path.split('/').at(-1);
    if (name in files) return new Response(files[name]);
    throw Error('Unexpected fetch: ' + path);
  };
}

test('custom Studio API round trip verifies every artifact hash and named temperatures', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'paper-pilot-'));
  try {
    const result = await runStudio({ baseUrl: 'http://127.0.0.1:8000', config,
      experiment, outputDir: dir, fetchImpl: studioFetch() });
    assert.equal(result.run_kind, 'custom_2d_steady');
    assert.equal(result.input_sha256, 'server-input-hash');
    assert.equal(Object.keys(result.artifacts).length, 4);
    assert.equal(await readFile(resolve(dir, 'solver.log'), 'utf8'), 'solver ok');
    await assert.rejects(runStudio({ baseUrl: 'http://127.0.0.1:8000', config,
      experiment, outputDir: dir, fetchImpl: studioFetch({ tamper: true }) }), /SHA-256 mismatch/);
  } finally { await rm(dir, { recursive: true }); }
});

test('complete custom Rivet execution saves a reviewed candidate and Studio artifacts', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'paper-pilot-'));
  try {
    const result = await execute({ row: { openalex_id: 'W123', title: 'Test paper',
      status: 'downloaded', source_url: 'test' }, packet, config, outputDir: dir,
      runType: 'custom', fixture: { extraction, adversarial,
        assessment: { summary: 'Studio approximation', limitations: [] } },
      independentReview: review, fetchImpl: studioFetch() });
    assert.equal(result.feasibility.decision, 'candidate_2d_snapshot');
    assert.equal(result.simulation.status, 'completed');
    assert.equal(result.assessment.comparison_valid, false);
    assert.equal(result.simulation.artifacts['input.flp'].sha256,
      sha256(await readFile(resolve(dir, 'input.flp'))));
  } finally { await rm(dir, { recursive: true }); }
});

test('unreviewed custom evidence still runs as a non-comparable exploratory simulation', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'paper-pilot-'));
  try {
    const disputed = structuredClone(adversarial);
    disputed.approved = false;
    disputed.checklist.data.status = 'missing';
    disputed.findings.push({ field: 'power_w', reason: 'Power source unverified', locator: 'Table 1' });
    const uncited = structuredClone(extraction);
    uncited.evidence = [];
    const result = await execute({ row: { openalex_id: 'W123', title: 'Test paper',
      status: 'downloaded', source_url: 'test' }, packet, config, outputDir: dir,
      runType: 'custom', fixture: { extraction: uncited, adversarial: disputed,
        assessment: { summary: 'Exploratory Studio run', limitations: [] } },
      fetchImpl: studioFetch() });
    assert.equal(result.feasibility.decision, 'conditional_2d_snapshot');
    assert.equal(result.feasibility.simulation_allowed, true);
    assert.equal(result.simulation.status, 'completed');
    assert.equal(result.assessment.comparison_valid, false);
    assert.equal(result.adversarial.findings[0].reason, 'Power source unverified');
  } finally { await rm(dir, { recursive: true }); }
});

test('illustrative verdict permits a Studio proxy without implying scientific equivalence', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'paper-pilot-'));
  try {
    const proxy = structuredClone(extraction);
    proxy.physical_mismatches.push({ reason: 'Vertical heat path is omitted', essential: true });
    const result = await execute({ row: { openalex_id: 'W123', title: 'Test paper',
      status: 'downloaded', source_url: 'test' }, packet, config, outputDir: dir,
      runType: 'custom', fixture: { extraction: proxy, adversarial,
        assessment: { summary: 'Illustrative proxy', limitations: [] } },
      fetchImpl: studioFetch() });
    assert.equal(result.feasibility.decision, 'illustrative_2d_only');
    assert.equal(result.feasibility.scientific_gate_pass, false);
    assert.equal(result.simulation.status, 'completed');
    assert.equal(result.assessment.comparison_valid, false);
  } finally { await rm(dir, { recursive: true }); }
});

test('unsuitable paper stops before Studio while retaining feasibility evidence', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'paper-pilot-'));
  try {
    const unsuitable = structuredClone(extraction);
    unsuitable.scenario.steady_2d_relevant = false;
    const result = await execute({ row: { openalex_id: 'W123', title: 'Test paper',
      status: 'downloaded', source_url: 'test' }, packet, config, outputDir: dir,
      runType: 'custom', fixture: { extraction: unsuitable, adversarial,
        assessment: { summary: 'No suitable 2D scenario', limitations: [] } },
      fetchImpl: () => { throw Error('Studio must not be called'); } });
    assert.equal(result.feasibility.decision, 'not_2d_applicable');
    assert.equal(result.simulation.status, 'skipped');
    assert.match(result.simulation.reason, /verdict not_2d_applicable/);
    assert.equal(result.assessment.verdict, 'not_2d_applicable');
  } finally { await rm(dir, { recursive: true }); }
});

test('extraction failure identifies the paper and stage after Rivet wraps the error', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'paper-pilot-'));
  try {
    const badExtraction = structuredClone(extraction);
    badExtraction.experiment = { kind: 'custom_2d_steady', floorplan: experiment.floorplan,
      power_rows: [{ name: 'core0', watts: 8 }, { name: 'core0', watts: 6 }] };
    await assert.rejects(execute({ row: { openalex_id: 'W123', title: 'Test paper' },
      packet, config, outputDir: dir, runType: 'custom',
      fixture: { extraction: badExtraction } }), /Paper W123 failed at extractPaper: Duplicate extracted power row/);
    const failure = JSON.parse(await readFile(resolve(dir, 'stage-error.json'), 'utf8'));
    assert.equal(failure.paper_id, 'W123');
    assert.equal(failure.stage, 'extractPaper');
  } finally { await rm(dir, { recursive: true }); }
});
