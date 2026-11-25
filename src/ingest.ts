import type {
  CandidateRecord,
  MaterialInfo,
  MaterialOp,
  MaterialStatus,
  ParsedCandidate,
  ParseResult,
  ReviewItem,
  SourceRef,
  State,
} from './types.js';
import { hashString } from './parse-utils.js';
import { recordKeyOf, Store } from './store.js';

export interface IngestRequest {
  materialId: string;
  fileName: string;
  mediaType: string;
  content: string;
  op?: MaterialOp;
  clientToken?: string;
}

export interface IngestOutcome {
  materialId: string;
  version: number;
  op: MaterialOp;
  idempotentHit: boolean;
  /** 首次提交该版本的操作序号（幂等命中时为首次送达的那次提交） */
  operationSeq: number | null;
  /** 命中版本当前的材料状态（已撤回不因补发而复活） */
  materialStatus: MaterialStatus;
  recordKeys: string[];
  newReviewIds: string[];
  activeRecordCount: number;
}

/**
 * 判断是否为重复送达：同材料 + 同动作(op) + 同内容哈希。
 * 已撤回版本同样命中——补发只返回首次提交的序号与版本，不改变撤回状态。
 */
export function findIdempotent(state: State, req: IngestRequest): MaterialInfo | null {
  const versions = state.materials[req.materialId];
  if (!versions) return null;
  const hash = hashString(`${req.op ?? 'ingest'}|${req.content}`);
  return versions.find((m) => m.contentHash === hash) ?? null;
}

/** 该版本首次落账的操作序号；老台账缺 createdSeq 字段时从操作日志回查 */
export function firstCommitSeq(state: State, m: MaterialInfo): number | null {
  if (typeof m.createdSeq === 'number') return m.createdSeq;
  const op = state.operations.find((o) => o.materialId === m.materialId && o.op === m.op);
  return op ? op.seq : null;
}

function toSourceRef(m: MaterialInfo, cand: ParsedCandidate): SourceRef {
  return {
    materialId: m.materialId,
    version: m.version,
    fileName: m.fileName,
    kind: cand.kind,
    lines: cand.evidence.map((e) => e.line),
    snippets: cand.evidence.map((e) => (e.raw ? e.raw : e.value).slice(0, 120)),
  };
}

/** 由解析候选构造规范记录 */
function buildRecord(m: MaterialInfo, cand: ParsedCandidate): CandidateRecord {
  const key = recordKeyOf(m.materialId, cand.cabinet || 'UNASSIGNED', cand.time || 'UNKNOWN-TIME', cand.kind);
  return {
    key,
    materialId: m.materialId,
    version: m.version,
    cabinet: cand.cabinet,
    time: cand.time,
    kind: cand.kind,
    value: cand.value,
    oldFinal: cand.oldFinal,
    newStart: cand.newStart,
    note: cand.note,
    confidence: cand.confidence,
    source: toSourceRef(m, cand),
    issues: [...cand.issues],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const ISSUE_REASON: Record<string, string> = {
  'unassigned-cabinet': '柜号无法归属',
  'unparsed-time': '巡检时刻无法解析',
  'unparsed-reading': '读数无法解析',
  'missing-old-final': '换表缺少旧表终值',
  'missing-new-start': '换表缺少新表起值',
  'cross-page-merge': '跨页合并记录，需确认拼接正确',
  'meter-seam-gap': '换表接续异常：旧表终值与前一读数不一致',
  'negative-delta': '相邻巡检读数下降且期间无换表记录',
  'duplicate-delivery': '不同材料送来相同柜号/时刻/类型的候选',
  'low-confidence': '解析置信度低',
};

function ensureReviewItem(
  state: State,
  record: CandidateRecord,
  reasonCode: string,
  detail: string,
): string | null {
  const id = `${record.key}#${reasonCode}`;
  const existing = state.reviews[id];
  if (existing) {
    if (existing.state !== 'pending') {
      // 问题在更正后再次出现：重新入队
      existing.state = 'pending';
      existing.updatedAt = Date.now();
      existing.detail = detail;
    }
    return null;
  }
  const item: ReviewItem = {
    id,
    recordKey: record.key,
    cabinet: record.cabinet || 'UNASSIGNED',
    time: record.time,
    reason: reasonCode,
    detail,
    state: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    evidence: [record.source],
  };
  state.reviews[id] = item;
  return id;
}

/** 对一条记录做问题派生；问题消失时自动关闭对应的待核项 */
function deriveIssuesForRecord(store: Store, draft: State, record: CandidateRecord): string[] {
  const created: string[] = [];
  const activeReasons = new Set<string>();

  const raise = (code: string, detail?: string) => {
    activeReasons.add(code);
    const id = ensureReviewItem(draft, record, code, detail ?? ISSUE_REASON[code] ?? code);
    if (id) created.push(id);
  };

  for (const issue of record.issues) raise(issue);
  if (record.confidence === 'low' && record.issues.length === 0) raise('low-confidence');

  // 读数下降检查：同柜时间线中前一条活动读数若更大，且两者间无换表，则入复核
  if (record.kind === 'reading' && record.cabinet && record.time && record.value !== null) {
    const arr = draft.timeline[record.cabinet] ?? [];
    const pos = arr.findIndex((e) => e.recordKey === record.key);
    const before = pos > 0 ? arr.slice(0, pos) : [];
    let meterBetween = false;
    for (let k = before.length - 1; k >= 0; k--) {
      const env = draft.records[before[k]!.recordKey];
      if (!env || !env.active) continue;
      if (env.record.kind === 'meter-change') {
        meterBetween = true;
        break;
      }
      if (env.record.kind === 'reading' && env.record.value !== null) {
        if (!meterBetween && env.record.value > record.value) {
          raise(
            'negative-delta',
            `读数由 ${env.record.value} 降至 ${record.value}，期间无换表记录`,
          );
        }
        break;
      }
    }
  }

  // 换表接续检查：旧表终值应等于同柜此前最近一条读数
  if (record.kind === 'meter-change' && record.cabinet && record.time) {
    const arr = draft.timeline[record.cabinet] ?? [];
    const pos = arr.findIndex((e) => e.recordKey === record.key);
    const before = pos > 0 ? arr.slice(0, pos).filter((e) => e.time < record.time) : [];
    const prevReadingKey = before.reverse().find((e) => {
      const r = draft.records[e.recordKey];
      return r?.active && r.record.kind === 'reading' && r.record.value !== null;
    })?.recordKey;
    if (prevReadingKey && record.oldFinal !== null) {
      const prev = store.draftReadRecord(draft, prevReadingKey)!;
      if (prev.record.value !== null && Math.abs(prev.record.value - record.oldFinal) > 1e-9) {
        raise(
          'meter-seam-gap',
          `旧表终值 ${record.oldFinal} 与换表前最近读数 ${prev.record.value} 不一致`,
        );
      }
    }
  }

  // 关闭已不存在的问题对应待核项（已确认/订正的人工结论保留，不回退）
  for (const item of Object.values(draft.reviews)) {
    if (item.recordKey !== record.key) continue;
    if (item.state === 'pending' && !activeReasons.has(item.reason)) {
      item.state = 'confirmed';
      item.detail = `${item.detail}（问题在后续版本中消失，自动确认）`;
      item.updatedAt = Date.now();
    }
  }
  return created;
}

/** 应用一次材料操作（ingest/correct/withdraw），在 store.commit 的 draft 事务内执行 */
export function applyMaterial(store: Store, draft: State, req: IngestRequest, parsed: ParseResult): IngestOutcome {
  const idem = findIdempotent(draft, req);
  if (idem) {
    return {
      materialId: req.materialId,
      version: idem.version,
      op: idem.op,
      idempotentHit: true,
      operationSeq: firstCommitSeq(draft, idem),
      materialStatus: idem.status,
      recordKeys: idem.recordKeys,
      newReviewIds: [],
      activeRecordCount: idem.recordKeys.filter((k) => draft.records[k]?.active).length,
    };
  }

  const op: MaterialOp = req.op ?? 'ingest';
  const priorVersions = draft.materials[req.materialId] ?? [];
  const version = priorVersions.length === 0 ? 1 : Math.max(...priorVersions.map((m) => m.version)) + 1;
  // commit 将在变更完成后自增 seq，本次提交的序号即 draft.seq + 1
  const pendingSeq = draft.seq + 1;

  const info: MaterialInfo = {
    materialId: req.materialId,
    version,
    fileName: req.fileName,
    mediaType: req.mediaType,
    op,
    status: 'active',
    supersededBy: null,
    parentVersion: priorVersions.length ? Math.max(...priorVersions.map((m) => m.version)) : null,
    receivedAt: Date.now(),
    contentHash: hashString(`${op}|${req.content}`),
    createdSeq: pendingSeq,
    recordKeys: [],
  };

  const recordKeys: string[] = [];
  const newReviewIds: string[] = [];

  if (op === 'withdraw') {
    // 撤回：停用该材料全部版本的记录，撤回动作本身也标记为 withdrawn
    info.status = 'withdrawn';
    for (const old of priorVersions) {
      old.status = 'withdrawn';
      old.supersededBy = version;
      for (const key of old.recordKeys) {
        const env = draft.records[key];
        if (env && env.active) {
          env.active = false;
          store.draftWriteRecord(draft, key, env);
          store.draftRemoveTimeline(draft, env.record.cabinet || 'UNASSIGNED', env.record.time || 'UNKNOWN-TIME', key);
        }
      }
    }
    info.recordKeys = [];
  } else {
    // ingest / correct：旧版本被新版本取代
    if (op === 'correct') {
      for (const old of priorVersions) {
        if (old.status === 'active') {
          old.status = 'superseded';
          old.supersededBy = version;
          for (const key of old.recordKeys) {
            const env = draft.records[key];
            if (env && env.active) {
              env.active = false;
              store.draftWriteRecord(draft, key, env);
              store.draftRemoveTimeline(draft, env.record.cabinet || 'UNASSIGNED', env.record.time || 'UNKNOWN-TIME', key);
            }
          }
        }
      }
    }

    for (const cand of parsed.candidates) {
      const rec = buildRecord(info, cand);
      // 重复送达检测：同柜/同时刻/同类型、不同材料
      if (op === 'ingest') {
        const dup = Object.values(draft.records).find(
          (env) =>
            env.active &&
            env.record.materialId !== req.materialId &&
            env.record.kind === rec.kind &&
            env.record.cabinet === rec.cabinet &&
            env.record.time === rec.time,
        );
        if (dup) rec.issues.push('duplicate-delivery');
      }
      draft.records[rec.key] = { record: rec, active: true };
      store.draftWriteRecord(draft, rec.key, draft.records[rec.key]!);
      store.draftUpsertTimeline(draft, {
        cabinet: rec.cabinet || 'UNASSIGNED',
        time: rec.time || 'UNKNOWN-TIME',
        recordKey: rec.key,
      });
      recordKeys.push(rec.key);
      info.recordKeys.push(rec.key);
    }

    // 派生复核项（含换表接续、跨材料重复等）
    for (const key of recordKeys) {
      const rec = draft.records[key]!.record;
      newReviewIds.push(...deriveIssuesForRecord(store, draft, rec));
    }
  }

  draft.materials[req.materialId] ??= [];
  draft.materials[req.materialId]!.push(info);

  return {
    materialId: req.materialId,
    version,
    op,
    idempotentHit: false,
    operationSeq: pendingSeq,
    materialStatus: info.status,
    recordKeys,
    newReviewIds,
    activeRecordCount: recordKeys.filter((k) => draft.records[k]?.active).length,
  };
}

export interface ReviewDecision {
  reviewId: string;
  decision: 'confirmed' | 'corrected' | 'rejected';
  decidedBy?: string;
  correction?: ReviewItem['correction'];
}

/** 人工复核结论：与规范表在同一事务内生效 */
export function applyReviewDecision(state: State, d: ReviewDecision): ReviewItem {
  const item = state.reviews[d.reviewId];
  if (!item) throw new Error(`review item not found: ${d.reviewId}`);
  item.state = d.decision;
  item.decidedBy = d.decidedBy;
  item.updatedAt = Date.now();

  if (d.decision === 'corrected' && d.correction) {
    item.correction = d.correction;
    const env = state.records[item.recordKey];
    if (env) {
      const r = env.record;
      const oldCab = r.cabinet || 'UNASSIGNED';
      const oldTime = r.time || 'UNKNOWN-TIME';
      if (d.correction.cabinet !== undefined) r.cabinet = d.correction.cabinet;
      if (d.correction.time !== undefined) r.time = d.correction.time;
      if (d.correction.value !== undefined) r.value = d.correction.value;
      if (d.correction.oldFinal !== undefined) r.oldFinal = d.correction.oldFinal;
      if (d.correction.newStart !== undefined) r.newStart = d.correction.newStart;
      r.issues = r.issues.filter((x) => x === item.reason || x === 'cross-page-merge' ? false : true);
      r.updatedAt = Date.now();
      // 索引随订正一起移动
      const newCab = r.cabinet || 'UNASSIGNED';
      const newTime = r.time || 'UNKNOWN-TIME';
      if (newCab !== oldCab || newTime !== oldTime) {
        const arr = state.timeline[oldCab];
        if (arr) {
          const pos = arr.findIndex((e) => e.recordKey === r.key);
          if (pos >= 0) arr.splice(pos, 1);
        }
        state.timeline[newCab] ??= [];
        const target = { cabinet: newCab, time: newTime, recordKey: r.key };
        const tArr = state.timeline[newCab]!;
        const lb = lowerBound(tArr, newTime);
        tArr.splice(lb, 0, target);
      }
    }
  }

  if (d.decision === 'rejected') {
    const env = state.records[item.recordKey];
    if (env) {
      env.active = false;
      // 拒绝的记录退出规范表时间线，但保留审计痕迹
      const arr = state.timeline[env.record.cabinet || 'UNASSIGNED'];
      if (arr) {
        const pos = arr.findIndex((e) => e.recordKey === env.record.key);
        if (pos >= 0) arr.splice(pos, 1);
      }
    }
  }
  return item;
}

function lowerBound(arr: { time: string }[], time: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]!.time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
