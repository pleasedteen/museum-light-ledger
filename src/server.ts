import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { parseHtml } from './parse-html.js';
import { parseText } from './parse-text.js';
import { emptyCounters, Store } from './store.js';
import {
  applyMaterial,
  applyReviewDecision,
  findIdempotent,
  type IngestRequest,
  type ReviewDecision,
} from './ingest.js';
import { queryIntervals } from './normalize.js';
import type { AccessReportCounters, Interval, ParseResult } from './types.js';
import { hashString } from './parse-utils.js';

export interface AppContext {
  store: Store;
}

interface JsonResponse {
  status?: number;
  body: unknown;
}

function send(res: ServerResponse, status: number, body: unknown, contentType = 'application/json; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': contentType });
  if (contentType.startsWith('application/json')) res.end(JSON.stringify(body, null, 2));
  else res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req: IncomingMessage, limitBytes = 20 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseMediaType(fileName: string, explicit?: string): 'html' | 'text' {
  if (explicit === 'text/html' || explicit === 'html') return 'html';
  if (explicit === 'text/plain' || explicit === 'text') return 'text';
  return /\.x?html?$/i.test(fileName) ? 'html' : 'text';
}

function runParse(req: IngestRequest): ParseResult {
  const kind = parseMediaType(req.fileName, req.mediaType);
  const materialKey = `${req.materialId}#${hashString(req.content)}`;
  return kind === 'html' ? parseHtml(req.content, materialKey) : parseText(req.content, materialKey);
}

/** 从故障注入请求体的各种常见包装中取出复核结论 */
function extractDecision(body: any): ReviewDecision | null {
  if (!body || typeof body !== 'object') return null;
  const candidates = [body, body.decision, body.reviewDecision, body.payload, body.request, body.body];
  for (const c of candidates) {
    if (c && typeof c === 'object' && typeof c.reviewId === 'string' && typeof c.decision === 'string') {
      return c as ReviewDecision;
    }
  }
  return null;
}

export async function handleRequest(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { store } = ctx;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // 健康检查不计数
  if (method === 'GET' && path === '/health') {
    send(res, 200, { ok: true, seq: store.getState().seq });
    return;
  }

  store.beginRequest();
  const accessAtStart = store.getPerRequestCounters();
  void accessAtStart;

  try {
    // ---------- 材料导入/更正/撤回 ----------
    if (method === 'POST' && (path === '/materials' || path === '/api/materials')) {
      const body = JSON.parse(await readBody(req)) as IngestRequest;
      if (!body.materialId || !body.fileName || typeof body.content !== 'string') {
        return send(res, 400, { error: 'materialId, fileName, content 为必填' });
      }
      const parsed = runParse(body);
      const state = store.getState();
      const idem = findIdempotent(state, body);
      if (idem) {
        const outcome = {
          materialId: idem.materialId,
          version: idem.version,
          op: idem.op,
          idempotentHit: true,
          recordKeys: idem.recordKeys,
          newReviewIds: [],
        };
        return send(res, 200, wrap(store, { outcome, parse: summarizeParse(parsed) }));
      }
      let outcome: import('./ingest.js').IngestOutcome | null = null;
      const opRec = store.commit(
        (draft) => {
          outcome = applyMaterial(store, draft, body, parsed);
        },
        {
          op: body.op ?? 'ingest',
          materialId: body.materialId,
          clientToken: body.clientToken,
          recordKeys: [],
          summary: `${body.op ?? 'ingest'} ${body.materialId} (${body.fileName})`,
        },
      );
      return send(
        res,
        200,
        wrap(store, {
          operationSeq: opRec.seq,
          outcome,
          parse: summarizeParse(parsed),
        }),
      );
    }

    // ---------- 仅解析（预览，不落库） ----------
    if (method === 'POST' && path === '/parse-preview') {
      const body = JSON.parse(await readBody(req)) as IngestRequest;
      const parsed = runParse(body);
      return send(res, 200, wrap(store, summarizeParse(parsed)));
    }

    // ---------- 复核队列 ----------
    if (method === 'GET' && path === '/reviews') {
      const status = url.searchParams.get('status') ?? 'pending';
      const cabinet = url.searchParams.get('cabinet');
      // 带柜过滤时走 cabinetReviewIndex，只访问该柜复核项；无过滤才列全表
      let items = cabinet ? store.reviewsForCabinet(cabinet) : store.allReviews();
      if (status !== 'all') items = items.filter((r) => r.state === status);
      if (cabinet) items = items.filter((r) => r.cabinet === cabinet);
      items.sort((a, b) => b.updatedAt - a.updatedAt);
      return send(res, 200, wrap(store, { count: items.length, reviews: items }));
    }

    // ---------- 复核结论 ----------
    if (method === 'POST' && path === '/reviews/decision') {
      const body = JSON.parse(await readBody(req)) as ReviewDecision & {
        __testCrash?: boolean | { fraction?: number; bytes?: number; complete?: boolean };
      };
      if (!body.reviewId || !body.decision) return send(res, 400, { error: 'reviewId, decision 必填' });
      const existing = store.readReview(body.reviewId);
      if (!existing) return send(res, 404, { error: '复核项不存在' });

      // 可选测试钩子：在该结论的原子日志写到一半时截断并硬退出
      const crashHeader = req.headers['x-test-crash-write'];
      const crashQuery = url.searchParams.get('crash') ?? url.searchParams.get('testCrash');
      const crashMarker = body.__testCrash || crashHeader === '1' || crashHeader === 'torn' || crashQuery === '1' || crashQuery === 'torn';
      if (crashMarker) {
        const headerFraction =
          typeof crashHeader === 'string' && crashHeader.includes(':') ? Number(crashHeader.split(':')[1]) : NaN;
        const opts =
          typeof body.__testCrash === 'object' && body.__testCrash
            ? body.__testCrash
            : { fraction: Number.isFinite(headerFraction) ? headerFraction : 1 / 3 };
        const info = store.commitTorn(
          (draft) => applyReviewDecision(store, draft, body),
          {
            op: 'review',
            recordKeys: [existing.recordKey],
            summary: `crash-torn review ${body.reviewId} -> ${body.decision}`,
          },
          opts,
        );
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ crashing: true, ...info }));
        setImmediate(() => process.exit(17));
        return;
      }

      const opRec = store.commit(
        (draft) => applyReviewDecision(store, draft, body),
        {
          op: 'review',
          recordKeys: [existing.recordKey],
          summary: `review ${body.reviewId} -> ${body.decision}`,
        },
      );
      return send(res, 200, wrap(store, { operationSeq: opRec.seq, review: store.getState().reviews[body.reviewId] }));
    }

    // ---------- 规范表区间查询 ----------
    if (method === 'GET' && path === '/intervals') {
      const cabinet = url.searchParams.get('cabinet');
      if (!cabinet) return send(res, 400, { error: 'cabinet 必填' });
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const intervals = queryIntervals(store, cabinet, from, to);
      return send(res, 200, wrap(store, { cabinet, from, to, count: intervals.length, intervals }));
    }

    // ---------- 候选记录查询 ----------
    if (method === 'GET' && path === '/records') {
      const state = store.getState();
      const cabinet = url.searchParams.get('cabinet');
      const kind = url.searchParams.get('kind');
      const activeOnly = url.searchParams.get('active') !== '0';
      let list = Object.values(state.records);
      if (cabinet) list = list.filter((e) => e.record.cabinet === cabinet);
      if (kind) list = list.filter((e) => e.record.kind === kind);
      if (activeOnly) list = list.filter((e) => e.active);
      return send(
        res,
        200,
        wrap(store, { count: list.length, records: list.map((e) => ({ ...e.record, active: e.active })) }),
      );
    }

    // ---------- 材料版本台账 ----------
    if (method === 'GET' && path === '/materials') {
      const state = store.getState();
      const materialId = url.searchParams.get('materialId');
      if (materialId) return send(res, 200, wrap(store, { versions: state.materials[materialId] ?? [] }));
      return send(res, 200, wrap(store, { materials: state.materials }));
    }

    // ---------- JSON Lines 导出 ----------
    if (method === 'GET' && path === '/export.jsonl') {
      const cabinet = url.searchParams.get('cabinet');
      if (!cabinet) return send(res, 400, { error: 'cabinet 必填' });
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const intervals = queryIntervals(store, cabinet, from, to);
      const lines = intervals.map((iv: Interval) => JSON.stringify(iv)).join('\n') + (intervals.length ? '\n' : '');
      res.writeHead(200, {
        'content-type': 'application/jsonl; charset=utf-8',
        'content-disposition': `attachment; filename="intervals-${cabinet}.jsonl"`,
      });
      res.end(lines);
      return;
    }

    // ---------- 访问量 ----------
    if (method === 'GET' && path === '/access') {
      const cumulative = store.getCounters();
      const perRequest = store.getPerRequestCounters();
      return send(res, 200, {
        // 顶层也平铺主计数（累计口径），方便直接核对
        ...cumulative,
        cumulative,
        perRequest,
        note: 'recordReads/recordWrites=规范记录按键访问；indexReads/indexWrites=每柜时间线索引二分/定点 splice；reviewReads/reviewWrites=经 recordKey/cabinet 二级索引访问的复核项；bytesWritten=本次/累计追加并 fsync 的日志字节（与 journal.log 增长一致）',
      });
    }

    if (method === 'POST' && path === '/access/reset') {
      const opRec = store.commit(
        (draft) => {
          draft.counters = { ...emptyCounters(), resetAt: Date.now() };
        },
        { op: 'reset-counters', recordKeys: [], summary: 'reset access counters' },
        { zeroBytes: true, forceDelta: true },
      );
      return send(res, 200, wrap(store, { operationSeq: opRec.seq, counters: store.getCounters() }));
    }

    // ---------- 测试用故障注入：在日志写入中途退出 ----------
    // 兼容两种用法：
    //  1) 无 body：保持旧行为，写一条 seq+1 全状态日志的 1/3 前缀后退出 17；
    //  2) body 为复核结论（或包在 decision/reviewDecision/payload 字段内）：
    //     按真实“复核订正”事务构造增量日志并截断写入，用于验证重启后
    //     复核状态与规范表/区间同进同退。可用 fraction/bytes/complete 控制截断点。
    if (
      method === 'POST' &&
      ['/test/crash-during-write', '/test/crash-during-commit', '/test/crash-review', '/test/crash'].includes(path)
    ) {
      const rawBody = await readBody(req).catch(() => '');
      let parsed: any = {};
      try {
        parsed = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        parsed = {};
      }
      const qFraction = url.searchParams.get('fraction') ?? url.searchParams.get('f');
      const qBytes = url.searchParams.get('bytes');
      const opts = {
        fraction: parsed.fraction ?? (qFraction ? Number(qFraction) : undefined),
        bytes: parsed.bytes ?? (qBytes ? Number(qBytes) : undefined),
        complete: parsed.complete === true || url.searchParams.get('complete') === '1',
      };

      let decision: ReviewDecision | null = extractDecision(parsed);
      if (!decision && url.searchParams.get('reviewId')) {
        let correction: ReviewDecision['correction'];
        const correctionRaw = url.searchParams.get('correction');
        if (correctionRaw) {
          try {
            correction = JSON.parse(correctionRaw);
          } catch {
            correction = undefined;
          }
        }
        decision = {
          reviewId: url.searchParams.get('reviewId')!,
          decision: (url.searchParams.get('decision') as ReviewDecision['decision']) ?? 'corrected',
          decidedBy: url.searchParams.get('decidedBy') ?? undefined,
          correction:
            correction ??
            ({
              cabinet: url.searchParams.get('cabinet') ?? undefined,
              time: url.searchParams.get('time') ?? undefined,
              value: url.searchParams.has('value') ? Number(url.searchParams.get('value')) : undefined,
            } as ReviewDecision['correction']),
        };
      }

      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ crashing: true, mode: decision ? 'review-decision' : 'legacy-bump' }));
      setImmediate(() => {
        try {
          if (decision) {
            const existing = store.getState().reviews[decision.reviewId];
            store.commitTorn(
              (draft) => applyReviewDecision(store, draft, decision!),
              {
                op: 'review',
                recordKeys: existing ? [existing.recordKey] : [],
                summary: `crash-torn review ${decision.reviewId} -> ${decision.decision}`,
              },
              opts,
            );
          } else {
            store.appendLegacyTornBump(opts);
          }
        } catch (err) {
          // 构造失败（如复核项不存在）时也以约定码退出，避免测试悬挂
          console.error('crash injection failed:', err);
        }
        process.exit(17);
      });
      return;
    }

    return send(res, 404, { error: `not found: ${method} ${path}` });
  } catch (err) {
    return send(res, 500, { error: (err as Error).message });
  }
}

function summarizeParse(p: ParseResult) {
  return {
    materialKey: p.materialKey,
    layout: p.layout,
    notes: p.notes,
    candidateCount: p.candidates.length,
    candidates: p.candidates.map((c) => ({
      kind: c.kind,
      cabinet: c.cabinet,
      time: c.time,
      value: c.value,
      oldFinal: c.oldFinal,
      newStart: c.newStart,
      confidence: c.confidence,
      issues: c.issues,
      evidence: c.evidence.map((e) => ({ line: e.line, col: e.col, snippet: (e.raw ?? e.value).slice(0, 80) })),
    })),
  };
}

function wrap(store: Store, payload: unknown): {
  data: unknown;
  access: AccessReportCounters & { perRequest: AccessReportCounters; cumulative: AccessReportCounters };
} {
  const perRequest = store.getPerRequestCounters();
  const cumulative = store.getCounters();
  return {
    data: payload,
    // 顶层平铺本次请求计数，同时保留 perRequest/cumulative 标准结构
    access: { ...perRequest, perRequest, cumulative },
  };
}

export function startServer(dataDir: string, port = 0, host = '127.0.0.1'): Promise<{ server: Server; port: number; store: Store }> {
  const store = new Store(dataDir);
  const server = createServer((req, res) => {
    handleRequest({ store }, req, res).catch((err) => {
      send(res, 500, { error: (err as Error).message });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port, store });
    });
  });
}

// 独立启动：node dist/src/server.js [dataDir] [port] [host]
const isMain = (() => {
  try {
    return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const dataDir = process.argv[2] ?? join(process.cwd(), 'data');
  const port = Number(process.argv[3] ?? process.env.PORT ?? 8080);
  const host = process.argv[4] ?? process.env.HOST ?? '127.0.0.1';
  startServer(dataDir, port, host).then(({ port: actual }) => {
    console.log(`[museum-light-ledger] 数据目录: ${dataDir}`);
    console.log(`[museum-light-ledger] 监听: http://${host}:${actual}`);
  });
}
