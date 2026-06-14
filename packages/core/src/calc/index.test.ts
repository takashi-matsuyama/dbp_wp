import { describe, expect, it } from 'vitest';
import { SafeFormulaEngine } from './index';

const engine = new SafeFormulaEngine();

describe('SafeFormulaEngine', () => {
  it('evaluates arithmetic with named cells', () => {
    expect(engine.evaluate('a + b * 2', { a: 1, b: 3 })).toBe(7);
    expect(engine.evaluate('(menuOrder + 1) * 10', { menuOrder: 4 })).toBe(50);
  });

  it('supports safe built-in math functions', () => {
    expect(engine.evaluate('max(a, b)', { a: 2, b: 5 })).toBe(5);
    expect(engine.evaluate('floor(x)', { x: 3.7 })).toBe(3);
  });

  it('throws on invalid syntax', () => {
    expect(() => engine.evaluate('a +', { a: 1 })).toThrow(/Invalid formula/);
  });

  it('throws on unknown variables', () => {
    expect(() => engine.evaluate('a + b', { a: 1 })).toThrow();
  });

  it('throws when the result is not a finite number', () => {
    expect(() => engine.evaluate('1 / 0', {})).toThrow(/finite number/);
    expect(() => engine.evaluate('a > b', { a: 1, b: 2 })).toThrow(/finite number/);
  });

  it('rejects assignment (no side effects)', () => {
    expect(() => engine.evaluate('a = 5', { a: 1 })).toThrow();
  });

  it('blocks member access (prototype-pollution hardening)', () => {
    expect(() => engine.evaluate('a.constructor', { a: 1 })).toThrow();
    expect(() => engine.evaluate('a["__proto__"]', { a: 1 })).toThrow();
  });

  it('removes the nondeterministic random() function', () => {
    expect(() => engine.evaluate('random()', {})).toThrow();
  });
});
