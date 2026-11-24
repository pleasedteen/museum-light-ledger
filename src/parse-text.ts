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
} from './parse-utils.js';

const CABINET_RE = /[A-Za-z]{1,3}[-]?\d{1,4}/;
const PAGE_RE = /(?:^|\s|[-—=*])\s*(?:第\s*\d+\s*页|page\s*\d+|共\s*\d+\s*页)\s*(?:$|[-—=*])/i;
const HEADER_RE = /巡检|时刻|读数|光照|柜号/;
const METER_RE = /换表|更换(?:电)?表|新旧表/;

interface RawFrag {
  cabinet: string | null;
  time: string | null;
  timeCell: ParsedCell | null;
  value: number | null;
  valueCell: ParsedCell | null;
  oldFinal: number | null;
  oldCell: ParsedCell | null;
  newStart: number | null;
  newCell: ParsedCell | null;
  isMeter: boolean;
  line: number;
  raw: string;
  issues: string[];
}

function extractMeterNumbers(line: string, lineNo: number): {
  oldFinal: number | null;
  oldCell: ParsedCell | null;
  newStart: number | null;
  newCell: ParsedCell | null;
} {
  let oldFinal: number | null = null;
  let newStart: number | null = null;
  let oldCell: ParsedCell | null = null;
  let newCell: ParsedCell | null = null;
  const oldM = line.match(/旧表[^\d]{0,6}?(\d[\d,，.]*)/);
  const newM = line.match(/新表[^\d]{0,6}?(\d[\d,，.]*)/);
  if (oldM && oldM.index !== undefined) {
    oldFinal = parseReadingNumber(oldM[1]!);
    oldCell = cell(oldM[1]!, lineNo, undefined, oldM[0]);
  }
  if (newM && newM.index !== undefined) {
    newStart = parseReadingNumber(newM[1]!);
    newCell = cell(newM[1]!, lineNo, undefined, newM[0]);
  }
  return { oldFinal, oldCell, newStart, newCell };
}

/** 判断一行里的柜号 token（排除被误认的时间片段与表计编号） */
function cabinetTokenIn(line: string, currentCabinet: string | null): string | null {
  const isMeterContext = /换表|表计|表号|新旧表/.test(line);
  for (const tok of line.split(/[\s|｜,，;；]+/)) {
    const t = tok.replace(/[:：#号柜展()（）]/g, '');
    if (/^[A-Za-z]{1,3}-?\d{1,4}$/.test(t)) {
      const norm = normalizeCabinet(t);
      // 换表/表计语境里的编号是表计编号，不是展柜；优先沿用当前展柜
      if (isMeterContext && (!currentCabinet || norm !== currentCabinet)) continue;
      return norm;
    }
  }
  if (!isMeterContext) {
    const m = line.match(CABINET_RE);
    return m ? normalizeCabinet(m[0]) : null;
  }
  return null;
}

export function parseText(content: string, materialKey: string): ParseResult {
  const notes: string[] = [];
  const lines = content.split(/\r?\n/);
  let layout: Layout = 'unknown';

  // 第一遍：版式识别
  let horizontalHeaderLine = -1;
  let verticalMarkers = 0;
  lines.forEach((ln, idx) => {
    const cabinetTokens = ln.match(/[A-Za-z]{1,3}-?\d{1,4}/g) ?? [];
    const uniq = new Set(cabinetTokens.map((t) => normalizeCabinet(t)));
    if (uniq.size >= 2 && /巡检|时刻|读数/.test(ln)) horizontalHeaderLine = idx;
    if (/柜号\s*[:：]/.test(ln)) verticalMarkers += 1;
  });
  if (horizontalHeaderLine >= 0) {
    layout = 'horizontal';
    notes.push(`第 ${horizontalHeaderLine + 1} 行表头含多个柜号列，识别为【多柜并排】版式`);
  } else if (verticalMarkers > 0) {
    layout = 'vertical';
    notes.push(`发现 ${verticalMarkers} 处“柜号：”分节标记，识别为【逐柜纵排】版式`);
  } else {
    notes.push('未发现明确版式标记，按逐柜纵排兜底解析');
    layout = 'vertical';
  }

  const candidates: ParsedCandidate[] = [];

  if (layout === 'horizontal') {
    parseHorizontal(lines, candidates, notes);
  } else {
    parseVertical(lines, candidates, notes);
  }

  // 合并结果的置信度汇总在构造候选时完成
  return { materialKey, layout, candidates, notes };
}

function parseVertical(lines: string[], out: ParsedCandidate[], notes: string[]): void {
  let currentCabinet: string | null = null;
  let lastFrag: RawFrag | null = null;
  let headerCount = 0;
  let pageCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === '') continue;

    if (PAGE_RE.test(raw)) {
      pageCount += 1;
      notes.push(`第 ${lineNo} 行：翻页标记（第 ${pageCount + 1} 页前后）`);
      continue;
    }

    const cabinetMark = line.match(/柜号\s*[:：]?\s*([A-Za-z0-9-]+)/);
    if (cabinetMark) {
      currentCabinet = normalizeCabinet(cabinetMark[1]!);
      lastFrag = null;
      continue;
    }

    if (HEADER_RE.test(line) && !/\d{4}/.test(line)) {
      headerCount += 1;
      if (headerCount > 1) notes.push(`第 ${lineNo} 行：重复表头（翻页后），已跳过`);
      continue;
    }

    const isMeter = METER_RE.test(line);
    const time = parseTime(line);
    const frag: RawFrag = {
      cabinet: currentCabinet,
      time,
      timeCell: time ? cell(line.replace(/\s+/g, ' ').slice(0, 32), lineNo) : null,
      value: null,
      valueCell: null,
      oldFinal: null,
      oldCell: null,
      newStart: null,
      newCell: null,
      isMeter,
      line: lineNo,
      raw,
      issues: [],
    };

    if (isMeter) {
      const mn = extractMeterNumbers(line, lineNo);
      frag.oldFinal = mn.oldFinal;
      frag.oldCell = mn.oldCell;
      frag.newStart = mn.newStart;
      frag.newCell = mn.newCell;
      const inlineCab = cabinetTokenIn(line, currentCabinet);
      // 换表行未显式写柜号时归属当前展柜
      frag.cabinet = inlineCab ?? currentCabinet;
    } else {
      frag.cabinet = currentCabinet;
      // 读数：取该行最后一个数字 token 作为累计读数
      const nums = line.match(/\d[\d,，.]*\d|\d/g);
      if (nums && nums.length) {
        const last = nums[nums.length - 1]!;
        frag.value = parseReadingNumber(last);
        frag.valueCell = cell(last, lineNo);
      }
    }

    // 跨页/残片合并：仅在“同一类型”的相邻片段间补字段，
    // 读数行不得并入换表片段，反之亦然
    const canMergeWith =
      lastFrag &&
      lastFrag.isMeter === isMeter &&
      (frag.time === null || frag.cabinet === null) &&
      (isMeter || frag.value !== null);
    if (canMergeWith && lastFrag) {
      notes.push(
        `第 ${lineNo} 行：跨页残片（缺${frag.time === null ? '时刻' : '柜号'}），与第 ${lastFrag.line} 行记录合并`,
      );
      mergeFrag(lastFrag, frag);
      lastFrag.issues.push('cross-page-merge');
      continue;
    }

    if (frag.cabinet === null) frag.issues.push('unassigned-cabinet');
    if (frag.time === null) frag.issues.push('unparsed-time');
    if (!isMeter && frag.value === null) frag.issues.push('unparsed-reading');
    if (isMeter && frag.oldFinal === null) frag.issues.push('missing-old-final');
    if (isMeter && frag.newStart === null) frag.issues.push('missing-new-start');

    lastFrag = frag;
    pushCandidate(frag, out);
  }
}

function parseHorizontal(lines: string[], out: ParsedCandidate[], notes: string[]): void {
  let cabinets: string[] = [];
  let headerLine = -1;
  let prevRow: { time: string | null; values: (number | null)[]; lineNo: number; raw: string } | null = null;
  let headerCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === '') continue;
    if (PAGE_RE.test(raw)) {
      notes.push(`第 ${lineNo} 行：翻页标记`);
      continue;
    }

    const tokens = line.split(/[\s|｜]+/).filter((t) => t !== '');

    // 表头行：含至少两个柜号 token
    const cabTokens = tokens.filter((t) => /^[A-Za-z]{1,3}-?\d{1,4}$/.test(t));
    if (cabTokens.length >= 2 && /巡检|时刻|读数|柜号/.test(line)) {
      cabinets = cabTokens.map((t) => normalizeCabinet(t));
      headerLine = lineNo;
      headerCount += 1;
      if (headerCount > 1) notes.push(`第 ${lineNo} 行：翻页后重复表头，已跳过`);
      continue;
    }
    if (cabinets.length === 0) {
      notes.push(`第 ${lineNo} 行：表头出现前的数据行，跳过（${line.slice(0, 24)}）`);
      continue;
    }

    // 换表行
    if (METER_RE.test(line)) {
      const time = parseTime(line);
      const mn = extractMeterNumbers(line, lineNo);
      // 换表行柜号：只接受形如 B-202 的展柜 token，排除“柜号”等文字
      const inlineCab =
        line.match(/柜号\s*([A-Za-z]{1,3}-?\d{1,4})/)?.[1] ??
        (line.split(/[\s|｜,，;；]+/).find((t) => /^[A-Za-z]{1,3}-?\d{1,4}$/.test(t)) ?? null);
      const issues: string[] = [];
      if (!inlineCab) issues.push('unassigned-cabinet');
      if (time === null) issues.push('unparsed-time');
      if (mn.oldFinal === null) issues.push('missing-old-final');
      if (mn.newStart === null) issues.push('missing-new-start');
      const evidence: ParsedCell[] = [cell(line, lineNo)];
      if (mn.oldCell) evidence.push(mn.oldCell);
      if (mn.newCell) evidence.push(mn.newCell);
      out.push({
        kind: 'meter-change',
        cabinet: inlineCab ? normalizeCabinet(inlineCab) : '',
        time: time ?? '',
        oldFinal: mn.oldFinal,
        newStart: mn.newStart,
        value: null,
        note: `并排版式换表行（表头位于第 ${headerLine} 行）`,
        confidence: scoreConfidence(issues, issues.length),
        evidence,
        issues,
        layoutReason: 'horizontal',
      });
      continue;
    }

    // 读数行：行首匹配“日期 + 时刻”（可能含空格），剩余部分按列切分
    const timeMatch = line.match(/^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?(?:\s+\d{1,2}[:：]\d{2}(?:[:：]\d{2})?)?/);
    const time = timeMatch ? parseTime(timeMatch[0]!) : parseTime(tokens[0] ?? '');
    const rest = timeMatch ? line.slice(timeMatch[0]!.length) : line;
    const valueTokens = rest.split(/[\s|｜]+/).filter((t) => t !== '');
    const values = valueTokens.map((t) => parseReadingNumber(t));

    if (time === null) {
      // 跨页残片行：补齐上一行缺失的尾部柜列
      if (prevRow && prevRow.values.filter((v) => v === null).length > 0) {
        notes.push(
          `第 ${lineNo} 行：跨页残片（无时刻，${values.length} 个读数），补入第 ${prevRow.lineNo} 行缺失柜列`,
        );
        let vi = 0;
        for (let c = 0; c < cabinets.length && vi < values.length; c++) {
          if (prevRow.values[c] === null) {
            prevRow.values[c] = values[vi]!;
            vi += 1;
          }
        }
        continue;
      }
      notes.push(`第 ${lineNo} 行：无法解析时刻且无可并入的上一行，已跳过`);
      continue;
    }

    const row = { time, values: values.slice(0, cabinets.length), lineNo, raw };
    // 补齐缺列
    while (row.values.length < cabinets.length) row.values.push(null);
    prevRow = row;
    emitHorizontalRow(row, cabinets, headerLine, out, notes);
  }
}

function emitHorizontalRow(
  row: { time: string | null; values: (number | null)[]; lineNo: number; raw: string },
  cabinets: string[],
  headerLine: number,
  out: ParsedCandidate[],
  notes: string[],
): void {
  cabinets.forEach((cab, idx) => {
    const v = row.values[idx] ?? null;
    const issues: string[] = [];
    if (v === null) issues.push('unparsed-reading');
    out.push({
      kind: 'reading',
      cabinet: cab,
      time: row.time ?? '',
      value: v,
      oldFinal: null,
      newStart: null,
      note: `并排版式第 ${idx + 1} 柜列（表头第 ${headerLine} 行）`,
      confidence: scoreConfidence(issues, v === null ? 1 : 0),
      evidence: [
        cell(row.time ?? '', row.lineNo, 1),
        cell(v === null ? '' : String(v), row.lineNo, idx + 2),
      ],
      issues,
      layoutReason: 'horizontal',
    });
  });
  const missing = row.values.filter((v) => v === null).length;
  if (missing > 0) notes.push(`第 ${row.lineNo} 行：${missing} 个柜列缺读数，标记待核`);
}

function mergeFrag(target: RawFrag, extra: RawFrag): void {
  if (target.time === null && extra.time !== null) {
    target.time = extra.time;
    target.timeCell = extra.timeCell;
  }
  if (target.value === null && extra.value !== null) {
    target.value = extra.value;
    target.valueCell = extra.valueCell;
  }
  if (target.oldFinal === null && extra.oldFinal !== null) {
    target.oldFinal = extra.oldFinal;
    target.oldCell = extra.oldCell;
  }
  if (target.newStart === null && extra.newStart !== null) {
    target.newStart = extra.newStart;
    target.newCell = extra.newCell;
  }
  if (target.cabinet === null && extra.cabinet !== null) target.cabinet = extra.cabinet;
  target.issues = Array.from(new Set([...target.issues, ...extra.issues]));
}

function pushCandidate(frag: RawFrag, out: ParsedCandidate[]): void {
  const missing =
    (frag.cabinet === null ? 1 : 0) +
    (frag.time === null ? 1 : 0) +
    (frag.isMeter ? 0 : frag.value === null ? 1 : 0);
  const evidence: ParsedCell[] = [cell(frag.raw.trim(), frag.line)];
  if (frag.timeCell) evidence.push(frag.timeCell);
  if (frag.valueCell) evidence.push(frag.valueCell);
  if (frag.oldCell) evidence.push(frag.oldCell);
  if (frag.newCell) evidence.push(frag.newCell);
  out.push({
    kind: frag.isMeter ? 'meter-change' : 'reading',
    cabinet: frag.cabinet ?? '',
    time: frag.time ?? '',
    value: frag.isMeter ? null : frag.value,
    oldFinal: frag.isMeter ? frag.oldFinal : null,
    newStart: frag.isMeter ? frag.newStart : null,
    note: `逐柜纵排，原文第 ${frag.line} 行`,
    confidence: scoreConfidence(frag.issues, missing),
    evidence,
    issues: [...frag.issues],
    layoutReason: 'vertical',
  });
}
