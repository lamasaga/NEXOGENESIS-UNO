import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchUnoJob,
  fetchUnoRepair,
  organizeUnoUnassignedCard,
  repairUnoCandidate,
  recompileUnoUnassignedCard,
  type UnoJob,
} from '../api/client';

export type UnoUnassignedQueueMode = 'recompile' | 'organize';
export type UnoUnassignedQueueStatus = 'running' | 'stopping' | 'paused' | 'completed';
export interface UnoUnassignedQueueTarget {
  id: string;
  kind: 'unassigned' | 'repair';
  revision: string;
}

export interface UnoUnassignedQueueResult {
  cardId: string;
  jobId: string;
  status: UnoJob['status'];
  detail: string;
}

export interface UnoUnassignedQueueState {
  version: 2;
  libraryId: string;
  mode: UnoUnassignedQueueMode;
  targets: UnoUnassignedQueueTarget[];
  index: number;
  currentJobId: string | null;
  currentRequestId: string | null;
  status: UnoUnassignedQueueStatus;
  results: UnoUnassignedQueueResult[];
  message: string;
  startedAt: string;
}

const STORAGE_KEY = 'nexogenesis.unassigned-queue.v2';
const ACTIVE_JOB_STATES = new Set<UnoJob['status']>(['running', 'review']);

function validQueue(value: unknown): value is UnoUnassignedQueueState {
  if (!value || typeof value !== 'object') return false;
  const queue = value as Partial<UnoUnassignedQueueState>;
  return queue.version === 2
    && typeof queue.libraryId === 'string'
    && (queue.mode === 'recompile' || queue.mode === 'organize')
    && Array.isArray(queue.targets)
    && queue.targets.length > 0
    && queue.targets.every(target => target && typeof target.id === 'string'
      && (target.kind === 'unassigned' || target.kind === 'repair')
      && typeof target.revision === 'string')
    && Number.isInteger(queue.index)
    && Number(queue.index) >= 0
    && Number(queue.index) <= queue.targets.length
    && (queue.currentJobId === null || typeof queue.currentJobId === 'string')
    && (queue.currentRequestId == null || typeof queue.currentRequestId === 'string')
    && (queue.status === 'running' || queue.status === 'stopping' || queue.status === 'paused' || queue.status === 'completed')
    && Array.isArray(queue.results);
}

export function readUnoUnassignedQueue(): UnoUnassignedQueueState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return validQueue(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveQueue(queue: UnoUnassignedQueueState | null) {
  if (typeof window === 'undefined') return;
  try {
    if (queue) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // The in-memory queue remains usable when session storage is unavailable.
  }
}

export function queueProgress(queue: UnoUnassignedQueueState) {
  return {
    completed: queue.results.length,
    total: queue.targets.length,
    remaining: Math.max(0, queue.targets.length - queue.results.length),
    currentCardId: queue.index < queue.targets.length ? queue.targets[queue.index].id : null,
    attention: queue.results.filter(result => result.status === 'partial').length,
  };
}

export function deferCurrentQueueItem(queue: UnoUnassignedQueueState): UnoUnassignedQueueState {
  if(queue.status!=='paused'||queue.index>=queue.targets.length)return queue;
  const target=queue.targets[queue.index],nextIndex=queue.index+1;
  const deferred:UnoUnassignedQueueResult={cardId:target.id,jobId:queue.currentJobId??'',status:'partial',detail:'本项已保留，稍后可从未组织池单独处理。'};
  const results=[...queue.results.filter(row=>row.cardId!==target.id),deferred];
  return {...queue,index:nextIndex,currentJobId:null,currentRequestId:null,results,
    status:nextIndex<queue.targets.length?'running':'completed',
    message:nextIndex<queue.targets.length?`已保留当前项目，准备处理 ${nextIndex+1} / ${queue.targets.length}。`:'连续处理已结束；保留的项目可稍后单独处理。'};
}

function wait(delay: number) {
  return new Promise(resolve => window.setTimeout(resolve, delay));
}

interface QueueCallbacks {
  onJob?: (job: UnoJob) => void;
  onSettled?: (queue: UnoUnassignedQueueState) => void;
}

export function useUnoUnassignedQueue({ onJob, onSettled }: QueueCallbacks = {}) {
  const [queue, setQueue] = useState<UnoUnassignedQueueState | null>(() => readUnoUnassignedQueue());
  const queueRef = useRef(queue);
  const runningRef = useRef(false);
  const callbacksRef = useRef({ onJob, onSettled });

  useEffect(() => { callbacksRef.current = { onJob, onSettled }; }, [onJob, onSettled]);

  const replaceQueue = useCallback((next: UnoUnassignedQueueState | null) => {
    queueRef.current = next;
    saveQueue(next);
    setQueue(next);
    return next;
  }, []);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      while (queueRef.current && ['running', 'stopping'].includes(queueRef.current.status)) {
        let current = queueRef.current;
        if (current.index >= current.targets.length) {
          const finished = replaceQueue({ ...current, status: 'completed', currentJobId: null,
            message: current.results.some(result => result.status === 'partial') ? '连续处理已结束；部分卡片仍需人工判断。' : '连续处理已完成。' });
          if (finished) callbacksRef.current.onSettled?.(finished);
          break;
        }

        const target = current.targets[current.index];
        const cardId = target.id;
        let job: UnoJob;
        try {
          if (current.currentJobId) job = await fetchUnoJob(current.currentJobId, AbortSignal.timeout(10000));
          else {
            const requestId = current.currentRequestId ?? globalThis.crypto.randomUUID();
            if (!current.currentRequestId) current = replaceQueue({ ...current, currentRequestId: requestId })!;
            if (target.kind === 'repair') {
              const detail = await fetchUnoRepair(cardId, AbortSignal.timeout(10000));
              job = detail.active_repair_job && ['running', 'paused', 'review'].includes(detail.repair_status ?? '')
                ? await fetchUnoJob(detail.active_repair_job, AbortSignal.timeout(10000))
                : await repairUnoCandidate(detail, current.libraryId, '', '', requestId);
            } else {
              job = current.mode === 'recompile'
                ? await recompileUnoUnassignedCard(cardId, current.libraryId, requestId)
                : await organizeUnoUnassignedCard(cardId, current.libraryId, requestId);
            }
            current = replaceQueue({ ...queueRef.current!, currentJobId: job.id,
              message: `正在处理 ${current.index + 1} / ${current.targets.length}：${cardId}` })!;
            callbacksRef.current.onJob?.(job);
          }

          while (ACTIVE_JOB_STATES.has(job.status)) {
            await wait(1500);
            job = await fetchUnoJob(job.id, AbortSignal.timeout(10000));
          }
        } catch (error) {
          const paused = replaceQueue({ ...queueRef.current!, status: 'paused',
            message: `连续处理已暂停：${error instanceof Error ? error.message : String(error)}` });
          if (paused) callbacksRef.current.onSettled?.(paused);
          break;
        }

        current = queueRef.current!;
        if (job.status === 'completed' || job.status === 'partial') {
          const result: UnoUnassignedQueueResult = { cardId, jobId: job.id, status: job.status, detail: job.detail };
          const results = [...current.results.filter(row => row.cardId !== cardId), result];
          const nextIndex = current.index + 1;
          if (current.status === 'stopping') {
            const stopped = replaceQueue({ ...current, index: nextIndex, currentJobId: null, currentRequestId: null, results, status: 'paused',
              message: `已在当前项目结算后停止；还有 ${Math.max(0, current.targets.length - nextIndex)} 项未处理。` });
            if (stopped) callbacksRef.current.onSettled?.(stopped);
            break;
          }
          replaceQueue({ ...current, index: nextIndex, currentJobId: null, currentRequestId: null, results,
            message: nextIndex < current.targets.length ? `已结算 ${nextIndex} / ${current.targets.length}，准备下一项。` : '正在完成队列结算。' });
          continue;
        }

        const blocked = replaceQueue({ ...current, status: 'paused',
          message: `连续处理已在 ${cardId} 暂停：${job.detail || job.status}` });
        if (blocked) callbacksRef.current.onSettled?.(blocked);
        break;
      }
    } finally {
      runningRef.current = false;
    }
  }, [replaceQueue]);

  useEffect(() => {
    if (queueRef.current && ['running', 'stopping'].includes(queueRef.current.status)) void run();
  }, [run]);

  const start = useCallback((mode: UnoUnassignedQueueMode, targets: UnoUnassignedQueueTarget[], libraryId: string) => {
    const seen = new Set<string>();
    const uniqueTargets = targets.filter(target => target.id && !seen.has(target.id) && seen.add(target.id));
    if (!uniqueTargets.length) throw new Error('连续处理至少需要一个未组织项目。');
    const next: UnoUnassignedQueueState = { version: 2, libraryId, mode, targets: uniqueTargets, index: 0, currentJobId: null, currentRequestId: null,
      status: 'running', results: [], message: `准备逐项处理 ${uniqueTargets.length} 个未组织项目。`, startedAt: new Date().toISOString() };
    replaceQueue(next);
    void run();
  }, [replaceQueue, run]);

  const stopAfterCurrent = useCallback(() => {
    const current = queueRef.current;
    if (!current || current.status !== 'running') return;
    replaceQueue({ ...current, status: 'stopping', message: '当前卡片结算后停止，不再启动下一张。' });
  }, [replaceQueue]);

  const resume = useCallback(() => {
    const current = queueRef.current;
    if (!current || current.status !== 'paused') return;
    replaceQueue({ ...current, status: 'running', message: current.currentJobId ? '正在重新核对当前任务状态。' : '正在继续剩余队列。' });
    void run();
  }, [replaceQueue, run]);

  const deferCurrent = useCallback(() => {
    const current=queueRef.current;
    if(!current||current.status!=='paused'||current.index>=current.targets.length)return;
    const next=replaceQueue(deferCurrentQueueItem(current));
    if(!next)return;
    if(next.status==='running')void run();
    else callbacksRef.current.onSettled?.(next);
  },[replaceQueue,run]);

  const clear = useCallback(() => {
    if (queueRef.current && ['running', 'stopping'].includes(queueRef.current.status)) return;
    replaceQueue(null);
  }, [replaceQueue]);

  return { queue, start, stopAfterCurrent, resume, deferCurrent, clear };
}
