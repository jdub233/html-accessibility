/**
 * axe-run.js — the a11y_check detection payload for the html-accessibility skill.
 *
 * WHAT IT IS: deterministic accessibility detection. Loads axe-core into the
 * current page, runs the full ruleset, and returns a compact, report-ready
 * summary. This is the HTML analogue of pdf-accessibility's pdf_a11y_check.py —
 * facts only, no judgment. The judgment layer (render-and-look over the returned
 * `needsLook` selectors) happens AFTER this, in the model.
 *
 * ONE FUNCTION, BOTH RUNTIMES. `a11yAudit()` loads axe with fetch+eval, which
 * works in Playwright's main world AND the AppleScript extension's isolated
 * world. (A page <script> tag would load axe into the main world only, invisible
 * to the isolated world.) axe is pinned to 4.12.1. Contrast is covered by axe; no separate tool is needed.
 *
 * HOW TO INVOKE
 *   Playwright MCP (preferred): pass a wrapper to browser_evaluate that inlines
 *   these declarations and awaits the audit — browser_evaluate awaits the
 *   promise, so you get the summary in a single call:
 *       async () => { <declarations from this file> ; return await a11yAudit(); }
 *
 *   AppleScript "Control Chrome": execute_javascript is synchronous and will not
 *   await a promise, so kick + poll:
 *       call 1: <declarations> ; a11yAudit().then(r => window.__a11y = r); 'STARTED'
 *       call N: JSON.stringify(window.__a11y || 'PENDING')
 *
 * CAVEAT: fetch() of axe can be blocked by a strict connect-src CSP. Playwright
 * can be launched with bypassCSP to avoid this; on the Chrome path a hardened
 * site may require pre-bundling axe.
 */

const AXE_URL = 'https://cdn.jsdelivr.net/npm/axe-core@4.12.1/axe.min.js';

// Rule ids whose findings essentially always need the render-and-look loop
// (look at the pixels before writing/deciding). Everything in `incomplete` needs
// eyes by definition and is queued regardless of this list.
const LOOK_RULES = new Set([
  'image-alt', 'input-image-alt', 'area-alt', 'object-alt',
  'color-contrast', 'link-name', 'button-name', 'label',
  'target-size' // small/overlapping targets + spacing exceptions want a look
]);

// Rules axe ships DISABLED by default that we deliberately turn on.
//
// axe 4.12.1 is a WCAG 2.0/2.1 engine. The ONLY rule for a net-new 2.2
// criterion is `target-size` (SC 2.5.8 Target Size (Minimum), AA), and it
// ships `enabled: false`. We enable it to inch coverage toward 2.2 and route
// its output through the judgment queue (see LOOK_RULES). This does NOT make
// the skill a 2.2 checker: the other net-new 2.2 AA criteria — 2.4.11 Focus
// Not Obscured, 2.5.7 Dragging Movements, 3.2.6 Consistent Help, 3.3.7
// Redundant Entry, 3.3.8 Accessible Authentication — have NO axe rule at all.
// Reports must state that 2.2 coverage is target-size only.
//
// Deliberately left OFF (the other default-disabled A/AA rules in 4.12.1):
//   - `audio-caption` (1.2.1): not reliably automatable; yields manual-only
//     items a human AT pass covers better.
//   - `aria-roledescription` (4.1.2): niche; low yield on content-authored pages.
// And note: `label-content-name-mismatch` (2.5.3 Label in Name) is ALREADY
// enabled by default in 4.12.1 — no action needed (verified 2026-07).
const ENABLE_RULES = ['target-size'];

// Ensure axe is available in the CURRENT JS world. fetch+eval works in both the
// main world (Playwright) and an isolated world (extension). Returns the version.
async function ensureAxe() {
  if (typeof axe !== 'undefined') return axe.version;
  const src = await fetch(AXE_URL).then(r => r.text());
  (0, eval)(src); // indirect eval → defines `axe` on the current world's global
  return (typeof axe !== 'undefined') ? axe.version : null;
}

// Pure: shape raw axe results into a compact, report-ready structure.
function summarizeAxe(results, opts) {
  opts = opts || {};
  // maxNodes: 0 returns every node (a whole-site report needs each location).
  const maxNodes = opts.maxNodes === 0 ? Infinity : (opts.maxNodes || 10);
  const wcagOf = v => (v.tags || []).filter(t => /^wcag\d/.test(t));
  // axe's evidence for a node: for color-contrast the measured colours and ratio, and for
  // an incomplete node the reason axe could not decide (e.g. 'bgImage', 'bgOverlap').
  const evidenceOf = n => {
    const check = [].concat(n.any || [], n.all || [], n.none || []).find(c => c && c.data) || {};
    const d = check.data;
    if (!d || typeof d !== 'object') return null;
    const keep = ['fgColor', 'bgColor', 'contrastRatio', 'expectedContrastRatio', 'fontSize',
      'fontWeight', 'messageKey'];
    const out = {};
    keep.forEach(k => { if (d[k] !== undefined) out[k] = d[k]; });
    return Object.keys(out).length ? out : null;
  };
  const shapeNode = n => {
    const node = {
      target: n.target,
      html: (n.html || '').slice(0, 200),
      fix: n.failureSummary || null
    };
    if (opts.evidence) {
      node.ancestry = n.ancestry || null;
      node.evidence = evidenceOf(n);
    }
    return node;
  };
  const shape = v => ({
    id: v.id, impact: v.impact, wcag: wcagOf(v),
    help: v.help, helpUrl: v.helpUrl,
    nodeCount: v.nodes.length,
    nodes: v.nodes.slice(0, maxNodes).map(shapeNode)
  });

  // The judgment queue: selectors to screenshot and look at. All `incomplete`
  // nodes, plus violations of rules that need visual confirmation.
  const needsLook = [];
  const addLook = (v, reason) => v.nodes.forEach(n => needsLook.push({
    rule: v.id, reason, wcag: wcagOf(v),
    target: Array.isArray(n.target) ? n.target[0] : n.target
  }));
  results.violations.forEach(v => { if (LOOK_RULES.has(v.id)) addLook(v, 'violation'); });
  results.incomplete.forEach(v => addLook(v, 'incomplete'));

  return {
    url: (typeof location !== 'undefined') ? location.href : null,
    axeVersion: (typeof axe !== 'undefined') ? axe.version : null,
    counts: {
      violations: results.violations.length,
      incomplete: results.incomplete.length,
      passes: results.passes.length,
      inapplicable: results.inapplicable.length
    },
    violations: results.violations.map(shape),
    incomplete: results.incomplete.map(shape),
    needsLook
  };
}

// Load axe (if needed), run the full ruleset against the document, and shape it.
// ENABLE_RULES turns on axe's default-disabled rules we've opted into (see above);
// all other rules run per their defaults.
//
// opts (all optional): maxNodes (default 10; 0 = every node); evidence (true adds each
// node's ancestry selector and axe's contrast data, and runs axe with ancestry on);
// runOnly (passed to axe.run, e.g. a list of rule ids to re-check); resultTypes
// (passed to axe.run; default all four).
async function a11yAudit(opts) {
  opts = opts || {};
  await ensureAxe();
  const ruleConfig = {};
  for (const id of ENABLE_RULES) ruleConfig[id] = { enabled: true };
  const runOptions = {
    resultTypes: opts.resultTypes || ['violations', 'incomplete', 'passes', 'inapplicable'],
    rules: ruleConfig
  };
  if (opts.runOnly) runOptions.runOnly = opts.runOnly;
  if (opts.evidence) runOptions.ancestry = true;
  const results = await axe.run(document, runOptions);
  return summarizeAxe(results, opts);
}

// Node/testing export (ignored in the browser).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AXE_URL, LOOK_RULES, ENABLE_RULES, ensureAxe, summarizeAxe, a11yAudit };
}
