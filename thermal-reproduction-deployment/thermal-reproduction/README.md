# Thermal paper feasibility and pilot

## What this pilot proves

`feasibility_inventory.md` screens all 31 manifest entries against the current HotSpot Studio backend. The local collection has 22 PDFs; nine are unavailable. The screen found no exact match to Studio's fixed EV6/GCC experiment. The one-paper pilot uses the Alpha EV6 paper (`W4206159291`) as an **adapted** demonstration. The paper uses a 3D FEniCS/POD model and localized pulsed power (PDF p. 2); the pilot runs Studio's EV6/GCC HotSpot case. Its database comparison is explicitly invalid for a numerical paper-result match.

The editable Rivet project is `paper-pilot.rivet-project`. Its stages are paper extraction (LLM), feasibility review (deterministic), HotSpot API run, and result assessment (LLM). The live path makes two LLM calls. `--mock-llm` substitutes a checked, page-cited fixture and makes no LLM calls; it still runs HotSpot through the API and downloads both artifacts.

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

To run the live LLM path after the fixture test, set `OPENAI_API_KEY` and `LLM_MODEL` in the Codespace terminal, then:

```bash
cd thermal-reproduction
OPENAI_API_KEY="$OPENAI_API_KEY" LLM_MODEL="$LLM_MODEL" npm run pilot -- --allow-adapted
```

`LLM_BASE_URL` can point to another OpenAI-compatible chat-completions API. Do not put keys in the Rivet graph or saved results. The live LLM path has not been exercised without a configured API key.

## App data model

`schema.sql` defines papers, experiments, page-cited evidence, versioned workflow runs, LLM calls, simulations, downloadable artifacts, and metric comparisons. `app_paper_summary` gives the app one row per paper experiment with its latest workflow and simulation status. The app should serve files from `artifact.storage_path` after checking the requesting user's access and verifying the path stays within its configured artifact root. A batch worker should copy Studio artifacts to durable storage before deleting old Studio run folders.

The pilot importer is repeatable:

```bash
python3 thermal-reproduction/load_pilot.py --manifest thermal-reproduction/pilot-output/W4206159291/<run-folder>/manifest.json
```

The current worker runs one experiment at a time, which matches Studio's single-simulation lock. For a batch run, process each downloaded paper independently, checkpoint each stage, and key attempts by PDF hash, graph hash, experiment specification, and model settings. Skip unsupported and missing-source papers; do not retry validation errors. Retry temporary API failures and preserve partial evidence/results for review.
