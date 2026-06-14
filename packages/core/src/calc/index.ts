import { Parser, type Expression } from 'expr-eval-fork';

/**
 * Formula engine: evaluates a spreadsheet expression against named numeric cells.
 *
 * Implementations MUST NOT use `eval`, `Function`, or any other dynamic code execution.
 */
export interface FormulaEngine {
  /**
   * Evaluate a single expression against a map of cell references to numbers.
   * Throws on invalid syntax, unknown variables, or a non-numeric result.
   */
  evaluate(expression: string, context: Record<string, number>): number;
}

/**
 * Formula engine backed by expr-eval-fork, which parses to an AST and evaluates without
 * `eval`/`Function`. Member access, assignment, and function definitions are disabled,
 * the nondeterministic `random()` function is removed, and results are constrained to
 * finite numbers, so expressions stay pure, deterministic, and side-effect free.
 */
export class SafeFormulaEngine implements FormulaEngine {
  private readonly parser: Parser;

  constructor() {
    this.parser = new Parser({
      allowMemberAccess: false,
      operators: { assignment: false, fndef: false },
    });
    // The `operators.random` flag does not remove the random() function; delete it so
    // evaluation stays deterministic.
    delete this.parser.functions.random;
  }

  evaluate(expression: string, context: Record<string, number>): number {
    let parsed: Expression;
    try {
      parsed = this.parser.parse(expression);
    } catch (e) {
      throw new Error(`Invalid formula: ${e instanceof Error ? e.message : 'parse error'}`);
    }

    let result: unknown;
    try {
      result = parsed.evaluate(context);
    } catch (e) {
      throw new Error(`Formula evaluation failed: ${e instanceof Error ? e.message : 'error'}`);
    }

    if (typeof result !== 'number' || !Number.isFinite(result)) {
      throw new Error('Formula must evaluate to a finite number.');
    }
    return result;
  }
}
