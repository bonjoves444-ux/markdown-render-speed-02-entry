// parse.js — a credited fork of marked 18.1.3 (MIT).
//
// Renders Markdown to exactly the HTML marked 18.1.3 produces with its
// default options (GFM on). The stock Lexer and Parser from vendor/marked/
// do the real work; only the block Tokenizer is replaced with a faster one.
// Cheap first-character gates skip the block regexes that cannot match, and
// the list tokenizer is a manual port of the stock one that avoids splitting
// the source into lines. The inline tokenizer is the stock one, untouched,
// so autolinks, hard breaks and emphasis behave exactly like marked.
//
// SPDX-License-Identifier: MIT

import { Lexer, Parser, Tokenizer, marked } from "./vendor/marked/marked.esm.js";

// --- Character kinds -------------------------------------------------------
// Small integer kinds for the ASCII characters that can start a block
// token. kindAt() classifies the character at an index; anything else
// (including every non-ASCII code point) is kind 0, "other", because no
// block token in marked starts with it.

const ASCII_KIND = new Uint8Array(128);
{
  const set = (chars, kind) => {
    for (const ch of chars) ASCII_KIND[ch.charCodeAt(0)] = kind;
  };
  set(" ", 1);
  set("\t", 2);
  set("\n", 3);
  set("#", 4);
  set(">", 5);
  set("`", 6);
  set("~", 7);
  set("-", 8);
  set("*", 9);
  set("_", 10);
  set("+", 11);
  set("[", 12);
  set("<", 13);
  set("0123456789", 14);
  set("|", 15);
  set("=", 16);
  set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", 17);
  set(":", 18);
  set(".", 19);
  set("/", 20);
  set("!", 21);
  set("?", 22);
  set("\r", 23);
}

function codePointAt(s, i) {
  if (i >= s.length) return -1;
  const hi = s.charCodeAt(i);
  if (hi >= 0xd800 && hi <= 0xdbff && i + 1 < s.length) {
    const lo = s.charCodeAt(i + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);
  }
  return hi;
}

function codePointLen(s, i) {
  if (i >= s.length) return 0;
  const hi = s.charCodeAt(i);
  if (hi >= 0xd800 && hi <= 0xdbff && i + 1 < s.length) {
    const lo = s.charCodeAt(i + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return 2;
  }
  return 1;
}

function kindAt(s, i) {
  if (i >= s.length) return 0;
  const cp = codePointAt(s, i);
  return cp < 128 ? ASCII_KIND[cp] : 0;
}

function isPunctStr(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i += codePointLen(s, i)) {
    if (!/[\p{P}\p{S}]/u.test(String.fromCodePoint(codePointAt(s, i)))) return false;
  }
  return true;
}

// --- Stock entity decoding and label normalisation -------------------------
// Replicas of the stock helpers (named Ie and F in the vendored build):
// a numeric character reference that is 0, over U+10FFFF, or a surrogate
// becomes U+FFFD; 38 becomes &amp;; a bare & that is not the start of a
// reference becomes &amp;; anything else is left alone.

const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeEntities(s) {
  if (!NUMERIC_REF.test(s)) return s;
  return s.replace(NUMERIC_REF_OR_AMP, (match, dec, hex) => {
    if (dec === undefined && hex === undefined) return "&amp;";
    const cp = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "\uFFFD";
    if (cp === 38) return "&amp;";
    return String.fromCodePoint(cp);
  });
}

const MULTIPLE_SPACE = /\s+/g;

function normLabel(s) {
  return s.trim().replace(MULTIPLE_SPACE, " ").toLowerCase().toUpperCase().toLowerCase();
}

// --- Stock tab expansion ---------------------------------------------------
// J(s, startCol): expand tabs to spaces, a tab jumping to the next multiple
// of 4 columns from startCol. Verbatim from the stock build. It takes the
// column the run starts at and does NOT pad to a target width.

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

function expandTabs(s, startCol = 0) {
  return J(s, startCol);
}

// --- Line helpers ----------------------------------------------------------

function lineEnd(src, from = 0) {
  const i = src.indexOf("\n", from);
  return i === -1 ? src.length : i;
}

function firstLine(src) {
  return src.slice(0, lineEnd(src, 0));
}

// Column (tabs expanded to the next multiple of 4) and index of the first
// character that is not a space or a tab.
function firstNonSpaceExpanded4(src) {
  let col = 0;
  let idx = 0;
  while (idx < src.length) {
    const ch = src[idx];
    if (ch === " ") {
      col++;
      idx++;
    } else if (ch === "\t") {
      col += 4 - (col % 4);
      idx++;
    } else break;
  }
  return { col, idx };
}

function blankLineText(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== " " && line[i] !== "\t") return false;
  }
  return true;
}

// Index just past the run of blank lines starting at `from`.
function blankLineRange(src, from = 0) {
  let pos = from;
  while (pos < src.length) {
    const end = lineEnd(src, pos);
    if (!blankLineText(src.slice(pos, end))) break;
    pos = end + 1;
  }
  return pos;
}

const SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;

function isUnderlineRow(line) {
  return SETEXT_LINE.test(line);
}

function endsWithDoubleBlank(s) {
  return /\n[ \t]*\n[ \t]*$/.test(s);
}

// The stock HTML block tag names, verbatim from the vendored build.
const BLOCK_TAG_SET = new Set(
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul".split("|")
);

// Index just after up to three leading spaces (the stock block regexes
// allow at most three; a tab is not a leading space here).
function skipUpTo3Spaces(src) {
  let i = 0;
  while (i < src.length && i < 3 && src[i] === " ") i++;
  return i;
}

function isAsciiLetter(ch) {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

// Each lineIs* helper is a necessary condition for its stock regex: it
// passes whenever the stock method could match, and only skips the super
// call when the stock method certainly cannot match.

function lineIsFences(src) {
  const k = kindAt(src, skipUpTo3Spaces(src));
  return k === 6 || k === 7;
}

function lineIsHeading(src) {
  return kindAt(src, skipUpTo3Spaces(src)) === 4;
}

function lineIsHr(src) {
  const k = kindAt(src, skipUpTo3Spaces(src));
  return k === 8 || k === 9 || k === 10;
}

function lineIsBlockquote(src) {
  return kindAt(src, skipUpTo3Spaces(src)) === 5;
}

function lineIsHtml(src) {
  const i = skipUpTo3Spaces(src);
  if (src[i] !== "<") return false;
  const c = src[i + 1];
  if (c === "!" || c === "?") return true;
  if (c === "/") return isAsciiLetter(src[i + 2]);
  if (!isAsciiLetter(c)) return false;
  // A letter tag. The stock html rule accepts any tag name in its later
  // alternatives, so any letter tag is a possible html block; the
  // block-tag set below names the tags its first alternative lists.
  let j = i + 1;
  let name = "";
  while (j < src.length && /[a-zA-Z0-9-]/.test(src[j])) {
    name += src[j];
    j++;
  }
  // Known block tags are the common case; any other tag name passes too.
  return BLOCK_TAG_SET.has(name.toLowerCase()) || name.length > 0;
}

function lineIsDef(src) {
  return kindAt(src, skipUpTo3Spaces(src)) === 12;
}

function lineIsList(src) {
  const k = kindAt(src, skipUpTo3Spaces(src));
  return k === 8 || k === 9 || k === 11 || k === 14;
}

// A table can start here only if the second line is a delimiter row and
// that row contains a colon or a pipe. (The stock table() also requires
// the delimiter to contain : or |, and a pipe-less header is a real table
// when the delimiter is like ":---" — so the header need not contain a
// pipe. The delimiter pattern and the :/| test are both necessary
// conditions for the stock method to match.)
const DELIM_ROW = /^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/;

function tableStartsHere(src) {
  const nl = src.indexOf("\n");
  if (nl === -1) return false;
  const row = src.slice(nl + 1, lineEnd(src, nl + 1));
  if (!DELIM_ROW.test(row)) return false;
  return row.indexOf(":") !== -1 || row.indexOf("|") !== -1;
}

// True if some line after the first, before any blank line, is a setext
// underline row. A setext heading needs such a row, so this is a
// necessary condition for the stock lheading method to match.
function setextRowAhead(src) {
  let pos = src.indexOf("\n");
  if (pos === -1) return false;
  pos++;
  while (pos < src.length) {
    const end = lineEnd(src, pos);
    const line = src.slice(pos, end);
    if (blankLineText(line)) return false;
    if (isUnderlineRow(line)) return true;
    pos = end + 1;
  }
  return false;
}

// --- Fast block tokenizer --------------------------------------------------
// Same tokens as the stock Tokenizer; each method first checks a cheap
// necessary condition and only then runs the stock regex. A gate that
// passes when the stock method would fail costs one wasted super call;
// a gate that fails when the stock method would match would be a bug,
// so every gate below is a necessary condition for its regex.

class FastTokenizer extends Tokenizer {
  space(src) {
    const k = kindAt(src, 0);
    if (k === 1 || k === 2 || k === 3) return super.space(src);
  }

  code(src) {
    // Indented code: the first line must reach column 4 (a tab jumps to
    // the next multiple of 4) and have a non-newline character after it.
    const { col, idx } = firstNonSpaceExpanded4(src);
    if (col < 4) return;
    if (idx >= src.length || src[idx] === "\n") return;
    return super.code(src);
  }

  fences(src) {
    if (lineIsFences(src)) return super.fences(src);
  }

  heading(src) {
    if (lineIsHeading(src)) return super.heading(src);
  }

  hr(src) {
    if (lineIsHr(src)) return super.hr(src);
  }

  blockquote(src) {
    if (lineIsBlockquote(src)) return super.blockquote(src);
  }

  html(src) {
    if (lineIsHtml(src)) return super.html(src);
  }

  def(src) {
    if (lineIsDef(src)) return super.def(src);
  }

  table(src) {
    if (tableStartsHere(src)) return super.table(src);
  }

  lheading(src) {
    if (setextRowAhead(src)) return super.lheading(src);
  }

  list(src) {
    if (this.options.pedantic) return super.list(src);
    if (lineIsList(src)) return this.listPort(src);
  }

  // Manual port of the stock Tokenizer.list(), written to avoid splitting
  // the source into lines: firstLine() uses indexOf("\n") instead of
  // split("\n", 1)[0]. Semantics follow the stock method line by line.
  listPort(src) {
    let cap = this.rules.block.list.exec(src);
    if (!cap) return;
    const start = src;
    const pos = () => start.length - src.length;
    const bull = cap[1].trim();
    const ordered = bull.length > 1;
    const list = {
      type: "list",
      raw: "",
      ordered,
      start: ordered ? +bull.slice(0, -1) : "",
      loose: false,
      items: [],
    };
    let bullRegex = ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
    if (this.options.pedantic) bullRegex = ordered ? bullRegex : "[*+-]";
    const itemRegex = this.rules.other.listItemRegex(bullRegex);
    let sawDoubleBlank = false;
    for (; src;) {
      let isEnd = false;
      let text = "";
      if (!(cap = itemRegex.exec(src)) || this.rules.block.hr.test(src)) break;
      const itemStart = pos();
      src = src.substring(cap[0].length);
      const first = firstLine(cap[2]);
      const bulletLen = cap[1].length;
      let content = this.options.pedantic
        ? J(first, bulletLen)
        : first.replace(this.rules.other.leadingSpaceTab, (v) => J(v, bulletLen));
      let nextLine = firstLine(src);
      let isEmpty = !content.trim();
      let indent = 0;
      if (this.options.pedantic) {
        indent = 2;
        text = content.trimStart();
      } else if (isEmpty) {
        indent = bulletLen + 1;
      } else {
        indent = content.search(this.rules.other.nonSpaceChar);
        if (indent > 4) indent = 1;
        text = content.slice(indent);
        indent += bulletLen;
      }
      if (isEmpty && this.rules.other.blankLine.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        isEnd = true;
      }
      if (!isEnd) {
        const nextBullet = this.rules.other.nextBulletRegex(indent);
        const hr = this.rules.other.hrRegex(indent);
        const fences = this.rules.other.fencesBeginRegex(indent);
        const heading = this.options.pedantic
          ? this.rules.other.pedanticHeadingBeginRegex(indent)
          : this.rules.other.headingBeginRegex(indent);
        const html = this.rules.other.htmlBeginRegex(indent);
        const blockquote = this.rules.other.blockquoteBeginRegex(indent);
        for (; src;) {
          const line = firstLine(src);
          let lineExpanded;
          nextLine = line;
          if (this.options.pedantic) {
            nextLine = nextLine.replace(this.rules.other.listReplaceNesting, "  ");
            lineExpanded = nextLine;
          } else {
            lineExpanded = nextLine.replace(this.rules.other.leadingSpaceTab, (m) => J(m));
          }
          if (
            fences.test(nextLine) || heading.test(nextLine) || html.test(nextLine) ||
            blockquote.test(nextLine) || nextBullet.test(nextLine) || hr.test(nextLine)
          ) break;
          if (lineExpanded.search(this.rules.other.nonSpaceChar) >= indent || !nextLine.trim()) {
            text += "\n" + lineExpanded.slice(indent);
          } else {
            if (
              isEmpty ||
              content.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 ||
              fences.test(content) || heading.test(content) || html.test(content) || hr.test(content)
            ) break;
            const setext =
              !this.options.pedantic &&
              SETEXT_LINE.test(nextLine) &&
              this.rules.block.lheading.test(`${content}\n${nextLine}`)
                ? `    ${lineExpanded.replace(/^ {0,3}/, "")}`
                : nextLine;
            text += "\n" + setext;
          }
          isEmpty = !nextLine.trim();
          src = src.substring(line.length + 1);
          content = lineExpanded.slice(indent);
        }
      }
      const itemRaw = start.slice(itemStart, pos());
      if (!list.loose) {
        if (sawDoubleBlank) list.loose = true;
        else if (endsWithDoubleBlank(itemRaw)) sawDoubleBlank = true;
      }
      list.items.push({
        type: "list_item",
        raw: itemRaw,
        task: !!this.options.gfm && this.rules.other.listIsTask.test(text),
        loose: false,
        text,
        tokens: [],
      });
    }
    const last = list.items.at(-1);
    if (last) {
      last.raw = last.raw.trimEnd();
      last.text = last.text.trimEnd();
    } else return;
    list.raw = start.slice(0, pos()).trimEnd();
    for (const item of list.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((t) => t.type === "space");
        const hasLine = spaces.length > 0 && spaces.some((t) => this.rules.other.anyLine.test(t.raw));
        list.loose = hasLine;
      }
    }
    for (const item of list.items) {
      const firstTok = item.tokens[0];
      if (item.task && (firstTok?.type === "text" || firstTok?.type === "paragraph")) {
        item.text = item.text.replace(this.rules.other.listReplaceTask, "");
        firstTok.raw = firstTok.raw.replace(this.rules.other.listReplaceTask, "");
        firstTok.text = firstTok.text.replace(this.rules.other.listReplaceTask, "");
        for (let i = this.lexer.inlineQueue.length - 1; i >= 0; i--) {
          if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[i].src)) {
            this.lexer.inlineQueue[i].src = this.lexer.inlineQueue[i].src.replace(this.rules.other.listReplaceTask, "");
            break;
          }
        }
        const checkbox = this.rules.other.listTaskCheckbox.exec(item.raw);
        if (checkbox) {
          const cb = { type: "checkbox", raw: checkbox[0] + " ", checked: checkbox[0] !== "[ ]" };
          item.checked = cb.checked;
          if (list.loose) {
            if (
              item.tokens[0] &&
              ["paragraph", "text"].includes(item.tokens[0].type) &&
              "tokens" in item.tokens[0] &&
              item.tokens[0].tokens
            ) {
              item.tokens[0].raw = cb.raw + item.tokens[0].raw;
              item.tokens[0].text = cb.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(cb);
            } else {
              item.tokens.unshift({ type: "paragraph", raw: cb.raw, text: cb.raw, tokens: [cb] });
            }
          } else {
            item.tokens.unshift(cb);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const tok of item.tokens) {
          if (tok.type === "text") tok.type = "paragraph";
        }
      }
    }
    return list;
  }
}

// --- Entry point -----------------------------------------------------------

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
