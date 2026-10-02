function extractSearchQuery(text) {
  if (!text || typeof text !== 'string') return undefined;
  let str = text.trim();
  if (!str) return undefined;

  // 1. Strip compound action clause at end ("and play...", "and open...", "to view...", etc.) or trailing punctuation
  str = str.replace(/(?:\s+(?:and|then|to)\s+(?:play|watch|open|click|view|select|listen|launch|start|stream|inspect)\b.*|[.!?]+$)/i, '').trim();

  // 2. Strip leading action verbs
  str = str.replace(/^(?:search\s+(?:for\s+)?|find\s+|look\s+up\s+|query\s+(?:for\s+)?|show\s+(?:me\s+)?|get\s+(?:me\s+)?|fetch\s+|locate\s+|filter\s+(?:by\s+)?)/i, '').trim();

  // 3. Strip quotes if wrapped
  str = str.replace(/^["']|["']$/g, '').trim();

  // 4. Strip leading possessives/articles ("my", "the", "a", "an", "our")
  str = str.replace(/^(?:my|the|a|an|our)\s+/i, '').trim();

  // 5. Strip selection / temporal constraints ("latest", "most recent", "newest", "last", "first", "oldest", "recent")
  const constraintMatch = str.match(/^(?:latest|most\s+recent|newest|last|first|oldest|recent)\s+/i);
  if (constraintMatch) {
    str = str.slice(constraintMatch[0].length).trim();
  }

  // 6. Strip trailing generic record / container nouns if preceded by an entity
  // (e.g. "Amazon transaction" -> "Amazon", "Netflix payment" -> "Netflix")
  const nounMatch = str.match(/^(.*?)\s+(?:transactions?|payments?|orders?|receipts?|records?|bills?|invoices?|entries|entry|items?|details?)$/i);
  if (nounMatch && nounMatch[1] && nounMatch[1].trim().length > 0) {
    str = nounMatch[1].trim();
  }

  // Final cleanup of quotes
  str = str.replace(/^["']|["']$/g, '').trim();

  return str.length > 0 ? str : undefined;
}

const testCases = [
  'Find my latest Amazon transaction.',
  'Search for the latest Amazon transaction.',
  'Find my latest Swiggy transaction.',
  'Find my most recent salary transaction.',
  'Find the latest Netflix payment.',
  'Search for MrBeast and play the first video',
  'Search for laptops under ₹50,000',
  'Find wireless headphones and view details',
  'Search "retro sneakers"',
  'Search for MrBeast',
  'Find Amazon transaction',
  'latest Amazon transaction'
];

for (const tc of testCases) {
  console.log(`"${tc}" => "${extractSearchQuery(tc)}"`);
}
