#!/usr/bin/env python3
"""Render a HotSpot floorplan, steady temperatures, and transient trace as HTML.

Only the Python standard library is required. Temperatures are read as Kelvin.
The trace has no time column in the bundled HotSpot format, so frames are
identified by sample number rather than an inferred physical time.
"""

import argparse
import html
import json
import math
from pathlib import Path


def read_floorplan(path):
    units = []
    seen = set()
    for number, raw in enumerate(path.read_text().splitlines(), 1):
        parts = raw.split("#", 1)[0].split()
        if not parts:
            continue
        if len(parts) < 5:
            raise ValueError(f"{path}:{number}: expected name, width, height, x, y")
        name = parts[0]
        if name in seen:
            raise ValueError(f"{path}:{number}: duplicate block {name!r}")
        try:
            width, height, x, y = (float(part) for part in parts[1:5])
        except ValueError as exc:
            raise ValueError(f"{path}:{number}: invalid block dimensions") from exc
        if not all(map(math.isfinite, (width, height, x, y))) or width <= 0 or height <= 0:
            raise ValueError(f"{path}:{number}: dimensions must be finite and positive")
        seen.add(name)
        # HotSpot floorplans use metres; the viewer displays millimetres.
        units.append({"name": name, "x": x * 1000, "y": y * 1000,
                      "width": width * 1000, "height": height * 1000})
    if not units:
        raise ValueError(f"{path}: no floorplan blocks found")
    return units


def parse_temperature(value, path, number):
    try:
        temperature = float(value)
    except ValueError as exc:
        raise ValueError(f"{path}:{number}: invalid temperature {value!r}") from exc
    if not math.isfinite(temperature) or temperature < 0:
        raise ValueError(f"{path}:{number}: temperature must be finite Kelvin")
    return temperature


def read_steady(path, names):
    values = {}
    for number, raw in enumerate(path.read_text().splitlines(), 1):
        parts = raw.split("#", 1)[0].split()
        if not parts:
            continue
        if len(parts) != 2:
            raise ValueError(f"{path}:{number}: expected block name and temperature")
        name = parts[0]
        if name in values:
            raise ValueError(f"{path}:{number}: duplicate node {name!r}")
        values[name] = parse_temperature(parts[1], path, number)
    missing = names - values.keys()
    if missing:
        raise ValueError(f"{path}: missing floorplan blocks: {', '.join(sorted(missing))}")
    return {name: values[name] for name in names}


def read_trace(path, names):
    lines = [(number, raw.split("#", 1)[0].split())
             for number, raw in enumerate(path.read_text().splitlines(), 1)]
    lines = [(number, parts) for number, parts in lines if parts]
    if len(lines) < 2:
        raise ValueError(f"{path}: expected a header and at least one sample")
    header = lines[0][1]
    if len(header) != len(set(header)):
        raise ValueError(f"{path}:{lines[0][0]}: duplicate trace columns")
    missing = names - set(header)
    if missing:
        raise ValueError(f"{path}: missing floorplan blocks: {', '.join(sorted(missing))}")
    indices = {name: header.index(name) for name in names}
    frames = []
    for number, parts in lines[1:]:
        if len(parts) != len(header):
            raise ValueError(f"{path}:{number}: expected {len(header)} values, found {len(parts)}")
        frames.append({name: parse_temperature(parts[index], path, number)
                       for name, index in indices.items()})
    return frames


def find_inputs(args):
    run_dir = args.run_dir
    if run_dir and not run_dir.is_dir():
        raise ValueError(f"Run directory does not exist: {run_dir}")
    if args.floorplan:
        floorplan = args.floorplan
    elif run_dir:
        candidates = sorted(run_dir.glob("*.flp"))
        if len(candidates) != 1:
            raise ValueError(f"{run_dir}: found {len(candidates)} .flp files; pass --floorplan explicitly")
        floorplan = candidates[0]
    else:
        raise ValueError("Pass --floorplan, or --run-dir containing exactly one .flp file")
    steady = args.steady or (run_dir / "gcc.steady" if run_dir and (run_dir / "gcc.steady").is_file() else None)
    trace = args.trace or (run_dir / "gcc.ttrace" if run_dir and (run_dir / "gcc.ttrace").is_file() else None)
    if not steady and not trace:
        raise ValueError("Pass --steady or --trace, or provide a run directory containing either file")
    for path in (floorplan, steady, trace):
        if path and not path.is_file():
            raise ValueError(f"Input file does not exist: {path}")
    output_dir = run_dir or (steady.parent if steady else trace.parent)
    output = args.output or (output_dir / "thermal-visualization.html")
    return floorplan, steady, trace, output


def render_html(data, title):
    payload = json.dumps(data, separators=(",", ":"), allow_nan=False)
    # JSON in a script element must not allow input names to close that element.
    payload = payload.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return HTML_TEMPLATE.replace("__TITLE__", html.escape(title)).replace("__DATA__", payload)


HTML_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
  :root { color-scheme: light dark; font: 15px/1.4 system-ui, sans-serif; }
  body { max-width: 1120px; margin: 28px auto; padding: 0 18px; background: Canvas; color: CanvasText; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  p { margin: 0 0 18px; color: GrayText; }
  .layout { display: flex; flex-wrap: wrap; gap: 22px; align-items: flex-start; }
  #map { display: block; width: min(100%, 720px); height: auto; flex: 1 1 360px; overflow: visible; }
  aside { flex: 1 1 230px; min-width: 210px; }
  .legend { height: 18px; background: linear-gradient(90deg,#440154,#3b528b,#21918c,#5ec962,#fde725); }
  .ticks { display: flex; justify-content: space-between; font-variant-numeric: tabular-nums; }
  .detail { margin-top: 22px; min-height: 4.5em; font-variant-numeric: tabular-nums; }
  .detail strong { display: block; }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 18px; }
  button, input { font: inherit; }
  button { padding: 5px 10px; }
  input[type=range] { flex: 1 1 220px; min-width: 150px; }
  .block { stroke: Canvas; stroke-width: 1.1; cursor: pointer; }
  .block:hover, .block:focus { stroke: CanvasText; stroke-width: 2.5; outline: none; }
  .block.selected { stroke: CanvasText; stroke-width: 3; }
  .unit-label { fill: CanvasText; font-size: 13px; text-anchor: middle; font-weight: 600; pointer-events: none; paint-order: stroke; stroke: Canvas; stroke-width: 3px; stroke-linejoin: round; }
  .axis { fill: GrayText; font-size: 12px; }
  .frame { fill: none; stroke: CanvasText; stroke-width: 1; pointer-events: none; }
  .hidden { display: none; }
</style>
</head>
<body>
<h1>__TITLE__</h1>
<p id="subtitle"></p>
<div class="controls" id="controls">
  <button type="button" id="steady-button">Steady state</button>
  <button type="button" id="trace-button">Trace</button>
  <button type="button" id="play-button">Play</button>
  <label for="sample">Sample <span id="sample-number"></span></label>
  <input id="sample" type="range" min="0" value="0">
</div>
<div class="layout">
  <svg id="map" aria-label="HotSpot floorplan temperature heatmap"></svg>
  <aside>
    <strong>Temperature · K (shared scale)</strong>
    <div class="legend" aria-hidden="true"></div>
    <div class="ticks"><span id="low"></span><span id="mid"></span><span id="high"></span></div>
    <div class="detail" id="detail" aria-live="polite"></div>
  </aside>
</div>
<script id="thermal-data" type="application/json">__DATA__</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('thermal-data').textContent);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.getElementById('map');
  const sample = document.getElementById('sample');
  const sampleNumber = document.getElementById('sample-number');
  const play = document.getElementById('play-button');
  const steadyButton = document.getElementById('steady-button');
  const traceButton = document.getElementById('trace-button');
  const detail = document.getElementById('detail');
  const hasSteady = data.steady !== null;
  const hasTrace = data.trace.length > 0;
  let mode = hasSteady ? 'steady' : 'trace';
  let index = 0;
  let selected = null;
  let timer = null;
  const units = data.units;
  let low = Infinity, high = -Infinity;
  for (const frame of [data.steady, ...data.trace]) {
    if (!frame) continue;
    for (const unit of units) {
      low = Math.min(low, frame[unit.name]);
      high = Math.max(high, frame[unit.name]);
    }
  }
  const domainHigh = high === low ? low + 1 : high;
  const stops = ['#440154','#3b528b','#21918c','#5ec962','#fde725'];
  const svgElement = (tag, attrs = {}) => {
    const element = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
    return element;
  };
  const color = kelvin => {
    const position = Math.min(0.999999, Math.max(0, (kelvin-low)/(domainHigh-low))) * (stops.length-1);
    const i = Math.floor(position), fraction = position-i;
    const a = stops[i].slice(1).match(/../g).map(hex => parseInt(hex,16));
    const b = stops[i+1].slice(1).match(/../g).map(hex => parseInt(hex,16));
    return '#' + a.map((v,j) => Math.round(v+(b[j]-v)*fraction).toString(16).padStart(2,'0')).join('');
  };
  const minX = Math.min(...units.map(u => u.x)), maxX = Math.max(...units.map(u => u.x+u.width));
  const minY = Math.min(...units.map(u => u.y)), maxY = Math.max(...units.map(u => u.y+u.height));
  const scale = Math.min(45, 620/Math.max(maxX-minX, maxY-minY));
  const left = 46, top = 12, right = 12, bottom = 40;
  const width = (maxX-minX)*scale, height = (maxY-minY)*scale;
  svg.setAttribute('viewBox', `0 0 ${left+width+right} ${top+height+bottom}`);
  const x = u => left+(u.x-minX)*scale;
  const y = u => top+(maxY-u.y-u.height)*scale;
  const blockElements = new Map();
  for (const unit of units) {
    const rect = svgElement('rect', {x:x(unit), y:y(unit), width:unit.width*scale,
      height:unit.height*scale, class:'block', tabindex:'0', role:'button',
      'aria-label':unit.name});
    rect.addEventListener('click', () => { selected = unit.name; update(); });
    rect.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selected = unit.name; update(); }
    });
    const title = svgElement('title'); rect.append(title);
    svg.append(rect); blockElements.set(unit.name, {rect,title});
  }
  svg.append(svgElement('rect', {x:left,y:top,width,height,class:'frame'}));
  for (const unit of units) {
    if (unit.width*scale < 84 || unit.height*scale < 47) continue;
    const text = svgElement('text', {x:x(unit)+unit.width*scale/2, y:y(unit)+unit.height*scale/2,
      class:'unit-label'});
    const name = svgElement('tspan', {x:text.getAttribute('x'), dy:'-3'});
    name.textContent = unit.name;
    const value = svgElement('tspan', {x:text.getAttribute('x'), dy:'16'});
    text.append(name,value); svg.append(text);
    blockElements.get(unit.name).label = value;
  }
  const xLabel = svgElement('text', {x:left+width/2,y:top+height+31,class:'axis','text-anchor':'middle'});
  xLabel.textContent = `x · mm (${minX.toFixed(2)}–${maxX.toFixed(2)})`; svg.append(xLabel);
  const yLabel = svgElement('text', {x:13,y:top+height/2,class:'axis','text-anchor':'middle',
    transform:`rotate(-90 13 ${top+height/2})`});
  yLabel.textContent = `y · mm (${minY.toFixed(2)}–${maxY.toFixed(2)})`; svg.append(yLabel);
  document.getElementById('low').textContent = low.toFixed(2);
  document.getElementById('mid').textContent = ((low+high)/2).toFixed(2);
  document.getElementById('high').textContent = high.toFixed(2);
  sample.max = Math.max(0,data.trace.length-1);
  steadyButton.classList.toggle('hidden', !hasSteady || !hasTrace);
  traceButton.classList.toggle('hidden', !hasSteady || !hasTrace);
  document.getElementById('subtitle').textContent = `${units.length} floorplan blocks · ${data.trace.length} trace samples · Kelvin source values`;
  function stop() { if (timer !== null) clearInterval(timer); timer = null; play.textContent = 'Play'; }
  function update() {
    const frame = mode === 'steady' ? data.steady : data.trace[index];
    const traceMode = mode === 'trace';
    sample.classList.toggle('hidden', !traceMode);
    play.classList.toggle('hidden', !traceMode || data.trace.length < 2);
    document.querySelector('label[for="sample"]').classList.toggle('hidden', !traceMode);
    sampleNumber.textContent = `${index+1} / ${data.trace.length}`;
    sample.value = index;
    steadyButton.setAttribute('aria-pressed', String(!traceMode));
    traceButton.setAttribute('aria-pressed', String(traceMode));
    for (const unit of units) {
      const kelvin = frame[unit.name];
      const item = blockElements.get(unit.name);
      item.rect.setAttribute('fill', color(kelvin));
      item.rect.classList.toggle('selected', selected === unit.name);
      item.rect.setAttribute('aria-label', `${unit.name}: ${kelvin.toFixed(2)} kelvin`);
      item.title.textContent = `${unit.name}: ${kelvin.toFixed(2)} K · ${(kelvin-273.15).toFixed(2)} °C`;
      if (item.label) item.label.textContent = `${kelvin.toFixed(2)} K`;
    }
    const hottest = units.reduce((a,b) => frame[a.name] > frame[b.name] ? a : b);
    const name = selected || hottest.name;
    const k = frame[name];
    detail.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = `${selected ? 'Selected' : 'Hottest'}: ${name}`;
    const values = document.createElement('div');
    values.textContent = `${k.toFixed(2)} K · ${(k-273.15).toFixed(2)} °C`;
    detail.append(heading, values);
  }
  steadyButton.addEventListener('click', () => { stop(); mode = 'steady'; update(); });
  traceButton.addEventListener('click', () => { mode = 'trace'; update(); });
  sample.addEventListener('input', () => { index = Number(sample.value); update(); });
  play.addEventListener('click', () => {
    if (timer !== null) { stop(); return; }
    mode = 'trace'; play.textContent = 'Pause';
    timer = setInterval(() => { index = (index+1) % data.trace.length; update(); }, 250);
    update();
  });
  update();
})();
</script>
</body>
</html>
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, help="pilot run folder; detects gcc.steady, gcc.ttrace, and one .flp")
    parser.add_argument("--floorplan", type=Path, help="HotSpot .flp file (required if run folder has none)")
    parser.add_argument("--steady", type=Path, help="HotSpot steady temperature file")
    parser.add_argument("--trace", type=Path, help="HotSpot transient trace file")
    parser.add_argument("--output", type=Path, help="output HTML path (defaults beside the run files)")
    parser.add_argument("--title", help="page title")
    args = parser.parse_args()
    try:
        floorplan, steady_path, trace_path, output = find_inputs(args)
        units = read_floorplan(floorplan)
        names = {unit["name"] for unit in units}
        steady = read_steady(steady_path, names) if steady_path else None
        trace = read_trace(trace_path, names) if trace_path else []
        title = args.title or f"HotSpot temperatures · {(args.run_dir or floorplan).name}"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(render_html({"units": units, "steady": steady, "trace": trace}, title))
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    print(f"Wrote {output} ({len(units)} blocks, {len(trace)} trace samples)")


if __name__ == "__main__":
    main()
