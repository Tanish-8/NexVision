/**
 * Luhn algorithm checksum validator for payment card numbers.
 * Strictly deterministic and local.
 */

/**
 * Validates whether a numeric string conforms to the Luhn checksum formula.
 *
 * @param candidate String containing potential card digits (may contain spaces or dashes).
 * @returns true if candidate contains 13-19 digits and satisfies the Luhn check, false otherwise.
 */
export function isValidLuhn(candidate: string): boolean {
  // Strip common separators (spaces, hyphens)
  const sanitized = candidate.replace(/[\s-]/g, '');

  // Payment cards typically range from 13 to 19 digits
  if (!/^\d{13,19}$/.test(sanitized)) {
    return false;
  }

  let sum = 0;
  let shouldDouble = false;

  // Loop from rightmost digit to left
  for (let i = sanitized.length - 1; i >= 0; i--) {
    let digit = Number.parseInt(sanitized.charAt(i), 10);

    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}
