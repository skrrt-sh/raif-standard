"""Shared pytest fixtures/paths for the raif Python tests."""

from __future__ import annotations

import sys
from pathlib import Path

# Resolve the shared conformance corpus from this test file:
#   packages/py/tests/conftest.py -> packages/py -> packages -> <worktree root>
WORKTREE_ROOT = Path(__file__).resolve().parents[3]
CONFORMANCE_DIR = WORKTREE_ROOT / "conformance"

# Make the dev-only test helpers (raif_bun, _raif_oracle) importable.
sys.path.insert(0, str(Path(__file__).resolve().parent))
