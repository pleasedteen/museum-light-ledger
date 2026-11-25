# 博物馆光照台账（museum-light-ledger）

本地 HTTP 服务：批量导入各馆抄表单（HTML / 纯文本，逐柜纵排或多柜并排），
自动识别版式、合并跨页记录、派生复核队列、计算规范表光照增量，
并提供按展柜/时刻查询、JSON Lines 导出、崩溃安全持久化与可核对的访问量。

## 1. 安装与启动

```bash
npm install
npm run build          # TypeScript 编译到 dist/
npm start              # 默认数据目录 ./data，端口 8080
# 或自定义：node dist/src/server.js <数据目录> <端口> <主机>
node dist/src/server.js ./data 8080 127.0.0.1
```

健康检查：`GET /health`。

## 2. 一条命令跑测试（依赖装好后 80 秒内）

```bash
npm test
```

该命令先编译再运行 `dist/test/run-tests.js`，覆盖：版式识别、跨页/跨表合并、
换表接续、复核确认/订正/拒绝、幂等、补送/更正/撤回、JSON Lines、
5000 条历史下的访问量有界性、写入中断后的崩溃原子性，以及断写后续写、
补发与二次重启的恢复链（材料/待核项/区间一起恢复、残尾粘连找回、
顺序无法确认时报错并保留原文件）。实测约 15 秒，输出逐条可读断言与汇总。

## 3. 材料版式约定

- **逐柜纵排**：以“柜号: X-01”分节，其后每行一条“时刻 + 累计读数”；
  换表行形如 `换表：旧表终值 2450，新表起值 100`。
- **多柜并排**：表头行含多个柜号列（`巡检时刻  B-101  B-102 …`），
  其后每行一条巡检，各柜列对应读数。
- **翻页**：`第 N 页 / 共 M 页` 等标记与重复表头自动跳过；
  同一条巡检的柜号/读数拆在两页时（无时刻残行、或独立续行表）自动合并，
  合并动作写入解析说明，并给候选打上 `cross-page-merge` 待核标记。
- 时刻支持 `2026-11-01 09:00`、`2026/11/1 9:00`、`2026年11月1日 9时`、全角数字等。
- 读数容忍千分位、全角数字、常见单位后缀。

## 4. HTTP 接口

所有请求/响应均为 UTF-8 JSON（导出接口除外）。写接口的响应体带 `access`
字段，给出本次请求与累计的记录/索引访问计数。

### 4.1 导入 / 更正 / 撤回材料

`POST /materials`

```json
{
  "materialId": "mat-A",
  "fileName": "a-vertical.html",
  "mediaType": "text/html",          // 或 text/plain；缺省按扩展名判断
  "content": "<!doctype html> …",
  "op": "ingest",                    // ingest(默认) | correct | withdraw
  "clientToken": "可选幂等令牌"
}
```

响应含 `outcome`（材料版本、记录主键、幂等命中标记）与 `parse`
（识别版式、解析说明、带置信度与证据的候选列表）。

- **幂等**：同一 `materialId` + 相同动作（op）+ 相同内容（哈希）重复送达，直接返回
  `idempotentHit: true` 以及首次提交的 `operationSeq` 与 `version`，状态序号不变；
  已撤回的材料补发仍保持撤回，不产生新版本。
- **correct（补送/更正）**：生成新版本，旧版本置 `superseded` 并退出规范表，
  新版本记录重新派生复核项。
- **withdraw（撤回）**：该材料全部版本置 `withdrawn`，其记录退出时间线，
  审计痕迹保留。

### 4.2 仅解析预览（不落库）

`POST /parse-preview`，请求体同上，返回版式与候选，便于导入前核对。

### 4.3 复核队列

- `GET /reviews?status=pending|confirmed|corrected|rejected|all&cabinet=X-01`
- `POST /reviews/decision`

```json
{
  "reviewId": "mat-A|A-03|2026-11-02T09:00:00Z|reading#negative-delta",
  "decision": "corrected",          // confirmed | corrected | rejected
  "decidedBy": "keeper-1",
  "correction": { "value": 580 }    // 订正时可给 cabinet/time/value/oldFinal/newStart
}
```

复核结论与规范表在**同一事务**内生效。`rejected` 会让该记录退出规范表；
`corrected` 会移动时间线索引并重算区间。

### 4.4 规范表区间查询

`GET /intervals?cabinet=A-01&from=2026-11-03T00:00:00Z&to=2026-11-08T23:59:00Z`

每个区间：

```json
{
  "intervalId": "A-01@2026-11-03T09:00:00Z->2026-11-05T09:00:00Z",
  "cabinet": "A-01",
  "fromTime": "…", "toTime": "…",
  "delta": 600,                      // 跨换表时按旧终值/新起值接续；无法计算为 null
  "status": "ok|pending-review|anomaly",
  "pendingReasons": ["终点:unparsed-reading"],
  "meterChanges": [{ "time": "…", "oldFinal": 2450, "newStart": 100, "recordKey": "…" }],
  "evidence": [{ "materialId": "…", "version": 1, "lines": [7], "snippets": ["…"] }]
}
```

跨换表增量：`(旧表终值 − 区间起点读数) + Σ(后续表段增量)`，换表本身不计光照。
已定位到展柜和时刻但仍待核的记录，相关区间 `status=pending-review`、`delta=null`
（若数值本身可算则仍给出 delta，同时标记待核）。

### 4.5 候选记录与材料台账

- `GET /records?cabinet=A-01&kind=reading&active=1`
- `GET /materials` 或 `GET /materials?materialId=mat-A`

### 4.6 JSON Lines 导出

`GET /export.jsonl?cabinet=A-01&from=…&to=…`

每行一个区间 JSON，带 `Content-Disposition` 附件头。

### 4.7 访问量（可核对）

- `GET /access`：累计计数 + 本次请求计数
- `POST /access/reset`：归零并作为一次事务持久化

字段：`recordReads/recordWrites`（规范记录按键访问次数）、
`indexReads/indexWrites`（每柜时间线索引的二分定位/定点写入次数）、
`requests`。

## 5. 持久化与崩溃安全

数据目录布局：

```
<dataDir>/
  snapshot.json     # 周期性压缩快照（tmp + rename 原子替换）
  journal.log       # 追加操作日志，每条 fsync 后才算生效
```

- 一次操作 = 一条日志项，内含完整状态（规范表时间线 + 复核状态 + 计数），
  二者要么整条可见、要么整条不可见。
- 写入中断留下半条日志（残尾）：重启重放时跳过残尾，已 `fsync` 返回成功的
  操作全部保留；残尾**之后**已完整写入的提交（含旧版粘连在残尾同一行的）
  也会找回。继续追加前会先补换行终止残尾，避免新提交与残尾粘连。
- 找回的提交序号必须与快照逐一衔接；无法确认顺序（缺号、同号冲突）时
  启动报错（`JournalRecoveryError`）并原样保留 `journal.log`，需人工核对。
- 快照写入走 `snapshot.tmp → rename`，中断不破坏旧快照/旧日志。
- `/test/crash-during-write` 故障注入仅供测试：仅当以
  `MLL_FAULT_INJECTION=1` 启动（或 `startServer(..., { faultInjection: true })`）
  时才注册，正常启动对该路径返回 404。

## 6. 访问量有界性保证

每柜维护按时刻排序的时间线索引（仅含 `cabinet/time/recordKey` 轻量项）。

- 查询：两次定长索引访问确定锚点与窗口，再按键读取窗口内记录，
  每条记录在单次查询中只读一次。`recordReads = O(窗口内巡检数)`，
  与该柜历史长度无关；`indexReads ≤ 2`。
- 变动一条读数（更正/复核订正）：索引定点 upsert/remove（二分定位 +
  一次 splice），`indexWrites` 为常数，不扫描历史。
- 5000 条历史、10 天窗口的实测计数见 `npm test` 第 6 节断言。

## 7. 本地夹具

`fixtures/` 下：

| 文件 | 版式 | 覆盖点 |
| --- | --- | --- |
| `a-vertical.html` | 纵排 HTML | 翻页重复表头、跨表续抄 |
| `b-horizontal-split.html` | 并排 HTML | 同一巡检拆两页、独立续行表补全 |
| `c-vertical-text-meter.txt` | 纵排文本 | 换表旧终值/新起值、读数下降异常 |
| `d-horizontal-text.txt` | 并排文本 | 残行补列、换表后接续区间 |
