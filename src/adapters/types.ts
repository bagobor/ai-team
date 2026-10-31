import type { TaskManifest } from '../manifest/build.ts';

export type WorkerEvent =
  | { t: 'init'; sessionId: string; model: string }
  | { t: 'message'; text: string }
  | { t: 'tool_call'; name: string; input: unknown }
  | { t: 'tool_result'; name: string; ok: boolean; summary?: string }
  | { t: 'usage'; inTok: number; outTok: number; cachedTok?: number; usdEst?: number }
  | { t: 'error'; message: string };

export type Workspace = { path: string; transcriptPath: string; manifestDir: string };

export type Usage = { inTok: number; outTok: number; cachedTok?: number; usdEst?: number };

export type FailureKind = 'auth_required' | 'max_turns' | 'no_result' | 'no_structured_output' | 'worker_error' | 'spawn_error';

export type AttemptResult = {
  status: 'succeeded' | 'failed' | 'timeout' | 'budget_exceeded' | 'cancelled' | 'invalid_output' | 'usage_limited';
  output?: unknown;
  usage: Usage;
  sessionId?: string;
  failureKind?: FailureKind;
  message?: string;
  resetAt?: string;
};

export interface AttemptHandle {
  events: AsyncIterable<WorkerEvent>;
  cancel(): Promise<void>;
  result: Promise<AttemptResult>;
  pid?: number;
  argv: readonly string[];
}

export interface WorkerAdapter {
  id: string;
  vendor: string;
  capabilities: {
    repoTools: boolean;
    structuredOutput: boolean;
    resume: boolean;
    costReport: 'exact' | 'estimate' | 'none';
    sandbox: 'os' | 'flags' | 'none';
  };
  preflight(): Promise<{ ok: true } | { ok: false; reason: string; fix: string }>;
  start(m: TaskManifest, ws: Workspace): AttemptHandle;
}
