// A judge answers yes-or-no questions about a piece of work with a probability, not with prose. The work goes in as
// one text, the questions as a list, and each comes back with how likely the answer is yes. What a probability means
// depends on who gave it: a share of runs that said yes, or a model's own weight on the word.

export type Question = { id: string; ask: string };

export type JudgeRequest = { state: string; questions: Question[] };

export type Judged = { answers: Record<string, { p: number; passage: string | null }>; usd: number };

// At or above YES the answer is taken as yes, at or below NO as no. Between the two the judge is unsure.
export const YES = 0.7;
export const NO = 0.3;

// The judge could not be asked at all, for a reason that passes: an expired login, a rate limit. usd is what the
// attempt cost before it stopped.
export class JudgeStopped extends Error {
  constructor(
    message: string,
    readonly usd: number,
  ) {
    super(message);
  }
}

export function questionsText(questions: Question[]): string {
  return ['## Questions', '', ...questions.map(({ id, ask }) => `- \`${id}\`: ${ask}`)].join('\n');
}
