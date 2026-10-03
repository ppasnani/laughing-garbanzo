import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { runGraphInFile } from '@ironclad/rivet-node';
import { reviewFeasibility, runStudio } from '../pilot.mjs';

test('Rivet graph keeps the paper in adapted status', async () => {
  const graph = resolve('paper-pilot.rivet-project');
  const fixture = JSON.parse(await readFile('pilot_fixture.json', 'utf8'));
  const packet = { pages: Array.from({ length: 4 }, (_, index) => ({ pdf_page: index + 1 })) };
  const output = await runGraphInFile(graph, {
    graph: 'Paper pilot', inputs: { paper_packet: { type: 'object', value: packet } },
    externalFunctions: {
      extractPaper: async () => ({ type: 'object', value: fixture.extraction }),
      reviewFeasibility: async (_context, extraction) => ({ type: 'object', value: reviewFeasibility(extraction, packet) }),
      runHotspot: async (_context, review) => ({ type: 'object', value: { decision: review.decision, status: 'skipped_in_test' } }),
      assessResult: async (_context, simulation) => ({ type: 'object', value: { verdict: simulation.decision } }),
    },
  });
  assert.equal(output.feasibility.value.decision, 'adapted_only');
  assert.equal(output.feasibility.value.exact_replication_allowed, false);
  assert.equal(output.assessment.value.verdict, 'adapted_only');
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
