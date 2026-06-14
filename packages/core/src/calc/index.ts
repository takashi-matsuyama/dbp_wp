/**
 * Formula engine (contract only — implementation deferred).
 *
 * The legacy SaaS evaluated spreadsheet formulas with `eval`, which is unsafe. The
 * replacement MUST use a sandboxed expression evaluator. The concrete library is chosen
 * in a later implementation step (see planning docs, framework-selection "remaining
 * points"); this module only fixes the interface so the rest of the app can depend on it.
 */
export interface FormulaEngine {
  /**
   * Evaluate a single spreadsheet expression against a map of cell references to numbers.
   * Implementations must not use `eval`, `Function`, or any other dynamic code execution.
   */
  evaluate(expression: string, context: Record<string, number>): number;
}

/** Placeholder engine that fails loudly until a safe evaluator is wired in. */
export class UnimplementedFormulaEngine implements FormulaEngine {
  evaluate(): number {
    throw new Error('Formula engine is not implemented yet (safe evaluator to be selected).');
  }
}
