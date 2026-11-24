import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  fsyncSync,
  openSync,
  closeSync,
  appendFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  AccessCounters,
  CandidateRecord,
  State,
  StoredRecord,
  TimelineEntry,
} from './types.js';

export function emptyCounters(): AccessCounters {
  return { recordReads: 0, recordWrites: 0, indexReads: 0, indexWrites: 0, requests: 0, resetAt: null };
}

export function emptyState(): State {
  return {
    seq: 0,
    materials: {},
    records: {},
    reviews: {},
    timeline: {},
    operations: [],
    counters: emptyCounters(),
  };
}

interface JournalEntry {
  seq: number;
  type: 'operation';
  /** 完整状态快照（足够小，单条操作只动少量记录） */
  state: State;
}

/**
 * 崩溃安全存储。
 * 文件布局（dataDir）：
 *   snapshot.json        —— 最近一次压缩快照（tmp + rename 原子替换）
 *   journal.log          —— 追加写操作日志，每条 fsync 后才算生效
 *   journal.tmp 等       —— 中断残留，重启时忽略
 *
 * 不变式：规范表（timeline/records）与复核状态（reviews）在同一条日志项的
 * 同一份 State 里，要么整条可见，要么整条不可见。
 */
export class Store {
  private state: State;
  private readonly snapshotPath: string;
  private readonly journalPath: string;
  private readonly dir: string;
  /** 启动后重放/压缩用的日志条数 */
  private journalEntries = 0;
  /** 每请求计数 */
  private perRequest = emptyCounters();

  /** 事务内对 draft 的访问记账，commit 换入状态后一次性计入 */
  private txnTally: AccessCounters | null = null;

  constructor(dataDir: string) {
    this.dir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.snapshotPath = join(dataDir, 'snapshot.json');
    this.journalPath = join(dataDir, 'journal.log');
    this.state = this.load();
  }

  private load(): State {
    let state = emptyState();
    if (existsSync(this.snapshotPath)) {
      try {
        state = JSON.parse(readFileSync(this.snapshotPath, 'utf8')) as State;
      } catch (err) {
        // 快照损坏（写入中断只会留下 tmp，正常不会发生）：从空状态重放
        state = emptyState();
      }
    }
    this.journalEntries = 0;
    if (existsSync(this.journalPath)) {
      const lines = readFileSync(this.journalPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
      for (const line of lines) {
        let entry: JournalEntry;
        try {
          entry = JSON.parse(line) as JournalEntry;
        } catch {
          // 日志尾部半条（写入中断）：停止重放，前面已 fsync 的完整条目保留
          break;
        }
        if (entry.type === 'operation' && entry.seq > state.seq) {
          state = entry.state;
          this.journalEntries += 1;
        }
      }
    }
    return state;
  }

  getState(): State {
    return this.state;
  }

  // ---- 受限的、带计数的记录访问接口（规范化/查询只能通过这些方法触达记录） ----

  beginRequest(): void {
    this.perRequest = emptyCounters();
    this.state.counters.requests += 1;
    this.perRequest.requests = 1;
  }

  getPerRequestCounters(): AccessCounters {
    return { ...this.perRequest };
  }

  getCounters(): AccessCounters {
    return { ...this.state.counters };
  }

  resetCounters(): void {
    this.state.counters = { ...emptyCounters(), resetAt: Date.now() };
  }

  /** 按键读一条记录；不存在返回 null。每次调用记一次 recordReads。 */
  readRecord(key: string): StoredRecord | null {
    this.state.counters.recordReads += 1;
    this.perRequest.recordReads += 1;
    return this.state.records[key] ?? null;
  }

  /** 事务内读 draft 记录（同样计入访问量，保证计数可核对） */
  draftReadRecord(draft: State, key: string): StoredRecord | null {
    this.tally('recordReads');
    return draft.records[key] ?? null;
  }

  /** 写一条记录信封。 */
  writeRecord(key: string, envelope: StoredRecord): void {
    this.state.records[key] = envelope;
    this.state.counters.recordWrites += 1;
    this.perRequest.recordWrites += 1;
  }

  /** 事务内写 draft 记录 */
  draftWriteRecord(draft: State, key: string, envelope: StoredRecord): void {
    draft.records[key] = envelope;
    this.tally('recordWrites');
  }

  /**
   * 在某柜时间线索引中按时刻二分定位（返回插入位/命中位）。
   * 只计一次 indexReads——与该柜历史长度无关。
   */
  locateInTimeline(cabinet: string, time: string): { index: number; entry: TimelineEntry | null } {
    this.state.counters.indexReads += 1;
    this.perRequest.indexReads += 1;
    const arr = this.state.timeline[cabinet] ?? [];
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid]!.time < time) lo = mid + 1;
      else hi = mid;
    }
    return { index: lo, entry: arr[lo] && arr[lo]!.time === time ? arr[lo]! : null };
  }

  /** 时间线区间切片：按位置读取一段索引项（计一次 indexReads）。 */
  timelineSlice(cabinet: string, fromTime: string | null, toTime: string | null): TimelineEntry[] {
    this.state.counters.indexReads += 1;
    this.perRequest.indexReads += 1;
    const arr = this.state.timeline[cabinet] ?? [];
    const start = fromTime ? lowerBound(arr, fromTime) : 0;
    const end = toTime ? upperBound(arr, toTime) : arr.length;
    return arr.slice(start, end);
  }

  /** 定点插入/替换一条时间线索引项（计一次 indexWrites，与历史长度无关）。 */
  upsertTimeline(entry: TimelineEntry): void {
    const arr = (this.state.timeline[entry.cabinet] ??= []);
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid]!.time < entry.time) lo = mid + 1;
      else hi = mid;
    }
    if (arr[lo] && arr[lo]!.time === entry.time) {
      if (arr[lo]!.recordKey !== entry.recordKey) arr[lo] = entry;
    } else {
      arr.splice(lo, 0, entry);
    }
    this.state.counters.indexWrites += 1;
    this.perRequest.indexWrites += 1;
  }

  /** 事务内定点写入 draft 时间线索引 */
  draftUpsertTimeline(draft: State, entry: TimelineEntry): void {
    const arr = (draft.timeline[entry.cabinet] ??= []);
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid]!.time < entry.time) lo = mid + 1;
      else hi = mid;
    }
    if (arr[lo] && arr[lo]!.time === entry.time) {
      if (arr[lo]!.recordKey !== entry.recordKey) arr[lo] = entry;
    } else {
      arr.splice(lo, 0, entry);
    }
    this.tally('indexWrites');
  }

  /** 定点移除一条时间线索引项。 */
  removeTimeline(cabinet: string, time: string, recordKey: string): void {
    const arr = this.state.timeline[cabinet];
    if (!arr) return;
    const { index, entry } = this.locateInTimeline(cabinet, time);
    if (entry && entry.recordKey === recordKey) {
      arr.splice(index, 1);
      this.state.counters.indexWrites += 1;
      this.perRequest.indexWrites += 1;
    }
  }

  /** 事务内定点移除 draft 时间线索引项 */
  draftRemoveTimeline(draft: State, cabinet: string, time: string, recordKey: string): void {
    const arr = draft.timeline[cabinet];
    if (!arr) return;
    const pos = arr.findIndex((e) => e.time === time && e.recordKey === recordKey);
    if (pos >= 0) {
      arr.splice(pos, 1);
      this.tally('indexWrites');
    }
  }

  private tally(kind: keyof Omit<AccessCounters, 'requests' | 'resetAt'>): void {
    if (this.txnTally) {
      this.txnTally[kind] += 1;
      this.perRequest[kind] += 1;
    } else {
      this.state.counters[kind] += 1;
      this.perRequest[kind] += 1;
    }
  }

  // ---- 原子提交 ----

  commit(mutate: (draft: State) => void, meta: Omit<import('./types.js').OperationRecord, 'seq' | 'appliedAt'>): import('./types.js').OperationRecord {
    const draft: State = structuredClone(this.state);
    this.txnTally = emptyCounters();
    try {
      mutate(draft);
    } catch (err) {
      // 事务失败：回滚全部内存改动与计数
      this.perRequest = emptyCounters();
      this.txnTally = null;
      throw err;
    }
    // 事务内记账并入 draft（与规范表、复核状态一起原子生效）
    draft.counters.recordReads += this.txnTally.recordReads;
    draft.counters.recordWrites += this.txnTally.recordWrites;
    draft.counters.indexReads += this.txnTally.indexReads;
    draft.counters.indexWrites += this.txnTally.indexWrites;
    this.txnTally = null;

    draft.seq += 1;
    const opRec: import('./types.js').OperationRecord = {
      seq: draft.seq,
      appliedAt: Date.now(),
      ...meta,
    };
    draft.operations.push(opRec);

    const entry: JournalEntry = { seq: draft.seq, type: 'operation', state: draft };
    const line = JSON.stringify(entry) + '\n';
    const fd = openSync(this.journalPath, 'a');
    try {
      appendFileSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.state = draft;
    this.journalEntries += 1;
    if (this.journalEntries >= 20) this.compact();
    return opRec;
  }

  /** 把当前状态压缩成快照，并清空日志。全程 tmp+rename，中断不破坏旧状态。 */
  compact(): void {
    const tmpSnap = join(this.dir, `snapshot.tmp-${process.pid}`);
    const tmpJournal = join(this.dir, `journal.tmp-${process.pid}`);
    writeFileSync(tmpSnap, JSON.stringify(this.state));
    const fd = openSync(tmpSnap, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // 先原子替换快照，再用空日志原子替换旧日志
    renameSync(tmpSnap, this.snapshotPath);
    writeFileSync(tmpJournal, '');
    renameSync(tmpJournal, this.journalPath);
    this.journalEntries = 0;
  }

  // ---- 测试/运维辅助 ----

  listFiles(): string[] {
    return readdirSync(this.dir).sort();
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

export function recordKeyOf(materialId: string, cabinet: string, time: string, kind: string): string {
  return `${materialId}|${cabinet}|${time}|${kind}`;
}

export function intervalId(cabinet: string, fromTime: string, toTime: string): string {
  return `${cabinet}@${fromTime}->${toTime}`;
}

export type { CandidateRecord };
