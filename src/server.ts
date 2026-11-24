import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { appendFileSync, fsyncSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { parseHtml } from './parse-html.js';
import { parseText } from './parse-text.js';
import { Store } from './store.js';
import {
  applyMaterial,
  applyReviewDecision,
  findIdempotent,
  type IngestRequest,
  type ReviewDecision,
} from './ingest.js';
import { queryIntervals } from './normalize.js';
import type { AccessCounters, Interval, ParseResult } from './types.js';
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
      const state = store.getState();
      const status = url.searchParams.get('status') ?? 'pending';
      const cabinet = url.searchParams.get('cabinet');
      let items = Object.values(state.reviews);
      if (status !== 'all') items = items.filter((r) => r.state === status);
      if (cabinet) items = items.filter((r) => r.cabinet === cabinet);
      items.sort((a, b) => b.updatedAt - a.updatedAt);
      return send(res, 200, wrap(store, { count: items.length, reviews: items }));
    }

    // ---------- 复核结论 ----------
    if (method === 'POST' && path === '/reviews/decision') {
      const body = JSON.parse(await readBody(req)) as ReviewDecision;
      if (!body.reviewId || !body.decision) return send(res, 400, { error: 'reviewId, decision 必填' });
      if (!store.getState().reviews[body.reviewId]) return send(res, 404, { error: '复核项不存在' });
      const opRec = store.commit(
        (draft) => applyReviewDecision(draft, body),
        {
          op: 'review',
          recordKeys: [store.getState().reviews[body.reviewId]!.recordKey],
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
      return send(res, 200, {
        cumulative: store.getCounters(),
        perRequest: store.getPerRequestCounters(),
        note: 'recordReads/recordWrites 为规范记录按键访问次数；indexReads/indexWrites 为每柜时间线索引访问次数（二分定位，与历史长度无关）',
      });
    }

    if (method === 'POST' && path === '/access/reset') {
      const opRec = store.commit(
        (draft) => {
          draft.counters = { recordReads: 0, recordWrites: 0, indexReads: 0, indexWrites: 0, requests: 0, resetAt: Date.now() };
        },
        { op: 'reset-counters', recordKeys: [], summary: 'reset access counters' },
      );
      return send(res, 200, wrap(store, { operationSeq: opRec.seq, counters: store.getCounters() }));
    }

    // ---------- 测试用故障注入：在日志写入中途退出 ----------
    if (method === 'POST' && path === '/test/crash-during-write') {
      const state = store.getState();
      const draft = structuredClone(state);
      draft.seq += 1;
      const line = JSON.stringify({ seq: draft.seq, type: 'operation', state: draft }) + '\n';
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ crashing: true }));
      setImmediate(() => {
        // 只写半条然后硬退出，模拟写入中断
        const fd = openSync((store as unknown as { journalPath: string }).journalPath, 'a');
        appendFileSync(fd, line.slice(0, Math.max(1, Math.floor(line.length / 3))));
        fsyncSync(fd);
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

function wrap(store: Store, payload: unknown): { data: unknown; access: { perRequest: AccessCounters; cumulative: AccessCounters } } {
  return {
    data: payload,
    access: { perRequest: store.getPerRequestCounters(), cumulative: store.getCounters() },
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
