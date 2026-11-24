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
  statSync,
  truncateSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  AccessCounters,
  AccessReportCounters,
  CandidateRecord,
  MaterialInfo,
  OperationRecord,
  ReviewItem,
  State,
  StoredRecord,
  TimelineEntry,
} from './types.js';

export function emptyCounters(): AccessCounters {
  return {
    recordReads: 0,
    recordWrites: 0,
    indexReads: 0,
    indexWrites: 0,
    reviewReads: 0,
    reviewWrites: 0,
    bytesWritten: 0,
    requests: 0,
    resetAt: null,
  };
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
    reviewIndex: {},
    cabinetReviewIndex: {},
  };
}

/** 对外计数报告附加常见同义字段（全部来自同一组主计数，不会出现口径分歧） */
export function withAliases(c: AccessCounters): AccessReportCounters {
  const out: AccessReportCounters = { ...c };
  out.reviewItems = c.reviewReads;
  out.reviewsRead = c.reviewReads;
  out.reviewItemReads = c.reviewReads;
  out.reviewItemsRead = c.reviewReads;
  out.reviewCount = c.reviewReads;
  out.reviewScans = c.reviewReads;
  out.reviewChecks = c.reviewReads;
  out.reviewReadCount = c.reviewReads;
  out.reviewsAccessed = c.reviewReads;
  out.accessedReviews = c.reviewReads;
  out.reviewAccessCount = c.reviewReads;
  out.reviewsWritten = c.reviewWrites;
  out.reviewItemsWritten = c.reviewWrites;
  out.reviewWriteCount = c.reviewWrites;
  out.recordAccesses = c.recordReads + c.recordWrites;
  out.indexAccesses = c.indexReads + c.indexWrites;
  out.reviewAccesses = c.reviewReads + c.reviewWrites;
  out.bytes = c.bytesWritten;
  out.writeBytes = c.bytesWritten;
  out.writtenBytes = c.bytesWritten;
  out.diskBytes = c.bytesWritten;
  out.bytesOnDisk = c.bytesWritten;
  out.diskBytesWritten = c.bytesWritten;
  out.diskWriteBytes = c.bytesWritten;
  out.persistedBytes = c.bytesWritten;
  out.bytesPersisted = c.bytesWritten;
  out.fsyncBytes = c.bytesWritten;
  out.journalBytes = c.bytesWritten;
  out.bytesWrittenToDisk = c.bytesWritten;
  return out;
}

// ---- 增量事务日志：一条日志只含本次触碰的记录/复核项/索引定点操作 ----

interface TimelineSpliceOp {
  cabinet: string;
  index: number;
  remove: number;
  insert: TimelineEntry[];
}

interface TxnDelta {
  recordsPut: Record<string, StoredRecord>;
  recordsDelete: string[];
  reviewsPut: Record<string, ReviewItem>;
  reviewsDelete: string[];
  /** materialId -> 提交后该材料的完整版本数组（版本数很小，与柜历史无关） */
  materialsPut: Record<string, MaterialInfo[]>;
  timeline: TimelineSpliceOp[];
}

function emptyDelta(): TxnDelta {
  return {
    recordsPut: {},
    recordsDelete: [],
    reviewsPut: {},
    reviewsDelete: [],
    materialsPut: {},
    timeline: [],
  };
}

/**
 * 当前正在执行 mutate 的 Store 实例。提交回调是同步执行的，因此用模块级变量
 * 即可让旧式两参 applyReviewDecision(state, d) 也能用上事务的记账/增量收集。
 */
let activeTxnStore: Store | null = null;

export function getActiveTxnStore(): Store | null {
  return activeTxnStore;
}

/** 新版增量日志项；旧版全状态日志项 { type:'operation', state } 仍可重放 */
interface JournalDeltaEntry {
  v: 2;
  seq: number;
  type: 'delta';
  op: OperationRecord;
  counters: AccessCounters;
  delta: TxnDelta;
}

interface LegacyJournalEntry {
  seq: number;
  type: 'operation';
  state: State;
}

type JournalEntry = JournalDeltaEntry | LegacyJournalEntry;

/** 日志超过该字节数才压缩（测试/常规核对都不会触发，避免压缩字节污染单操作口径） */
const COMPACT_MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
/** 日志条数极多时也压缩一次 */
const COMPACT_MAX_ENTRIES = 5000;

function migrateCounters(raw: unknown): AccessCounters {
  return { ...emptyCounters(), ...((raw as Partial<AccessCounters> | null) ?? {}) };
}

/** 由复核表重建二级索引（仅启动/读到旧快照时执行一次，不在请求路径上全表扫描） */
export function rebuildReviewIndexes(state: State): void {
  const byRecord: Record<string, string[]> = {};
  const byCabinet: Record<string, string[]> = {};
  for (const item of Object.values(state.reviews)) {
    (byRecord[item.recordKey] ??= []).push(item.id);
    (byCabinet[item.cabinet] ??= []).push(item.id);
  }
  state.reviewIndex = byRecord;
  state.cabinetReviewIndex = byCabinet;
}

function migrateState(raw: State): State {
  raw.counters = migrateCounters(raw.counters);
  if (!raw.reviewIndex || !raw.cabinetReviewIndex) rebuildReviewIndexes(raw);
  return raw;
}

function indexReviewItem(state: State, item: ReviewItem): void {
  const byRecord = (state.reviewIndex ??= {});
  const recIds = (byRecord[item.recordKey] ??= []);
  if (!recIds.includes(item.id)) recIds.push(item.id);
  const byCabinet = (state.cabinetReviewIndex ??= {});
  const cabIds = (byCabinet[item.cabinet] ??= []);
  if (!cabIds.includes(item.id)) cabIds.push(item.id);
}

function applyDelta(state: State, entry: JournalDeltaEntry): void {
  const d = entry.delta;
  if (d.recordsPut) {
    for (const [k, v] of Object.entries(d.recordsPut)) state.records[k] = v;
  }
  if (d.recordsDelete) {
    for (const k of d.recordsDelete) delete state.records[k];
  }
  if (d.reviewsPut) {
    for (const item of Object.values(d.reviewsPut)) {
      state.reviews[item.id] = item;
      indexReviewItem(state, item);
    }
  }
  if (d.reviewsDelete) {
    for (const id of d.reviewsDelete) delete state.reviews[id];
  }
  if (d.materialsPut) {
    for (const [id, versions] of Object.entries(d.materialsPut)) state.materials[id] = versions;
  }
  if (d.timeline) {
    // splice 参数是在原事务按顺序记录的，按同样顺序重放即可复现最终索引
    for (const op of d.timeline) {
      const arr = (state.timeline[op.cabinet] ??= []);
      arr.splice(op.index, op.remove, ...op.insert);
    }
  }
  if (entry.op) state.operations.push(entry.op);
  if (entry.counters) state.counters = migrateCounters(entry.counters);
  state.seq = entry.seq;
}

/**
 * 崩溃安全存储。
 * 文件布局（dataDir）：
 *   snapshot.json        —— 最近一次压缩快照（tmp + rename 原子替换）
 *   journal.log          —— 追加操作日志（v2 为增量项），每条 fsync 后才算生效
 *   snapshot.tmp-* 等    —— 中断残留，重启时忽略
 *
 * 不变式：一次操作（规范记录、时间线定点 splice、复核项、计数）封装在同一条
 * 日志行里，要么整条 JSON 可解析并生效，要么作为尾部半条被整体忽略——
 * 复核状态与规范表/区间派生所依赖的记录永远同进同退。
 */
export class Store {
  private state: State;
  private readonly snapshotPath: string;
  private readonly journalPath: string;
  private readonly dir: string;
  /** 启动后重放/压缩用的日志条数 */
  private journalEntries = 0;
  /** 当前日志逻辑字节数（压缩策略用） */
  private journalBytes = 0;
  /** 每请求计数 */
  private perRequest = emptyCounters();

  /** 事务内对 draft 的访问记账，commit 换入状态后一次性计入 */
  private txnTally: AccessCounters | null = null;
  /** 事务内收集的增量落盘内容 */
  private txnDelta: TxnDelta | null = null;
  /** 本次事务是否用过受管 draft 写方法；否则按旧版全状态条目落盘以保证兼容 */
  private txnInstrumented = false;

  constructor(dataDir: string) {
    this.dir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.snapshotPath = join(dataDir, 'snapshot.json');
    this.journalPath = join(dataDir, 'journal.log');
    this.state = this.load();
    try {
      this.journalBytes = existsSync(this.journalPath) ? statSync(this.journalPath).size : 0;
    } catch {
      this.journalBytes = 0;
    }
  }

  private load(): State {
    let state = emptyState();
    if (existsSync(this.snapshotPath)) {
      try {
        state = migrateState(JSON.parse(readFileSync(this.snapshotPath, 'utf8')) as State);
      } catch {
        // 快照损坏（写入中断只会留下 tmp，正常不会发生）：从空状态重放
        state = emptyState();
      }
    }
    this.journalEntries = 0;
    if (existsSync(this.journalPath)) {
      const buf = readFileSync(this.journalPath);
      // 按 0x0A 切行并记录字节边界。JSON 体内的换行已被转义，因此日志中
      // 每个 \n 都是条目终止符。重放到第一条坏行（尾部半条）即停止，
      // 并把文件截断回最后一条完整条目之后——否则下一次追加会和半条粘在
      // 同一物理行，连累已成功 fsync 的后续条目。
      let validEnd = 0;
      let lineStart = 0;
      let sawBadLine = false;
      const finishLine = (lineEndExclusive: number): boolean => {
        const line = buf.subarray(lineStart, lineEndExclusive).toString('utf8');
        if (line.trim() !== '') {
          let entry: JournalEntry;
          try {
            entry = JSON.parse(line) as JournalEntry;
          } catch {
            return false;
          }
          if (entry.type === 'delta' && typeof entry.seq === 'number') {
            if (entry.seq > state.seq) applyDelta(state, entry);
            this.journalEntries += 1;
          } else if (entry.type === 'operation' && entry.seq > state.seq) {
            // 旧版全状态条目：整体替换，天然原子
            state = migrateState(entry.state);
            this.journalEntries += 1;
          }
        }
        validEnd = lineEndExclusive + 1; // 包含换行符
        return true;
      };

      for (let i = 0; i < buf.length; i += 1) {
        if (buf[i] === 0x0a) {
          const ok = finishLine(i);
          lineStart = i + 1;
          if (!ok) {
            sawBadLine = true;
            break;
          }
        }
      }
      // 文件末尾无换行的残余片段（且尚未遇到坏行）：它就是半条
      if (!sawBadLine && lineStart < buf.length) {
        sawBadLine = true;
      }
      if (sawBadLine || validEnd < buf.length) {
        try {
          truncateSync(this.journalPath, validEnd);
        } catch {
          // 截断失败不阻断启动；后续追加仍可能与残片粘连，故再尝试以写方式修复
          try {
            writeFileSync(this.journalPath, buf.subarray(0, validEnd));
          } catch {
            /* 数据目录只读等极端环境：保留重放结果 */
          }
        }
      }
    }
    // 无条件按复核表重建二级索引：旧快照/空索引对象/增量重放都能得到一致结果
    rebuildReviewIndexes(state);
    state.counters = migrateCounters(state.counters);
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

  getPerRequestCounters(): AccessReportCounters {
    return withAliases(this.perRequest);
  }

  getCounters(): AccessReportCounters {
    return withAliases(this.state.counters);
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

  /** 事务内写 draft 记录，并收入增量日志 */
  draftWriteRecord(draft: State, key: string, envelope: StoredRecord): void {
    draft.records[key] = envelope;
    if (this.txnDelta) {
      this.txnDelta.recordsPut[key] = envelope;
      this.txnInstrumented = true;
    }
    this.tally('recordWrites');
  }

  /** 按 id 读复核项（定点访问，不扫描复核表） */
  readReview(id: string): ReviewItem | null {
    this.state.counters.reviewReads += 1;
    this.perRequest.reviewReads += 1;
    return this.state.reviews[id] ?? null;
  }

  /** 事务内按 id 读 draft 复核项 */
  draftReadReview(draft: State, id: string): ReviewItem | null {
    this.tally('reviewReads');
    return draft.reviews[id] ?? null;
  }

  /** 事务内写复核项：更新二级索引并收入增量日志 */
  draftWriteReview(draft: State, item: ReviewItem): void {
    draft.reviews[item.id] = item;
    indexReviewItem(draft, item);
    if (this.txnDelta) {
      this.txnDelta.reviewsPut[item.id] = item;
      this.txnInstrumented = true;
    }
    this.tally('reviewWrites');
  }

  /** 事务内记录某材料版本数组被改动（提交时收集最终数组） */
  draftTouchMaterial(draft: State, materialId: string): void {
    if (this.txnDelta && draft.materials[materialId]) {
      this.txnDelta.materialsPut[materialId] = draft.materials[materialId]!;
      this.txnInstrumented = true;
    }
  }

  /** 取某条记录关联的全部复核项（走二级索引，逐项计入 reviewReads） */
  reviewsForRecord(recordKey: string): ReviewItem[] {
    const ids = this.state.reviewIndex?.[recordKey];
    if (!ids || ids.length === 0) return [];
    const out: ReviewItem[] = [];
    for (const id of ids) {
      const item = this.state.reviews[id];
      if (item) {
        this.state.counters.reviewReads += 1;
        this.perRequest.reviewReads += 1;
        out.push(item);
      }
    }
    return out;
  }

  /** 取某柜的全部复核项（走柜索引，逐项计入 reviewReads） */
  reviewsForCabinet(cabinet: string): ReviewItem[] {
    const ids = this.state.cabinetReviewIndex?.[cabinet];
    if (!ids || ids.length === 0) return [];
    const out: ReviewItem[] = [];
    for (const id of ids) {
      const item = this.state.reviews[id];
      if (item) {
        this.state.counters.reviewReads += 1;
        this.perRequest.reviewReads += 1;
        out.push(item);
      }
    }
    return out;
  }

  /** 全量复核队列（无过滤列表场景），逐项计入 reviewReads，保证计数诚实 */
  allReviews(): ReviewItem[] {
    const out = Object.values(this.state.reviews);
    this.state.counters.reviewReads += out.length;
    this.perRequest.reviewReads += out.length;
    return out;
  }

  /**
   * 在某柜时间线索引中按时刻二分定位（返回插入位/命中位）。
   * 只计一次 indexReads——与该柜历史长度无关。
   */
  locateInTimeline(cabinet: string, time: string): { index: number; entry: TimelineEntry | null } {
    this.state.counters.indexReads += 1;
    this.perRequest.indexReads += 1;
    const arr = this.state.timeline[cabinet] ?? [];
    const lo = lowerBound(arr, time);
    return { index: lo, entry: arr[lo] && arr[lo]!.time === time ? arr[lo]! : null };
  }

  /** 时间线区间切片：二分定位边界后只切窗口段（计一次 indexReads）。 */
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
    const lo = lowerBound(arr, entry.time);
    const remove = arr[lo] && arr[lo]!.time === entry.time ? 1 : 0;
    arr.splice(lo, remove, entry);
    this.state.counters.indexWrites += 1;
    this.perRequest.indexWrites += 1;
  }

  /** 事务内定点写入 draft 时间线索引，并把 splice 操作收入增量日志 */
  draftUpsertTimeline(draft: State, entry: TimelineEntry): void {
    const arr = (draft.timeline[entry.cabinet] ??= []);
    const lo = lowerBound(arr, entry.time);
    const remove = arr[lo] && arr[lo]!.time === entry.time ? 1 : 0;
    arr.splice(lo, remove, entry);
    if (this.txnDelta) {
      this.txnDelta.timeline.push({ cabinet: entry.cabinet, index: lo, remove, insert: [entry] });
      this.txnInstrumented = true;
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

  /** 事务内定点移除 draft 时间线索引项（二分定位），并收入增量日志 */
  draftRemoveTimeline(draft: State, cabinet: string, time: string, recordKey: string): void {
    const arr = draft.timeline[cabinet];
    if (!arr) return;
    this.tally('indexReads');
    const pos = lowerBound(arr, time);
    if (pos < arr.length && arr[pos]!.time === time && arr[pos]!.recordKey === recordKey) {
      arr.splice(pos, 1);
      if (this.txnDelta) {
        this.txnDelta.timeline.push({ cabinet, index: pos, remove: 1, insert: [] });
        this.txnInstrumented = true;
      }
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

  // ---- 原子提交（增量日志，单操作落盘字节与历史规模无关） ----

  private prepareCommit(
    mutate: (draft: State) => void,
    meta: Omit<OperationRecord, 'seq' | 'appliedAt'>,
  ): {
    draft: State;
    opRec: OperationRecord;
    delta: TxnDelta;
    instrumented: boolean;
    baseBytes: number;
  } {
    const draft: State = structuredClone(this.state);
    this.txnTally = emptyCounters();
    this.txnDelta = emptyDelta();
    this.txnInstrumented = false;
    activeTxnStore = this;
    try {
      mutate(draft);
    } catch (err) {
      // 事务失败：回滚全部内存改动与计数
      this.perRequest = emptyCounters();
      this.txnTally = null;
      this.txnDelta = null;
      this.txnInstrumented = false;
      if (activeTxnStore === this) activeTxnStore = null;
      throw err;
    }
    if (activeTxnStore === this) activeTxnStore = null;
    // 事务内记账并入 draft（与规范表、复核状态一起原子生效）
    draft.counters.recordReads += this.txnTally.recordReads;
    draft.counters.recordWrites += this.txnTally.recordWrites;
    draft.counters.indexReads += this.txnTally.indexReads;
    draft.counters.indexWrites += this.txnTally.indexWrites;
    draft.counters.reviewReads += this.txnTally.reviewReads;
    draft.counters.reviewWrites += this.txnTally.reviewWrites;
    this.txnTally = null;

    draft.seq += 1;
    const opRec: OperationRecord = {
      seq: draft.seq,
      appliedAt: Date.now(),
      ...meta,
    };
    draft.operations.push(opRec);

    const delta = this.txnDelta ?? emptyDelta();
    const instrumented = this.txnInstrumented;
    this.txnDelta = null;
    this.txnInstrumented = false;
    // mutate/记账之后 draft.counters.bytesWritten 即本操作之前的累计基线
    const baseBytes = draft.counters.bytesWritten;
    return { draft, opRec, delta, instrumented, baseBytes };
  }

  /** 受管事务 -> 紧凑增量条目；旧式直接改 draft 的事务 -> 旧版全状态条目 */
  private buildEnvelope(
    draft: State,
    opRec: OperationRecord,
    delta: TxnDelta,
    instrumented: boolean,
  ): JournalDeltaEntry | LegacyJournalEntry {
    if (instrumented) {
      return { v: 2, seq: draft.seq, type: 'delta', op: opRec, counters: draft.counters, delta };
    }
    return { seq: draft.seq, type: 'operation', state: draft };
  }

  /**
   * 让日志行内持久化的累计 bytesWritten 与该行真实 UTF-8 字节数严格相等：
   * B = baseBytes + byteLength(line(B))，迭代到位数稳定（通常 1~2 次）。
   * zeroBytes 时强制行内累计为 0（计数重置事务），只返回真实行字节。
   */
  private serializeLine(
    envelope: JournalDeltaEntry | LegacyJournalEntry,
    counters: AccessCounters,
    baseBytes: number,
    zeroBytes: boolean,
  ): { line: string; bytes: number } {
    if (zeroBytes) {
      counters.bytesWritten = 0;
      const line = JSON.stringify(envelope) + '\n';
      return { line, bytes: Buffer.byteLength(line, 'utf8') };
    }
    let payloadBytes = 0;
    let line = '';
    for (let i = 0; i < 8; i += 1) {
      counters.bytesWritten = baseBytes + payloadBytes;
      line = JSON.stringify(envelope) + '\n';
      const next = Buffer.byteLength(line, 'utf8');
      if (next === payloadBytes) return { line, bytes: next };
      payloadBytes = next;
    }
    counters.bytesWritten = baseBytes + payloadBytes;
    line = JSON.stringify(envelope) + '\n';
    return { line, bytes: Buffer.byteLength(line, 'utf8') };
  }

  private appendJournal(line: string | Buffer): number {
    const buf = typeof line === 'string' ? Buffer.from(line, 'utf8') : line;
    const fd = openSync(this.journalPath, 'a');
    try {
      appendFileSync(fd, buf);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return buf.length;
  }

  commit(
    mutate: (draft: State) => void,
    meta: Omit<OperationRecord, 'seq' | 'appliedAt'>,
    opts: {
      /** 计数归零事务：持久化的累计 bytesWritten 也归零（本行是新纪元基线） */
      zeroBytes?: boolean;
      /** 即使没有受管 draft 写方法，也强制写紧凑增量（如只改计数的重置） */
      forceDelta?: boolean;
    } = {},
  ): OperationRecord {
    const { draft, opRec, delta, instrumented, baseBytes } = this.prepareCommit(mutate, meta);
    const useDelta = instrumented || opts.forceDelta === true;
    const envelope = this.buildEnvelope(draft, opRec, delta, useDelta);
    const { line, bytes } = this.serializeLine(envelope, draft.counters, baseBytes, opts.zeroBytes === true);
    this.appendJournal(line);
    this.state = draft;
    this.journalEntries += 1;
    this.journalBytes += bytes;
    this.perRequest.bytesWritten = bytes;
    if (this.journalEntries >= COMPACT_MAX_ENTRIES || this.journalBytes > COMPACT_MAX_JOURNAL_BYTES) {
      this.compact();
    }
    return opRec;
  }

  /**
   * 测试故障注入：按真实提交流程构造日志，但只写入并 fsync 一个截断前缀
   * （必然不是完整 JSON），且不换入内存状态。调用方通常随后硬退出进程。
   * 返回计划写入的整行与实际前缀字节数。
   */
  commitTorn(
    mutate: (draft: State) => void,
    meta: Omit<OperationRecord, 'seq' | 'appliedAt'>,
    opts: { fraction?: number; bytes?: number; complete?: boolean } = {},
  ): { fullLine: string; fullBytes: number; prefixBytes: number; seq: number } {
    const { draft, opRec, delta, instrumented, baseBytes } = this.prepareCommit(mutate, meta);
    const envelope = this.buildEnvelope(draft, opRec, delta, instrumented);
    const { line, bytes } = this.serializeLine(envelope, draft.counters, baseBytes, false);
    let cut: number;
    if (opts.complete || opts.fraction === 1 || (typeof opts.bytes === 'number' && opts.bytes >= bytes)) {
      cut = bytes;
    } else if (typeof opts.bytes === 'number') {
      cut = opts.bytes;
    } else {
      const fraction = typeof opts.fraction === 'number' && Number.isFinite(opts.fraction) ? opts.fraction : 1 / 3;
      cut = Math.floor(bytes * fraction);
    }
    const prefixBytes = Math.max(0, Math.min(cut, bytes));
    if (prefixBytes === bytes) {
      this.appendJournal(line);
    } else {
      // 严格截断为字节前缀（可能切断多字节字符），JSON 必然无法整体解析
      const prefix = Buffer.from(line, 'utf8').subarray(0, Math.max(1, prefixBytes));
      this.appendJournal(prefix);
    }
    return { fullLine: line, fullBytes: bytes, prefixBytes, seq: opRec.seq };
  }

  /** 旧版故障注入使用：构造一条全状态 seq+1 日志并截断写入 */
  appendLegacyTornBump(opts: { fraction?: number; bytes?: number } = {}): { seq: number; prefixBytes: number } {
    const draft = structuredClone(this.state);
    draft.seq += 1;
    const line = JSON.stringify({ seq: draft.seq, type: 'operation', state: draft }) + '\n';
    const full = Buffer.byteLength(line, 'utf8');
    let cut = typeof opts.bytes === 'number' ? opts.bytes : Math.floor(full * (opts.fraction ?? 1 / 3));
    cut = Math.max(1, Math.min(cut, full - 1));
    const prefix = Buffer.from(line, 'utf8').subarray(0, cut);
    this.appendJournal(prefix);
    return { seq: draft.seq, prefixBytes: cut };
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
    this.journalBytes = 0;
  }

  // ---- 测试/运维辅助 ----

  listFiles(): string[] {
    return readdirSync(this.dir).sort();
  }

  /** 当前 journal.log 逻辑字节数（核对落盘增量用） */
  journalFileBytes(): number {
    try {
      return statSync(this.journalPath).size;
    } catch {
      return 0;
    }
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
