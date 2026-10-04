import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { runGraphInFile } from '@ironclad/rivet-node';
import { anthropicJson, anthropicExtraction, execute, parseCsv, runStudio, normalizeExtraction,
  EXTRACTION_SCHEMA, EXTRACTION_ENVELOPE_SCHEMA } from '../pilot.mjs';
import { reviewDigest, reviewFeasibility, sha256, validateExperiment } from '../screening.mjs';

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

test('manifest parser preserves quoted article titles and 31 rows', async () => {
  const text = await readFile(resolve('../chip_thermal_management_papers/download_manifest.csv'), 'utf8');
  const rows = parseCsv(text);
  assert.equal(rows.length, 31);
  assert.equal(rows.filter(row => row.status === 'downloaded').length, 22);
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

test('adversarial and independent verification gate custom simulation', () => {
  assert.equal(reviewFeasibility(extraction, adversarial, packet, config).decision,
    'conditional_2d_snapshot');
  const accepted = reviewFeasibility(extraction, adversarial, packet, config, review);
  assert.equal(accepted.decision, 'candidate_2d_snapshot');
  assert.equal(accepted.simulation_allowed, true);
  const challenged = structuredClone(adversarial);
  challenged.checklist.parameters.status = 'contradicted';
  challenged.findings.push({ field: 'power_w', reason: 'wrong scenario', locator: 'Table 1' });
  challenged.approved = false;
  assert.equal(reviewFeasibility(extraction, challenged, packet, config, review).simulation_allowed, false);
  const invented = structuredClone(extraction);
  invented.evidence = invented.evidence.filter(item =>
    !(item.field === 'power_w' && item.block_name === 'core1'));
  assert.equal(reviewFeasibility(invented, adversarial, packet, config, review).simulation_allowed, false);
  const changed = structuredClone(extraction);
  changed.experiment.power_w.core0 = 10;
  assert.equal(reviewFeasibility(changed, adversarial, packet, config, review).simulation_allowed, false);
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

test('live extraction uses a compact grammar while retaining the full evidence contract', async () => {
  const result = await anthropicExtraction({ system: 'Extract cited evidence', packet,
    apiKey: 'test-key',
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        assert.deepEqual(request.output_config.format.schema, EXTRACTION_ENVELOPE_SCHEMA);
        assert.match(request.system, /Extract cited evidence/);
        assert.deepEqual(JSON.parse(request.messages[0].content).extraction_schema, EXTRACTION_SCHEMA);
        return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [
          { type: 'text', text: JSON.stringify({ extraction_json: JSON.stringify({
            ...extraction, experiment: { kind: 'custom_2d_steady', floorplan: experiment.floorplan,
              power_rows: [{ name: 'core0', watts: 8 }, { name: 'core1', watts: 6 }] },
          }) }) },
        ] }));
      } });
  assert.equal(result.paper_id, 'W123');
  assert.equal(result.evidence.length, extraction.evidence.length);
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
        calls.push('run'); assert.equal(input.simulation_allowed, false);
        return { type: 'object', value: { status: 'skipped' } };
      },
      assessResult: async (_ctx, input, prompt) => {
        calls.push('assess'); assert.equal(input.status, 'skipped');
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
