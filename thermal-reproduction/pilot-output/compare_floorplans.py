#!/usr/bin/env python3
"""Compare two HotSpot .flp files and write a self-contained HTML viewer.

The first file is the base. Blocks with identical names are compared directly.
Numbered block families (for example Bpred_0..2 and Bpred) are recognized as
splits or merges when their combined geometry is equal within a tolerance.
Unrelated layouts are shown side by side on the same coordinate scale.
"""

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass
import html
import math
from pathlib import Path
import re


TOLERANCE_MM = 0.002
COLORS = {
    "unchanged": "#b8c3cc", "merge": "#e3a620", "split": "#159c91",
    "moved": "#8b64bf", "resized": "#4b83c4", "moved and resized": "#a866b8",
    "renamed": "#78923f", "added": "#198d59", "removed": "#cb5757",
}


@dataclass(frozen=True)
class Block:
    name: str
    x: float
    y: float
    width: float
    height: float

    @property
    def bounds(self):
        return self.x, self.y, self.x + self.width, self.y + self.height

    @property
    def area(self):
        return self.width * self.height


def read_floorplan(path):
    blocks = []
    names = set()
    for number, raw in enumerate(path.read_text().splitlines(), 1):
        parts = raw.split("#", 1)[0].split()
        if not parts:
            continue
        if len(parts) < 5:
            raise ValueError(f"{path}:{number}: expected name, width, height, x, y")
        name = parts[0]
        if name in names:
            raise ValueError(f"{path}:{number}: duplicate block {name!r}")
        try:
            width, height, x, y = (float(value) * 1000 for value in parts[1:5])
        except ValueError as exc:
            raise ValueError(f"{path}:{number}: invalid geometry") from exc
        if not all(map(math.isfinite, (width, height, x, y))) or width <= 0 or height <= 0:
            raise ValueError(f"{path}:{number}: width and height must be finite and positive")
        blocks.append(Block(name, x, y, width, height))
        names.add(name)
    if not blocks:
        raise ValueError(f"{path}: no floorplan blocks")
    return blocks


def close(a, b):
    return abs(a - b) <= TOLERANCE_MM


def same_bounds(first, second):
    return all(close(a, b) for a, b in zip(first.bounds, second.bounds))


def combined_bounds(blocks):
    return (min(block.x for block in blocks), min(block.y for block in blocks),
            max(block.x + block.width for block in blocks),
            max(block.y + block.height for block in blocks))


def same_coverage(first, second):
    if not all(close(a, b) for a, b in zip(combined_bounds(first), combined_bounds(second))):
        return False
    # Bounding boxes alone can hide gaps. These examples partition rectangles;
    # the area check rejects a different total footprint.
    return abs(sum(b.area for b in first) - sum(b.area for b in second)) <= 0.005


def family(name):
    return re.sub(r"_\d+$", "", name)


def compare(base, second):
    old = {block.name: block for block in base}
    new = {block.name: block for block in second}
    old_left, new_left = set(old), set(new)
    changes = []

    def record(kind, old_names, new_names):
        changes.append({"kind": kind, "old": sorted(old_names), "new": sorted(new_names)})
        old_left.difference_update(old_names)
        new_left.difference_update(new_names)

    for name in sorted(old_left & new_left):
        before, after = old[name], new[name]
        moved = not (close(before.x, after.x) and close(before.y, after.y))
        resized = not (close(before.width, after.width) and close(before.height, after.height))
        kind = "moved and resized" if moved and resized else "moved" if moved else "resized" if resized else "unchanged"
        record(kind, [name], [name])

    old_families, new_families = defaultdict(list), defaultdict(list)
    for name in old_left:
        old_families[family(name)].append(old[name])
    for name in new_left:
        new_families[family(name)].append(new[name])
    for stem in sorted(old_families.keys() & new_families.keys()):
        before, after = old_families[stem], new_families[stem]
        if len(before) == len(after) or not same_coverage(before, after):
            continue
        kind = "merge" if len(before) > len(after) else "split"
        record(kind, [b.name for b in before], [b.name for b in after])

    # Exact geometry also supports a one-to-one rename without a shared stem.
    for old_name in sorted(old_left):
        matches = [new_name for new_name in sorted(new_left)
                   if same_bounds(old[old_name], new[new_name])]
        if len(matches) == 1:
            record("renamed", [old_name], matches)

    for name in sorted(old_left):
        record("removed", [name], [])
    for name in sorted(new_left):
        record("added", [], [name])

    matched_area = sum(old[name].area for change in changes
                       if change["kind"] not in ("removed", "added") for name in change["old"])
    total_base_area = sum(block.area for block in base)
    mode = "overlay" if matched_area / total_base_area >= 0.3 else "side-by-side"
    return changes, mode


def esc(value):
    return html.escape(str(value), quote=True)


def svg_rect(block, bounds, scale, status, *, fill=True, dashed=False):
    min_x, _, _, max_y = bounds
    x = 42 + (block.x - min_x) * scale
    y = 12 + (max_y - block.y - block.height) * scale
    width, height = block.width * scale, block.height * scale
    color = COLORS[status]
    fill_color = color
    opacity = "0.58" if fill and status != "unchanged" else "0.35" if fill else "0"
    dash = ' stroke-dasharray="5 3"' if dashed else ""
    stroke_color = "#334155" if dashed else color
    stroke_width = 1.5 if dashed else 2 if status != "unchanged" else 0.8
    return (f'<rect x="{x:.3f}" y="{y:.3f}" width="{width:.3f}" height="{height:.3f}" '
            f'fill="{fill_color}" fill-opacity="{opacity}" stroke="{stroke_color}" stroke-width="{stroke_width}"{dash}>'
            f'<title>{esc(block.name)} · {esc(status)} · x={block.x:.3f}, y={block.y:.3f}, '
            f'w={block.width:.3f}, h={block.height:.3f} mm</title></rect>')


def svg_panel(base, second, changes, *, layer, focus=False):
    all_blocks = base + second
    if focus:
        changed_names = {name for change in changes if change["kind"] != "unchanged"
                         for name in change["old"] + change["new"]}
        all_blocks = [block for block in all_blocks if block.name in changed_names]
    bounds = (min(b.x for b in all_blocks), min(b.y for b in all_blocks),
              max(b.x + b.width for b in all_blocks), max(b.y + b.height for b in all_blocks))
    min_x, min_y, max_x, max_y = bounds
    if focus:
        bounds = (min_x - 0.15, min_y - 0.15, max_x + 0.15, max_y + 0.15)
        min_x, min_y, max_x, max_y = bounds
    scale = 620 / max(max_x - min_x, max_y - min_y)
    width, height = (max_x - min_x) * scale, (max_y - min_y) * scale
    old = {b.name: b for b in base}
    new = {b.name: b for b in second}
    old_status = {name: change["kind"] for change in changes for name in change["old"]}
    new_status = {name: change["kind"] for change in changes for name in change["new"]}
    pieces = [f'<svg viewBox="0 0 {width+55:.1f} {height+48:.1f}" role="img" '
              f'aria-label="{esc(layer)} floorplan comparison in millimetres">']
    if layer == "overlay":
        # Base footprint first, then second-version fills, old boundaries, new outlines.
        pieces += [svg_rect(block, bounds, scale, "unchanged") for block in base]
        pieces += [svg_rect(block, bounds, scale, new_status[block.name]) for block in second
                   if new_status[block.name] != "unchanged"]
        pieces += [svg_rect(block, bounds, scale, old_status[block.name], fill=False, dashed=True)
                   for block in base if old_status[block.name] != "unchanged"]
        pieces += [svg_rect(block, bounds, scale, new_status[block.name], fill=False)
                   for block in second if new_status[block.name] != "unchanged"]
    else:
        blocks = base if layer == "base" else second
        pieces += [svg_rect(block, bounds, scale, "unchanged") for block in blocks]
    for block in (base if layer == "base" else second):
        if block.width * scale < 78 or block.height * scale < 34:
            continue
        x = 42 + (block.x - min_x + block.width / 2) * scale
        y = 12 + (max_y - block.y - block.height / 2) * scale
        pieces.append(f'<text class="block-name" x="{x:.2f}" y="{y:.2f}">{esc(block.name)}</text>')
    pieces.append(f'<text class="axis" x="{42+width/2:.1f}" y="{height+43:.1f}" text-anchor="middle">x · mm</text>')
    pieces.append(f'<text class="axis" x="12" y="{12+height/2:.1f}" text-anchor="middle" '
                  f'transform="rotate(-90 12 {12+height/2:.1f})">y · mm</text>')
    pieces.append('</svg>')
    return "\n".join(pieces)


def format_change(change):
    before = ", ".join(change["old"]) or "—"
    after = ", ".join(change["new"]) or "—"
    return f'<li><span class="swatch" style="background:{COLORS[change["kind"]]}"></span><strong>{esc(change["kind"].title())}</strong> · {esc(before)} → {esc(after)}</li>'


def render(base, second, changes, mode, base_path, second_path):
    counts = Counter(change["kind"] for change in changes)
    if mode == "overlay":
        figures = ('<figure><figcaption>Second floorplan over base · dashed outlines mark previous boundaries</figcaption>'
                   + svg_panel(base, second, changes, layer="overlay") + '</figure>')
        changed = [b for b in base + second if any(b.name in c["old"] + c["new"]
                                                 for c in changes if c["kind"] != "unchanged")]
        if changed:
            full_width = max(b.x+b.width for b in base+second) - min(b.x for b in base+second)
            full_height = max(b.y+b.height for b in base+second) - min(b.y for b in base+second)
            detail_width = max(b.x+b.width for b in changed) - min(b.x for b in changed)
            detail_height = max(b.y+b.height for b in changed) - min(b.y for b in changed)
            if detail_width * detail_height < 0.7 * full_width * full_height:
                figures += ('<figure><figcaption>Changed area · enlarged</figcaption>'
                            + svg_panel(base, second, changes, layer="overlay", focus=True) + '</figure>')
        change_list = "\n".join(format_change(change) for change in changes if change["kind"] != "unchanged")
        if not change_list:
            change_list = "<li>No geometry or name changes.</li>"
    else:
        figures = ('<figure><figcaption>Base · first input</figcaption>' + svg_panel(base, second, changes, layer="base") + '</figure>'
                   '<figure><figcaption>Second input</figcaption>' + svg_panel(base, second, changes, layer="second") + '</figure>')
        change_list = '<li>No reliable block correspondence; shown side by side on the same scale.</li>'
    if mode == "side-by-side":
        summary = "No reliable block correspondence · same coordinate scale"
    else:
        summary = ", ".join(f"{count} {kind}" for kind, count in sorted(counts.items()) if kind != "unchanged") or "No changes"
    title = f"Floorplan comparison: {base_path.name} → {second_path.name}"
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<style>
  :root {{ color-scheme: light dark; font: 15px/1.45 system-ui,sans-serif; }}
  body {{ max-width: 1200px; margin: 26px auto; padding: 0 20px; background: Canvas; color: CanvasText; }}
  h1 {{ font-size: 1.5rem; margin: 0 0 8px; }}
  .subtle {{ color: GrayText; margin: 0 0 18px; overflow-wrap: anywhere; }}
  .figures {{ display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-start; }}
  figure {{ margin: 0; flex: 1 1 400px; max-width: 720px; }}
  figcaption {{ font-weight: 600; margin-bottom: 8px; }}
  svg {{ width: 100%; height: auto; display: block; }}
  .block-name {{ fill: CanvasText; font-size: 12px; font-weight: 600; text-anchor: middle; dominant-baseline: middle;
    paint-order: stroke; stroke: Canvas; stroke-width: 3px; stroke-linejoin: round; pointer-events: none; }}
  .axis {{ fill: GrayText; font-size: 12px; }}
  h2 {{ font-size: 1.1rem; margin: 24px 0 8px; }}
  ul {{ padding-left: 20px; }} li {{ margin: 5px 0; overflow-wrap: anywhere; }}
  .swatch {{ display: inline-block; width: 10px; height: 10px; margin-right: 7px; vertical-align: baseline; }}
</style>
</head>
<body>
<h1>{esc(title)}</h1>
<p class="subtle">Base: {esc(base_path)}<br>Second: {esc(second_path)}<br>{len(base)} → {len(second)} blocks · {esc(summary)}</p>
<div class="figures">{figures}</div>
<h2>Changes from the base</h2>
<ul>{change_list}</ul>
</body>
</html>
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base", type=Path, help="first .flp file; comparison base")
    parser.add_argument("second", type=Path, help="second .flp file; changes to show")
    parser.add_argument("--output", type=Path, help="output HTML path; defaults beside the base file")
    args = parser.parse_args()
    try:
        base = read_floorplan(args.base)
        second = read_floorplan(args.second)
        changes, mode = compare(base, second)
        output = args.output or args.base.with_name(f"{args.base.stem}-vs-{args.second.stem}.html")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(render(base, second, changes, mode, args.base, args.second))
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    counts = Counter(change["kind"] for change in changes)
    print(f"Wrote {output} ({mode}; {dict(counts)})")


if __name__ == "__main__":
    main()
