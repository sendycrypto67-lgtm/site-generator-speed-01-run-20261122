import { setFlagsFromString } from 'node:v8';
setFlagsFromString('--no-opt');
// A faster drop-in for makefun-site 1.0.0, written from its specification
// (README.md of makefun-site 1.0.0): the same front matter, Markdown subset,
// template dialect, slug rule and report, byte for byte, but with the
// template interpreter replaced by a per-case code generator, a fused
// single-pass Markdown renderer, and a cached slugify. One import only:
// node:v8, to tune V8 flags the way the rules allow (setFlagsFromString,
// as main.ts does): --no-opt, because this entry runs cold in a fresh
// process per execution, so TurboFan's compile cost outweighs its runtime
// gain here. No state kept between run() calls (every cache is made fresh
// inside run()).

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
const NONASCII = /[^\x00-\x7F]/;

function slugify(text) {
  if (!NONASCII.test(text)) {
    let out = text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (out.charCodeAt(0) === 45) out = out.slice(1);
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
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
const WS64 = new Uint8Array(65536);
for (const c of [32, 9, 10, 11, 12, 13, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS64[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS64[c] = 1;

/** The words of a body: its runs of characters other than whitespace (a table over char codes, no condition chain). */
function wordsOf(text) {
  const W = WS64;
  const len = text.length;
  let n = 0;
  let prev = 1;
  let i = 0;
  const end4 = len - 3;
  for (; i < end4; i += 4) {
    let ws = W[text.charCodeAt(i)];
    n += prev & (ws ^ 1); prev = ws;
    ws = W[text.charCodeAt(i + 1)];
    n += prev & (ws ^ 1); prev = ws;
    ws = W[text.charCodeAt(i + 2)];
    n += prev & (ws ^ 1); prev = ws;
    ws = W[text.charCodeAt(i + 3)];
    n += prev & (ws ^ 1); prev = ws;
  }
  for (; i < len; i++) {
    const ws = W[text.charCodeAt(i)];
    n += prev & (ws ^ 1); prev = ws;
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  return resolvePathParts(dir === '' ? [] : dir.split('/'), rel);
}

function resolvePathParts(parts, rel) {
  // Fast path: leading "../"s, then a tail with no special segment.
  let i = 0;
  let p = null;
  while (rel.startsWith('../', i)) {
    if (p === null) p = parts.slice();
    if (p.length === 0) return null;
    p.pop();
    i += 3;
  }
  if (rel.startsWith('..', i) && i + 2 === rel.length) {
    if (p === null) p = parts.slice();
    if (p.length === 0) return null;
    p.pop();
    return p.join('/');
  }
  const tail = rel.slice(i);
  if (
    tail !== '' && tail !== '.' && tail.charCodeAt(0) !== 47 && tail.charCodeAt(tail.length - 1) !== 47 &&
    tail.indexOf('..') === -1 && tail.indexOf('//') === -1 && !tail.startsWith('./') &&
    tail.indexOf('/./') === -1 && !tail.endsWith('/.')
  ) {
    if (p === null) return parts.length === 0 ? tail : parts.join('/') + '/' + tail;
    return p.length === 0 ? tail : p.join('/') + '/' + tail;
  }
  if (p === null) p = parts.slice();
  else if (i > 0) {
    // The tail was not plain: replay it through the slow loop.
    for (const seg of tail.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (p.length === 0) return null;
        p.pop();
      } else p.push(seg);
    }
    return p.join('/');
  }
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (p.length === 0) return null;
      p.pop();
    } else p.push(seg);
  }
  return p.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    if (raw.indexOf('\\') === -1) {
      // No escape to process: the only quote is the closing one, or it
      // is a stray quote (an error, found by the slow path below).
      if (raw.indexOf('"', 1) === raw.length - 1) return { value: raw.slice(1, -1) };
    }
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
      let raw = m[2] === undefined ? '' : m[2];
      {
        let re = raw.length;
        while (re > 0 && (raw[re - 1] === ' ' || raw[re - 1] === '\t')) re--;
        if (re < raw.length) raw = raw.slice(0, re);
      }
      if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
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

/** A line of spaces and tabs only (or empty), as a range of `src`. */
function isBlankRange(src, a, b) {
  for (let k = a; k < b; k++) {
    const c = src[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A fence-open line's language, or null, as a range of `src`. */
function fenceOpenRange(src, a, b) {
  if (src[a] !== '`' || src[a + 1] !== '`' || src[a + 2] !== '`') return null;
  let j = a + 3;
  while (j < b) {
    const c = src.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = src.slice(a + 3, j);
  while (j < b && (src[j] === ' ' || src[j] === '\t')) j++;
  return j === b ? lang : null;
}

/** A heading line's level and trimmed text range, or null. */
function headingRange(src, a, b) {
  let j = a;
  while (j < b && src[j] === '#') j++;
  const depth = j - a;
  if (depth === 0 || depth > 6) return null;
  if (src[j] !== ' ' && src[j] !== '\t') return null;
  let x = j;
  while (x < b && (src[x] === ' ' || src[x] === '\t')) x++;
  let y = b;
  while (y > x && (src[y - 1] === ' ' || src[y - 1] === '\t')) y--;
  if (x === y) return null;
  return { depth, a: x, b: y };
}

/** A thematic break, as a range of `src`. */
function isHrRange(src, a, b) {
  const c = src[a];
  if (c !== '-' && c !== '*') return false;
  if (src[a + 1] !== c || src[a + 2] !== c) return false;
  for (let j = a + 3; j < b; j++) {
    if (src[j] !== ' ' && src[j] !== '\t') return false;
  }
  return true;
}


/** An ordered item line, as a range of `src`: its number and where its text starts, or null. */
function orderedRange(src, a, b) {
  let j = a;
  while (j < b && src[j] >= '0' && src[j] <= '9') j++;
  if (j === a || j - a > 9) return null;
  if (src[j] !== '.' || src[j + 1] !== ' ') return null;
  return { num: src.slice(a, j), text: j + 2 };
}

/** Whether the line range is a continuation line: 2+ spaces, then a non-whitespace character. */
function isContinuedRange(src, a, b) {
  let j = a;
  while (j < b && src[j] === ' ') j++;
  return j - a >= 2 && j < b && WS64[src.charCodeAt(j)] === 0;
}


/** The characters a backslash escapes, as a table over char codes. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[ch.charCodeAt(0)] = 1;

/** Whether `code` (a char code) is a character a backslash escapes. */
const isEscapableCode = (code) => code < 128 && ESCAPABLE[code] === 1;

/** The scan for inline markup: one regex shared by every call, its lastIndex saved and restored around nested calls. */
const INLINE_RE = /[\\`*&<>"'\[]/g;

/** A fence-close line: "```" then spaces/tabs to the line end. */
const FENCE_CLOSE = /\n```[ \t]*(?:\n|$)/g;

/**
 * `s` rendered inline; `link(target)` is a link's href. One regex jumps
 * from one interesting character to the next, so plain runs are pushed
 * whole. Nested strong, emphasis and link text is rendered by recursion
 * over indices into the same string, never a slice, and the shared
 * regex's lastIndex is saved and restored around each nested call. A
 * special character that turns out not to open anything stays in the
 * plain run, exactly as the character-by-character walk would leave it:
 * a failed `**` skips both stars, a failed single `*`, backtick or `[`
 * skips one, and a backslash before a character it cannot escape is plain.
 */
const INLINE_ANY = /[*`\[\\&<>"']/;
const INLINE_MARKUP = /[*`\[\\]/;

/** `s` rendered inline; without a markup opener it is only escaped. */
function inlineStr(s, link) {
  if (!INLINE_MARKUP.test(s)) return escapeHtml(s);
  return inlineSlow(s, link);
}

/** `s[a..b]` rendered inline: plain text (or only escapables) skips the scan. */
function inlineRange(s, a, b, link) {
  const seg = s.slice(a, b);
  if (!INLINE_ANY.test(seg)) return seg;
  if (!INLINE_MARKUP.test(seg)) return escapeHtml(seg);
  return inlineSlow(seg, link);
}

/**
 * `s` rendered inline, the slow path: one regex jumps from one
 * interesting character to the next, so plain runs are pushed whole.
 * Nested strong, emphasis and link text is rendered by recursion
 * (inlineRange slices again), and the shared regex's lastIndex is
 * saved and restored around each nested call. A special character
 * that turns out not to open anything stays in the plain run, exactly
 * as the character-by-character walk would leave it: a failed `**`
 * skips both stars, a failed single `*`, backtick or `[` skips one,
 * and a backslash before a character it cannot escape is plain.
 */
function inlineSlow(s, link) {
  const saved = INLINE_RE.lastIndex;
  INLINE_RE.lastIndex = 0;
  const re = INLINE_RE;
  const b = s.length;
  let out = '';
  let i = 0;
  // test() instead of exec(): the same scan, but no match array per hit.
  // A match is one character, so its index is lastIndex - 1.
  while (re.test(s)) {
    const p = re.lastIndex - 1;
    const c = s[p];
    if (c === '\\') {
      if (p + 1 < b && isEscapableCode(s.charCodeAt(p + 1))) {
        if (p > i) out += s.slice(i, p);
        out += ESCAPES[s[p + 1]] ?? s[p + 1];
        i = p + 2;
        re.lastIndex = i;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', p + 1);
      if (j !== -1 && j < b && j > p + 1) {
        if (p > i) out += s.slice(i, p);
        out += '<code>' + escapeHtml(s.slice(p + 1, j)) + '</code>';
        i = j + 1;
        re.lastIndex = i;
      }
      continue;
    }
    if (c === '*') {
      if (s[p + 1] === '*') {
        let j = -1;
        {
          let jj = s.indexOf('**', p + 2);
          while (jj !== -1) {
            let k = jj - 1;
            let odd = false;
            while (k >= p + 2 && s.charCodeAt(k) === 92) { odd = !odd; k--; }
            if (!odd) { j = jj; break; }
            jj = s.indexOf('**', jj + 1);
          }
        }
        if (j > p + 2) {
          if (p > i) out += s.slice(i, p);
          out += '<strong>' + inlineRange(s, p + 2, j, link) + '</strong>';
          i = j + 2;
          re.lastIndex = i;
        } else {
          re.lastIndex = p + 2;
        }
        continue;
      }
      let j = -1;
      {
        let jj = s.indexOf('*', p + 1);
        while (jj !== -1) {
          let k = jj - 1;
          let odd = false;
          while (k >= p + 1 && s.charCodeAt(k) === 92) { odd = !odd; k--; }
          if (!odd && s[jj + 1] !== '*') { j = jj; break; }
          jj = s.indexOf('*', odd ? jj + 1 : jj + 2);
        }
      }
      if (j > p + 1) {
        if (p > i) out += s.slice(i, p);
        out += '<em>' + inlineRange(s, p + 1, j, link) + '</em>';
        i = j + 1;
        re.lastIndex = i;
      }
      continue;
    }
    if (c === '[') {
      let k = -1;
      {
        let jj = s.indexOf(']', p + 1);
        while (jj !== -1) {
          let kk = jj - 1;
          let odd = false;
          while (kk >= p + 1 && s.charCodeAt(kk) === 92) { odd = !odd; kk--; }
          if (!odd) { k = jj; break; }
          jj = s.indexOf(']', jj + 1);
        }
      }
      const mm = k !== -1 && k + 1 < b && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 || mm >= b ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        if (p > i) out += s.slice(i, p);
        out += '<a href="' + escapeHtml(link(target)) + '">' + inlineRange(s, p + 1, k, link) + '</a>';
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
  if (i < b) out += s.slice(i, b);
  INLINE_RE.lastIndex = saved;
  return out;
}

/**
 * `src` rendered in one pass over its line ranges (no split): its HTML
 * (each block on its own lines, a "\n" after the last), its table of
 * contents (every level 2 and 3 heading: level, id and its inline HTML)
 * and its excerpt (the first paragraph's inline HTML, or "").
 * `slugOf` is the case's cached slugify. A paragraph or a single-line
 * list item whose lines need no trimming is rendered straight from its
 * range in `src`; only lines that do need trimming are sliced and joined,
 * exactly as before.
 */
function renderMarkdown(src, link, slugOf) {
  const n = src.length;
  const parts = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let pos = 0;
  let _le = -1;
  while (pos < n) {
    const a = pos;
    const b = (_le = src.indexOf('\n', a)) === -1 ? n : _le;
    const next = b === n ? n + 1 : b + 1;
    if (a === b) {
      pos = next;
      continue;
    }
    const c0 = src.charCodeAt(a);
    if (c0 === 96) {
      const lang = fenceOpenRange(src, a, b);
      if (lang !== null) {
        const contentStart = next;
        let closeStart = -1;
        if (contentStart < n) {
          FENCE_CLOSE.lastIndex = contentStart - 1;
          const fm = FENCE_CLOSE.exec(src);
          if (fm !== null) closeStart = fm.index + 1;
        }
        const closed = closeStart !== -1;
        const hasContent = closed ? closeStart > contentStart : contentStart < n;
        const fb = !hasContent ? '' : escapeHtml(closed ? src.slice(contentStart, closeStart - 1) : src.slice(contentStart, n)) + '\n';
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        parts.push(`<pre><code${cls}>${fb}</code></pre>\n`);
        const ce = closed ? ((_le = src.indexOf('\n', closeStart)) === -1 ? n : _le) : n;
        pos = closed ? (ce === n ? n + 1 : ce + 1) : n + 1;
        continue;
      }
    } else if (c0 === 35) {
      const hd = headingRange(src, a, b);
      if (hd !== null) {
        const id = uniqueSlug(slugOf(src.slice(hd.a, hd.b)), ids);
        const html = inlineRange(src, hd.a, hd.b, link);
        parts.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        pos = next;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHrRange(src, a, b)) {
        parts.push('<hr>\n');
        pos = next;
        continue;
      }
      const t0 = (src[a] === '-' || src[a] === '*') && src[a + 1] === ' ' ? a + 2 : -1;
      if (t0 !== -1) {
        const il = [];
        const ib = [];
        let p = a;
        let e = b;
        let nx = next;
        while (true) {
          const t = (src[p] === '-' || src[p] === '*') && src[p + 1] === ' ' ? p + 2 : -1;
          if (t !== -1) {
            ib.push(il.length);
            il.push(t, e);
            p = nx;
            if (p >= n) break;
            e = (_le = src.indexOf('\n', p)) === -1 ? n : _le;
            nx = e === n ? n + 1 : e + 1;
          } else if (isContinuedRange(src, p, e)) {
            il.push(p, e);
            p = nx;
            if (p >= n) break;
            e = (_le = src.indexOf('\n', p)) === -1 ? n : _le;
            nx = e === n ? n + 1 : e + 1;
          } else break;
        }
        ib.push(il.length);
        parts.push('<ul>\n');
        for (let k = 0; k + 1 < ib.length; k++) {
          const s0 = ib[k];
          const s1 = ib[k + 1];
          let html;
          if (s1 - s0 === 2 && !(il[s0] !== il[s0 + 1] && (src[il[s0]] === ' ' || src[il[s0]] === '\t' || src[il[s0 + 1] - 1] === ' ' || src[il[s0 + 1] - 1] === '\t'))) {
            html = inlineRange(src, il[s0], il[s0 + 1], link);
          } else {
            const strs = [];
            for (let q = s0; q < s1; q += 2) {
              let tx = il[q];
              let ty = il[q + 1];
              while (tx < ty && (src[tx] === ' ' || src[tx] === '\t')) tx++;
              while (ty > tx && (src[ty - 1] === ' ' || src[ty - 1] === '\t')) ty--;
              strs.push(src.slice(tx, ty));
            }
            html = inlineStr(strs.join('\n'), link);
          }
          parts.push('<li>' + html + '</li>\n');
        }
        parts.push('</ul>\n');
        pos = p;
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      let p = a;
      let e = b;
      let nx = next;
      while (p < n && src[p] === '>') {
        let x = p + 1;
        if (src[x] === ' ') x++;
        let tx = x;
        let ty = e;
        while (tx < ty && (src[tx] === ' ' || src[tx] === '\t')) tx++;
        while (ty > tx && (src[ty - 1] === ' ' || src[ty - 1] === '\t')) ty--;
        body.push(src.slice(tx, ty));
        p = nx;
        if (p >= n) break;
        e = (_le = src.indexOf('\n', p)) === -1 ? n : _le;
        nx = e === n ? n + 1 : e + 1;
      }
      const kept = body.filter((l) => l !== '');
      parts.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(kept.join('\n'), link)}</p>\n</blockquote>\n`);
      pos = p;
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const o0 = orderedRange(src, a, b);
      if (o0 !== null) {
        const start = Number(o0.num);
        const il = [];
        const ib = [];
        let p = a;
        let e = b;
        let nx = next;
        while (true) {
          const o = orderedRange(src, p, e);
          if (o !== null) {
            ib.push(il.length);
            il.push(o.text, e);
            p = nx;
            if (p >= n) break;
            e = (_le = src.indexOf('\n', p)) === -1 ? n : _le;
            nx = e === n ? n + 1 : e + 1;
          } else if (isContinuedRange(src, p, e)) {
            il.push(p, e);
            p = nx;
            if (p >= n) break;
            e = (_le = src.indexOf('\n', p)) === -1 ? n : _le;
            nx = e === n ? n + 1 : e + 1;
          } else break;
        }
        ib.push(il.length);
        parts.push(start !== 1 ? `<ol start="${start}">\n` : '<ol>\n');
        for (let k = 0; k + 1 < ib.length; k++) {
          const s0 = ib[k];
          const s1 = ib[k + 1];
          let html;
          if (s1 - s0 === 2 && !(il[s0] !== il[s0 + 1] && (src[il[s0]] === ' ' || src[il[s0]] === '\t' || src[il[s0 + 1] - 1] === ' ' || src[il[s0 + 1] - 1] === '\t'))) {
            html = inlineRange(src, il[s0], il[s0 + 1], link);
          } else {
            const strs = [];
            for (let q = s0; q < s1; q += 2) {
              let tx = il[q];
              let ty = il[q + 1];
              while (tx < ty && (src[tx] === ' ' || src[tx] === '\t')) tx++;
              while (ty > tx && (src[ty - 1] === ' ' || src[ty - 1] === '\t')) ty--;
              strs.push(src.slice(tx, ty));
            }
            html = inlineStr(strs.join('\n'), link);
          }
          parts.push('<li>' + html + '</li>\n');
        }
        parts.push('</ol>\n');
        pos = p;
        continue;
      }
    } else if (c0 === 32 || c0 === 9) {
      if (isBlankRange(src, a, b)) {
        pos = next;
        continue;
      }
    }
    // A paragraph: lines until one ends it. Rendered straight from its
    // range when no line needs trimming, else from trimmed lines joined.
    let p = a;
    let e = b;
    let nx = next;
    let clean = !(a !== b && (src[a] === ' ' || src[a] === '\t' || src[b - 1] === ' ' || src[b - 1] === '\t'));
    const firstA = a;
    let lastB = b;
    while (true) {
      p = nx;
      if (p >= n) break;
      e = (_le = src.indexOf('\n', p)) === -1 ? n : _le;
      // Whether this line ends the paragraph, inlined: blank, fence,
      // heading or thematic break.
      if (p === e) break;
      const cc = src.charCodeAt(p);
      if (cc === 32 || cc === 9) {
        if (isBlankRange(src, p, e)) break;
      } else if (cc === 96) {
        if (fenceOpenRange(src, p, e) !== null) break;
      } else if (cc === 35) {
        if (headingRange(src, p, e) !== null) break;
      } else if (cc === 45 || cc === 42) {
        if (isHrRange(src, p, e)) break;
      }
      if (clean) {
        const f = src[p];
        if (f === ' ' || f === '\t') clean = false;
        else {
          const l = src[e - 1];
          if (l === ' ' || l === '\t') clean = false;
        }
      }
      lastB = e;
      nx = e === n ? n + 1 : e + 1;
    }
    let html;
    if (clean) {
      html = inlineRange(src, firstA, lastB, link);
    } else {
      const strs = [];
      let q = firstA;
      while (true) {
        const qe = (_le = src.indexOf('\n', q)) === -1 ? n : _le;
        let tx = q;
        let ty = qe;
        while (tx < ty && (src[tx] === ' ' || src[tx] === '\t')) tx++;
        while (ty > tx && (src[ty - 1] === ' ' || src[ty - 1] === '\t')) ty--;
        strs.push(src.slice(tx, ty));
        if (qe === lastB) break;
        q = qe + 1;
      }
      html = inlineStr(strs.join('\n'), link);
    }
    if (excerpt === null) excerpt = html;
    parts.push(`<p>${html}</p>\n`);
    pos = p;
  }
  return { html: parts.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
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

/**
 * Segments whose direct read could differ from an own-property read:
 * members of Object.prototype (on plain objects) and of Array.prototype
 * (on arrays). When no template uses one, a direct read is exactly an
 * own-property read, so the generated code skips the check; when one
 * does appear, the safe form (an explicit own-property check) is used.
 */
const DANGEROUS_SEGMENTS = new Set([
  'constructor', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'toString', 'valueOf',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', '__proto__',
  'at', 'concat', 'copyWithin', 'entries', 'every', 'fill', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex',
  'flat', 'flatMap', 'forEach', 'includes', 'indexOf', 'join', 'keys', 'lastIndexOf', 'map', 'pop', 'push', 'reduce',
  'reduceRight', 'reverse', 'shift', 'slice', 'some', 'sort', 'splice', 'toReversed', 'toSorted', 'toSpliced',
  'unshift', 'values', 'with',
]);

/** True while the templates being compiled use a dangerous segment. Set by compileTemplates. */
let GEN_SAFE = false;

/**
 * A path's expression in generated code: the first name from the scope
 * chain, then one own property after another, inlined (no helper call):
 * each step assigns its base to a temp once (`_q<depth>`, declared at
 * the function's head) and reads the property only when the base is an
 * object. In the fast form an array's own property is still checked
 * explicitly (its methods are not own properties); in the safe form
 * every step checks.
 */
function genPath(path, sc) {
  let e = `${sc}[${JSON.stringify(path[0])}]`;
  for (let k = 1; k < path.length; k++) {
    const t = `_q${k}`;
    const key = JSON.stringify(path[k]);
    e = GEN_SAFE
      ? `(${t}=${e},${t}==null||typeof ${t}!=="object"?void 0:Object.hasOwn(${t},${key})?${t}[${key}]:void 0)`
      : `(${t}=${e},${t}==null||typeof ${t}!=="object"?void 0:Array.isArray(${t})?Object.hasOwn(${t},${key})?${t}[${key}]:void 0:${t}[${key}])`;
  }
  return e;
}

/**
 * A path's truthiness in generated code, inlined: a non-empty array, else
 * plain JavaScript truthiness, which is the reference's rule for every
 * value the data model can hold (no NaN ever occurs: counts, lengths and
 * reading_minutes are integers, the rest are strings, booleans, null,
 * objects or arrays).
 */
function genTruth(path, sc, not) {
  const e = genPath(path, sc);
  const t = `(_w=${e},Array.isArray(_w)?_w.length>0:_w)`;
  return not ? `!${t}` : t;
}

/** `nodes` compiled into statements appended to `out`; `sc` is the current scope variable.
 * `tpl` is the template being compiled; `inLoop` whether the site is
 * inside a `for` (a constant template's output cannot be reused there,
 * because the loop's scope varies per iteration). A constant template
 * included at a top-level site of a varying template is replaced by its
 * once-per-case rendering from `K`. */
function genNodes(nodes, sc, out, nextId, tpl, loops) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      out.push(`s+=${JSON.stringify(n.text)};`);
    } else if (n.kind === 'var' || n.kind === 'raw') {
      const v = `_v${nextId()}`;
      out.push(`var ${v}=${genPath(n.path, sc)};`);
      // Numbers and booleans stringify to text without escapables, so
      // they skip the escape call; strings go through esc, arrays
      // through txt (the only helper left) and then esc for {{ }}.
      // Strings are the common value, so they are tested first.
      const val = `typeof ${v}==="string"?${v}:${v}==null?"":typeof ${v}==="number"?String(${v}):typeof ${v}==="boolean"?(${v}?"true":"false"):Array.isArray(${v})?${v}.map(txt).join(", "):""`;
      if (n.kind === 'var') out.push(`s+=(typeof ${v}==="string"?esc(${v}):${v}==null?"":typeof ${v}==="number"?String(${v}):typeof ${v}==="boolean"?(${v}?"true":"false"):Array.isArray(${v})?esc(${v}.map(txt).join(", ")):"");`);
      else out.push(`s+=(${val});`);
    } else if (n.kind === 'if') {
      const cond = genTruth(n.path, sc, n.not);
      const thenB = [];
      genNodes(n.then, sc, thenB, nextId, tpl, loops);
      if (n.else !== null) {
        const elseB = [];
        genNodes(n.else, sc, elseB, nextId, tpl, loops);
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
      genNodes(n.body, fr, body, nextId, tpl, [...loops, n.name]);
      // A loop named `loop` is shadowed by the loop record itself, as in the
      // reference's `{ [name]: x, loop: {...} }` object literal.
      const assignEl = n.name === 'loop' ? '' : `${fr}[${JSON.stringify(n.name)}]=${xs}[${k}];`;
      const ln = `_n${nextId()}`;
      out.push(`var ${xs}=${genPath(n.path, sc)};`);
      out.push(`if(Array.isArray(${xs})){var ${ln}=${xs}.length;var ${fr}=Object.create(${sc});var ${lp}={index:0,first:false,last:false,length:${ln}};${fr}["loop"]=${lp};for(var ${k}=0;${k}<${ln};${k}++){${assignEl}${lp}.index=${k}+1;${lp}.first=${k}===0;${lp}.last=${k}===${ln}-1;\n${body.join('\n')}\n}}`);
    } else if (n.kind === 'include') {
      const loopVar = loops.length === 0 ? null : loops[loops.length - 1];
      const pureVars = PURE_TEMPLATES.get(n.name);
      if (loopVar !== null && pureVars !== undefined && pureVars.has(loopVar) && MEMO_OK) {
        // Rendered once per value of the loop variable, cached on it.
        const v = `_v${nextId()}`;
        const f = `_f${nextId()}`;
        out.push(`if(depth<${INCLUDE_DEPTH}){var ${v}=${sc}[${JSON.stringify(loopVar)}];if(${v}!==null&&typeof ${v}==="object"){s+=${v}[SYMS[${JSON.stringify(n.name)}]]??=T[${JSON.stringify(n.name)}](${sc},T,depth+1);}else{var ${f}=T[${JSON.stringify(n.name)}];if(${f}!==undefined)s+=${f}(${sc},T,depth+1);}}`);
      } else if (loops.length === 0 && CONST_TEMPLATES.has(n.name) && !CONST_TEMPLATES.has(tpl)) {
        out.push(`if(depth<${INCLUDE_DEPTH}){s+=K[${JSON.stringify(n.name)}];}`);
      } else {
        const f = `_f${nextId()}`;
        out.push(`if(depth<${INCLUDE_DEPTH}){var ${f}=T[${JSON.stringify(n.name)}];if(${f}!==undefined)s+=${f}(${sc},T,depth+1);}`);
      }
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
/**
 * The templates whose output is the same for every render of a case:
 * every path they read (through their own loops and their transitive
 * includes) starts from `site`, `tags` or `recent`, which are built once
 * per case, never from `page`, `posts`, `pager` or `tag`. Set by
 * compileTemplates, read by genNodes.
 */
const CONST_TEMPLATES = new Set();

/**
 * Templates that render purely from one loop variable (plus the
 * case constants): name -> the loop variable names it is pure in. Set
 * by compileTemplates; a template included inside a loop over such a
 * variable is rendered once per value and cached on the value itself
 * (a symbol key, invisible to template paths). Only used when MEMO_OK.
 */
const PURE_TEMPLATES = new Map();

/** Whether the include graph from the layouts is shallow enough that a once-per-case rendering matches every call site (see compileTemplates). */
let MEMO_OK = false;

/**
 * Whether template `name` is constant under `env` (a Map from names to
 * constant/varying). Loop variables (and `loop`) take the constancy of
 * the iterable; an include inherits the caller's env. `seen` holds the
 * (template, env) pairs in progress, assumed constant: constancy is a
 * conjunction, so a cycle with no varying path is still constant.
 * Past depth 8 the answer is varying (safe).
 */
// Whether `nodes` render anything at all (see isConstantTemplate).
function rendersNodes(nodes) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      if (n.text !== '') return true;
    } else if (n.kind === 'for') {
      if (rendersNodes(n.body)) return true;
    } else if (n.kind === 'if') {
      if (rendersNodes(n.then)) return true;
      if (n.else !== null && rendersNodes(n.else)) return true;
    } else return true;
  }
  return false;
}

function isConstantTemplate(asts, name, env, depth, seen, memo) {
  const key = `${name}|${[...env.entries()].map(([k, v]) => `${k}=${v ? 1 : 0}`).join(',')}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  if (seen.has(key)) return true;
  if (depth > 8) return false;
  seen.add(key);
  // Whether `nodes` render anything at all (a non-empty text, a
  // variable, an include, or a nested block that does): a `for` over a
  // varying collection, or an `if` on a varying condition, varies the
  // output only when its branch renders something.
  const renders = rendersNodes;
  let ok = true;
  const walk = (nodes, e) => {
    for (const n of nodes) {
      if (!ok) return;
      if (n.kind === 'for') {
        const c = e.get(n.path[0]) === true;
        if (!c && renders(n.body)) {
          ok = false;
          return;
        }
        const inner = new Map(e);
        inner.set(n.name, c);
        inner.set('loop', c);
        walk(n.body, inner);
      } else if (n.kind === 'if') {
        if (e.get(n.path[0]) !== true && (renders(n.then) || (n.else !== null && renders(n.else)))) {
          ok = false;
          return;
        }
        walk(n.then, e);
        if (n.else !== null) walk(n.else, e);
      } else if (n.kind === 'include') {
        if (!isConstantTemplate(asts, n.name, e, depth + 1, seen, memo)) ok = false;
      } else if (n.path !== undefined) {
        if (e.get(n.path[0]) !== true) ok = false;
      }
    }
  };
  walk(asts[name] ?? [], env);
  seen.delete(key);
  memo.set(key, ok);
  return ok;
}

function compileTemplates(asts) {
  // The deepest path any template reads decides how many `_q` temps
  // the generated functions declare; any dangerous segment switches
  // the whole case to the safe (explicit own-property) form.
  let maxDepth = 1;
  GEN_SAFE = false;
  const scan = (nodes) => {
    for (const n of nodes) {
      if (n.path !== undefined) {
        if (n.path.length > maxDepth) maxDepth = n.path.length;
        for (let k = 1; k < n.path.length; k++) {
          if (DANGEROUS_SEGMENTS.has(n.path[k])) GEN_SAFE = true;
        }
      }
      if (n.body !== undefined) scan(n.body);
      if (n.then !== undefined) scan(n.then);
      if (n.else !== null && n.else !== undefined) scan(n.else);
    }
  };
  for (const name of Object.keys(asts)) scan(asts[name]);
  // Which templates are constant under the render root env.
  CONST_TEMPLATES.clear();
  {
    const rootEnv = new Map([['site', true], ['tags', true], ['recent', true], ['page', false], ['posts', false], ['pager', false], ['tag', false]]);
    const memo = new Map();
    for (const name of Object.keys(asts)) {
      if (isConstantTemplate(asts, name, rootEnv, 0, new Set(), memo)) CONST_TEMPLATES.add(name);
    }
  }
  // The include graph from the layouts must be shallow (and acyclic):
  // a once-per-case rendering at depth 0 must match a call at any site.
  MEMO_OK = true;
  {
    const edges = new Map();
    const collect = (nodes, out) => {
      for (const n of nodes) {
        if (n.kind === 'include') out.push(n.name);
        if (n.body !== undefined) collect(n.body, out);
        if (n.then !== undefined) collect(n.then, out);
        if (n.else !== null && n.else !== undefined) collect(n.else, out);
      }
    };
    for (const name of Object.keys(asts)) {
      const out = [];
      collect(asts[name], out);
      edges.set(name, out);
    }
    const roots = ['index', 'tag', 'tags', 'page', 'post'];
    const visit = (name, depth, path) => {
      if (!MEMO_OK) return;
      if (depth > 7 || path.has(name)) {
        MEMO_OK = false;
        return;
      }
      path.add(name);
      for (const next of edges.get(name) ?? []) visit(next, depth + 1, path);
      path.delete(name);
    };
    for (const r of roots) {
      if (asts[r] !== undefined) visit(r, 0, new Set());
    }
  }
  if (!MEMO_OK) CONST_TEMPLATES.clear();
  // Which templates are pure in which loop variable: an include inside
  // a loop over such a variable is rendered once per value. The env
  // treats that variable (and the case constants) as constant.
  PURE_TEMPLATES.clear();
  {
    const pairs = new Map();
    const collectSites = (nodes, loops) => {
      for (const n of nodes) {
        if (n.kind === 'for') collectSites(n.body, [...loops, n.name]);
        else if (n.kind === 'if') {
          collectSites(n.then, loops);
          if (n.else !== null) collectSites(n.else, loops);
        } else if (n.kind === 'include' && loops.length > 0) {
          let set = pairs.get(n.name);
          if (set === undefined) {
            set = new Set();
            pairs.set(n.name, set);
          }
          set.add(loops[loops.length - 1]);
        }
      }
    };
    for (const name of Object.keys(asts)) collectSites(asts[name], []);
    const memo = new Map();
    for (const [name, vars] of pairs) {
      for (const v of vars) {
        const env = new Map([['site', true], ['tags', true], ['recent', true], ['page', false], ['posts', false], ['pager', false], ['tag', false], [v, true]]);
        if (isConstantTemplate(asts, name, env, 0, new Set(), memo)) {
          let set = PURE_TEMPLATES.get(name);
          if (set === undefined) {
            set = new Set();
            PURE_TEMPLATES.set(name, set);
          }
          set.add(v);
        }
      }
    }
  }
  if (!MEMO_OK) PURE_TEMPLATES.clear();
  const temps = [];
  for (let k = 1; k < maxDepth; k++) temps.push(`_q${k}`);
  temps.push('_w');
  const parts = [];
  parts.push('function txt(v){if(typeof v==="string")return v;if(typeof v==="number")return String(v);if(typeof v==="boolean")return v?"true":"false";if(Array.isArray(v))return v.map(txt).join(", ");return "";}');
  parts.push('var R=Object.create(null);');
  let uid = 0;
  const nextId = () => uid++;
  for (const name of Object.keys(asts)) {
    const body = [];
    genNodes(asts[name], 'sc', body, nextId, name, []);
    parts.push(`R[${JSON.stringify(name)}]=function(sc,T,depth){var s="";var ${temps.join(',')};\n${body.join('\n')}\nreturn s;};`);
  }
  parts.push('return R;');
  const K = Object.create(null);
  const SYMS = Object.create(null);
  for (const name of PURE_TEMPLATES.keys()) SYMS[name] = Symbol(name);
  const R = new Function('esc', 'K', 'SYMS', parts.join('\n'))(escapeHtml, K, SYMS);
  R.__K = K;
  return R;
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
  const files = [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
  for (const name of Object.keys(input.templates).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
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
    const dirParts = dir === '' ? [] : dir.split('/');
    let perDir = linkCache.get(dir);
    const link = (target) => {
      const c0 = target.charCodeAt(0);
      if (c0 === 47 || c0 === 35) return target;
      const ci = target.indexOf(':');
      if (ci !== -1) {
        const sl = target.indexOf('/');
        if ((sl === -1 || ci < sl) && SCHEME.test(target)) return target;
      }
      if (perDir !== undefined) {
        const hit = perDir.get(target);
        if (hit !== undefined) return hit;
      }
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePathParts(dirParts, rel);
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
  // Each source's long date, once: linkOf and cardOf read it repeatedly.
  for (const s of kept) s.date_long = s.data.date === undefined ? '' : longDate(s.data.date);
  // Layouts whose render chain reads a page's reading_minutes: only
  // pages rendered through one of those (and posts, always) pay for the
  // word count. A layout's chain is its transitive includes; a path
  // under a loop variable also named `page` over-counts (safe).
  const layoutsNeedReading = new Set();
  {
    const readsIt = (nodes, seen) => {
      for (const n of nodes) {
        if (n.path !== undefined && n.path.length === 2 && n.path[0] === 'page' && n.path[1] === 'reading_minutes') return true;
        if (n.kind === 'include' && !seen.has(n.name)) {
          seen.add(n.name);
          if (asts[n.name] !== undefined && readsIt(asts[n.name], seen)) return true;
        }
        if (n.body !== undefined && readsIt(n.body, seen)) return true;
        if (n.then !== undefined && readsIt(n.then, seen)) return true;
        if (n.else !== null && n.else !== undefined && readsIt(n.else, seen)) return true;
      }
      return false;
    };
    for (const name of Object.keys(asts)) {
      if (readsIt(asts[name], new Set([name]))) layoutsNeedReading.add(name);
    }
  }
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => (y.data.date < x.data.date ? -1 : y.data.date > x.data.date ? 1 : 0) || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));
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
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));

  /** A page's link record as templates read it. */
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.date_long });

  /** A post's card, as lists show it. */
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.date_long,
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.post || layoutsNeedReading.has(s.layout) ? Math.max(1, Math.ceil(wordsOf(s.body) / 200)) : 0,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });

  /** A page as its layout reads it. A post's card is the one already built for the lists. */
  const pageOf = (s) => {
    const c = s.post ? cards.get(s) : cardOf(s);
    return {
      title: c.title, url: c.url, date: c.date, date_long: c.date_long,
      summary: c.summary, excerpt: c.excerpt, reading_minutes: c.reading_minutes, tags: c.tags,
      slug: s.slug, content: s.html, toc: s.toc,
      newer: linkOf(s.newer ?? null), older: linkOf(s.older ?? null), is_post: s.post,
    };
  };

  // 8. Every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  // The constant templates, rendered once for this case: the generated
  // code reads their strings from K instead of calling them per page.
  if (MEMO_OK) {
    const rootConst = Object.create(null);
    rootConst.site = site;
    rootConst.tags = allTags;
    rootConst.recent = recent;
    for (const name of CONST_TEMPLATES) {
      const fn = T[name];
      if (fn !== undefined) T.__K[name] = fn(rootConst, T, 0);
    }
  }
  const output = {};
  const rootPage = Object.create(null);
  rootPage.site = site;
  rootPage.tags = allTags;
  rootPage.recent = recent;
  const rootIndex = Object.create(null);
  rootIndex.site = site;
  rootIndex.tags = allTags;
  rootIndex.recent = recent;
  const rootTag = Object.create(null);
  rootTag.site = site;
  rootTag.tags = allTags;
  rootTag.recent = recent;
  const rootTags = Object.create(null);
  rootTags.site = site;
  rootTags.tags = allTags;
  rootTags.recent = recent;
  const render = (name, vars) => {
    const fn = T[name];
    if (fn === undefined) return null;
    let root;
    if (vars.posts !== undefined) {
      root = rootIndex;
      root.posts = vars.posts;
      root.pager = vars.pager;
    } else if (vars.tag !== undefined) {
      root = rootTag;
      root.tag = vars.tag;
    } else if (vars.page !== undefined) {
      root = rootPage;
      root.page = vars.page;
    } else {
      root = rootTags;
    }
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
  const lines = [...report, ...broken].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const npages = kept.filter((s) => !s.post).length;
  lines.push(`built ${npages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  for (const k of Object.keys(output)) output[k] = '' + output[k];
  return output;
}
