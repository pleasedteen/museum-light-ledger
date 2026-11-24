import { parseHtml } from './parse-html.js';
import { parseText } from './parse-text.js';
import { hashString } from './parse-utils.js';
import type { ParseResult } from './types.js';

export function parseMediaType(fileName: string, explicit?: string): 'html' | 'text' {
  if (explicit === 'text/html' || explicit === 'html') return 'html';
  if (explicit === 'text/plain' || explicit === 'text') return 'text';
  return /\.x?html?$/i.test(fileName) ? 'html' : 'text';
}

/** 依扩展名/媒体类型选择解析器并解析原文（纯函数，不落库） */
export function runParse(req: {
  materialId: string;
  fileName: string;
  mediaType?: string;
  content: string;
}): ParseResult {
  const kind = parseMediaType(req.fileName, req.mediaType);
  const materialKey = `${req.materialId}#${hashString(req.content)}`;
  return kind === 'html' ? parseHtml(req.content, materialKey) : parseText(req.content, materialKey);
}
