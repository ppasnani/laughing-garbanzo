# Screening papers for one-scenario 2D HotSpot approximations

Rubric version: 1.1 (2026-10-03). This copy updates the Studio capability reference
after custom steady runs became available. It does not record a completed audit.

This is a handoff procedure for an agent given `../chip_thermal_management_papers/download_manifest.csv`. It is a **new audit protocol**, not a description of a completed audit. The existing `feasibility_inventory.csv` screened compatibility with Studio's fixed EV6/GCC experiment. The earlier estimate of about six additional papers with paired custom 2D inputs was an informed guess from that coarse inventory; no paper-by-paper, source-complete 2D candidate list was produced. Do not reuse that number as a measured result.

## Target and vocabulary

Studio's custom run accepts one planar floorplan (named, axis-aligned rectangles in metres) and one steady power value in watts per block. It uses the bundled package/material assumptions and returns steady block temperatures; it does not execute an optimizer, controller, transient trace, 3D stack, microfluidic cooler, or alternative solver. See `../hotspot-studio/README.md` and `../hotspot-studio/server.py`.

Screen **one identifiable scenario per paper**, ideally a specific figure/table/configuration in the paper. “Meaningful” means the paper supplies enough evidence to construct that scenario's planar geometry and matching power map, the steady 2D approximation addresses a stated thermal question, and there is at least one paper thermal observable to compare or discuss. A meaningful approximation can still be *adapted* because Studio's package/material model differs. Never label it an exact replication on this basis.

Use these mutually exclusive labels:

- `candidate_2d_snapshot`: complete paper-derived geometry and matching per-block power for one scenario, including values from verified code/data explicitly linked by the paper; steady 2D physics is relevant; a cited paper thermal observable exists. Missing package/material settings are explicit Studio assumptions, and the chosen comparison is not invalidated by a paper-specific layer, interposer, cooler, or time-dependent mechanism.
- `conditional_2d_snapshot`: the scenario and thermal question fit 2D steady state, but one or more required numeric inputs may be recoverable from a cited figure, appendix, benchmark, or author data. Specify exactly which input and source must be checked. Do not include in a confirmed candidate count.
- `illustrative_2d_only`: a planar proxy can be run, but a decisive physical feature or required input is missing. It may illustrate sensitivity, but its numbers cannot be compared as reproduction of the paper's result.
- `not_2d_applicable`: the paper's relevant result depends on a 3D stack, interposer, cooling geometry/flow, transient behavior, controller, reliability model, or nonthermal experiment in a way a single planar steady run cannot address.
- `source_unavailable`: no readable full paper in the local corpus. Do not infer from title or abstract alone.

## Repeatable procedure

1. **Freeze the input set.** Read the manifest in row order using CSV parsing. Key papers by `openalex_id`; record `title`, `doi`, `status`, `filename`, and `source_url`. Compute a SHA-256 hash of the manifest. For each `downloaded` row, require the named PDF under `../chip_thermal_management_papers/`, verify it starts with `%PDF`, compute its SHA-256, and record its page count. For unavailable rows, record `source_unavailable` and the manifest's reason; do not silently drop them. This makes the denominator 31 manifest entries (22 downloaded, 9 unavailable in the current manifest).
2. **Extract and number pages.** In the Codespace, install Poppler if needed and run `pdftotext -layout <pdf> <text-file>` plus `pdfinfo <pdf>`. Split text on form-feed and number the first PDF page 1. Retain the PDF hash and extraction method. If a page or table is garbled, inspect that PDF page visually or OCR it; mark the evidence `needs_visual_check` until verified. Do not treat a failed text extraction as evidence of absence.
3. **Find and download paper-linked code and data.** Search the full PDF text, footnotes, references, and availability statements for URLs, repository names, DOIs, supplementary files, benchmark inputs, and phrases such as `code`, `data`, `artifact`, `GitHub`, and `reproducibility`. Visually check pages where PDF URL extraction is garbled. For each resource explicitly linked by the paper, follow the link and download the repository snapshot, release, supplementary file, or dataset into a per-paper `evidence_assets/<openalex_id>/` folder. For a Git repository, pin the exact commit (prefer the paper's tag/release if given); fetch referenced submodules or large-file assets needed for the scenario. Record the paper page containing the link, original and final URL, access date, commit/tag/version, local path, byte size, SHA-256, and any stated license. Inspect README and manifests for additional linked inputs and download those too. Do not execute downloaded code during screening. If a link is broken, access restricted, or a dataset cannot be retrieved, record that precise failure and the missing files; a bare repository URL does not establish that the required floorplan or power data exists.
4. **Select one scenario before judging feasibility.** Read the abstract, methodology, experimental setup, relevant figures/tables, conclusion, and any downloaded experiment manifests. Record the specific figure/table/page, architecture/design, workload or test case, operating point, and what the authors compared. If the paper contains several regimes, choose the simplest **published steady thermal scenario** with numeric inputs. If there is none, say so. Do not combine dimensions from one design with powers from another. Confirm that linked code/data corresponds to the paper's version and this scenario; later repository defaults may differ.
5. **Extract a cited evidence ledger.** For every fact below, record `value`, `unit`, PDF page and table/figure/section, or exact linked file path plus line/record and commit/version; include a short locator and `provenance` (`explicit_text`, `table`, `figure_digitized`, `linked_code`, `linked_data`, `supplement`, `inferred`, or `missing`). Use `null` for missing values. Record uncertainty for digitized values. Required fields: (a) die/chiplet/block names; (b) each block's width, height, x, y or an unambiguous placement and die outline; (c) power in watts for each same-scenario block, or an explicit rule to derive it; (d) the result's steady/transient regime; (e) relevant layer/interposer/cooling/material/boundary conditions; (f) one paper thermal observable, units, and location/aggregation (peak block, map, average, delta, etc.). Also record the original solver, optimizer, controller, and benchmark setup so they are not mistaken for Studio capabilities.
6. **Normalize without inventing.** Convert lengths to metres, power to watts, and temperatures to Kelvin/Celsius as needed. Keep source values and conversion factors. A total chip power cannot be split across blocks without a published allocation rule. A density requires area and a clear definition of the powered region. Names in the power map must correspond exactly to named floorplan blocks; if paper blocks must be merged or split, record the mapping and its justification. Never fill missing values with EV6/GCC defaults while describing them as paper values.
7. **Apply the Studio input gate.** Check 1–128 unique safe block names; positive finite widths/heights; nonnegative finite coordinates; no positive-area overlap; bounding size within the chosen `s_spreader` and `s_sink`; exact floorplan/power name match; finite nonnegative power; and the backend limits (0.1 m coordinate/extent, 10,000 W per block, 100,000 W total). These are backend feasibility checks, not scientific-validity checks. If the paper's geometry is irregular, say how much simplification rectangles require. Do not run HotSpot at the screening stage.
8. **Apply the scientific gate.** Ask whether the selected thermal observable can reasonably respond to a single-layer steady 2D block-power model. Mark an essential mismatch if the paper's claimed effect relies on vertical heat paths, interposer/TSV geometry, fluid flow, dynamic power or thermal cycling, a control/optimization loop, custom package boundaries, or a different measured device. A snapshot may approximate one placement from an optimization paper, but it cannot reproduce optimizer quality or throughput. If a 2.5D/3D paper also reports a separate planar baseline, evaluate only that cited baseline as its scenario.
9. **Choose one label using the definitions above.** Count only `candidate_2d_snapshot` as confirmed. Report `conditional_2d_snapshot` separately as a range of possible future candidates; never add unavailable PDFs to either count. If any required geometry, power, or observable remains `missing`/`inferred`, a confirmed label is prohibited. If a decisive physical mismatch exists, use `illustrative_2d_only` or `not_2d_applicable`, explaining why.
10. **Independent verification.** A second reader opens every cited PDF page and linked file at the pinned version and checks the extracted values, units, scenario consistency, and classification. Figures containing critical geometry/power require visual confirmation. Record reviewer name/time and corrections. An LLM extraction alone is not verified evidence.
11. **Only then build and test the candidate.** For each confirmed candidate, save normalized experiment JSON, exact config, evidence ledger, PDF hash, linked asset hashes/commits, and assumptions. Submit the paired inputs to Studio in a Codespace, download `input.flp`, `input.ptrace`, and `temperatures.steady`, and verify the artifact hashes. Check that increasing one block's power raises its own steady temperature and that all output block names match. Compare only a paper observable with compatible location, aggregation, and boundary assumptions; otherwise report a qualitative sensitivity result with the mismatch stated.

## Minimum per-paper record

Save one JSON or CSV record per manifest row containing at least:

```json
{
  "openalex_id": "W...",
  "manifest_status": "downloaded",
  "pdf_sha256": "...",
  "artifact_search_status": "checked_links_found|checked_no_links|blocked",
  "linked_assets": [{"paper_page": 0, "url": "...", "kind": "code|data|supplement", "version": "...", "local_path": "...", "sha256": "...", "status": "downloaded|unavailable"}],
  "scenario": {"paper_page": 0, "figure_or_table": "...", "description": "..."},
  "geometry": {"status": "explicit|digitized|inferred|missing", "evidence": []},
  "power": {"status": "explicit|derived|inferred|missing", "evidence": []},
  "thermal_observable": {"status": "explicit|digitized|missing", "evidence": []},
  "physical_mismatches": [],
  "studio_assumptions": [],
  "input_gate_pass": false,
  "scientific_gate_pass": false,
  "decision": "conditional_2d_snapshot",
  "blocking_facts": [],
  "reviewed_pdf_pages": [],
  "independent_review": {"reviewer": null, "completed_at": null}
}
```

For each evidence item, include `field`, `value`, `unit`, `pdf_page` or pinned asset path/line, `locator`, `provenance`, and, where needed, `uncertainty`. Save the source PDF hash, linked asset hashes/commits, and a versioned copy of this rubric with the results. Produce a summary with the five label counts, a table of **named** confirmed and conditional candidates, and each paper's blocking fact. Counts must sum to the manifest row count.

## Example of conservative interpretation

The existing inventory calls `W4361199658` a 2.5D chiplet temperature/communication optimization paper and notes chiplet/interposer geometry, per-chiplet power, and optimizer requirements. This makes it worth examining for a **single placement snapshot**. The current inventory cites only PDF pages 1 and 3 and does not record a complete floorplan, same-scenario power map, or comparable thermal observable. Therefore it is **not yet a confirmed** `candidate_2d_snapshot`; the agent must inspect and download any paper-linked artifacts, locate and verify those facts, and decide whether omitting the interposer invalidates the chosen comparison.

## What was actually done previously

`build_inventory.py` contains a hand-reviewed `REVIEW` dictionary with page references and broad capability gaps for each downloaded paper. It classifies against the **current fixed EV6/GCC backend**, with `adapted_pilot_only` for `W4206159291`. It does not extract all geometry and power values, apply the 2D input/scientific gates above, or identify six verified candidates. The earlier “about six” was a planning estimate, and this audit is required before using it in product claims or batch execution.
