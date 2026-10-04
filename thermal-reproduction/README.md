# Thermal paper screening and pilot

## What this workflow does

`paper-pilot.rivet-project` is an editable Rivet graph for one paper at a time. It:

1. Extracts a **single, named paper scenario** and a page or pinned asset locator for each method, code, parameter, configuration, data, geometry, power, and thermal-result claim.
2. Sends that extraction and the original paper packet to a separate **adversarial agent**. The agent checks methods, code, parameters, config, and data independently and records contradictions.
3. Applies deterministic Studio input limits and records scientific-fit checks. A custom run with valid geometry, power, and config may proceed even when evidence or adversarial checks are unresolved. Only a second reader's review of the exact evidence hash can support a confirmed candidate label.
4. Submits the `custom_2d_steady` experiment, or the legacy bundled EV6/GCC demo, to Studio. It retrieves the saved configuration, run status, solver log, named Kelvin/°C rows, generated input files, and temperature files. A custom result also gets a second run with one block's power changed to check temperature direction. Each downloaded artifact is checked against Studio's byte count and SHA-256.
5. Produces a conservative assessment. The output never marks a numerical paper comparison valid automatically.

The versioned [2D screening protocol](2D_SNAPSHOT_SCREENING_PROTOCOL.md) is the rubric. It is a procedure, not a completed audit. The [new inventory](screening_inventory.md) freezes all 31 manifest rows and verifies the 22 local PDF headers, sizes, hashes, and page counts. Nine rows are `source_unavailable`; the 22 PDFs are **pending source-complete review**, so the five-label totals are not final and there are no claimed 2D candidates yet. The [old inventory](feasibility_inventory.md) remains the historical EV6/GCC screen.

## Rivet graph and prompts

Open `paper-pilot.rivet-project` in Rivet Desktop using **File → Open Project**. The editable Text nodes are **Extraction instructions**, **Adversarial verification instructions**, and **Assessment instructions**. Keep the external function names and graph outputs aligned with `pilot.mjs`. Rivet's Run button needs a remote debugger to execute these external functions; use the Node runner in a Codespace.

PDF and asset content is passed as untrusted research data. The adversarial reviewer is a distinct LLM call and cannot supply the human second-reader signoff. Its checklist and findings appear in the CLI result and saved `adversarial.json`. Scientific concerns remain in `feasibility.json`; an exploratory Studio run never makes a paper comparison valid automatically.

## Screen a paper

In a Codespace with the repository, install dependencies and Poppler:

```sh
cd thermal-reproduction
npm ci
sudo apt-get update && sudo apt-get install -y poppler-utils
npm test
```

Start Studio in another terminal with `bash hotspot-studio/start.sh`, then run the first screen for a downloaded manifest entry:

```sh
read -rsp 'Anthropic API key: ' ANTHROPIC_API_KEY
echo
export ANTHROPIC_API_KEY
npm run pilot -- --run-type custom --paper-id W4361199658
```

The first pass writes `pilot-output/<paper-id>/<attempt>/manifest.json`, `extraction.json`, `adversarial.json`, and `feasibility.json`. With valid Studio inputs, it also runs a diagnostic simulation and saves `temperatures.steady`; no independent review is needed to run it. Unresolved evidence and adversarial findings remain visible, and the result is not a confirmed paper reproduction. Inspect the cited PDF pages, figures, linked resources, units, scenario consistency, and physical mismatches before treating any comparison as valid. Do not sign an incomplete review record.

If the paper links code, data, or supplements, download and pin them first. Pass a local `--assets-file` JSON array; each item has `id`, `kind`, `paper_page`, `original_url`, `final_url`, `version` (commit/tag/release), `path` (relative to the manifest file), `sha256`, and `locator`. The runner verifies the local hash and includes the text in both LLM calls. Use a cited excerpt of at most 200 KB per asset; keep the original file and its hash in your evidence archive. The workflow does not execute downloaded code or silently fetch a repository's latest version. Missing linked resources remain blocking facts.

After a second reader has checked every critical page and asset, write a review file:

```json
{
  "reviewer": "Name of second reader",
  "completed_at": "2026-10-03T12:00:00Z",
  "evidence_sha256": "<feasibility.evidence_sha256 from the first attempt>",
  "approved": true,
  "reviewed_pdf_pages": [1, 3, 5],
  "reviewed_assets": [],
  "corrections": []
}
```

For a reviewed rerun, reuse the **same** extraction and adversarial output so the signoff hash stays valid:

```sh
npm run pilot -- --run-type custom --paper-id W4361199658 \
  --reuse-audit pilot-output/W4361199658/<first-attempt>/manifest.json \
  --review-file /path/to/second-reader-review.json
```

Use the same `--assets-file` on both runs if linked assets were supplied. Reuse checks the PDF and asset hashes. Pass `--config-file /path/to/config` to use reviewed settings; the default is Studio's bundled example config in block mode. For grid mode, set `model_type grid` and power-of-two grid rows and columns in that file. The backend may still reject an unsupported config or solver failure; the saved Studio result and log record that outcome. For a completed block run, expect `submitted.experiment.json`, `input.flp`, `input.ptrace`, and `temperatures.steady`. Grid mode additionally requires `temperatures.grid.steady`. Custom runs have no `gcc.ttrace`.

The live LLM path uses Anthropic Messages structured JSON output and defaults to `claude-haiku-4-5-20251001`; set `ANTHROPIC_MODEL` to use another supported model. The model emits named `power_rows`, which the runner converts to Studio's `power_w` map after rejecting duplicate names. A completed live LLM call has not been tested with a user API key in this checkout.

## Bundled EV6/GCC regression demo

The original paper `W4206159291` uses 3D FEniCS/POD and pulsed power. The bundled HotSpot run is an **adapted artifact-pipeline demo**, with no valid numerical paper comparison:

```sh
bash thermal-reproduction/test-pilot.sh
```

This runs graph/unit tests, then a real Studio simulation using a page-cited fixture and downloads `gcc.steady` and `gcc.ttrace`. It imports the attempt into `pilot-output/pilot.db`. The first screen remains `adapted_only`.

## Inventory and app data

Regenerate the source snapshot after completing paper screens:

```sh
python3 thermal-reproduction/screen_inventory.py
```

The script needs `pdfinfo` or `pypdf` for page counts. It retains all manifest rows in order, records unavailable-source reasons, takes the latest independently reviewed custom attempt for the current manifest, rubric, and PDF hashes, and reports confirmed and conditional papers by name. While any downloaded row is pending, `counts_final` is false. Never add pending or unavailable papers to a candidate count.

Import one custom attempt into the SQLite app model:

```sh
python3 thermal-reproduction/load_pilot.py \
  --manifest thermal-reproduction/pilot-output/<paper-id>/<attempt>/manifest.json
```

`snapshot_screening_run` stores the full extraction, adversarial review, gate, human review, Studio response, and hashes. `snapshot_screening_artifact` stores checked file paths, byte counts, and hashes; `app_2d_screening_summary` shows the latest attempt per paper. Existing `app_paper_summary` still describes the older bundled screen. A service exposing artifact paths must enforce user access and stay within the configured artifact root.
