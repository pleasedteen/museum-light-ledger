import type {
  CandidateRecord,
  Interval,
  ReviewItem,
  SourceRef,
  StoredRecord,
} from './types.js';
import { intervalId, Store } from './store.js';

interface TimelinePoint {
  time: string;
  recordKey: string;
  kind: 'reading' | 'meter-change';
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * 把任意可解析的时刻边界归一成与存储一致的 'YYYY-MM-DDTHH:mm:ssZ'。
 * 避免调用方 toISOString() 带 .000Z 毫秒段时，字符串字典序把同一时刻
 * 误判到边界另一侧；无法解析时原样返回。
 */
export function canonicalBoundary(time: string | null | undefined): string | null {
  if (time === null || time === undefined || time === '') return null;
  const ms = Date.parse(time);
  if (Number.isNaN(ms)) return time;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 读取某柜时间线上的活动记录并计算相邻巡检区间。
 * 访问量（可核对）：
 *   - from 存在时 1 次 indexReads 二分找锚点前一条，再加 1 次 timelineSlice
 *     二分截窗（共 ≤2 次索引访问）；不再 null-null 切片复制整柜索引。
 *   - 窗口内每个时间点恰好 1 次 recordReads——同一记录在整个查询中只读一次。
 *   - 复核项走 recordKey 二级索引并在本次查询内缓存，每条复核项只读一次，
 *     reviewReads = O(窗口内记录的待核项)，与复核表总条数/柜历史长度无关。
 */
export function queryIntervals(
  store: Store,
  cabinet: string,
  fromTimeRaw: string | null,
  toTimeRaw: string | null,
): Interval[] {
  const fromTime = canonicalBoundary(fromTimeRaw);
  const toTime = canonicalBoundary(toTimeRaw);
  // 第一次索引访问（有 from 时）：二分定位窗口起点，锚点取其前一条
  let anchorTime: string | null = null;
  if (fromTime) {
    const loc = store.locateInTimeline(cabinet, fromTime);
    const arr = store.getState().timeline[cabinet] ?? [];
    const anchorPos = Math.max(0, loc.index - 1);
    anchorTime = arr[anchorPos]?.time ?? null;
  }
  // 第二次索引访问：只切出 [锚点时刻, 窗口终点] 的一小段索引项
  const windowEntries = store.timelineSlice(cabinet, anchorTime, toTime);

  // 同一 recordKey 的复核项在一次查询内只经二级索引读取一次
  const reviewCache = new Map<string, ReviewItem[]>();
  const pendingReasonsFor = (recordKey: string): string[] => {
    let items = reviewCache.get(recordKey);
    if (!items) {
      items = store.reviewsForRecord(recordKey);
      reviewCache.set(recordKey, items);
    }
    const reasons: string[] = [];
    for (const item of items) {
      if (item.state === 'pending') reasons.push(item.reason);
    }
    return reasons;
  };

  // 每个窗口内记录恰好读取一次，缓存到 map 供各区间复用，杜绝重复 recordReads
  const recordMap = new Map<string, StoredRecord>();
  const readings: TimelinePoint[] = [];
  const meterChanges: TimelinePoint[] = [];

  for (const e of windowEntries) {
    const env: StoredRecord | null = store.readRecord(e.recordKey);
    if (!env || !env.active) continue;
    if (env.record.cabinet !== cabinet) continue;
    recordMap.set(e.recordKey, env);
    (env.record.kind === 'meter-change' ? meterChanges : readings).push({
      time: e.time,
      recordKey: e.recordKey,
      kind: env.record.kind,
    });
  }

  if (readings.length < 2) return [];

  const intervals: Interval[] = [];
  for (let i = 0; i < readings.length - 1; i++) {
    const start = readings[i]!;
    const end = readings[i + 1]!;
    const seams = meterChanges.filter((m) => m.time > start.time && m.time <= end.time);
    intervals.push(buildInterval(recordMap, pendingReasonsFor, start, end, seams));
  }
  return intervals;
}

function buildInterval(
  recordMap: Map<string, StoredRecord>,
  pendingReasonsFor: (recordKey: string) => string[],
  start: TimelinePoint,
  end: TimelinePoint,
  seamPoints: TimelinePoint[],
): Interval {
  const startRec: CandidateRecord = recordMap.get(start.recordKey)!.record;
  const endRec: CandidateRecord = recordMap.get(end.recordKey)!.record;

  const pendingReasons = new Set<string>();
  const evidence: SourceRef[] = [startRec.source, endRec.source];

  pendingReasonsFor(start.recordKey).forEach((r) => pendingReasons.add(`起点:${r}`));
  pendingReasonsFor(end.recordKey).forEach((r) => pendingReasons.add(`终点:${r}`));

  // 区间内换表事件（按时间先后），全部来自已缓存的记录，无额外 recordReads
  const meterChanges: Interval['meterChanges'] = [];
  let seamPending = false;

  for (const p of seamPoints) {
    const env = recordMap.get(p.recordKey);
    if (!env || !env.active) continue;
    const m = env.record;
    const reasons = pendingReasonsFor(m.key);
    reasons.forEach((r) => pendingReasons.add(`换表:${r}`));
    evidence.push(m.source);
    meterChanges.push({
      time: m.time,
      oldFinal: m.oldFinal,
      newStart: m.newStart,
      recordKey: m.key,
    });
    if (m.oldFinal === null || m.newStart === null || reasons.length > 0) seamPending = true;
  }

  // 计算增量：逐段拼接（当前表段 -> 旧表终值，换表后从新表起值重新累计）
  let cursorValue = startRec.value;
  let uncomputable = startRec.value === null || endRec.value === null;
  let delta = 0;

  for (const mc of meterChanges) {
    const m: CandidateRecord = recordMap.get(mc.recordKey)!.record;
    if (cursorValue === null || m.oldFinal === null || m.newStart === null) {
      uncomputable = true;
      break;
    }
    delta += round(m.oldFinal - cursorValue);
    cursorValue = m.newStart;
  }

  let finalDelta: number | null;
  if (!uncomputable && cursorValue !== null && endRec.value !== null) {
    delta += round(endRec.value - cursorValue);
    finalDelta = delta;
  } else {
    finalDelta = null;
  }

  // 无换表却出现读数下降 -> 异常（人工确认后仍保留 anomaly，只是不再待核）
  const isAnomaly = finalDelta !== null && meterChanges.length === 0 && finalDelta < 0;
  if (isAnomaly) pendingReasons.add('negative-delta');

  let status: Interval['status'] = 'ok';
  if (isAnomaly) {
    // 仅当下降问题仍在复核队列时才同时待核
    if (pendingReasonsFor(end.recordKey).includes('negative-delta')) status = 'pending-review';
    else status = 'anomaly';
  } else if (pendingReasons.size > 0 || seamPending) {
    status = 'pending-review';
  }

  return {
    intervalId: intervalId(startRec.cabinet, startRec.time, endRec.time),
    cabinet: startRec.cabinet,
    fromTime: startRec.time,
    toTime: endRec.time,
    fromRecordKey: start.recordKey,
    toRecordKey: end.recordKey,
    delta: finalDelta,
    status,
    pendingReasons: Array.from(pendingReasons),
    meterChanges,
    evidence: dedupeEvidence(evidence),
  };
}

function dedupeEvidence(list: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const e of list) {
    const k = `${e.materialId}|${e.version}|${e.lines.join(',')}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out;
}
