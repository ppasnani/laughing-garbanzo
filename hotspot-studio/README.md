# HotSpot Studio

Browser editor and private-workspace simulation backend for UVA HotSpot 7.0. Uses Python's standard library and browser JavaScript; no npm packages required.

## Codespaces deployment

Upload `HotSpot-Studio-Codespaces.zip` into your Codespace using the Explorer's Upload action. From that folder:

```sh
unzip -n HotSpot-Studio-Codespaces.zip
bash hotspot-studio-deployment/hotspot-studio/start.sh
```

The self-contained bundle includes HotSpot source, examples, and Studio. It builds its own HotSpot copy without SuperLU and starts the app on port 8000. It does not overwrite the Codespace's original repository files. If the target deployment folder already exists, extract an updated bundle to a new folder instead of mixing versions.

In the Ports tab, forward port 8000, keep its visibility Private, and click Open in Browser. The Codespace's GitHub authentication is the access boundary. Everyone with access to this service shares the saved runs. This is not a public multi-user service. Closing the terminal or stopping the Codespace stops the service; rerun `start.sh` to resume. Saved runs persist on workspace disk until the Codespace or files are deleted. Download or back up research results.

## Run flow

1. Edit or import a configuration. Apply any raw source edits.
2. Click **Save configuration & run**.
3. Studio validates server-side and snapshots the configuration and bundled experiment inputs into `hotspot-studio/runs/<id>/`.
4. HotSpot computes steady-state EV6/gcc temperatures, then runs the gcc power trace from those temperatures. The two phases share a 60-second timeout.
5. Read node temperatures in °C and the solver log. Reopen earlier runs using Saved runs. Download their original configurations, `gcc.steady`, and `gcc.ttrace`.

The `gcc.steady` file contains native Kelvin temperatures; `gcc.ttrace` contains the transient temperature trace initialized from `gcc.steady`. `result.json` includes Kelvin and Celsius, timestamp, status, logs, and available artifact URLs. Package nodes are included and labelled using HotSpot's original names. `submitted.config` preserves the original source; `tuned.config` is its canonicalized execution form. Only one simulation runs at a time; storage is limited to 100 run folders. Archive old folders to free capacity. Interrupted runs are marked after restart. Older runs with `result.steady` expose it as a `gcc.steady` download; they have no `gcc.ttrace` until rerun.

The run API returns `artifacts` entries for files available to download. Use `GET /api/runs/<id>/artifacts/gcc.steady` and `GET /api/runs/<id>/artifacts/gcc.ttrace`; missing or incomplete artifacts return 404. A paper workflow should save the run ID and artifact URLs with each eligible paper, and copy the files to durable storage before archiving run folders. These endpoints use the same private Codespace access boundary as Studio.

## Supported experiments

This release runs the bundled example1 floorplan, power trace, materials and package settings. It supports block mode and power-of-two grid dimensions up to 128. It does not accept arbitrary executable commands, external input paths, custom floorplan uploads, multi-layer or microfluidic experiments, or uncalibrated leakage models. Unknown configuration fields are preserved in editor exports but rejected by the backend. Runtime output destinations are assigned by the backend. A transient trace from the bundled gcc power input does not by itself reproduce a paper's transient experiment.

The editor's validation checks configuration structure and selected constraints, not physical accuracy. Backend validation applies additional run constraints. The build is without SuperLU; use powers of two for grid mode. Simulation settings may fail inside HotSpot; the resulting error log is shown and saved.

## Local development

From the repository root:

```sh
bash hotspot-studio/setup.sh
python3 hotspot-studio/server.py --port 8001
```

Visit http://localhost:8001. `HOTSPOT_ROOT` can select another source/build directory; setup rebuilds it without SuperLU. The service assumes that build mode. Default binding is localhost; `start.sh` binds all interfaces for Codespaces forwarding.

For editor-only operation, serve `dist` with a static HTTP server; the Run panel will report the backend as unavailable. Imported edits remain in browser memory until exported or submitted.

## Verification

```sh
node --test hotspot-studio/test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 hotspot-studio/test_server.py
```

Backend tests include a real simulation when a built executable is available. Upstream source/example licensing is included in HOTSPOT-LICENSE and the bundled HotSpot LICENSE. Source: https://github.com/uvahotspot/HotSpot.
