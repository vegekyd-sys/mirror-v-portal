// Rollout batch（镜像滚动发布）任务进度订阅 hook。
//
// 与 useLlmPushTask 同构：先 GET 详情拿当前状态与逐租户 items，再对未终态
// 任务打开 SSE 增量订阅（snapshot/item/task/done）。断开后以详情为准决定
// 结束或指数退避重连，避免把「连接断开」误判成「任务结束」。
//
// 差异点（vs LLM push）：item 有 already_current / pinned 两种额外终态，且
// 携带 deployment 名；counts 多 alreadyCurrent / pinned 两维。

import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { openSse, type SseEvent } from '../lib/sse';

export type RolloutTaskStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type RolloutItemStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'already_current'
  | 'pinned'
  | 'skipped'
  | 'failed';

export interface RolloutCounts {
  total: number;
  succeeded: number;
  alreadyCurrent: number;
  pinned: number;
  skipped: number;
  failed: number;
}

export interface RolloutItem {
  tenantId: string;
  deployment: string;
  status: RolloutItemStatus;
  error: string | null;
}

const TERMINAL: readonly RolloutTaskStatus[] = ['succeeded', 'partial', 'failed', 'cancelled'];

function isTerminal(status: string): boolean {
  return (TERMINAL as readonly string[]).includes(status);
}

interface DetailResponse {
  task: {
    id: string;
    service: string;
    image: string;
    tag: string;
    scope: string | null;
    status: RolloutTaskStatus;
    totalCount: number;
    succeededCount: number;
    alreadyCurrentCount: number;
    pinnedCount: number;
    skippedCount: number;
    failedCount: number;
    error: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  };
  items: RolloutItem[];
}

export interface RolloutTaskState {
  status: RolloutTaskStatus;
  task: DetailResponse['task'] | null;
  counts: RolloutCounts;
  items: RolloutItem[];
  done: boolean;
  error: string | null;
}

const EMPTY_COUNTS: RolloutCounts = {
  total: 0,
  succeeded: 0,
  alreadyCurrent: 0,
  pinned: 0,
  skipped: 0,
  failed: 0,
};

const MAX_RECONNECTS = 5;
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const RECONNECT_EXHAUSTED_HINT = '进度订阅中断，请关闭弹窗后重新打开查看';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function countsFrom(p: Record<string, unknown>): RolloutCounts {
  return {
    total: Number(p.totalCount ?? 0),
    succeeded: Number(p.succeededCount ?? 0),
    alreadyCurrent: Number(p.alreadyCurrentCount ?? 0),
    pinned: Number(p.pinnedCount ?? 0),
    skipped: Number(p.skippedCount ?? 0),
    failed: Number(p.failedCount ?? 0),
  };
}

export function useRolloutTask(taskId: string | null) {
  const [state, setState] = useState<RolloutTaskState>({
    status: 'pending',
    task: null,
    counts: EMPTY_COUNTS,
    items: [],
    done: false,
    error: null,
  });
  const abortRef = useRef<AbortController | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!taskId) return;
    const ac = new AbortController();
    abortRef.current = ac;
    let cancelled = false;

    const patch = (p: Partial<RolloutTaskState>) => {
      if (!cancelled) setState((prev) => ({ ...prev, ...p }));
    };

    const upsertItem = (item: RolloutItem) => {
      if (cancelled) return;
      setState((prev) => {
        const idx = prev.items.findIndex((i) => i.tenantId === item.tenantId);
        if (idx >= 0) {
          const items = [...prev.items];
          items[idx] = item;
          return { ...prev, items };
        }
        return { ...prev, items: [...prev.items, item] };
      });
    };

    const onSseEvent = (ev: SseEvent) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (ev.event === 'snapshot' || ev.event === 'task') {
        patch({
          status: (payload.status as RolloutTaskStatus) ?? 'pending',
          counts: countsFrom(payload),
          error: typeof payload.error === 'string' ? payload.error : null,
        });
      } else if (ev.event === 'item') {
        upsertItem({
          tenantId: String(payload.tenantId ?? ''),
          deployment: String(payload.deployment ?? ''),
          status: (payload.status as RolloutItemStatus) ?? 'pending',
          error: typeof payload.error === 'string' ? payload.error : null,
        });
      } else if (ev.event === 'done') {
        patch({ done: true });
      }
    };

    const detailPath = `/v1/admin/rollout-batch-tasks/${encodeURIComponent(taskId)}`;
    const streamPath = `${detailPath}/stream`;

    const applyDetail = (detail: DetailResponse): boolean => {
      const terminal = isTerminal(detail.task.status);
      patch({
        status: detail.task.status,
        task: detail.task,
        counts: {
          total: detail.task.totalCount,
          succeeded: detail.task.succeededCount,
          alreadyCurrent: detail.task.alreadyCurrentCount,
          pinned: detail.task.pinnedCount,
          skipped: detail.task.skippedCount,
          failed: detail.task.failedCount,
        },
        items: detail.items ?? [],
        error: detail.task.error,
        done: terminal,
      });
      return terminal;
    };

    const subscribe = async () => {
      let reconnects = 0;
      for (;;) {
        if (cancelled || ac.signal.aborted) return;

        try {
          await openSse(streamPath, onSseEvent, ac.signal);
        } catch {
          // 网关空闲超时 / 网络错误：以详情为准再决定结束还是重连。
        }

        if (cancelled || ac.signal.aborted) return;

        const detail = await api<DetailResponse>(detailPath);
        if (cancelled || ac.signal.aborted) return;
        if (applyDetail(detail)) return;

        if (reconnects >= MAX_RECONNECTS) {
          patch({ done: true, error: RECONNECT_EXHAUSTED_HINT });
          return;
        }

        await sleep(RECONNECT_BACKOFF_MS[reconnects], ac.signal);
        reconnects += 1;
      }
    };

    const run = async () => {
      try {
        const detail = await api<DetailResponse>(detailPath);
        if (applyDetail(detail)) return;
        await subscribe();
      } catch (e) {
        if (ac.signal.aborted) return;
        patch({ error: e instanceof Error ? e.message : '进度订阅失败', done: true });
      }
    };

    void run();
    return () => {
      cancelled = true;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, reloadKey]);

  return { ...state, reload: () => setReloadKey((k) => k + 1) };
}
