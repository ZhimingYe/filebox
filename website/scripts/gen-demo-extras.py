#!/usr/bin/env python3
"""Seed extra, realistic demo files for docs screenshots (multi-tab shots).

Writes into /tmp/fbx_demo (the `demo` root used by the local Hub+Agent):
  code/qc_pipeline.py       — analysis script (Monaco code preview)
  datasets/qc_runs.csv      — per-replicate QC table (CSV preview)
  notes/run-log.md   — lab notebook entry (Markdown preview)

All content is original synthetic demo material. Stdlib only.
Run after gen-demo-report-pdf.py (which writes the PDF + figures/*.png).
"""
import csv
import os
import random

ROOT = os.environ.get("FBX_DEMO_ROOT", "/tmp/fbx_demo")

QC_PIPELINE = '''#!/usr/bin/env python3
"""QC pipeline for the adaptive recovery assay (synthetic demo).

Reads per-replicate recovery from datasets/qc_runs.csv, applies the
acceptance gate from the methods report (mean >= 80 %, RSD <= 5 %), and
writes a summary table plus the figures used in reports/demo-report.pdf.
"""
from __future__ import annotations

import csv
import statistics as stats
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "datasets" / "qc_runs.csv"
OUT = ROOT / "reports"

TARGET_MEAN = 80.0   # % recovery
MAX_RSD = 5.0        # % relative standard deviation


@dataclass
class RunSummary:
    run: str
    mean: float
    rsd: float
    temp_c: int
    rpm: int

    @property
    def gate(self) -> str:
        if self.mean >= TARGET_MEAN and self.rsd <= MAX_RSD:
            return "PASS"
        if self.mean >= TARGET_MEAN - 1.0:
            return "BORDERLINE"
        return "FAIL"


def load_runs(path: Path = DATA) -> dict[str, list[dict]]:
    runs: dict[str, list[dict]] = {}
    with path.open(newline="") as fh:
        for row in csv.DictReader(fh):
            runs.setdefault(row["run"], []).append(row)
    return runs


def summarize(rows: list[dict]) -> RunSummary:
    values = [float(r["recovery_pct"]) for r in rows]
    mean = stats.fmean(values)
    rsd = 100.0 * stats.stdev(values) / mean if len(values) > 1 else 0.0
    first = rows[0]
    return RunSummary(first["run"], round(mean, 1), round(rsd, 1),
                      int(first["temp_c"]), int(first["rpm"]))


def main() -> None:
    summaries = [summarize(rows) for rows in load_runs().values()]
    OUT.mkdir(exist_ok=True)
    with (OUT / "qc_summary.tsv").open("w") as fh:
        fh.write("run\\tmean\\trsd\\ttemp_c\\trpm\\tgate\\n")
        for s in summaries:
            fh.write(f"{s.run}\\t{s.mean}\\t{s.rsd}\\t{s.temp_c}\\t{s.rpm}\\t{s.gate}\\n")
    passed = sum(s.gate == "PASS" for s in summaries)
    print(f"{passed}/{len(summaries)} runs pass the acceptance gate")


if __name__ == "__main__":
    main()
'''

EXPERIMENT_LOG = """# Experiment log — adaptive recovery assay

**Project:** FBX-DEMO-LAB-2026-10 · **Host:** lab-server · **Operator:** A. Chen (synthetic)

## 2026-10-07 · Batch kinetics (Runs 01–06)

- Inoculated six 12 mL aliquots, three technical replicates each
- OD₆₀₀ every 30 min for 48 h; setpoints alternate 28 °C / 32 °C
- Agitation 180–220 RPM, pH buffered at 6.8 ± 0.2

| Run    | Temp (°C) | RPM | Mean R (%) | Gate       |
|--------|-----------|-----|------------|------------|
| Run-01 | 28        | 180 | 72.4       | FAIL       |
| Run-02 | 32        | 200 | 81.1       | PASS       |
| Run-03 | 28        | 180 | 68.9       | FAIL       |
| Run-04 | 32        | 220 | 88.2       | PASS       |
| Run-05 | 30        | 200 | 79.5       | BORDERLINE |
| Run-06 | 32        | 210 | 84.0       | PASS       |

## Follow-ups

- [x] Regenerate `reports/demo-report.pdf` with the correlation matrix
- [x] Export figures to `figures/` for quick review in filebox
- [ ] Re-prep Run-03 (low mean **and** high RSD)
- [ ] FIXME: rerun Run-05 with seed=7 before sign-off

> Reviewed on the train home from a phone — no laptop, no scp.
"""


def write_csv(path: str) -> None:
    rng = random.Random(42)
    runs = [
        ("Run-01", 72.4, 28, 180), ("Run-02", 81.1, 32, 200), ("Run-03", 68.9, 28, 180),
        ("Run-04", 88.2, 32, 220), ("Run-05", 79.5, 30, 200), ("Run-06", 84.0, 32, 210),
    ]
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["run", "replicate", "temp_c", "rpm", "ph", "od600_48h", "recovery_pct", "operator"])
        for run, mean, temp, rpm in runs:
            for rep in (1, 2, 3):
                w.writerow([
                    run, rep, temp, rpm,
                    f"{6.8 + rng.uniform(-0.2, 0.2):.2f}",
                    f"{0.55 + (mean - 65) / 50 + rng.uniform(-0.04, 0.04):.3f}",
                    f"{mean + rng.uniform(-3.0, 3.0):.1f}",
                    rng.choice(["A. Chen", "R. Okada", "M. Silva"]),
                ])


def main() -> None:
    for sub in ("code", "datasets", "notes"):
        os.makedirs(os.path.join(ROOT, sub), exist_ok=True)
    with open(os.path.join(ROOT, "code", "qc_pipeline.py"), "w") as fh:
        fh.write(QC_PIPELINE)
    write_csv(os.path.join(ROOT, "datasets", "qc_runs.csv"))
    with open(os.path.join(ROOT, "notes", "run-log.md"), "w") as fh:
        fh.write(EXPERIMENT_LOG)
    print("seeded extras under", ROOT)


if __name__ == "__main__":
    main()
