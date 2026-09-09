/**
 * Self-test for the probes. Runs against test/fixture.html, which contains one
 * known instance of each defect plus clean controls that must NOT be reported.
 *
 *   cd ~/Projects/pre-pr-ui-audit && npx playwright test
 *
 * A probe that cannot fire on a page built to trip it will not fire on a real
 * one either, and would ship as silent false assurance.
 */

import { expect, test } from '@playwright/test'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { runProbes, settle } from '../scripts/probes'

const FIXTURE = pathToFileURL(join(__dirname, 'fixture.html')).href

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto(FIXTURE)
  await settle(page)
})

test('every probe fires on the defect it exists to catch', async ({ page }) => {
  const findings = await runProbes(page)
  const byProbe = new Map<string, typeof findings>()
  for (const f of findings) {
    if (!byProbe.has(f.probe)) byProbe.set(f.probe, [])
    byProbe.get(f.probe)!.push(f)
  }

  const expected = [
    'text-clipped-no-affordance',
    'ellipsis-hover-only',
    'heading-clamped',
    'element-outside-clipper',
    'scroll-region-not-focusable',
    'text-overlaps-text',
    'page-horizontal-scroll',
    'target-too-small',
  ]

  const missing = expected.filter((p) => !byProbe.has(p))
  expect(missing, `probes that failed to fire:\n${JSON.stringify(findings, null, 2)}`).toEqual([])
})

test('findings carry the measurement that makes them actionable', async ({ page }) => {
  const findings = await runProbes(page)
  for (const f of findings) {
    expect(Object.keys(f.measured).length, `${f.probe} reported no measurement`).toBeGreaterThan(0)
    expect(f.selector, `${f.probe} reported no selector`).not.toEqual('')
  }
})

test('clean controls are not reported', async ({ page }) => {
  const findings = await runProbes(page)
  const hits = findings.filter((f) => /#ok-/.test(f.selector) || /ok-/.test(String(f.measured.clipper ?? '')))
  expect(hits, `false positives on the clean controls:\n${JSON.stringify(hits, null, 2)}`).toEqual([])
})
