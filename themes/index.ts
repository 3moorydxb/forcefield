import { assertTheme, type Theme } from './contract.js';
import { darkTheme } from './dark.js';
import { lightTheme } from './light.js';
import { midnightGlow } from './midnight-glow.js';

export * from './contract.js';
export { darkTheme } from './dark.js';
export { lightTheme } from './light.js';
export { midnightGlow } from './midnight-glow.js';

/**
 * Every shipped theme, asserted against the contract AT MODULE LOAD. A theme
 * that cannot pass `assertTheme` cannot be in this array — that is what makes
 * the contract real for the contribution path: add a theme, forget to satisfy
 * a rule, and the package fails to even import, not just fails a test you
 * might not have run.
 */
export const themes: readonly Theme[] = [
  assertTheme(darkTheme),
  assertTheme(lightTheme),
  assertTheme(midnightGlow),
];

export function themeByName(name: string): Theme | undefined {
  return themes.find((t) => t.name === name);
}
