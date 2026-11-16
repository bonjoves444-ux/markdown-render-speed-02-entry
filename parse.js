// A credited fork of marked 18.1.3, tuned to render faster.
//
// marked itself is vendored untouched under vendor/marked/ (MIT, see
// vendor/marked/LICENSE and vendor/marked/NOTICE) and stays the
// reference for every byte of output: this module only changes how
// the work is done, never what comes out. The block lexer is marked's
// own, driven through a tokenizer that skips each block rule with one
// cheap look at the first characters when that rule cannot match, and
// the list rule is re-implemented as a small character scanner that
// walks lines instead of re-running a regex per line. Inline text is
// tokenized by a single left-to-right pass that hands every piece of
// real markup to marked's own inline tokenizers, and only the
// emphasis and strikethrough closers are searched by hand, using the
// same closer tables marked precomputes. Anything the fast path is
// unsure about falls back to marked.parse for the whole document, so
// a doubtful input is rendered slowly and correctly, never wrongly.

import { Lexer, Parser, Tokenizer, marked } from './vendor/marked/marked.esm.js';

// ------------------------------------------------------------------
// Small character helpers. A character is classed the way the
// reference's Unicode classes class it: 0 is a word character (not
// space, not punctuation or symbol), 1 is whitespace, 2 is
// punctuation or a symbol. The tilde, asterisk and underscore are
// punctuation here, exactly as \p{P} and \p{S} see them.
// ------------------------------------------------------------------

const PUNCT_SYMBOL = /[\p{P}\p{S}]/u;
const WHITE_SPACE = /\s/;
const ALPHA_NUMERIC = /[\p{L}\p{N}]/u;

const ASCII_KIND = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  const ch = String.fromCharCode(c);
  ASCII_KIND[c] = WHITE_SPACE.test(ch) ? 1 : PUNCT_SYMBOL.test(ch) ? 2 : 0;
}

function codePointAt(s, i) {
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return (c - 0xd800) * 0x400 + (d - 0xdc00) + 0x10000;
  }
  return c;
}

function codePointLen(cp) {
  return cp > 0xffff ? 2 : 1;
}

// Kind of the code point starting at index i of s.
function kindAt(s, i) {
  const c = s.charCodeAt(i);
  if (c < 128) return ASCII_KIND[c];
  const ch = String.fromCodePoint(codePointAt(s, i));
  return WHITE_SPACE.test(ch) ? 1 : PUNCT_SYMBOL.test(ch) ? 2 : 0;
}

function isPunctStr(ch) {
  if (ch === '') return false;
  if (ch === '*' || ch === '_') return false;
  return PUNCT_SYMBOL.test(ch) || WHITE_SPACE.test(ch);
}

// ------------------------------------------------------------------
// Entity decoding. Only numeric character references are decoded;
// a bare ampersand that starts no valid reference becomes &amp;.
// Text with no numeric reference at all is returned untouched, so a
// lone & in ordinary prose is left for the renderer to escape.
// ------------------------------------------------------------------

const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeEntities(text) {
  if (!NUMERIC_REF.test(text)) return text;
  return text.replace(NUMERIC_REF_OR_AMP, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    return String.fromCodePoint(cp);
  });
}

// ------------------------------------------------------------------
// Reference-label normalisation: trim, collapse runs of whitespace
// to one space, lowercase.
// ------------------------------------------------------------------

const MULTI_SPACE = /\s+/g;

function normLabel(label) {
  return label.trim().replace(MULTI_SPACE, ' ').toLowerCase();
}

// ------------------------------------------------------------------
// Closer tables. For a masked inline source, remember the last
// delimiter run that could close something: a run of * or _ whose
// preceding character is not blank, and the last such run of ~.
// ------------------------------------------------------------------

function closerIndexes(masked) {
  const star = { '*': -1, '_': -1 };
  let tilde = -1;
  let found = 0;
  const n = masked.length;
  let s = n - 1;
  while (s >= 0 && found !== 7) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') {
      s--;
      continue;
    }
    // Walk back to the start of this run.
    let start = s;
    while (start > 0 && masked[start - 1] === r) start--;
    const before = start === 0 ? '\n' : masked[start - 1];
    if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r' && before !== '\f') {
      if (r === '~') {
        if (tilde === -1) {
          tilde = start;
          found |= 4;
        }
      } else if (star[r] === -1) {
        star[r] = start;
        found |= r === '*' ? 1 : 2;
      }
    }
    s = start - 1;
  }
  return { star, tilde };
}

// ------------------------------------------------------------------
// Masked source. Emphasis scanning must not see delimiters that sit
// inside a link, a reference label, a code span or a tag, and must
// not treat an escaped punctuation mark as punctuation. This
// rewrites those stretches in place, keeping every length, so the
// masked text lines up with the real one character for character:
// reference labels and link destinations become runs of a, escaped
// punctuation becomes runs of +, code spans keep their backticks
// with any backtick inside turned to +, and whole links, code spans
// and tags become bracketed runs of a.
// ------------------------------------------------------------------

function maskText(src, links, rules, linkInText) {
  let out = src;
  if (links && src.includes('[')) {
    const search = rules.inline.reflinkSearch;
    const fix = (m) => {
      const o = m.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(m.slice(o + 1, -1)))) return m;
      if (o > 1 && m.charAt(0) !== '!') {
        const inner = m.slice(1, o - 1);
        if (linkInText(inner)) {
          return '[' + inner.replace(search, fix) + '][' + 'a'.repeat(m.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m.length - 2) + ']';
    };
    out = out.replace(search, fix);
  }
  // The next two passes only have anything to do when the text
  // holds a backslash, a backtick, a bracket or an angle bracket;
  // plain prose skips both scans entirely.
  if (out.includes('\\') || out.includes('`')) {
    out = out.replace(rules.inline.anyPunctuationOutsideCode, (m, ticks, escaped) => {
      if (escaped !== undefined) return '+'.repeat(m.length);
      if (ticks !== undefined) return ticks + m.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks;
      return m;
    });
  }
  if (out.includes('[') || out.includes('`') || out.includes('<')) {
    out = out.replace(rules.inline.blockSkip, (m, _a, empty) => {
      const kept = empty ? empty.length : 0;
      return m.slice(0, kept) + '[' + 'a'.repeat(m.length - kept - 2) + ']';
    });
  }
  return out;
}

// ------------------------------------------------------------------
// Closer groups. A candidate closer is a delimiter run with a
// character before it and one after it; which group it belongs to
// depends on the kinds of those two neighbours, exactly as the
// reference's closer patterns decide. kind 0 is a word character,
// 1 is whitespace, 2 is punctuation or a symbol, -1 is the end of
// the text. Returns the group number, or 0 when the run is not a
// closer at all.
// ------------------------------------------------------------------

function closerGroup(kind, r, prevStr, prevKind, runLen, nextStr, nextKind, atEnd) {
  const nextIsSpaceOrEnd = atEnd || nextKind === 1;
  if (kind === 'ast') {
    const prevPunctNotStarTilde = prevKind === 2 && prevStr !== '*' && prevStr !== '~';
    const prevWordOrTilde = prevKind === 0 || prevStr === '~';
    const prevSpaceOrPunctNotStarTilde =
      (prevKind === 1 || prevKind === 2) && prevStr !== '*' && prevStr !== '~';
    const nextPunctNotTilde = nextKind === 2 && nextStr !== '~';
    const nextWordOrTilde = nextKind === 0 || nextStr === '~';
    if (prevPunctNotStarTilde && nextIsSpaceOrEnd) return 1;
    if (prevWordOrTilde && (nextPunctNotTilde || nextIsSpaceOrEnd)) return 2;
    if (prevSpaceOrPunctNotStarTilde && nextWordOrTilde) return 3;
    if (prevKind === 1 && nextPunctNotTilde) return 4;
    if (prevPunctNotStarTilde && nextPunctNotTilde) return 5;
    if (prevWordOrTilde && nextWordOrTilde) return 6;
    return 0;
  }
  if (kind === 'und') {
    const prevPunctNotUnd = prevKind === 2 && prevStr !== '_';
    const prevSpaceOrPunctNotUnd = (prevKind === 1 || prevKind === 2) && prevStr !== '_';
    if (prevPunctNotUnd && nextIsSpaceOrEnd) return 1;
    if (prevKind === 0 && (nextKind === 1 || nextKind === 2 || atEnd)) return 2;
    if (prevSpaceOrPunctNotUnd && nextKind === 0) return 3;
    if (prevKind === 1 && nextKind === 2) return 4;
    if (prevPunctNotUnd && nextKind === 2) return 5;
    return 0;
  }
  // Strikethrough: a closer run is one or two tildes, never more.
  if (runLen > 2) return 0;
  const prevPunctNotTilde = prevKind === 2 && prevStr !== '~';
  const prevSpaceOrPunctNotTilde = (prevKind === 1 || prevKind === 2) && prevStr !== '~';
  if (prevPunctNotTilde && nextIsSpaceOrEnd) return 1;
  if (prevKind === 0 && (nextKind === 1 || nextKind === 2 || atEnd)) return 2;
  if (prevSpaceOrPunctNotTilde && nextKind === 0) return 3;
  if (prevKind === 1 && nextKind === 2) return 4;
  if (prevPunctNotTilde && nextKind === 2) return 5;
  if (prevKind === 0 && nextKind === 0) return 6;
  return 0;
}

// ------------------------------------------------------------------
// The anchored skip at the head of the emphasis closer search: for
// * it is a stretch with no * or _ that holds __, then a *, then
// __ again; for _ the same shape with ** and _. It can only match
// at the very start of the remaining text, and it consumes up to
// the final doubled delimiter. Returns the end index, or -1.
// ------------------------------------------------------------------

function skipTriplePrefix(masked, start, r) {
  const other = r === '*' ? '_' : '*';
  const mid = r === '*' ? '*' : '_';
  const n = masked.length;
  let p = start;
  while (p < n && masked[p] !== '*' && masked[p] !== '_') p++;
  if (p + 1 >= n || masked[p] !== other || masked[p + 1] !== other) return -1;
  p += 2;
  while (p < n && masked[p] !== '*' && masked[p] !== '_') p++;
  if (p >= n || masked[p] !== mid) return -1;
  p += 1;
  while (p < n && masked[p] !== '*' && masked[p] !== '_') p++;
  if (p + 1 >= n || masked[p] !== other || masked[p + 1] !== other) return -1;
  return p;
}

// ------------------------------------------------------------------
// The inline pass. Stock marked tokenizes inline text by trying a
// dozen patterns at every position; this pass does the same work
// with one dispatch on the character in front of it, and hands
// every piece of real markup to marked's own inline tokenizers, so
// the tokens it produces are identical by construction. Only the
// emphasis and strikethrough closers are searched by hand.
// ------------------------------------------------------------------

class FastLexer extends Lexer {
  inlineTokens(src, tokens = []) {
    this.tokenizer.lexer = this;
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(')');
    try {
      return this.scanInline(src, tokens);
    } finally {
      this.state.linkParenPossible = saved;
    }
  }

  // The masked source for one inline pass, with its closer tables.
  // Built lazily, on the first emphasis or strikethrough attempt.
  maskFor(src) {
    const masked = maskText(
      src,
      this.tokens.links,
      this.tokenizer.rules,
      (s) => this.linkInText(s),
    );
    return { src, masked, closer: closerIndexes(masked) };
  }

  // Search the masked text for the next closer candidate at or
  // after slice offset `from` (the slice starts at Q in the full
  // text) and no further than the bound ee. A candidate is a
  // delimiter run with a character before it; plain stretches of
  // text are stepped over, leaving their last character, exactly
  // as the reference's skip alternative does. Returns null, or
  // { j, te, b, group, end } with j the match start in slice
  // coordinates, te the length of the character before the run,
  // b the run length, group the closer group, and end the match
  // end in slice coordinates.
  scanCloser(cx, r, Q, ee, table, from = 0) {
    const masked = cx.masked;
    const sliceLen = masked.length - Q;
    let j = from;
    if (j === 0 && table !== 'del') {
      const end = skipTriplePrefix(masked, Q, r);
      if (end >= 0) j = end - Q;
    }
    while (j < sliceLen) {
      if (j > ee) return null;
      const ch = masked[Q + j];
      if (ch === r) {
        // No closer can start inside a delimiter run; jump past it.
        let rl = 0;
        while (Q + j + rl < masked.length && masked[Q + j + rl] === r) rl++;
        j += rl;
        continue;
      }
      // Step over a stretch of ordinary text, leaving its last
      // character behind, so the candidate there is still tried.
      let k2 = j;
      while (k2 < sliceLen && masked[Q + k2] !== r) k2++;
      if (k2 - 1 > j) {
        j = k2 - 1;
        continue;
      }
      // Candidate: the code point at j, then a run of r.
      const prevCp = codePointAt(masked, Q + j);
      const prevLen = codePointLen(prevCp);
      const prevStr = String.fromCodePoint(prevCp);
      const runStart = Q + j + prevLen;
      if (runStart >= masked.length || masked[runStart] !== r) {
        j++;
        continue;
      }
      let runLen = 0;
      while (runStart + runLen < masked.length && masked[runStart + runLen] === r) runLen++;
      const afterIdx = runStart + runLen;
      const nextCp = afterIdx < masked.length ? codePointAt(masked, afterIdx) : -1;
      const nextStr = nextCp === -1 ? '' : String.fromCodePoint(nextCp);
      const nextKind = nextCp === -1 ? -1 : kindAt(masked, afterIdx);
      const prevKind = kindAt(masked, Q + j);
      const group = closerGroup(
        table,
        r,
        prevStr,
        prevKind,
        runLen,
        nextStr,
        nextKind,
        afterIdx >= masked.length,
      );
      if (group === 0) {
        j++;
        continue;
      }
      return { j, te: prevLen, b: runLen, group, end: j + prevLen + runLen };
    }
    return null;
  }

  // Emphasis or strong at position pos of cx.src. prevCh is the
  // last character of the previous text token, or ''. Returns the
  // token, or null when this run cannot open one.
  emStrongAt(cx, pos, prevCh) {
    const src = cx.src;
    const masked = cx.masked;
    const r = src[pos];
    // Opening delimiter: a run of r, then one more character.
    let run = 0;
    while (pos + run < src.length && src[pos + run] === r) run++;
    const afterIdx = pos + run;
    let g1 = '';
    let g2 = '';
    let g3 = '';
    let g4 = '';
    if (afterIdx < src.length) {
      const cp = codePointAt(src, afterIdx);
      const ch = String.fromCodePoint(cp);
      const kind = kindAt(src, afterIdx);
      if (r === '*') {
        if (kind === 2 && ch !== '*' && ch !== '~') g1 = ch;
        else if (kind !== 1 && ch !== '*') g2 = ch;
      } else {
        if (kind === 2 && ch !== '_' && ch !== '~') g3 = ch;
        else if (kind !== 1 && ch !== '_') g4 = ch;
      }
    }
    // A run followed by a blank or the end of the text opens nothing.
    if (!g1 && !g2 && !g3 && !g4) return null;
    const k = run;
    const i = pos;
    // Walk back over any delimiter run that ends where this one
    // starts; the character before that run is what the flanking
    // rules look at.
    let l = i;
    while (l > 0 && masked[l - 1] === r) l--;
    let p = '';
    if (l > 0) {
      const c1 = masked.charCodeAt(l - 1);
      if (c1 >= 0xdc00 && c1 <= 0xdfff && l >= 2) {
        const c0 = masked.charCodeAt(l - 2);
        p = c0 >= 0xd800 && c0 <= 0xdbff ? masked.slice(l - 2, l) : masked[l - 1];
      } else {
        p = masked[l - 1];
      }
    }
    const h = p === '*' || p === '_' || isPunctStr(p);
    let n = prevCh;
    if (l < i) n = p;
    const u = l < i ? h : isPunctStr(n);
    // An underscore opener may not sit inside a word.
    if (g4 && ALPHA_NUMERIC.test(n)) return null;
    const d = g1 || g3 || '';
    if (d && n && !u) return null;
    const o = prevCh === r;
    const y = i - l + k;
    const R = p.trim() !== '' && (d !== '' || (r === '*' && !h));
    const v = cx.closer.star[r];
    const Q = i + k;
    if (v < Q) return null;
    const ee = v - Q;
    const table = r === '*' ? 'ast' : 'und';
    let m = k;
    let f = 0;
    let cand = this.scanCloser(cx, r, Q, ee, table);
    while (cand) {
      const { j, te, b, group, end } = cand;
      const next = () => this.scanCloser(cx, r, Q, ee, table, end);
      if (group === 3 || group === 4) {
        m += b;
        cand = next();
        continue;
      }
      if (group === 5 || group === 6 || R) {
        if (o && (group === 5 || group === 6)) return null;
        if (y % 3 !== 0 && (y + b) % 3 === 0) {
          f += b;
          cand = next();
          continue;
        }
      }
      m -= b;
      if (m > 0) {
        cand = next();
        continue;
      }
      const bb = Math.min(b, b + m + f);
      const rawLen = k + j + te + bb;
      const raw = src.slice(pos, pos + rawLen);
      const odd = Math.min(k, bb) % 2 === 1;
      const inner = odd ? raw.slice(1, -1) : raw.slice(2, -2);
      return {
        type: odd ? 'em' : 'strong',
        raw,
        text: inner,
        tokens: this.inlineTokens(inner),
      };
    }
    return null;
  }

  // Strikethrough at position pos of cx.src. Returns the token,
  // or null when this run cannot open one.
  delAt(cx, pos, prevCh) {
    const src = cx.src;
    let run = 0;
    while (pos + run < src.length && src[pos + run] === '~') run++;
    if (run < 1 || run > 2) return null;
    const afterIdx = pos + run;
    if (afterIdx >= src.length) return null;
    const cp = codePointAt(src, afterIdx);
    const ch = String.fromCodePoint(cp);
    const kind = kindAt(src, afterIdx);
    if (kind === 1 || ch === '~') return null;
    const g1 = kind === 2 ? ch : '';
    if (g1 && prevCh && !isPunctStr(prevCh)) return null;
    const o = run;
    const u = cx.closer.tilde;
    const d = pos + o;
    if (u < d) return null;
    const ee = u - d;
    let p = o;
    let cand = this.scanCloser(cx, '~', d, ee, 'del');
    while (cand) {
      const { j, te, b, group, end } = cand;
      const next = () => this.scanCloser(cx, '~', d, ee, 'del', end);
      // The closer run must be exactly as long as the opener.
      if (b !== o) {
        cand = next();
        continue;
      }
      if (group === 3 || group === 4) {
        p += b;
        cand = next();
        continue;
      }
      p -= b;
      if (p > 0) {
        cand = next();
        continue;
      }
      const bb = Math.min(b, b + p);
      const rawLen = o + j + te + bb;
      const raw = src.slice(pos, pos + rawLen);
      const inner = raw.slice(o, -o);
      return { type: 'del', raw, text: inner, tokens: this.inlineTokens(inner) };
    }
    return null;
  }

  // One left-to-right pass over an inline source. The dispatch is
  // by the character in front: only the tokenizers that can start
  // there are tried, in the reference's order. A failed reference
  // link that yields text is merged into the previous text token,
  // and adjacent text tokens are merged, exactly as the reference
  // does. A URL is only tried outside a link.
  scanInline(src, out) {
    const tz = this.tokenizer;
    const links = this.tokens.links;
    const len = src.length;
    let pos = 0;
    let prevText = false;
    let r = '';
    let cx = null;
    const mask = () => (cx ??= this.maskFor(src));
    while (pos < len) {
      if (!prevText) r = '';
      prevText = false;
      const startPos = pos;
      const ch = src[pos];
      let tok = null;
      if (ch === '\\') {
        tok = tz.escape(src.slice(pos));
        if (!tok && src[pos + 1] === '\n') tok = tz.br(src.slice(pos));
      } else if (ch === '<') {
        tok = tz.tag(src.slice(pos)) || tz.autolink(src.slice(pos));
      } else if (ch === '[' || ch === '!') {
        tok = tz.link(src.slice(pos));
        if (!tok) {
          const rt = tz.reflink(src.slice(pos), links);
          if (rt) {
            if (rt.type === 'text') {
              const prev = out[out.length - 1];
              if (prev && prev.type === 'text') {
                prev.raw += rt.raw;
                prev.text += rt.text;
              } else out.push(rt);
            } else out.push(rt);
            pos += rt.raw.length;
            continue;
          }
        }
      } else if (ch === '*' || ch === '_') {
        tok = this.emStrongAt(mask(), pos, r);
      } else if (ch === '`') {
        tok = tz.codespan(src.slice(pos));
      } else if (ch === '~') {
        tok = this.delAt(mask(), pos, r);
      } else if (ch === ' ' && src[pos + 1] === ' ') {
        tok = tz.br(src.slice(pos));
      } else if (
        !this.state.inLink &&
        ((ch >= 'a' && ch <= 'z') ||
          (ch >= 'A' && ch <= 'Z') ||
          (ch >= '0' && ch <= '9') ||
          ch === '.' ||
          ch === '_' ||
          ch === '+' ||
          ch === '-')
      ) {
        tok = tz.url(src.slice(pos));
      }
      if (tok) {
        pos += tok.raw.length;
        out.push(tok);
        continue;
      }
      const tt = tz.inlineText(src.slice(pos));
      if (!tt || tt.raw.length === 0) throw new Error('inline text made no progress');
      if (tt.raw.charCodeAt(tt.raw.length - 1) !== 95) r = tt.raw.slice(-1);
      prevText = true;
      const prev = out[out.length - 1];
      if (prev && prev.type === 'text') {
        prev.raw += tt.raw;
        prev.text += tt.text;
      } else out.push(tt);
      pos += tt.raw.length;
      if (pos === startPos) throw new Error('inline pass made no progress');
    }
    return out;
  }
}
// ------------------------------------------------------------------
// Fast text-run scanner. It returns the end index of the text run
// starting at pos, following the stock GFM inline.text regex's stop
// rules exactly (markup starters, URL starts, e-mail starts, hard
// breaks, and the mailto lead-in). Replacing the regex with a
// character scan avoids the regex engine's cost on long prose runs.
// ------------------------------------------------------------------

// The character set that may appear in an e-mail local part (the
// set the text regex uses for its e-mail stop).
function isEmailCharCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 33 || code === 35 || code === 36 || code === 37 ||
    code === 38 || code === 39 || code === 42 || code === 43 ||
    code === 45 || code === 46 || code === 47 || code === 61 ||
    code === 63 || code === 95 || code === 96 || code === 123 ||
    code === 124 || code === 125 || code === 126;
}

function isAlnumCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122);
}

function startsWithAt(src, pos, s) {
  if (pos + s.length > src.length) return false;
  for (let k = 0; k < s.length; k++) {
    if (src.charCodeAt(pos + k) !== s.charCodeAt(k)) return false;
  }
  return true;
}

// True when an e-mail local part followed by '@' starts at i.
function emailStartsAt(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && isEmailCharCode(src.charCodeAt(j))) j++;
  return j > i && j < n && src.charCodeAt(j) === 64;
}

// True when 2+ spaces followed by a newline start at i.
function twoSpacesNewlineAt(src, i) {
  const n = src.length;
  if (i + 1 >= n || src.charCodeAt(i) !== 32 || src.charCodeAt(i + 1) !== 32) return false;
  let j = i + 2;
  while (j < n && src.charCodeAt(j) === 32) j++;
  return j < n && src.charCodeAt(j) === 10;
}

// End index (exclusive) of the text run starting at pos.
function textRunEnd(src, pos) {
  const n = src.length;
  if (pos >= n) return pos;
  const c0 = src.charCodeAt(pos);
  // Alternative A: a single non-alphanumeric character before a
  // mailto:/xmpp: link.
  if (!isAlnumCode(c0) &&
      (startsWithAt(src, pos + 1, 'mailto:') || startsWithAt(src, pos + 1, 'xmpp:'))) {
    return pos + 1;
  }
  // First character group: a run of backticks, a run of tildes, or
  // a single other character.
  let i = pos;
  if (c0 === 96 || c0 === 126) {
    while (i < n && src.charCodeAt(i) === c0) i++;
  } else {
    i++;
  }
  // Immediate stops right after the first group.
  if (i < n) {
    const c = src.charCodeAt(i);
    if (c === 96 || c === 126) return i;
    if (twoSpacesNewlineAt(src, i)) return i;
    if (emailStartsAt(src, i)) return i;
  }
  // Lazy scan.
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    // Markup starters: \ < ! [ ` * ~ _
    if (c === 92 || c === 60 || c === 33 || c === 91 || c === 96 || c === 42 || c === 126 || c === 95) return j;
    // http/https (bare, case-insensitive).
    if ((c === 104 || c === 72) && j + 3 < n) {
      const c1 = src.charCodeAt(j + 1), c2 = src.charCodeAt(j + 2), c3 = src.charCodeAt(j + 3);
      if ((c1 === 116 || c1 === 84) && (c2 === 116 || c2 === 84) && (c3 === 112 || c3 === 80)) return j;
    }
    // ftp:// (case-insensitive).
    if ((c === 102 || c === 70) && j + 5 < n) {
      const c1 = src.charCodeAt(j + 1), c2 = src.charCodeAt(j + 2), c3 = src.charCodeAt(j + 3);
      const c4 = src.charCodeAt(j + 4), c5 = src.charCodeAt(j + 5);
      if ((c1 === 116 || c1 === 84) && (c2 === 112 || c2 === 80) && c3 === 58 && c4 === 47 && c5 === 47) return j;
    }
    // www. with its lookbehind: the preceding character must be
    // whitespace, *, _, ~, ( or the start of the text run.
    if ((c === 119 || c === 87) && j + 3 < n) {
      const c1 = src.charCodeAt(j + 1), c2 = src.charCodeAt(j + 2), c3 = src.charCodeAt(j + 3);
      if ((c1 === 119 || c1 === 87) && (c2 === 119 || c2 === 87) && c3 === 46) {
        if (j === pos) return j;
        const pc = src.charCodeAt(j - 1);
        if (pc === 32 || pc === 9 || pc === 10 || pc === 13 || pc === 12 || pc === 11 ||
            pc === 42 || pc === 95 || pc === 126 || pc === 40) return j;
      }
    }
    // Hard break: a non-space character followed by 2+ spaces and \n.
    if (c !== 32 && j + 2 < n && src.charCodeAt(j + 1) === 32 && src.charCodeAt(j + 2) === 32) {
      let k = j + 3;
      while (k < n && src.charCodeAt(k) === 32) k++;
      if (k < n && src.charCodeAt(k) === 10) return j + 1;
    }
    // mailto:/xmpp: lead-in: a non-alphanumeric character followed
    // by the scheme.
    if (!isAlnumCode(c) && j + 1 < n) {
      const nc = src.charCodeAt(j + 1);
      if (nc === 109 || nc === 120) {
        if (startsWithAt(src, j + 1, 'mailto:') || startsWithAt(src, j + 1, 'xmpp:')) return j + 1;
      }
    }
    // E-mail: an '@' whose local part starts inside this run.
    if (c === 64) {
      let s = j - 1;
      while (s >= pos && isEmailCharCode(src.charCodeAt(s))) s--;
      const runStart = s + 1;
      if (runStart < j && runStart > pos) return runStart;
    }
    j++;
  }
  return n;
}

// ------------------------------------------------------------------
// Line helpers for the block rules. A line is a slice of the
// source without its trailing newline; helpers take (src, start,
// end) and work with indexes so no line is ever copied.
// ------------------------------------------------------------------

// Index just past the newline ending the line that starts at pos,
// or src.length when the line is the last one.
function lineEnd(src, pos) {
  const nl = src.indexOf('\n', pos);
  return nl === -1 ? src.length : nl;
}

// Expand tabs the way the reference does: a tab advances the
// column to the next multiple of four, starting from column
// `start`, so a second tab in the same stretch counts from where
// the first one landed.
function expandTabs(text, start = 0) {
  let out = '';
  let col = start;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Does a table start at pos? The first line must hold a non-space
// character after up to three spaces, and the second line must be
// a delimiter row: up to three spaces, then only | - : and spaces,
// holding at least one -.
function tableStartsHere(src, pos) {
  let i = pos;
  let spaces = 0;
  while (spaces < 3 && src[i] === ' ') { i++; spaces++; }
  const end1 = lineEnd(src, pos);
  if (i >= end1) return false;
  let j = end1;
  if (src[j] !== '\n') return false;
  j++;
  let k = j;
  let sp = 0;
  while (sp < 3 && src[k] === ' ') { k++; sp++; }
  const end2 = lineEnd(src, j);
  if (end2 <= k) return false;
  let hasDash = false;
  for (let t = k; t < end2; t++) {
    const c = src[t];
    if (c === '-') hasDash = true;
    else if (c !== '|' && c !== ':' && c !== ' ') return false;
  }
  return hasDash;
}

// Is there a setext underline row ahead? Scan the lines after
// the first: the first line that is an underline row (up to three
// spaces, a run of = or -, spaces or tabs, then the end of the
// line) means the reference's setext rule may match. A blank line
// first means it cannot, since a setext heading's text cannot
// cross a blank line. Other lines are passed over: being
// permissive here only costs a call to the reference's rule,
// which then decides.
function setextRowAhead(src, pos) {
  let j = lineEnd(src, pos);
  if (j === pos) return false;
  while (j < src.length) {
    if (src[j] !== '\n') return false;
    j++;
    const end = lineEnd(src, j);
    if (isUnderlineRow(src, j, end)) return true;
    if (blankLineRange(src, j, end)) return false;
    j = end;
  }
  return false;
}

// One underline row: up to three spaces, a run of = or -, then
// only spaces or tabs to the end of the line.
function isUnderlineRow(src, start, end) {
  let k = start;
  let sp = 0;
  while (sp < 3 && src[k] === ' ') { k++; sp++; }
  const c = src[k];
  if (c !== '=' && c !== '-') return false;
  let t = k;
  while (src[t] === c) t++;
  while (src[t] === ' ' || src[t] === '\t') t++;
  return t >= end;
}

// A range of only spaces and tabs, or empty.
function blankLineRange(src, start, end) {
  for (let i = start; i < end; i++) {
    if (src[i] !== ' ' && src[i] !== '\t') return false;
  }
  return true;
}

// ------------------------------------------------------------------
// The per-line break tests the list rule uses. Each takes the line
// as (src, start, end) and the most spaces the line may be indented
// by, which is clamp(R - 1, 0, 3) for a content indent R.
// ------------------------------------------------------------------

// An hr line: up to maxSpaces spaces, then three or more of the
// same - _ * with spaces or tabs between, then the end of the line.
function lineIsHr(src, start, end, maxSpaces) {
  let i = start;
  let sp = 0;
  while (sp < maxSpaces && src[i] === ' ') { i++; sp++; }
  const c = src[i];
  if (c !== '-' && c !== '_' && c !== '*') return false;
  let count = 0;
  while (i < end) {
    if (src[i] === c) { count++; i++; }
    else if (src[i] === ' ' || src[i] === '\t') i++;
    else return false;
  }
  return count >= 3;
}

// A fenced-code opening: up to maxSpaces spaces, then ``` or ~~~.
function lineIsFences(src, start, end, maxSpaces) {
  let i = start;
  let sp = 0;
  while (sp < maxSpaces && src[i] === ' ') { i++; sp++; }
  const c = src[i];
  if (c !== '`' && c !== '~') return false;
  return src[i + 1] === c && src[i + 2] === c;
}

// An ATX heading: up to maxSpaces spaces, one to six #, then
// whitespace or the end of the line.
function lineIsHeading(src, start, end, maxSpaces) {
  let i = start;
  let sp = 0;
  while (sp < maxSpaces && src[i] === ' ') { i++; sp++; }
  let n = 0;
  while (n < 6 && src[i + n] === '#') n++;
  if (n === 0) return false;
  if (src[i + n] === '#') return false;
  if (i + n >= end) return true;
  return /\s/.test(src[i + n]);
}

// A blockquote opening: up to maxSpaces spaces, then >.
function lineIsBlockquote(src, start, end, maxSpaces) {
  let i = start;
  let sp = 0;
  while (sp < maxSpaces && src[i] === ' ') { i++; sp++; }
  return src[i] === '>';
}

const BLOCK_TAG_SET = new Set(
  'address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul'.split(' '),
);

// A block-HTML opening at the line: up to maxSpaces spaces, then
// < starting a block tag (case-insensitive, followed by spaces,
// the end of the line, or /> or >), a script/pre/style/textarea
// tag (followed by whitespace, > or the end), a comment, a
// processing instruction, a declaration, or a CDATA section.
function lineIsHtml(src, start, end, maxSpaces) {
  let i = start;
  let sp = 0;
  while (sp < maxSpaces && src[i] === ' ') { i++; sp++; }
  if (src[i] !== '<') return false;
  const c1 = src[i + 1];
  if (c1 === '!') {
    if (src[i + 2] === '-' && src[i + 3] === '-') return true;
    if (src[i + 2] === '[') return src.slice(i + 3, i + 9) === 'CDATA[';
    const c2 = src[i + 2];
    return (c2 >= 'A' && c2 <= 'Z') || (c2 >= 'a' && c2 <= 'z');
  }
  if (c1 === '?') return true;
  let j = i + 1;
  let slash = false;
  if (src[j] === '/') { slash = true; j++; }
  let nameEnd = j;
  while (nameEnd < end) {
    const c = src[nameEnd];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-') nameEnd++;
    else break;
  }
  if (nameEnd === j) return false;
  const name = src.slice(j, nameEnd).toLowerCase();
  if (!slash && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) {
    if (nameEnd >= end) return true;
    const c = src[nameEnd];
    return c === '>' || /\s/.test(c);
  }
  const isBlock =
    BLOCK_TAG_SET.has(name) ||
    (name.length === 2 && name[0] === 'h' && name[1] >= '1' && name[1] <= '6');
  if (!isBlock) return false;
  if (nameEnd >= end) return true;
  const c = src[nameEnd];
  if (c === ' ') return true;
  if (c === '>') return true;
  if (c === '/' && src[nameEnd + 1] === '>') return true;
  return false;
}

// A line of only spaces and tabs, or empty.
function blankLineText(f) {
  for (let i = 0; i < f.length; i++) {
    if (f[i] !== ' ' && f[i] !== '\t') return false;
  }
  return true;
}

// Does the text end with two blank lines (a newline, optional
// spaces and tabs, another newline, optional spaces and tabs)?
function endsWithDoubleBlank(a) {
  let i = a.length;
  while (i > 0 && (a[i - 1] === ' ' || a[i - 1] === '\t')) i--;
  if (i === 0 || a[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (a[i - 1] === ' ' || a[i - 1] === '\t')) i--;
  if (i === 0 || a[i - 1] !== '\n') return false;
  return true;
}

// The index of the first non-space character in m when every
// tab is counted as four spaces, or -1 when m holds only spaces
// and tabs.
function firstNonSpaceExpanded4(m) {
  let col = 0;
  for (let i = 0; i < m.length; i++) {
    const c = m[i];
    if (c === ' ') col++;
    else if (c === '\t') col += 4;
    else return col;
  }
  return -1;
}

const SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;

// ------------------------------------------------------------------
// The block tokenizer. Each rule first looks at the first
// characters and bows out when the rule cannot match, so the
// reference's regular expressions only run for lines that could
// actually be that block. The list rule is re-implemented as a
// character scanner that walks lines instead of re-running a
// pattern per line; paragraph and text stay with the reference.
// ------------------------------------------------------------------

class FastTokenizer extends Tokenizer {
  space(src) {
    const c = src.charCodeAt(0);
    if (c !== 32 && c !== 9 && c !== 10) return undefined;
    return super.space(src);
  }

  code(src) {
    let i = 0;
    while (i < 4 && src.charCodeAt(i) === 32) i++;
    if (i === 4) return super.code(src);
    if (src.charCodeAt(i) === 9) return super.code(src);
    return undefined;
  }

  fences(src) {
    let i = 0;
    while (i < 3 && src.charCodeAt(i) === 32) i++;
    const c = src.charCodeAt(i);
    if (c !== 96 && c !== 126) return undefined;
    if (src.charCodeAt(i + 1) !== c || src.charCodeAt(i + 2) !== c) return undefined;
    return super.fences(src);
  }

  heading(src) {
    let i = 0;
    while (i < 3 && src.charCodeAt(i) === 32) i++;
    if (src.charCodeAt(i) !== 35) return undefined;
    return super.heading(src);
  }

  hr(src) {
    let i = 0;
    while (i < 3 && src.charCodeAt(i) === 32) i++;
    const c = src.charCodeAt(i);
    if (c !== 45 && c !== 95 && c !== 42) return undefined;
    return super.hr(src);
  }

  blockquote(src) {
    let i = 0;
    while (i < 3 && src.charCodeAt(i) === 32) i++;
    if (src.charCodeAt(i) !== 62) return undefined;
    return super.blockquote(src);
  }

  html(src) {
    let i = 0;
    while (i < 3 && src.charCodeAt(i) === 32) i++;
    if (src.charCodeAt(i) !== 60) return undefined;
    return super.html(src);
  }

  def(src) {
    let i = 0;
    while (i < 3 && src.charCodeAt(i) === 32) i++;
    if (src.charCodeAt(i) !== 91) return undefined;
    return super.def(src);
  }

  table(src) {
    if (!tableStartsHere(src, 0)) return undefined;
    return super.table(src);
  }

  lheading(src) {
    if (!setextRowAhead(src, 0)) return undefined;
    return super.lheading(src);
  }

  list(src) {
    if (this.options.pedantic) return super.list(src);
    return this.listPort(src);
  }

  // A bullet at the start of the line beginning at `pos`,
  // allowing up to `maxSpaces` leading spaces. `want` constrains
  // the bullet to match an earlier one: the same character for an
  // unordered list, the same terminator for an ordered one.
  // Returns null, or { bulletEnd, ordered, ch, term }.
  matchBullet(src, pos, maxSpaces, want) {
    let i = pos;
    let sp = 0;
    while (sp < maxSpaces && src[i] === ' ') { i++; sp++; }
    const c = src[i];
    if (c === '*' || c === '+' || c === '-') {
      if (want && (want.ordered || want.ch !== c)) return null;
      return { bulletEnd: i + 1, ordered: false, ch: c, term: '' };
    }
    if (c >= '0' && c <= '9') {
      let j = i;
      let digits = 0;
      while (digits < 9 && src[j] >= '0' && src[j] <= '9') { j++; digits++; }
      const term = src[j];
      if (term !== '.' && term !== ')') return null;
      if (want && (!want.ordered || want.term !== term)) return null;
      return { bulletEnd: j + 1, ordered: true, ch: '', term };
    }
    return null;
  }

  // The list rule, walked line by line with character scans
  // instead of a pattern per line. Phase one works purely on the
  // source string and computes each item's raw text, text and
  // task flag; phase two tokenizes the items with the reference's
  // block lexer and handles task checkboxes exactly as the
  // reference does.
  listPort(src) {
    const other = this.rules.other;
    const len = src.length;
    const first = this.matchBullet(src, 0, 3, null);
    if (!first) return undefined;
    const bulletText = src.slice(0, first.bulletEnd).trim();
    const ordered = bulletText.length > 1;
    const start = ordered ? +bulletText.slice(0, -1) : '';
    const want = { ordered, ch: first.ch, term: first.term };
    const items = [];
    let loose = false;
    let p = false;
    let pos = 0;
    while (pos < len) {
      const itemStart = pos;
      const it = this.matchBullet(src, pos, 3, want);
      if (!it) break;
      const lineStop0 = lineEnd(src, pos);
      if (lineIsHr(src, pos, lineStop0, 3)) break;
      // Consume the first line: indent, bullet, content, newline.
      const b = it.bulletEnd - pos;
      const end1 = lineStop0;
      let g = '';
      if (it.bulletEnd < end1) {
        const c = src[it.bulletEnd];
        if (c !== ' ' && c !== '\t') break;
        g = src.slice(it.bulletEnd, end1);
      }
      let nextPos = end1;
      if (nextPos < len && src[nextPos] === '\n') nextPos++;
      // The first line's content, its leading whitespace expanded.
      let m = g.replace(other.leadingSpaceTab, (v) => expandTabs(v, b));
      let f = nextPos < len ? src.slice(nextPos, lineEnd(src, nextPos)) : '';
      let y = !m.trim();
      let R = 0;
      let d = '';
      if (y) {
        R = b + 1;
      } else {
        R = m.search(other.nonSpaceChar);
        if (R > 4) R = 1;
        d = m.slice(R);
        R += b;
      }
      // An empty item: blank first-line content and a blank next line.
      let u = false;
      if (y && blankLineText(f)) {
        nextPos += f.length + 1;
        if (nextPos > len) nextPos = len;
        u = true;
      }
      pos = nextPos;
      if (!u) {
        const maxSp = Math.max(0, Math.min(3, R - 1));
        while (pos < len) {
          const lineStart = pos;
          const lineStop = lineEnd(src, pos);
          // The line's leading whitespace run, and how long it is
          // once its tabs are expanded.
          let leadEnd = lineStart;
          let leadHasTab = false;
          while (leadEnd < lineStop && (src[leadEnd] === ' ' || src[leadEnd] === '\t')) {
            if (src[leadEnd] === '\t') leadHasTab = true;
            leadEnd++;
          }
          const leadLen = leadEnd - lineStart;
          let expandedLead = null;
          let expandedLeadLen = leadLen;
          if (leadHasTab) {
            expandedLead = expandTabs(src.slice(lineStart, leadEnd), 0);
            expandedLeadLen = expandedLead.length;
          }
          const firstNonSpace = leadEnd < lineStop ? expandedLeadLen : -1;
          const isBlank = leadEnd === lineStop;
          const nb = this.matchBullet(src, lineStart, maxSp, null);
          const isNextBullet =
            nb !== null &&
            (nb.bulletEnd >= lineStop || src[nb.bulletEnd] === ' ' || src[nb.bulletEnd] === '\t');
          if (
            lineIsFences(src, lineStart, lineStop, maxSp) ||
            lineIsHeading(src, lineStart, lineStop, maxSp) ||
            lineIsHtml(src, lineStart, lineStop, maxSp) ||
            lineIsBlockquote(src, lineStart, lineStop, maxSp) ||
            isNextBullet ||
            lineIsHr(src, lineStart, lineStop, maxSp)
          ) break;
          // The line's content dedented by R: with no tab in the
          // leading run it is just the line from offset R.
          let zslice;
          if (!leadHasTab) zslice = src.slice(lineStart + R, lineStop);
          else if (R <= expandedLeadLen) zslice = expandedLead.slice(R) + src.slice(leadEnd, lineStop);
          else zslice = src.slice(leadEnd + (R - expandedLeadLen), lineStop);
          if (firstNonSpace >= R || isBlank) {
            d += '\n' + zslice;
          } else {
            if (
              y ||
              firstNonSpaceExpanded4(m) >= 4 ||
              lineIsFences(m, 0, m.length, maxSp) ||
              lineIsHeading(m, 0, m.length, maxSp) ||
              lineIsHtml(m, 0, m.length, maxSp) ||
              lineIsHr(m, 0, m.length, maxSp)
            ) break;
            const fLine = src.slice(lineStart, lineStop);
            let qe = fLine;
            if (SETEXT_LINE.test(fLine) && this.rules.block.lheading.test(m + '\n' + fLine)) {
              const zFull = leadHasTab ? expandedLead + src.slice(leadEnd, lineStop) : fLine;
              qe = '    ' + zFull.replace(/^ {0,3}/, '');
            }
            d += '\n' + qe;
          }
          y = isBlank;
          pos = lineStop < len && src[lineStop] === '\n' ? lineStop + 1 : len;
          m = zslice;
        }
      }
      const A = src.slice(itemStart, pos);
      if (!loose) {
        if (p) loose = true;
        else if (endsWithDoubleBlank(A)) p = true;
      }
      items.push({
        type: 'list_item',
        raw: A,
        task: !!this.options.gfm && other.listIsTask.test(d),
        loose: false,
        text: d,
        tokens: [],
      });
    }
    const last = items[items.length - 1];
    if (!last) return undefined;
    last.raw = last.raw.trimEnd();
    last.text = last.text.trimEnd();
    const raw = src.slice(0, pos).trimEnd();
    for (const item of items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        const k = spaces.length > 0 && spaces.some((t) => other.anyLine.test(t.raw));
        loose = k;
      }
    }
    for (const item of items) {
      const d0 = item.tokens[0];
      if (item.task && (d0?.type === 'text' || d0?.type === 'paragraph')) {
        item.text = item.text.replace(other.listReplaceTask, '');
        d0.raw = d0.raw.replace(other.listReplaceTask, '');
        d0.text = d0.text.replace(other.listReplaceTask, '');
        for (let gi = this.lexer.inlineQueue.length - 1; gi >= 0; gi--) {
          if (other.listIsTask.test(this.lexer.inlineQueue[gi].src)) {
            this.lexer.inlineQueue[gi].src = this.lexer.inlineQueue[gi].src.replace(
              other.listReplaceTask,
              '',
            );
            break;
          }
        }
        const kk = other.listTaskCheckbox.exec(item.raw);
        if (kk) {
          const g = { type: 'checkbox', raw: kk[0] + ' ', checked: kk[0] !== '[ ]' };
          item.checked = g.checked;
          if (loose) {
            if (
              item.tokens[0] &&
              ['paragraph', 'text'].includes(item.tokens[0].type) &&
              'tokens' in item.tokens[0] &&
              item.tokens[0].tokens
            ) {
              item.tokens[0].raw = g.raw + item.tokens[0].raw;
              item.tokens[0].text = g.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(g);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: g.raw, text: g.raw, tokens: [g] });
            }
          } else {
            item.tokens.unshift(g);
          }
        }
      } else if (item.task) item.task = false;
    }
    if (loose) {
      for (const item of items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return { type: 'list', raw, ordered, start, loose, items };
  }
}

// ------------------------------------------------------------------
// The entry point. A fresh lexer and parser per call, with the
// fast tokenizer and the fast inline pass, under the reference's
// default options. Any doubt at all — a throw anywhere in the
// fast path — renders the whole document with marked itself, so
// the output is always the reference's output, only sometimes
// slower. Nothing is kept between calls.
// ------------------------------------------------------------------

const DEFAULTS = { async: false, breaks: false, gfm: true, pedantic: false };

export function parse(markdown) {
  try {
    const lexer = new FastLexer({ ...DEFAULTS, tokenizer: new FastTokenizer() });
    const tokens = lexer.lex(markdown);
    const parser = new Parser({ ...DEFAULTS });
    return parser.parse(tokens);
  } catch {
    return marked.parse(markdown);
  }
}
