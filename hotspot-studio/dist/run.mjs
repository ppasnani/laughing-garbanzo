import {getRunConfiguration} from './app.mjs';
import {canonicalExperiment, validateCustom} from './custom.mjs';

const panel = document.createElement('section');
panel.className = 'panel run-panel';
panel.innerHTML = `<h2>Run HotSpot</h2>
  <label for="run-kind">Run type</label>
  <select id="run-kind"><option value="bundled_ev6_gcc">Bundled EV6/GCC</option><option value="custom_2d_steady">Custom 2D steady</option></select>
  <p id="run-description">EV6 floorplan · gcc power trace · steady and transient phases</p>
  <div id="custom-editor" hidden>
    <p class="hint">Single-layer approximation using bundled package and material assumptions. Gaps in a floorplan are approximated by this HotSpot model; compare paper results with care.</p>
    <p class="hint narrow-table-hint">Scroll the table horizontally to edit width, height, and power.</p>
    <div class="table-scroll"><table id="block-table"><thead><tr><th>Block name</th><th>x (m)</th><th>y (m)</th><th>Width (m)</th><th>Height (m)</th><th>Power (W)</th><th></th></tr></thead><tbody></tbody></table></div>
    <button type="button" id="add-block">Add block</button>
    <div id="custom-error" role="alert" aria-live="polite"></div>
    <p class="preview-label">Floorplan preview · metres</p><svg id="floorplan-preview" role="img" aria-label="Floorplan rectangle preview" viewBox="0 0 300 210"></svg>
    <details><summary>Paste or import experiment JSON</summary><p class="hint">Use the canonical object with kind, floorplan, and power_w.</p>
      <textarea id="experiment-json" rows="7" aria-label="Experiment JSON"></textarea>
      <input id="experiment-file" type="file" accept=".json,application/json" aria-label="Import experiment JSON">
      <button type="button" id="apply-experiment">Apply experiment JSON</button>
    </details>
  </div>
  <p id="backend-status">Connecting to backend…</p>
  <button id="run-hotspot" class="primary" disabled>Save configuration & run</button>
  <h3>Saved runs</h3><select id="run-history" aria-label="Saved runs"><option value="">Select a saved run</option></select>
  <div id="run-result" aria-live="polite"></div>`;
document.querySelector('aside').prepend(panel);
const $ = selector => panel.querySelector(selector);
let token;
let rows = [
  {name:'core0',x_m:'0',y_m:'0',width_m:'0.005',height_m:'0.005',watts:'8'},
  {name:'core1',x_m:'0.005',y_m:'0',width_m:'0.005',height_m:'0.005',watts:'6'},
];
const fields = [['name','Block name'],['x_m','x (m)'],['y_m','y (m)'],['width_m','Width (m)'],['height_m','Height (m)'],['watts','Power (W)']];

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Request failed');
  return data;
}
async function history() {
  const runs = await api('/api/runs');
  $('#run-history').replaceChildren(new Option('Select a saved run',''), ...runs.map(run =>
    new Option(`${run.experiment?.kind === 'custom_2d_steady' ? 'Custom 2D steady' : 'Bundled EV6/GCC'} · ${new Date(run.created).toLocaleString()} · ${run.status}`, run.id)));
}
function error(message, field = '') {
  $('#custom-error').textContent = message;
  panel.querySelectorAll('#block-table input').forEach(input => input.removeAttribute('aria-invalid'));
  if (field) {
    const match = field.match(/^floorplan\.(\d+)\.(\w+)$/);
    const input = match ? panel.querySelector(`[data-row="${match[1]}"][data-field="${match[2]}"]`) :
      field.startsWith('power_w.') ? [...panel.querySelectorAll('[data-field="watts"]')].find(input => rows[input.dataset.row]?.name === field.slice(8)) : null;
    if (input) input.setAttribute('aria-invalid','true');
  }
}
function experiment() { return canonicalExperiment(rows); }
function refreshPreview() {
  const svg = $('#floorplan-preview');
  svg.replaceChildren();
  if ($('#run-kind').value !== 'custom_2d_steady') return;
  const current = experiment();
  const issue = validateCustom(current);
  if (issue) { error(issue.message, issue.field); return; }
  error('');
  const width = Math.max(...current.floorplan.map(block => block.x_m + block.width_m));
  const height = Math.max(...current.floorplan.map(block => block.y_m + block.height_m));
  const scale = Math.min(280 / width, 170 / height);
  for (const [index, block] of current.floorplan.entries()) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg','rect');
    const x = 10 + block.x_m * scale, y = 190 - (block.y_m + block.height_m) * scale;
    rect.setAttribute('x',x); rect.setAttribute('y',y);
    rect.setAttribute('width',block.width_m * scale); rect.setAttribute('height',block.height_m * scale);
    rect.setAttribute('class',index % 2 ? 'floorplan-alt' : 'floorplan-block');
    const title = document.createElementNS('http://www.w3.org/2000/svg','title');
    title.textContent = `${block.name}: ${current.power_w[block.name]} W`;
    rect.append(title); svg.append(rect);
    const label = document.createElementNS('http://www.w3.org/2000/svg','text');
    label.setAttribute('x',x + 4); label.setAttribute('y',y + 15);
    label.textContent = block.name; svg.append(label);
  }
}
function renderRows() {
  const body = $('#block-table tbody'); body.replaceChildren();
  rows.forEach((row, index) => {
    const tr = body.insertRow();
    for (const [field, label] of fields) {
      const input = document.createElement('input');
      input.type = field === 'name' ? 'text' : 'number';
      if (field !== 'name') { input.step = 'any'; input.min = '0'; }
      input.value = row[field]; input.dataset.row = index; input.dataset.field = field;
      input.setAttribute('aria-label',`${label} for block ${index + 1}`);
      input.oninput = () => { rows[index][field] = input.value; refreshPreview(); };
      tr.insertCell().append(input);
    }
    const remove = document.createElement('button');
    remove.type = 'button'; remove.textContent = '×'; remove.title = 'Remove block'; remove.setAttribute('aria-label',`Remove block ${index + 1}`);
    remove.onclick = () => { rows.splice(index,1); renderRows(); };
    tr.insertCell().append(remove);
  });
  refreshPreview();
}
$('#run-kind').onchange = () => {
  const custom = $('#run-kind').value === 'custom_2d_steady';
  document.querySelector('.layout').classList.toggle('custom-layout',custom);
  $('#custom-editor').hidden = !custom;
  $('#run-description').textContent = custom ? 'Your floorplan and one power map · steady state only' : 'EV6 floorplan · gcc power trace · steady and transient phases';
  refreshPreview();
};
$('#add-block').onclick = () => {
  let index = rows.length + 1;
  while (rows.some(row => row.name === `block${index}`)) index++;
  rows.push({name:`block${index}`,x_m:'0',y_m:'0',width_m:'0.005',height_m:'0.005',watts:'0'});
  renderRows();
};
$('#experiment-file').onchange = async event => {
  if (event.target.files[0]) $('#experiment-json').value = await event.target.files[0].text();
};
$('#apply-experiment').onclick = () => {
  try {
    const imported = JSON.parse($('#experiment-json').value);
    const issue = validateCustom(imported);
    if (issue) { error(issue.message, issue.field); return; }
    rows = imported.floorplan.map(block => ({...block, watts: imported.power_w[block.name]}));
    renderRows();
  } catch (cause) { error(`Invalid experiment JSON: ${cause.message}`); }
};
function show(result) {
  const target = $('#run-result'); target.replaceChildren();
  const title = document.createElement('h3');
  title.textContent = `${result.experiment?.kind === 'custom_2d_steady' ? 'Custom 2D steady' : 'Bundled EV6/GCC'} · ${result.id.slice(0,8)} · ${result.status}`;
  target.append(title);
  const links = document.createElement('div'); links.className = 'artifact-links';
  const config = document.createElement('a'); config.href = `/api/runs/${result.id}/config`;
  config.download = 'submitted.config'; config.textContent = 'Download saved configuration'; links.append(config);
  for (const artifact of Object.values(result.artifacts || {})) {
    const link = document.createElement('a'); link.href = artifact.url;
    link.download = artifact.filename; link.textContent = `Download ${artifact.filename}`; links.append(link);
  }
  target.append(links);
  if (result.rows?.length) {
    const table = document.createElement('table'); table.style.width = '100%';
    const header = table.createTHead().insertRow();
    for (const text of ['Node','°C']) { const cell = document.createElement('th'); cell.textContent = text; header.append(cell); }
    const body = table.createTBody();
    for (const row of result.rows) { const tr = body.insertRow(); tr.insertCell().textContent = row.name; tr.insertCell().textContent = row.celsius.toFixed(2); }
    const wrapper = document.createElement('div'); wrapper.className = 'table-scroll'; wrapper.append(table); target.append(wrapper);
  }
  const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Simulation log';
  const log = document.createElement('pre'); log.textContent = result.log || 'Run is still executing. Select it again to refresh.';
  details.append(summary,log); target.append(details);
}
$('#run-hotspot').onclick = async () => {
  const button = $('#run-hotspot');
  try {
    const config = getRunConfiguration();
    const custom = $('#run-kind').value === 'custom_2d_steady';
    const payload = {config};
    if (custom) {
      payload.experiment = experiment();
      const issue = validateCustom(payload.experiment);
      if (issue) { error(issue.message,issue.field); return; }
    }
    button.disabled = true; $('#backend-status').textContent = 'Configuration saved when accepted. Running HotSpot…';
    const result = await api('/api/runs',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':token},body:JSON.stringify(payload)});
    show(result); await history(); $('#backend-status').textContent = `Simulation ${result.status}.`;
  } catch (cause) {
    $('#backend-status').textContent = cause.message;
    if ($('#run-kind').value === 'custom_2d_steady') {
      const block = cause.message.match(/experiment\.floorplan\[(\d+)\](?:\.(name|x_m|y_m|width_m|height_m))?/);
      const power = cause.message.match(/experiment\.power_w\.([A-Za-z][A-Za-z0-9_]*)/);
      error(cause.message, block ? `floorplan.${block[1]}.${block[2] || 'name'}` : power ? `power_w.${power[1]}` : '');
    }
  } finally { button.disabled = false; }
};
$('#run-history').onchange = async event => {
  if (event.target.value) try { show(await api(`/api/runs/${event.target.value}`)); }
  catch (cause) { $('#backend-status').textContent = cause.message; }
};
renderRows();
try {
  const status = await api('/api/status'); token = status.token;
  $('#backend-status').textContent = status.ready ? 'Backend ready · 60-second run limit' : 'Build HotSpot with setup.sh to enable runs.';
  $('#run-hotspot').disabled = !status.ready;
  document.querySelector('#solver').value = 'off'; document.querySelector('#solver').dispatchEvent(new Event('change'));
  await history();
} catch { $('#backend-status').textContent = 'Backend unavailable. Start Studio with server.py to run simulations.'; }
