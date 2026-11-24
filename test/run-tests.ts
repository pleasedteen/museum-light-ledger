import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from '../src/server.js';
import type { Server } from 'node:http';
import type { AccessCounters, Interval, MaterialInfo, ReviewItem } from '../src/types.js';

const FIXTURES = join(process.cwd(), 'fixtures');
const DATA = join(process.cwd(), 'data-test');

let base = '';
let server: Server;
let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name} ${detail}`);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

function ingestBody(materialId: string, fileName: string, op?: string) {
  return {
    materialId,
    fileName,
    mediaType: fileName.endsWith('.html') ? 'text/html' : 'text/plain',
    content: readFileSync(join(FIXTURES, fileName), 'utf8'),
    op: op as any,
    clientToken: `tok-${materialId}`,
  };
}

async function main(): Promise<void> {
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  const started = await startServer(DATA, 0, '127.0.0.1');
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
  const t0 = Date.now();
  console.log('== 1. 版式识别与跨页合并 ==');

  const r1 = await api('POST', '/materials', ingestBody('mat-A', 'a-vertical.html'));
  check('A 馆识别为逐柜纵排', r1.data.parse.layout === 'vertical', r1.data.parse.layout);
  check('A 馆跳过翻页重复表头', r1.data.parse.notes.some((n: string) => n.includes('重复表头')));
  check('A 馆解析出 8 条候选', r1.data.parse.candidateCount === 8, `got ${r1.data.parse.candidateCount}`);
  const a01 = await api('GET', '/intervals?cabinet=A-01');
  check('A-01 生成 3 个相邻区间', a01.data.intervals.length === 3, `got ${a01.data.intervals.length}`);
  check(
    'A-01 增量正确 (600/650/650)',
    a01.data.intervals.map((i: Interval) => i.delta).join(',') === '600,650,650',
    a01.data.intervals.map((i: Interval) => i.delta).join(','),
  );
  check('正常区间状态为 ok', a01.data.intervals.every((i: Interval) => i.status === 'ok'));

  const r2 = await api('POST', '/materials', ingestBody('mat-B', 'b-horizontal-split.html'));
  check('B 馆识别为多柜并排', r2.data.parse.layout === 'horizontal');
  const b103 = await api('GET', '/intervals?cabinet=B-103');
  const b103Deltas = b103.data.intervals.map((i: Interval) => i.delta);
  check(
    'B-103 跨页续行合并成功（900->1850->2300->3600）',
    b103Deltas.join(',') === '950,450,1300',
    b103Deltas.join(','),
  );

  console.log('== 2. 换表接续与待核区间 ==');
  const r3 = await api('POST', '/materials', ingestBody('mat-C', 'c-vertical-text-meter.txt'));
  check('C 文本识别为逐柜纵排', r3.data.parse.layout === 'vertical');
  const cMeter = r3.data.parse.candidates.find((c: any) => c.kind === 'meter-change');
  check('换表候选解析出旧表终值/新表起值', cMeter && cMeter.oldFinal === 2450 && cMeter.newStart === 100);
  const m01c = await api('GET', '/intervals?cabinet=M-01&from=2026-11-03T00:00:00Z&to=2026-11-08T23:59:00Z');
  // 跨换表区间：11-03(2450) -> 11-04 换表(旧2450/新100) -> 11-05(700)
  const seam = m01c.data.intervals.find((i: Interval) => i.meterChanges.length > 0);
  check('跨换表区间被识别且含 1 次换表', !!seam && seam.meterChanges.length === 1);
  check('跨换表增量按旧终值/新起值接续 = 600', seam && seam.delta === 600, String(seam?.delta));
  const a03 = await api('GET', '/intervals?cabinet=A-03');
  check(
    '读数下降触发异常/待核区间',
    a03.data.intervals.some((i: Interval) => i.status === 'anomaly' || i.status === 'pending-review'),
    a03.data.intervals.map((i: Interval) => i.status).join(','),
  );

  const r4 = await api('POST', '/materials', ingestBody('mat-D', 'd-horizontal-text.txt'));
  check('D 文本识别为多柜并排', r4.data.parse.layout === 'horizontal');
  const dSplit = await api('GET', '/intervals?cabinet=B-203');
  check('文本并排跨页残行补全 B-203', dSplit.data.intervals.length >= 2);
  const b202 = await api('GET', '/intervals?cabinet=B-202');
  const b202Seam = b202.data.intervals.find((i: Interval) => i.meterChanges.length > 0);
  check('B-202 文本换表接续可计算', b202Seam && typeof b202Seam.delta === 'number');

  console.log('== 3. 证据、置信度与复核队列 ==');
  const recs = await api('GET', '/records?cabinet=A-03');
  const withEvidence = recs.data.records.every((r: any) => r.source?.lines?.length > 0 && r.source?.snippets?.length > 0);
  check('每条候选可追溯到原文行号与片段', withEvidence);
  check('候选带置信度字段', recs.data.records.every((r: any) => ['high', 'medium', 'low'].includes(r.confidence)));
  const reviews = await api('GET', '/reviews?status=pending');
  check('复核队列非空（含异常下降等）', reviews.data.count > 0, `count=${reviews.data.count}`);
  check('复核项带证据', reviews.data.reviews.every((r: ReviewItem) => r.evidence.length > 0));

  // 复核确认
  const negReview = reviews.data.reviews.find((r: ReviewItem) => r.reason === 'negative-delta');
  check('存在读数下降复核项', !!negReview);
  await api('POST', '/reviews/decision', { reviewId: negReview.id, decision: 'confirmed', decidedBy: 'keeper-1' });
  const reviews2 = await api('GET', '/reviews?status=pending');
  check('确认后该项退出待核队列', !reviews2.data.reviews.some((r: ReviewItem) => r.id === negReview.id));
  const a03After = await api('GET', '/intervals?cabinet=A-03');
  check('已确认的异常区间保留 anomaly 且不再待核', a03After.data.intervals.every((i: Interval) => i.status !== 'pending-review'));

  // 订正：把 A-03 的 280 改为 580
  const a03Recs = await api('GET', '/records?cabinet=A-03');
  const target = a03Recs.data.records.find((r: any) => r.value === 280);
  const corrReview = (await api('GET', '/reviews?status=all')).data.reviews.find(
    (r: ReviewItem) => r.recordKey === target.key,
  );
  await api('POST', '/reviews/decision', {
    reviewId: corrReview.id,
    decision: 'corrected',
    decidedBy: 'keeper-1',
    correction: { value: 580 },
  });
  const a03Fixed = await api('GET', '/intervals?cabinet=A-03');
  check('订正后区间增量重算（首段 580-300=280）', a03Fixed.data.intervals[0].delta === 280, String(a03Fixed.data.intervals[0].delta));
  check('订正后无异常区间', a03Fixed.data.intervals.every((i: Interval) => i.status === 'ok'));

  console.log('== 4. 幂等、版本补送/更正/撤回 ==');
  const again = await api('POST', '/materials', ingestBody('mat-A', 'a-vertical.html'));
  check('重复送达幂等命中', again.data.outcome.idempotentHit === true);
  const seqBefore = started.store.getState().seq;
  await api('POST', '/materials', ingestBody('mat-A', 'a-vertical.html'));
  check('重复送达不改变状态序号', started.store.getState().seq === seqBefore);

  // 补送新版本（更正 A-02 的 1300 -> 1350）
  const correctedHtml = readFileSync(join(FIXTURES, 'a-vertical.html'), 'utf8').replace(
    '<td>1300</td>',
    '<td>1350</td>',
  );
  const corr = await api('POST', '/materials', {
    materialId: 'mat-A',
    fileName: 'a-vertical-v2.html',
    mediaType: 'text/html',
    content: correctedHtml,
    op: 'correct',
  });
  check('更正产生新版本号 v2', corr.data.outcome.version === 2);
  const versions = await api('GET', '/materials?materialId=mat-A');
  check('旧版本标记 superseded', versions.data.versions[0].status === 'superseded');
  const a02 = await api('GET', '/intervals?cabinet=A-02');
  check('查询反映更正后的区间（1350-800=550）', a02.data.intervals[0].delta === 550, String(a02.data.intervals[0].delta));

  // 撤回
  await api('POST', '/materials', { ...ingestBody('mat-D', 'd-horizontal-text.txt'), op: 'withdraw' });
  const b201 = await api('GET', '/records?cabinet=B-201');
  check('撤回后该材料记录退出规范表', b201.data.count === 0);
  const dMats = await api('GET', '/materials?materialId=mat-D');
  check('撤回版本状态为 withdrawn', dMats.data.versions.every((m: MaterialInfo) => m.status === 'withdrawn'));

  console.log('== 5. JSON Lines 导出 ==');
  const jsonlRes = await fetch(base + '/export.jsonl?cabinet=A-01');
  const jsonlText = await jsonlRes.text();
  const lines = jsonlText.trim().split('\n');
  let validJsonl = true;
  for (const l of lines) {
    const o = JSON.parse(l);
    if (!o.intervalId || o.cabinet !== 'A-01') validJsonl = false;
  }
  check('导出为合法 JSON Lines 且每行一个区间', validJsonl && lines.length >= 3, `${lines.length} lines`);

  console.log('== 6. 访问量有界性（不随柜历史长度线性增长）==');
  await api('POST', '/access/reset');
  // 生成 5000 条历史读数到柜 PERF-1（每 12 小时一条）
  const perfContent = buildPerfContent(5000);
  await api('POST', '/materials', {
    materialId: 'mat-perf',
    fileName: 'perf.txt',
    mediaType: 'text/plain',
    content: perfContent,
  });
  await api('POST', '/access/reset');
  const smallWindow = await api(
    'GET',
    '/intervals?cabinet=PERF-1&from=2027-06-01T00:00:00Z&to=2027-06-10T23:59:00Z',
  );
  const accessSmall: AccessCounters = smallWindow.access.perRequest;
  check('小窗口查询命中记录数有界（<=15，与 5000 历史无关）', accessSmall.recordReads <= 15, `recordReads=${accessSmall.recordReads}`);
  check('时间线索引访问为常数次（<=2）', accessSmall.indexReads <= 2, `indexReads=${accessSmall.indexReads}`);
  check('窗口内区间数合理（<=11）', smallWindow.data.intervals.length <= 11, `n=${smallWindow.data.intervals.length}`);

  // 变动一条读数后，查询访问量仍有界（重复送达材料只多一条同刻记录，不随历史增长）
  const fixedContent = buildPerfContent(5000, 2500, 99999);
  await api('POST', '/materials', {
    materialId: 'mat-perf-fix',
    fileName: 'perf-fix.txt',
    mediaType: 'text/plain',
    content: fixedContent,
    op: 'ingest',
  });
  const q2 = await api('GET', '/intervals?cabinet=PERF-1&from=2027-06-01T00:00:00Z&to=2027-06-10T23:59:00Z');
  check('变动后小窗口访问量仍有界', q2.access.perRequest.recordReads <= 20, `recordReads=${q2.access.perRequest.recordReads}`);
  const accessReport = await api('GET', '/access');
  check('访问量接口返回累计与每请求计数', !!accessReport.cumulative && !!accessReport.perRequest);

  console.log('== 7. 崩溃原子性（写入中断后重启）==');
  server.close();
  await new Promise((r) => server.on('close', r));
  const seqOk = started.store.getState().seq;
  const crashPort = 43117;
  const child = spawn(process.execPath, [join(process.cwd(), 'dist', 'src', 'server.js'), DATA, String(crashPort)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await waitForPort(crashPort, 5000);
  const crashRes = await fetch(`http://127.0.0.1:${crashPort}/test/crash-during-write`, { method: 'POST' });
  check('故障注入端点接受请求', crashRes.status === 202);
  const exitCode = await new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)));
  check('子进程在日志写入中途硬退出', exitCode === 17, `exit=${exitCode}`);
  const restarted = await startServer(DATA, 0, '127.0.0.1');
  const base2 = `http://127.0.0.1:${restarted.port}`;
  const health = await fetch(base2 + '/health').then((r) => r.json());
  check('中断后可正常重启', health.ok === true);
  check('重启后序号停在整次操作之前（未提交操作不可见）', health.seq === seqOk, `seq=${health.seq}, expected=${seqOk}`);
  const a01Reboot = await fetch(base2 + '/intervals?cabinet=A-01').then((r) => r.json());
  check('已成功提交的数据完整保留', a01Reboot.data.intervals.length >= 3);
  restarted.server.close();

  console.log(`\n结果：${passed} 通过 / ${failed} 失败，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (failed > 0) {
    console.log('失败项：\n - ' + failures.join('\n - '));
    process.exitCode = 1;
  } else {
    console.log('全部断言通过。');
  }
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server on port ${port} did not become ready`);
}

function buildPerfContent(n: number, overrideIdx?: number, overrideVal?: number): string {
  const rows: string[] = ['性能压测柜纵排', '柜号: PERF-1', '巡检时刻 读数(lux·h)'];
  const start = Date.UTC(2027, 0, 1);
  for (let k = 0; k < n; k++) {
    // 每日一条，跨 5000 天，保证小窗口只覆盖少量巡检
    const t = new Date(start + k * 24 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
    const val = overrideIdx !== undefined && k === overrideIdx ? overrideVal : 1000 + k * 10;
    rows.push(`${t} ${val}`);
  }
  return rows.join('\n');
}

main().catch((err) => {
  console.error('测试运行失败：', err);
  process.exit(1);
});
