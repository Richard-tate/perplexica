/**
 * Fixes broken PHP array syntax produced by some LLMs (e.g. MiniMax)
 * where commas between array elements are replaced with ][
 *
 * Examples:
 *   ['title']['content']['status']  →  ['title', 'content', 'status']
 *   ['key' => 'val']['key2' => 'val2']  →  ['key' => 'val', 'key2' => 'val2']
 *   ['val1']['val2'][]  →  ['val1', 'val2']
 *   update($id, ['key' => true]['key2' => now()][])  →  update($id, ['key' => true, 'key2' => now()])
 */
function fixPhpArraySyntax(code: string): string {
  // Fix patterns where ] is immediately followed by [ between array elements
  // Handles: 'val']['next', "val"]["next", true][', now()][', etc.
  //
  // Strategy: replace ]\s*[ that appears within array context
  // We match: ) or quote or word-char or true/false/null, then ]\s*[
  let result = code;

  // Pass 1: Fix quoted element boundaries: 'a']['b' or "a"]["b"
  result = result.replace(/(['"])\]\s*\[(?=['"])/g, '$1, ');

  // Pass 2: Fix non-quoted value followed by quoted key: true]['key' or null]['key'
  // Handles: true][', false][', null][', now()][', $var]['
  result = result.replace(/(\w|\))\]\s*\[(?=['"])/g, '$1, ');

  // Pass 3: Fix trailing empty brackets '][]' → ']'
  result = result.replace(/\]\[\]/g, ']');

  return result;
}

/**
 * Applies code sanitization only within markdown code blocks,
 * leaving regular text (citations like [1][2]) untouched.
 */
export function sanitizeCodeBlocks(text: string): string {
  // Match markdown fenced code blocks: ```lang\n...\n```
  // Uses \r?\n to handle both Unix and Windows line endings
  return text.replace(
    /(```[\w]*\r?\n)([\s\S]*?)(```)/g,
    (_match, opening: string, code: string, closing: string) => {
      return opening + fixPhpArraySyntax(code) + closing;
    },
  );
}
