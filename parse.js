// parse.js — a from-scratch Markdown renderer that returns exactly the HTML
// marked 18.1.3 returns with its default options (GFM on, breaks off).
//
// Design: a line-based block parser builds a small tree of block nodes, then a
// renderer walks the tree and runs a single-pass inline scanner over each
// leaf's raw text. The inline scanner emits pieces (text, code spans, links,
// raw HTML, hard breaks, emphasis delimiters) and a CommonMark delimiter
// stack resolves emphasis, strong emphasis and strikethrough over them, so
// emphasis can span links and code spans without any token tree of its own.
// Nothing is kept between parse() calls: every call is stateless.

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
const WS_RE = /^\s$/;
// Marked's punctuation for emphasis flanking: any Unicode punctuation or
// symbol except '~' (which is the strikethrough marker, not punctuation).
const PUNCT_RE = /^(?!~)[\p{P}\p{S}]$/u;

function isWS(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || WS_RE.test(ch);
}
function isPunct(ch) {
  if (ch.length !== 1) return false;
  if (ch === '~') return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_PUNCT.has(ch);
  return PUNCT_RE.test(ch);
}
// Expand a leading run of spaces/tabs to spaces, as if it started at the
// given column (marked's J): a tab advances to the next multiple of four.
function expandWS(s, base) {
  let out = '';
  let col = base;
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
    if (s[i] === ' ') {
      out += ' ';
      col++;
    } else {
      const adv = 4 - (col % 4);
      out += ' '.repeat(adv);
      col += adv;
    }
    i++;
  }
  return out + s.slice(i);
}
// Index of the first character that is not a space (a tab counts as one).
function firstNonSpace(s) {
  let k = 0;
  while (k < s.length && s[k] === ' ') k++;
  return k;
}
function isAsciiPunct(ch) {
  return ch.length === 1 && ch.charCodeAt(0) < 128 && ASCII_PUNCT.has(ch);
}

// Escape &, <, >, " and ' fully.
function esc(s) {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let r = null;
    if (c === 38) r = '&amp;';
    else if (c === 60) r = '&lt;';
    else if (c === 62) r = '&gt;';
    else if (c === 34) r = '&quot;';
    else if (c === 39) r = '&#39;';
    if (r !== null) {
      out += s.slice(last, i) + r;
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

// Escape like esc(), but leave a well-formed character reference alone:
// &name; and &#123; / &#x1F; stay as written, a bare & becomes &amp;.
function escNoEnc(s) {
  let out = '';
  let last = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const m = entityAt(s, i);
      if (m > 0) {
        out += s.slice(last, i + m);
        last = i + m;
        i += m;
        continue;
      }
      out += s.slice(last, i) + '&amp;';
      last = i + 1;
    } else if (c === 60) {
      out += s.slice(last, i) + '&lt;';
      last = i + 1;
    } else if (c === 62) {
      out += s.slice(last, i) + '&gt;';
      last = i + 1;
    } else if (c === 34) {
      out += s.slice(last, i) + '&quot;';
      last = i + 1;
    } else if (c === 39) {
      out += s.slice(last, i) + '&#39;';
      last = i + 1;
    }
    i++;
  }
  return last === 0 ? s : out + s.slice(last);
}

// Length of the character reference starting at s[i] (an &), or 0 when the &
// does not start one. Numeric references are decoded by the caller.
function entityAt(s, i) {
  if (s[i] !== '&') return 0;
  let j = i + 1;
  if (s[j] === '#') {
    j++;
    let hex = false;
    if (s[j] === 'x' || s[j] === 'X') {
      hex = true;
      j++;
    }
    const start = j;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      const ok = hex
        ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
        : c >= 48 && c <= 57;
      if (!ok) break;
      j++;
    }
    const digits = j - start;
    if (digits >= 1 && digits <= (hex ? 6 : 7) && s[j] === ';') return j + 1 - i;
    return 0;
  }
  if (j < s.length) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      j++;
      while (j < s.length) {
        const d = s.charCodeAt(j);
        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57)) j++;
        else break;
      }
      if (s[j] === ';') return j + 1 - i;
    }
  }
  return 0;
}

// Escape plain text: like escNoEnc, except numeric character references are
// decoded to the character (invalid code points become U+FFFD), and a named
// reference is passed through unchanged.
function escText(s) {
  let out = '';
  let last = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const m = entityAt(s, i);
      if (m > 0) {
        if (s[i + 1] === '#') {
          let code;
          const body = s.slice(i + 2, i + m - 1);
          if (body[0] === 'x' || body[0] === 'X') code = parseInt(body.slice(1), 16);
          else code = parseInt(body, 10);
          if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) code = 0xfffd;
          const ch = String.fromCodePoint(code);
          out += s.slice(last, i) + esc(ch);
          last = i + m;
        } else {
          out += s.slice(last, i + m);
          last = i + m;
        }
        i += m;
        continue;
      }
      out += s.slice(last, i) + '&amp;';
      last = i + 1;
    } else if (c === 60) {
      out += s.slice(last, i) + '&lt;';
      last = i + 1;
    } else if (c === 62) {
      out += s.slice(last, i) + '&gt;';
      last = i + 1;
    } else if (c === 34) {
      out += s.slice(last, i) + '&quot;';
      last = i + 1;
    } else if (c === 39) {
      out += s.slice(last, i) + '&#39;';
      last = i + 1;
    }
    i++;
  }
  return last === 0 ? s : out + s.slice(last);
}

// Resolve backslash escapes: \ + ASCII punctuation yields the punctuation,
// anything else keeps the backslash.
function unescape(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      out += s.slice(last, i) + s[i + 1];
      last = i + 2;
      i++;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

// Clean a link destination the way marked does: percent-encode it, but keep
// an existing % sequence intact.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return href;
  }
}

// ---------------------------------------------------------------------------
// Line helpers. A tab advances the column to the next multiple of four.

function indentOf(line) {
  let cols = 0;
  let idx = 0;
  while (idx < line.length) {
    const c = line.charCodeAt(idx);
    if (c === 32) {
      cols++;
      idx++;
    } else if (c === 9) {
      cols += 4 - (cols % 4);
      idx++;
    } else break;
  }
  return { cols, idx };
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Remove the first `cols` columns of indentation from a line. A tab that
// straddles the boundary is replaced by the spaces it would have covered.
function stripCols(line, cols) {
  let c = 0;
  let idx = 0;
  while (idx < line.length && c < cols) {
    const ch = line.charCodeAt(idx);
    if (ch === 32) {
      c++;
      idx++;
    } else if (ch === 9) {
      const adv = 4 - (c % 4);
      if (c + adv > cols) return ' '.repeat(c + adv - cols) + line.slice(idx + 1);
      c += adv;
      idx++;
    } else break;
  }
  return line.slice(idx);
}

// ---------------------------------------------------------------------------
// Block structure helpers.

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'section',
  'source', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

// Which kind of HTML block a line starts (CommonMark types 1-7), or 0.
// Returns {type, tag} for type 1 (the tag whose end tag closes it).
function htmlStart(line) {
  const ind = indentOf(line);
  if (ind.cols > 3) return null;
  const s = line.slice(ind.idx);
  if (s.charCodeAt(0) !== 60) return null; // not <
  const low = s.toLowerCase();
  const m1 = /^(?:<(script|pre|style|textarea)(?:[\s>]|$))/i.exec(s);
  if (m1) return { type: 1, tag: m1[1].toLowerCase() };
  if (low.startsWith('<!--')) return { type: 2, tag: null };
  if (low.startsWith('<?')) return { type: 3, tag: null };
  if (low.startsWith('<![cdata[')) return { type: 5, tag: null };
  if (/^<![a-z]/i.test(s)) return { type: 4, tag: null };
  const tagM = /^<\/?([a-z][a-z0-9-]*)/i.exec(s);
  if (tagM) {
    const name = tagM[1].toLowerCase();
    const after = s[tagM[0].length];
    if (after === undefined || after === ' ' || after === '\t' || after === '>' || after === '/') {
      if (BLOCK_TAGS.has(name)) return { type: 6, tag: null };
    }
    // Type 7: the whole line is one complete tag. A closing tag takes no
    // attributes; an opening tag takes the block attribute form.
    if (s[1] === '/') {
      if (/^<\/[a-z][a-z0-9-]*\s*>[ \t]*$/i.test(s)) return { type: 7, tag: null };
    } else if (/^<[a-z][a-z0-9-]*(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"]*"| *= *'[^']*'| *= *[^\s"'=<>`]+)?)* *\/?>[ \t]*$/i.test(s)) {
      return { type: 7, tag: null };
    }
  }
  return null;
}

function fenceInfo(line) {
  const ind = indentOf(line);
  if (ind.cols > 3) return null;
  const s = line.slice(ind.idx);
  const ch = s[0];
  if (ch !== '`' && ch !== '~') return null;
  let n = 0;
  while (s[n] === ch) n++;
  if (n < 3) return null;
  return { ch, len: n, info: s.slice(n), ind };
}

function isFenceClose(line, ch, len) {
  const ind = indentOf(line);
  if (ind.cols > 3) return false;
  const s = line.slice(ind.idx);
  let n = 0;
  while (s[n] === ch) n++;
  if (n < len) return false;
  for (let k = n; k < s.length; k++) {
    if (s[k] !== ' ' && s[k] !== '\t') return false;
  }
  return true;
}

function isHR(line) {
  const ind = indentOf(line);
  if (ind.cols > 3) return false;
  const s = line.slice(ind.idx);
  const c = s[0];
  if (c !== '-' && c !== '*' && c !== '_') return false;
  let count = 0;
  for (let k = 0; k < s.length; k++) {
    if (s[k] === c) count++;
    else if (s[k] !== ' ' && s[k] !== '\t') return false;
  }
  return count >= 3;
}

function atxHeading(line) {
  const ind = indentOf(line);
  if (ind.cols > 3) return null;
  const s = line.slice(ind.idx);
  if (s[0] !== '#') return null;
  let n = 0;
  while (s[n] === '#') n++;
  if (n > 6) return null;
  if (n === s.length) return { level: n, raw: '' };
  if (s[n] !== ' ' && s[n] !== '\t') return null;
  let raw = s.slice(n + 1).trim();
  // Marked's closing rule: trailing #s come off only when what remains is
  // empty or ends in a space or tab, so "## foo#" keeps its #.
  if (raw.endsWith('#')) {
    const stripped = raw.replace(/#+$/, '');
    if (stripped === '' || stripped.endsWith(' ') || stripped.endsWith('\t')) {
      raw = stripped.trim();
    }
  }
  return { level: n, raw };
}

// Setext underline level (1 for =, 2 for -), or 0.
function setextLevel(line) {
  const ind = indentOf(line);
  if (ind.cols > 3) return 0;
  const s = line.slice(ind.idx);
  if (s.length === 0) return 0;
  const c = s[0];
  if (c !== '=' && c !== '-') return 0;
  // The run must be contiguous: "= =" and "--- -" are not underlines.
  let k = 1;
  while (k < s.length && s[k] === c) k++;
  for (; k < s.length; k++) {
    if (s[k] !== ' ' && s[k] !== '\t') return 0;
  }
  return c === '=' ? 1 : 2;
}

// Information about a list marker at the start of a line, or null.
function listMarker(line) {
  const ind = indentOf(line);
  if (ind.cols > 3) return null;
  const s = line.slice(ind.idx);
  let markerLen = 0;
  let ord = false;
  let num = 0;
  let delim = '';
  let bullet = '';
  const c = s[0];
  if (c === '-' || c === '+' || c === '*') {
    bullet = c;
    markerLen = 1;
  } else if (c >= '0' && c <= '9') {
    let k = 0;
    while (k < s.length && s[k] >= '0' && s[k] <= '9' && k < 9) k++;
    if (k === 0 || k > 9) return null;
    if (s[k] !== '.' && s[k] !== ')') return null;
    num = parseInt(s.slice(0, k), 10);
    delim = s[k];
    markerLen = k + 1;
    ord = true;
  } else {
    return null;
  }
  // The marker must be followed by whitespace or the end of the line.
  const after = s[markerLen];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  // Work out the content indent and the content of the first line: expand
  // the whitespace run after the marker from the marker's end column, then
  // take the first non-space position (capped at 1 when it exceeds four).
  const markerCol = ind.cols;
  const markerEndCol = markerCol + markerLen;
  const m = expandWS(s.slice(markerLen), markerEndCol);
  let content;
  let contentIndent;
  if (m.trim() === '') {
    content = '';
    contentIndent = markerEndCol + 1;
  } else {
    let R = firstNonSpace(m);
    if (R > 4) R = 1;
    content = m.slice(R);
    contentIndent = R + markerEndCol;
  }
  return { ord, num, delim, bullet, markerLen, content, contentIndent, indent: markerCol };
}

// ---------------------------------------------------------------------------
// Link reference definitions.

// Normalise a link label the way marked does (its F): trim, collapse
// whitespace runs, then lower-upper-lower, which folds ẞ to ss. No
// unescaping: a label written foo\! does not match a definition foo!.
function normLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Parse a link title starting at s[r] (one of " ' (). The " and ( forms may
// span lines; the ' form may span lines but not a blank line. Returns
// {title, end} or null.
function parseTitleStr(s, r) {
  const q = s[r];
  if (q === '"' || q === "'") {
    let j = r + 1;
    while (j < s.length) {
      if (s[j] === '\\' && j + 1 < s.length) {
        j += 2;
        continue;
      }
      if (q === "'" && s[j] === '\n' && s[j + 1] === '\n') return null;
      if (s[j] === q) return { title: s.slice(r + 1, j), end: j + 1 };
      j++;
    }
    return null;
  }
  if (q === '(') {
    let j = r + 1;
    while (j < s.length) {
      if (s[j] === '\\' && j + 1 < s.length) {
        j += 2;
        continue;
      }
      if (s[j] === '(') return null;
      if (s[j] === ')') return { title: s.slice(r + 1, j), end: j + 1 };
      j++;
    }
    return null;
  }
  return null;
}

// Try to read a link reference definition starting at lines[i], following
// marked's Fe regex over the lines joined by newlines: the label may span
// lines but not a blank line, the destination may sit on the next line, and
// the title may sit on the next line and span lines. A title on the next
// line that fails or has trailing junk does not kill the definition (it
// stands without the title); a same-line title failure does. Returns
// {next, label, dest, title} or null.
function tryParseDef(lines, i, end) {
  const line = lines[i];
  const ind = indentOf(line);
  if (ind.cols > 3) return null;
  const s0 = line.slice(ind.idx);
  if (s0[0] !== '[') return null;
  // Join enough lines for the longest realistic definition.
  const k = Math.min(end, i + 16);
  let s = s0;
  for (let m = i + 1; m < k; m++) s += '\n' + lines[m];
  // Label: escapes, any char except [ ] \ newline, or a newline not
  // followed by a blank line; no nested [; not empty or whitespace-only.
  let p = 1;
  let close = -1;
  while (p < s.length) {
    const c = s[p];
    if (c === '\\' && p + 1 < s.length) {
      p += 2;
      continue;
    }
    if (c === ']') {
      close = p;
      break;
    }
    if (c === '[') return null;
    if (c === '\n') {
      let q = p + 1;
      while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
      if (q >= s.length || s[q] === '\n') return null;
      p++;
      continue;
    }
    p++;
  }
  if (close < 0) return null;
  const label = s.slice(1, close);
  if (normLabel(label) === '') return null;
  if (s[close + 1] !== ':') return null;
  p = close + 2;
  while (s[p] === ' ') p++;
  // The destination may sit on the next line, any indent.
  if (s[p] === '\n') {
    p++;
    while (s[p] === ' ' || s[p] === '\t') p++;
  }
  // Destination: <...> on one line, or a run of non-whitespace.
  let dest;
  if (s[p] === '<') {
    let q = p + 1;
    while (q < s.length && s[q] !== '>' && s[q] !== '\n') q++;
    if (s[q] !== '>') return null;
    dest = s.slice(p + 1, q);
    p = q + 1;
  } else {
    let q = p;
    while (q < s.length && s[q] !== ' ' && s[q] !== '\t' && s[q] !== '\n') q++;
    if (q === p) return null;
    dest = s.slice(p, q);
    p = q;
  }
  // Optional title, preceded by spaces and/or a newline. Track whether the
  // title crossed onto a following line: a crossed title that fails or has
  // trailing junk leaves the definition standing without it.
  let title = null;
  let endPos = -1;
  let q = p;
  let hadSep = false;
  let crossLine = false;
  while (s[q] === ' ') {
    q++;
    hadSep = true;
  }
  if (s[q] === '\n') {
    crossLine = true;
    hadSep = true;
    q++;
    while (s[q] === ' ' || s[q] === '\t') q++;
  }
  if ((s[q] === '"' || s[q] === "'" || s[q] === '(') && hadSep) {
    const t = parseTitleStr(s, q);
    if (t) {
      let r = t.end;
      while (s[r] === ' ') r++;
      if (s[r] === '\n' || r >= s.length) {
        title = t.title;
        endPos = r;
      } else if (crossLine) {
        endPos = p;
        while (s[endPos] === ' ') endPos++;
      } else {
        return null;
      }
    } else if (crossLine) {
      endPos = p;
      while (s[endPos] === ' ') endPos++;
    } else {
      return null;
    }
  } else if (s[q] === '\n' || q >= s.length) {
    endPos = q;
  } else if (crossLine) {
    endPos = p;
    while (s[endPos] === ' ') endPos++;
  } else {
    return null;
  }
  // Trailing newlines belong to the definition.
  while (endPos < s.length && s[endPos] === '\n') endPos++;
  let nl = 0;
  for (let m = 0; m < endPos; m++) if (s[m] === '\n') nl++;
  const next = i + nl + (endPos > 0 && s[endPos - 1] === '\n' ? 0 : 1);
  return { next, label, dest, title };
}

// ---------------------------------------------------------------------------
// Tables.

function splitRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) {
      // An escaped pipe is a literal pipe (the backslash goes); any other
      // escape is left for the inline parser.
      if (line[i + 1] === '|') {
        cur += '|';
        i++;
      } else {
        cur += c + line[i + 1];
        i++;
      }
    } else if (c === '|') {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  const trimmed = line.trim();
  if (trimmed.startsWith('|')) cells.shift();
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) cells.pop();
  return cells.map((x) => x.trim());
}

function parseDelimRow(line) {
  const ind = indentOf(line);
  if (ind.cols > 3) return null;
  const s = line.slice(ind.idx).trim();
  if (s.indexOf('-') < 0) return null;
  const cells = splitRow(s);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    if (/^:?-+:?$/.test(cell)) {
      const left = cell.startsWith(':');
      const right = cell.endsWith(':');
      aligns.push(left && right ? 2 : left ? 1 : right ? 3 : 0);
    } else {
      return null;
    }
  }
  return aligns;
}

// ---------------------------------------------------------------------------
// Block parsing.

// Should an indented-code line at lines[j] merge into the paragraph being
// built? Inside a list item (top=false) any code line merges; inside a
// blockquote (top=true) only a code line that starts a lazy group does.
function codeMergeHere(j, top, lazy) {
  if (!top) return true;
  return !!(lazy && lazy[j] && (j === 0 || !lazy[j - 1]));
}

// Does a line end a table's body rows?
function interruptsTableRow(line) {
  const ind = indentOf(line);
  if (ind.cols > 3) return false;
  if (isHR(line)) return true;
  if (atxHeading(line)) return true;
  if (line[ind.idx] === '>') return true;
  if (isCodeLine(line)) return true;
  const f = fenceInfo(line);
  if (f && !(f.ch === '`' && f.info.indexOf('`') >= 0)) return true;
  const m = listMarker(line);
  if (m && (!m.ord || m.num === 1)) return true;
  const hs = htmlStart(line);
  if (hs && hs.type <= 6) return true;
  return false;
}

function parseBlocks(lines, start, end, ctx, top, lazy, root) {
  const nodes = [];
  let loose = false;
  let sawBlock = false;
  let pendingBlank = false;
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) {
      if (sawBlock) pendingBlank = true;
      i++;
      continue;
    }
    if (pendingBlank) {
      loose = true;
      pendingBlank = false;
    }
    // Link reference definitions.
    const def = tryParseDef(lines, i, end);
    if (def) {
      const key = normLabel(def.label);
      if (!ctx.refs.has(key)) ctx.refs.set(key, { dest: def.dest, title: def.title });
      i = def.next;
      continue;
    }
    const ind = indentOf(line);
    if (ind.cols >= 4) {
      // Indented code block.
      const { codeLines, next } = collectCodeRun(lines, i, end);
      nodes.push({ t: 'code', lang: null, text: codeLines.length ? codeLines.join('\n') + '\n' : '' });
      i = next;
      sawBlock = true;
      continue;
    }
    const fence = fenceInfo(line);
    if (fence) {
      if (fence.ch === '`' && fence.info.indexOf('`') >= 0) {
        // Not a fence after all: fall through to paragraph handling.
      } else {
        const content = [];
        let j = i + 1;
        while (j < end) {
          if (isFenceClose(lines[j], fence.ch, fence.len)) {
            j++;
            break;
          }
          content.push(lines[j]);
          j++;
        }
        // Content is the lines joined by newlines (no trailing newline
        // added); backtick fences dedent by the fence's own indent.
        let text = '';
        if (content.length) {
          if (fence.ch === '`') {
            const n = fence.ind.idx;
            text = content
              .map((l) => {
                const m = /^[ \t]*/.exec(l);
                return l.slice(Math.min(m[0].length, n));
              })
              .join('\n');
          } else {
            text = content.join('\n');
          }
        }
        const info = unescape(fence.info.trim());
        const lang = info === '' ? null : info.split(/\s+/)[0];
        nodes.push({ t: 'code', lang, text });
        i = j;
        sawBlock = true;
        continue;
      }
    }
    const atx = atxHeading(line);
    if (atx) {
      nodes.push({ t: 'h', lv: atx.level, raw: atx.raw });
      i++;
      sawBlock = true;
      continue;
    }
    if (isHR(line)) {
      nodes.push({ t: 'hr' });
      i++;
      sawBlock = true;
      continue;
    }
    const hs = htmlStart(line);
    if (hs) {
      const { text, next } = collectHtml(lines, i, end, hs, root, ctx);
      nodes.push({ t: 'html', text });
      i = next;
      sawBlock = true;
      continue;
    }
    if (ind.cols <= 3 && line[ind.idx] === '>') {
      const { inner, next, lazy: innerLazy } = collectBlockquote(lines, i, end);
      const children = parseBlocks(inner, 0, inner.length, ctx, true, innerLazy, false);
      nodes.push({ t: 'bq', ch: children });
      i = next;
      sawBlock = true;
      continue;
    }
    const marker = listMarker(line);
    if (marker) {
      const { node, next } = parseList(lines, i, end, ctx);
      nodes.push(node);
      i = next;
      sawBlock = true;
      continue;
    }
    // Table: header line plus a delimiter row, with matching cell counts.
    if (line.indexOf('|') >= 0 && i + 1 < end) {
      const aligns = parseDelimRow(lines[i + 1]);
      if (aligns) {
        const head = splitRow(line.slice(ind.idx));
        if (head.length === aligns.length) {
          const rows = [];
          let j = i + 2;
          while (j < end) {
            const rl = lines[j];
            // A body row ends only at a spaces-only (or empty) line: the
            // table regex's blank exclusion is (?! *\n), so a tab-only
            // line is a row (of empty cells), as is a plain-text line.
            if (/^ *$/.test(rl) || interruptsTableRow(rl)) break;
            rows.push(splitRow(rl.slice(indentOf(rl).idx)));
            j++;
          }
          nodes.push({ t: 'table', align: aligns, head, rows });
          i = j;
          sawBlock = true;
          continue;
        }
      }
    }
    // Paragraph (possibly a setext heading). Lines are kept verbatim,
    // including their leading spaces.
    const para = [];
    let j = i;
    let headingLevel = 0;
    while (j < end) {
      const ln = lines[j];
      if (isBlank(ln)) {
        // A whitespace-only line is a paragraph continuation only when it
        // is the last line and no newline follows it, and it is not a lazy
        // line (the space rule folds those away instead). An empty last
        // line is the phantom left by joining inner lines, not a real
        // line, so only a line holding spaces or tabs counts.
        if (j === end - 1 && ln.length > 0 && !(lazy && lazy[j]) && !(root && ctx.endsWithNL)) {
          para.push(ln);
          j++;
        }
        break;
      }
      if (j > i && interruptsParagraph(ln, top)) break;
      if (j > i && isCodeLine(ln) && codeMergeHere(j, top, lazy)) {
        // An indented-code run merges into the paragraph text (one indent
        // unit removed); it keeps a trailing newline when a non-blank line
        // follows the run.
        const { codeLines, next } = collectCodeRun(lines, j, end);
        let codeText = codeLines.join('\n');
        if (next < end && !isBlank(lines[next])) codeText += '\n';
        para.push(codeText);
        j = next;
        continue;
      }
      para.push(ln);
      j++;
      if (j < end) {
        const lv = setextLevel(lines[j]);
        if (lv > 0) {
          headingLevel = lv;
          j++;
          break;
        }
      }
    }
    if (para.length > 0) {
      if (headingLevel > 0) nodes.push({ t: 'h', lv: headingLevel, raw: para.join('\n').trim() });
      else nodes.push({ t: 'p', raw: para.join('\n') });
      sawBlock = true;
    }
    i = j;
  }
  nodes.loose = loose;
  return nodes;
}

// Collect an indented code run starting at lines[i]: code lines plus the
// blank lines between them (a blank line only counts when another code line
// follows). Each line loses one indent unit. Returns the stripped lines and
// the index of the first line after the run.
function collectCodeRun(lines, i, end) {
  const codeLines = [];
  let j = i;
  while (j < end) {
    const ln = lines[j];
    if (isBlank(ln)) {
      let k = j;
      while (k < end && isBlank(lines[k])) k++;
      if (k < end && isCodeLine(lines[k])) {
        while (j < k) {
          codeLines.push(stripCols(lines[j], 4));
          j++;
        }
        continue;
      }
      break;
    }
    if (isCodeLine(ln)) {
      codeLines.push(stripCols(ln, 4));
      j++;
      continue;
    }
    break;
  }
  return { codeLines, next: j };
}

// Does a line start a block that can interrupt a paragraph? At the top
// level (and in blockquotes) a GFM ordered list only interrupts when it
// starts at 1; inside a list item there is no paragraph regex, each line is
// a text token, and any list marker starts a list.
function interruptsParagraph(line, top) {
  const ind = indentOf(line);
  if (ind.cols > 3) return false;
  if (atxHeading(line)) return true;
  const f = fenceInfo(line);
  // A backtick fence whose info string holds a backtick is not a fence.
  if (f && !(f.ch === '`' && f.info.indexOf('`') >= 0)) return true;
  if (isHR(line)) return true;
  const hs = htmlStart(line);
  if (hs && hs.type <= 6) return true;
  if (line[ind.idx] === '>') return true;
  const m = listMarker(line);
  if (m) {
    // In GFM a list marker interrupts a paragraph only when the item has
    // content, and an ordered item only when it starts at 1.
    if (!top) return true;
    if (m.content.trim() === '') return false;
    if (!m.ord) return true;
    return m.num === 1;
  }
  return false;
}

// Collect an HTML block starting at lines[i]. Returns its raw text and the
// index of the first line after it. The text keeps the newline after its
// last line, unless the block is followed by a genuine blank line.
function collectHtml(lines, i, end, hs, root, ctx) {
  const collected = [];
  let j = i;
  if (hs.type === 1) {
    const closeRe = new RegExp('</' + hs.tag + '(?:[\\s>]|$)', 'i');
    while (j < end) {
      collected.push(lines[j]);
      const done = closeRe.test(lines[j]);
      j++;
      if (done) break;
    }
  } else if (hs.type === 2) {
    while (j < end) {
      collected.push(lines[j]);
      const done = lines[j].indexOf('-->') >= 0;
      j++;
      if (done) break;
    }
  } else if (hs.type === 3) {
    while (j < end) {
      collected.push(lines[j]);
      const done = lines[j].indexOf('?>') >= 0;
      j++;
      if (done) break;
    }
  } else if (hs.type === 4) {
    while (j < end) {
      collected.push(lines[j]);
      const done = lines[j].indexOf('>') >= 0;
      j++;
      if (done) break;
    }
  } else if (hs.type === 5) {
    while (j < end) {
      collected.push(lines[j]);
      const done = lines[j].indexOf(']]>') >= 0;
      j++;
      if (done) break;
    }
  } else {
    // Types 6 and 7 run until a blank line.
    while (j < end && !isBlank(lines[j])) {
      collected.push(lines[j]);
      j++;
    }
  }
  let text = collected.join('\n');
  // The block keeps the newline after its last line when one follows it in
  // the source, unless the next line is blank (then it is dropped). A
  // tab-only line is not blank here (the block regex's blank exclusion is
  // spaces-only, as in tables), so the newline is kept before a \t line.
  const hasNL = j < end || (root && ctx.endsWithNL);
  if (hasNL && !(j < end && /^ *$/.test(lines[j]))) text += '\n';
  return { text, next: j };
}

// Is this line an indented-code line (a line the code tokenizer would take:
// four columns of indent, or up to three spaces plus a tab, with content)?
function isCodeLine(line) {
  return !isBlank(line) && indentOf(line).cols >= 4;
}

// Classify a container-stripped line for lazy-continuation decisions.
function lineKind(line) {
  if (isBlank(line)) return 'blank';
  const ind = indentOf(line);
  if (ind.cols >= 4) return 'code';
  if (atxHeading(line)) return 'heading';
  const f = fenceInfo(line);
  if (f) return 'fence';
  if (isHR(line)) return 'hr';
  const hs = htmlStart(line);
  if (hs) return 'html';
  if (setextLevel(line) > 0) return 'setext';
  if (listMarker(line)) return 'list';
  return 'plain';
}

// Is this line a block start that a blockquote's lazy line cannot be? A
// lazy line may be an indented-code line (it merges into the paragraph) or
// a setext line (it stays text, indented), but not a fence, heading, hr,
// HTML block or list item.
function isBqLazyBlockStart(line) {
  const k = lineKind(line);
  return k === 'fence' || k === 'heading' || k === 'hr' || k === 'html' || k === 'list';
}

// The block kind of the last inner line of a blockquote, for lazy decisions.
// A setext line after a paragraph line forms a heading; a delimiter row
// after a header line is a table; both end lazy continuation.
function bqKind(inner) {
  const n = inner.length;
  const last = inner[n - 1];
  if (isBlank(last)) return 'blank';
  if (setextLevel(last) > 0 && n >= 2) {
    const pk = lineKind(inner[n - 2]);
    if (pk === 'plain' || pk === 'setext') return 'heading';
    return 'plain';
  }
  if (n >= 2) {
    const aligns = parseDelimRow(last);
    if (aligns && inner[n - 2].indexOf('|') >= 0) {
      if (splitRow(inner[n - 2].slice(indentOf(inner[n - 2]).idx)).length === aligns.length) {
        return 'table';
      }
    }
  }
  return lineKind(last);
}

// Collect a blockquote's inner lines starting at lines[i]. Returns the inner
// lines, the index of the first line after the quote, and a parallel array
// marking which inner lines came from lazy (non->) lines. A blank line ends
// the quote; a lazy line is kept only after a paragraph or list line and
// only when it is not itself a block start.
function collectBlockquote(lines, i, end) {
  const inner = [];
  const lazy = [];
  let j = i;
  let inFence = null;
  let lastKind = 'blank';
  while (j < end) {
    const line = lines[j];
    const ind = indentOf(line);
    if (ind.cols <= 3 && line[ind.idx] === '>') {
      // Marker whitespace is J-expanded from the marker's end column, then
      // the marker plus one space or tab is removed.
      const after = line.slice(ind.idx + 1);
      let k = 0;
      while (k < after.length && (after[k] === ' ' || after[k] === '\t')) k++;
      const expanded = expandWS(after.slice(0, k), ind.cols + 1);
      const stripped = expanded.length > 0 ? expanded.slice(1) + after.slice(k) : after.slice(k);
      inner.push(stripped);
      lazy.push(false);
      if (inFence) {
        if (isFenceClose(stripped, inFence.ch, inFence.len)) inFence = null;
        lastKind = 'fence';
      } else {
        const f = fenceInfo(stripped);
        if (f && !(f.ch === '`' && f.info.indexOf('`') >= 0)) {
          inFence = f;
          lastKind = 'fence';
        } else {
          lastKind = bqKind(inner);
        }
      }
      j++;
      continue;
    }
    if (isBlank(line)) break;
    if (
      !inFence &&
      (lastKind === 'plain' || lastKind === 'list') &&
      !isBqLazyBlockStart(line) &&
      !(line.indexOf('|') >= 0 && j + 1 < end && parseDelimRow(lines[j + 1]) !== null)
    ) {
      // A lazy setext line is indented by four spaces, so it stays text
      // instead of turning the paragraph into a heading.
      let l = line;
      if (setextLevel(l) > 0) l = '    ' + l.replace(/^ {0,3}/, '');
      inner.push(l);
      lazy.push(true);
      // A lazy line joins the paragraph the quote is in (a code line merges
      // into it, a setext line stays text), so lazy continuation stays open.
      lastKind = 'plain';
      j++;
      continue;
    }
    break;
  }
  return { inner, next: j, lazy };
}

// Block-start checks on a raw line with a maximum indent (the list's break
// checks use indent clamped to R-1, at most 3).
function isFenceStartAt(line, maxInd) {
  const ind = indentOf(line);
  if (ind.cols > maxInd) return false;
  return !!fenceInfo(line);
}
function isAtxStartAt(line, maxInd) {
  const ind = indentOf(line);
  return ind.cols <= maxInd && !!atxHeading(line);
}
function isHtmlStartAt(line, maxInd) {
  const ind = indentOf(line);
  if (ind.cols > maxInd) return false;
  const hs = htmlStart(line);
  return !!hs && hs.type <= 6;
}
function isBqStartAt(line, maxInd) {
  const ind = indentOf(line);
  return ind.cols <= maxInd && line[ind.idx] === '>';
}
function isBulletStartAt(line, maxInd) {
  const ind = indentOf(line);
  if (ind.cols > maxInd) return false;
  return !!listMarker(line);
}
function isHRStartAt(line, maxInd) {
  const ind = indentOf(line);
  return ind.cols <= maxInd && isHR(line);
}

// Is this line a setext underline with spaces only after the run (the form
// the list's lazy-setext check uses)?
function isSetextSpacesOnly(line) {
  const ind = indentOf(line);
  if (ind.cols > 3) return false;
  const s = line.slice(ind.idx);
  if (s.length === 0) return false;
  const c = s[0];
  if (c !== '=' && c !== '-') return false;
  let k = 1;
  while (k < s.length && s[k] === c) k++;
  for (; k < s.length; k++) {
    if (s[k] !== ' ') return false;
  }
  return true;
}

// Could mPrev be the paragraph of a setext heading with f as its underline?
function isLheadingLine(mPrev, f) {
  if (mPrev.trim() === '') return false;
  const ind = indentOf(mPrev);
  if (ind.cols <= 3 && mPrev[ind.idx] === '>') return false;
  const k = lineKind(mPrev);
  if (k === 'list' || k === 'code' || k === 'fence' || k === 'heading' || k === 'html') {
    return false;
  }
  return isSetextSpacesOnly(f);
}

// Parse a list starting at lines[i]. Returns the list node and the index of
// the first line after it.
function parseList(lines, i, end, ctx) {
  const first = listMarker(lines[i]);
  const items = [];
  let loose = false;
  let j = i;
  let prevDoubleBlank = false;
  while (j < end) {
    const info = listMarker(lines[j]);
    if (
      !info ||
      info.ord !== first.ord ||
      info.delim !== first.delim ||
      info.bullet !== first.bullet ||
      isHR(lines[j])
    ) {
      break;
    }
    if (prevDoubleBlank) loose = true;
    prevDoubleBlank = false;
    const R = info.contentIndent;
    const maxInd = Math.max(0, Math.min(3, R - 1));
    const itemLines = [info.content];
    let mPrev = info.content;
    let y = info.content.trim() === '';
    let u = false;
    if (y && j + 1 < end && isBlank(lines[j + 1])) {
      // Empty item followed by a blank line: the item is empty and no
      // continuation lines follow. The blank line stays for the enclosing
      // block unless another item of this list follows it.
      const ni = j + 2 < end ? listMarker(lines[j + 2]) : null;
      if (ni && ni.ord === first.ord && ni.delim === first.delim && ni.bullet === first.bullet) {
        j += 2;
        prevDoubleBlank = true;
      } else {
        j += 1;
      }
      u = true;
    }
    let k = u ? j : j + 1;
    let trailingBlankStart = -1;
    let brokeForNewItem = false;
    if (!u) {
      while (k < end) {
        const U = lines[k];
        const f = U;
        const Z = expandWS(U, 0);
        if (
          isFenceStartAt(f, maxInd) ||
          isAtxStartAt(f, maxInd) ||
          isHtmlStartAt(f, maxInd) ||
          isBqStartAt(f, maxInd) ||
          isBulletStartAt(f, maxInd) ||
          isHRStartAt(f, maxInd)
        ) {
          break;
        }
        if (firstNonSpace(Z) >= R || !f.trim()) {
          if (!f.trim()) {
            if (trailingBlankStart < 0) trailingBlankStart = k;
          } else {
            trailingBlankStart = -1;
          }
          itemLines.push(Z.slice(R));
          mPrev = Z.slice(R);
        } else {
          if (
            y ||
            firstNonSpace(mPrev.replace(/\t/g, '    ')) >= 4 ||
            isFenceStartAt(mPrev, maxInd) ||
            isAtxStartAt(mPrev, maxInd) ||
            isHtmlStartAt(mPrev, maxInd) ||
            isHRStartAt(mPrev, maxInd)
          ) {
            break;
          }
          let qe = f;
          if (isSetextSpacesOnly(f) && isLheadingLine(mPrev, f)) {
            qe = '    ' + Z.replace(/^ {0,3}/, '');
          }
          itemLines.push(qe);
          mPrev = Z.slice(R);
          trailingBlankStart = -1;
        }
        y = !f.trim();
        k++;
      }
      // A new item of this list at the break point keeps the blank lines
      // (they make the list loose); otherwise they are left for the
      // enclosing block to see as a separator.
      if (k < end) {
        const ni = listMarker(lines[k]);
        brokeForNewItem = !!(
          ni &&
          ni.ord === first.ord &&
          ni.delim === first.delim &&
          ni.bullet === first.bullet
        );
      }
      if (trailingBlankStart >= 0 && !brokeForNewItem) {
        itemLines.length = itemLines.length - (k - trailingBlankStart);
        j = trailingBlankStart;
      } else {
        j = k;
      }
    }
    // The item's raw ends with a double blank line when its last consumed
    // line is blank and there is more than one line.
    if (!u && itemLines.length >= 2 && isBlank(itemLines[itemLines.length - 1])) {
      prevDoubleBlank = true;
    }
    while (itemLines.length > 0 && isBlank(itemLines[itemLines.length - 1])) {
      itemLines.pop();
    }
    const children = parseBlocks(itemLines, 0, itemLines.length, ctx, false, undefined, false);
    if (children.loose) loose = true;
    items.push(children);
  }
  return {
    node: { t: 'list', ord: first.ord, start: first.num, loose, items },
    next: j,
  };
}

// ---------------------------------------------------------------------------
// Inline parsing.

// Find the index of the ] matching the [ at openIdx, or -1. Code spans and
// backslash escapes do not count brackets. Marked's label regex nests at
// most three levels deep, so a fourth [ fails the match.
function findLinkEnd(src, openIdx, n) {
  let depth = 1;
  let j = openIdx + 1;
  while (j < n) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') {
      let m = j;
      while (m < n && src[m] === '`') m++;
      const run = m - j;
      // Marked's label regex skips a code-span-like run of any length
      // (opener and closer need not match); only an unclosed run kills
      // the label, except 2+ backticks immediately before ] (``+(?=])).
      let k = m;
      let found = -1;
      while (k < n) {
        if (src[k] === '`') {
          let p = k;
          while (p < n && src[p] === '`') p++;
          found = p;
          break;
        }
        k++;
      }
      if (found < 0) {
        if (run >= 2 && src[m] === ']') {
          j = m;
          continue;
        }
        return -1;
      }
      j = found;
      continue;
    }
    if (c === '[') {
      depth++;
      if (depth > 3) return -1;
    } else if (c === ']') {
      depth--;
      if (depth === 0) return j;
    }
    j++;
  }
  return -1;
}

function skipInlineWS(src, i, n) {
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n') i++;
    else break;
  }
  return i;
}

// Parse a link destination starting at src[i]. Returns {dest, end} or null.
function parseDest(src, i, n) {
  if (src[i] === '<') {
    let j = i + 1;
    while (j < n && src[j] !== '>' && src[j] !== '\n') {
      if (src[j] === '\\' && j + 1 < n) j += 2;
      else if (src[j] === '<') return null;
      else j++;
    }
    if (j >= n || src[j] !== '>') return null;
    return { dest: src.slice(i + 1, j), end: j + 1 };
  }
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = src[j];
    if (c === ' ' || c === '\t' || c === '\n') break;
    if (c === '\\' && j + 1 < n) {
      j += 2;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) break;
      depth--;
    } else if (c < ' ') break;
    j++;
  }
  return { dest: src.slice(i, j), end: j };
}

// Parse a title starting at src[i] (one of " ' (). Returns {title, end}.
function parseTitle(src, i, n) {
  const q = src[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < n) {
      if (src[j] === '\\' && j + 1 < n) {
        j += 2;
        continue;
      }
      if (src[j] === q) return { title: src.slice(i + 1, j), end: j + 1 };
      j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1;
    while (j < n) {
      if (src[j] === '\\' && j + 1 < n) {
        j += 2;
        continue;
      }
      if (src[j] === '(') return null;
      if (src[j] === ')') return { title: src.slice(i + 1, j), end: j + 1 };
      j++;
    }
    return null;
  }
  return null;
}

// Parse an inline link destination starting at the ( at src[i].
// Returns {href, title, end} or null.
function tryInlineLinkDest(src, i, n) {
  let p = skipInlineWS(src, i + 1, n);
  if (src[p] === ')') return { href: '', title: null, end: p + 1 };
  const d = parseDest(src, p, n);
  if (!d) return null;
  let j = d.end;
  let hadWS = false;
  while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) {
    j++;
    hadWS = true;
  }
  let title = null;
  if (hadWS && (src[j] === '"' || src[j] === "'" || src[j] === '(')) {
    const t = parseTitle(src, j, n);
    if (!t) return null;
    title = t.title;
    j = skipInlineWS(src, t.end, n);
  }
  if (src[j] !== ')') return null;
  return { href: d.dest, title, end: j + 1 };
}

// Does a parsed piece list contain a (non-image) link anywhere, including
// inside emphasis spans? A link whose text contains one is rejected, and
// the inner link wins instead. An image's alt text does not count.
function containsLink(pieces) {
  for (const p of pieces) {
    if (p.t === 'link') {
      if (!p.img) return true;
    } else if (p.t === 'e' && containsLink(p.ch)) {
      return true;
    }
  }
  return false;
}

// Marked's Be(): a < in the label that starts a tag or autolink running
// past the label's closing ] rejects the link.
function labelHasOpenTag(src, openIdx, closeIdx) {
  const text = src.slice(openIdx + 1, closeIdx);
  let s = 0;
  while (s < text.length) {
    const c = text[s];
    if (c === '\\') {
      s += 2;
      continue;
    }
    if (c === '`') {
      let m = s;
      while (m < text.length && text[m] === '`') m++;
      const run = m - s;
      let k = m;
      let found = -1;
      while (k < text.length) {
        if (text[k] === '`') {
          let p = k;
          while (p < text.length && text[p] === '`') p++;
          if (p - k === run) {
            found = p;
            break;
          }
          k = p;
        } else k++;
      }
      s = found >= 0 ? found : m;
      continue;
    }
    if (c !== '<') {
      s++;
      continue;
    }
    const srcPos = openIdx + 1 + s;
    const html = tryInlineHtml(src, srcPos);
    if (html) {
      if (html.end > closeIdx) return true;
      s += html.end - srcPos;
      continue;
    }
    const auto = tryAutolink(src, srcPos);
    if (auto) {
      if (auto.end > closeIdx) return true;
      s += auto.end - srcPos;
      continue;
    }
    s++;
  }
  return false;
}

// Try to read a link (or image) whose [ is at openIdx. Returns a link node
// or null when the text is not a link.
function tryLink(src, openIdx, refs, img) {
  const n = src.length;
  const closeIdx = findLinkEnd(src, openIdx, n);
  if (closeIdx < 0) return null;
  const text = src.slice(openIdx + 1, closeIdx);
  const after = closeIdx + 1;
  if (text.indexOf('<') >= 0 && labelHasOpenTag(src, openIdx, closeIdx)) return null;
  let href = null;
  let title = null;
  let end = -1;
  let fullRefMatched = false;
  if (src[after] === '(') {
    // Inline link; on failure fall back to the shortcut reference.
    const inl = tryInlineLinkDest(src, after, n);
    if (inl) {
      href = inl.href;
      title = inl.title;
      end = inl.end;
    }
  } else if (src[after] === '[') {
    // Full reference link: the label (le) has no nested [ and spans no
    // blank line. An empty second label means the text itself.
    let j = after + 1;
    let close2 = -1;
    while (j < n) {
      if (src[j] === '\\' && j + 1 < n) {
        j += 2;
        continue;
      }
      if (src[j] === '[') break;
      if (src[j] === '\n') {
        let q = j + 1;
        while (q < n && (src[q] === ' ' || src[q] === '\t')) q++;
        if (q >= n || src[q] === '\n') break;
        j++;
        continue;
      }
      if (src[j] === ']') {
        close2 = j;
        break;
      }
      j++;
    }
    if (close2 >= 0) {
      fullRefMatched = true;
      const labelRaw = src.slice(after + 1, close2);
      const key = normLabel(labelRaw === '' ? text : labelRaw);
      const ref = refs.get(key);
      if (ref) {
        href = ref.dest;
        title = ref.title;
        end = close2 + 1;
      }
    }
  }
  if (href === null && src[after] === '[' && fullRefMatched) {
    // A full reference that matched syntactically but whose label is not
    // defined does not fall back to the shortcut: the [ is literal text.
    return null;
  }
  if (href === null) {
    // Shortcut reference (also the fallback when an inline link fails).
    const ref = refs.get(normLabel(text));
    if (!ref) return null;
    href = ref.dest;
    title = ref.title;
    end = after;
  }
  const ch = parseInlinePieces(text, refs, true);
  if (!img && containsLink(ch)) return null;
  return { t: 'link', img, href: unescape(href), title: title === null ? null : unescape(title), text, end, ch };
}

// Try an autolink <scheme:...> or <email> at src[i]. Returns {href, text, end}.
function tryAutolink(src, i) {
  const n = src.length;
  let e = i + 1;
  while (e < n) {
    const c = src[e];
    if (c === '>' ) break;
    if (c === ' ' || c === '\t' || c === '\n' || c === '<' || c < ' ') return null;
    e++;
  }
  if (e >= n || src[e] !== '>') return null;
  const content = src.slice(i + 1, e);
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.exec(content);
  if (scheme) {
    return { href: content, text: content, end: e + 1 };
  }
  if (/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(content)) {
    return { href: 'mailto:' + content, text: content, end: e + 1 };
  }
  return null;
}

// Try a raw HTML tag, comment, processing instruction, declaration or CDATA
// section starting at src[i], following marked's St regex. Returns
// {s, end} or null.
function tryInlineHtml(src, i) {
  const n = src.length;
  if (src.startsWith('<!--', i)) {
    // <!--> and <!---> are complete comments on their own.
    if (src[i + 4] === '>') return { s: src.slice(i, i + 5), end: i + 5 };
    if (src[i + 4] === '-' && src[i + 5] === '>') return { s: src.slice(i, i + 6), end: i + 6 };
    const e = src.indexOf('-->', i + 4);
    if (e < 0) return null;
    return { s: src.slice(i, e + 3), end: e + 3 };
  }
  if (src.startsWith('<?', i)) {
    const e = src.indexOf('?>', i + 2);
    if (e < 0) return null;
    return { s: src.slice(i, e + 2), end: e + 2 };
  }
  if (src.startsWith('<![CDATA[', i)) {
    const e = src.indexOf(']]>', i + 9);
    if (e < 0) return null;
    return { s: src.slice(i, e + 3), end: e + 3 };
  }
  if (src.startsWith('<!', i) && i + 2 < n) {
    const c = src[i + 2];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
      // Declaration: <!LETTERS whitespace ... > (first > ends it).
      let j = i + 2;
      while (j < n && ((src[j] >= 'A' && src[j] <= 'Z') || (src[j] >= 'a' && src[j] <= 'z'))) j++;
      if (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) {
        const e = src.indexOf('>', j);
        if (e < 0) return null;
        return { s: src.slice(i, e + 1), end: e + 1 };
      }
    }
    return null;
  }
  let j = i + 1;
  let closing = false;
  if (src[j] === '/') {
    closing = true;
    j++;
  }
  if (j >= n) return null;
  const first = src[j];
  if (!((first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z'))) return null;
  // Tag name: a letter, then letters, digits and hyphens. A : or anything
  // else right after the name is not a tag.
  j++;
  while (j < n) {
    const c = src[j];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-') j++;
    else break;
  }
  if (closing) {
    // A closing tag takes only whitespace, then >.
    while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
    if (src[j] === '>') return { s: src.slice(i, j + 1), end: j + 1 };
    return null;
  }
  // Opening tag: each attribute needs whitespace before it, and the tag
  // ends with an optional / and >. Whitespace skipped after a valueless
  // attribute name is the separator for the next attribute, so it carries
  // into the next round.
  let pendingWS = 0;
  while (true) {
    let ws = pendingWS;
    pendingWS = 0;
    while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) {
      j++;
      ws++;
    }
    if (j >= n) return null;
    if (src[j] === '>') return { s: src.slice(i, j + 1), end: j + 1 };
    if (src[j] === '/' && src[j + 1] === '>') return { s: src.slice(i, j + 2), end: j + 2 };
    if (ws === 0) return null;
    // Attribute name.
    const a0 = src[j];
    if (!((a0 >= 'A' && a0 <= 'Z') || (a0 >= 'a' && a0 <= 'z') || a0 === '_' || a0 === ':')) return null;
    j++;
    while (j < n) {
      const c = src[j];
      if (
        (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
        c === '_' || c === ':' || c === '.' || c === '-'
      ) j++;
      else break;
    }
    let wsAfter = 0;
    while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) {
      j++;
      wsAfter++;
    }
    if (src[j] === '=') {
      j++;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
      if (src[j] === '"' || src[j] === "'") {
        const q = src[j];
        const e = src.indexOf(q, j + 1);
        if (e < 0) return null;
        j = e + 1;
      } else {
        let k = j;
        while (k < n) {
          const c = src[k];
          if (c === ' ' || c === '\t' || c === '\n' || c === '"' || c === "'" || c === '=' || c === '<' || c === '>' || c === '`') break;
          k++;
        }
        if (k === j) return null;
        j = k;
      }
    } else {
      pendingWS = wsAfter;
    }
  }
}

const EMAIL_LOCAL = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&\'*+/=?^_`{|}~-'.split(''));

// Try an extended autolink (www., http(s)/ftp URL, or email) starting at i.
// `prev` is the character before i ('' at the start).
// GFM autolink backpedal: keep a prefix of the URL, dropping a trailing
// run of punctuation, an unbalanced ), or a trailing &entity;.
const BACKPEDAL = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

// Scan a URL starting at i (up to whitespace or <), applying the backpedal
// until it stops changing. A > is part of the URL.
function scanUrl(src, i, n) {
  let j = i;
  while (j < n) {
    const c = src[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '<' || c < ' ') break;
    j++;
  }
  let url = src.slice(i, j);
  let prev;
  do {
    prev = url;
    const m = BACKPEDAL.exec(url);
    url = m ? m[0] : '';
  } while (url !== prev);
  return url;
}

// Scan an email address (marked's It) starting at i. Returns the end index
// or -1: local part, @, domain labels with at least one dot, the last label
// ending in an alphanumeric, and no word char or - after it.
function scanEmail(src, i, n) {
  let j = i;
  while (j < n) {
    const c = src[j];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '.' || c === '_' || c === '+' || c === '-') j++;
    else break;
  }
  if (j === i || src[j] !== '@') return -1;
  j++;
  let k = j;
  while (k < n) {
    const c = src[k];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-' || c === '_') k++;
    else break;
  }
  if (k === j) return -1;
  j = k;
  let dots = 0;
  while (src[j] === '.') {
    let m = j + 1;
    while (m < n) {
      const c = src[m];
      if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-' || c === '_') m++;
      else break;
    }
    if (m === j + 1) break;
    const last = src[m - 1];
    if (!((last >= 'a' && last <= 'z') || (last >= 'A' && last <= 'Z') || (last >= '0' && last <= '9'))) break;
    dots++;
    j = m;
  }
  if (dots === 0) return -1;
  const nx = src[j];
  if (nx !== undefined && ((nx >= 'a' && nx <= 'z') || (nx >= 'A' && nx <= 'Z') || (nx >= '0' && nx <= '9') || nx === '_' || nx === '-')) return -1;
  return j;
}

// Validate the host after www. or ://: one or more [A-Za-z0-9-]+ labels,
// each optionally followed by a dot. Returns the end index or -1.
function scanHost(src, i, n) {
  let j = i;
  let labels = 0;
  while (j < n) {
    const c = src[j];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-')) break;
    while (j < n) {
      const d = src[j];
      if ((d >= 'a' && d <= 'z') || (d >= 'A' && d <= 'Z') || (d >= '0' && d <= '9') || d === '-') j++;
      else break;
    }
    labels++;
    if (src[j] === '.') j++;
    else break;
  }
  return labels > 0 ? j : -1;
}

// Try an extended autolink (www., http(s)/ftp URL, mailto:/xmpp: address,
// or email) starting at i. `prev` is the character before i ('' at start).
function tryExtended(src, i, prev) {
  const n = src.length;
  // mailto: / xmpp: (At): a whole address; xmpp takes an optional /path.
  if (src.startsWith('mailto:', i)) {
    const e = scanEmail(src, i + 7, n);
    if (e >= 0) {
      const url = src.slice(i, e);
      return { t: 'auto', href: url, text: url, end: e };
    }
  }
  if (src.startsWith('xmpp:', i)) {
    const e = scanEmail(src, i + 5, n);
    if (e >= 0) {
      let end = e;
      if (src[end] === '/') {
        let m = end + 1;
        while (m < n) {
          const c = src[m];
          if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '@' || c === '.') m++;
          else break;
        }
        if (m > end + 1) end = m;
      }
      const url = src.slice(i, end);
      return { t: 'auto', href: url, text: url, end };
    }
  }
  // www. URL: only at a word boundary (start, whitespace, *, _, ~, or ().
  if (src.startsWith('www.', i)) {
    if (prev === '' || prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' || prev === '*' || prev === '_' || prev === '~' || prev === '(') {
      if (scanHost(src, i + 4, n) >= 0) {
        const url = scanUrl(src, i, n);
        if (url && url.length > 4) {
          return { t: 'auto', href: 'http://' + url, text: url, end: i + url.length };
        }
      }
    }
    return null;
  }
  // Scheme URL (the protocol is case-insensitive: Https:// counts).
  let scheme = null;
  const pfx = src.slice(i, i + 8).toLowerCase();
  if (pfx.startsWith('https://')) scheme = 8;
  else if (pfx.startsWith('http://')) scheme = 7;
  else if (pfx.startsWith('ftp://')) scheme = 6;
  if (scheme !== null) {
    if (scanHost(src, i + scheme, n) >= 0) {
      const url = scanUrl(src, i, n);
      if (url && url.length > scheme) {
        return { t: 'auto', href: url, text: url, end: i + url.length };
      }
    }
    return null;
  }
  // Email address: only at the start of a word.
  if (prev !== '' && EMAIL_LOCAL.has(prev)) return null;
  const e = scanEmail(src, i, n);
  if (e >= 0) {
    const email = src.slice(i, e);
    return { t: 'auto', href: 'mailto:' + email, text: email, end: e };
  }
  return null;
}

// Scan src into pieces, then resolve emphasis delimiters over them.
// When inLink is set (parsing a link's text), extended autolinks are
// suppressed and stay plain text; <...> autolinks and [...] links still
// parse, and a [...] link inside makes the outer link fail.
function parseInlinePieces(src, refs, inLink) {
  const pieces = [];
  let buf = '';
  const flush = () => {
    if (buf !== '') {
      pieces.push({ t: 't', s: buf });
      buf = '';
    }
  };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') {
        flush();
        pieces.push({ t: 'br' });
        i += 2;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) {
        // An escaped character is literal text that must never be
        // re-interpreted: \&ouml; is "&" followed by "ouml;", not an
        // entity, so it leaves the scanner already escaped.
        flush();
        pieces.push({ t: 'x', s: esc(nx), c: nx });
        i += 2;
        continue;
      }
      buf += '\\';
      i++;
      continue;
    }
    if (ch === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const run = j - i;
      let k = j;
      let found = -1;
      let foundEnd = 0;
      while (k < n) {
        if (src[k] === '`') {
          let m = k;
          while (m < n && src[m] === '`') m++;
          if (m - k === run) {
            found = k;
            foundEnd = m;
            break;
          }
          k = m;
        } else k++;
      }
      if (found >= 0) {
        flush();
        // Newlines become spaces first, then one leading and one trailing
        // space come off when both are present and the content is not all
        // spaces.
        let content = src.slice(j, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        pieces.push({ t: 'code', s: content });
        i = foundEnd;
        continue;
      }
      buf += src.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '\n') {
      let e = buf.length;
      let spaces = 0;
      while (e > 0 && (buf[e - 1] === ' ' || buf[e - 1] === '\t')) {
        if (buf[e - 1] === ' ') spaces++;
        e--;
      }
      if (spaces >= 2) {
        buf = buf.slice(0, e);
        flush();
        pieces.push({ t: 'br' });
        i++;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      buf += '\n';
      i++;
      continue;
    }
    if (ch === '!') {
      if (src[i + 1] === '[') {
        const link = tryLink(src, i + 1, refs, true);
        if (link) {
          flush();
          pieces.push(link);
          i = link.end;
          continue;
        }
      }
      buf += '!';
      i++;
      continue;
    }
    if (ch === '[') {
      const link = tryLink(src, i, refs, false);
      if (link) {
        flush();
        pieces.push(link);
        i = link.end;
        continue;
      }
      buf += '[';
      i++;
      continue;
    }
    if (ch === '<') {
      const auto = tryAutolink(src, i);
      if (auto) {
        flush();
        pieces.push({ t: 'auto', href: auto.href, text: auto.text });
        i = auto.end;
        continue;
      }
      const html = tryInlineHtml(src, i);
      if (html) {
        flush();
        pieces.push({ t: 'html', s: html.s });
        i = html.end;
        continue;
      }
      buf += '<';
      i++;
      continue;
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      let j = i;
      while (j < n && src[j] === ch) j++;
      const run = j - i;
      if (ch === '~' && run > 2) {
        buf += src.slice(i, j);
        i = j;
        continue;
      }
      const prev = i > 0 ? src[i - 1] : '';
      const next = j < n ? src[j] : '';
      const prevWS = prev === '' || isWS(prev);
      const nextWS = next === '' || isWS(next);
      const prevP = prev !== '' && isPunct(prev);
      const nextP = next !== '' && isPunct(next);
      const leftF = !nextWS && (!nextP || prevWS || prevP);
      const rightF = !prevWS && (!prevP || nextWS || nextP);
      let canOpen;
      let canClose;
      if (ch === '_') {
        canOpen = leftF && (!rightF || prevP);
        canClose = rightF && (!leftF || nextP);
      } else {
        canOpen = leftF;
        canClose = rightF;
      }
      flush();
      pieces.push({ t: 'd', c: ch, n: run, open: canOpen, close: canClose, dead: false });
      i = j;
      continue;
    }
    // Extended autolinks: www., scheme URLs and email addresses. Not
    // inside a link's text (marked's inLink state suppresses them there).
    // The boundary char is the last character of the text already emitted,
    // not the raw previous source char: a * _ or ~ already consumed as a
    // delimiter is a word boundary, not part of an email's local part.
    if (!inLink && (ch === 'w' || ch === 'h' || ch === 'f' || EMAIL_LOCAL.has(ch))) {
      let prev = '';
      if (buf !== '') prev = buf[buf.length - 1];
      else if (pieces.length) {
        const lp = pieces[pieces.length - 1];
        if (lp.t === 't' && lp.s !== '') prev = lp.s[lp.s.length - 1];
        else if (lp.t === 'x') prev = lp.c;
      }
      const ext = tryExtended(src, i, prev);
      if (ext) {
        flush();
        pieces.push(ext);
        i = ext.end;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  processEmphasis(pieces);
  return pieces;
}

function firstCharOf(p) {
  if (p.t === 't' || p.t === 'code' || p.t === 'html') return p.s.length ? p.s[0] : '';
  if (p.t === 'x') return p.c;
  if (p.t === 'd') return p.c;
  if (p.t === 'br') return '\n';
  if (p.t === 'auto') return p.text.length ? p.text[0] : '';
  if (p.t === 'link') return p.ch.length ? firstCharOf(p.ch[0]) : '';
  if (p.t === 'e') return p.ch.length ? firstCharOf(p.ch[0]) : '';
  return '';
}

function lastCharOf(p) {
  if (p.t === 't' || p.t === 'code' || p.t === 'html') return p.s.length ? p.s[p.s.length - 1] : '';
  if (p.t === 'x') return p.c;
  if (p.t === 'd') return p.c;
  if (p.t === 'br') return '\n';
  if (p.t === 'auto') return p.text.length ? p.text[p.text.length - 1] : '';
  if (p.t === 'link') return p.ch.length ? lastCharOf(p.ch[p.ch.length - 1]) : '';
  if (p.t === 'e') return p.ch.length ? lastCharOf(p.ch[p.ch.length - 1]) : '';
  return '';
}

// CommonMark delimiter-stack emphasis resolution over a flat piece list.
// A closer that is only partly consumed by a match is re-processed against
// earlier openers before moving on, so runs like ****foo**** nest fully.
function processEmphasis(pieces) {
  const delims = [];
  for (const p of pieces) if (p.t === 'd') delims.push(p);
  let ci = 0;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (closer.dead || !closer.close || closer.n <= 0) {
      ci++;
      continue;
    }
    let oi = ci - 1;
    let opener = null;
    while (oi >= 0) {
      const op = delims[oi];
      if (!op.dead && op.n > 0 && op.open && op.c === closer.c) {
        const eitherBoth = (op.open && op.close) || (closer.open && closer.close);
        if (eitherBoth && (op.n + closer.n) % 3 === 0 && !(op.n % 3 === 0 && closer.n % 3 === 0)) {
          oi--;
          continue;
        }
        if (closer.c === '~' && op.n !== closer.n) {
          oi--;
          continue;
        }
        opener = op;
        break;
      }
      oi--;
    }
    if (!opener) {
      ci++;
      continue;
    }
    const opIdx = pieces.indexOf(opener);
    const clIdx = pieces.indexOf(closer);
    if (opIdx < 0 || clIdx < 0 || clIdx <= opIdx) continue;
    if (closer.c === '~') {
      const first = pieces[opIdx + 1];
      const last = pieces[clIdx - 1];
      if (!first || !last) continue;
      const fc = firstCharOf(first);
      const lc = lastCharOf(last);
      if (fc === ' ' || fc === '\t' || fc === '\n' || lc === ' ' || lc === '\t' || lc === '\n') continue;
    }
    let use = 1;
    if (closer.c === '~') use = closer.n;
    else if (opener.n >= 2 && closer.n >= 2) use = 2;
    const tag = closer.c === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    const inner = pieces.slice(opIdx + 1, clIdx);
    // Marked re-tokenizes an emphasis span's text on its own: a delimiter
    // at the span's edge is flanked by the span boundary, not by the
    // wrapper's delimiter (so _x_ at the end of ~~...~~ still closes).
    // Fix up the edge delimiters, resolve the inside, and only then mark
    // any leftover delimiters dead so they cannot leak across the wrapper.
    if (inner.length) {
      const first = inner[0];
      if (first.t === 'd') reDelim(first, '', inner.length > 1 ? firstCharOf(inner[1]) : '');
      const last = inner[inner.length - 1];
      if (last.t === 'd') reDelim(last, inner.length > 1 ? lastCharOf(inner[inner.length - 2]) : '', '');
      processEmphasis(inner);
    }
    // Delimiters swallowed by the new node stop being candidates.
    for (let k = oi + 1; k < ci; k++) delims[k].dead = true;
    const wrapper = { t: 'e', tag, ch: inner };
    opener.n -= use;
    closer.n -= use;
    const replacement = [];
    if (opener.n > 0) replacement.push(opener);
    replacement.push(wrapper);
    if (closer.n > 0) replacement.push(closer);
    pieces.splice(opIdx, clIdx - opIdx + 1, ...replacement);
    // A partly consumed closer is re-processed against earlier openers;
    // only an exhausted closer moves the scan on.
    if (closer.n <= 0) ci++;
  }
}

// Recompute a delimiter piece's open/close flags from its neighbours.
function reDelim(p, prevCh, nextCh) {
  const prevWS = prevCh === '' || isWS(prevCh);
  const nextWS = nextCh === '' || isWS(nextCh);
  const prevP = prevCh !== '' && isPunct(prevCh);
  const nextP = nextCh !== '' && isPunct(nextCh);
  const leftF = !nextWS && (!nextP || prevWS || prevP);
  const rightF = !prevWS && (!prevP || nextWS || nextP);
  if (p.c === '_') {
    p.open = leftF && (!rightF || prevP);
    p.close = rightF && (!leftF || nextP);
  } else {
    p.open = leftF;
    p.close = rightF;
  }
}
// dropped, raw HTML is escaped, everything else keeps its text.
function plainText(pieces) {
  let out = '';
  for (const p of pieces) {
    if (p.t === 't') out += escNoEnc(p.s);
    else if (p.t === 'x') out += p.s;
    else if (p.t === 'd') out += p.c.repeat(p.n);
    else if (p.t === 'code') out += escNoEnc(p.s);
    else if (p.t === 'br') out += '\n';
    else if (p.t === 'html') out += escNoEnc(p.s);
    else if (p.t === 'auto') out += escNoEnc(p.text);
    else if (p.t === 'link') out += plainText(p.ch);
    else if (p.t === 'e') out += plainText(p.ch);
  }
  return out;
}

function renderPieces(pieces) {
  let out = '';
  for (const p of pieces) {
    if (p.t === 't') out += escText(p.s);
    else if (p.t === 'x') out += p.s;
    else if (p.t === 'd') out += p.c.repeat(p.n);
    else if (p.t === 'code') out += '<code>' + esc(p.s) + '</code>';
    else if (p.t === 'br') out += '<br>';
    else if (p.t === 'html') out += p.s;
    else if (p.t === 'auto') {
      out += '<a href="' + escNoEnc(cleanUrl(p.href)) + '">' + escText(p.text) + '</a>';
    } else if (p.t === 'link') {
      const href = escNoEnc(cleanUrl(p.href));
      const title = p.title === null ? '' : ' title="' + escNoEnc(p.title) + '"';
      if (p.img) {
        out += '<img src="' + href + '" alt="' + plainText(p.ch) + '"' + title + '>';
      } else {
        out += '<a href="' + href + '"' + title + '>' + renderPieces(p.ch) + '</a>';
      }
    } else if (p.t === 'e') {
      out += '<' + p.tag + '>' + renderPieces(p.ch) + '</' + p.tag + '>';
    }
  }
  return out;
}

// Fast path: a leaf with no inline specials at all is just escaped text.
// Any of * _ ~ ` [ ! \ < & @, a www. or :// autolink trigger, or a hard
// break (2+ spaces before a newline) sends it through the full scanner.
const PLAIN_RE = /[*_~`\[!\\<&@]|www\.|:\/\/|  +\n/;
function inline(src, refs) {
  if (!PLAIN_RE.test(src)) return esc(src);
  return renderPieces(parseInlinePieces(src, refs));
}

// ---------------------------------------------------------------------------
// Block rendering.

function renderNodes(nodes, ctx) {
  let out = '';
  for (const node of nodes) out += renderNode(node, ctx);
  return out;
}

function renderNode(node, ctx) {
  switch (node.t) {
    case 'p':
      return '<p>' + inline(node.raw, ctx.refs) + '</p>\n';
    case 'h':
      return '<h' + node.lv + '>' + inline(node.raw, ctx.refs) + '</h' + node.lv + '>\n';
    case 'code': {
      const lang = node.lang === null ? '' : ' class="language-' + escNoEnc(node.lang) + '"';
      // The stored text has no trailing newline for fences and one for
      // indented code; render with exactly one: strip one, add one.
      const body = node.text === '' ? '' : node.text.replace(/\n$/, '') + '\n';
      return '<pre><code' + lang + '>' + esc(body) + '</code></pre>\n';
    }
    case 'html':
      return node.text;
    case 'hr':
      return '<hr>\n';
    case 'bq':
      return '<blockquote>\n' + renderNodes(node.ch, ctx) + '</blockquote>\n';
    case 'list': {
      const open = node.ord
        ? '<ol' + (node.start !== 1 ? ' start="' + node.start + '"' : '') + '>\n'
        : '<ul>\n';
      let out = open;
      for (const item of node.items) out += renderListItem(item, node.loose, ctx);
      out += node.ord ? '</ol>\n' : '</ul>\n';
      return out;
    }
    case 'table': {
      const alignAttr = (a) => (a === 1 ? ' align="left"' : a === 2 ? ' align="center"' : a === 3 ? ' align="right"' : '');
      let out = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < node.head.length; k++) {
        out += '<th' + alignAttr(node.align[k] || 0) + '>' + inline(node.head[k], ctx.refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length === 0) {
        out += '</table>\n';
        return out;
      }
      out += '<tbody>';
      for (const row of node.rows) {
        out += '<tr>\n';
        for (let k = 0; k < node.head.length; k++) {
          const cell = k < row.length ? row[k] : '';
          out += '<td' + alignAttr(node.align[k] || 0) + '>' + inline(cell, ctx.refs) + '</td>\n';
        }
        out += '</tr>\n';
      }
      out += '</tbody></table>\n';
      return out;
    }
    default:
      return '';
  }
}

function renderListItem(children, loose, ctx) {
  let out = '<li>';
  for (let k = 0; k < children.length; k++) {
    const child = children[k];
    if (child.t === 'p') {
      if (loose) {
        out += k === 0 ? renderTaskParagraphLoose(child, ctx) : renderNode(child, ctx);
      } else if (k === 0) {
        out += renderTaskParagraph(child, ctx);
      } else {
        out += inline(child.raw, ctx.refs);
      }
    } else {
      out += renderNode(child, ctx);
    }
  }
  out += '</li>\n';
  return out;
}

// A paragraph that starts a list item: a leading [ ] / [x] / [X] followed by
// spaces and more text becomes a checkbox; otherwise it renders as usual.
function taskPrefix(raw) {
  if (raw.length < 4 || raw[0] !== '[') return null;
  const c = raw[1];
  if (c !== ' ' && c !== 'x' && c !== 'X') return null;
  if (raw[2] !== ']') return null;
  let p = 3;
  while (p < raw.length && (raw[p] === ' ' || raw[p] === '\t')) p++;
  if (p === 3 || p >= raw.length) return null;
  return { checked: c === 'x' || c === 'X', rest: raw.slice(p) };
}

function renderTaskParagraph(child, ctx) {
  const task = taskPrefix(child.raw);
  if (!task) return inline(child.raw, ctx.refs);
  const box = task.checked
    ? '<input checked="" disabled="" type="checkbox">'
    : '<input disabled="" type="checkbox">';
  return box + ' ' + inline(task.rest, ctx.refs);
}

function renderTaskParagraphLoose(child, ctx) {
  const task = taskPrefix(child.raw);
  if (!task) return '<p>' + inline(child.raw, ctx.refs) + '</p>\n';
  const box = task.checked
    ? '<input checked="" disabled="" type="checkbox">'
    : '<input disabled="" type="checkbox">';
  return '<p>' + box + ' ' + inline(task.rest, ctx.refs) + '</p>\n';
}

// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  // A trailing newline is a line terminator, not an extra blank line.
  if (src.endsWith('\n')) lines.pop();
  const ctx = { refs: new Map(), endsWithNL: src.endsWith('\n') };
  const nodes = parseBlocks(lines, 0, lines.length, ctx, true, undefined, true);
  return renderNodes(nodes, ctx);
}
