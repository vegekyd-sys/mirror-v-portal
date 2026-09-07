// Server-Sent Events 客户端（管理控制台）。
//
// 后端 LLM 推送任务进度通过 text/event-stream 帧下发（见 provisioning-service
// routes/llm-push.ts）。浏览器原生 EventSource 无法携带 Authorization 头，
// 因此与 PodLogsModal 一样使用 fetch + ReadableStream 逐块解析：同源请求
// 可带 Bearer token，关闭窗口时 abort 上游连接。
//
// 帧格式（空行分隔）：
//   event: snapshot|item|task|done
//   data: { ...json }
// 心跳帧为 `: ping`（以冒号开头，解析时忽略）。

import { getToken } from './api';

/** 解析后的一帧事件：event 名 + 原始 data 文本（JSON 由调用方 parse）。 */
export interface SseEvent {
  event: string;
  data: string;
}

/** 单帧解析：忽略注释行（心跳），抽取 event/data。空帧返回 null。 */
export function parseSseFrame(frame: string): SseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const raw of frame.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      // `data:` 后紧跟一个空格（SSE 规范），trimStart 去掉再拼接多行。
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/**
 * 打开一个 SSE 流，逐帧回调 `onEvent`，直到上游 end 或 `signal` 中断。
 * 抛出 Error（HTTP 非 2xx 或网络错误）供调用方展示。
 */
export async function openSse(
  path: string,
  onEvent: (ev: SseEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(path, {
    headers: {
      Accept: 'text/event-stream',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({} as { message?: string }));
    throw new Error(body.message || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done || signal.aborted) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const ev = parseSseFrame(frame);
      if (ev) onEvent(ev);
    }
  }
}
