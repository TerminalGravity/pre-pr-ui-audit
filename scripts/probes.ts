/**
 * probes — the layout failures axe-core structurally cannot report.
 *
 * axe checks the accessibility tree and computed colour. It has no rule for
 * "this text is cut off", "this heading is clamped", "this chip is painted over
 * that title", or "the only way to read the full value is a hover tooltip".
 * Every one of those shipped through a green axe gate and came back from QA.
 *
 * These probes run in the page and return structured findings. They are
 * deliberately conservative: each one reports a measured geometric fact, not a
 * guess, so a finding can be pasted into a ticket with its numbers.
 *
 * Companion to axe, never a replacement. Run both on every surface.
 */

import type { Page } from '@playwright/test'

export interface Finding {
  probe: string
  wcag: string | null
  selector: string
  text: string
  detail: string
  measured: Record<string, number | string | boolean>
}

/** Freeze animation so measurements are taken against a settled layout. */
export async function settle(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
  await page.waitForLoadState('networkidle').catch(() => {})
  // Fonts must be settled before any width is measured — a fallback face
  // changes every text advance, which is the difference between "clipped" and
  // "fits" on exactly the elements these probes judge.
  await page.evaluate(async () => {
    await document.fonts?.ready
    return true
  })
}

export async function runProbes(page: Page): Promise<Finding[]> {
  return page.evaluate(() => {
    const findings: any[] = []

    // ---- helpers ---------------------------------------------------------

    const cssPath = (el: Element): string => {
      const parts: string[] = []
      let cur: Element | null = el
      while (cur && cur.nodeType === 1 && parts.length < 4) {
        let part = cur.tagName.toLowerCase()
        const testid = cur.getAttribute('data-testid')
        if (testid) {
          parts.unshift(`[data-testid="${testid}"]`)
          break
        }
        if (cur.id) {
          parts.unshift(`#${cur.id}`)
          break
        }
        const cls = (cur.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3)
        if (cls.length) part += '.' + cls.join('.')
        parts.unshift(part)
        cur = cur.parentElement
      }
      return parts.join(' > ')
    }

    const label = (el: Element) => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)

    const visible = (el: Element) => {
      const s = getComputedStyle(el)
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }

    /**
     * True when the element is scrolled out of the box that clips it.
     *
     * Such an element still reports a laid-out rect, so a naive geometry compare
     * "sees" it colliding with whatever sits below the container. Without this
     * check the overlap probe reports every scroll list against its next
     * sibling — a false positive the fixture caught on the first run.
     */
    const clippedOutOfView = (el: Element): boolean => {
      const r = el.getBoundingClientRect()
      let p = el.parentElement
      while (p && p !== document.body) {
        const s = getComputedStyle(p)
        if (s.overflow !== 'visible' || s.overflowY !== 'visible' || s.overflowX !== 'visible') {
          const c = p.getBoundingClientRect()
          if (r.bottom <= c.top + 1 || r.top >= c.bottom - 1 || r.right <= c.left + 1 || r.left >= c.right - 1) {
            return true
          }
        }
        p = p.parentElement
      }
      return false
    }

    /** Elements whose own text is what gets clipped (no element children carrying it). */
    const hasOwnText = (el: Element) =>
      Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 0)

    const all = Array.from(document.querySelectorAll<HTMLElement>('body *')).filter(visible)

    const report = (f: any) => {
      if (findings.length < 200) findings.push(f)
    }

    // ---- 1. text cut mid-glyph: clipped with no ellipsis, no wrap --------
    // DS-13630: the bulk-invite preview rendered "Participa|" at 1440px —
    // 576px of content in a 473px box, overlay scrollbars hidden, so nothing
    // told the admin more existed. DS-13634 A/C: the "2 customized" chip and
    // the "Settings" tab label, both cut at a card edge.
    for (const el of all) {
      if (!hasOwnText(el)) continue
      const s = getComputedStyle(el)
      const clipped = s.overflow === 'hidden' || s.overflowX === 'hidden' || s.textOverflow === 'clip'
      if (!clipped) continue
      const over = el.scrollWidth - el.clientWidth
      if (over <= 1) continue
      if (s.textOverflow === 'ellipsis') continue // reported by probe 2 instead
      report({
        probe: 'text-clipped-no-affordance',
        wcag: '1.4.10 Reflow',
        selector: cssPath(el),
        text: label(el),
        detail:
          'Text is wider than its box and the overflow is hidden with no ellipsis, no wrap ' +
          'and no scrollbar — the reader is given no signal that content is missing.',
        measured: { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, hiddenPx: over },
      })
    }

    // ---- 2. ellipsis whose full value is hover-only ----------------------
    // DS-13634 DA-3: the breadcrumb ellipsised the challenge title and put the
    // full value in `title`. `title` never fires on touch, and the H1 below was
    // clamped too, so on a phone the page's own subject was unreadable.
    for (const el of all) {
      const s = getComputedStyle(el)
      if (s.textOverflow !== 'ellipsis') continue
      if (el.scrollWidth - el.clientWidth <= 1) continue // ellipsis declared but not active
      const hasTitle = el.hasAttribute('title') || !!el.closest('[title]')
      const expandable =
        el.matches('a, button, [role="button"], [role="link"], summary') ||
        !!el.querySelector('a, button, [role="button"]') ||
        !!el.closest('a, button, [role="button"], summary')
      if (expandable) continue // reachable another way
      report({
        probe: hasTitle ? 'ellipsis-hover-only' : 'ellipsis-no-full-value',
        wcag: '1.4.10 Reflow',
        selector: cssPath(el),
        text: label(el),
        detail: hasTitle
          ? 'Truncated text whose full value exists only in a `title` attribute. `title` has no ' +
            'touch equivalent, so on a phone or tablet the full value is unreachable.'
          : 'Truncated text with no full value available anywhere — not in a title, not behind a control.',
        measured: { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, hasTitle },
      })
    }

    // ---- 3. line-clamp actually truncating -------------------------------
    // DS-13634 DA-4: the challenge page H1 is line-clamp-2. The page's primary
    // identifier was never fully readable at 375 or 768.
    for (const el of all) {
      const s = getComputedStyle(el) as any
      const clamp = s.webkitLineClamp || s['-webkit-line-clamp']
      if (!clamp || clamp === 'none') continue
      const over = el.scrollHeight - el.clientHeight
      if (over <= 1) continue
      const isHeading = /^H[1-6]$/.test(el.tagName) || el.getAttribute('role') === 'heading'
      report({
        probe: isHeading ? 'heading-clamped' : 'text-clamped',
        wcag: '1.4.10 Reflow',
        selector: cssPath(el),
        text: label(el),
        detail: isHeading
          ? 'A heading is line-clamped and is currently truncating. A page whose own H1 is cut ' +
            'short has lost its primary identifier at this width.'
          : 'Line-clamped text is truncating with no expand control.',
        measured: { lineClamp: String(clamp), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
      })
    }

    // ---- 4. element painted outside the box that clips it ----------------
    // DS-13560: an oversized workspace chip painted over the card title and
    // pushed the action buttons off-screen. DS-13586: the catalog table ran
    // ~17px past its pane, clipping both action buttons.
    const clipperOf = (el: Element): HTMLElement | null => {
      let p = el.parentElement
      while (p && p !== document.body) {
        const s = getComputedStyle(p)
        if (s.overflow !== 'visible' || s.overflowX !== 'visible' || s.overflowY !== 'visible') return p
        p = p.parentElement
      }
      return null
    }
    for (const el of all) {
      const clipper = clipperOf(el)
      if (!clipper) continue
      const r = el.getBoundingClientRect()
      const c = clipper.getBoundingClientRect()
      const overRight = r.right - c.right
      const overLeft = c.left - r.left
      if (overRight <= 1 && overLeft <= 1) continue
      // A scroll container that is keyboard-reachable is a legitimate pattern.
      const scrollable = clipper.scrollWidth > clipper.clientWidth + 1
      const reachable = clipper.hasAttribute('tabindex') || !!clipper.querySelector('a, button, input, select, textarea, [tabindex]')
      if (scrollable && reachable) continue
      report({
        probe: 'element-outside-clipper',
        wcag: '1.4.10 Reflow',
        selector: cssPath(el),
        text: label(el),
        detail:
          'Element extends past the edge of the ancestor that clips it, and that ancestor is ' +
          'not a keyboard-reachable scroll region — the overflowing part cannot be brought into view.',
        measured: {
          overflowRightPx: Math.round(Math.max(0, overRight)),
          overflowLeftPx: Math.round(Math.max(0, overLeft)),
          clipper: cssPath(clipper),
        },
      })
    }

    // ---- 5. scroll region no keyboard user can scroll --------------------
    // DS-13630 DA-1: four max-h-72 overflow-auto containers, none focusable and
    // none containing a focusable child. axe reports this as
    // scrollable-region-focusable — but only once the container actually
    // overflows, which needs seeded data. The gate never seeded any.
    for (const el of all) {
      const s = getComputedStyle(el)
      const scrolls =
        (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1) ||
        (/(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1)
      if (!scrolls) continue
      const focusable = el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1'
      const hasFocusableChild = !!el.querySelector(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (focusable || hasFocusableChild) continue
      report({
        probe: 'scroll-region-not-focusable',
        wcag: '2.1.1 Keyboard',
        selector: cssPath(el),
        text: label(el),
        detail:
          'A scrollable region with no tabindex and no focusable descendant. A keyboard-only ' +
          'user cannot scroll it, so its hidden content is unreachable. Fix: tabindex="0" ' +
          'plus role="region" and an aria-label.',
        measured: {
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        },
      })
    }

    // ---- 6. text painted over text ---------------------------------------
    // DS-13634 DA-5: the progress ring's COMPLETE label rendered through the
    // ring stroke — 57px of label centred in a 64px ring, cut at both sides.
    // Rects are cached in one pass: reading getBoundingClientRect inside the
    // O(n^2) compare forces a layout per call and turns a 400-element page into
    // a multi-second probe.
    const textEls = all
      .filter((el) => hasOwnText(el) && label(el).length > 0 && !clippedOutOfView(el))
      .slice(0, 600)
    const rects = textEls.map((el) => el.getBoundingClientRect())
    for (let i = 0; i < textEls.length; i++) {
      for (let j = i + 1; j < textEls.length; j++) {
        const a = textEls[i]
        const b = textEls[j]
        const ra = rects[i]
        const rb = rects[j]
        // Cheap rejection before the expensive containment check.
        if (ra.right <= rb.left || rb.right <= ra.left || ra.bottom <= rb.top || rb.bottom <= ra.top) continue
        if (a.contains(b) || b.contains(a)) continue
        const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
        const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
        if (ox <= 2 || oy <= 2) continue
        // Only report a substantial overlap of both boxes — decorative
        // backdrops routinely share a few pixels.
        const frac = (ox * oy) / Math.min(ra.width * ra.height, rb.width * rb.height)
        if (frac < 0.5) continue
        report({
          probe: 'text-overlaps-text',
          wcag: '1.4.10 Reflow',
          selector: cssPath(a),
          text: `${label(a)} / ${label(b)}`,
          detail: 'Two separate text elements occupy the same space — one is rendering through the other.',
          measured: { overlapPx: Math.round(ox * oy), fraction: Number(frac.toFixed(2)), other: cssPath(b) },
        })
      }
    }

    // ---- 7. page-level horizontal scroll ---------------------------------
    const root = document.documentElement
    if (root.scrollWidth > root.clientWidth + 1) {
      report({
        probe: 'page-horizontal-scroll',
        wcag: '1.4.10 Reflow',
        selector: 'html',
        text: '',
        detail: 'The page scrolls horizontally. Reflow forbids two-dimensional scrolling down to 320px.',
        measured: { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth },
      })
    }

    // ---- 8. target size (WCAG 2.5.8 AA, 24x24 minimum) -------------------
    for (const el of all) {
      if (!el.matches('a[href], button, [role="button"], input[type="checkbox"], input[type="radio"], [role="tab"]')) continue
      const r = el.getBoundingClientRect()
      if (r.width >= 24 && r.height >= 24) continue
      if (clippedOutOfView(el)) continue
      // 2.5.8 exempts targets in a sentence or block of text. A link laid out
      // inline is that case by definition — reporting it flags ordinary body
      // copy, which the fixture caught as a false positive on a 217x18 link.
      if (el.tagName === 'A' && /^inline$/.test(getComputedStyle(el).display)) continue
      report({
        probe: 'target-too-small',
        wcag: '2.5.8 Target Size (Minimum)',
        selector: cssPath(el),
        text: label(el),
        detail: 'Interactive target is smaller than the 24x24 CSS-pixel minimum.',
        measured: { width: Math.round(r.width), height: Math.round(r.height) },
      })
    }

    return findings
  })
}

/**
 * Contrast against gradients and translucent layers.
 *
 * axe reports text over a `linear-gradient` as *incomplete*, never a violation,
 * because it cannot resolve one backdrop pixel — so a full axe run waves it
 * through. changemaker-gcp already carries a gradient-aware walker at
 * tests/e2e/mobile/accessibility/challenge-contrast.spec.ts (DS-13183), written
 * after a QA pass found six sub-AA elements a green axe run had passed.
 *
 * Use that one in-repo rather than duplicating it here; this note exists so the
 * omission reads as deliberate. Run it on any surface whose diff touches a
 * gradient, a translucent `bg-` opacity utility, or a backdrop-blur.
 */
export const GRADIENT_CONTRAST_SPEC =
  'tests/e2e/mobile/accessibility/challenge-contrast.spec.ts'
