#!/usr/bin/env bash
# run-audit — resolve the touched surfaces, install the spec, run the audit.
#
#   run-audit.sh --repo ~/ADR/changemaker-gcp --base origin/main --ticket DS-13650
#
# Installs into the target repo (idempotent):
#   tests/e2e/accessibility/probes.ts
#   tests/e2e/accessibility/<TICKET>-touched-surfaces.a11y.spec.ts
#   .audit/surfaces.json          (gitignored working file)
#
# The spec is meant to STAY in the PR. The manifest is not.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO=""; BASE="origin/main"; TICKET=""; MAX=25; RUN=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --ticket) TICKET="$2"; shift 2 ;;
    --max) MAX="$2"; shift 2 ;;
    --resolve-only) RUN=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$REPO" ]] || { echo "--repo is required" >&2; exit 2; }
REPO="$(cd "$REPO" && pwd)"
[[ -n "$TICKET" ]] || TICKET="$(git -C "$REPO" rev-parse --abbrev-ref HEAD | grep -oE 'DS-[0-9]+' || echo AUDIT)"

# A stale local base is the single most likely way to get a wrong answer here:
# a base 185 commits behind resolves to every route in the app. Fetch, then
# refuse to guess.
echo "==> fetching $BASE"
git -C "$REPO" fetch --quiet origin "${BASE#origin/}" 2>/dev/null || true
CHANGED=$(git -C "$REPO" diff --name-only "$BASE"...HEAD 2>/dev/null | wc -l | tr -d ' ')
if [[ "$CHANGED" -gt 300 ]]; then
  echo "!! $CHANGED files differ from $BASE. That is almost never one ticket's diff —" >&2
  echo "   check that $BASE is current (git -C $REPO rev-list --count $BASE..origin/main)." >&2
fi

mkdir -p "$REPO/.audit" "$REPO/tests/e2e/accessibility"

echo "==> resolving surfaces (base $BASE)"
node "$HERE/resolve-surfaces.mjs" --repo "$REPO" --base "$BASE" --max "$MAX" --out "$REPO/.audit/surfaces.json"

cp "$HERE/probes.ts" "$REPO/tests/e2e/accessibility/probes.ts"
SPEC="$REPO/tests/e2e/accessibility/${TICKET}-touched-surfaces.a11y.spec.ts"
[[ -f "$SPEC" ]] || cp "$HERE/touched-surfaces.a11y.spec.ts" "$SPEC"
grep -qxF '.audit/' "$REPO/.gitignore" 2>/dev/null || echo '.audit/' >> "$REPO/.gitignore"

echo "==> installed:"
echo "    $SPEC"
echo "    $REPO/tests/e2e/accessibility/probes.ts"

[[ "$RUN" -eq 1 ]] || exit 0

echo "==> running audit"
cd "$REPO"
AUDIT_MANIFEST=.audit/surfaces.json pnpm playwright test --project=accessibility "$SPEC" --reporter=list
