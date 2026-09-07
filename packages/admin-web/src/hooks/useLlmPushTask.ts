// LLM 推送任务进度订阅 hook。
//
// 打开进度弹窗后：先 GET 详情端点拿当前状态与逐租户 items（任务可能已经
// 完成、SSE 不会重放历史 item 事件），再对未终态任务打开 SSE 增量订阅，
// 逐帧更新 snapshot/item/task/done。卸载时 abort 断开上游。

import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { openSse, type SseEvent } from '../lib/sse';

export type LlmPushTaskStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface LlmPushCounts {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface LlmPushItem {
  tenantId: string;
  status: 'pending' | 'running' | 'succeeded' | 'skipped' | 'failed';
  restarted: boolean;
  gatewayRestarted: boolean;
  skipRestart: boolean;
  error: string | null;
}

const TERMINAL: readonly LlmPushTaskStatus[] = ['succeeded', 'partial', 'failed', 'cancelled'];

function isTerminal(status: string): boolean {
  return (TERMINAL as readonly string[]).includes(status);
}

interface DetailResponse {
  task: {
    id: string;
    status: LlmPushTaskStatus;
    totalCount: number;
    succeededCount: number;
    failedCount: number;
    skippedCount: number;
    error: string | null;
  };
  items: LlmPushItem[];
}

export interface LlmPushTaskState {
  status: LlmPushTaskStatus;
  counts: LlmPushCounts;
  items: LlmPushItem[];
  hint: string | null;
  done: boolean;
  error: string | null;
}

const EMPTY_COUNTS: LlmPushCounts = { total: 0, succeeded: 0, failed: 0, skipped: 0 };

export function useLlmPushTask(taskId: string | null) {
  const [state, setState] = useState<LlmPushTaskState>({
    status: 'pending',
    counts: EMPTY_COUNTS,
    items: [],
    hint: null,
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

    const patch = (p: Partial<LlmPushTaskState>) => {
      if (!cancelled) setState((prev) => ({ ...prev, ...p }));
    };

    const upsertItem = (item: LlmPushItem) => {
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
          status: (payload.status as LlmPushTaskStatus) ?? state.status,
          counts: {
            total: Number(payload.totalCount ?? 0),
            succeeded: Number(payload.succeededCount ?? 0),
            failed: Number(payload.failedCount ?? 0),
            skipped: Number(payload.skippedCount ?? 0),
          },
          hint: typeof payload.hint === 'string' ? payload.hint : null,
          error: typeof payload.error === 'string' ? payload.error : null,
        });
      } else if (ev.event === 'item') {
        upsertItem({
          tenantId: String(payload.tenantId ?? ''),
          status: (payload.status as LlmPushItem['status']) ?? 'pending',
          restarted: payload.restarted === true,
          gatewayRestarted: payload.gatewayRestarted === true,
          skipRestart: payload.skipRestart === true,
          error: typeof payload.error === 'string' ? payload.error : null,
        });
      } else if (ev.event === 'done') {
        patch({ done: true });
      }
    };

    const run = async () => {
      try {
        const detail = await api<DetailResponse>(
          `/v1/admin/llm-push-tasks/${encodeURIComponent(taskId)}`,
        );
        patch({
          status: detail.task.status,
          counts: {
            total: detail.task.totalCount,
            succeeded: detail.task.succeededCount,
            failed: detail.task.failedCount,
            skipped: detail.task.skippedCount,
          },
          items: detail.items ?? [],
          error: detail.task.error,
          done: isTerminal(detail.task.status),
        });
        if (isTerminal(detail.task.status)) return;
        await openSse(
          `/v1/admin/llm-push-tasks/${encodeURIComponent(taskId)}/stream`,
          onSseEvent,
          ac.signal,
        );
        if (!cancelled) patch({ done: true });
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
