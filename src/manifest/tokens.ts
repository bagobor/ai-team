// Deliberately conservative: there is no offline tokenizer, and running over a budget costs more than running under it.
const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

export function charsForTokens(tokens: number): number {
  return Math.floor(tokens * CHARS_PER_TOKEN);
}
