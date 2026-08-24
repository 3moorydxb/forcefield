/**
 * Minimal ambient declarations for the two Node built-ins the test suite uses.
 *
 * The package has ZERO dependencies, including dev dependencies, so `@types/node`
 * is not installed and `npm test` works on a clone with no network. This declares
 * exactly the surface the tests touch and nothing else — pointing `types` at some
 * other package's copy of `@types/node` would hardcode a path off one machine.
 */

declare module 'node:test' {
  interface TestFn {
    (name: string, fn: () => void | Promise<void>): void;
    skip(name: string, fn: () => void | Promise<void>): void;
  }
  const test: TestFn;
  export default test;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, regexp: RegExp, message?: string): void;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}

// `console` and `performance` come from the DOM lib, which `src/` needs anyway
// (the renderer and controller are browser code). Nothing else is declared here.
