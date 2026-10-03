import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { runGraphInFile } from '@ironclad/rivet-node';
import { anthropicJson, reviewFeasibility, runStudio } from '../pilot.mjs';

test('Anthropic Messages call uses the key, Rivet prompt, and JSON schema', async () => {
  const schema = { type: 'object', additionalProperties: false, required: ['ok'],
    properties: { ok: { type: 'boolean' } } };
  const result = await anthropicJson({ system: 'Extract carefully', user: '{"paper_id":"test"}', schema,
    apiKey: 'test-key', model: 'claude-haiku-4-5-20251001', fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(options.headers['x-api-key'], 'test-key');
      assert.equal(options.headers['anthropic-version'], '2023-06-01');
      const request = JSON.parse(options.body);
      assert.equal(request.model, 'claude-haiku-4-5-20251001');
      assert.equal(request.system, 'Extract carefully');
      assert.deepEqual(request.messages, [{ role: 'user', content: '{"paper_id":"test"}' }]);
      assert.deepEqual(request.output_config, { format: { type: 'json_schema', schema } });
      assert.equal(request.stream, undefined);
      return new Response(JSON.stringify({ stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"ok":true}' }] }));
    } });
  assert.deepEqual(result, { ok: true });
});

test('Anthropic truncated output is rejected', async () => {
  await assert.rejects(anthropicJson({ system: 'test', user: 'test', schema: {}, apiKey: 'test-key',
    fetchImpl: async () => new Response(JSON.stringify({ stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"ok":' }] })) }), /stopped with max_tokens/);
});

test('Rivet graph keeps the paper in adapted status', async () => {
  const graph = resolve('paper-pilot.rivet-project');
  const fixture = JSON.parse(await readFile('pilot_fixture.json', 'utf8'));
  const packet = { pages: Array.from({ length: 4 }, (_, index) => ({ pdf_page: index + 1 })) };
  let extractionInstructions;
  let assessmentInstructions;
  const output = await runGraphInFile(graph, {
    graph: 'Paper pilot', inputs: { paper_packet: { type: 'object', value: packet } },
    externalFunctions: {
      extractPaper: async (_context, input, instructions) => {
        assert.deepEqual(input, packet);
        extractionInstructions = instructions;
        return { type: 'object', value: fixture.extraction };
      },
      reviewFeasibility: async (_context, extraction) => ({ type: 'object', value: reviewFeasibility(extraction, packet) }),
      runHotspot: async (_context, review) => ({ type: 'object', value: { decision: review.decision, status: 'skipped_in_test' } }),
      assessResult: async (_context, simulation, instructions) => {
        assessmentInstructions = instructions;
        return { type: 'object', value: { verdict: simulation.decision } };
      },
    },
  });
  assert.equal(output.feasibility.value.decision, 'adapted_only');
  assert.equal(output.feasibility.value.exact_replication_allowed, false);
  assert.equal(output.feasibility.value.extraction_complete, true);
  assert.deepEqual(output.feasibility.value.missing_evidence_fields, []);
  assert.equal(output.assessment.value.verdict, 'adapted_only');
  assert.match(extractionInstructions, /Extract only facts supported by this PDF/);
  assert.match(assessmentInstructions, /Assess this simulation conservatively/);
});

test('missing LLM evidence is recorded without claiming exact replication', async () => {
  const fixture = JSON.parse(await readFile('pilot_fixture.json', 'utf8'));
  fixture.extraction.evidence = fixture.extraction.evidence.filter(item => item.field !== 'processor');
  const review = reviewFeasibility(fixture.extraction, { pages: [{}, {}, {}, {}] });
  assert.equal(review.decision, 'adapted_only');
  assert.equal(review.exact_replication_allowed, false);
  assert.equal(review.extraction_complete, false);
  assert.deepEqual(review.missing_evidence_fields, ['processor']);
});

test('paper citations outside the PDF are rejected', async () => {
  const fixture = JSON.parse(await readFile('pilot_fixture.json', 'utf8'));
  fixture.extraction.evidence[0].pdf_page = 99;
  assert.throws(() => reviewFeasibility(fixture.extraction, { pages: [{}, {}, {}, {}] }), /PDF page/);
});

test('artifact size mismatch stops result storage', async () => {
  const outputDir = await mkdtemp(resolve(tmpdir(), 'thermal-pilot-test-'));
  const fakeFetch = async url => {
    const path = String(url);
    if (path.endsWith('/api/status')) return new Response(JSON.stringify({ ready: true, token: 'test' }));
    if (path.endsWith('/api/runs')) return new Response(JSON.stringify({ id: 'a'.repeat(32), status: 'completed', rows: [],
      artifacts: { 'gcc.steady': { url: '/gcc.steady', bytes: 999 }, 'gcc.ttrace': { url: '/gcc.ttrace', bytes: 2 } } }), { status: 201 });
    return new Response('x');
  };
  try {
    await assert.rejects(runStudio({ baseUrl: 'http://127.0.0.1:8127', config: '-ambient 300',
      outputDir, fetchImpl: fakeFetch }), /size mismatch/);
  } finally {
    await rm(outputDir, { recursive: true });
  }
});
