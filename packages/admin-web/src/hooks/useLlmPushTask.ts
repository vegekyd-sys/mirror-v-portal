// LLM 推送任务进度订阅 hook。
//
// 打开进度弹窗后：先 GET 详情端点拿当前状态与逐租户 items（任务可能已经
// 完成、SSE 不会重放历史 item 事件），再对未终态任务打开 SSE 增量订阅，
// 逐帧更新 snapshot/item/task/done。卸载时 abort 断开上游。
//
// SSE 流可能被网关/负载均衡的空闲超时断开——这并不意味着任务结束。因此
// openSse 无论正常 return 还是抛错，都先重新 GET 详情确认任务真实状态：
// 终态才置 done；仍 pending/running 则带指数退避重连（上限 5 次）；重连
// 耗尽仍非终态才给友好提示并结束，避免把「连接断开」误判成「任务结束」。

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

/** SSE 断开后的最大重连次数（不含首次连接）。 */
const MAX_RECONNECTS = 5;
/** 指数退避间隔（毫秒）：1s、2s、4s、8s、16s。 */
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
/** 重连上限耗尽且任务仍未终态时的友好提示。 */
const RECONNECT_EXHAUSTED_HINT = '进度订阅中断，请关闭弹窗后重新打开查看';

/** 可被 abort 提前唤醒的延时：组件卸载后立即结束，避免悬挂的定时器继续跑。 */
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

    const detailPath = `/v1/admin/llm-push-tasks/${encodeURIComponent(taskId)}`;
    const streamPath = `${detailPath}/stream`;

    // 用详情端点快照覆盖本地状态，返回是否为终态。
    const applyDetail = (detail: DetailResponse): boolean => {
      const terminal = isTerminal(detail.task.status);
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
        done: terminal,
      });
      return terminal;
    };

    // 订阅 SSE，并在连接结束（正常/异常）后以详情为准决定是否结束或重连。
    const subscribe = async () => {
      let reconnects = 0;
      for (;;) {
        if (cancelled || ac.signal.aborted) return;

        try {
          await openSse(streamPath, onSseEvent, ac.signal);
        } catch {
          // 网关空闲超时 / 网络错误 / 瞬时 HTTP 错误：不当作终态，落到下方
          // 重新确认任务真实状态后再决定结束还是重连。
        }

        if (cancelled || ac.signal.aborted) return;

        // SSE 结束只代表「订阅断开」，不代表「任务结束」，必须以详情为准。
        const detail = await api<DetailResponse>(detailPath);
        if (cancelled || ac.signal.aborted) return;
        if (applyDetail(detail)) return; // 已终态，结束。

        if (reconnects >= MAX_RECONNECTS) {
          // 重连上限耗尽仍非终态：给友好提示并结束，避免用户误以为任务完成。
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
