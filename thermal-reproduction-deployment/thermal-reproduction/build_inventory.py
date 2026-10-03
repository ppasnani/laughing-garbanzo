"""Build the reviewed feasibility screen from the paper download manifest."""

import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "chip_thermal_management_papers/download_manifest.csv"
OUTPUT = Path(__file__).with_name("feasibility_inventory.csv")

# Evidence is a PDF page number, counting the first PDF page as 1. These are
# scope decisions for the current EV6/GCC Studio backend, not claims about the
# reproducibility of the papers in a suitably extended simulator.
REVIEW = {
    "W7167828524": ("1,4", "Chiplet DNN accelerator design-space exploration", "chiplet floorplans, accelerator power/workloads, optimization loop"),
    "W4413989692": ("1,15", "Multi-fidelity 2.5D and 3D chiplet thermal models", "chiplet geometry, material stack, comparison models"),
    "W4414900343": ("1,9", "Microfluidic-cooled 3D integrated circuits", "3D layers, microfluidic cooling, architecture workloads"),
    "W4409282844": ("1,6", "Large-scale 2.5D chiplet placement and thermal evaluation", "chiplet placement, interposer geometry, varied power maps"),
    "W4400409743": ("1", "ANSYS Icepak heat-sink and fluid-flow optimization", "heat-sink geometry, fluid-flow boundary conditions, ANSYS model"),
    "W4390437658": ("1,2", "Reinforcement-learning chiplet floorplanning", "chiplet benchmark floorplans, placement policy, power maps"),
    "W4387010219": ("1,3", "Steady-state modeling of a stacked RISC-V MemPool SoC", "MemPool 2D/3D floorplans, layer stack, measured power"),
    "W4381799710": ("1,4,7", "Thermal task assignment coupled to gem5 and McPAT", "quad-core floorplan, workload power traces, scheduling loop"),
    "W4361199658": ("1,3", "2.5D chiplet temperature and communication optimization", "chiplet/interposer floorplan, per-chiplet power, optimizer"),
    "W4205499638": ("1", "Localized application-dependent processor hotspots", "processor floorplans, detailed workload power maps, hotspot metrics"),
    "W3197485759": ("1,12", "Cache-way gating and per-core DVFS", "multi-core floorplan, dynamic power/leakage, DVFS control loop"),
    "W3163019281": ("1,8", "PACT simulator evaluation across integration and cooling technologies", "PACT and comparison setups, custom floorplans, cooling models"),
    "W3161169265": ("1,2", "Thermal goodness of 3D-IC floorplans", "multiple 3D layer floorplans, block powers, proposed metric"),
    "W3109296144": ("1,8", "Dynamic thermal management of a 64-core NoC", "64-core floorplan, Sniper/McPAT power, runtime control"),
    "W3157445859": ("1,2,5", "3D NoC thermal and reliability prediction", "3D NoC floorplans, traffic-derived power, reliability model"),
    "W3086153377": ("1,12", "TSV fault tolerance in a 3D NoC", "3D NoC/router floorplans, TSV model, traffic and fault inputs"),
    "W3036764451": ("1,5", "Thermal-cycling reliability management in a many-core SoC", "many-core floorplan, time-varying power, reliability policy"),
    "W3035869053": ("1", "Spectral vectorless thermal integrity verification", "3D thermal grid, vectorless power bounds, spectral algorithm"),
    "W3021197939": ("1", "TRIC package resistance and impedance calculation", "package-family geometry, parametric detailed thermal models, TRIC solver"),
    "W3006943355": ("1,3,9", "3D stacked-cache thermal control", "stacked-cache floorplan, SPEC power traces, fuzzy controller"),
    "W3001987830": ("1", "Measured static/transient thermal metrics of power devices", "physical device measurements, package/cooling mount, TDIM analysis"),
    "W4206159291": ("2,3", "Alpha EV6 geometry, but FEniCS/POD with 3D structure and pulsed power", "paper's 3D geometry, three pulse inputs, boundary conditions, FEniCS/POD outputs"),
}

with MANIFEST.open(newline="") as stream:
    manifest = list(csv.DictReader(stream))

with OUTPUT.open("w", newline="") as stream:
    writer = csv.DictWriter(stream, fieldnames=[
        "openalex_id", "title", "doi", "pdf_filename", "pdf_pages", "decision",
        "evidence", "required_for_faithful_replication", "reason",
    ])
    writer.writeheader()
    for row in manifest:
        paper_id = row["openalex_id"]
        if row["status"] != "downloaded":
            decision = "source_unavailable"
            pages, evidence, required = "", "PDF not in local corpus", "Obtain and review source PDF"
            reason = row["notes"]
        else:
            pages, evidence, required = REVIEW[paper_id]
            decision = "adapted_pilot_only" if paper_id == "W4206159291" else "unsupported_current_backend"
            reason = ("The processor family is shared, but the paper's geometry, experiment, and output are different" if paper_id == "W4206159291"
                      else "Studio fixes EV6/GCC inputs and cannot run this paper's experiment")
        writer.writerow({
            "openalex_id": paper_id, "title": row["title"], "doi": row["doi"],
            "pdf_filename": row["filename"], "pdf_pages": pages, "decision": decision,
            "evidence": evidence, "required_for_faithful_replication": required, "reason": reason,
        })
with OUTPUT.open(newline="") as stream:
    rows = list(csv.DictReader(stream))
lines = [
    "# HotSpot Studio paper feasibility inventory", "",
    "This is a first-pass compatibility screen against the current fixed EV6 floorplan, GCC power trace, and HotSpot Studio backend. PDF page numbers count from the first PDF page. It does not assert that a paper is irreproducible with an expanded simulator, and it does not establish whether every numeric input is published. Figures and tables need manual review before an exact replication claim.", "",
    "**Result:** 0 exact matches, 1 adapted pilot candidate, 21 unsupported with the current backend, and 9 source PDFs unavailable.", "",
    "| Paper | PDF evidence | Current decision | Needed for faithful replication |", "|---|---|---|---|",
]
for row in rows:
    if not row["pdf_filename"]:
        continue
    source = f'../chip_thermal_management_papers/{row["pdf_filename"]}'
    pages = row["pdf_pages"].replace(",", ", ")
    title = row["title"].replace("|", "\\|")
    lines.append(f'| [{title}]({source}) | pp. {pages}: {row["evidence"]} | `{row["decision"]}` | {row["required_for_faithful_replication"]} |')
lines += ["", "## PDFs absent from the local collection", "",
          "| Paper | DOI |", "|---|---|"]
for row in rows:
    if row["pdf_filename"]:
        continue
    title = row["title"].replace("|", "\\|")
    lines.append(f'| {title} | {row["doi"]} |')
lines += ["", "The CSV contains the machine-readable decision, source filename, page references, required capabilities, and reason for every item in the 31-paper manifest.", ""]
OUTPUT.with_suffix('.md').write_text('\n'.join(lines))
print(OUTPUT)
print(OUTPUT.with_suffix('.md'))
