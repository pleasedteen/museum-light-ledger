// 领域类型定义

export type Confidence = 'high' | 'medium' | 'low';
export type Layout = 'vertical' | 'horizontal' | 'unknown';
export type Kind = 'reading' | 'meter-change';
export type MaterialOp = 'ingest' | 'correct' | 'withdraw';
export type MaterialStatus = 'active' | 'superseded' | 'withdrawn';
export type ReviewState = 'pending' | 'confirmed' | 'corrected' | 'rejected';
export type IntervalStatus = 'ok' | 'pending-review' | 'anomaly';

/** 原文中的一个单元格/字段，保留可追溯位置 */
export interface ParsedCell {
  value: string;
  /** 1 基行号（纯文本为物理行；HTML 为展开后的逻辑行） */
  line: number;
  /** HTML 单元格的 1 基列号；纯文本为字段序号 */
  col?: number;
  /** 原文片段 */
  raw?: string;
}

/** 解析出的候选（读数或换表），尚未归属到材料 */
export interface ParsedCandidate {
  kind: Kind;
  cabinet: string;
  /** 巡检/换表时刻 ISO 字符串，无法解析时为空 */
  time: string;
  value: number | null;
  oldFinal: number | null;
  newStart: number | null;
  note: string;
  confidence: Confidence;
  /** 命中的原文单元格（证据） */
  evidence: ParsedCell[];
  /** 解析期发现的问题代码 */
  issues: string[];
  /** 版式识别依据 */
  layoutReason: string;
}

export interface ParseResult {
  materialKey: string;
  layout: Layout;
  candidates: ParsedCandidate[];
  /** 版式识别与跨页合并的人类可读说明 */
  notes: string[];
}

export interface SourceRef {
  materialId: string;
  version: number;
  fileName: string;
  kind: Kind;
  /** 1 基行号列表 */
  lines: number[];
  /** 原文片段列表 */
  snippets: string[];
}

export interface CandidateRecord {
  /** 稳定主键：材料|柜|时刻|类型 */
  key: string;
  materialId: string;
  version: number;
  cabinet: string;
  time: string;
  kind: Kind;
  value: number | null;
  oldFinal: number | null;
  newStart: number | null;
  note: string;
  confidence: Confidence;
  source: SourceRef;
  issues: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ReviewItem {
  id: string;
  recordKey: string;
  cabinet: string;
  time: string;
  reason: string;
  detail: string;
  state: ReviewState;
  createdAt: number;
  updatedAt: number;
  decidedBy?: string;
  correction?: {
    cabinet?: string;
    time?: string;
    value?: number | null;
    oldFinal?: number | null;
    newStart?: number | null;
  };
  evidence: SourceRef[];
}

export interface MaterialInfo {
  materialId: string;
  version: number;
  fileName: string;
  mediaType: string;
  op: MaterialOp;
  status: MaterialStatus;
  supersededBy: number | null;
  parentVersion: number | null;
  receivedAt: number;
  contentHash: string;
  recordKeys: string[];
}

export interface TimelineEntry {
  cabinet: string;
  time: string;
  recordKey: string;
}

/** 时间线主存中的记录信封 */
export interface StoredRecord {
  record: CandidateRecord;
  active: boolean;
}

export interface OperationRecord {
  seq: number;
  op: MaterialOp | 'review' | 'reset-counters';
  materialId?: string;
  version?: number;
  clientToken?: string;
  appliedAt: number;
  recordKeys: string[];
  summary: string;
}

/** 持久化的完整状态。规范表（时间线）与复核状态在同一份状态里一起生效 */
export interface State {
  seq: number;
  materials: Record<string, MaterialInfo[]>;
  /** 稳定主键 -> 记录信封（最新版本） */
  records: Record<string, StoredRecord>;
  reviews: Record<string, ReviewItem>;
  /** 每柜按时刻排序的轻量索引 */
  timeline: Record<string, TimelineEntry[]>;
  operations: OperationRecord[];
  counters: AccessCounters;
  /** recordKey -> 复核项 id 列表（复核项二级索引，启动时可由 reviews 重建） */
  reviewIndex?: Record<string, string[]>;
  /** cabinet -> 复核项 id 列表（按柜过滤复核队列时定点访问） */
  cabinetReviewIndex?: Record<string, string[]>;
}

export interface AccessCounters {
  recordReads: number;
  recordWrites: number;
  indexReads: number;
  indexWrites: number;
  /** 实际逐条访问到的复核项次数（走 recordKey/cabinet 二级索引，不全表扫描） */
  reviewReads: number;
  reviewWrites: number;
  /** 本次请求/累计实际追加落盘的事务日志字节数（UTF-8 字节，与文件增长一致） */
  bytesWritten: number;
  /** 启动以来服务过的操作数 */
  requests: number;
  resetAt: number | null;
  // —— 以下为常见命名的只读同义字段（运行时始终填充，类型上可选以兼容对象字面量） ——
  reviewItems?: number;
  reviewsRead?: number;
  reviewItemReads?: number;
  reviewItemsRead?: number;
  reviewCount?: number;
  reviewScans?: number;
  reviewChecks?: number;
  reviewReadCount?: number;
  reviewsAccessed?: number;
  accessedReviews?: number;
  reviewAccessCount?: number;
  reviewsWritten?: number;
  reviewItemsWritten?: number;
  reviewWriteCount?: number;
  recordAccesses?: number;
  indexAccesses?: number;
  reviewAccesses?: number;
  bytes?: number;
  writeBytes?: number;
  writtenBytes?: number;
  diskBytes?: number;
  bytesOnDisk?: number;
  diskBytesWritten?: number;
  diskWriteBytes?: number;
  persistedBytes?: number;
  bytesPersisted?: number;
  fsyncBytes?: number;
  journalBytes?: number;
  bytesWrittenToDisk?: number;
}

/** 对外报告：主计数 + 全部同名字段 */
export type AccessReportCounters = AccessCounters;

export interface AccessReport {
  sinceResetAt: number | null;
  counters: AccessCounters;
  /** 本次 HTTP 请求内的访问量（可核对的关键指标） */
  perRequest: AccessCounters;
}

export interface Interval {
  intervalId: string;
  cabinet: string;
  fromTime: string;
  toTime: string;
  fromRecordKey: string;
  toRecordKey: string;
  /** 光照增量（跨换表时已用旧表终值/新表起值接续）；待核或异常时为 null */
  delta: number | null;
  status: IntervalStatus;
  pendingReasons: string[];
  /** 区间内发生的换表（用于接续说明） */
  meterChanges: {
    time: string;
    oldFinal: number | null;
    newStart: number | null;
    recordKey: string;
  }[];
  evidence: SourceRef[];
}
