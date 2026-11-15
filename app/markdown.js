// A small Markdown reader for bounty descriptions and rules, building DOM nodes (never innerHTML): headings,
// paragraphs, bullet and numbered lists, fenced code, block quotes, tables, and inline code, bold, italics and links.
// Links keep only https:, http: and make.fun-relative targets.

import { adoptViewStyles, el, MAKEFUN_ORIGIN } from './app.js';
/** Block Markdown as a DocumentFragment. */
export function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(6, heading[1].length + 1);
      fragment.append(el(`h${level}`, { className: 'md-heading' }, renderInlineMarkdown(heading[2])));
      i++;
    } else if (line.startsWith('```')) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      i++;
      fragment.append(el('pre', { className: 'md-code' }, el('code', null, code.join('\n'))));
    } else if (/^>\s?/.test(line)) {
      const quoted = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) quoted.push(lines[i].replace(/^>\s?/, ''));
      fragment.append(el('blockquote', null, renderMarkdown(quoted.join('\n'))));
    } else if (isTableRow(line) && isTableRow(lines[i + 1] || '') && /^[\s|:-]+$/.test(lines[i + 1])) {
      const header = tableCells(line);
      const rows = [];
      for (i += 2; i < lines.length && isTableRow(lines[i]); i++) rows.push(tableCells(lines[i]));
      fragment.append(
        el('div', { className: 'table-scroll' }, el('table', { className: 'md-table' }, el('thead', null, el('tr', null, header.map((cell) => el('th', null, renderInlineMarkdown(cell))))), el('tbody', null, rows.map((row) => el('tr', null, row.map((cell) => el('td', null, renderInlineMarkdown(cell)))))))),
      );
    } else if (/^\s*([-*+]|\d+[.)])\s/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const list = el(ordered ? 'ol' : 'ul', { className: 'md-list' });
      let item = null;
      for (; i < lines.length && lines[i].trim(); i++) {
        const bullet = lines[i].match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
        if (bullet) {
          item = el('li', null, renderInlineMarkdown(bullet[1]));
          list.append(item);
        } else item?.append(' ', ...renderInlineMarkdown(lines[i].trim()));
      }
      fragment.append(list);
    } else {
      const paragraph = [line.trim()];
      for (i++; i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i]) && !isTableRow(lines[i]); i++) paragraph.push(lines[i].trim());
      fragment.append(el('p', null, renderInlineMarkdown(paragraph.join(' '))));
    }
  }
  return fragment;
}

/** Split Markdown by its top-level "## " headings: [{ title, body }]. */
export function splitMarkdownSections(source) {
  const sections = [];
  let current = { title: '', lines: [] };
  for (const line of String(source || '').split('\n')) {
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) {
      if (current.title || current.lines.some((l) => l.trim())) sections.push(current);
      current = { title: heading[1].trim(), lines: [] };
    } else current.lines.push(line);
  }
  sections.push(current);
  return sections.map(({ title, lines }) => ({ title, body: lines.join('\n') }));
}

const INLINE_PATTERN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(https:\/\/[^\s)<>"]+[^\s)<>".,;:!?])|(\*[^*\s][^*]*\*)/g;

function safeLinkTarget(target) {
  if (target.startsWith('/')) return MAKEFUN_ORIGIN + target;
  return /^https?:\/\//i.test(target) ? target : null;
}

function externalLink(href, text) {
  return el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
}

/** Inline Markdown of one line or paragraph as an array of nodes and strings. */
export function renderInlineMarkdown(text) {
  const output = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    if (match.index > last) output.push(text.slice(last, match.index));
    const [token, code, bold, link, bareUrl, italic] = match;
    if (code) output.push(el('code', null, code.slice(1, -1)));
    else if (bold) output.push(el('strong', null, renderInlineMarkdown(bold.slice(2, -2))));
    else if (link) {
      const [, label, target] = link.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      const href = safeLinkTarget(target);
      output.push(href ? externalLink(href, renderInlineMarkdown(label)) : label);
    } else if (bareUrl) output.push(externalLink(bareUrl, bareUrl));
    else if (italic) output.push(el('em', null, italic.slice(1, -1)));
    else output.push(token);
    last = match.index + token.length;
  }
  if (last < text.length) output.push(text.slice(last));
  return output;
}

const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const tableCells = (line) => line.trim().slice(1, -1).split('|').map((cell) => cell.trim());
const BLOCK_START = /^(#{1,6}\s|```|>\s?|\s*[-*+]\s|\s*\d+[.)]\s)/;

adoptViewStyles(`
.prose{overflow-wrap:break-word}
.prose>:first-child{margin-top:0}
.prose p,.md-list{max-width:78ch}
.md-heading{margin-top:1.2em;font-size:1.05rem}
.prose code{padding:1px 5px;border-radius:6px;background:var(--surface-2);font-family:var(--mono);font-size:.86em}
.md-code{padding:12px;overflow-x:auto;border-radius:6px;background:var(--surface-2);font-size:.86em}
.md-code code{padding:0;background:none;font-size:1em}
.prose blockquote{margin:0;padding-left:12px;border-left:3px solid var(--border);color:var(--muted)}
`);
