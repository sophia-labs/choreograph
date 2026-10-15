#!/usr/bin/env bash
set -euo pipefail

# Nothing to prepare: Chromium ships in the Playwright image, and the Camoufox
# engine (whose binary this script used to fetch) was removed on 2026-10-13.
# Kept as a no-op because units installed from older releases still run it as
# ExecStartPre through /opt/choreograph/current.
echo "No browser engines to prepare (Chromium ships in the Playwright image)"
