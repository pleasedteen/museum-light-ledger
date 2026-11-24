import type {
  Layout,
  ParsedCandidate,
  ParsedCell,
  ParseResult,
} from './types.js';
import {
  cell,
  normalizeCabinet,
  parseReadingNumber,
  parseTime,
  scoreConfidence,
  unescapeHtml,
} from './parse-utils.js';

const METER_RE = /换表|更换(?:电)?表|新旧表/;
const CABINET_CELL_RE = /^[A-Za-z]{1,3}-?\d{1,4}$/;

interface TableCell {
  text: string;
  line: number;
  col: number;
  raw: string;
}

interface TableRow {
  cells: TableCell[];
  line: number;
  raw: string;
}

/** 用原始 HTML 的行号定位子串所在物理行（1 基） */
function lineAtOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

/** 提取文档中的所有表格（无第三方依赖的本地解析） */
function extractTables(content: string): TableRow[][] {
  const tables: TableRow[][] = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tableRe.exec(content)) !== null) {
    const body = tm[1]!;
    const bodyStart = tm.index + tm[0].indexOf(body);
    const rows: TableRow[] = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(body)) !== null) {
      const rowBody = rm[1]!;
      const rowOffset = bodyStart + rm.index;
      const rowLine = lineAtOffset(content, rowOffset);
      const cells: TableCell[] = [];
      const cellRe = /<(t[hd])\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
      let cm: RegExpExecArray | null;
      let col = 0;
      while ((cm = cellRe.exec(rowBody)) !== null) {
        col += 1;
        const cellOffset = rowOffset + cm.index;
        const text = unescapeHtml(
          cm[2]!
            .replace(/<br\s*\/?>(?!\n)/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .trim(),
        );
        cells.push({
          text,
          line: lineAtOffset(content, cellOffset),
          col,
          raw: unescapeHtml(cm[0]!).replace(/\s+/g, ' ').trim(),
        });
      }
      if (cells.length) rows.push({ cells, line: rowLine, raw: unescapeHtml(rowBody).replace(/\s+/g, ' ').slice(0, 160) });
    }
    tables.push(rows);
  }
  return tables;
}

function detectLayout(rows: TableRow[]): { layout: Layout; reason: string } {
  for (const r of rows) {
    const cabs = r.cells
      .map((c) => c.text.replace(/[\s　]/g, ''))
      .filter((t) => CABINET_CELL_RE.test(t));
    if (cabs.length >= 2) {
      return {
        layout: 'horizontal',
        reason: `第 ${r.line} 行表头含 ${cabs.length} 个柜号列，识别为【多柜并排】`,
      };
    }
  }
  return { layout: 'vertical', reason: '表头为字段名、每行一条巡检，识别为【逐柜纵排】' };
}

function meterNumbersFromCells(cells: TableCell[]): {
  oldFinal: number | null;
  newStart: number | null;
  oldCell: TableCell | null;
  newCell: TableCell | null;
} {
  let oldFinal: number | null = null;
  let newStart: number | null = null;
  let oldCell: TableCell | null = null;
  let newCell: TableCell | null = null;
  cells.forEach((c) => {
    const oldM = c.text.match(/旧表[^\d]{0,6}?(\d[\d,，.]*)/);
    const newM = c.text.match(/新表[^\d]{0,6}?(\d[\d,，.]*)/);
    if (oldM) {
      oldFinal = parseReadingNumber(oldM[1]!);
      oldCell = c;
    }
    if (newM) {
      newStart = parseReadingNumber(newM[1]!);
      newCell = c;
    }
  });
  // 兜底：标注了旧/新的两个相邻数字单元格
  if (oldFinal === null || newStart === null) {
    const nums = cells.filter((c) => parseReadingNumber(c.text) !== null && !/^\d{4}/.test(c.text));
    if (nums.length >= 2) {
      if (oldFinal === null) {
        oldFinal = parseReadingNumber(nums[0]!.text);
        oldCell = nums[0]!;
      }
      if (newStart === null) {
        newStart = parseReadingNumber(nums[1]!.text);
        newCell = nums[1]!;
      }
    }
  }
  return { oldFinal, newStart, oldCell, newCell };
}

export function parseHtml(content: string, materialKey: string): ParseResult {
  const notes: string[] = [];
  const tables = extractTables(content);
  const candidates: ParsedCandidate[] = [];
  let layout: Layout = 'unknown';

  if (tables.length === 0) {
    notes.push('未发现 <table>，无法按表格版式解析');
    return { materialKey, layout: 'unknown', candidates, notes };
  }
  notes.push(`提取到 ${tables.length} 个表格，共 ${tables.reduce((a, t) => a + t.length, 0)} 行`);

  // 全局表头签名：只收录“不含任何可解析数字”的表头行，避免把数据行误判为表头
  const allHeaderSigs = new Set<string>();
  tables.forEach((rows) => {
    const { layout: l } = detectLayout(rows);
    for (const r of rows) {
      const sig = r.cells.map((c) => c.text).join('|');
      const looksHeader = /柜号|巡检|时刻|读数/.test(sig);
      const hasNumber = r.cells.some((c) => parseReadingNumber(c.text) !== null);
      if (looksHeader && !hasNumber && (l === 'horizontal' || /柜号/.test(sig))) allHeaderSigs.add(sig);
    }
  });

  const horizState: HorizontalState = { cabinets: [], pendingRow: null, headerLine: -1 };
  const encounteredHeaders = new Set<string>();
  tables.forEach((rows, ti) => {
    const { layout: l, reason } = detectLayout(rows);
    const anyCabCell = rows.some((r) =>
      r.cells.some((c) => CABINET_CELL_RE.test(c.text.replace(/[\s　]/g, ''))),
    );
    const hasTimeHeader = rows.some((r) => r.cells.some((c) => /巡检|时刻|时间/.test(c.text)));
    // 已处于并排解析、且该表只含柜号续行（无“时刻”字段表头）时，按并排续行表处理
    const isContinuationTable = horizState.cabinets.length > 0 && anyCabCell && !hasTimeHeader;
    if (layout === 'unknown') layout = l;
    notes.push(
      isContinuationTable ? `表格 ${ti + 1}：识别为并排跨页续行表（柜号标签 + 残行）` : `表格 ${ti + 1}：${reason}`,
    );
    if (l === 'horizontal' || isContinuationTable) {
      parseHorizontalTable(rows, candidates, notes, allHeaderSigs, horizState, { keepPending: true });
    } else {
      parseVerticalTable(rows, candidates, notes, allHeaderSigs, encounteredHeaders);
    }
  });
  // 全部表格处理完，定稿最后一条待补巡检行
  if (horizState.pendingRow) finalizePendingRow(horizState, candidates, notes);

  return { materialKey, layout, candidates, notes };
}

function parseVerticalTable(
  rows: TableRow[],
  out: ParsedCandidate[],
  notes: string[],
  globalHeaderSigs: Set<string>,
  encountered: Set<string> = new Set(),
): void {
  // 列定位：寻找表头行各字段列
  let cabinetCol = -1;
  let timeCol = -1;
  let valueCol = -1;
  let oldCol = -1;
  let newCol = -1;
  let headerLine = -1;

  for (const r of rows) {
    r.cells.forEach((c) => {
      const t = c.text;
      if (/柜号/.test(t)) cabinetCol = c.col;
      if (/巡检|时刻|时间/.test(t)) timeCol = c.col;
      if (/读数|累计|光照/.test(t)) valueCol = c.col;
      if (/旧表|终值/.test(t)) oldCol = c.col;
      if (/新表|起值/.test(t)) newCol = c.col;
    });
    if (cabinetCol >= 0 || timeCol >= 0 || valueCol >= 0) {
      headerLine = r.line;
      break;
    }
  }
  void oldCol;
  void newCol;

  let prev: ParsedCandidate | null = null;

  for (const r of rows) {
    const sig = r.cells.map((c) => c.text).join('|');
    // 翻页重复表头：本文件任意位置出现过的表头签名再次出现即跳过并提示
    if (globalHeaderSigs.has(sig) && /柜号|巡检|时刻|读数/.test(sig)) {
      if (encountered.has(sig)) notes.push(`第 ${r.line} 行：翻页重复表头，已跳过`);
      encountered.add(sig);
      continue;
    }
    const get = (col: number) => (col > 0 ? r.cells.find((c) => c.col === col) : undefined);
    const cabCell = get(cabinetCol);
    const timeCell = get(timeCol);
    const valCell = get(valueCol);
    const isMeter = r.cells.some((c) => METER_RE.test(c.text));

    const cabRaw = cabCell?.text ?? '';
    const timeRaw = timeCell?.text ?? '';
    const time = parseTime(timeRaw);
    const issues: string[] = [];
    const evidence: ParsedCell[] = [cell(r.raw, r.line)];

    if (isMeter) {
      const mn = meterNumbersFromCells(r.cells);
      if (mn.oldCell) evidence.push(cell(mn.oldCell.text, mn.oldCell.line, mn.oldCell.col, mn.oldCell.raw));
      if (mn.newCell) evidence.push(cell(mn.newCell.text, mn.newCell.line, mn.newCell.col, mn.newCell.raw));
      if (!cabRaw) issues.push('unassigned-cabinet');
      if (time === null) issues.push('unparsed-time');
      if (mn.oldFinal === null) issues.push('missing-old-final');
      if (mn.newStart === null) issues.push('missing-new-start');
      const cand: ParsedCandidate = {
        kind: 'meter-change',
        cabinet: cabRaw ? normalizeCabinet(cabRaw) : '',
        time: time ?? '',
        value: null,
        oldFinal: mn.oldFinal,
        newStart: mn.newStart,
        note: `纵排 HTML 换表行（第 ${r.line} 行）`,
        confidence: scoreConfidence(issues, issues.length),
        evidence,
        issues,
        layoutReason: 'vertical',
      };
      // 跨页：柜号/时刻缺失时并入上一条
      if (prev && prev.kind === 'meter-change' && (!cabRaw || time === null)) {
        notes.push(`第 ${r.line} 行：换表跨页残片，与第 ${prev.evidence[0]?.line ?? '?'} 行合并`);
        mergeIntoPrev(prev, cand);
      } else {
        out.push(cand);
        prev = cand;
      }
      continue;
    }

    const value = valCell ? parseReadingNumber(valCell.text) : null;
    if (valCell) evidence.push(cell(valCell.text, valCell.line, valCell.col, valCell.raw));
    if (timeCell) evidence.push(cell(timeCell.text, timeCell.line, timeCell.col, timeCell.raw));
    if (cabCell) evidence.push(cell(cabCell.text, cabCell.line, cabCell.col, cabCell.raw));

    // 跨页：读数行缺柜号（新页只带时刻+读数）
    if (!cabRaw && prev && prev.kind === 'reading' && time !== null && value !== null) {
      notes.push(`第 ${r.line} 行：读数跨页残片（缺柜号），与柜号 ${prev.cabinet} 的上一条同页记录区分待核`);
    }

    if (!cabRaw) issues.push('unassigned-cabinet');
    if (time === null) issues.push('unparsed-time');
    if (value === null) issues.push('unparsed-reading');

    const cand: ParsedCandidate = {
      kind: 'reading',
      cabinet: cabRaw ? normalizeCabinet(cabRaw) : '',
      time: time ?? '',
      value,
      oldFinal: null,
      newStart: null,
      note: `纵排 HTML 巡检行（第 ${r.line} 行）`,
      confidence: scoreConfidence(issues, (!cabRaw ? 1 : 0) + (time === null ? 1 : 0) + (value === null ? 1 : 0)),
      evidence,
      issues,
      layoutReason: 'vertical',
    };

    // 与上一条做跨页字段补全：上一条缺时间或读数，本行能补上
    if (
      prev &&
      prev.kind === 'reading' &&
      (prev.time === '' || prev.value === null) &&
      (time !== null || value !== null)
    ) {
      notes.push(`第 ${r.line} 行：跨页残片合并到第 ${prev.evidence[0]?.line ?? '?'} 行记录`);
      mergeIntoPrev(prev, cand);
      prev.issues.push('cross-page-merge');
      continue;
    }
    out.push(cand);
    prev = cand;
  }
}

interface HorizontalState {
  cabinets: { name: string; col: number }[];
  /** 上一条尚缺柜列读数的巡检行（跨页/跨表续行合并目标） */
  pendingRow: { time: string; lineNo: number; values: Map<number, number | null> } | null;
  headerLine: number;
}

function parseHorizontalTable(
  rows: TableRow[],
  out: ParsedCandidate[],
  notes: string[],
  globalHeaderSigs: Set<string>,
  state: HorizontalState = { cabinets: [], pendingRow: null, headerLine: -1 },
  opts: { keepPending?: boolean } = {},
): HorizontalState {
  for (const r of rows) {
    const sig = r.cells.map((c) => c.text).join('|');
    const cabs = r.cells.filter((c) => CABINET_CELL_RE.test(c.text.replace(/[\s　]/g, '')));
    const looksHeader = cabs.length >= 2 && /柜号|读数|巡检/.test(r.cells.map((c) => c.text).join(''));
    const isRepeatedHeader = globalHeaderSigs.has(sig) && /柜号|巡检|时刻|读数/.test(sig);
    if (looksHeader) {
      // 新表头（含翻页后重复表头）：（重新）建立柜列映射，保证后续续行表能识别
      state.cabinets = cabs.map((c) => ({ name: normalizeCabinet(c.text), col: c.col }));
      state.headerLine = r.line;
      if (isRepeatedHeader) notes.push(`第 ${r.line} 行：翻页重复表头，已跳过（柜列映射已重建）`);
      continue;
    }
    if (isRepeatedHeader) {
      notes.push(`第 ${r.line} 行：翻页重复表头，已跳过`);
      continue;
    }
    if (state.cabinets.length === 0) {
      // 可能是跨表续行表（列结构不同），交给下方续行逻辑
      if (state.pendingRow) tryFillContinuation(r, state, notes, out);
      continue;
    }
    const isMeter = r.cells.some((c) => METER_RE.test(c.text));
    // 续行表中的子表头行（如“续行 | B-103”，整行无数字）：仅当无待补行时跳过
    const rowHasNumber = r.cells.some((c) => parseReadingNumber(c.text) !== null);
    if (!rowHasNumber && !isMeter) {
      continue;
    }

    if (isMeter) {
      const timeCell = r.cells.find((c) => parseTime(c.text) !== null);
      const time = timeCell ? parseTime(timeCell.text) : null;
      const cabCell = r.cells.find((c) => CABINET_CELL_RE.test(c.text.replace(/[\s　]/g, '')));
      const mn = meterNumbersFromCells(r.cells);
      const issues: string[] = [];
      if (!cabCell) issues.push('unassigned-cabinet');
      if (time === null) issues.push('unparsed-time');
      if (mn.oldFinal === null) issues.push('missing-old-final');
      if (mn.newStart === null) issues.push('missing-new-start');
      const evidence: ParsedCell[] = [cell(r.raw, r.line)];
      if (mn.oldCell) evidence.push(cell(mn.oldCell.text, mn.oldCell.line, mn.oldCell.col));
      if (mn.newCell) evidence.push(cell(mn.newCell.text, mn.newCell.line, mn.newCell.col));
      out.push({
        kind: 'meter-change',
        cabinet: cabCell ? normalizeCabinet(cabCell.text) : '',
        time: time ?? '',
        value: null,
        oldFinal: mn.oldFinal,
        newStart: mn.newStart,
        note: `并排 HTML 换表行（第 ${r.line} 行）`,
        confidence: scoreConfidence(issues, issues.length),
        evidence,
        issues,
        layoutReason: 'horizontal',
      });
      continue;
    }

    // 读数行：时刻通常在第 1 列，且必须位于行首
    const timeCell = r.cells[0];
    const startsWithDate = !!timeCell && /^\s*\d{4}[-/年]/.test(timeCell.text);
    const time = startsWithDate && timeCell ? parseTime(timeCell.text) : null;
    // 续行表行（列结构与主表不一致，如“承上页… | 2300”）：单元格数明显少于
    // 主表一行（时刻+各柜列），或其列号无法与任一主表柜列对齐
    const alignedWithMain = state.cabinets.some((c) => r.cells.some((x) => x.col === c.col));
    const structuralRow = state.pendingRow !== null && (r.cells.length < state.cabinets.length + 1 || !alignedWithMain);
    if (time === null || structuralRow) {
      if (state.pendingRow) {
        tryFillContinuation(r, state, notes, out);
        continue;
      }
      notes.push(`第 ${r.line} 行：并排表残行无法解析时刻且无可并入行，已标记待核`);
      state.cabinets.forEach((c) => {
        out.push({
          kind: 'reading',
          cabinet: c.name,
          time: '',
          value: null,
          oldFinal: null,
          newStart: null,
          note: `并排 HTML 残行（第 ${r.line} 行）`,
          confidence: 'low',
          evidence: [cell(r.raw, r.line)],
          issues: ['unparsed-time', 'cross-page-merge'],
          layoutReason: 'horizontal',
        });
      });
      continue;
    }

    const values = new Map<number, number | null>();
    state.cabinets.forEach((c) => {
      const vc = r.cells.find((x) => x.col === c.col);
      values.set(c.col, vc ? parseReadingNumber(vc.text) : null);
    });

    // 新时刻行到达：若上一条待补行属于更早时刻，先定稿（续行表应在其之前出现）
    if (state.pendingRow && state.pendingRow.time < time) {
      finalizePendingRow(state, out, notes);
    }

    state.pendingRow = { time, lineNo: r.line, values };
    if (![...values.values()].includes(null)) {
      finalizePendingRow(state, out, notes);
    } else {
      notes.push(
        `第 ${r.line} 行：${[...values.values()].filter((v) => v === null).length} 个柜列缺读数，等待跨页续行`,
      );
    }
  }
  // 待补行的定稿时机：新时刻行到达、续行补全、或全部表格结束（由 parseHtml 处理）
  if (state.pendingRow && !opts.keepPending) finalizePendingRow(state, out, notes, true);
  return state;
}

/** 续行表/残行：续行表列号是局部的，按“柜名标签格 + 同行数字格”补入 pendingRow 对应柜列 */
function tryFillContinuation(r: TableRow, state: HorizontalState, notes: string[], out: ParsedCandidate[]): void {
  if (!state.pendingRow) return;
  const missing = state.cabinets.filter((c) => state.pendingRow!.values.get(c.col) === null);
  let used = 0;

  // 路径一：行内出现柜名标签（如 B-103），取该行数字格补该柜列
  for (let i = 0; i < r.cells.length; i++) {
    const label = r.cells[i]!.text.replace(/[\s　]/g, '');
    const cab = state.cabinets.find((c) => c.name === label);
    if (!cab) continue;
    const numCell = r.cells.find((c) => parseReadingNumber(c.text) !== null);
    const v = numCell ? parseReadingNumber(numCell.text) : null;
    if (v !== null && state.pendingRow.values.get(cab.col) === null) {
      state.pendingRow.values.set(cab.col, v);
      used += 1;
    }
  }

  // 路径二：无柜名标签的纯数字残行，按缺列顺序补
  if (used === 0) {
    const nums = r.cells.filter((c) => parseReadingNumber(c.text) !== null);
    for (let k = 0; k < nums.length && k < missing.length; k++) {
      const target = missing[k]!;
      state.pendingRow.values.set(target.col, parseReadingNumber(nums[k]!.text));
      used += 1;
    }
  }

  if (used > 0) {
    notes.push(
      `第 ${r.line} 行：跨页/跨表续行，${used} 个读数补入第 ${state.pendingRow.lineNo} 行（${state.pendingRow.time}）`,
    );
  }
  if (![...state.pendingRow.values.values()].includes(null)) {
    // 补全后立即定稿到候选输出
    finalizePendingRow(state, out, notes);
  }
}

function finalizePendingRow(
  state: HorizontalState,
  out: ParsedCandidate[],
  notes: string[],
  silent = false,
): void {
  const row = state.pendingRow;
  if (!row) return;
  state.pendingRow = null;
  state.cabinets.forEach((c) => {
    const v = row.values.get(c.col) ?? null;
    const issues: string[] = [];
    if (v === null) issues.push('unparsed-reading');
    out.push({
      kind: 'reading',
      cabinet: c.name,
      time: row.time,
      value: v,
      oldFinal: null,
      newStart: null,
      note: `并排 HTML，柜列 col=${c.col}，表头第 ${state.headerLine} 行，数据第 ${row.lineNo} 行`,
      confidence: scoreConfidence(issues, v === null ? 1 : 0),
      evidence: [cell(`${row.time} | ${c.name}=${v ?? '空'}`, row.lineNo, c.col)],
      issues,
      layoutReason: 'horizontal',
    });
  });
  if (!silent) {
    const missing = [...row.values.values()].filter((v) => v === null).length;
    if (missing > 0 && notes.length >= 0) notes.push(`第 ${row.lineNo} 行定稿：仍有 ${missing} 个柜列缺读数，标记待核`);
  }
}

function mergeIntoPrev(prev: ParsedCandidate, extra: ParsedCandidate): void {
  if (prev.cabinet === '' && extra.cabinet) prev.cabinet = extra.cabinet;
  if (prev.time === '' && extra.time) prev.time = extra.time;
  if (prev.value === null && extra.value !== null) prev.value = extra.value;
  if (prev.oldFinal === null && extra.oldFinal !== null) prev.oldFinal = extra.oldFinal;
  if (prev.newStart === null && extra.newStart !== null) prev.newStart = extra.newStart;
  prev.evidence.push(...extra.evidence);
  prev.issues = Array.from(new Set([...prev.issues, ...extra.issues]));
  prev.confidence = scoreConfidence(prev.issues, 0);
}
