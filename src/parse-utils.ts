import type { Confidence, ParsedCell } from './types.js';

/** 规范化柜号：去掉空白与全角空格，大写化 */
export function normalizeCabinet(raw: string): string {
  return raw.replace(/[\s　]+/g, '').toUpperCase();
}

/** 解析抄表数字：容忍全角数字、千分位逗号、单位后缀 */
export function parseReadingNumber(raw: string): number | null {
  if (raw === undefined || raw === null) return null;
  let s = raw
    .replace(/[，,]/g, '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, '.')
    .trim();
  // 去掉常见单位
  s = s.replace(/(lux|lx|勒克斯|流明|度|kwh|kWh|千瓦时|表码)?/gi, '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const CN_NUM: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/**
 * 解析巡检/换表时刻。支持：
 *  2026-11-01 09:00、2026/11/1 9:00、20261101 0900、
 *  2026年11月1日 9时、中文数字日期等。
 * 失败返回 null。
 */
export function parseTime(raw: string): string | null {
  if (!raw) return null;
  let s = raw
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ':')
    .replace(/[－–—]/g, '-')
    .trim();
  if (!s) return null;

  // 中文数字转阿拉伯
  s = s.replace(/[〇零一二两三四五六七八九]/g, (c) => String(CN_NUM[c]));

  // 分隔形式：年/月/日 + 可选 时:分(:秒)。时分秒必须跟在日期之后，避免把同行读数吞成“秒”
  let m = s.match(
    /(\d{4})\D+(\d{1,2})\D+(\d{1,2})(?:[^\d]+(\d{1,2})[：:](\d{1,2})(?:[：:](\d{1,2}))?)?/,
  );
  if (!m) {
    // 紧凑形式 20261101 0900 / 202611010900
    m = s.match(/(\d{4})(\d{2})(\d{2})(?:\D*(\d{2}))?(?:\D*(\d{2}))?/);
    if (!m) return null;
  }
  const [, y, mo, d, h, mi, se] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const hour = h ? Number(h) : 0;
  const min = mi ? Number(mi) : 0;
  const sec = se ? Number(se) : 0;
  if (hour > 23 || min > 59 || sec > 59) return null;
  const dt = new Date(Date.UTC(year, month - 1, day, hour, min, sec));
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().replace('.000Z', 'Z');
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 由字段完整度与问题数给出置信度 */
export function scoreConfidence(issues: string[], missingFields: number): Confidence {
  if (issues.length > 0 || missingFields > 1) return 'low';
  if (missingFields === 1) return 'medium';
  return 'high';
}

export function cell(value: string, line: number, col?: number, raw?: string): ParsedCell {
  return { value, line, col, raw };
}

/** 简单 HTML 转义反转义，仅用于本地可信抄表单 */
export function unescapeHtml(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

export function hashString(s: string): string {
  // FNV-1a 32bit，本地去重足够
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function lowerConfidence(c: Confidence): Confidence {
  if (c === 'high') return 'medium';
  return 'low';
}
