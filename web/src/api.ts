import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { InboxAnswer } from '../../src/engine/inbox.ts';
import type { AttemptRow, MilestoneRow, ProjectRow, TaskRow } from '../../src/engine/store.ts';
import type { EventRow } from '../../src/events.ts';
import type { TaskManifest } from '../../src/manifest/build.ts';
import type { InboxItem } from './lib/inbox.ts';
import { applyEvent, EMPTY_LOG, EVENT_TYPES, type LogState } from './logState.ts';

export type TaskSummary = TaskRow & { specialty: string; attempts: number; usdEst: number | null };
export type Attempt = Omit<AttemptRow, 'manifest'>;
export type TaskDetails = { task: TaskRow; attempts: Attempt[] };
export type StoredManifest = TaskManifest & { flags?: string[] };
export type ProjectSummary = ProjectRow & { milestone: MilestoneRow | null; pending: number };
export type ProjectDetails = ProjectRow & { milestones: MilestoneRow[]; totals: { attempts: number; usdEst: number | null; seconds: number } };
export type InboxList = { items: InboxItem[]; count: number };

const REOPEN_MS = 2000;
const FLUSH_MS = 50;
const REFRESH_MS = 200;
const INBOX_POLL_MS = 3000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.text();
  if (!res.ok) {
    let message = body;
    try {
      message = (JSON.parse(body) as { error?: string }).error ?? body;
    } catch {
      // Not every failure comes from the API: a proxy or a daemon that is starting up can answer in plain text.
    }
    throw new ApiError(message || `The daemon answered ${res.status}`, res.status);
  }
  return JSON.parse(body) as T;
}

export const listTasks = () => request<TaskSummary[]>('/api/tasks');
export const getTask = (id: number) => request<TaskDetails>(`/api/tasks/${id}`);
export const listProjectTasks = (project: string) => request<TaskSummary[]>(`/api/tasks?project=${encodeURIComponent(project)}`);
export const getAttemptDiff = (id: number) => request<{ diff: string | null }>(`/api/attempts/${id}/diff`);
export const getManifest = (attemptId: number) => request<StoredManifest>(`/api/attempts/${attemptId}/manifest`);

const post = <T,>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const act = (id: number, action: 'cancel' | 'retry') => post<unknown>(`/api/tasks/${id}/${action}`);

export const cancelTask = (id: number) => act(id, 'cancel');
export const retryTask = (id: number) => act(id, 'retry');

const projectApi = (name: string) => `/api/projects/${encodeURIComponent(name)}`;

export const listProjects = () => request<ProjectSummary[]>('/api/projects');
export const getProject = (name: string) => request<ProjectDetails>(projectApi(name));
export const addBrief = (name: string, markdown: string) => post<unknown>(`${projectApi(name)}/brief`, { markdown });
export const haltProject = (name: string, reason: string) => post<unknown>(`${projectApi(name)}/halt`, { reason });
export const listInbox = (project?: string) => request<InboxList>(project === undefined ? '/api/inbox' : `/api/inbox?project=${encodeURIComponent(project)}`);
export const answerInbox = (id: number, answer: InboxAnswer) => post<unknown>(`/api/inbox/${id}/answer`, answer);

// The badge and the Inbox page share one poll, so they can't disagree. It covers every project: the page narrows it down itself.
export const useInbox = () => useQuery({ queryKey: ['inbox'], queryFn: () => listInbox(), refetchInterval: INBOX_POLL_MS });

// A project's events only say that something changed. The queries they refresh hold the record.
export function useProjectEvents(name: string): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let source: EventSource | undefined;
    let reopen: ReturnType<typeof setTimeout> | undefined;
    let flush: ReturnType<typeof setTimeout> | undefined;

    const receive = () => {
      flush ??= setTimeout(() => {
        flush = undefined;
        for (const queryKey of [['project', name], ['tasks', name], ['inbox'], ['artifacts', name]]) void queryClient.invalidateQueries({ queryKey });
      }, REFRESH_MS);
    };

    const open = () => {
      const current = new EventSource(`${projectApi(name)}/events`);
      source = current;
      for (const type of EVENT_TYPES) current.addEventListener(type, receive);
      current.onerror = () => {
        if (current.readyState === EventSource.CLOSED) reopen = setTimeout(open, REOPEN_MS);
      };
    };
    open();

    return () => {
      source?.close();
      clearTimeout(reopen);
      clearTimeout(flush);
    };
  }, [name, queryClient]);
}

// The stream's events also say when the task's own record has changed, so they refresh it.
const CHANGES_THE_RECORD: readonly string[] = ['task.state', 'attempt.state', 'manifest.built'];

export function useTaskLog(taskId: number): { log: LogState; connected: boolean } {
  const queryClient = useQueryClient();
  const [log, setLog] = useState(EMPTY_LOG);
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    let source: EventSource | undefined;
    let reopen: ReturnType<typeof setTimeout> | undefined;
    let flush: ReturnType<typeof setTimeout> | undefined;
    let lastSeq = 0;
    let pending: EventRow[] = [];

    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      void queryClient.invalidateQueries({ queryKey: ['manifest'] });
    };

    // Opening an old task replays its whole history, one browser task per event. Rendering once per batch keeps that quick.
    const receive = (message: Event) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as EventRow;
      lastSeq = Math.max(lastSeq, event.seq);
      pending.push(event);
      if (CHANGES_THE_RECORD.includes(event.type)) refresh();
      flush ??= setTimeout(() => {
        flush = undefined;
        const batch = pending;
        pending = [];
        setLog((state) => batch.reduce(applyEvent, state));
      }, FLUSH_MS);
    };

    const open = () => {
      const current = new EventSource(`/api/tasks/${taskId}/events?after=${lastSeq}`);
      source = current;
      for (const type of EVENT_TYPES) current.addEventListener(type, receive);
      current.onopen = () => {
        setConnected(true);
        refresh();
      };
      current.onerror = () => {
        setConnected(false);
        // A dropped connection reopens by itself, but an error status such as a starting daemon's 503 ends it for good.
        if (current.readyState === EventSource.CLOSED) reopen = setTimeout(open, REOPEN_MS);
      };
    };
    open();

    return () => {
      source?.close();
      clearTimeout(reopen);
      clearTimeout(flush);
    };
  }, [taskId, queryClient]);

  return { log, connected };
}
