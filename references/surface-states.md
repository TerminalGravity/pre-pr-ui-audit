# Driving surfaces into the states that hide defects

A route sweep covers one state per URL. Defects live in the others.

## Roles and credentials

`tests/config/credentials.ts` reads env with local defaults:

| Manifest role | Credential | Route shape |
|---|---|---|
| `platformAdmin` | `PLATFORM_ADMIN_EMAIL` | `/admin/**` — the platform console |
| `admin` | `WORKSPACE_ADMIN_EMAIL` | `/w/[slug]/admin/**` |
| `manager` | `MANAGER_EMAIL` | `/w/[slug]/manager/**` |
| `participant` | `PARTICIPANT_EMAIL` | `/w/[slug]/participant/**` |
| `client` | `CLIENT_VIEWER_EMAIL` (often unset) | `/w/[slug]/client/**` |
| `public` | none | everything else |

`/admin/**` and `/w/[slug]/admin/**` are **different consoles with different roles**.
Conflating them is what left the platform-admin routes unscanned. The resolver keys off the
prefix; check the role on any surface whose result looks surprising.

Login: `loginWithCredentials(page, email)` from `tests/e2e/support/auth.ts`. On mobile
viewports use `mobileLogin` from `tests/e2e/mobile/_support.ts` — `fill()` races React's
controlled-input `onChange` under `isMobile + hasTouch`, leaving submit disabled.

A `client` role with no credential is skipped by the spec. **Skips are not passes** — say so
in the PR rather than counting the surface as covered.

## Overlays

Flagged `opens` when the changed files import a Dialog/Sheet/Popover/DropdownMenu/
AlertDialog/Drawer/Command/Select trigger.

The spec's `openOverlay` walks up to 12 visible buttons, skipping anything matching
`delete|remove|deactivate|archive|sign out|log out|send|submit|save|confirm|publish|invite`,
and stops at the first `[role="dialog"|"menu"|"listbox"]` that appears. It probes that
overlay and presses Escape.

That heuristic reaches one overlay per surface. When a surface owns several — or the one
that matters is behind a specific control — drive it by hand:

```ts
await page.getByRole('button', { name: 'Create Workspace' }).click()
await expect(page.getByRole('dialog')).toBeVisible()
await settle(page)
const findings = await runProbes(page)
```

Multi-step overlays need every step probed. DS-13634's failing pills were the *active* and
*upcoming* states of a step indicator — visiting step 1 only would have found the completed
pill, which was the one already fixed.

## Seeded data

Flagged `seeds` when the changed files contain a data-gated branch. The empty tree and the
populated tree are different pages, and the empty one is what a fresh workspace renders.

Seed via `tests/helpers/factories`:

```ts
import { createTestChallenge, createTestSubmission, createTestEnrollment } from '../../helpers/factories'
```

Cases worth seeding explicitly, all from returned tickets:

- **A count badge.** Renders only above zero. DS-13634's 1.72:1 badge needed a non-empty
  review queue. Seed a pending submission.
- **A list past its container.** DS-13630's preview only overflows past ~25 rows; below that
  the scroll container never scrolls, so `scrollable-region-focusable` cannot fire.
- **A long value.** Truncation needs something long enough to truncate. DS-13560 needed a
  workspace whose name overflowed the chip; a short name passes cleanly and proves nothing.
- **Both arms.** Empty states are UI too — an empty state with no heading and 2.6:1 helper
  text is a real finding.

Set `AUDIT_SEEDED=1` once the populated branch actually renders. Setting it without seeding
converts a `[coverage]` failure into a false pass, which is worse than the original gate.

## Widths

`320 / 375 / 1440` always, plus `(bp − 1, bp)` for every Tailwind prefix on an added line.

320 is the WCAG 1.4.10 floor (1280 at 400% zoom). Tailwind: `sm` 640, `md` 768, `lg` 1024,
`xl` 1280, `2xl` 1536.

Test the pair, never the middle. A responsive bug is a boundary bug: DS-13606 was correct at
767 and wrong at 768, and any width sampled between breakpoints would have passed.

## What to do with a finding

Report the measurement, the file and class, and the one-line fix — the shape QA uses, and
the reason their findings are actionable on sight:

> `app/w/[slug]/admin/settings/catalog/page.tsx` — card twin renders Shipping `No` as
> `text-gray-400` (#99a1af on #ffffff = 2.60:1). WCAG 2.1 AA requires 4.5:1 for 16px normal
> text. axe: `color-contrast` (serious), 5 nodes. Change to `text-gray-500` (#6b7280 =
> 4.83:1).

Mark preexisting findings as preexisting. They still get reported — one found and not
mentioned comes back with your ticket number on it.
