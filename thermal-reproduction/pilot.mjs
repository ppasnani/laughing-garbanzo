import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runGraphInFile } from '@ironclad/rivet-node';
import { sha256, reviewFeasibility, validateExperiment, CHECKS } from './screening.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const GRAPH = join(HERE, 'paper-pilot.rivet-project');
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_PAPER = 'W4206159291';
const object = properties => ({ type: 'object', additionalProperties: false,
  required: Object.keys(properties), properties });
const string = { type: 'string' };
const number = { type: 'number' };
const nullable = type => ({ type: [type, 'null'] });
const array = items => ({ type: 'array', items });
const block = object({ name: string, x_m: number, y_m: number, width_m: number, height_m: number });
const evidence = object({ field: string, block_name: nullable('string'), source_value: nullable('number'),
  source_unit: nullable('string'), conversion_factor: nullable('number'), normalized_value: nullable('number'),
  pdf_page: nullable('integer'), asset_id: nullable('string'), locator: string, provenance: string,
  uncertainty: nullable('string') });

export const EXTRACTION_SCHEMA = object({
  paper_id: string, paper_title: string,
  artifact_search_status: { type: 'string', enum: ['checked_links_found', 'checked_no_links', 'blocked'] },
  linked_assets: array(object({ id: string, url: string, kind: string, paper_page: { type: 'integer' } })),
  scenario: object({ pdf_page: { type: 'integer' }, figure_or_table: string, description: string,
    architecture: string, workload: string, operating_point: string,
    steady_2d_relevant: { type: 'boolean' } }),
  original_setup: object({ solver: string, optimizer: string, controller: string, benchmark: string }),
  evidence: array(evidence),
  experiment: object({ kind: { type: 'string', enum: ['custom_2d_steady'] },
    floorplan: array(block), power_rows: array(object({ name: string, watts: number })) }),
  thermal_observable: object({ value: nullable('number'), unit: string, location: string,
    aggregation: string, pdf_page: { type: 'integer' } }),
  physical_mismatches: array(object({ reason: string, essential: { type: 'boolean' } })),
  studio_assumptions: array(string), missing_inputs: array(string),
});
// Anthropic's strict grammar compiler rejects the full evidence schema. Keep the
// detailed contract in the prompt and constrain only the small transport envelope.
export const EXTRACTION_ENVELOPE_SCHEMA = object({ extraction_json: string });
export const ADVERSARIAL_SCHEMA = object({
  approved: { type: 'boolean' },
  checklist: object(Object.fromEntries(CHECKS.map(key => [key, object({
    status: { type: 'string', enum: ['verified', 'missing', 'contradicted', 'not_applicable'] },
    note: string })]))),
  findings: array(object({ field: string, reason: string, locator: string })),
  checked_pdf_pages: array({ type: 'integer' }), checked_assets: array(string),
});
export const ASSESSMENT_SCHEMA = object({ summary: string, limitations: array(string) });
const jsonFile = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const delay = ms => new Promise(done => setTimeout(done, ms));

export function normalizeExtraction(result) {
  const experiment = result?.experiment;
  if (!experiment?.power_rows) return result;
  const power_w = {};
  for (const row of experiment.power_rows) {
    if (Object.hasOwn(power_w, row.name)) throw Error('Duplicate extracted power row: ' + row.name);
    power_w[row.name] = row.watts;
  }
  return { ...result, experiment: { kind: experiment.kind,
    floorplan: experiment.floorplan, power_w } };
}

export function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
    } else field += char;
  }
  if (quoted) throw Error('Manifest contains an unterminated CSV quote');
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows;
  if (!header?.includes('openalex_id')) throw Error('Manifest has no openalex_id column');
  return data.map((values, index) => {
    if (values.length !== header.length) throw Error('Manifest row ' + (index + 2) + ' has wrong field count');
    return Object.fromEntries(header.map((key, column) => [key, values[column]]));
  });
}

export async function paperPacket(row, { pdfTool = process.env.PDFTOTEXT || 'pdftotext',
  infoTool = process.env.PDFINFO || 'pdfinfo',
  assetsFile } = {}) {
  if (row.status !== 'downloaded') return { paper_id: row.openalex_id, title: row.title,
    doi: row.doi, manifest_status: row.status, unavailable_reason: row.notes,
    source_url: row.source_url, pages: [], assets: [] };
  if (!/^[A-Za-z0-9_.-]+\.pdf$/.test(row.filename)) throw Error('Unsafe manifest PDF filename');
  const pdfPath = resolve(ROOT, 'chip_thermal_management_papers', row.filename);
  const source = await readFile(pdfPath);
  if (source.subarray(0, 4).toString() !== '%PDF') throw Error('Invalid PDF: ' + row.filename);
  const { stdout } = await execFileAsync(pdfTool, ['-layout', pdfPath, '-'], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 60000,
  });
  const pages = stdout.split('\f').filter((value, index, all) => index < all.length - 1 || value.trim())
    .map((text, index) => ({ pdf_page: index + 1, text }));
  if (!pages.length) throw Error('PDF extraction returned no pages; inspect or OCR the PDF');
  const { stdout: info } = await execFileAsync(infoTool, [pdfPath], {
    encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30000,
  });
  const statedPages = /^Pages:\s*(\d+)\s*$/m.exec(info);
  if (!statedPages || Number(statedPages[1]) !== pages.length) {
    throw Error('PDF page count differs from extracted text; inspect or OCR the PDF');
  }
  let assets = [];
  if (assetsFile) {
    const entries = JSON.parse(await readFile(assetsFile, 'utf8'));
    if (!Array.isArray(entries)) throw Error('Evidence asset manifest must be an array');
    assets = await Promise.all(entries.map(async entry => {
      if (!entry.id || !entry.version || !entry.paper_page || !entry.original_url || !entry.final_url ||
          !entry.path || !entry.kind || !entry.locator) throw Error('Evidence asset lacks provenance');
      const data = await readFile(resolve(dirname(assetsFile), entry.path));
      if (data.length > 200000) throw Error('Evidence asset exceeds 200 KB; provide a cited excerpt');
      const digest = sha256(data);
      if (entry.sha256 !== digest) throw Error('Evidence asset hash mismatch: ' + entry.id);
      return { ...entry, sha256: digest, bytes: data.length, status: 'downloaded',
        text: data.toString('utf8') };
    }));
  }
  return { paper_id: row.openalex_id, title: row.title, doi: row.doi,
    source_url: row.source_url, pdf_path: pdfPath, pdf_sha256: sha256(source),
    manifest_status: 'downloaded', extraction_method: 'pdftotext -layout',
    pages, page_count: pages.length, assets };
}

export async function anthropicJson({ system, user, schema, apiKey = process.env.ANTHROPIC_API_KEY,
  model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL, fetchImpl = fetch }) {
  if (!apiKey) throw Error('Set ANTHROPIC_API_KEY, or use --mock-llm');
  const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(120000),
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey,
      'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 32768, system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema } } }),
  });
  if (!response.ok) throw Error('Anthropic returned ' + response.status + ': ' + (await response.text()).slice(0, 500));
  const body = await response.json();
  if (body.stop_reason !== 'end_turn') throw Error('Anthropic stopped with ' + (body.stop_reason || 'unknown reason'));
  const blocks = body.content?.filter(part => part.type === 'text' && typeof part.text === 'string');
  if (blocks?.length !== 1) throw Error('Anthropic response had no single JSON text block');
  return JSON.parse(blocks[0].text);
}

export async function anthropicExtraction({ system, packet, apiKey, fetchImpl = fetch }) {
  const envelope = await anthropicJson({ system: system + '\nReturn a JSON serialization of the extraction object in extraction_json. Follow the provided extraction schema exactly; use empty arrays and empty strings for unknown non-nullable fields, and null only where the schema permits it.',
    user: JSON.stringify({ paper_packet: packet, extraction_schema: EXTRACTION_SCHEMA }),
    schema: EXTRACTION_ENVELOPE_SCHEMA, apiKey, fetchImpl });
  let extraction;
  try { extraction = JSON.parse(envelope.extraction_json); }
  catch { throw Error('Anthropic extraction_json is not valid JSON'); }
  if (!extraction || typeof extraction !== 'object' || Array.isArray(extraction) ||
      extraction.paper_id !== packet.paper_id || !Array.isArray(extraction.evidence) ||
      !Array.isArray(extraction.experiment?.floorplan) ||
      !Array.isArray(extraction.experiment?.power_rows)) {
    throw Error('Anthropic extraction_json is missing required evidence or experiment fields');
  }
  return extraction;
}

export async function runStudio({ baseUrl, config, experiment, outputDir, fetchImpl = fetch }) {
  const origin = baseUrl.replace(/\/$/, '');
  const custom = experiment?.kind === 'custom_2d_steady';
  if (custom) {
    const errors = validateExperiment(experiment, config);
    if (errors.length) throw Error('Invalid custom experiment: ' + errors.join('; '));
  }
  const statusResponse = await fetchImpl(origin + '/api/status', { signal: AbortSignal.timeout(10000) });
  if (!statusResponse.ok) throw Error('Studio status returned ' + statusResponse.status);
  const status = await statusResponse.json();
  if (!status.ready || !status.token) throw Error('Studio is not ready for simulation');
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetchImpl(origin + '/api/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': status.token },
      body: JSON.stringify(custom ? { config, experiment } : { config }), signal: AbortSignal.timeout(75000),
    });
    if (response.status !== 409) break;
    await response.text(); await delay(1000 * (attempt + 1));
  }
  if (response.status !== 201) throw Error('Studio run returned ' + response.status + ': ' +
    (await response.text()).slice(0, 500));
  const submitted = await response.json();
  if (!/^[a-f0-9]{32}$/.test(submitted.id)) throw Error('Studio returned an invalid run ID');
  const get = await fetchImpl(origin + '/api/runs/' + submitted.id, { signal: AbortSignal.timeout(15000) });
  if (!get.ok) throw Error('Studio run retrieval returned ' + get.status);
  const run = await get.json();
  if (run.id !== submitted.id || run.experiment?.kind !== (custom ? 'custom_2d_steady' : 'bundled_ev6_gcc')) {
    throw Error('Retrieved Studio run does not match submission');
  }
  const configResponse = await fetchImpl(origin + '/api/runs/' + run.id + '/config',
    { signal: AbortSignal.timeout(15000) });
  if (!configResponse.ok || await configResponse.text() !== config) throw Error('Retrieved config differs');
  await jsonFile(join(outputDir, 'studio-result.json'), run);
  await writeFile(join(outputDir, 'solver.log'), run.log || '');
  const expected = custom ? ['submitted.experiment.json', 'input.flp', 'input.ptrace',
    'temperatures.steady', ...(run.experiment.model_type === 'grid' ? ['temperatures.grid.steady'] : [])]
    : ['gcc.steady', 'gcc.ttrace'];
  const artifacts = {};
  for (const filename of expected) {
    const advertised = run.artifacts?.[filename];
    if (!advertised?.url) {
      if (run.status === 'completed') throw Error('Studio did not advertise ' + filename);
      continue;
    }
    const url = new URL(advertised.url, origin);
    if (url.origin !== new URL(origin).origin ||
        url.pathname !== '/api/runs/' + run.id + '/artifacts/' + filename) {
      throw Error('Artifact URL does not match the Studio run');
    }
    const artifactResponse = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    if (!artifactResponse.ok) throw Error('Artifact ' + filename + ' returned ' + artifactResponse.status);
    const bytes = Buffer.from(await artifactResponse.arrayBuffer());
    if (!bytes.length || bytes.length !== advertised.bytes || sha256(bytes) !== advertised.sha256) {
      throw Error('Artifact ' + filename + ' size or SHA-256 mismatch');
    }
    await writeFile(join(outputDir, filename), bytes);
    artifacts[filename] = { path: filename, bytes: bytes.length, sha256: sha256(bytes),
      studio_url: advertised.url };
  }
  if (custom && run.status === 'completed') {
    const outputNames = new Set(run.rows?.map(row => row.name));
    for (const name of experiment.floorplan.map(block => block.name)) {
      if (!outputNames.has(name)) throw Error('Studio output is missing block ' + name);
    }
    for (const row of run.rows) {
      if (!Number.isFinite(row.kelvin) || !Number.isFinite(row.celsius) ||
          Math.abs(row.celsius - (row.kelvin - 273.15)) > 0.002) {
        throw Error('Studio returned invalid Kelvin/Celsius temperatures');
      }
    }
    if (!run.experiment.input_sha256) throw Error('Studio omitted the custom input hash');
  }
  return { status: run.status, studio_run_id: run.id, run_kind: run.experiment.kind,
    input_sha256: run.experiment.input_sha256 || null, config_sha256: sha256(config),
    rows: run.rows, solver_log: run.log, assumptions: run.experiment.assumptions || null,
    artifacts, comparison_valid: false };
}

function bundledReview(packet, adversarial) {
  return { paper_id: packet.paper_id, decision: 'adapted_only', simulation_allowed: true,
    input_gate_pass: false, scientific_gate_pass: false, independently_verified: false,
    comparison_valid: false, blocking_facts: (adversarial.findings || []).map(item => item.reason),
    reason: 'The EV6 paper uses a 3D FEniCS/POD model and pulsed power; bundled GCC is an adapted pipeline demonstration.' };
}

export async function execute({ row, packet, config, outputDir, runType, allowAdapted = false,
  fixture = null, reusedAudit = null, independentReview = null, baseUrl = 'http://127.0.0.1:8000',
  graph = GRAPH, fetchImpl = fetch }) {
  await mkdir(outputDir, { recursive: true });
  const save = async (name, value) => {
    await jsonFile(join(outputDir, name + '.json'), value);
    return { type: 'object', value };
  };
  const stageFunctions = {
    extractPaper: async (_context, input, systemPrompt) => {
      if (!systemPrompt?.trim()) throw Error('Extraction instructions are empty');
      const source = reusedAudit?.extraction ?? fixture?.extraction ??
        await anthropicExtraction({ system: systemPrompt, packet: input, fetchImpl });
      const result = normalizeExtraction(source);
      return save('extraction', result);
    },
    adversarialReview: async (_context, extraction, systemPrompt) => {
      if (!systemPrompt?.trim()) throw Error('Adversarial instructions are empty');
      const result = reusedAudit?.adversarial ?? fixture?.adversarial ??
        await anthropicJson({ system: systemPrompt,
          user: JSON.stringify({ packet, extraction }), schema: ADVERSARIAL_SCHEMA, fetchImpl });
      return save('adversarial', result);
    },
    reviewFeasibility: async (_context, adversarial) => {
      const extraction = JSON.parse(await readFile(join(outputDir, 'extraction.json'), 'utf8'));
      const result = runType === 'bundled' ? bundledReview(packet, adversarial)
        : reviewFeasibility(extraction, adversarial, packet, config, independentReview);
      return save('feasibility', result);
    },
    runHotspot: async (_context, review) => {
      if (!review.simulation_allowed || runType === 'bundled' && !allowAdapted) {
        return save('simulation', { status: 'skipped', reason: review.reason, artifacts: {} });
      }
      const extraction = JSON.parse(await readFile(join(outputDir, 'extraction.json'), 'utf8'));
      const result = await runStudio({ baseUrl, config, outputDir,
        experiment: runType === 'custom' ? extraction.experiment : undefined, fetchImpl });
      if (runType === 'custom' && result.status === 'completed') {
        const baseline = extraction.experiment;
        const trial = structuredClone(baseline);
        const total = Object.values(trial.power_w).reduce((sum, watts) => sum + watts, 0);
        let name = trial.floorplan.find(block =>
          trial.power_w[block.name] < 10000 && total < 100000)?.name;
        let delta = name ? Math.min(1, 10000 - trial.power_w[name], 100000 - total) : 0;
        if (!name) {
          name = trial.floorplan.find(block => trial.power_w[block.name] > 0)?.name;
          if (name) delta = -Math.min(1, trial.power_w[name]);
        }
        if (!name || delta === 0) {
          result.sensitivity = { status: 'unavailable', passed: false,
            reason: 'No valid power perturbation within Studio limits' };
        } else {
          trial.power_w[name] += delta;
          const sensitivityDir = join(outputDir, 'sensitivity');
          await mkdir(sensitivityDir);
          try {
            const run = await runStudio({ baseUrl, config, experiment: trial,
              outputDir: sensitivityDir, fetchImpl });
            const baselineKelvin = result.rows.find(row => row.name === name)?.kelvin;
            const trialKelvin = run.rows?.find(row => row.name === name)?.kelvin;
            result.sensitivity = { status: run.status, block_name: name,
              power_delta_w: delta, baseline_kelvin: baselineKelvin,
              trial_kelvin: trialKelvin,
              passed: run.status === 'completed' &&
                (delta > 0 ? trialKelvin > baselineKelvin : trialKelvin < baselineKelvin),
              run };
          } catch (error) {
            result.sensitivity = { status: 'failed', block_name: name,
              power_delta_w: delta, passed: false, reason: String(error) };
          }
        }
      }
      return save('simulation', result);
    },
    assessResult: async (_context, simulation, systemPrompt) => {
      if (!systemPrompt?.trim()) throw Error('Assessment instructions are empty');
      const extraction = JSON.parse(await readFile(join(outputDir, 'extraction.json'), 'utf8'));
      const feasibility = JSON.parse(await readFile(join(outputDir, 'feasibility.json'), 'utf8'));
      const proposed = fixture ? fixture.assessment : reusedAudit && !process.env.ANTHROPIC_API_KEY
        ? { summary: simulation.status === 'skipped'
          ? 'Studio was not run because the screening gate is unresolved.'
          : 'Studio custom 2D steady run ended with status ' + simulation.status + '.',
          limitations: [] }
        : await anthropicJson({ system: systemPrompt,
        user: JSON.stringify({ extraction, feasibility, simulation }), schema: ASSESSMENT_SCHEMA,
        fetchImpl });
      const limitations = [...(proposed.limitations || []), ...feasibility.blocking_facts.map(String),
        ...(feasibility.studio_assumptions || [])];
      if (simulation.sensitivity && !simulation.sensitivity.passed) {
        limitations.push('Power-direction check did not pass: ' +
          (simulation.sensitivity.reason || simulation.sensitivity.status));
      }
      const result = { verdict: feasibility.decision, comparison_valid: false,
        summary: String(proposed.summary || ''), limitations };
      return save('assessment', result);
    },
  };
  let stageFailure;
  const externalFunctions = Object.fromEntries(Object.entries(stageFunctions).map(([stage, fn]) =>
    [stage, async (...args) => {
      try { return await fn(...args); }
      catch (error) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        const message = String(error?.message || error).replaceAll(apiKey || '\0', '[redacted]').slice(0, 2000);
        stageFailure = { paper_id: packet.paper_id, stage, message };
        await jsonFile(join(outputDir, 'stage-error.json'), stageFailure);
        throw error;
      }
    }]));
  let output;
  try {
    output = await runGraphInFile(graph, { graph: 'Paper pilot',
      inputs: { paper_packet: { type: 'object', value: packet } }, externalFunctions });
  } catch (error) {
    if (stageFailure) throw new Error(`Paper ${stageFailure.paper_id} failed at ${stageFailure.stage}: ${stageFailure.message} (see ${join(outputDir, 'stage-error.json')})`, { cause: error });
    throw error;
  }
  const manifest = { paper_id: row.openalex_id, paper_title: row.title,
    manifest_status: row.status, source_url: row.source_url,
    manifest_sha256: packet.manifest_sha256, pdf_sha256: packet.pdf_sha256,
    pdf_pages: packet.page_count, extraction_method: packet.extraction_method,
    linked_assets: (packet.assets || []).map(({ text, ...meta }) => meta),
    independent_review: independentReview, graph_sha256: sha256(await readFile(graph)),
    rubric_sha256: sha256(await readFile(join(HERE, '2D_SNAPSHOT_SCREENING_PROTOCOL.md'))),
    run_type: runType, studio_base_url: baseUrl, generated_at: new Date().toISOString(),
    llm_mode: fixture ? 'fixture' : reusedAudit ? 'reused_audit' : 'live',
    llm_provider: fixture || reusedAudit && !process.env.ANTHROPIC_API_KEY ? null : 'anthropic',
    llm_model: fixture || reusedAudit && !process.env.ANTHROPIC_API_KEY
      ? null : (process.env.ANTHROPIC_MODEL || DEFAULT_MODEL),
    extraction: output.extraction.value, adversarial: output.adversarial.value,
    feasibility: output.feasibility.value, simulation: output.simulation.value,
    assessment: output.assessment.value };
  await jsonFile(join(outputDir, 'manifest.json'), manifest);
  await writeFile(join(outputDir, 'submitted.config'), config);
  return manifest;
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
  const runType = value('--run-type') || 'bundled';
  if (!['bundled', 'custom'].includes(runType)) throw Error('--run-type must be bundled or custom');
  const paperId = value('--paper-id') || DEFAULT_PAPER;
  const manifestBytes = await readFile(resolve(ROOT, 'chip_thermal_management_papers/download_manifest.csv'));
  const rows = parseCsv(manifestBytes.toString('utf8'));
  const row = rows.find(item => item.openalex_id === paperId);
  if (!row) throw Error('Paper ' + paperId + ' is absent from the manifest');
  if (row.status !== 'downloaded') throw Error('Paper ' + paperId + ' has no local PDF: ' + row.notes);
  if (runType === 'bundled' && paperId !== DEFAULT_PAPER) throw Error('Bundled pilot is only mapped to W4206159291');
  const packet = await paperPacket(row, { assetsFile: value('--assets-file') });
  packet.manifest_sha256 = sha256(manifestBytes);
  const outputDir = resolve(HERE, 'pilot-output', paperId,
    new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  const fixture = args.includes('--mock-llm') ? JSON.parse(await readFile(
    value('--fixture') || join(HERE, 'pilot_fixture.json'), 'utf8')) : null;
  const reuseFile = value('--reuse-audit');
  const reusedAudit = reuseFile ? JSON.parse(await readFile(reuseFile, 'utf8')) : null;
  if (reusedAudit && (reusedAudit.paper_id !== paperId || reusedAudit.pdf_sha256 !== packet.pdf_sha256 ||
      JSON.stringify(reusedAudit.linked_assets || []) !== JSON.stringify(
        (packet.assets || []).map(({ text, ...meta }) => meta)))) {
    throw Error('Reused audit does not match this PDF and pinned asset set');
  }
  if (!fixture && !reusedAudit && !process.env.ANTHROPIC_API_KEY) {
    throw Error('Set ANTHROPIC_API_KEY, use --mock-llm, or supply --reuse-audit');
  }
  const reviewFile = value('--review-file');
  const independentReview = reviewFile ? JSON.parse(await readFile(reviewFile, 'utf8')) : null;
  const config = await readFile(value('--config-file') || resolve(ROOT, 'hotspot-studio/dist/example.config'), 'utf8');
  const result = await execute({ row, packet, config, outputDir, runType,
    allowAdapted: args.includes('--allow-adapted'), fixture, reusedAudit, independentReview,
    baseUrl: process.env.HOTSPOT_BASE_URL || 'http://127.0.0.1:8000' });
  console.log(JSON.stringify({ output_dir: outputDir, verdict: result.assessment.verdict,
    studio_run_id: result.simulation.studio_run_id || null,
    artifacts: Object.keys(result.simulation.artifacts) }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
}
