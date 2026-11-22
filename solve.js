// A faster drop-in for makefun-site 1.0.0, written from its specification
// (README.md of makefun-site 1.0.0): the same front matter, Markdown subset,
// template dialect, slug rule and report, byte for byte, but with the
// template interpreter replaced by a per-case code generator, a fused
// single-pass Markdown renderer, and a cached slugify. No imports, no
// dependencies, no state kept between run() calls (every cache is made
// fresh inside run()).

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
  if (!/[&<>"']/.test(text)) return text;
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. Pure ASCII text is unchanged by NFKD, so it takes a direct loop.
 */
function slugify(text) {
  let ascii = true;
  for (let k = 0; k < text.length; k++) {
    if (text.charCodeAt(k) > 127) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let k = 0; k < plain.length; k++) {
    const ch = plain[k];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const parts = date.split('-');
  return `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
}

/**
 * The words of a body: its runs of characters other than whitespace.
 * A manual scan, exactly the whitespace set of /\s/ (no allocation, unlike
 * a match, which builds an array of every word).
 */
function wordsOf(text) {
  let n = 0;
  let word = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff) word = false;
    else if (!word) {
      word = true;
      n++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || !FM_TAG.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The lines are
 * walked with indexOf, so the body is one slice, never a split and re-join.
 */
function parseFrontMatter(text) {
  if (text.slice(0, 3) !== '---' || (text.length > 3 && text[3] !== '\n')) return { error: 'no front matter' };
  const data = {};
  let pos = 4;
  let lineNo = 2;
  let body = null;
  while (true) {
    const nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    if (line === '---') {
      body = nl === -1 ? '' : text.slice(nl + 1);
      break;
    }
    if (!isBlank(line) && line[0] !== '#') {
      const m = FM_LINE.exec(line);
      if (m === null) return { error: `line ${lineNo} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] === undefined ? '' : m[2]).replace(/[ \t]+$/, '');
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if (v.error !== undefined) return v;
      data[key] = v.value;
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    pos = nl + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

/** A line of spaces and tabs only (or empty). */
function isBlank(s) {
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A fence-open line: three backticks and an optional language, then spaces or tabs only. Returns the language, or null. */
function fenceOpen(s) {
  if (s[0] !== '`' || s[1] !== '`' || s[2] !== '`') return null;
  let j = 3;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = s.slice(3, j);
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
  return j === s.length ? lang : null;
}

/** A fence-close line: three backticks, then spaces or tabs only. */
function isFenceClose(s) {
  if (s[0] !== '`' || s[1] !== '`' || s[2] !== '`') return false;
  for (let j = 3; j < s.length; j++) {
    if (s[j] !== ' ' && s[j] !== '\t') return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(s) {
  let j = 0;
  while (j < s.length && s[j] === '#') j++;
  if (j === 0 || j > 6) return null;
  if (s[j] !== ' ' && s[j] !== '\t') return null;
  let a = j;
  while (a < s.length && (s[a] === ' ' || s[a] === '\t')) a++;
  let b = s.length;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
  if (a === b) return null;
  return { depth: j, text: s.slice(a, b) };
}

/** A thematic break: `---` or `***`, then spaces or tabs only. */
function isHr(s) {
  const c = s[0];
  if (c !== '-' && c !== '*') return false;
  if (s[1] !== c || s[2] !== c) return false;
  for (let j = 3; j < s.length; j++) {
    if (s[j] !== ' ' && s[j] !== '\t') return false;
  }
  return true;
}

/** A bullet item line `- ` or `* `, or null. */
function bulletOf(s) {
  if ((s[0] === '-' || s[0] === '*') && s[1] === ' ') return { text: s.slice(2) };
  return null;
}

/** An ordered item line `digits. ` (1-9 digits), or null. */
function orderedOf(s) {
  let j = 0;
  while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
  if (j === 0 || j > 9) return null;
  if (s[j] !== '.' || s[j + 1] !== ' ') return null;
  return { num: s.slice(0, j), text: s.slice(j + 2) };
}

const CONTINUED = /^ {2,}\S/;

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a++;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/** The characters a backslash escapes, as a table over char codes. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[ch.charCodeAt(0)] = 1;

/** Whether `code` (a char code) is a character a backslash escapes. */
const isEscapableCode = (code) => code < 128 && ESCAPABLE[code] === 1;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s[j] !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The scan for inline markup: one regex shared by every call, its lastIndex saved and restored around nested calls. */
const INLINE_RE = /[\\`*&<>"'\[]/g;

/**
 * `s` rendered inline; `link(target)` is a link's href. One regex jumps
 * from one interesting character to the next, so plain runs are pushed
 * whole: a run holds no escapable character, and each escapable character
 * is written as its entity on the spot. A special character that turns out
 * not to open anything stays in the plain run, exactly as the
 * character-by-character walk would leave it: a failed `**` skips both
 * stars, a failed single `*`, backtick or `[` skips one, and a backslash
 * before a character it cannot escape is plain.
 */
function inlineStr(s, link) {
  const saved = INLINE_RE.lastIndex;
  INLINE_RE.lastIndex = 0;
  const re = INLINE_RE;
  let out = '';
  let i = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const p = m.index;
    const c = m[0];
    if (c === '\\') {
      if (p + 1 < s.length && isEscapableCode(s.charCodeAt(p + 1))) {
        if (p > i) out += s.slice(i, p);
        out += ESCAPES[s[p + 1]] ?? s[p + 1];
        i = p + 2;
        re.lastIndex = i;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', p + 1);
      if (j > p + 1) {
        if (p > i) out += s.slice(i, p);
        out += '<code>' + escapeHtml(s.slice(p + 1, j)) + '</code>';
        i = j + 1;
        re.lastIndex = i;
      }
      continue;
    }
    if (c === '*') {
      if (s[p + 1] === '*') {
        const j = findUnescaped(s, '**', p + 2);
        if (j > p + 2) {
          if (p > i) out += s.slice(i, p);
          out += '<strong>' + inlineStr(s.slice(p + 2, j), link) + '</strong>';
          i = j + 2;
          re.lastIndex = i;
        } else {
          re.lastIndex = p + 2;
        }
        continue;
      }
      const j = findSingleStar(s, p + 1);
      if (j > p + 1) {
        if (p > i) out += s.slice(i, p);
        out += '<em>' + inlineStr(s.slice(p + 1, j), link) + '</em>';
        i = j + 1;
        re.lastIndex = i;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', p + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        if (p > i) out += s.slice(i, p);
        out += '<a href="' + escapeHtml(link(target)) + '">' + inlineStr(s.slice(p + 1, k), link) + '</a>';
        i = mm + 1;
        re.lastIndex = i;
      }
      continue;
    }
    // One of & < > " ': its entity, and the scan goes on after it.
    if (p > i) out += s.slice(i, p);
    out += ESCAPES[c];
    i = p + 1;
  }
  if (i < s.length) out += s.slice(i);
  INLINE_RE.lastIndex = saved;
  return out;
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents (every level 2 and 3 heading:
 * level, id and its inline HTML) and its excerpt (the first paragraph's
 * inline HTML, or ""). `slugOf` is the case's cached slugify.
 */
function renderMarkdown(src, link, slugOf) {
  const lines = src.split('\n');
  let built = '';
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      i++;
      const parts = [];
      while (i < n && !isFenceClose(lines[i])) {
        parts.push(escapeHtml(lines[i]));
        parts.push('\n');
        i++;
      }
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      built += `<pre><code${cls}>${parts.join('')}</code></pre>` + '\n';
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugOf(hd.text), ids);
      const html = inlineStr(hd.text, link);
      built += `<h${hd.depth} id="${id}">${html}</h${hd.depth}>` + '\n';
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      built += '<hr>' + '\n';
      i++;
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        const l = lines[i++];
        body.push(trimLine(l[1] === ' ' ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      built += kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(kept.join('\n'), link)}</p>\n</blockquote>` + '\n';
      continue;
    }
    const b = bulletOf(line);
    const o = b === null ? orderedOf(line) : null;
    if (b !== null || o !== null) {
      const isOrdered = o !== null;
      const start = isOrdered ? Number(o.num) : 1;
      const items = [];
      while (i < n) {
        const l = lines[i];
        let m;
        if (isOrdered) m = orderedOf(l);
        else m = bulletOf(l);
        if (m !== null) {
          items.push([trimLine(m.text)]);
          i++;
        } else if (CONTINUED.test(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      const parts = [open, '\n'];
      for (const item of items) {
        parts.push('<li>', inlineStr(item.join('\n'), link), '</li>\n');
      }
      parts.push(`</${tag}>`);
      built += parts.join('') + '\n';
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    built += `<p>${html}</p>` + '\n';
  }
  return { html: built, toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlank(src.slice(lineStart, open)) && isBlank(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null ? parent.else : parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A path's expression in generated code: first name from the scope chain, then own properties. */
function genPath(path, sc) {
  let e = `${sc}[${JSON.stringify(path[0])}]`;
  for (let k = 1; k < path.length; k++) e = `g(${e},${JSON.stringify(path[k])})`;
  return e;
}

/** `nodes` compiled into statements appended to `out`; `sc` is the current scope variable. */
function genNodes(nodes, sc, out, nextId) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      out.push(`s+=${JSON.stringify(n.text)};`);
    } else if (n.kind === 'var' || n.kind === 'raw') {
      const v = `_v${nextId()}`;
      out.push(`var ${v}=${genPath(n.path, sc)};`);
      if (n.kind === 'var') out.push(`s+=esc(typeof ${v}==="string"?${v}:txt(${v}));`);
      else out.push(`s+=typeof ${v}==="string"?${v}:txt(${v});`);
    } else if (n.kind === 'if') {
      const cond = n.not ? `!tr(${genPath(n.path, sc)})` : `tr(${genPath(n.path, sc)})`;
      const thenB = [];
      genNodes(n.then, sc, thenB, nextId);
      if (n.else !== null) {
        const elseB = [];
        genNodes(n.else, sc, elseB, nextId);
        out.push(`if(${cond}){\n${thenB.join('\n')}\n}else{\n${elseB.join('\n')}\n}`);
      } else {
        out.push(`if(${cond}){\n${thenB.join('\n')}\n}`);
      }
    } else if (n.kind === 'for') {
      const xs = `_x${nextId()}`;
      const fr = `_s${nextId()}`;
      const lp = `_l${nextId()}`;
      const k = `_k${nextId()}`;
      const body = [];
      genNodes(n.body, fr, body, nextId);
      // A loop named `loop` is shadowed by the loop record itself, as in the
      // reference's `{ [name]: x, loop: {...} }` object literal.
      const assignEl = n.name === 'loop' ? '' : `${fr}[${JSON.stringify(n.name)}]=${xs}[${k}];`;
      out.push(`var ${xs}=${genPath(n.path, sc)};`);
      out.push(`if(Array.isArray(${xs})){var ${fr}=Object.create(${sc});var ${lp}={index:0,first:false,last:false,length:${xs}.length};${fr}["loop"]=${lp};for(var ${k}=0;${k}<${xs}.length;${k}++){${assignEl}${lp}.index=${k}+1;${lp}.first=${k}===0;${lp}.last=${k}===${xs}.length-1;\n${body.join('\n')}\n}}`);
    } else if (n.kind === 'include') {
      const f = `_f${nextId()}`;
      out.push(`if(depth<${INCLUDE_DEPTH}){var ${f}=T[${JSON.stringify(n.name)}];if(${f}!==undefined)s+=${f}(${sc},T,depth+1);}`);
    }
  }
}

/**
 * Every parsed template compiled to a function `(sc, T, depth)` returning
 * its rendered string: `sc` is a scope chain of null-prototype frames (a
 * loop's frame is created from its parent's), `T` is this map itself for
 * includes, `depth` the include depth. Returns a null-prototype map of
 * name to function, built fresh for this case.
 */
function compileTemplates(asts) {
  const parts = [];
  parts.push('function txt(v){if(typeof v==="string")return v;if(typeof v==="number")return String(v);if(typeof v==="boolean")return v?"true":"false";if(Array.isArray(v))return v.map(txt).join(", ");return "";}');
  parts.push('function tr(v){if(Array.isArray(v))return v.length>0;return v!==undefined&&v!==null&&v!==false&&v!==""&&v!==0;}');
  parts.push('function g(v,k){return v!==null&&typeof v==="object"&&Object.hasOwn(v,k)?v[k]:undefined;}');
  parts.push('var R=Object.create(null);');
  let uid = 0;
  const nextId = () => uid++;
  for (const name of Object.keys(asts)) {
    const body = [];
    genNodes(asts[name], 'sc', body, nextId);
    parts.push(`R[${JSON.stringify(name)}]=function(sc,T,depth){var s="";\n${body.join('\n')}\nreturn s;};`);
  }
  parts.push('return R;');
  return new Function('esc', parts.join('\n'))(escapeHtml);
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. */
export function run(input) {
  // Every cache is made fresh inside this call; nothing is kept between cases.
  const slugCache = new Map();
  const slugOf = (t) => {
    let s = slugCache.get(t);
    if (s === undefined) {
      s = slugify(t);
      slugCache.set(t, s);
    }
    return s;
  };

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Every template parsed, in code-unit order of its name, then compiled.
  // One that does not parse is reported and left out, as if it were not there.
  const report = [];
  const asts = {};
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      asts[name] = parseTemplate(name, input.templates[name]);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const T = compileTemplates(asts);

  // 3. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  // The checks run in order: parse error, reserved directory, post without date, missing layout, draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (T[layout] === undefined) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 4. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 5. Each body's Markdown, its links resolved to the pages and static files they name.
  // Successful resolutions are cached per directory: they depend on the
  // directory and the target alone. Broken links are never cached, because
  // each source reports its own broken link.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    let perDir = linkCache.get(dir);
    const link = (target) => {
      if (SCHEME.test(target) || target[0] === '/' || target[0] === '#') return target;
      if (perDir !== undefined) {
        const hit = perDir.get(target);
        if (hit !== undefined) return hit;
      }
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      let href = null;
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) href = `${page.url}${frag}`;
        else if (staticPaths.has(path)) href = `${base}/${path}${frag}`;
      }
      if (href === null) {
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      }
      if (perDir === undefined) {
        perDir = new Map();
        linkCache.set(dir, perDir);
      }
      perDir.set(target, href);
      return href;
    };
    const md = renderMarkdown(s.body, link, slugOf);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 6. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 7. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugOf(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugOf(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  /** A page's link record as templates read it. */
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

  /** A post's card, as lists show it. */
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });

  /** A page as its layout reads it. A post's card is the one already built for the lists. */
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 8. Every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  const output = {};
  const render = (name, vars) => {
    const fn = T[name];
    if (fn === undefined) return null;
    const root = Object.create(null);
    root.site = site;
    root.tags = allTags;
    root.recent = recent;
    for (const k of Object.keys(vars)) root[k] = vars[k];
    return fn(root, T, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 9. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const npages = kept.filter((s) => !s.post).length;
  lines.push(`built ${npages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
