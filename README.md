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
5000 条历史下的访问量有界性、写入中断后的崩溃原子性，以及**按批送达**：
整批原子发布/回滚、校验期间并发批外订正、重启后原批重送拿首次回执、
同批号换内容冲突。实测约 20 秒，输出逐条可读断言与汇总。

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

- **幂等**：同一 `materialId` + 相同内容（哈希）重复送达，直接返回
  `idempotentHit: true`，状态序号不变。
- **correct（补送/更正）**：生成新版本，旧版本置 `superseded` 并退出规范表，
  新版本记录重新派生复核项。
- **withdraw（撤回）**：该材料全部版本置 `withdrawn`，其记录退出时间线，
  审计痕迹保留。

### 4.2 按批送达（整批原子发布）

馆方一次送来多份独立材料（其中也可能有更正或撤回）时，用批量接口。

`POST /materials/batch`

```json
{
  "batchId": "batch-20261124-1",
  "items": [
    { "materialId": "mat-A", "fileName": "a-vertical.html", "mediaType": "text/html", "content": "…", "op": "ingest" },
    { "materialId": "mat-C", "fileName": "c-vertical-meter.txt", "mediaType": "text/plain", "content": "…", "op": "correct" }
  ]
}
```

语义：

- **整批原子**：全部 `items` 解析、校验通过后，在**同一次事务**内按送达顺序
  逐份应用，只产生一条操作日志（序号 +1）。任一份失败则**整批不生效**，
  已应用部分随事务回滚，状态序号不变。
- **校验与发布两阶段**：`prepareBatch` 先做纯解析/校验（每份之间让出事件循环），
  期间保管员仍可提交**批外**材料的订正/撤回；发布阶段基于**最新状态**再校验
  一次引用有效性（例如批内 `correct` 引用的材料若已被批外撤回，则该批拒绝）。
  因此批外订正在发布后依然保留。
- **区间与复核按整批生效后的材料重算**：发布后对受影响柜/时刻邻域的活动记录
  重新派生复核项；已确认/已订正的人工结论不会被重算推翻（问题消失则自动确认）。
- **逐份回执**：响应 `receipt.items[]` 给出每份的 `index / version / recordKeys /
  layout / candidateCount / idempotentHit`。
- **重启后原批重送**：批号 + 内容哈希存入持久化状态。同一批号 + 相同内容
  重送返回**首次逐份回执**（`idempotentHit: true`，逐字段一致，含首次操作序号），
  不改状态序号。
- **同一批号换内容**：返回 `409 batch conflict`，整批不生效、不污染规范表。
  被校验拒绝的批次不占批号，修正后可用同批号重送。
- 批次内不得出现重复的 `materialId`（返回 `422` 并指明 `duplicate-material`）。

整批被拒时响应为 `422`，`published: false`，`failures[]` 逐份给出
`index / materialId / errorCode / errorDetail`（如 `empty-material`、
`unknown-material`、`unsupported-op`、`duplicate-material`、`parse-error`）。

### 4.3 仅解析预览（不落库）

`POST /parse-preview`，请求体同上，返回版式与候选，便于导入前核对。

### 4.4 复核队列

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

### 4.5 规范表区间查询

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

### 4.6 候选记录与材料台账

- `GET /records?cabinet=A-01&kind=reading&active=1`
- `GET /materials` 或 `GET /materials?materialId=mat-A`

### 4.7 JSON Lines 导出

`GET /export.jsonl?cabinet=A-01&from=…&to=…`

每行一个区间 JSON，带 `Content-Disposition` 附件头。

### 4.8 访问量（可核对）

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

- 一次操作 = 一条日志项，内含完整状态（规范表时间线 + 复核状态 + 计数）。
  二者要么整条可见、要么整条不可见。
- **批量送达**同样是一次操作：整批的规范表变动、复核重算与批号回执都写在同一
  条日志项里，崩溃不会留下“部分成员已发布”的中间态。
- 写入中断留下半条日志：重启重放到最后一条完整 JSON 即停止，
  已 `fsync` 返回成功的操作全部保留；同时**将残缺尾部截断**（tmp + rename），
  避免继续追加后残缺行不再位于末尾、下次重启回放提前中断而丢失其后的操作。
- 快照写入走 `snapshot.tmp → rename`，中断不破坏旧快照/旧日志。

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
| `e-batch-vertical.txt` / `f-batch-vertical.txt` | 纵排文本 | 批量送达：两份合法材料整批发布 |
| `g-batch-invalid.txt` | 纯文本（无可解析行） | 批量送达：任一份失败整批回滚 |
| `h-outside.txt` / `m1-outside-correct.txt` | 纵排文本 | 校验期间批外订正，发布后保留 |
| `i-batch-dupe.txt` | 纵排文本 | 校验期间批外撤回导致引用失效，整批拒绝 |
| `j-batch-valid2.txt` | 纵排文本 | 批外撤回 / 回滚对照组 |
| `k1-batch.txt` / `k2-batch.txt` | 纵排文本 | 同批内跨材料同柜同刻，复核重算 |
