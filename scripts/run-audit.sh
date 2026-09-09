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
REPO=""; BASE="origin/main"; TICKET=""; MAX=25; RUN=1; BASE_URL_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --ticket) TICKET="$2"; shift 2 ;;
    --max) MAX="$2"; shift 2 ;;
    --base-url) BASE_URL_ARG="$2"; shift 2 ;;
    --resolve-only) RUN=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$REPO" ]] || { echo "--repo is required" >&2; exit 2; }
REPO="$(cd "$REPO" && pwd)"
[[ -n "$TICKET" ]] || TICKET="$(git -C "$REPO" rev-parse --abbrev-ref HEAD | grep -oE 'DS-[0-9]+' || echo AUDIT)"

# ---------------------------------------------------------------------------
# Which server am I auditing?
#
# Every worktree runs its own dev server on its own port, so there is no single
# right default. Worse, `.env` files carry a stale BASE_URL="http://localhost:3000"
# alongside a correct NEXT_PUBLIC_APP_URL="http://localhost:3561" — trusting
# BASE_URL, or silently falling back to 3000, audits whichever *other* worktree
# happens to be serving there and reports the result under this ticket's name.
#
# So: resolve from the worktree's own env, then prove the thing listening is
# this checkout. Refuse rather than guess.
# ---------------------------------------------------------------------------
resolve_base_url() {
  if [[ -n "$BASE_URL_ARG" ]]; then echo "$BASE_URL_ARG"; return; fi
  if [[ -n "${BASE_URL:-}" ]]; then echo "$BASE_URL"; return; fi
  local env="$REPO/.env.local"; [[ -f "$env" ]] || env="$REPO/.env"
  if [[ -f "$env" ]]; then
    # NEXT_PUBLIC_APP_URL and NEXTAUTH_URL track the real dev port; BASE_URL does not.
    local url
    url="$(grep -hoE '^(NEXT_PUBLIC_APP_URL|NEXTAUTH_URL)="?http://localhost:[0-9]+' "$env" 2>/dev/null \
           | head -1 | grep -oE 'http://localhost:[0-9]+')"
    [[ -n "$url" ]] && { echo "$url"; return; }
    local port
    port="$(grep -hoE '^PORT=[0-9]+' "$env" 2>/dev/null | head -1 | cut -d= -f2)"
    [[ -n "$port" ]] && { echo "http://localhost:$port"; return; }
  fi
  echo ""
}

verify_server() {
  local url="$1" port pid cwd title
  port="${url##*:}"

  pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  if [[ -z "$pid" ]]; then
    echo "!! Nothing is listening on $url" >&2
    echo "   Start this worktree's dev server first:  (cd $REPO && PORT=$port pnpm dev)" >&2
    return 1
  fi

  # The decisive check: is the process serving this port running from THIS
  # checkout? A port collision with another worktree is otherwise invisible.
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2- | head -1)"
  if [[ -n "$cwd" && "$cwd" != "$REPO"* ]]; then
    echo "!! $url is served by a process running from:" >&2
    echo "     $cwd" >&2
    echo "   but this audit targets:" >&2
    echo "     $REPO" >&2
    echo "   Auditing another worktree's build under this ticket is exactly the mistake" >&2
    echo "   this gate exists to catch. Start this worktree's server, or pass --base-url." >&2
    return 1
  fi

  title="$(curl -s --max-time 15 "$url/" | grep -io '<title>[^<]*</title>' | head -1)"
  if ! grep -qi 'changemaker' <<<"$title"; then
    echo "!! $url is listening but does not look like Changemaker (title: ${title:-none})" >&2
    return 1
  fi

  echo "==> auditing $url  (pid $pid, cwd ${cwd:-unknown})"
}

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

# A standalone config for the audit run, written into the gitignored .audit/ dir.
#
# It exists so the audit can use installed Chrome via AUDIT_CHANNEL. The repo's
# own config pins a Playwright-managed Chromium, and `playwright install` is a
# multi-hundred-MB download that fails often enough on a laptop connection to
# block the gate entirely. These probes are DOM geometry plus axe — any
# Chromium-family engine gives the same answer.
cat > "$REPO/.audit/playwright.audit.config.ts" <<'CONFIG'
import { defineConfig, devices } from '@playwright/test'

const channel = process.env.AUDIT_CHANNEL

export default defineConfig({
  testDir: '../tests/e2e/accessibility',
  globalSetup: '../tests/setup/global-setup.ts',
  globalTeardown: '../tests/setup/global-teardown.ts',
  outputDir: '../test-results',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    ...devices['Desktop Chrome'],
    ...(channel ? { channel } : {}),
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'accessibility', testMatch: '**/*.a11y.spec.ts' }],
})
CONFIG

echo "==> installed:"
echo "    $SPEC"
echo "    $REPO/tests/e2e/accessibility/probes.ts"

[[ "$RUN" -eq 1 ]] || exit 0

RESOLVED_URL="$(resolve_base_url)"
if [[ -z "$RESOLVED_URL" ]]; then
  echo "!! Could not determine which server to audit." >&2
  echo "   No NEXT_PUBLIC_APP_URL / NEXTAUTH_URL / PORT in $REPO/.env — pass --base-url." >&2
  echo "   Not defaulting to :3000: another worktree is probably serving there, and a" >&2
  echo "   green result against the wrong build is worse than no result." >&2
  exit 1
fi
verify_server "$RESOLVED_URL" || exit 1

echo "==> running audit"
cd "$REPO"
BASE_URL="$RESOLVED_URL" AUDIT_MANIFEST=.audit/surfaces.json \
  pnpm playwright test --config .audit/playwright.audit.config.ts "$SPEC" --reporter=list
