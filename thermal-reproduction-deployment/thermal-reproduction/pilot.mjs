import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runGraphInFile } from '@ironclad/rivet-node';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PAPER_ID = 'W4206159291';
const PAPER_FILE = '2020_W4206159291_Thermal_Simulation_of_a_CPU_Based_on_Model_Order_Reduction.pdf';
const GRAPH = join(HERE, 'paper-pilot.rivet-project');
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const EVIDENCE_FIELDS = ['processor', 'thermal_method', 'geometry', 'mesh', 'power', 'boundary', 'reported_result'];
const REQUIRED_EVIDENCE_FIELDS = ['processor', 'thermal_method', 'geometry', 'power', 'reported_result'];

const EXTRACTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['paper_id', 'paper_title', 'evidence', 'missing_for_exact_replication'],
  properties: {
    paper_id: { type: 'string' },
    paper_title: { type: 'string' },
    evidence: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['field', 'value', 'pdf_page'], properties: {
        field: { type: 'string', enum: EVIDENCE_FIELDS }, value: { type: 'string' },
        pdf_page: { type: 'integer' },
      } } },
    missing_for_exact_replication: { type: 'array', items: { type: 'string' } },
  },
};

const ASSESSMENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'summary', 'limitations'],
  properties: {
    verdict: { type: 'string', enum: ['adapted_only'] },
    summary: { type: 'string' },
    limitations: { type: 'array', items: { type: 'string' } },
  },
};

export const sha256 = value => createHash('sha256').update(value).digest('hex');
const jsonFile = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

export async function paperPacket(pdfPath, pdftotext = process.env.PDFTOTEXT || 'pdftotext') {
  const source = await readFile(pdfPath);
  const { stdout } = await execFileAsync(pdftotext, ['-layout', pdfPath, '-'], {
    encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 30000,
  });
  const pages = stdout.split('\f').filter(text => text.trim()).map((text, index) => ({
    pdf_page: index + 1, text,
  }));
  if (pages.length !== 4) throw Error(`Expected four PDF pages for pilot; found ${pages.length}`);
  return { paper_id: PAPER_ID, title: 'Thermal Simulation of a CPU Based on Model Order Reduction',
    pdf_path: pdfPath, pdf_sha256: sha256(source), pages };
}

export function reviewFeasibility(extraction, packet) {
  if (extraction.paper_id !== PAPER_ID || !Array.isArray(extraction.evidence)) {
    throw Error('Extraction has the wrong paper ID or no evidence array');
  }
  for (const item of extraction.evidence) {
    if (!item.field || !item.value || !Number.isInteger(item.pdf_page) ||
        item.pdf_page < 1 || item.pdf_page > packet.pages.length) {
      throw Error('Extraction contains an invalid field or PDF page citation');
    }
  }
  const fields = new Set(extraction.evidence.map(item => item.field.trim().toLowerCase()));
  const missingEvidenceFields = REQUIRED_EVIDENCE_FIELDS.filter(field => !fields.has(field));
  return {
    paper_id: PAPER_ID,
    decision: 'adapted_only',
    exact_replication_allowed: false,
    adapted_demo_allowed: true,
    extraction_complete: missingEvidenceFields.length === 0,
    missing_evidence_fields: missingEvidenceFields,
    reason: 'The paper uses an Alpha EV6 but its 3D FEniCS/POD experiment and pulsed power are different from the fixed EV6/GCC HotSpot run.',
    current_backend: 'EV6 floorplan, GCC power trace, HotSpot block/grid; steady and seeded transient outputs',
    comparison_valid: false,
    required_for_exact_replication: ['paper 3D geometry', 'paper pulsed power', 'paper boundary conditions', 'FEniCS/POD implementation'],
  };
}

export async function runStudio({ baseUrl, config, outputDir, fetchImpl = fetch }) {
  const origin = baseUrl.replace(/\/$/, '');
  const statusResponse = await fetchImpl(`${origin}/api/status`, { signal: AbortSignal.timeout(10000) });
  if (!statusResponse.ok) throw Error(`Studio status returned ${statusResponse.status}`);
  const status = await statusResponse.json();
  if (!status.ready || !status.token) throw Error('Studio is not ready for simulation');
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetchImpl(`${origin}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': status.token },
      body: JSON.stringify({ config }), signal: AbortSignal.timeout(75000),
    });
    if (response.status !== 409) break;
    await response.text();
    await delay(1000 * (attempt + 1));
  }
  if (response.status !== 201) throw Error(`Studio run returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const run = await response.json();
  await jsonFile(join(outputDir, 'studio-result.json'), run);
  if (run.status !== 'completed') throw Error(`Studio run ${run.id} ended as ${run.status}: ${run.log || ''}`);
  const artifacts = {};
  for (const filename of ['gcc.steady', 'gcc.ttrace']) {
    const advertised = run.artifacts?.[filename];
    if (!advertised?.url) throw Error(`Studio did not advertise ${filename}`);
    const url = new URL(advertised.url, origin);
    if (url.origin !== new URL(origin).origin) throw Error('Artifact URL changed origin');
    const artifactResponse = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    if (!artifactResponse.ok) throw Error(`Artifact ${filename} returned ${artifactResponse.status}`);
    const bytes = Buffer.from(await artifactResponse.arrayBuffer());
    if (!bytes.length || bytes.length !== advertised.bytes) throw Error(`Artifact ${filename} size mismatch`);
    await writeFile(join(outputDir, filename), bytes);
    artifacts[filename] = { path: filename, bytes: bytes.length, sha256: sha256(bytes),
      studio_url: advertised.url };
  }
  return { status: run.status, studio_run_id: run.id, rows: run.rows,
    config_sha256: sha256(config), artifacts, comparison_valid: false };
}

export async function anthropicJson({ system, user, schema, apiKey = process.env.ANTHROPIC_API_KEY,
  model = process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL, fetchImpl = fetch }) {
  if (!apiKey) throw Error('Set ANTHROPIC_API_KEY, or use --mock-llm');
  const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(90000),
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey,
      'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 4096, system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema } } }),
  });
  if (!response.ok) throw Error(`Anthropic returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const body = await response.json();
  if (body.stop_reason !== 'end_turn') throw Error(`Anthropic stopped with ${body.stop_reason || 'unknown reason'}`);
  const blocks = body.content?.filter(part => part.type === 'text' && typeof part.text === 'string');
  if (blocks?.length !== 1) throw Error('Anthropic response had no single JSON text block');
  return JSON.parse(blocks[0].text);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const mockLlm = args.has('--mock-llm');
  const allowAdapted = args.has('--allow-adapted');
  if (!allowAdapted) throw Error('This paper only supports an adapted demo. Pass --allow-adapted to run it.');
  if (!mockLlm && !process.env.ANTHROPIC_API_KEY) throw Error('Set ANTHROPIC_API_KEY, or use --mock-llm');
  const pdfPath = resolve(ROOT, 'chip_thermal_management_papers', PAPER_FILE);
  const packet = await paperPacket(pdfPath);
  const outputDir = resolve(HERE, 'pilot-output', PAPER_ID, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(outputDir, { recursive: true });
  const fixture = mockLlm ? JSON.parse(await readFile(join(HERE, 'pilot_fixture.json'), 'utf8')) : null;
  const config = await readFile(resolve(ROOT, 'hotspot-studio/dist/example.config'), 'utf8');
  const graphHash = sha256(await readFile(GRAPH));
  const baseUrl = process.env.HOTSPOT_BASE_URL || 'http://127.0.0.1:8000';
  const saveStage = async (name, value) => { await jsonFile(join(outputDir, `${name}.json`), value); return { type: 'object', value }; };
  const externalFunctions = {
    extractPaper: async (_context, input, systemPrompt) => {
      if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
        throw Error('Extraction instructions are empty. Check that paper-pilot.rivet-project has an Extraction instructions Text node connected through Extraction arguments; unzip -n does not replace an older graph.');
      }
      const result = fixture ? fixture.extraction : await anthropicJson({ system: systemPrompt,
        user: JSON.stringify(input), schema: EXTRACTION_SCHEMA });
      return saveStage('extraction', result);
    },
    reviewFeasibility: async (_context, extraction) => saveStage('feasibility', reviewFeasibility(extraction, packet)),
    runHotspot: async (_context, review) => {
      if (review.decision !== 'adapted_only' || !review.adapted_demo_allowed) throw Error('Feasibility gate rejected simulation');
      const result = await runStudio({ baseUrl, config, outputDir });
      return saveStage('simulation', result);
    },
    assessResult: async (_context, simulation, systemPrompt) => {
      if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
        throw Error('Assessment instructions are empty. Check that paper-pilot.rivet-project has an Assessment instructions Text node connected through Assessment arguments; unzip -n does not replace an older graph.');
      }
      const proposed = fixture ? fixture.assessment : await anthropicJson({ system: systemPrompt,
        user: JSON.stringify({ extraction: JSON.parse(await readFile(join(outputDir, 'extraction.json'))),
          feasibility: JSON.parse(await readFile(join(outputDir, 'feasibility.json'))), simulation }),
        schema: ASSESSMENT_SCHEMA });
      const feasibility = JSON.parse(await readFile(join(outputDir, 'feasibility.json')));
      const limitations = [...(Array.isArray(proposed.limitations) ? proposed.limitations : [])];
      if (feasibility.missing_evidence_fields?.length) {
        limitations.push(`LLM extraction omitted evidence for: ${feasibility.missing_evidence_fields.join(', ')}. Review the PDF before using this result.`);
      }
      const result = { verdict: 'adapted_only', comparison_valid: false,
        summary: String(proposed.summary || ''), limitations };
      return saveStage('assessment', result);
    },
  };
  const graphResult = await runGraphInFile(GRAPH, {
    graph: 'Paper pilot', inputs: { paper_packet: { type: 'object', value: packet } }, externalFunctions,
  });
  const manifest = { paper_id: PAPER_ID, paper_title: packet.title, pdf_path: pdfPath,
    pdf_sha256: packet.pdf_sha256, graph_sha256: graphHash,
    llm_mode: mockLlm ? 'fixture' : 'live', llm_provider: mockLlm ? null : 'anthropic',
    llm_model: mockLlm ? null : (process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL),
    studio_base_url: baseUrl, generated_at: new Date().toISOString(),
    extraction: graphResult.extraction.value, feasibility: graphResult.feasibility.value,
    simulation: graphResult.simulation.value, assessment: graphResult.assessment.value };
  await jsonFile(join(outputDir, 'manifest.json'), manifest);
  await writeFile(join(outputDir, 'submitted.config'), config);
  console.log(JSON.stringify({ output_dir: outputDir, studio_run_id: manifest.simulation.studio_run_id,
    verdict: manifest.assessment.verdict, artifacts: Object.keys(manifest.simulation.artifacts) }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack || String(error));
    if (error.cause) console.error('Cause:', error.cause.stack || String(error.cause));
    process.exitCode = 1; });
}
