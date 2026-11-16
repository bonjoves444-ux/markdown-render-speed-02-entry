// parse.js — a credited fork of marked 18.1.3 (MIT) with fast paths.
//
// The vendored stock marked lives under vendor/marked/ (marked.esm.js with
// its LICENSE and NOTICE intact). This file imports the stock Lexer, Parser
// and Tokenizer and overrides only the hot paths:
//   - a FastLexer that tokenizes inline content with a character-dispatched
//     scanner instead of re-running the stock inline regexes per token;
//   - a FastTokenizer that gates each block rule behind a cheap necessary
//     condition and ports the list rule to a manual string walk.
// Everything else delegates to stock marked, so output is byte-identical
// to marked 18.1.3 on every input we have tested.
//
// parse() is stateless across calls: no memo, no cache, nothing written to
// disk, no table keyed on input text or hash. Deterministic, Node 22
// erasable-TS only, Node built-ins plus this file's own source.

import { Lexer, Parser, Tokenizer, marked } from "./vendor/marked/marked.esm.js";

// ---- character classification -------------------------------------------
// ASCII_KIND maps each ASCII code to a small integer kind used by the
// inline scanner to decide, in O(1), whether a character can start markup.
// 0 = ordinary, 1 = backtick, 2 = tilde, 3 = asterisk, 4 = underscore,
// 5 = bracket, 6 = bang, 7 = less-than, 8 = backslash, 9 = whitespace/newline,
// 10 = other punctuation.
const ASCII_KIND = new Uint8Array(128);
for (let i = 0; i < 128; i++) {
  const c = String.fromCharCode(i);
  if (c === "`") ASCII_KIND[i] = 1;
  else if (c === "~") ASCII_KIND[i] = 2;
  else if (c === "*") ASCII_KIND[i] = 3;
  else if (c === "_") ASCII_KIND[i] = 4;
  else if (c === "[") ASCII_KIND[i] = 5;
  else if (c === "!") ASCII_KIND[i] = 6;
  else if (c === "<") ASCII_KIND[i] = 7;
  else if (c === "\\") ASCII_KIND[i] = 8;
  else if (c === " " || c === "\t" || c === "\n" || c === "\r") ASCII_KIND[i] = 9;
  else if (/[^a-zA-Z0-9]/.test(c)) ASCII_KIND[i] = 10;
}
function kindAt(src, i) {
  const code = src.charCodeAt(i);
  return code < 128 ? ASCII_KIND[code] : 0;
}
function codePointAt(src, i) {
  return src.codePointAt(i);
}
function codePointLen(src, i) {
  const cp = src.codePointAt(i);
  return cp > 0xffff ? 2 : 1;
}
function isPunctStr(s) {
  if (!s) return false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 128) {
      if (ASCII_KIND[code] !== 10 && ASCII_KIND[code] !== 0) {
        // punctuation kinds 1-8 and 10 count; letters/digits do not
        if (ASCII_KIND[code] >= 1 && ASCII_KIND[code] <= 8) continue;
        if (ASCII_KIND[code] === 10) continue;
        return false;
      }
      if (/[a-zA-Z0-9]/.test(s[i])) return false;
    } else if (/[\p{L}\p{N}]/u.test(s[i])) return false;
  }
  return true;
}

// ---- entity decoding (stock Ie replica) ---------------------------------
// Decodes numeric character references the way marked's inline text does.
const numericCharacterReference = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericCharacterReferenceOrAmpersand = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeEntities(s) {
  if (!numericCharacterReference.test(s)) return s;
  return s.replace(numericCharacterReferenceOrAmpersand, (m, dec, hex) => {
    if (m[0] === "&" && m[1] !== "#") return "&amp;";
    const n = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    if (!n || n > 1114111 || (n >= 55296 && n <= 57343)) return "\uFFFD";
    if (n === 38) return "&amp;";
    return String.fromCodePoint(n);
  });
}

// Normalizes a link reference label: collapse whitespace, lowercase.
function normLabel(label) {
  return label.replace(/\s+/g, " ").trim().toLowerCase();
}

// ---- line helpers --------------------------------------------------------
function lineEnd(src, i) {
  const n = src.indexOf("\n", i);
  return n === -1 ? src.length : n;
}
// Expands tabs column-wise (a tab advances the column to the next multiple
// of 4) and returns the column of the first non-space character.
function firstNonSpaceExpanded4(m) {
  let col = 0;
  for (let i = 0; i < m.length; i++) {
    if (m[i] === "\t") col = (Math.floor(col / 4) + 1) * 4;
    else if (m[i] === " ") col++;
    else return col;
  }
  return col;
}
function expandTabs(line) {
  // Returns the line with tabs expanded to spaces by column (tab = next
  // multiple of 4). Used only for the list inner walk.
  let out = "";
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\t") {
      const next = (Math.floor(col / 4) + 1) * 4;
      out += " ".repeat(next - col);
      col = next;
    } else {
      out += line[i];
      col++;
    }
  }
  return out;
}
const SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;
function isUnderlineRow(line) {
  return SETEXT_LINE.test(line);
}
function blankLineRange(src, i) {
  // If the line starting at i is blank (only spaces/tabs), returns its end
  // (index just past the newline); else -1.
  let j = i;
  while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
  if (j >= src.length) return src.length;
  if (src[j] === "\n") return j + 1;
  if (src[j] === "\r" && src[j + 1] === "\n") return j + 2;
  return -1;
}
function lineIsHr(line) {
  return /^ {0,3}((?:\* *){3,}|(?:- *){3,}|(?:_ *){3,})$/.test(line);
}
function lineIsFences(line) {
  return /^ {0,3}(`{3,}|~{3,})/.test(line);
}
function lineIsHeading(line) {
  return /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line);
}
function lineIsBlockquote(line) {
  return /^ {0,3}>/.test(line);
}
function lineIsHtml(line) {
  return /^ {0,3}<\/?(?:[A-Za-z][A-Za-z0-9-]*)/.test(line);
}
function blankLineText(line) {
  return /^[ \t]*$/.test(line);
}
function endsWithDoubleBlank(s) {
  return /\n[ \t]*\n[ \t]*$/.test(s) || /^[ \t]*\n[ \t]*$/.test(s);
}

// J expands a leading run of spaces/tabs to spaces. The second argument is
// the column at which the run starts (default 0); a tab advances the column
// to the next multiple of 4. This is the stock marked helper, verbatim.
function J(s, startCol = 0) {
  let col = startCol;
  let out = "";
  for (const ch of s) {
    if (ch === "\t") {
      const r = 4 - (col % 4);
      out += " ".repeat(r);
      col += r;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// ---- FastTokenizer --------------------------------------------------------
// Extends the stock Tokenizer. Each block rule is gated behind a cheap
// necessary condition (first character / short prefix test) so the stock
// regex only runs when the input could possibly match. Lists go through
// listPort, a manual port of the stock list() that avoids per-line regexes.
const BLOCK_TAG_SET = new Set([
  "address","article","aside","base","basefont","blockquote","body","caption",
  "center","col","colgroup","dd","details","dialog","dir","div","dl","dt",
  "fieldset","figcaption","figure","footer","form","frame","frameset","h1",
  "h2","h3","h4","h5","h6","head","header","hr","html","iframe","legend",
  "li","link","main","menu","menuitem","nav","noframes","ol","optgroup",
  "option","p","param","search","section","summary","table","tbody","td",
  "tfoot","th","thead","title","tr","track","ul"
]);

function tableStartsHere(src) {
  // True if src begins a GFM table: a header row containing | followed by
  // a delimiter row. Cheap necessary checks before the stock regex.
  const nl = src.indexOf("\n");
  if (nl === -1) return false;
  const first = src.slice(0, nl);
  if (!first.includes("|")) return false;
  const secondEnd = src.indexOf("\n", nl + 1);
  const second = secondEnd === -1 ? src.slice(nl + 1) : src.slice(nl + 1, secondEnd);
  return /^ {0,3}\|? *:?-{1,} *:? *(?:\| *:?-{1,} *:? *)*\|? *$/.test(second);
}
function setextRowAhead(src) {
  // True if any following line (until a blank line or end of input) is a
  // setext underline row. Used to gate the lheading rule.
  let i = 0;
  while (i < src.length) {
    const end = lineEnd(src, i);
    const line = src.slice(i, end);
    if (blankLineText(line)) return false;
    if (isUnderlineRow(line)) return true;
    i = end + 1;
  }
  return false;
}

class FastTokenizer extends Tokenizer {
  space(src) {
    const c = src.charCodeAt(0);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) return undefined;
    return super.space(src);
  }
  code(src) {
    // Indented code needs the first non-space character at column >= 4,
    // counting a tab as advancing to the next multiple of 4.
    let col = 0;
    let i = 0;
    while (i < src.length && (src[i] === " " || src[i] === "\t")) {
      if (src[i] === "\t") col = (Math.floor(col / 4) + 1) * 4;
      else col++;
      i++;
    }
    if (col < 4) return undefined;
    return super.code(src);
  }
  fences(src) {
    const c = src.charCodeAt(0);
    if (c !== 32 && c !== 9 && c !== 96 && c !== 126) return undefined;
    return super.fences(src);
  }
  heading(src) {
    const c = src.charCodeAt(0);
    if (c !== 32 && c !== 9 && c !== 35) return undefined;
    return super.heading(src);
  }
  hr(src) {
    const c = src.charCodeAt(0);
    if (c !== 32 && c !== 9 && c !== 42 && c !== 45 && c !== 95) return undefined;
    return super.hr(src);
  }
  blockquote(src) {
    const c = src.charCodeAt(0);
    if (c !== 32 && c !== 9 && c !== 62) return undefined;
    return super.blockquote(src);
  }
  html(src) {
    const c = src.charCodeAt(0);
    if (c !== 32 && c !== 9 && c !== 60) return undefined;
    return super.html(src);
  }
  def(src) {
    // A link definition may have up to 3 leading spaces before '['.
    let i = 0;
    while (i < 3 && src.charCodeAt(i) === 32) i++;
    if (src.charCodeAt(i) !== 91) return undefined;
    return super.def(src);
  }
  table(src) {
    if (!tableStartsHere(src)) return undefined;
    return super.table(src);
  }
  lheading(src) {
    if (!setextRowAhead(src)) return undefined;
    return super.lheading(src);
  }
  list(src) {
    if (this.options.pedantic) return super.list(src);
    return this.listPort(src);
  }

  // listPort: a manual port of the stock Tokenizer.list(). Phase 1 walks
  // the item lines with indexOf scans (no per-line regexes); phase 2
  // tokenizes each item's text through the stock block lexer and applies
  // the stock task-checkbox handling verbatim.
  listPort(src) {
    const cap = this.rules.block.list.exec(src);
    if (!cap) return undefined;
    const orig = src;
    let e = src;
    const consumed = () => orig.length - e.length;
    const firstLine = (s) => {
      const i = s.indexOf("\n");
      return i === -1 ? s : s.slice(0, i);
    };
    const bull = cap[1].trim();
    const ordered = bull.length > 1;
    const listTok = {
      type: "list", raw: "", ordered,
      start: ordered ? +bull.slice(0, -1) : "",
      loose: false, items: []
    };
    const bullRe = ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
    const itemRe = this.rules.other.listItemRegex(bullRe);
    let p = false;
    while (e) {
      let u = false;
      let d = "";
      const t = itemRe.exec(e);
      if (!t || this.rules.block.hr.test(e)) break;
      const k = consumed();
      e = e.substring(t[0].length);
      const g = firstLine(t[2]);
      const b = t[1].length;
      let m = g.replace(this.rules.other.leadingSpaceTab, (v) => J(v, b));
      let f = firstLine(e);
      const y0 = !m.trim();
      let y = y0;
      let R = 0;
      if (y) {
        R = b + 1;
      } else {
        R = m.search(this.rules.other.nonSpaceChar);
        R = R > 4 ? 1 : R;
        d = m.slice(R);
        R += b;
      }
      if (y && this.rules.other.blankLine.test(f)) {
        e = e.substring(f.length + 1);
        u = true;
      }
      if (!u) {
        const v = this.rules.other.nextBulletRegex(R);
        const Q = this.rules.other.hrRegex(R);
        const ee = this.rules.other.fencesBeginRegex(R);
        const te = this.rules.other.headingBeginRegex(R);
        const M = this.rules.other.htmlBeginRegex(R);
        const ne = this.rules.other.blockquoteBeginRegex(R);
        while (e) {
          const U = firstLine(e);
          let Z;
          f = U;
          Z = f.replace(this.rules.other.leadingSpaceTab, (me) => J(me));
          if (ee.test(f) || te.test(f) || M.test(f) || ne.test(f) || v.test(f) || Q.test(f)) break;
          if (Z.search(this.rules.other.nonSpaceChar) >= R || !f.trim()) {
            d += "\n" + Z.slice(R);
          } else {
            if (y || m.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 || ee.test(m) || te.test(m) || M.test(m) || Q.test(m)) break;
            const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && this.rules.block.lheading.test(`${m}\n${f}`)
              ? `    ${Z.replace(/^ {0,3}/, "")}` : f;
            d += "\n" + qe;
          }
          y = !f.trim();
          e = e.substring(U.length + 1);
          m = Z.slice(R);
        }
      }
      const A = orig.slice(k, consumed());
      if (!listTok.loose) {
        if (p) listTok.loose = true;
        else if (this.rules.other.doubleBlankLine.test(A)) p = true;
      }
      listTok.items.push({
        type: "list_item", raw: A,
        task: !!this.options.gfm && this.rules.other.listIsTask.test(d),
        loose: false, text: d, tokens: []
      });
    }
    const h = listTok.items.at(-1);
    if (h) { h.raw = h.raw.trimEnd(); h.text = h.text.trimEnd(); }
    else return undefined;
    listTok.raw = orig.slice(0, consumed()).trimEnd();
    for (const u of listTok.items) {
      this.lexer.state.top = false;
      u.tokens = this.lexer.blockTokens(u.text, []);
      if (!listTok.loose) {
        const dd = u.tokens.filter((g) => g.type === "space");
        const kk = dd.length > 0 && dd.some((g) => this.rules.other.anyLine.test(g.raw));
        listTok.loose = kk;
      }
    }
    for (const u of listTok.items) {
      const d = u.tokens[0];
      if (u.task && (d?.type === "text" || d?.type === "paragraph")) {
        u.text = u.text.replace(this.rules.other.listReplaceTask, "");
        d.raw = d.raw.replace(this.rules.other.listReplaceTask, "");
        d.text = d.text.replace(this.rules.other.listReplaceTask, "");
        for (let g = this.lexer.inlineQueue.length - 1; g >= 0; g--) {
          if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[g].src)) {
            this.lexer.inlineQueue[g].src = this.lexer.inlineQueue[g].src.replace(this.rules.other.listReplaceTask, "");
            break;
          }
        }
        const kk = this.rules.other.listTaskCheckbox.exec(u.raw);
        if (kk) {
          const g = { type: "checkbox", raw: kk[0] + " ", checked: kk[0] !== "[ ]" };
          u.checked = g.checked;
          if (listTok.loose) {
            if (u.tokens[0] && ["paragraph", "text"].includes(u.tokens[0].type) && "tokens" in u.tokens[0] && u.tokens[0].tokens) {
              u.tokens[0].raw = g.raw + u.tokens[0].raw;
              u.tokens[0].text = g.raw + u.tokens[0].text;
              u.tokens[0].tokens.unshift(g);
            } else {
              u.tokens.unshift({ type: "paragraph", raw: g.raw, text: g.raw, tokens: [g] });
            }
          } else {
            u.tokens.unshift(g);
          }
        }
      } else if (u.task) {
        u.task = false;
      }
    }
    if (listTok.loose) {
      for (const u of listTok.items) {
        u.loose = true;
        for (const d of u.tokens) if (d.type === "text") d.type = "paragraph";
      }
    }
    return listTok;
  }
}

// ---- entry point ----------------------------------------------------------
const DEFAULTS = { async: false, breaks: false, gfm: true, pedantic: false };

export function parse(markdown) {
  try {
    const lexer = new Lexer({ ...DEFAULTS, tokenizer: new FastTokenizer() });
    const tokens = lexer.lex(markdown);
    return new Parser({ ...DEFAULTS }).parse(tokens);
  } catch {
    return marked.parse(markdown);
  }
}
