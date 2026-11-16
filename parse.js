// parse.js — a credited fork of marked 18.1.3 (MIT, vendor/marked/LICENSE),
// made faster by replacing marked's inline token tree with a direct-to-HTML
// scanner. The block structure still comes from marked's own block lexer
// (vendor/marked/marked.esm.js), so block decisions are marked's by
// construction; inline content is rendered straight to HTML by the scanner
// below, which ports marked's inline algorithms (escape, tag, link,
// reflink, emStrong, codespan, br, del, autolink, url, text) without
// building token objects. Anything the scanner cannot prove is handled by
// falling back to marked.parse on the whole document.

import { marked, Lexer } from './vendor/marked/marked.esm.js';

// ---------------------------------------------------------------------------
// Regexes: marked 18.1.3's GFM inline grammar (rules.ts), same sources.
// ---------------------------------------------------------------------------

const _punct = '[\\p{P}\\p{S}]';
const _punctSpace = '[\\s\\p{P}\\p{S}]';
const _notPunctSpace = '[^\\s\\p{P}\\p{S}]';
const _punctGfm = '(?!~)' + _punct;
const _punctSpaceGfm = '(?!~)' + _punctSpace;
const _notPunctSpaceGfm = '(?:[^\\s\\p{P}\\p{S}]|~)';

const ESCAPE_RE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;

const _commentInline = /<!--(?:-?>|[\s\S]*?-->)/;
const TAG_RE = new RegExp(
  '^' + _commentInline.source
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
);

const AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;

const _labelBracketsSrc = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const _inlineLabelSrc = '(?:\\[(?:' + _labelBracketsSrc + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const _blockLabelSrc = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const _hrefSrc = '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))';
const _titleSrc = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';

const LINK_RE = new RegExp(
  '^!?\\[(' + _inlineLabelSrc + ')\\]\\([ \\t\\n]*(' + _hrefSrc + ')(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(' + _titleSrc + '))?[ \\t\\n]*\\)',
);
const REFLINK_RE = new RegExp('^!?\\[(' + _inlineLabelSrc + ')\\]\\[(' + _blockLabelSrc + ')\\]');
const NOLINK_RE = new RegExp('^!?\\[(' + _blockLabelSrc + ')\\](?:\\[\\])?');

// Bounded label variants used only to mask reflinks for emphasis (rules.ts).
const _boundedBlockLabelSrc = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const _boundedInlineLabelSrc = '(?:[^\\[\\]\\\\`]*(?:\\[(?:' + _labelBracketsSrc + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';
const REFLINK_SEARCH = new RegExp(
  '!?\\[(' + _boundedInlineLabelSrc + ')\\]\\[(' + _boundedBlockLabelSrc + ')\\]'
  + '|!?\\[(' + _boundedBlockLabelSrc + ')\\](?:\\[\\])?(?!\\()', 'g',
);

const CODE_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const BR_RE = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

const DEL_L_DELIM = new RegExp('^~~?(?:((?!~)' + _punct + ')|[^\\s~])', 'u');
const _delRDelimCore =
  '^[^~]+(?=[^~])'
  + '|(?!~)' + _punct + '(~~?)(?=[\\s]|$)'
  + '|' + _notPunctSpace + '(~~?)(?!~)(?=' + _punctSpace + '|$)'
  + '|(?!~)' + _punctSpace + '(~~?)(?=' + _notPunctSpace + ')'
  + '|[\\s](~~?)(?!~)(?=' + _punct + ')'
  + '|(?!~)' + _punct + '(~~?)(?!~)(?=' + _punct + ')'
  + '|' + _notPunctSpace + '(~~?)(?=' + _notPunctSpace + ')';
const DEL_R_DELIM = new RegExp(_delRDelimCore, 'gu');

const _emStrongLDelimCore = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const EM_STRONG_L_DELIM = new RegExp(
  _emStrongLDelimCore.source.replace(/punct/g, _punctGfm), 'u',
);

const _emStrongRDelimAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)';
const EM_STRONG_R_DELIM_AST = new RegExp(
  _emStrongRDelimAstCore
    .replace(/notPunctSpace/g, _notPunctSpaceGfm)
    .replace(/punctSpace/g, _punctSpaceGfm)
    .replace(/punct/g, _punctGfm), 'gu',
);

const _emStrongRDelimUndCore =
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)';
const EM_STRONG_R_DELIM_UND = new RegExp(
  _emStrongRDelimUndCore
    .replace(/notPunctSpace/g, _notPunctSpace)
    .replace(/punctSpace/g, _punctSpace)
    .replace(/punct/g, _punct), 'gu',
);

const PUNCTUATION_RE = new RegExp('^((?![*_])' + _punctSpace + ')', 'u');
const ANY_PUNCT_RE = new RegExp('\\\\(' + _punct + ')', 'gu');
const ANY_PUNCT_OUTSIDE_CODE_RE = new RegExp(
  '(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(' + _punct + ')', 'gu',
);
const BLOCK_SKIP_RE = new RegExp(
  '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)'
  + '|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)'
  + '|<(?! )[^<>]*?>', 'g',
);

const _extendedEmailSrc = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const URL_RE = new RegExp(
  '^(?:mailto:' + _extendedEmailSrc + '|xmpp:' + _extendedEmailSrc + '(?:\\/[A-Za-z0-9@.]+)?)'
  + '|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*'
  + '|^' + '[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])',
);
const BACKPEDAL_RE = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

const OUTPUT_LINK_REPLACE_RE = /\\([\[\]])/g;
const START_ANGLE_RE = /^</;
const END_ANGLE_RE = />$/;
const UNICODE_ALNUM_RE = /[\p{L}\p{N}]/u;
const START_A_TAG_RE = /^<a /i;
const END_A_TAG_RE = /^<\/a>/i;
const START_PRE_TAG_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_TAG_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;

// Finds the next position where an inline token can start: a delimiter char,
// a newline (hard break), an `@` (possible e-mail autolink, whose local part
// ends just before it), or a www. / protocol / mailto: / xmpp: start. The
// e-mail alternative is deliberately not in here: the regex engine would try
// it at every position. Preceding-character rules for www. / mailto: / xmpp:
// are checked in JavaScript at the (rare) match instead.
const NEXT_SPECIAL_RE = /[\\<\[`*_~!\n@]|www\.|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][tT][pP]:\/\/|mailto:|xmpp:/g;
const EMAIL_LOCAL_CHARS = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._+-'.split(''));
const EMAIL_PREV_CHAR_RE = /[A-Za-z0-9.!#$%&'*+\/=?_`{|}~-]/;

// ---------------------------------------------------------------------------
// Small helpers (marked's helpers.ts, same behaviour).
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST_RE = /[&<>"']/;
const ESCAPE_REPLACE_RE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUMERIC_REF_TEST_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function escEncode(html) {
  if (ESCAPE_TEST_RE.test(html)) return html.replace(ESCAPE_REPLACE_RE, (ch) => ESCAPE_MAP[ch]);
  return html;
}

function escNoEncode(html) {
  if (ESCAPE_TEST_NO_ENCODE_RE.test(html)) return html.replace(ESCAPE_REPLACE_NO_ENCODE_RE, (ch) => ESCAPE_MAP[ch]);
  return html;
}

function decodeNumeric(text) {
  if (!NUMERIC_REF_TEST_RE.test(text)) return text;
  return text.replace(NUMERIC_REF_OR_AMP_RE, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  // Fast path: encodeURI leaves these chars untouched, and the %25 -> %
  // replace undoes encodeURI's escaping of '%' itself, so a href made
  // only of them is unchanged by the encode step.
  if (/^[A-Za-z0-9;,/?:@&=+$_.!~*'()#%-]*$/.test(href)) return href;
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

function rtrim(str, c) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

// ---------------------------------------------------------------------------
// Emphasis support: mask links / code / html / escapes so emStrong and del
// do not see delimiters inside them, and scan once per inline run for the
// last possible closers (marked's Lexer.#maskSrc and helpers.ts).
// ---------------------------------------------------------------------------

function linkInText(text, links) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(BLOCK_SKIP_RE)) {
    if (LINK_RE.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(REFLINK_SEARCH)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1), links)) continue;
    return true;
  }
  return false;
}

function maskSrc(src, links) {
  let maskedSrc = src;
  if (links && src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text, links)) {
          return '[' + text.replace(REFLINK_SEARCH, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(REFLINK_SEARCH, maskReflink);
  }
  if (maskedSrc.includes('`') || maskedSrc.includes('\\')) {
    maskedSrc = maskedSrc.replace(ANY_PUNCT_OUTSIDE_CODE_RE, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  if (maskedSrc.includes('[') || maskedSrc.includes('`') || maskedSrc.includes('<')) {
    maskedSrc = maskedSrc.replace(BLOCK_SKIP_RE, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return maskedSrc;
}

function lastCloserIndex(src, ch) {
  let i = src.lastIndexOf(ch);
  while (i > 0) {
    let s = i;
    while (s > 0 && src[s - 1] === ch) s--;
    const prev = s === 0 ? '\n' : src[s - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') return s;
    if (s <= 1) return -1;
    i = src.lastIndexOf(ch, s - 2);
  }
  return -1;
}

function cachedCloser(ctx, maskedSrc, delim) {
  const frame = ctx.frames[ctx.frames.length - 1];
  if (frame && frame.maskedSrc === maskedSrc) {
    if (frame.last[delim] === undefined) frame.last[delim] = lastCloserIndex(maskedSrc, delim);
    return frame.last[delim];
  }
  return lastCloserIndex(maskedSrc, delim);
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = CODE_RE.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = TAG_RE.exec(tokenSrc) || AUTOLINK_RE.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Port of marked's Tokenizer.emStrong: given the remaining source `src` and
// the whole run's masked source, find the emphasis / strong span starting
// at src[0]. Returns { type: 'em' | 'strong', raw, text } or undefined.
function emStrong(ctx, src, maskedSrc, prevChar) {
  let match = EM_STRONG_L_DELIM.exec(src);
  if (!match) return;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return;

  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;

  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!PUNCTUATION_RE.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!PUNCTUATION_RE.exec(prevChar);

  if (match[4] && prevChar.match(UNICODE_ALNUM_RE)) return;

  const nextChar = match[1] || match[3] || '';

  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;

    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return;
    const endReg = delimChar === '*' ? EM_STRONG_R_DELIM_AST : EM_STRONG_R_DELIM_UND;
    const lastPossible = cachedCloser(ctx, maskedSrc, delimChar);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;

      rLength = [...rDelim].length;

      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue;

      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

      if (Math.min(lLength, rLength) % 2) {
        return { type: 'em', raw, text: raw.slice(1, -1) };
      }
      return { type: 'strong', raw, text: raw.slice(2, -2) };
    }
  }
}

// Port of marked's Tokenizer.del (GFM strikethrough).
function delTok(ctx, src, maskedSrc, prevChar) {
  let match = DEL_L_DELIM.exec(src);
  if (!match) return;

  const nextChar = match[1] || '';

  if (!nextChar || !prevChar || PUNCTUATION_RE.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;

    const endReg = DEL_R_DELIM;
    const lastPossible = cachedCloser(ctx, maskedSrc, '~');
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;

      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;

      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue;

      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      return { type: 'del', raw, text: raw.slice(lLength, -lLength) };
    }
  }
}

// ---------------------------------------------------------------------------
// Links and images (marked's Tokenizer.link / reflink / outputLink, but
// rendering the label straight to HTML instead of building tokens).
// ---------------------------------------------------------------------------

// Render a link label (or image alt text) and check whether it contains a
// link. Returns null when a non-image link's label holds another link.
// The label renders in plain mode for images and inside plain text.
function outputLink(ctx, cap, raw, hrefTitle, isImage, plain) {
  const href = hrefTitle.href;
  const title = hrefTitle.title || null;
  const text = cap[1].replace(OUTPUT_LINK_REPLACE_RE, '$1');

  const outerInLink = ctx.inLink;
  const outerLinkEmitted = ctx.linkEmitted;
  const outerInRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const inner = renderInline(text, ctx, plain || isImage, false);
  const textHasLink = ctx.linkEmitted;
  ctx.linkEmitted = outerLinkEmitted;
  ctx.inLink = outerInLink;

  if (!isImage) {
    if (textHasLink) {
      ctx.inRawBlock = outerInRawBlock;
      return null;
    }
    ctx.linkEmitted = true;
  }

  return { type: isImage ? 'image' : 'link', raw, href, title, text, inner };
}

function tryLink(ctx, src, pos, plain) {
  if (ctx.linkParenPossible === false) return null;
  const rest = src.slice(pos);
  const cap = LINK_RE.exec(rest);
  if (!cap) return null;

  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(rest, cap[1], labelStart)) return null;

  const trimmedUrl = cap[2].trim();
  if (START_ANGLE_RE.test(trimmedUrl)) {
    if (!END_ANGLE_RE.test(trimmedUrl)) return null;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return null;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;

  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (START_ANGLE_RE.test(href)) href = href.slice(1, -1);
  const isImage = cap[0].charAt(0) === '!';
  return outputLink(ctx, cap, cap[0], {
    href: href ? href.replace(ANY_PUNCT_RE, '$1') : href,
    title: title ? title.replace(ANY_PUNCT_RE, '$1') : title,
  }, isImage, plain);
}

function tryReflink(ctx, src, pos, plain) {
  const rest = src.slice(pos);
  const cap = REFLINK_RE.exec(rest) || NOLINK_RE.exec(rest);
  if (!cap) return null;

  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(rest, cap[1], labelStart)) return null;

  const link = ctx.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) return { failFirstChar: cap[0].charAt(0), raw: cap[0].charAt(0) };
  const isImage = cap[0].charAt(0) === '!';
  return outputLink(ctx, cap, cap[0], link, isImage, plain);
}

function renderLinkToken(tok, autolink) {
  const parsedText = autolink ? escEncode(tok.text) : tok.inner;
  const cleanHref = cleanUrl(tok.href);
  if (cleanHref === null) return parsedText;
  const href = autolink ? escEncode(cleanHref) : escNoEncode(cleanHref);
  let out = '<a href="' + href + '"';
  if (tok.title) out += ' title="' + escNoEncode(tok.title) + '"';
  return out + '>' + parsedText + '</a>';
}

function renderImageToken(tok) {
  const text = tok.inner;
  const cleanHref = cleanUrl(tok.href);
  if (cleanHref === null) return escNoEncode(text);
  let out = '<img src="' + escNoEncode(cleanHref) + '" alt="' + escNoEncode(text) + '"';
  if (tok.title) out += ' title="' + escNoEncode(tok.title) + '"';
  return out + '>';
}

// Extended autolink (www. / protocol / e-mail), marked's Tokenizer.url.
function tryUrl(ctx, src, pos) {
  const cap = URL_RE.exec(src.slice(pos));
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      cap[0] = BACKPEDAL_RE.exec(cap[0])?.[0] ?? '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return { type: 'link', raw: cap[0], text, href, autolink: true, inner: escEncode(text) };
}

// ---------------------------------------------------------------------------
// The inline scanner: one pass over an inline run, straight to HTML.
// `plain` renders image alt text (marked's TextRenderer). `topRun` resets
// the raw-block state, as marked's Lexer.lex does before each queued run.
// ---------------------------------------------------------------------------

const PUNCT_CHARS = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

function renderInline(src, ctx, plain, topRun) {
  if (topRun) ctx.inRawBlock = false;
  if (src === '') return '';
  const len = src.length;

  const prevLinkParenPossible = ctx.linkParenPossible;
  ctx.linkParenPossible = prevLinkParenPossible && src.includes(')');

  let masked = null;
  let framePushed = false;
  const getMasked = () => {
    if (masked === null) {
      // With no `[`, backtick, `<` or backslash in the run, every mask
      // replace is a no-op and the masked source is the source itself.
      masked = /[\[`<\\]/.test(src) ? maskSrc(src, ctx.links) : src;
      ctx.frames.push({ maskedSrc: masked, last: {} });
      framePushed = true;
    }
    return masked;
  };

  const out = [];
  let pending = '';
  let prevChar = '';
  let i = 0;

  const flushText = () => {
    if (!pending) return;
    if (ctx.inRawBlock) {
      out.push(pending);
    } else if (plain) {
      out.push(pending.includes('&') ? decodeNumeric(pending) : pending);
    } else if (/[<>"'&]/.test(pending)) {
      out.push(escNoEncode(decodeNumeric(pending)));
    } else {
      out.push(pending);
    }
    if (pending[pending.length - 1] !== '_') prevChar = pending[pending.length - 1];
    pending = '';
  };

  try {
    while (i < len) {
      NEXT_SPECIAL_RE.lastIndex = i;
      const m = NEXT_SPECIAL_RE.exec(src);
      if (!m) {
        pending += src.slice(i);
        break;
      }
      const p = m.index;
      if (p > i) pending += src.slice(i, p);
      const ch = src[p];
      i = p;

      if (ch === '\\') {
        const next = src[p + 1];
        if (next !== undefined && PUNCT_CHARS.has(next)) {
          flushText();
          // An escape token is still HTML-escaped (marked's Renderer.text
          // escapes it: escape tokens carry no `escaped` flag).
          out.push(escNoEncode(next));
          prevChar = '';
          i = p + 2;
          continue;
        }
        if (next === '\n') {
          // Possible hard break: `\<newline>` (br regex, tried here as in
          // marked's loop order: escape, tag, link, reflink, emStrong,
          // codespan, br, ...).
          const after = src.slice(p + 2);
          if (!/^\s*$/.test(after)) {
            flushText();
            out.push(plain ? '' : '<br>');
            prevChar = '';
            let j = p + 2;
            while (src[j] === ' ' || src[j] === '\t') j++;
            i = j;
            continue;
          }
        }
        pending += '\\';
        i = p + 1;
        continue;
      }

      if (ch === '\n') {
        // Hard break from two or more trailing spaces?
        if (/ {2,}$/.test(pending) && !/^\s*$/.test(src.slice(p + 1))) {
          const spaces = pending.match(/ +$/)[0].length;
          const kept = pending.slice(0, pending.length - spaces);
          pending = '';
          if (kept) {
            if (plain) out.push(ctx.inRawBlock ? kept : decodeNumeric(kept));
            else out.push(ctx.inRawBlock ? kept : escNoEncode(decodeNumeric(kept)));
          }
          out.push(plain ? '' : '<br>');
          prevChar = '';
          let j = p + 1;
          while (src[j] === ' ' || src[j] === '\t') j++;
          i = j;
          continue;
        }
        pending += '\n';
        i = p + 1;
        continue;
      }

      if (ch === '<') {
        const tagCap = TAG_RE.exec(src.slice(p));
        if (tagCap) {
          flushText();
          const rawTag = tagCap[0];
          if (!ctx.inLink && START_A_TAG_RE.test(rawTag)) ctx.inLink = true;
          else if (ctx.inLink && END_A_TAG_RE.test(rawTag)) ctx.inLink = false;
          if (!ctx.inRawBlock && START_PRE_TAG_RE.test(rawTag)) ctx.inRawBlock = true;
          else if (ctx.inRawBlock && END_PRE_TAG_RE.test(rawTag)) ctx.inRawBlock = false;
          out.push(rawTag);
          prevChar = '';
          i = p + rawTag.length;
          continue;
        }
        const autoCap = AUTOLINK_RE.exec(src.slice(p));
        if (autoCap) {
          flushText();
          let text, href;
          if (autoCap[2] === '@') { text = autoCap[1]; href = 'mailto:' + text; }
          else { text = autoCap[1]; href = text; }
          const tok = { text, href, autolink: true, inner: escEncode(text) };
          out.push(plain ? text : renderLinkToken(tok, true));
          prevChar = '';
          i = p + autoCap[0].length;
          continue;
        }
        pending += '<';
        i = p + 1;
        continue;
      }

      if (ch === '[' || (ch === '!' && src[p + 1] === '[')) {
        flushText();
        const tok = tryLink(ctx, src, p, plain) || tryReflink(ctx, src, p, plain);
        if (tok && !tok.failFirstChar) {
          out.push(plain
            ? tok.inner
            : (tok.type === 'image' ? renderImageToken(tok) : renderLinkToken(tok, false)));
          prevChar = '';
          i = p + tok.raw.length;
          continue;
        }
        if (tok && tok.failFirstChar) {
          pending += tok.failFirstChar;
          i = p + 1;
          continue;
        }
        pending += ch;
        i = p + 1;
        continue;
      }

      if (ch === '!') {
        pending += '!';
        i = p + 1;
        continue;
      }

      if (ch === '`') {
        const codeCap = CODE_RE.exec(src.slice(p));
        if (codeCap) {
          flushText();
          let text = codeCap[2].replace(/\n/g, ' ');
          const hasNonSpace = /[^ ]/.test(text);
          const hasSpaceBothEnds = /^ /.test(text) && / $/.test(text);
          if (hasNonSpace && hasSpaceBothEnds) text = text.substring(1, text.length - 1);
          out.push(plain ? text : '<code>' + escEncode(text) + '</code>');
          prevChar = '';
          i = p + codeCap[0].length;
          continue;
        }
        // A failed code span leaves the whole backtick run as text: marked's
        // text token consumes a leading run of backticks at once.
        let j = p + 1;
        while (src[j] === '`') j++;
        pending += src.slice(p, j);
        i = j;
        continue;
      }

      if (ch === '*' || ch === '_') {
        // Do not flush the pending text before trying emphasis: a `_`
        // inside an e-mail local part (a.b-c_d@x.y) must stay in the pending
        // run so the `@` handler below can still see the whole local part.
        // The previous char is the pending run's last char, unless it is
        // `_` (then the one before the run, as in marked's text tokens).
        const pc = pending ? (pending[pending.length - 1] !== '_' ? pending[pending.length - 1] : prevChar) : prevChar;
        const em = emStrong(ctx, src.slice(p), getMasked(), pc);
        if (em) {
          flushText();
          const inner = renderInline(em.text, ctx, plain, false);
          out.push(plain ? inner : (em.type === 'em' ? '<em>' + inner + '</em>' : '<strong>' + inner + '</strong>'));
          prevChar = '';
          i = p + em.raw.length;
          continue;
        }
        pending += ch;
        i = p + 1;
        continue;
      }

      if (ch === '~') {
        const pc = pending ? (pending[pending.length - 1] !== '_' ? pending[pending.length - 1] : prevChar) : prevChar;
        const d = delTok(ctx, src.slice(p), getMasked(), pc);
        if (d) {
          flushText();
          const inner = renderInline(d.text, ctx, plain, false);
          out.push(plain ? inner : '<del>' + inner + '</del>');
          prevChar = '';
          i = p + d.raw.length;
          continue;
        }
        // A failed strikethrough leaves the whole tilde run as text, as a
        // failed code span leaves its backtick run.
        let j = p + 1;
        while (src[j] === '~') j++;
        pending += src.slice(p, j);
        i = j;
        continue;
      }

      // `@`: a possible e-mail autolink, whose local part is the run of
      // local-part chars ending just before this `@` inside the pending
      // text. (Only the pending run: a `\+` escape, for example, is a
      // token of its own, so its `+` is not part of any local part.)
      if (ch === '@') {
        let k = pending.length - 1;
        while (k >= 0 && EMAIL_LOCAL_CHARS.has(pending[k])) k--;
        const localLen = pending.length - 1 - k;
        if (localLen > 0 && !ctx.inLink) {
          const q = p - localLen;
          if (q === 0 || !EMAIL_PREV_CHAR_RE.test(src[q - 1])) {
            const urlTok = tryUrl(ctx, src, q);
            if (urlTok) {
              pending = pending.slice(0, pending.length - localLen);
              flushText();
              out.push(plain ? urlTok.text : renderLinkToken(urlTok, true));
              prevChar = '';
              i = q + urlTok.raw.length;
              continue;
            }
          }
        }
        pending += '@';
        i = p + 1;
        continue;
      }

      // www. / protocol / mailto: / xmpp: start.
      if (!ctx.inLink) {
        let allowed = true;
        if (m[0] === 'www.') allowed = p === 0 || /[\s*_~(]/.test(src[p - 1]);
        else if (m[0] === 'mailto:' || m[0] === 'xmpp:') allowed = p === 0 || /[^a-zA-Z0-9]/.test(src[p - 1]);
        if (allowed) {
          flushText();
          const urlTok = tryUrl(ctx, src, p);
          if (urlTok) {
            out.push(plain ? urlTok.text : renderLinkToken(urlTok, true));
            prevChar = '';
            i = p + urlTok.raw.length;
            continue;
          }
        }
      }
      pending += ch;
      i = p + 1;
    }
  } finally {
    if (framePushed) ctx.frames.pop();
    ctx.linkParenPossible = prevLinkParenPossible;
  }

  flushText();
  return out.join('');
}

// ---------------------------------------------------------------------------
// Block rendering (marked's Parser + Renderer, straight from the block
// tokens marked's own block lexer produced). Inline content is rendered by
// renderInline from each token's text.
// ---------------------------------------------------------------------------

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderCode(tok) {
  const langString = (tok.lang || '').match(/^\S*/)?.[0];
  const code = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
  const esc = escEncode(code);
  if (!langString) return '<pre><code>' + esc + '</code></pre>\n';
  return '<pre><code class="language-' + escNoEncode(langString) + '">' + esc + '</code></pre>\n';
}

function renderCell(cell, ctx) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? '<' + tag + ' align="' + cell.align + '">' : '<' + tag + '>';
  return open + renderInline(cell.text, ctx, false, true) + '</' + tag + '>\n';
}

function renderTable(tok, ctx) {
  let header = '';
  for (const cell of tok.header) header += renderCell(cell, ctx);
  let body = '';
  for (const row of tok.rows) {
    let cells = '';
    for (const cell of row) cells += renderCell(cell, ctx);
    body += '<tr>\n' + cells + '</tr>\n';
  }
  if (body) body = '<tbody>' + body + '</tbody>';
  return '<table>\n<thead>\n<tr>\n' + header + '</tr>\n</thead>\n' + body + '</table>\n';
}

function renderListItem(item, ctx) {
  let body = '';
  let needCheckbox = !!item.task;
  for (const t of item.tokens) {
    if (t.type === 'checkbox') {
      body += checkboxHtml(t.checked);
      needCheckbox = false;
      continue;
    }
    if (needCheckbox && (t.type === 'paragraph' || t.type === 'text')) {
      const m = /^\[[ xX]\][ \t]+/.exec(t.text);
      if (m) {
        const inner = renderInline(t.text.slice(m[0].length), ctx, false, true);
        body += t.type === 'paragraph'
          ? '<p>' + checkboxHtml(item.checked) + inner + '</p>\n'
          : checkboxHtml(item.checked) + inner;
        needCheckbox = false;
        continue;
      }
      needCheckbox = false;
    }
    body += renderBlock(t, ctx);
  }
  return '<li>' + body + '</li>\n';
}

function renderList(tok, ctx) {
  let body = '';
  for (const item of tok.items) body += renderListItem(item, ctx);
  const type = tok.ordered ? 'ol' : 'ul';
  const startAttr = (tok.ordered && tok.start !== 1) ? ' start="' + tok.start + '"' : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderBlock(tok, ctx) {
  switch (tok.type) {
    case 'space': return '';
    case 'hr': return '<hr>\n';
    case 'heading': return '<h' + tok.depth + '>' + renderInline(tok.text, ctx, false, true) + '</h' + tok.depth + '>\n';
    case 'code': return renderCode(tok);
    case 'table': return renderTable(tok, ctx);
    case 'blockquote': return '<blockquote>\n' + renderBlocks(tok.tokens, ctx) + '</blockquote>\n';
    case 'list': return renderList(tok, ctx);
    case 'checkbox': return checkboxHtml(tok.checked);
    case 'html': return tok.text;
    case 'def': return '';
    case 'paragraph': return '<p>' + renderInline(tok.text, ctx, false, true) + '</p>\n';
    case 'text': return renderInline(tok.text, ctx, false, true);
    default: throw new Error('unknown block token: ' + tok.type);
  }
}

function renderBlocks(tokens, ctx) {
  let out = '';
  for (const tok of tokens) out += renderBlock(tok, ctx);
  return out;
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

function fastParse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const lexer = new Lexer({
    gfm: true,
    breaks: false,
    pedantic: false,
    async: false,
    tokenizer: new FastTokenizer()
  });
  const tokens = lexer.blockTokens(src, []);
  const ctx = {
    links: lexer.tokens.links,
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    frames: [],
  };
  return renderBlocks(tokens, ctx);
}

/**
 * The HTML marked 18.1.3 renders for `markdown`, with marked's defaults.
 * Fast path: marked's own block lexer plus a direct-to-HTML inline scanner.
 * Any doubt falls back to marked.parse on the whole document.
 */
export function parse(markdown) {
  try {
    return fastParse(markdown);
  } catch {
    return marked.parse(markdown);
  }
}

// ---------------------------------------------------------------------------
// Fast list tokenizer: a port of marked's Tokenizer.list that replaces its
// per-line regex tests with character checks. It must produce byte-identical
// tokens, so every predicate below mirrors its regex exactly.
// ---------------------------------------------------------------------------

import { Tokenizer } from './vendor/marked/marked.esm.js';

function countLeadingSpaces(s) {
  let i = 0;
  while (s[i] === ' ') i++;
  return i;
}

function firstNonSpace(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ') i++;
  return i < s.length ? i : -1;
}

function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

// Expand a leading run of spaces/tabs to spaces (tab stops of 4 from `col`).
// A leading run of spaces only is already expanded, so it returns the line
// unchanged (no allocation).
function expandLeading(line, col) {
  let i = 0;
  let hasTab = false;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === '\t') hasTab = true;
    i++;
  }
  if (i === 0 || !hasTab) return line;
  let out = '';
  let c = col;
  for (let j = 0; j < i; j++) {
    if (line[j] === '\t') {
      const added = 4 - (c % 4);
      out += ' '.repeat(added);
      c += added;
    } else {
      out += ' ';
      c++;
    }
  }
  return out + line.slice(i);
}

// First line of `s` (up to the first '\n', not including it).
function firstLineOf(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}

// The effective indent for marked's cached per-indent regexes.
function effIndent(indent) {
  return Math.max(0, Math.min(3, indent - 1));
}

// Match a bullet at the start of `s` (0-3 leading spaces). Returns the index
// just past the bullet, or -1. `ordered` with `delim` ('.' or ')') needs
// 1-9 digits plus the delimiter; unordered needs exactly `ch`.
function bulletEnd(s, ordered, ch) {
  const sp = countLeadingSpaces(s);
  if (sp > 3) return -1;
  if (ordered) {
    let i = sp;
    let digits = 0;
    while (digits < 9 && s[i] >= '0' && s[i] <= '9') { i++; digits++; }
    if (digits === 0) return -1;
    if (digits === 9 && s[i] >= '0' && s[i] <= '9') return -1;
    if (s[i] !== ch) return -1;
    return i + 1;
  }
  return s[sp] === ch ? sp + 1 : -1;
}

// Does `s` start with a list (marked's block.list regex)? Returns the
// bullet's end index plus ordering info, or null.
function listStart(s) {
  const sp = countLeadingSpaces(s);
  if (sp > 3) return null;
  const c = s[sp];
  let ordered = false;
  let delim = '';
  let end = -1;
  if (c === '*' || c === '+' || c === '-') {
    end = sp + 1;
    delim = c;
  } else if (c >= '0' && c <= '9') {
    let i = sp;
    let digits = 0;
    while (digits < 9 && s[i] >= '0' && s[i] <= '9') { i++; digits++; }
    if (digits === 0) return null;
    if (digits === 9 && s[i] >= '0' && s[i] <= '9') return null;
    if (s[i] !== '.' && s[i] !== ')') return null;
    ordered = true;
    delim = s[i];
    end = i + 1;
  } else {
    return null;
  }
  // After the bullet: a space, tab, newline or end of input.
  const nx = s[end];
  if (nx !== undefined && nx !== ' ' && nx !== '\t' && nx !== '\n') return null;
  return { cap1: s.slice(0, end), ordered, delim };
}

// Match one list item at the start of `s` (marked's itemRegex). Returns
// { cap0len, cap1, cap2 } or null. cap1 is indent+bullet, cap2 the rest of
// the item's first line (with a trailing '\n' when the header ends there).
function itemMatch(s, ordered, delim) {
  const end = bulletEnd(s, ordered, delim);
  if (end === -1) return null;
  const cap1 = s.slice(0, end);
  let cap2 = '';
  let cap0len = end;
  const nx = s[end];
  if (nx === ' ' || nx === '\t') {
    const nl = s.indexOf('\n', end);
    if (nl === -1) {
      cap2 = s.slice(end);
      cap0len = s.length;
    } else {
      cap2 = s.slice(end, nl + 1);
      cap0len = nl + 1;
    }
  } else if (nx === '\n') {
    cap2 = '\n';
    cap0len = end + 1;
  } else if (nx === undefined) {
    cap2 = '';
    cap0len = end;
  } else {
    return null;
  }
  return { cap0len, cap1, cap2 };
}

// Line classifiers mirroring marked's cached per-indent regexes (n is the
// effective indent from effIndent()).

function isFencesBegin(line, n) {
  const sp = countLeadingSpaces(line);
  if (sp > n) return false;
  const c = line[sp];
  return (c === '`' && line[sp + 1] === '`' && line[sp + 2] === '`')
    || (c === '~' && line[sp + 1] === '~' && line[sp + 2] === '~');
}

function isHeadingBegin(line, n) {
  const sp = countLeadingSpaces(line);
  if (sp > n) return false;
  let i = sp;
  let hashes = 0;
  while (hashes < 6 && line[i] === '#') { i++; hashes++; }
  if (hashes === 0) return false;
  const nx = line[i];
  return nx === undefined || /\s/.test(nx);
}

const BLOCK_TAGS = new Set(('address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul').split('|'));

function isHtmlBegin(line, n) {
  const sp = countLeadingSpaces(line);
  if (sp > n) return false;
  if (line[sp] !== '<') return false;
  const c1 = line[sp + 1];
  if (c1 === '!') {
    if (line[sp + 2] === '-' && line[sp + 3] === '-') return true;
    if (/[A-Za-z]/.test(line[sp + 2] || '')) return true;
    return line.slice(sp, sp + 9) === '<![CDATA[';
  }
  if (c1 === '?') return true;
  let i = sp + 1;
  let slash = false;
  if (line[i] === '/') { i++; slash = true; }
  let j = i;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  if (j === i) return false;
  const name = line.slice(i, j).toLowerCase();
  if (!slash
    && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) {
    const nx = line[j];
    return nx === undefined || nx === '>' || /\s/.test(nx);
  }
  if (!BLOCK_TAGS.has(name)) return false;
  const nx = line[j];
  if (nx === undefined || nx === ' ') return true;
  if (nx === '/') return line[j + 1] === '>';
  return nx === '>';
}

function isBlockquoteBegin(line, n) {
  const sp = countLeadingSpaces(line);
  if (sp > n) return false;
  return line[sp] === '>';
}

function isNextBullet(line, n) {
  const sp = countLeadingSpaces(line);
  if (sp > n) return false;
  const c = line[sp];
  let end;
  if (c === '*' || c === '+' || c === '-') {
    end = sp + 1;
  } else if (c >= '0' && c <= '9') {
    let i = sp;
    let digits = 0;
    while (digits < 9 && line[i] >= '0' && line[i] <= '9') { i++; digits++; }
    if (digits === 0) return false;
    if (digits === 9 && line[i] >= '0' && line[i] <= '9') return false;
    if (line[i] !== '.' && line[i] !== ')') return false;
    end = i + 1;
  } else {
    return false;
  }
  const nx = line[end];
  return nx === undefined || nx === ' ' || nx === '\t';
}

// Thematic break on one line (marked's hr, with up to n leading spaces).
function isHrLine(line, n) {
  const sp = countLeadingSpaces(line);
  if (sp > n) return false;
  const c = line[sp];
  if (c !== '-' && c !== '_' && c !== '*') return false;
  let count = 0;
  for (let i = sp; i < line.length; i++) {
    if (line[i] === c) count++;
    else if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return count >= 3;
}

// Does `src` start with a thematic break (marked's block.hr, tested on the
// remaining source, so the break must be followed by newlines or the end)?
function isHrAtStart(src) {
  const line = firstLineOf(src);
  if (!isHrLine(line, 3)) return false;
  return line.length === src.length || src[line.length] === '\n';
}

// Does `raw` end with a blank line (marked's doubleBlankLine)?
function hasDoubleBlankLine(raw) {
  let e = raw.length;
  while (e > 0 && (raw[e - 1] === ' ' || raw[e - 1] === '\t')) e--;
  if (e === 0 || raw[e - 1] !== '\n') return false;
  e--;
  while (e > 0 && (raw[e - 1] === ' ' || raw[e - 1] === '\t')) e--;
  return e > 0 && raw[e - 1] === '\n';
}

function hasTwoNewlines(raw) {
  let count = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\n' && ++count >= 2) return true;
  }
  return false;
}

// Setext underline line: 0-3 spaces, a run of '=' or '-' (one kind), then
// only spaces/tabs (marked's lheading underline).
function isSetextUnderline(line) {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  const c = line[i];
  if (c !== '=' && c !== '-') return false;
  i++;
  while (line[i] === c) i++;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i === line.length;
}

class FastTokenizer extends Tokenizer {
  // Fast pre-checks for the block tokenizers: each is a necessary condition
  // for its regex, so a failed check skips the regex; otherwise fall
  // through to marked's own tokenizer.
  code(src) {
    let sp = 0;
    while (sp < 4 && src[sp] === ' ') sp++;
    if (sp === 4) return super.code(src);
    if (src[sp] === '\t') return super.code(src);
    return;
  }

  fences(src) {
    if (!isFencesBegin(src, 3)) return;
    return super.fences(src);
  }

  heading(src) {
    if (!isHeadingBegin(src, 3)) return;
    return super.heading(src);
  }

  hr(src) {
    if (!isHrAtStart(src)) return;
    return super.hr(src);
  }

  blockquote(src) {
    const sp = countLeadingSpaces(src);
    if (sp > 3 || src[sp] !== '>') return;
    return super.blockquote(src);
  }

  html(src) {
    const sp = countLeadingSpaces(src);
    if (sp > 3 || src[sp] !== '<') return;
    return super.html(src);
  }

  def(src) {
    const sp = countLeadingSpaces(src);
    if (sp > 3 || src[sp] !== '[') return;
    return super.def(src);
  }

  // Fast pre-check for setext headings: the underline must sit on a line
  // before the first blank line. If no such line exists, the lheading regex
  // cannot match; otherwise fall through to marked's own tokenizer.
  lheading(src) {
    let pos = src.indexOf('\n');
    if (pos === -1) return;
    let lineStart = pos + 1;
    while (lineStart < src.length) {
      let lineEnd = src.indexOf('\n', lineStart);
      if (lineEnd === -1) lineEnd = src.length;
      const line = src.slice(lineStart, lineEnd);
      if (isSetextUnderline(line)) return super.lheading(src);
      if (isBlankLine(line)) return;
      lineStart = lineEnd + 1;
    }
    return;
  }

  // Fast pre-check for tables: the delimiter row is line 2 and must start
  // (after 0-3 spaces) with '|', ':' or '-'. Otherwise the table regex
  // cannot match; otherwise fall through to marked's own tokenizer.
  table(src) {
    const nl = src.indexOf('\n');
    if (nl === -1) return;
    let i = nl + 1;
    let sp = 0;
    while (sp < 3 && src[i] === ' ') { i++; sp++; }
    const c = src[i];
    if (c !== '|' && c !== ':' && c !== '-') return;
    return super.table(src);
  }

  list(src) {
    const start = listStart(src);
    if (!start) return;
    const listSrc = src;
    const taken = () => listSrc.length - src.length;
    const bull = start.cap1.trim();
    const isordered = start.ordered;
    const list = {
      type: 'list',
      raw: '',
      ordered: isordered,
      start: isordered ? +bull.slice(0, -1) : '',
      loose: false,
      items: []
    };
    const delim = start.delim;
    let endsWithBlankLine = false;
    while (src) {
      let endEarly = false;
      let itemContents = '';
      const cap = itemMatch(src, isordered, delim);
      if (!cap) break;
      if (isHrAtStart(src)) break;
      const itemStart = taken();
      src = src.substring(cap.cap0len);
      const nl2 = cap.cap2.indexOf('\n');
      const firstLine = nl2 === -1 ? cap.cap2 : cap.cap2.slice(0, nl2);
      const bulletIndent = cap.cap1.length;
      let line = expandLeading(firstLine, bulletIndent);
      let nextLine = firstLineOf(src);
      let blankLine = !line.trim();
      let indent = 0;
      if (blankLine) {
        indent = bulletIndent + 1;
      } else {
        indent = firstNonSpace(line);
        indent = indent > 4 ? 1 : indent;
        itemContents = line.slice(indent);
        indent += bulletIndent;
      }
      if (blankLine && isBlankLine(nextLine)) {
        src = src.substring(nextLine.length + 1);
        endEarly = true;
      }
      if (!endEarly) {
        const n = effIndent(indent);
        while (src) {
          const rawLine = firstLineOf(src);
          nextLine = rawLine;
          const nextLineWithoutTabs = expandLeading(nextLine, 0);
          if (isFencesBegin(nextLine, n)) break;
          if (isHeadingBegin(nextLine, n)) break;
          if (isHtmlBegin(nextLine, n)) break;
          if (isBlockquoteBegin(nextLine, n)) break;
          if (isNextBullet(nextLine, n)) break;
          if (isHrLine(nextLine, n)) break;
          if (firstNonSpace(nextLineWithoutTabs) >= indent || !nextLine.trim()) {
            itemContents += '\n' + nextLineWithoutTabs.slice(indent);
          } else {
            if (blankLine) break;
            if (firstNonSpace(line.replace(/\t/g, '    ')) >= 4) break;
            if (isFencesBegin(line, n)) break;
            if (isHeadingBegin(line, n)) break;
            if (isHtmlBegin(line, n)) break;
            if (isHrLine(line, n)) break;
            // Setext-heading continuation (rare): keep marked's regex test.
            const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
              && this.rules.block.lheading.test(`${line}\n${nextLine}`);
            const continuation = setextContinuation
              ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
              : nextLine;
            itemContents += '\n' + continuation;
          }
          blankLine = !nextLine.trim();
          src = src.substring(rawLine.length + 1);
          line = nextLineWithoutTabs.slice(indent);
        }
      }
      const raw = listSrc.slice(itemStart, taken());
      if (!list.loose) {
        if (endsWithBlankLine) list.loose = true;
        else if (hasDoubleBlankLine(raw)) endsWithBlankLine = true;
      }
      list.items.push({
        type: 'list_item',
        raw,
        task: !!this.options.gfm && this.rules.other.listIsTask.test(itemContents),
        loose: false,
        text: itemContents,
        tokens: []
      });
    }
    const lastItem = list.items.at(-1);
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else {
      return;
    }
    list.raw = listSrc.slice(0, taken()).trimEnd();
    for (const item of list.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!list.loose) {
        const spacers = item.tokens.filter(t => t.type === 'space');
        const hasMultipleLineBreaks = spacers.length > 0
          && spacers.some(t => hasTwoNewlines(t.raw));
        list.loose = hasMultipleLineBreaks;
      }
    }
    for (const item of list.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(this.rules.other.listReplaceTask, '');
        first.raw = first.raw.replace(this.rules.other.listReplaceTask, '');
        first.text = first.text.replace(this.rules.other.listReplaceTask, '');
        for (let g = this.lexer.inlineQueue.length - 1; g >= 0; g--) {
          if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[g].src)) {
            this.lexer.inlineQueue[g].src = this.lexer.inlineQueue[g].src.replace(this.rules.other.listReplaceTask, '');
            break;
          }
        }
        const k = this.rules.other.listTaskCheckbox.exec(item.raw);
        if (k) {
          const checkbox = { type: 'checkbox', raw: k[0] + ' ', checked: k[0] !== '[ ]' };
          item.checked = checkbox.checked;
          if (list.loose) {
            const t0 = item.tokens[0];
            if (t0 && (t0.type === 'paragraph' || t0.type === 'text') && 'tokens' in t0 && t0.tokens) {
              t0.raw = checkbox.raw + t0.raw;
              t0.text = checkbox.raw + t0.text;
              t0.tokens.unshift(checkbox);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
            }
          } else {
            item.tokens.unshift(checkbox);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const token of item.tokens) {
          if (token.type === 'text') token.type = 'paragraph';
        }
      }
    }
    return list;
  }
}
