#!/usr/bin/env python3
"""Repeat the matched comparison in isolated browsers, with a hard time budget.

Usage: python3 demo/compare.py [--updates]
Requires an existing dist build and an installed Chromium-family browser.
Writes the measured record to docs/benchmarks/points-500k.json.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent
PROFILES = [
    ("maplet-webgl1", "comparison:maplet", []),
    ("leaflet-canvas", "comparison:leaflet-canvas", []),
    ("maplet-webgpu", "comparison:maplet", ["--webgpu"]),
    ("leaflet-dom", "comparison:leaflet-dom", []),
]
TIMEOUT_SECONDS = 120


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--updates', action='store_true', help='measure validated single-point visibility, color and position changes')
    parser.add_argument('--no-dom', action='store_true', help='compare the completed GPU/Canvas profiles without the known DOM timeout runs')
    parser.add_argument('--output', type=Path, help='write a separate before/after record instead of replacing the published baseline')
    args = parser.parse_args()
    report = {
        "measuredAtUtc": datetime.now(timezone.utc).isoformat(),
        "mode": "updates" if args.updates else "setup-and-pan",
        "workload": {"points": 500000, "viewportCssPx": [720, 520], "zoom": 10,
                     "radiusCssPx": 2, "color": "#2563eb", "interactive": True,
                     "coldPanMs": 2500, "warmupPanMs": 5000, "measuredWarmPanMs": 10000},
        "repetitions": 3,
        "processBudgetSeconds": TIMEOUT_SECONDS,
        "runs": [],
    }
    if args.updates:
        report['workload']['mutations'] = {"repetitionsPerOperation": 5, "radiusCssPx": 8,
                                          "operations": ["hide", "show", "color", "position"], "moveCssPx": 40}
    for repetition in range(1, 4):
        for profile, scenario, extra in PROFILES:
            if args.no_dom and profile == 'leaflet-dom':
                continue
            if args.updates:
                if profile == 'leaflet-dom':
                    continue  # No successful full-scene DOM setup within the budget.
                scenario = scenario.replace('comparison:', 'comparison-updates:')
            print(f"{profile}, repetition {repetition}", flush=True)
            command = ["node", "demo/e2e/runner.mjs", "--scenario", scenario, "--verbose", *extra]
            started = time.monotonic()
            process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, text=True, start_new_session=True)
            timed_out = False
            try:
                output, _ = process.communicate(timeout=TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                timed_out = True
                # Terminate only the process group created for this run, including
                # its browser/server children, rather than leaking a blocked browser.
                os.killpg(process.pid, signal.SIGKILL)
                output, _ = process.communicate()
            checks = []
            for line in output.splitlines():
                if line.strip().startswith(("ok ", "FAIL ", "updates-result —")) and " — {" in line:
                    checks.append(json.loads(line.split(" — ", 1)[1]))
            entry = {"profile": profile, "repetition": repetition,
                     "elapsedSeconds": round(time.monotonic() - started, 2),
                     "status": "timeout" if timed_out else "pass" if process.returncode == 0 else "fail",
                     "measurements": checks}
            expected_records = 1 if args.updates else 2
            if entry['status'] == 'pass' and len(checks) != expected_records:
                entry['status'] = 'fail'
                entry['error'] = f'Expected {expected_records} measurement records, got {len(checks)}'
            report["runs"].append(entry)
            print(json.dumps(entry), flush=True)
    destination = args.output or ROOT / "docs" / "benchmarks" / ("points-500k-updates.json" if args.updates else "points-500k.json")
    destination.parent.mkdir(exist_ok=True)
    destination.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Results: {destination}", flush=True)
    if any(run["status"] == "fail" for run in report["runs"]):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
