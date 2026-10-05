import { readFile } from 'node:fs/promises';
import { sha256, parseConfig } from './screening.mjs';

const SOURCES = JSON.parse(await readFile(new URL('./reference_sources.json', import.meta.url), 'utf8'));
const MM = 1e-3;
const UM = 1e-6;

export function referenceSelection(row, requestedCase = null) {
  if (/ATPlace2[.]5D/i.test(row.title)) {
    const name = requestedCase || 'Case3';
    if (!/^Case(?:10|[1-9])$/.test(name)) throw Error('Reference case must be Case1 through Case10');
    return { kind: 'atplace', caseName: name };
  }
  if (requestedCase) throw Error('--reference-case applies only to ATPlace2.5D');
  if (/RLPlanner/i.test(row.title)) return { kind: 'ascend910', caseName: null };
  return null;
}

async function pinnedAsset(source, path, id, fetchImpl) {
  const expected = source.files[path];
  if (!expected) throw Error('No pinned hash for ' + path);
  const url = `https://raw.githubusercontent.com/${source.repo}/${source.commit}/${path}`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`Reference download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 200000 || sha256(bytes) !== expected) {
    throw Error(`Reference source size or SHA-256 mismatch: ${url}`);
  }
  return { id, kind: 'pinned_public_reference', original_url: url, final_url: url,
    version: source.commit, path, sha256: expected, bytes: bytes.length,
    status: 'downloaded', locator: path + ':1', text: bytes.toString('utf8') };
}

export async function loadReferenceInputs(selection, fetchImpl = fetch) {
  if (!selection) return null;
  const source = SOURCES[selection.kind];
  const paths = selection.kind === 'ascend910'
    ? [['config/Ascend910.cfg', 'ref_ascend910_cfg']]
    : [
        [`cases/${selection.caseName}/${selection.caseName}.blocks`, 'ref_atplace_blocks'],
        [`cases/${selection.caseName}/${selection.caseName}.power`, 'ref_atplace_power'],
        [`cases/${selection.caseName}/${selection.caseName}.pl`, 'ref_atplace_placement'],
        ['thermal/hotspot.config', 'ref_atplace_hotspot_config'],
        ['reproduce.py', 'ref_atplace_reproduce'],
      ];
  const assets = await Promise.all(paths.map(([path, id]) => pinnedAsset(source, path, id, fetchImpl)));
  return { ...selection, repo: source.repo, commit: source.commit, assets };
}

export async function loadEv6Example() {
  const paths = ['ev6.flp', 'gcc.ptrace'];
  const assets = await Promise.all(paths.map(async (name, index) => {
    const path = `HotSpot/examples/example1/${name}`;
    const bytes = await readFile(new URL(`../${path}`, import.meta.url));
    const hash = sha256(bytes);
    return { id: index ? 'ref_ev6_power' : 'ref_ev6_floorplan',
      kind: 'bundled_example', original_url: path, final_url: path,
      version: hash, path, sha256: hash, bytes: bytes.length,
      status: 'downloaded', locator: path + ':1', text: bytes.toString('utf8') };
  }));
  return { kind: 'ev6', caseName: null, repo: 'bundled HotSpot example1',
    commit: 'local example; see asset SHA-256', assets };
}

function rows(text) {
  return text.split(/\r?\n/).map((raw, index) => ({ line: index + 1, parts: raw.trim().split(/\s+/) }))
    .filter(row => row.parts[0] && !row.parts[0].startsWith('#'));
}

function numberList(config, key) {
  const value = new RegExp(`^${key}\\s*=\\s*([^\\r\\n]+)`, 'm').exec(config)?.[1];
  if (!value) throw Error('Ascend910 config lacks ' + key);
  const numbers = value.split(',').map(Number);
  if (!numbers.length || numbers.some(n => !Number.isFinite(n) || n <= 0)) {
    throw Error('Invalid Ascend910 ' + key);
  }
  return numbers;
}

function shelfPlace(blocks, targetWidth) {
  let x = 0, y = 0, rowHeight = 0;
  const placed = [];
  for (const block of blocks) {
    if (x && x + block.width_m > targetWidth + 1e-12) {
      x = 0; y += rowHeight; rowHeight = 0;
    }
    placed.push({ ...block, x_m: x, y_m: y });
    x += block.width_m;
    rowHeight = Math.max(rowHeight, block.height_m);
  }
  return placed;
}

function illustrativePlacement(blocks, desiredWidth) {
  for (let width = desiredWidth; width <= 0.1000001; width += 0.001) {
    for (const order of [blocks, [...blocks].sort((a, b) => b.height_m - a.height_m || b.width_m - a.width_m)]) {
      const placed = shelfPlace(order, width);
      if (Math.max(...placed.map(b => b.y_m + b.height_m)) <= 0.1) return placed;
    }
  }
  throw Error('Reference chiplets cannot be placed within Studio 0.1 m limits');
}

function parseAscend(reference) {
  const config = reference.assets[0].text;
  const widths = numberList(config, 'widths');
  const heights = numberList(config, 'heights');
  const powers = numberList(config, 'powers');
  const count = Number(/chiplet_count\s*=\s*(\d+)/.exec(config)?.[1]);
  if (count !== widths.length || count !== heights.length || count !== powers.length) {
    throw Error('Ascend910 chiplet arrays have different lengths');
  }
  const blocks = widths.map((width, i) => ({ name: `chiplet_${i + 1}`,
    width_m: width * MM, height_m: heights[i] * MM }));
  const area = blocks.reduce((sum, b) => sum + b.width_m * b.height_m, 0);
  const lineOf = key => config.split(/\r?\n/).findIndex(line =>
    new RegExp(`^${key}\\s*=`).test(line.trim())) + 1;
  return { blocks: illustrativePlacement(blocks, Math.max(...blocks.map(b => b.width_m), Math.sqrt(area) * 1.3)),
    power_w: Object.fromEntries(powers.map((watts, i) => [`chiplet_${i + 1}`, watts])),
    dimensionSource: reference.assets[0], powerSource: reference.assets[0],
    placementSource: null, dimensionUnit: 'mm', scale: MM,
    location: () => ({ width: lineOf('widths'), height: lineOf('heights'),
      power: lineOf('powers') }),
    notes: ['RLPlanner publishes Ascend910 chiplet sizes and powers, but this config has no placement, power time series, or HotSpot configuration.'] };
}

function parseAtplace(reference) {
  const [blocksAsset, powerAsset, placementAsset, , reproduceAsset] = reference.assets;
  const blocks = [], blockLines = new Map();
  for (const { line, parts } of rows(blocksAsset.text)) {
    if (parts[1] !== 'hardrectilinear') continue;
    const raw = blocksAsset.text.split(/\r?\n/)[line - 1];
    const points = [...raw.matchAll(/\(([-\d.]+),\s*([-\d.]+)\)/g)]
      .map(match => [Number(match[1]), Number(match[2])]);
    if (points.length !== 4) throw Error('Unsupported ATPlace block polygon: ' + parts[0]);
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    if (!(width > 0 && height > 0)) throw Error('Invalid ATPlace block: ' + parts[0]);
    blocks.push({ name: parts[0], width_m: width * UM, height_m: height * UM });
    blockLines.set(parts[0], line);
  }
  const power = new Map(), powerLines = new Map();
  for (const { line, parts } of rows(powerAsset.text)) {
    if (parts.length !== 2 || !Number.isFinite(Number(parts[1])) || power.has(parts[0])) {
      throw Error('Invalid ATPlace power row at line ' + line);
    }
    power.set(parts[0], Number(parts[1])); powerLines.set(parts[0], line);
  }
  if (!blocks.length || blocks.length !== power.size || blocks.some(b => !power.has(b.name))) {
    throw Error('ATPlace block and power names differ');
  }
  const positions = new Map();
  for (const { line, parts } of rows(placementAsset.text)) {
    if (parts.length < 3 || !Number.isFinite(Number(parts[1])) ||
        !Number.isFinite(Number(parts[2])) || positions.has(parts[0])) {
      throw Error('Invalid ATPlace placement row at line ' + line);
    }
    positions.set(parts[0], { x_m: Number(parts[1]) * UM, y_m: Number(parts[2]) * UM, line });
  }
  if (positions.size !== blocks.length || blocks.some(b => !positions.has(b.name))) {
    throw Error('ATPlace block and placement names differ');
  }
  const size = new RegExp(`"${reference.caseName}"\\s*:\\s*\\[([\\d.]+),\\s*([\\d.]+)\\]`)
    .exec(reproduceAsset.text);
  if (!size) throw Error('ATPlace interposer size is missing for ' + reference.caseName);
  const interposer = { width_m: Number(size[1]) * UM, height_m: Number(size[2]) * UM };
  const sourcePlacement = blocks.map(b => ({ ...b, ...positions.get(b.name) }));
  const overlaps = sourcePlacement.some((a, i) => sourcePlacement.slice(0, i).some(b =>
    a.x_m < b.x_m + b.width_m && b.x_m < a.x_m + a.width_m &&
    a.y_m < b.y_m + b.height_m && b.y_m < a.y_m + a.height_m));
  const outside = sourcePlacement.some(b => b.x_m < 0 || b.y_m < 0 ||
    b.x_m + b.width_m > interposer.width_m || b.y_m + b.height_m > interposer.height_m);
  const generated = overlaps || outside;
  const area = blocks.reduce((sum, b) => sum + b.width_m * b.height_m, 0);
  const placed = generated ? illustrativePlacement(blocks,
    Math.max(interposer.width_m, Math.sqrt(area) * 1.3)) : sourcePlacement;
  const expanded = placed.some(b => b.x_m + b.width_m > interposer.width_m + 1e-12 ||
    b.y_m + b.height_m > interposer.height_m + 1e-12);
  return { blocks: placed.map(({ line, ...block }) => block),
    power_w: Object.fromEntries(power), dimensionSource: blocksAsset,
    powerSource: powerAsset, placementSource: generated ? null : placementAsset,
    dimensionUnit: 'um', scale: UM, interposer, generated,
    location: name => ({ dimension: blockLines.get(name), power: powerLines.get(name),
      placement: positions.get(name).line }),
    notes: generated
      ? [`${reference.caseName}.pl has overlapping or out-of-bounds input positions; a deterministic nonoverlapping shelf layout was generated.`,
          'The public package says final placement is produced by its encrypted kernel, not by the supplied .pl input.',
          ...(expanded ? ['The illustrative shelf layout exceeds this case’s published interposer dimensions.'] : [])]
      : [`${reference.caseName}.pl supplies nonoverlapping positions within its interposer.`] };
}

function parseEv6(reference) {
  const [floorplanAsset, powerAsset] = reference.assets;
  const floorRows = rows(floorplanAsset.text);
  const blocks = floorRows.map(({ line, parts }) => {
    if (parts.length < 5 || parts.slice(1, 5).some(value => !Number.isFinite(Number(value)))) {
      throw Error('Invalid bundled EV6 floorplan line ' + line);
    }
    return { name: parts[0], width_m: Number(parts[1]), height_m: Number(parts[2]),
      x_m: Number(parts[3]), y_m: Number(parts[4]) };
  });
  const traceRows = rows(powerAsset.text);
  const names = traceRows[0]?.parts || [];
  const watts = traceRows[1]?.parts.map(Number) || [];
  if (!blocks.length || names.length !== blocks.length || watts.length !== names.length ||
      watts.some(value => !Number.isFinite(value)) ||
      blocks.some((block, index) => block.name !== names[index])) {
    throw Error('Bundled EV6 floorplan and GCC power trace differ');
  }
  return { blocks, power_w: Object.fromEntries(names.map((name, i) => [name, watts[i]])),
    dimensionSource: floorplanAsset, powerSource: powerAsset,
    placementSource: floorplanAsset, dimensionUnit: 'm', scale: 1,
    location: name => ({ dimension: floorRows.find(row => row.parts[0] === name).line,
      placement: floorRows.find(row => row.parts[0] === name).line,
      power: traceRows[1].line }),
    notes: ['The EV6 geometry and the first GCC power row are unrelated to this paper and only illustrate the Studio pipeline.'] };
}

export function referenceExperiment(reference) {
  const parsed = reference.kind === 'ascend910' ? parseAscend(reference)
    : reference.kind === 'atplace' ? parseAtplace(reference) : parseEv6(reference);
  const experiment = { kind: 'custom_2d_steady', floorplan: parsed.blocks,
    power_w: parsed.power_w };
  const evidence = [];
  for (const block of parsed.blocks) {
    const loc = parsed.location(block.name);
    for (const [field, original] of [['width_m', block.width_m / parsed.scale],
      ['height_m', block.height_m / parsed.scale]]) {
      evidence.push({ field, block_name: block.name, source_value: original,
        source_unit: parsed.dimensionUnit, conversion_factor: parsed.scale,
        normalized_value: block[field], pdf_page: null, asset_id: parsed.dimensionSource.id,
        locator: `${parsed.dimensionSource.path}:${reference.kind === 'ascend910'
          ? (field === 'width_m' ? loc.width : loc.height) : loc.dimension}`,
        provenance: reference.kind === 'ev6' ? 'Bundled EV6 example dimensions' : 'Pinned repository dimensions',
        uncertainty: null });
    }
    evidence.push({ field: 'power_w', block_name: block.name,
      source_value: parsed.power_w[block.name], source_unit: 'W', conversion_factor: 1,
      normalized_value: parsed.power_w[block.name], pdf_page: null,
      asset_id: parsed.powerSource.id,
      locator: `${parsed.powerSource.path}:${loc.power}`,
      provenance: reference.kind === 'ev6' ? 'Bundled GCC example power row'
        : 'Pinned repository power value; one steady snapshot', uncertainty: null });
    for (const field of ['x_m', 'y_m']) {
      evidence.push({ field, block_name: block.name,
        source_value: parsed.placementSource ? block[field] : null,
        source_unit: parsed.placementSource ? 'm' : null,
        conversion_factor: parsed.placementSource ? 1 : null,
        normalized_value: block[field],
        pdf_page: null, asset_id: parsed.placementSource?.id || null,
        locator: parsed.placementSource
          ? `${parsed.placementSource.path}:${loc.placement}`
          : 'Deterministic shelf layout; original final coordinates not published',
        provenance: parsed.placementSource
          ? reference.kind === 'ev6' ? 'Bundled EV6 example placement' : 'Pinned repository placement'
          : 'Inferred illustrative placement',
        uncertainty: parsed.placementSource ? null : 'No published final placement coordinates' });
    }
  }
  const extent = { width_m: Math.max(...parsed.blocks.map(b => b.x_m + b.width_m)),
    height_m: Math.max(...parsed.blocks.map(b => b.y_m + b.height_m)) };
  return { experiment, evidence, extent, notes: parsed.notes,
    generated: !parsed.placementSource,
    interposer: parsed.interposer || null };
}

export function applyReferenceInputs(extraction, reference, prepared) {
  if (!reference || !prepared) return extraction;
  if (reference.kind === 'ev6' &&
      (extraction.scenario?.steady_2d_relevant !== true ||
       extraction.experiment?.floorplan?.length)) return extraction;
  if (extraction.reference_inputs) {
    if (extraction.reference_inputs.repo !== reference.repo ||
        extraction.reference_inputs.commit !== reference.commit ||
        extraction.reference_inputs.case_name !== reference.caseName ||
        JSON.stringify(extraction.experiment) !== JSON.stringify(prepared.experiment)) {
      throw Error('Reused audit reference inputs differ from pinned source');
    }
    return extraction;
  }
  const description = [extraction.scenario?.description, extraction.scenario?.architecture,
    extraction.scenario?.figure_or_table].join(' ');
  const match = reference.kind === 'ev6' || (reference.kind === 'ascend910'
    ? /Ascend\s*910/i.test(description)
    : new RegExp(`\\bCase\\s*${reference.caseName.slice(4)}\\b`, 'i').test(description));
  if (!match) throw Error(`Selected scenario does not match pinned ${reference.kind} ${reference.caseName || ''} inputs`);
  const marker = `Pinned ${reference.repo}@${reference.commit}`;
  const mismatch = reference.kind === 'ev6'
    ? 'Bundled EV6/GCC inputs are unrelated to this paper; this is an illustrative pipeline run only.'
    : prepared.generated
    ? 'Final chiplet coordinates are not supplied by the reference files; generated shelf positions illustrate a 2D power snapshot, not the published placement.'
    : 'The pinned placement is an input layout, not a verified final paper result.';
  return { ...extraction, experiment: prepared.experiment,
    reference_inputs: { repo: reference.repo, commit: reference.commit,
      case_name: reference.caseName, generated_placement: prepared.generated },
    evidence: [...(extraction.evidence || []), ...prepared.evidence],
    physical_mismatches: [...(extraction.physical_mismatches || []),
      { reason: mismatch, essential: true }],
    studio_assumptions: [...(extraction.studio_assumptions || []), marker,
      ...prepared.notes, reference.kind === 'ev6'
        ? 'The one-row power trace uses the bundled GCC example, not paper-derived watts.'
        : 'The power trace is one constant row made from source per-chiplet watts.'],
    missing_inputs: [...(extraction.missing_inputs || []),
      ...(prepared.generated ? ['Published final chiplet coordinates are unavailable.'] : [])] };
}

export function referenceConfig(base, reference, prepared) {
  if (!reference || !prepared) return base;
  const values = parseConfig(base);
  const sourceValues = reference.kind === 'atplace'
    ? parseConfig(reference.assets.find(asset => asset.id === 'ref_atplace_hotspot_config').text)
    : {};
  if (reference.kind === 'ev6') return base;
  const allowed = ['t_chip', 'k_chip', 'p_chip', 'thermal_threshold', 'c_convec',
    'r_convec', 't_sink', 'k_sink', 'p_sink', 't_spreader', 'k_spreader',
    'p_spreader', 't_interface', 'k_interface', 'p_interface', 'ambient', 'init_temp'];
  const overrides = Object.fromEntries(allowed.filter(key => sourceValues[key] && values[key])
    .map(key => [key, sourceValues[key]]));
  const spreader = Math.max(Number(sourceValues.s_spreader || values.s_spreader),
    prepared.extent.width_m, prepared.extent.height_m,
    prepared.interposer?.width_m || 0, prepared.interposer?.height_m || 0);
  const sink = Math.max(Number(sourceValues.s_sink || values.s_sink), spreader);
  overrides.s_spreader = String(Number((spreader + 1e-9).toFixed(9)));
  overrides.s_sink = String(Number((sink + 1e-9).toFixed(9)));
  overrides.model_type = 'block'; overrides.model_secondary = '0';
  let config = base;
  for (const [key, value] of Object.entries(overrides)) {
    const pattern = new RegExp(`(^\\s*-${key}\\s+)\\S+`, 'm');
    if (!pattern.test(config)) throw Error('Studio base config lacks ' + key);
    config = config.replace(pattern, (_match, prefix) => prefix + value);
  }
  return config;
}
