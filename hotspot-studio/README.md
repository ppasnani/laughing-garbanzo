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

1. Edit or import a configuration. Apply any raw source edits, then select **Bundled EV6/GCC** or **Custom 2D steady**. For a custom run, enter named block rectangles and watts, or paste/import the paired experiment JSON. Review the floorplan preview.
2. Click **Save configuration & run**.
3. Studio validates server-side and snapshots the configuration and bundled experiment inputs into `hotspot-studio/runs/<id>/`.
4. Bundled runs compute steady-state EV6/gcc temperatures, then run the gcc power trace from those temperatures. Custom runs compute one steady-state phase from a single per-block power row. The 60-second limit applies to the entire run.
5. Read node temperatures in °C and the solver log. Reopen earlier runs using Saved runs. Download their original configurations, `gcc.steady`, and `gcc.ttrace`.

The `gcc.steady` file contains native Kelvin temperatures; `gcc.ttrace` contains the transient temperature trace initialized from `gcc.steady`. Custom runs produce `temperatures.steady` and, in grid mode, `temperatures.grid.steady`. `result.json` includes Kelvin and Celsius, timestamp, status, logs, run type, and available artifact URLs. Package nodes are included and labelled using HotSpot's original names. `submitted.config` preserves the original source; `tuned.config` is its canonicalized execution form. Only one simulation runs at a time; storage is limited to 100 run folders. Archive old folders to free capacity. Interrupted runs are marked after restart. Older runs with `result.steady` expose it as a `gcc.steady` download; they have no `gcc.ttrace` until rerun.

The run API returns `artifacts` entries for files available to download, each with byte size and SHA-256. Use the URLs in the manifest; missing or incomplete outputs return 404. A paper workflow should save the run ID, `experiment.input_sha256`, and artifact URLs with each eligible paper, and copy the files to durable storage before archiving run folders. These endpoints use the same private Codespace access boundary as Studio.

## Supported experiments

The bundled example1 run retains its floorplan, power trace, materials, and package settings. A custom 2D steady run accepts 1–128 named rectangles in metres and one matching watts value per block. It supports block mode and power-of-two grid dimensions up to 128, with `model_secondary=0`. The backend assigns all input and output filenames, and uses the bundled `example.materials` and `package.config` for both run types. It rejects arbitrary commands, external input paths, layer files, microfluidic cooling, and uncalibrated leakage models. Unknown configuration fields are preserved in editor exports but rejected by the backend.

For API clients, send the same `POST /api/runs` request with the `X-Studio-Token` from `/api/status`:

```json
{
  "config": "<complete HotSpot configuration text>",
  "experiment": {
    "kind": "custom_2d_steady",
    "floorplan": [
      {"name": "core0", "x_m": 0, "y_m": 0, "width_m": 0.005, "height_m": 0.005},
      {"name": "core1", "x_m": 0.005, "y_m": 0, "width_m": 0.005, "height_m": 0.005}
    ],
    "power_w": {"core0": 8, "core1": 6}
  }
}
```

Omit `experiment` for the original bundled run. Custom results include a summary with block count, total watts, model type, bundled assumptions, and a deterministic input SHA-256. The submitted paired input is saved as `submitted.experiment.json`; generated solver inputs are `input.flp` and `input.ptrace`. A custom run does not run the transient phase. The custom model is a single-layer thermal approximation; gaps between blocks and missing paper-specific package or material parameters need explicit interpretation in research comparisons.

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
Pull requests also run these tests on Ubuntu after building HotSpot without SuperLU, so the legacy, custom block, power-direction, and grid integration checks exercise the real solver.
