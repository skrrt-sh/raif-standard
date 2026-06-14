"""Dev-only bridge to the canonical TypeScript RAIF implementation via `bun`.

Used ONLY by the differential test (`test_differential.py`) as an oracle; `bun`
is never a runtime or install dependency of the `raif` package.

The caller supplies a bun script (which reads its JSON input from the file named
by the `RAIF_BRIDGE_INPUT` env var) and a payload; `run_bridge` handles the temp
file, the subprocess, and parsing stdout back to JSON.

The TypeScript reference lives in the monorepo at `packages/js/src/raif.ts`. The
JS directory resolves to `packages/js` from this file, and can be overridden
with the `RAIF_JS_DIR` env var.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

# Resolve from THIS file so the bridge works regardless of the caller's cwd:
#   packages/py/tests/raif_bun.py -> packages/py -> packages -> <root>/packages/js
_DEFAULT_JS_DIR = Path(__file__).resolve().parents[2] / "js"
RAIF_JS_DIR = Path(os.environ.get("RAIF_JS_DIR", str(_DEFAULT_JS_DIR)))

# Env var the caller's bun script reads to find its JSON input file.
INPUT_ENV = "RAIF_BRIDGE_INPUT"


def available() -> bool:
    """True when both `bun` and the in-repo TS reference are present."""
    return (
        shutil.which("bun") is not None and (RAIF_JS_DIR / "src" / "raif.ts").exists()
    )


def run_bridge(script: str, payload, timeout: float) -> list:
    """Run `bun -e <script>` against `payload` (written to a temp file the script
    reads via `RAIF_BRIDGE_INPUT`) and return the JSON list it writes to stdout.

    All failure paths (startup error, non-zero exit, timeout, invalid/non-list
    output) raise RuntimeError, so callers see one stable failure type."""
    fd, tmp = tempfile.mkstemp(suffix=".json", prefix="raif_bun_")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f)
        try:
            res = subprocess.run(
                ["bun", "-e", script],
                capture_output=True,
                cwd=RAIF_JS_DIR,
                timeout=timeout,
                env={**os.environ, INPUT_ENV: tmp},
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"bun bridge timed out after {timeout}s") from exc
        except OSError as exc:
            # bun missing / RAIF_JS_DIR invalid — covers FileNotFoundError.
            raise RuntimeError(f"bun bridge could not start: {exc}") from exc
    finally:
        os.unlink(tmp)
    if res.returncode != 0:
        raise RuntimeError(
            f"bun bridge failed: {res.stderr.decode('utf-8', 'replace')[:1000]}"
        )
    try:
        out = json.loads(res.stdout.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError("bun bridge returned invalid JSON") from exc
    if not isinstance(out, list):
        raise RuntimeError("bun bridge must return a JSON list")
    return out
