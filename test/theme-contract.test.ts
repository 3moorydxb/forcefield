import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contrast,
  validateTheme,
  assertTheme,
  ThemeError,
  themes,
  themeByName,
  type Theme,
  type NodeStyle,
  type LinkStyle,
} from '../themes/index.js';
import { darkTheme as darkFromSrc } from '../src/index.js';
import { darkTheme as darkFromThemes } from '../themes/index.js';

/**
 * These tests exist because the whole point of `themes/` is a contribution
 * surface a stranger can add to — so the contract that guards it needs its own
 * coverage, not just "the shipped themes happen to pass".
 */

function baseTheme(overrides: Partial<Theme> = {}): Theme {
  // A theme that starts from a known-good shape (dark's numbers, renamed) so
  // each broken-theme test below can override exactly one field and be sure
  // every OTHER rule still passes — otherwise a test asserting "fails ONLY
  // rule X" could actually be failing on rule Y too and nobody would notice.
  return {
    name: 'test-base',
    background: '#1a1a19',
    ink: { primary: '#ffffff', secondary: '#c3c2b7', muted: '#898781' },
    palette: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
    other: '#898781',
    link: { color: '#3a3a37', active: '#c3c2b7' },
    selection: '#ffffff',
    hover: '#c3c2b7',
    pin: '#c3c2b7',
    label: '#c3c2b7',
    labelHalo: '#1a1a19',
    dimOpacity: 0.16,
    ...overrides,
  };
}

function onlyRule(problems: { rule: string }[]): string {
  const rules = new Set(problems.map((p) => p.rule));
  assert.equal(rules.size, 1, `expected exactly one distinct rule to fail, got ${JSON.stringify([...rules])}`);
  return [...rules][0]!;
}

// -------------------------------------------------------- shipped themes

test('every shipped theme passes validateTheme with zero problems', () => {
  for (const t of themes) {
    const problems = validateTheme(t);
    assert.deepEqual(
      problems,
      [],
      `theme "${t.name}" has ${problems.length} problem(s):\n${problems.map((p) => `  [${p.rule}] ${p.field}: ${p.detail}`).join('\n')}`,
    );
  }
});

// -------------------------------------------------------------- contrast()

test('contrast() matches known WCAG values', () => {
  assert.equal(contrast('#000000', '#ffffff'), 21);
  assert.equal(contrast('#ffffff', '#000000'), 21, 'order must not matter');
  assert.equal(contrast('#3987e5', '#3987e5'), 1, 'a colour against itself is 1');
  assert.equal(contrast('#1a1a19', '#1a1a19'), 1);
});

test('contrast() throws a clear error on an unparseable colour', () => {
  assert.throws(() => contrast('blue', '#000000'), /not a #rgb/);
  assert.throws(() => contrast('#12345', '#000000'), /not a #rgb/);
});

// ------------------------------------------------------------- R1..R7, one at a time

test('R1 palette-shape: fewer than 3 entries fails only R1', () => {
  const t = baseTheme({ palette: ['#3987e5', '#d95926'] });
  const problems = validateTheme(t);
  assert.ok(problems.length > 0, 'expected at least one problem');
  assert.equal(onlyRule(problems), 'R1 palette-shape');
});

test('R1 palette-shape: a duplicate entry fails only R1', () => {
  const t = baseTheme({
    palette: ['#3987e5', '#3987e5', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  });
  const problems = validateTheme(t);
  assert.equal(onlyRule(problems), 'R1 palette-shape');
  assert.ok(problems.some((p) => /duplicate/.test(p.detail)));
});

test('R2 readable text: a low-contrast label fails only R2', () => {
  // #2a2a28 sits close to the #1a1a19 background (contrast ~1.2, well under
  // the 4.5:1 floor). labelHalo is moved to white so label-vs-halo (R3) stays
  // comfortably above its own 4.5:1 floor — otherwise, since the base theme's
  // labelHalo equals its background, a low-contrast label would trip R3 too
  // and this test would not isolate R2 at all.
  const t = baseTheme({ label: '#2a2a28', labelHalo: '#ffffff' });
  const problems = validateTheme(t);
  assert.equal(onlyRule(problems), 'R2 readable text');
});

test('R3 the fallback channel survives: label unreadable over its own halo fails only R3', () => {
  // Background and labelHalo both stay put; only labelHalo moves close to the
  // label colour itself, so label-vs-background (R2) still passes but
  // label-vs-labelHalo (R3) does not.
  const t = baseTheme({ labelHalo: '#c9c8be' }); // close to label #c3c2b7
  const problems = validateTheme(t);
  assert.equal(onlyRule(problems), 'R3 the fallback channel survives');
});

test('R4 state chrome is visible: a low-contrast selection ring fails only R4', () => {
  const t = baseTheme({ selection: '#252523' }); // near-invisible against #1a1a19
  const problems = validateTheme(t);
  assert.equal(onlyRule(problems), 'R4 state chrome is visible');
});

test('R5 nothing is invisible: a too-dark palette slot fails only R5', () => {
  const t = baseTheme({
    palette: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#1c1c1a', '#9085e9', '#e66767'],
  });
  const problems = validateTheme(t);
  assert.equal(onlyRule(problems), 'R5 nothing is invisible');
});

test('R6 dimming is not disappearing: dimOpacity outside [0.05, 0.6] fails only R6', () => {
  const tooLow = validateTheme(baseTheme({ dimOpacity: 0.01 }));
  assert.equal(onlyRule(tooLow), 'R6 dimming is not disappearing');

  const tooHigh = validateTheme(baseTheme({ dimOpacity: 0.9 }));
  assert.equal(onlyRule(tooHigh), 'R6 dimming is not disappearing');

  const notFinite = validateTheme(baseTheme({ dimOpacity: NaN }));
  assert.equal(onlyRule(notFinite), 'R6 dimming is not disappearing');
});

test('R7 state is never colour alone: two nodeStyles differing ONLY in fill fails only R7', () => {
  const nodeStyles: NodeStyle[] = [
    { fill: '#111111', shape: 'circle' },
    { fill: '#222222', shape: 'circle' },
  ];
  const t = baseTheme({ nodeStyles });
  const problems = validateTheme(t);
  assert.equal(onlyRule(problems), 'R7 state is never colour alone');
});

test('R7: the SAME two nodeStyles pass once they differ in shape', () => {
  const nodeStyles: NodeStyle[] = [
    { fill: '#111111', shape: 'circle' },
    { fill: '#222222', shape: 'diamond' },
  ];
  const t = baseTheme({ nodeStyles });
  assert.deepEqual(validateTheme(t), []);
});

test('R7: two linkStyles differing only in colour/alpha fails only R7', () => {
  const t = baseTheme({
    linkStyles: [
      { color: '#333333', width: 2 },
      { color: '#444444', width: 2, alpha: 0.5 },
    ],
  });
  const problems = validateTheme(t);
  assert.equal(onlyRule(problems), 'R7 state is never colour alone');
});

test('R7: the same two linkStyles pass once width differs', () => {
  const t = baseTheme({
    linkStyles: [
      { color: '#333333', width: 2 },
      { color: '#444444', width: 1 },
    ],
  });
  assert.deepEqual(validateTheme(t), []);
});

/**
 * The regression an adversarial audit of this file found: `nodeStyles` handed a
 * plain object instead of an array makes `.length` `undefined`, the pair loop
 * runs zero times, and R7 returns a clean pass on a theme it never inspected.
 * A rule that can be skipped silently is not a rule, so the wrong shape is now
 * a problem in its own right. Both tests assert on the RULE NAME, so they still
 * mean something if the message is reworded.
 */
test('R7: nodeStyles that is not an array is a problem, not a silent skip', () => {
  const t = baseTheme({
    // deliberately the wrong shape — a record keyed by index, which reads as an
    // array right up until `.length` is read.
    nodeStyles: { 0: { fill: '#111111' }, 1: { fill: '#222222' } } as unknown as NodeStyle[],
  });
  const problems = validateTheme(t);
  assert.equal(onlyRule(problems), 'R7 state is never colour alone');
  assert.ok(problems.some((p) => p.field === 'nodeStyles'));
});

test('R7: linkStyles that is not an array is a problem, not a silent skip', () => {
  const t = baseTheme({
    linkStyles: { 0: { color: '#333333' } } as unknown as LinkStyle[],
  });
  const problems = validateTheme(t);
  assert.equal(onlyRule(problems), 'R7 state is never colour alone');
  assert.ok(problems.some((p) => p.field === 'linkStyles'));
});

// ---------------------------------------------------------------- assertTheme

test('assertTheme throws ThemeError naming every failing field', () => {
  const t = baseTheme({
    name: 'broken',
    dimOpacity: 0.9,
    selection: '#252523',
  });
  assert.throws(
    () => assertTheme(t),
    (err: unknown) => {
      assert.ok(err instanceof ThemeError, 'expected a ThemeError');
      const e = err as ThemeError;
      assert.equal(e.problems.length, 2, `expected 2 problems, got ${JSON.stringify(e.problems)}`);
      assert.ok(e.message.includes('dimOpacity'), 'message must name dimOpacity');
      assert.ok(e.message.includes('selection'), 'message must name selection');
      assert.ok(e.message.includes('broken'), 'message must name the theme');
      return true;
    },
  );
});

// ----------------------------------------------------------------- registry

test('themeByName finds a shipped theme and returns undefined for an unknown one', () => {
  const mg = themeByName('midnight-glow');
  assert.ok(mg, 'expected to find midnight-glow');
  assert.equal(mg!.name, 'midnight-glow');
  assert.equal(themeByName('does-not-exist'), undefined);
});

// -------------------------------------------------------- root re-export identity

test('darkTheme from src/index.js is the SAME object as from themes/index.js', () => {
  assert.equal(darkFromSrc, darkFromThemes, 'existing consumers importing from src must get the identical object');
});
