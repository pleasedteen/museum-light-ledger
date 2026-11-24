import type {
  BatchItemFailure,
  BatchItemReceipt,
  BatchItemRequest,
  BatchReceipt,
  MaterialOp,
  ParseResult,
  State,
  TimelineEntry,
} from './types.js';
import { applyMaterial, deriveIssuesForRecord } from './ingest.js';
import { parseMediaType, runParse } from './parse-dispatch.js';
import { hashString } from './parse-utils.js';
import { Store } from './store.js';

export interface BatchRequest {
  batchId: string;
  items: BatchItemRequest[];
  clientToken?: string;
  /** 仅测试钩子：校验阶段暂停若干毫秒，用于确定性地制造“校验期间并发订正” */
  testPauseMs?: number;
}

/** 整批校验失败：携带逐份失败原因，整批不生效 */
export class BatchValidationError extends Error {
  readonly status = 422;
  constructor(
    readonly failures: BatchItemFailure[],
    message = 'batch validation failed',
  ) {
    super(message);
  }
}

/** 同一批号换内容：冲突，整批不生效 */
export class BatchConflictError extends Error {
  readonly status = 409;
  constructor(readonly batchId: string) {
    super(`batchId ${batchId} already used with different content`);
  }
}

export interface BatchPublishResult {
  receipt: BatchReceipt;
  idempotentHit: boolean;
  operationSeq: number;
}

const OPS: MaterialOp[] = ['ingest', 'correct', 'withdraw'];

/** 批次内容哈希：规范化字段后做稳定序列化，与送达顺序一致 */
export function batchContentHash(req: BatchRequest): string {
  const canonical = req.items.map((it) => [
    it.materialId,
    it.fileName,
    parseMediaType(it.fileName, it.mediaType),
    it.op ?? 'ingest',
    it.content,
  ]);
  return hashString(JSON.stringify(canonical));
}

interface PreparedItem {
  index: number;
  request: BatchItemRequest;
  op: MaterialOp;
  parsed: ParseResult;
}

function failure(
  index: number,
  it: BatchItemRequest,
  code: string,
  detail: string,
): BatchItemFailure {
  return {
    index,
    materialId: it?.materialId ?? '',
    fileName: it?.fileName ?? '',
    op: (it?.op ?? 'ingest') as MaterialOp,
    errorCode: code,
    errorDetail: detail,
  };
}

/**
 * 解析与校验（纯计算，不改状态）。
 * 校验期间可以有await让出事件循环，保管员仍能提交批外订正；发布阶段才读最新状态。
 */
export async function prepareBatch(state: State, req: BatchRequest): Promise<PreparedItem[]> {
  const failures: BatchItemFailure[] = [];

  if (!Array.isArray(req.items) || req.items.length === 0) {
    throw new BatchValidationError([failure(0, {} as BatchItemRequest, 'empty-batch', 'items 为空')]);
  }

  const seenMaterial = new Set<string>();
  const prepared: PreparedItem[] = [];

  // 测试钩子：在校验阶段（尚未发布）暂停，让并发的批外操作得以发生
  if (typeof req.testPauseMs === 'number' && req.testPauseMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, req.testPauseMs));
  }

  for (let index = 0; index < req.items.length; index++) {
    const it = req.items[index] as BatchItemRequest;
    // 每份之间让出事件循环：校验期间不阻塞批外操作
    await new Promise<void>((resolve) => setImmediate(resolve));

    if (!it || typeof it !== 'object') {
      failures.push(failure(index, {} as BatchItemRequest, 'invalid-request', '材料项不是对象'));
      continue;
    }
    if (!it.materialId || typeof it.materialId !== 'string') {
      failures.push(failure(index, it, 'invalid-request', 'materialId 缺失'));
      continue;
    }
    if (!it.fileName || typeof it.fileName !== 'string') {
      failures.push(failure(index, it, 'invalid-request', 'fileName 缺失'));
      continue;
    }
    if (typeof it.content !== 'string') {
      failures.push(failure(index, it, 'invalid-request', 'content 缺失'));
      continue;
    }
    const op = (it.op ?? 'ingest') as MaterialOp;
    if (!OPS.includes(op)) {
      failures.push(failure(index, it, 'unsupported-op', `不支持的操作：${String(it.op)}`));
      continue;
    }
    if (seenMaterial.has(it.materialId)) {
      failures.push(failure(index, it, 'duplicate-material', `同一批次内重复材料：${it.materialId}`));
      continue;
    }
    seenMaterial.add(it.materialId);

    if (op === 'correct' || op === 'withdraw') {
      const versions = state.materials[it.materialId];
      const hasActive = Array.isArray(versions) && versions.some((m) => m.status === 'active');
      if (!hasActive) {
        failures.push(
          failure(index, it, 'unknown-material', `${op} 引用的材料不存在或没有活动版本：${it.materialId}`),
        );
        continue;
      }
    }

    let parsed: ParseResult;
    try {
      parsed = runParse(it);
    } catch (err) {
      failures.push(failure(index, it, 'parse-error', (err as Error).message));
      continue;
    }
    if (parsed.layout === 'unknown' || parsed.candidates.length === 0) {
      failures.push(
        failure(index, it, 'empty-material', `未能识别版式或未解析出任何候选（layout=${parsed.layout}）`),
      );
      continue;
    }
    prepared.push({ index, request: it, op, parsed });
  }

  if (failures.length > 0) throw new BatchValidationError(failures);
  return prepared;
}

/**
 * 原子发布整批：在单次 store.commit 事务内完成。
 *  - 若已存在同批号同内容：直接重放首次逐份回执（idempotentHit）
 *  - 若同批号不同内容：抛 BatchConflictError（整批回滚）
 *  - 逐份按送达顺序应用，全部成功后才算发布
 *  - 发布后按整批生效结果重算受影响邻域的复核项
 */
export function publishBatch(
  store: Store,
  req: BatchRequest,
  prepared: PreparedItem[],
): BatchPublishResult {
  const contentHash = batchContentHash(req);
  let result: BatchPublishResult | null = null;

  store.commit(
    (draft) => {
      const existing = draft.batches[req.batchId];
      if (existing) {
        if (existing.contentHash !== contentHash) throw new BatchConflictError(req.batchId);
        // 原批重送：原样重放首次逐份回执，不改变任何规范表/复核
        result = { receipt: existing, idempotentHit: true, operationSeq: existing.operationSeq };
        return;
      }

      const items: BatchItemReceipt[] = [];

      // 在应用之前快照受影响坐标：新记录（解析候选）+ 被 correct/withdraw 触及的
      // 批外旧记录（它们会移出时间线，但邻域仍需重算）
      const affected = snapshotAffected(draft, prepared);

      for (const prep of prepared) {
        // 发布基于最新状态（解析/校验期间可能有批外订正）：逐份权威复核引用有效性
        if (prep.op === 'correct' || prep.op === 'withdraw') {
          const versions = draft.materials[prep.request.materialId] ?? [];
          const hasActive = versions.some((m) => m.status === 'active');
          if (!hasActive) {
            throw new BatchValidationError(
              [
                failure(
                  prep.index,
                  prep.request,
                  'unknown-material',
                  `${prep.op} 引用的材料在发布时已不存在活动版本：${prep.request.materialId}`,
                ),
              ],
              'batch invalidated at publish time',
            );
          }
        }
        const outcome = applyMaterial(store, draft, { ...prep.request, op: prep.op }, prep.parsed, {
          derive: false,
        });
        items.push({
          index: prep.index,
          materialId: prep.request.materialId,
          fileName: prep.request.fileName,
          op: prep.op,
          version: outcome.version,
          idempotentHit: outcome.idempotentHit,
          recordKeys: outcome.recordKeys,
          layout: prep.parsed.layout,
          candidateCount: prep.parsed.candidates.length,
        });
      }

      // 区间由查询时按最新规范表实时计算；复核项在此按“整批生效后”的状态重算。
      recomputeReviews(store, draft, affected);

      // 记录回执序号：在事务内即可确定（commit 随后会把 seq 自增到该值）
      const receipt: BatchReceipt = {
        batchId: req.batchId,
        contentHash,
        itemCount: items.length,
        receivedAt: Date.now(),
        publishedAt: Date.now(),
        operationSeq: draft.seq + 1,
        outcome: 'published',
        items,
      };
      draft.batches[req.batchId] = receipt;
      result = { receipt, idempotentHit: false, operationSeq: receipt.operationSeq };
    },
    {
      op: 'batch',
      batchId: req.batchId,
      clientToken: req.clientToken,
      recordKeys: [],
      summary: `batch ${req.batchId} (${prepared.length} items)`,
    },
  );

  const r = result as unknown as BatchPublishResult | null;
  if (!r) throw new Error('batch publish produced no result');
  return r;
}

/** 收集批次触及的 柜/时刻：新记录（由解析结果得到）+ 这些材料旧版本记录（撤回/更正会移除） */
function snapshotAffected(draft: State, prepared: PreparedItem[]): Map<string, Set<string>> {
  const affected = new Map<string, Set<string>>();
  const add = (cabinet: string, time: string) => {
    if (!cabinet || !time) return;
    (affected.get(cabinet) ?? affected.set(cabinet, new Set()).get(cabinet)!).add(time);
  };

  for (const prep of prepared) {
    // 新记录：直接从解析候选得到坐标（此时尚未写入时间线）
    for (const cand of prep.parsed.candidates) {
      add(cand.cabinet || 'UNASSIGNED', cand.time || 'UNKNOWN-TIME');
    }
    // 旧版本：correct/withdraw 会移出这些记录，仍需重算其所在邻域
    const versions = draft.materials[prep.request.materialId] ?? [];
    for (const v of versions) {
      for (const key of v.recordKeys) {
        const env = draft.records[key];
        if (!env) continue;
        const r = env.record;
        add(r.cabinet || 'UNASSIGNED', r.time || 'UNKNOWN-TIME');
      }
    }
  }
  return affected;
}

/**
 * 按整批生效后的规范表重算受影响邻域的复核项：
 * 对每个受影响柜，取其受影响时刻跨度（含跨度前后各一条记录），
 * 对跨度内每条活动记录做问题派生。
 * reopen=false：已确认/已订正的人工结论不会被重算推翻（问题消失则自动确认）。
 */
function recomputeReviews(store: Store, draft: State, affected: Map<string, Set<string>>): void {
  const targets = new Set<string>();
  // 受影响坐标上的全部活动记录（同一柜/时刻可能有来自不同材料的记录）
  for (const [cabinet, times] of affected) {
    for (const key of Object.keys(draft.records)) {
      const env = draft.records[key];
      if (!env || !env.active) continue;
      const r = env.record;
      if ((r.cabinet || 'UNASSIGNED') === cabinet && times.has(r.time || 'UNKNOWN-TIME')) {
        targets.add(key);
      }
    }
    if (times.size === 0) continue;
    const arr: TimelineEntry[] = draft.timeline[cabinet] ?? [];
    if (arr.length === 0) continue;
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of times) {
      lo = Math.min(lo, lowerBound(arr, t));
      hi = Math.max(hi, upperBound(arr, t));
    }
    // 跨度前后各多取一条，覆盖“端点相邻关系被批次改写”的既有记录
    const from = Math.max(0, lo - 1);
    const to = Math.min(arr.length, hi + 1);
    for (let k = from; k < to; k++) {
      const entry = arr[k];
      if (entry) targets.add(entry.recordKey);
    }
  }
  for (const key of targets) {
    const env = draft.records[key];
    if (!env || !env.active) continue;
    deriveIssuesForRecord(store, draft, env.record, { reopen: false });
  }
}

function lowerBound(arr: TimelineEntry[], time: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]!.time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(arr: TimelineEntry[], time: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]!.time <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 判断是否为已发布批次（供服务端快速路径与冲突判定） */
export function lookupBatch(state: State, batchId: string): BatchReceipt | null {
  return state.batches[batchId] ?? null;
}
