import type { Player, PlayProblem, PlayResult } from '../../src/checks/play.ts';

// What a run returns when only its problems matter to the test.
export const playResult = (problems: PlayProblem[] = []): PlayResult => ({ ok: problems.length === 0, problems, durationMs: 1, log: [] });

// Stands in for Chrome. It fetches each page it is asked to play, so a test can see what the engine served, and
// answers with the results in order, repeating the last one once they run out.
export function fakePlayer(results: PlayResult | PlayResult[], opts: { unavailable?: string } = {}): Player & { calls: { url: string; body: string }[] } {
  const queue = Array.isArray(results) ? results : [results];
  if (queue.length === 0) throw new Error('fakePlayer needs at least one result');
  const calls: { url: string; body: string }[] = [];
  const next = async (url: string): Promise<PlayResult> => {
    const body = await fetch(url).then((res) => res.text());
    calls.push({ url, body });
    return queue[Math.min(calls.length, queue.length) - 1]!;
  };
  return {
    calls,
    unavailable: () => opts.unavailable,
    smoke: (url) => next(url),
    script: (url) => next(url),
  };
}
