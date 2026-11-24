/**
 * 十倍历史规模对比 + 写一半崩溃原子性核查。
 *
 * 作为 `npm test` 的一环运行（package.json: node dist/test/boundedness-check.js && ...）。
 * 用本地确定性夹具生成历史规模相差十倍的两个柜（500 vs 5000 条，且约半数记录
 * 各带一条复核项），执行完全相同的：
 *   1) 单条复核订正（含跨柜移动）；
 *   2) 窄窗口区间查询。
 * 公开每请求实际访问的 record/index/review 计数与落盘字节，并断言：
 * 十倍规模下每一项最多翻倍（big <= 2 * small）。
 *
 * 另起子进程对“订正日志写到一半”做故障注入，重启后核查：
 * 复核状态与区间/记录/时间线同进同退，此前已返回成功的订正不丢。
 */
import { rmSync, mkdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { startServer } from '../src/server.js';
import type { Server } from 'node:http';

const ROOT = process.cwd();
const DATA_ROOT = join(ROOT, 'data-test', 'boundedness');
const SMALL_N = 500;
const BIG_N = 5000;
const TARGET_IDX = 101; // 奇数：夹具体里是一个下降点，带 negative-delta 复核项

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

async function api(base: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

/** 确定性本地夹具：奇偶读数高低交替，每个回落点派生一条 negative-delta 复核项 */
function buildScaleContent(n: number, cabinet: string): string {
  const rows: string[] = [`柜号: ${cabinet}`];
  const start = Date.UTC(2027, 0, 1);
  for (let k = 0; k < n; k++) {
    const t = new Date(start + k * 24 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
    const value = 200000 + k * 100 + (k % 2 === 0 ? 8000 : 0);
    rows.push(`${t} ${value}`);
  }
  return rows.join('\n');
}

function targetTime(): string {
  return new Date(Date.UTC(2027, 0, 1) + TARGET_IDX * 86400000).toISOString().replace('T', ' ').slice(0, 16);
}

/** 把存储的 ISO 时刻归一成夹具使用的 'YYYY-MM-DD HH:mm' 以便比较 */
function minuteKey(iso: string | undefined): string {
  return (iso ?? '').replace('T', ' ').slice(0, 16);
}

function windowRange(days: number): { from: string; to: string } {
  const t = Date.UTC(2027, 0, 1) + TARGET_IDX * 86400000;
  return {
    from: new Date(t - days * 86400000).toISOString(),
    to: new Date(t + days * 86400000).toISOString(),
  };
}

const METRIC_KEYS = [
  'recordReads',
  'recordWrites',
  'indexReads',
  'indexWrites',
  'reviewReads',
  'reviewWrites',
  'bytesWritten',
] as const;

type Metrics = Record<(typeof METRIC_KEYS)[number], number>;

function pickMetrics(access: any): Metrics {
  const m = {} as Metrics;
  for (const k of METRIC_KEYS) m[k] = Number(access?.perRequest?.[k] ?? 0);
  return m;
}

function printMetricsTable(label: string, small: Metrics, big: Metrics): void {
  console.log(`  ${label}`);
  console.log('    metric         small(500)   big(5000)   big/small');
  for (const k of METRIC_KEYS) {
    const s = small[k];
    const b = big[k];
    const ratio = s === 0 ? (b === 0 ? '0/0' : '∞') : (b / s).toFixed(2);
    console.log(`    ${k.padEnd(15)}${String(s).padStart(8)}${String(b).padStart(11)}${ratio.padStart(11)}`);
  }
}

interface ScaleRun {
  correction: Metrics;
  query: Metrics;
  diskDelta: number;
  reviewCount: number;
}

async function runScale(n: number, tag: string): Promise<ScaleRun> {
  const dir = join(DATA_ROOT, tag);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const started = await startServer(dir, 0, '127.0.0.1');
  const base = `http://127.0.0.1:${started.port}`;
  const cabinet = `SCALE-${tag.toUpperCase()}`;
  try {
    // 优先使用提交在 fixtures/ 下的本地夹具文件（500 vs 5000，十倍规模）
    const fixturePath = join(ROOT, 'fixtures', `e-scale-${tag}-${n}.txt`);
    const content = existsSync(fixturePath) ? readFileSync(fixturePath, 'utf8') : buildScaleContent(n, cabinet);
    const ing = await api(base, 'POST', '/materials', {
      materialId: `mat-${tag}`,
      fileName: `${tag}.txt`,
      mediaType: 'text/plain',
      content,
    });
    if (ing.data.parse.candidateCount !== n) {
      throw new Error(`${tag}: 候选数 ${ing.data.parse.candidateCount} != ${n}`);
    }

    const pending = await api(base, 'GET', `/reviews?status=pending&cabinet=${cabinet}`);
    const reviewCount = pending.data.count as number;

    const tt = targetTime();
    const targetReview = pending.data.reviews.find(
      (r: any) => minuteKey(r.time) === tt && r.reason === 'negative-delta',
    );
    if (!targetReview) throw new Error(`${tag}: 找不到目标复核项 time=${tt}`);

    await api(base, 'POST', '/access/reset');
    const journalBefore = statSync(join(dir, 'journal.log')).size;

    // 同样的单条订正：改值 + 跨柜移动（两个规模完全一致的载荷形状）
    const decisionRes = await api(base, 'POST', '/reviews/decision', {
      reviewId: targetReview.id,
      decision: 'corrected',
      decidedBy: 'scale-check',
      correction: { cabinet: 'SCALE-MOVED', value: 999999 },
    });
    const correction = pickMetrics(decisionRes.access);
    const journalAfter = statSync(join(dir, 'journal.log')).size;
    const diskDelta = journalAfter - journalBefore;

    const w = windowRange(4);
    const qRes = await api(
      base,
      'GET',
      `/intervals?cabinet=${cabinet}&from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`,
    );
    const query = pickMetrics(qRes.access);

    return { correction, query, diskDelta, reviewCount };
  } finally {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  }
}

async function compareScales(): Promise<void> {
  console.log('== A. 十倍历史柜：单条订正（含改柜）与窄窗口查询的访问量/落盘对比 ==');
  const small = await runScale(SMALL_N, 'small');
  const big = await runScale(BIG_N, 'big');

  check('夹具确实派生了随规模增长的复核项（small >= 150）', small.reviewCount >= 150, `small=${small.reviewCount}`);
  check('夹具确实派生了随规模增长的复核项（big >= 1500）', big.reviewCount >= 1500, `big=${big.reviewCount}`);
  console.log(`   pending 复核项：small=${small.reviewCount}，big=${big.reviewCount}（十倍复核表规模）`);

  printMetricsTable('单条订正（corrected + 改柜）', small.correction, big.correction);
  printMetricsTable('窄窗口查询（±4 天）', small.query, big.query);
  console.log(`  journal.log 实际增长：small=${small.diskDelta}B，big=${big.diskDelta}B`);

  for (const op of ['correction', 'query'] as const) {
    for (const k of METRIC_KEYS) {
      const s = small[op][k];
      const b = big[op][k];
      check(`${op}.${k} 十倍规模下最多翻倍 (${b} <= 2*${s})`, b <= 2 * s, `small=${s} big=${b}`);
    }
  }

  // 绝对合理性，防止“两个规模都在全表扫描但比值相近”式的假通过
  check('窄窗口 recordReads 有界（<=20）', big.query.recordReads <= 20, `big=${big.query.recordReads}`);
  check('窄窗口 indexReads <= 2', big.query.indexReads <= 2, `big=${big.query.indexReads}`);
  check('窄窗口 reviewReads 有界（<=30，不扫十倍复核表）', big.query.reviewReads <= 30, `big=${big.query.reviewReads}`);
  check('订正落盘字节为正且有界（<=8192）', big.correction.bytesWritten > 0 && big.correction.bytesWritten <= 8192, `big=${big.correction.bytesWritten}`);
  check(
    '报告 bytesWritten 与 journal.log 实际增长逐字节一致',
    big.diskDelta === big.correction.bytesWritten && small.diskDelta === small.correction.bytesWritten,
    `reported=${small.correction.bytesWritten}/${big.correction.bytesWritten} disk=${small.diskDelta}/${big.diskDelta}`,
  );
  check('窄窗口查询不落盘', big.query.bytesWritten === 0 && small.query.bytesWritten === 0);
  check('订正至少写 1 条记录与 1 个复核项', big.correction.recordWrites >= 1 && big.correction.reviewWrites >= 1);
  check('改柜产生索引写（旧柜删 + 新柜写，>=2）', big.correction.indexWrites >= 2, `indexWrites=${big.correction.indexWrites}`);
}

// ---------------- 崩溃原子性 ----------------

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  throw new Error(`server on port ${port} not ready`);
}

function spawnCrashChild(dir: string): Promise<{ child: ChildProcessWithoutNullStreams; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(ROOT, 'dist', 'src', 'server.js'), dir, '0', '127.0.0.1'],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    ) as unknown as ChildProcessWithoutNullStreams;
    let buf = '';
    const timer = setTimeout(() => reject(new Error('child start timeout')), 10000);
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/监听: http:\/\/127\.0\.0\.1:(\d+)/);
      if (m && m[1]) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]) });
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited early code=${code}`));
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** 全量不变式：每条时间线项都能对应到活动记录，柜归属一致；订正结论与记录现状一致 */
function checkGlobalInvariants(store: { getState(): any }, label: string): void {
  const state = store.getState();
  let dangling = 0;
  let cabinetMismatch = 0;
  for (const [cab, arr] of Object.entries(state.timeline) as [string, any[]][]) {
    for (const e of arr) {
      const env = state.records[e.recordKey];
      if (!env || !env.active) dangling += 1;
      else if ((env.record.cabinet || 'UNASSIGNED') !== cab) cabinetMismatch += 1;
    }
  }
  check(`${label}: 时间线无悬空/失活项`, dangling === 0, `dangling=${dangling}`);
  check(`${label}: 时间线柜归属与记录一致`, cabinetMismatch === 0, `mismatch=${cabinetMismatch}`);

  let correctionDrift = 0;
  for (const item of Object.values(state.reviews) as any[]) {
    if (item.state === 'corrected' && item.correction) {
      const env = state.records[item.recordKey];
      if (!env) {
        correctionDrift += 1;
        continue;
      }
      const c = item.correction;
      if (c.cabinet !== undefined && env.record.cabinet !== c.cabinet) correctionDrift += 1;
      if (c.value !== undefined && env.record.value !== c.value) correctionDrift += 1;
    }
  }
  check(`${label}: 所有 corrected 复核项与记录/区间派生状态同进同退`, correctionDrift === 0, `drift=${correctionDrift}`);
}

async function crashScenario(opts: { fraction?: number; complete?: boolean; tag: string }): Promise<void> {
  const { tag } = opts;
  console.log(`== B. 写一半崩溃原子性（${tag}）==`);
  const dir = join(DATA_ROOT, `crash-${tag}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // 1) 主进程：导入 + 一条已返回成功的订正
  const first = await startServer(dir, 0, '127.0.0.1');
  const base0 = `http://127.0.0.1:${first.port}`;
  await api(base0, 'POST', '/materials', {
    materialId: 'mat-crash',
    fileName: 'crash.txt',
    mediaType: 'text/plain',
    content: buildScaleContent(160, 'CRASH-1'),
  });
  const t1 = new Date(Date.UTC(2027, 0, 1) + 21 * 86400000).toISOString().replace('T', ' ').slice(0, 16);
  let reviews = await api(base0, 'GET', '/reviews?status=pending&cabinet=CRASH-1');
  const r1 = reviews.data.reviews.find((r: any) => minuteKey(r.time) === t1 && r.reason === 'negative-delta');
  check(`${tag}: 找到第一条目标复核项`, !!r1);
  await api(base0, 'POST', '/reviews/decision', {
    reviewId: r1.id,
    decision: 'corrected',
    decidedBy: 'keeper-crash',
    correction: { cabinet: 'CRASH-MOVED', value: 999998 },
  });

  // 第二条订正（稍后在子进程里写到一半崩溃）
  const t2 = new Date(Date.UTC(2027, 0, 1) + 51 * 86400000).toISOString().replace('T', ' ').slice(0, 16);
  reviews = await api(base0, 'GET', '/reviews?status=pending&cabinet=CRASH-1');
  const r2 = reviews.data.reviews.find((r: any) => minuteKey(r.time) === t2 && r.reason === 'negative-delta');
  check(`${tag}: 找到第二条目标复核项`, !!r2);
  const decision2 = {
    reviewId: r2.id,
    decision: 'corrected' as const,
    decidedBy: 'keeper-crash',
    correction: { cabinet: 'CRASH-MOVED-2', value: 999997 },
  };

  const seqBeforeCrash = first.store.getState().seq;
  await closeServer(first.server);

  // 2) 子进程：对第二条订正做截断写入后硬退出
  const { child, port } = await spawnCrashChild(dir);
  const base1 = `http://127.0.0.1:${port}`;
  await waitForPort(port, 10000);
  const qs = opts.complete ? 'complete=1' : `fraction=${opts.fraction ?? 0.33}`;
  const crashRes = await fetch(`${base1}/test/crash-during-write?${qs}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(decision2),
  });
  check(`${tag}: 故障注入端点接受复核订正请求 (202)`, crashRes.status === 202, `status=${crashRes.status}`);
  const crashJson = await crashRes.json().catch(() => ({}));
  check(`${tag}: 故障注入识别为 review-decision 事务`, crashJson.mode === 'review-decision', `mode=${crashJson.mode}`);

  const exitCode = await new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)));
  check(`${tag}: 子进程硬退出码 17`, exitCode === 17, `exit=${exitCode}`);

  // 3) 重启核查
  const restarted = await startServer(dir, 0, '127.0.0.1');
  const base2 = `http://127.0.0.1:${restarted.port}`;
  const health = await (await fetch(base2 + '/health')).json();

  if (opts.complete) {
    check(`${tag}: 完整写入后 seq 前进到 ${seqBeforeCrash + 1}`, health.seq === seqBeforeCrash + 1, `seq=${health.seq}`);
    const rv2 = restarted.store.getState().reviews[decision2.reviewId];
    check(`${tag}: 完整写入 -> 复核结论已生效`, rv2?.state === 'corrected', `state=${rv2?.state}`);
    const rec2 = rv2 ? restarted.store.getState().records[rv2.recordKey] : undefined;
    check(`${tag}: 完整写入 -> 记录已改柜（区间派生随之移动）`, rec2?.record.cabinet === 'CRASH-MOVED-2', `cab=${rec2?.record.cabinet}`);
  } else {
    check(`${tag}: 半条日志被忽略，seq 停在崩溃前 ${seqBeforeCrash}`, health.seq === seqBeforeCrash, `seq=${health.seq}`);
    const rv2 = restarted.store.getState().reviews[decision2.reviewId];
    check(`${tag}: 半条写入整体回退 -> 第二条复核仍 pending`, rv2?.state === 'pending', `state=${rv2?.state}`);
    const rec2 = rv2 ? restarted.store.getState().records[rv2.recordKey] : undefined;
    check(`${tag}: 半条写入整体回退 -> 记录仍在原柜`, rec2?.record.cabinet === 'CRASH-1', `cab=${rec2?.record.cabinet}`);
    const cab1Timeline = restarted.store.getState().timeline['CRASH-1'] ?? [];
    const expectedKey = `${decision2.reviewId.replace(/#negative-delta$/, '')}`;
    check(
      `${tag}: 半条写入回退 -> 时间线仍含原索引项`,
      cab1Timeline.some((e: any) => e.recordKey === expectedKey),
      `key=${expectedKey}`,
    );
  }

  // 已返回成功的第一条订正必须保留
  const rv1 = restarted.store.getState().reviews[r1.id];
  check(`${tag}: 已成功订正的复核结论保留为 corrected`, rv1?.state === 'corrected', `state=${rv1?.state}`);
  const rec1 = rv1 ? restarted.store.getState().records[rv1.recordKey] : undefined;
  check(`${tag}: 已成功订正的改柜/改值保留`, rec1?.record.cabinet === 'CRASH-MOVED' && rec1?.record.value === 999998);

  checkGlobalInvariants(restarted.store, tag);

  // 崩溃后仍可正常提交新订正；再次重启后两份成功订正都在
  const t3 = new Date(Date.UTC(2027, 0, 1) + 81 * 86400000).toISOString().replace('T', ' ').slice(0, 16);
  const pend3 = await api(base2, 'GET', '/reviews?status=pending&cabinet=CRASH-1');
  const r3 = pend3.data.reviews.find((r: any) => minuteKey(r.time) === t3 && r.reason === 'negative-delta');
  check(`${tag}: 崩溃重启后仍可找到新的复核项并继续作业`, !!r3);
  if (r3) {
    await api(base2, 'POST', '/reviews/decision', {
      reviewId: r3.id,
      decision: 'corrected',
      decidedBy: 'keeper-after',
      correction: { value: 999996 },
    });
  }
  await closeServer(restarted.server);

  const again = await startServer(dir, 0, '127.0.0.1');
  check(`${tag}: 二次重启后第一条成功订正仍在`, again.store.getState().reviews[r1.id]?.state === 'corrected');
  if (r3) {
    check(`${tag}: 二次重启后崩溃后新提交的订正也在`, again.store.getState().reviews[r3.id]?.state === 'corrected');
  }
  checkGlobalInvariants(again.store, `${tag}-reboot2`);
  await closeServer(again.server);
}

async function main(): Promise<void> {
  rmSync(DATA_ROOT, { recursive: true, force: true });
  mkdirSync(DATA_ROOT, { recursive: true });
  const t0 = Date.now();
  try {
    await compareScales();
    await crashScenario({ tag: 'torn-early', fraction: 0.05 });
    await crashScenario({ tag: 'torn-mid', fraction: 1 / 3 });
    await crashScenario({ tag: 'torn-late', fraction: 0.97 });
    await crashScenario({ tag: 'complete', complete: true });
  } catch (err) {
    console.error('boundedness-check 运行失败：', err);
    process.exit(1);
  }

  console.log(`\nboundedness-check 结果：${passed} 通过 / ${failed} 失败，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (failed > 0) {
    console.log('失败项：\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  console.log('十倍规模有界性与崩溃原子性核查全部通过。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
