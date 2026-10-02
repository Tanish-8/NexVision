/**
 * Phase 3A / Shared — Deterministic Temporal Grounding.
 *
 * Provides pure, deterministic normalization of relative date expressions
 * (e.g. 'today', "today's date", 'tomorrow', 'yesterday') against an authoritative
 * runtime reference date into canonical ISO YYYY-MM-DD format.
 *
 * Invariants:
 * - Pure and deterministic: accepts an explicit reference date/time input.
 * - Preserves already-canonical YYYY-MM-DD values without alteration.
 * - Leaves unsupported expressions and unrelated strings unchanged.
 * - Does not guess or heuristically re-interpret arbitrary user text.
 * - Zero network or LLM dependencies.
 * - Zero logging of sensitive parameter values.
 */

/**
 * Checks whether a string matches a recognized relative date expression.
 * Handles standard and typographical curly apostrophe variants.
 */
export function isRelativeDateExpression(expression: string): boolean {
  if (typeof expression !== 'string') {
    return false;
  }
  const normalized = expression.trim().replace(/[\u2018\u2019]/g, "'").toLowerCase();
  return (
    /^(?:today(?:'s\s+date)?|todays\s+date)$/.test(normalized) ||
    /^(?:tomorrow(?:'s\s+date)?|tomorrows\s+date)$/.test(normalized) ||
    /^(?:yesterday(?:'s\s+date)?|yesterdays\s+date)$/.test(normalized)
  );
}

/**
 * Parses a reference date into a valid Date object, handling YYYY-MM-DD string
 * inputs without timezone-offset drift.
 */
function parseReferenceDate(ref: Date | string | number | undefined): Date | null {
  if (ref === undefined || ref === null) {
    return new Date();
  }
  if (typeof ref === 'string') {
    const trimmed = ref.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const parts = trimmed.split('-').map(Number);
      const y = parts[0];
      const m = parts[1];
      const d = parts[2];
      if (typeof y === 'number' && typeof m === 'number' && typeof d === 'number') {
        const date = new Date(y, m - 1, d);
        if (date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d) {
          return date;
        }
      }
    }
  }
  const date = new Date(ref);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Formats a Date instance as a canonical ISO date string (YYYY-MM-DD).
 */
function formatCanonicalIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Resolves relative date expressions against an authoritative reference date.
 *
 * Supported relative expressions:
 * - "today", "today's date", "todays date", "today’s date" -> reference date (offset 0)
 * - "tomorrow", "tomorrow's date", "tomorrows date" -> reference date + 1 day
 * - "yesterday", "yesterday's date", "yesterdays date" -> reference date - 1 day
 *
 * Rules:
 * 1. Already-canonical ISO "YYYY-MM-DD" values are preserved as-is.
 * 2. Unrelated text (e.g. "college", "pending", "medium") is returned unchanged.
 * 3. Unsupported relative expressions (e.g. "next week", "in 2 days") are returned unchanged.
 * 4. If referenceDate is invalid, returns the original expression unchanged.
 *
 * @param expression The raw string to resolve.
 * @param referenceDate Optional authoritative reference clock (defaults to new Date()).
 * @returns Canonical YYYY-MM-DD string if matched, otherwise original expression.
 */
export function resolveRelativeDate(
  expression: string,
  referenceDate?: Date | string | number
): string {
  if (typeof expression !== 'string') {
    return expression;
  }

  const trimmed = expression.trim();
  if (trimmed === '') {
    return expression;
  }

  // 1. Preserve already-canonical YYYY-MM-DD values
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parts = trimmed.split('-').map(Number);
    const y = parts[0];
    const m = parts[1];
    const d = parts[2];
    if (typeof y === 'number' && typeof m === 'number' && typeof d === 'number') {
      const candidate = new Date(y, m - 1, d);
      if (candidate.getFullYear() === y && candidate.getMonth() === m - 1 && candidate.getDate() === d) {
        return trimmed;
      }
    }
  }

  // 2. Normalize apostrophes and lowercase for matching
  const normalized = trimmed.replace(/[\u2018\u2019]/g, "'").toLowerCase();

  let dayOffset: number | null = null;
  if (/^(?:today(?:'s\s+date)?|todays\s+date)$/.test(normalized)) {
    dayOffset = 0;
  } else if (/^(?:tomorrow(?:'s\s+date)?|tomorrows\s+date)$/.test(normalized)) {
    dayOffset = 1;
  } else if (/^(?:yesterday(?:'s\s+date)?|yesterdays\s+date)$/.test(normalized)) {
    dayOffset = -1;
  } else {
    // Unsupported relative date expression or unrelated text -> return unchanged
    return expression;
  }

  // 3. Resolve base reference date
  const base = parseReferenceDate(referenceDate);
  if (!base) {
    return expression;
  }

  // 4. Deterministic day arithmetic
  const target = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset);
  return formatCanonicalIsoDate(target);
}
