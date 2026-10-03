# Thermal paper feasibility and pilot

## What this pilot proves

`feasibility_inventory.md` screens all 31 manifest entries against the current HotSpot Studio backend. The local collection has 22 PDFs; nine are unavailable. The screen found no exact match to Studio's fixed EV6/GCC experiment. The one-paper pilot uses the Alpha EV6 paper (`W4206159291`) as an **adapted** demonstration. The paper uses a 3D FEniCS/POD model and localized pulsed power (PDF p. 2); the pilot runs Studio's EV6/GCC HotSpot case. Its database comparison is explicitly invalid for a numerical paper-result match.

The editable Rivet project is `paper-pilot.rivet-project`. Its stages are paper extraction (LLM), feasibility review (deterministic), HotSpot API run, and result assessment (LLM). The two LLM system prompts are editable Text nodes named **Extraction instructions** and **Assessment instructions**. The live path makes two LLM calls. `--mock-llm` substitutes a checked, page-cited fixture and makes no LLM calls; it still runs HotSpot through the API and downloads both artifacts.

The extraction prompt and JSON schema use canonical evidence field names. Feasibility records any omitted core fields in `missing_evidence_fields` and sets `extraction_complete` accordingly. Missing extraction evidence never turns the adapted demonstration into a valid paper-result comparison; the assessment also lists the omission for review.

## Edit the workflow in Rivet

Install the [Rivet desktop app](https://rivet.ironcladapp.com/docs/getting-started/installation) on your computer. Editing the graph locally does not run HotSpot. In Rivet, choose **File → Open Project** (Cmd+O on macOS) and select this `paper-pilot.rivet-project` file. Open **Paper pilot**, click either instructions node to edit the LLM prompt, or rearrange the stage nodes, then save with Cmd+S.

The graph's four **External Call** nodes use functions in `pilot.mjs`. Their function names (`extractPaper`, `reviewFeasibility`, `runHotspot`, `assessResult`) and the four graph output IDs must stay aligned with that runner. Rivet's own **Run** button cannot execute those functions without a remote debugger; run the saved graph from the Codespace instead. Upload the edited `paper-pilot.rivet-project` file into `thermal-reproduction-deployment/thermal-reproduction/`, replacing the copy there, then run `bash thermal-reproduction/test-pilot.sh` from `thermal-reproduction-deployment`. The fixture test verifies graph wiring and performs a real HotSpot run; it does not test new prompt wording against an LLM. For that, use the live LLM command below.

If you update an existing Codespace deployment, the initial `unzip -n` command below **keeps** the old graph and runner. Keep a backup of any graph you edited in Rivet, then replace `paper-pilot.rivet-project` and `pilot.mjs` from the updated ZIP (or upload those two files in VS Code). Run `npm test` inside `thermal-reproduction-deployment/thermal-reproduction` before a live LLM call. The graph test checks that both instruction nodes reach their external functions.

## Simplest Codespace test

Upload `Thermal-Reproduction-Codespaces.zip` to the Codespace. In one terminal:

```bash
unzip -n Thermal-Reproduction-Codespaces.zip
cd thermal-reproduction-deployment
bash hotspot-studio/start.sh
```

Keep that terminal open. In a second Codespace terminal:

```bash
cd thermal-reproduction-deployment
bash thermal-reproduction/test-pilot.sh
```

The script installs Rivet and `pdftotext` if needed, runs the tests, performs one real HotSpot simulation using the fixture, verifies `gcc.steady` and `gcc.ttrace` hashes, and loads the result into `thermal-reproduction/pilot-output/pilot.db`. It prints the output folder and file paths. Forward port 8000 as **Private** if you also want to view Studio in the browser.

To run the live LLM path after the fixture test, enter your Anthropic key in a Codespace terminal without putting it in shell history:

```bash
read -rsp 'Anthropic API key: ' ANTHROPIC_API_KEY
echo
export ANTHROPIC_API_KEY
cd thermal-reproduction
npm run pilot -- --allow-adapted
```

The runner calls Anthropic's Messages API with `output_config.format` JSON schemas for both LLM stages. It defaults to `claude-haiku-4-5-20251001`; set `ANTHROPIC_MODEL` to use another supported model. Do not put keys in the Rivet graph or saved results. The live Anthropic path has not been exercised without a configured API key.

## App data model

`schema.sql` defines papers, experiments, page-cited evidence, versioned workflow runs, LLM calls, simulations, downloadable artifacts, and metric comparisons. `app_paper_summary` gives the app one row per paper experiment with its latest workflow and simulation status. The app should serve files from `artifact.storage_path` after checking the requesting user's access and verifying the path stays within its configured artifact root. A batch worker should copy Studio artifacts to durable storage before deleting old Studio run folders.

The pilot importer is repeatable:

```bash
python3 thermal-reproduction/load_pilot.py --manifest thermal-reproduction/pilot-output/W4206159291/<run-folder>/manifest.json
```

The current worker runs one experiment at a time, which matches Studio's single-simulation lock. For a batch run, process each downloaded paper independently, checkpoint each stage, and key attempts by PDF hash, graph hash, experiment specification, and model settings. Skip unsupported and missing-source papers; do not retry validation errors. Retry temporary API failures and preserve partial evidence/results for review.
