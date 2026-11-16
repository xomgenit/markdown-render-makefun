// parse.js — a faster drop-in for marked 18.1.3 with its default options
// (GFM on, breaks off, pedantic off, async off).
//
// The entry keeps marked's own tokenizer and renderer, so every input renders
// exactly the HTML marked renders. The speed comes from skipping work marked
// repeats for every block and every inline position:
//
//   1. The block and inline tokenizers are guarded by cheap first-character
//      tests: a rule whose pattern provably cannot match at the current
//      position returns undefined without running its regex. (emStrong and
//      del are deliberately left alone: marked skips its emphasis masking
//      when they are the stock methods, and overriding them would switch
//      that masking on for every inline run.)
//   2. Inline tokenization of a run of text with no inline markup at all is
//      short-circuited to a single text token, which is exactly what marked's
//      inline loop produces for such a run.
//   3. For runs that do hold markup, a reimplementation of marked's inline
//      loop dispatches on the character instead of trying every rule at
//      every position, finds text runs by scanning instead of by the text
//      regex, and computes the emphasis mask lazily. The tokenizers it
//      calls are still marked's own, in marked's order.
//   4. The carriage-return normalization is skipped when the input holds no
//      carriage return.
//   5. One Lexer/Parser pair is reused across calls, with its per-document
//      state reset before each parse, instead of allocating a fresh pair
//      (and fresh option objects) per document.
//
// Nothing is cached across calls: parse() is stateless per call, no input is
// ever recognized or looked up, and no output is ever stored.
//
// marked itself is vendored under vendor/marked/ under its MIT licence
// (vendor/marked/LICENSE, vendor/marked/NOTICE); this file only builds on
// its public classes.

import { Lexer, Parser, Tokenizer } from './vendor/marked/marked.esm.js';

// ---------------------------------------------------------------------------
// Small character helpers. Everything works on char codes and never allocates.
// ---------------------------------------------------------------------------

function isDigit(c) {
  return c >= 48 && c <= 57;
}

function isAlnum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// Characters allowed in the local part of an e-mail address in a GFM
// autolink: [A-Za-z0-9._+-]
function isMailLocal(c) {
  return isAlnum(c) || c === 46 || c === 95 || c === 43 || c === 45;
}

// Characters allowed in a domain name: [A-Za-z0-9-_]
function isDomainChar(c) {
  return isAlnum(c) || c === 45 || c === 95;
}

// Index of the first character after at most three leading spaces. Most block
// rules allow up to three spaces of indent, so a guard that reads the first
// significant character has to skip them first.
function afterSpaces3(src) {
  let i = 0;
  while (i < 3 && src.charCodeAt(i) === 32) i++;
  return i;
}

// Is there an http:// or https:// URL starting at index i (any letter case)?
function isHttpAt(src, i) {
  const c1 = src.charCodeAt(i + 1);
  const c2 = src.charCodeAt(i + 2);
  const c3 = src.charCodeAt(i + 3);
  if ((c1 !== 116 && c1 !== 84) || (c2 !== 116 && c2 !== 84) || (c3 !== 112 && c3 !== 80)) return false;
  const c4 = src.charCodeAt(i + 4);
  if (c4 === 58) return true; // http:
  return (c4 === 115 || c4 === 83) && src.charCodeAt(i + 5) === 58; // https:
}

// Is there an ftp:// URL starting at index i (any letter case)?
function isFtpAt(src, i) {
  const c1 = src.charCodeAt(i + 1);
  const c2 = src.charCodeAt(i + 2);
  return (c1 === 116 || c1 === 84) && (c2 === 112 || c2 === 80) && src.charCodeAt(i + 3) === 58;
}

// Is this character one that may precede a www. autolink? Marked's text
// rule only stops at www. when the previous character is whitespace or one
// of * _ ~ (, or when there is no previous character at all.
function isWwwPrefixChar(c) {
  if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 42 || c === 95 || c === 126 || c === 40) return true;
  // Non-ASCII whitespace (NBSP and friends) — rare, fall back to the regex.
  if (c >= 128) return /\s/.test(String.fromCharCode(c));
  return false;
}

// Is there an e-mail address with its '@' at index i? The address needs
// local-part characters before the '@' and a dotted domain after it.
function isEmailAt(src, i) {
  if (!isMailLocal(src.charCodeAt(i - 1))) return false;
  let j = i + 1;
  let n = 0;
  while (isDomainChar(src.charCodeAt(j))) {
    j++;
    n++;
  }
  if (n === 0 || src.charCodeAt(j) !== 46) return false; // needs a dot
  j++;
  let sawAlnum = false;
  while (isDomainChar(src.charCodeAt(j))) {
    if (isAlnum(src.charCodeAt(j))) sawAlnum = true;
    j++;
  }
  return sawAlnum;
}

// Replicates marked's internal label normalizer (used for link-reference
// lookup): trim, collapse whitespace, lower -> upper -> lower.
function normalizeLabel(label, multipleSpaceGlobal) {
  return label.trim().replace(multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Replicates marked's internal unescape: decodes numeric character references
// (&#169; / &#xA9; -> the character, with the replacement-char rules) and
// escapes bare '&' to '&amp;'. Named entities are NOT decoded (marked leaves
// &copy; / &amp; / &nbsp; untouched here; the renderer handles the rest).
// Uses marked's own regexes (passed in) so the match set is identical.
function unescapeNumeric(text, other) {
  if (!other.numericCharacterReference.test(text)) return text;
  return text.replace(other.numericCharacterReferenceOrAmpersand, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// Is there an e-mail address starting at index i? The local part is
// [A-Za-z0-9._+-]+, then '@', then a domain (see isEmailAt).
function isEmailStartAt(src, i) {
  let j = i;
  while (isMailLocal(src.charCodeAt(j))) j++;
  if (src.charCodeAt(j) !== 64) return false; // needs '@'
  return isEmailAt(src, j);
}

// ---------------------------------------------------------------------------
// Block-rule guards: necessary conditions for the expensive rules.
// Each returns false only when the rule provably cannot match; a true answer
// just hands the text to marked's own tokenizer.
// ---------------------------------------------------------------------------

// A table needs a non-blank first line and, on the next line, a delimiter
// row: up to three spaces, an optional pipe, an optional colon, then a dash.
function maybeTable(src) {
  const nl = src.indexOf('\n');
  if (nl < 0) return false;
  let i = 0;
  while (i < nl && src.charCodeAt(i) === 32) i++;
  if (i >= nl) return false; // first line blank
  let j = nl + 1;
  let sp = 0;
  while (sp < 3 && src.charCodeAt(j) === 32) {
    j++;
    sp++;
  }
  if (src.charCodeAt(j) === 124) {
    // '|': skip it and the spaces after it
    j++;
    while (src.charCodeAt(j) === 32) j++;
  }
  if (src.charCodeAt(j) === 58) j++; // ':'
  return src.charCodeAt(j) === 45; // '-'
}

// A setext underline is a line of only '=' or only '-' (after up to three
// leading spaces, with only spaces or tabs after it), on some line after the
// first and before any blank line. Without one, the lheading rule cannot
// match: its text part cannot span a blank line, and the underline must sit
// on a line of its own.
function maybeLheading(src) {
  let start = src.indexOf('\n');
  if (start < 0) return false;
  start += 1;
  while (start < src.length) {
    let end = src.indexOf('\n', start);
    if (end < 0) end = src.length;
    let j = start;
    let sp = 0;
    while (sp < 3 && src.charCodeAt(j) === 32) {
      j++;
      sp++;
    }
    const c = src.charCodeAt(j);
    if (c === 61 || c === 45) {
      // '=' or '-': an underline only if the rest of the line holds nothing
      // but the same character, spaces and tabs.
      let k = j + 1;
      let ok = true;
      while (k < end) {
        const cc = src.charCodeAt(k);
        if (cc !== c && cc !== 32 && cc !== 9) {
          ok = false;
          break;
        }
        k++;
      }
      if (ok) return true;
    } else {
      // A blank line ends the reach of the lheading text.
      let k = start;
      let blank = true;
      while (k < end) {
        const cc = src.charCodeAt(k);
        if (cc !== 32 && cc !== 9) {
          blank = false;
          break;
        }
        k++;
      }
      if (blank) return false;
    }
    start = end + 1;
  }
  return false;
}

// The url rule can only match at a position starting a scheme (http://,
// https://, ftp://), www., mailto:, xmpp:, or an e-mail address.
function maybeUrl(src) {
  const c0 = src.charCodeAt(0);
  if (c0 === 104 || c0 === 72) {
    if (isHttpAt(src, 0)) return true;
  } else if (c0 === 102 || c0 === 70) {
    if (isFtpAt(src, 0)) return true;
  } else if (c0 === 119) {
    if (src.charCodeAt(1) === 119 && src.charCodeAt(2) === 119 && src.charCodeAt(3) === 46) return true;
  } else if (c0 === 109) {
    if (src.startsWith('mailto:')) return true;
  } else if (c0 === 120) {
    if (src.startsWith('xmpp:')) return true;
  }
  // E-mail: local-part characters, then '@'.
  if (!isMailLocal(c0)) return false;
  let i = 1;
  while (isMailLocal(src.charCodeAt(i))) i++;
  return src.charCodeAt(i) === 64;
}

// ---------------------------------------------------------------------------
// Guarded tokenizer: every rule first checks the cheapest necessary condition
// for its pattern, and only runs the regex when the rule might match.
// emStrong and del are intentionally NOT overridden (see the header note).
// ---------------------------------------------------------------------------

class GuardedTokenizer extends Tokenizer {
  space(src) {
    const c = src.charCodeAt(0);
    // newline rule: /^(?:[ \t]*(?:\n|$))+/ — needs \n, space or tab first
    if (c !== 10 && c !== 32 && c !== 9) return undefined;
    return super.space(src);
  }

  code(src) {
    // code rule: /^((?: {4}| {0,3}\t)[^\n]+\n*)+/"
    // needs four spaces, or a tab within the first four columns
    const c0 = src.charCodeAt(0);
    if (c0 === 9) return super.code(src);
    if (c0 !== 32) return undefined;
    const c1 = src.charCodeAt(1);
    if (c1 === 9) return super.code(src);
    if (c1 !== 32) return undefined;
    const c2 = src.charCodeAt(2);
    if (c2 === 9) return super.code(src);
    if (c2 !== 32) return undefined;
    const c3 = src.charCodeAt(3);
    if (c3 === 9 || c3 === 32) return super.code(src);
    return undefined;
  }

  fences(src) {
    const c = src.charCodeAt(afterSpaces3(src));
    if (c !== 96 && c !== 126) return undefined;
    return super.fences(src);
  }

  heading(src) {
    if (src.charCodeAt(afterSpaces3(src)) !== 35) return undefined;
    return super.heading(src);
  }

  hr(src) {
    const c = src.charCodeAt(afterSpaces3(src));
    if (c !== 45 && c !== 95 && c !== 42) return undefined;
    return super.hr(src);
  }

  blockquote(src) {
    if (src.charCodeAt(afterSpaces3(src)) !== 62) return undefined;
    return super.blockquote(src);
  }

  list(src) {
    const c = src.charCodeAt(afterSpaces3(src));
    if (c !== 42 && c !== 43 && c !== 45 && !isDigit(c)) return undefined;
    return super.list(src);
  }

  html(src) {
    if (src.charCodeAt(afterSpaces3(src)) !== 60) return undefined;
    return super.html(src);
  }

  def(src) {
    if (src.charCodeAt(afterSpaces3(src)) !== 91) return undefined;
    return super.def(src);
  }

  table(src) {
    if (!maybeTable(src)) return undefined;
    return super.table(src);
  }

  lheading(src) {
    if (!maybeLheading(src)) return undefined;
    return super.lheading(src);
  }

  escape(src) {
    if (src.charCodeAt(0) !== 92) return undefined;
    return super.escape(src);
  }

  tag(src) {
    if (src.charCodeAt(0) !== 60) return undefined;
    return super.tag(src);
  }

  link(src) {
    const c0 = src.charCodeAt(0);
    if (c0 !== 91 && !(c0 === 33 && src.charCodeAt(1) === 91)) return undefined;
    return super.link(src);
  }

  reflink(src, links) {
    const c0 = src.charCodeAt(0);
    if (c0 !== 91 && !(c0 === 33 && src.charCodeAt(1) === 91)) return undefined;
    return super.reflink(src, links);
  }

  codespan(src) {
    if (src.charCodeAt(0) !== 96) return undefined;
    return super.codespan(src);
  }

  br(src) {
    const c0 = src.charCodeAt(0);
    if (c0 === 92) return super.br(src);
    if (c0 === 32 && src.charCodeAt(1) === 32) return super.br(src);
    return undefined;
  }

  autolink(src) {
    if (src.charCodeAt(0) !== 60) return undefined;
    return super.autolink(src);
  }

  url(src) {
    if (!maybeUrl(src)) return undefined;
    return super.url(src);
  }
}

// ---------------------------------------------------------------------------
// Plain-text fast path for inline tokenization.
// ---------------------------------------------------------------------------

// True when `src` holds no inline markup at all: no escapes, tags, links,
// emphasis, code spans, entities, autolinks, hard breaks or strikethrough.
// For such a run marked's inline loop yields exactly one text token whose
// text is the run itself (its entity decoding is a no-op without '&', and
// its hard-break rule needs two spaces before a newline), so the token can
// be produced directly.
function isPlainInline(src) {
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const c = src.charCodeAt(i);
    if (
      c === 92 || // \ escape
      c === 60 || // < tag / autolink
      c === 91 || // [ link / reflink
      c === 96 || // ` code span
      c === 42 || // * emphasis
      c === 95 || // _ emphasis
      c === 38 || // & entity
      c === 126 // ~ strikethrough
    ) {
      return false;
    }
    if (c === 33) {
      // '!' matters only before '[' (an image).
      if (src.charCodeAt(i + 1) === 91) return false;
    } else if (c === 10) {
      // Hard break: two spaces before a newline.
      if (src.charCodeAt(i - 1) === 32 && src.charCodeAt(i - 2) === 32) return false;
    } else if (c === 64) {
      // '@': an e-mail address autolinks.
      if (isEmailAt(src, i)) return false;
    } else if (c === 104 || c === 72) {
      if (isHttpAt(src, i)) return false;
    } else if (c === 102 || c === 70) {
      if (isFtpAt(src, i)) return false;
    } else if (c === 119) {
      if (
        src.charCodeAt(i + 1) === 119 &&
        src.charCodeAt(i + 2) === 119 &&
        src.charCodeAt(i + 3) === 46
      ) {
        return false; // www.
      }
    } else if (c === 109) {
      if (src.startsWith('mailto:', i)) return false;
    } else if (c === 120) {
      if (src.startsWith('xmpp:', i)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Lexer: same pipeline as marked's, with the carriage-return skip and the
// plain-text inline shortcut.
// ---------------------------------------------------------------------------

const CARRIAGE_RETURN = /\r\n|\r/g;

class FastLexer extends Lexer {
  lex(src) {
    if (src.indexOf('\r') !== -1) src = src.replace(CARRIAGE_RETURN, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const item = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(item.src, item.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  inlineTokens(src, tokens = []) {
    if (isPlainInline(src)) {
      tokens.push({
        type: 'text',
        raw: src,
        text: src,
        escaped: this.state.inRawBlock,
      });
      return tokens;
    }
    return this.inlineLoop(src, tokens);
  }

  // Replicates marked's private emphasis mask. The mask replaces link
  // references, code spans and escapes with placeholder characters of the
  // same length, so emphasis delimiters inside them cannot open or close.
  // It is length-preserving, which is what lets emStrong/del line the mask
  // up with the original text by offset.
  computeMask(src) {
    const inline = this.tokenizer.rules.inline;
    const other = this.tokenizer.rules.other;
    let t = src;
    if (this.tokens.links && src.includes('[')) {
      const n = inline.reflinkSearch;
      const maskReflink = (r) => {
        const o = r.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normalizeLabel(r.slice(o + 1, -1), other.multipleSpaceGlobal))) return r;
        if (o > 1 && r.charAt(0) !== '!') {
          const i = r.slice(1, o - 1);
          if (this.linkInText(i)) return '[' + i.replace(n, maskReflink) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
        return '[' + 'a'.repeat(r.length - 2) + ']';
      };
      t = t.replace(n, maskReflink);
    }
    t = t.replace(inline.anyPunctuationOutsideCode, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
    t = t.replace(inline.blockSkip, (n, s, r) => {
      const o = r ? r.length : 0;
      return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
    });
    return this.options.hooks?.emStrongMask?.call({ lexer: this }, t) ?? t;
  }

  // A direct reimplementation of marked's inline loop: the same tokenizers
  // are tried in the same order at the same positions, but the loop
  // dispatches on the character instead of trying every rule at every
  // position, and text runs are found by scanning instead of by the text
  // regex. The emphasis mask is computed lazily (only when a delimiter
  // could actually open emphasis) and cached for the rest of the call.
  // Text runs merge with a preceding text token exactly as marked's loop
  // merges them, and the previous-character value `r` that emStrong/del
  // read follows the same rules (last char of the previous text run,
  // unless it is '_'; reset after any non-text token).
  inlineLoop(src, tokens) {
    const tz = this.tokenizer;
    const other = tz.rules.other;
    const n = src.length;
    const savedLinkParen = this.state.linkParenPossible;
    this.state.linkParenPossible = savedLinkParen && src.includes(')');
    // No '@' in the text means no e-mail autolink can exist, so the
    // word-start address check can be skipped for the whole run.
    const hasAt = src.includes('@');
    let masked = null;
    let r = '';
    let i = 0;
    let runStart = 0;
    try {
      // The loop also runs while a text run is still pending: a failed
      // dispatch at the very last character leaves i at the end with one
      // character of run un-emitted, and that character must still come out.
      while (i < n || runStart < n) {
        // Find the next position where a rule could match.
        let stop = -1;
        let j = i;
        while (j < n) {
          const c = src.charCodeAt(j);
          // Word start with an e-mail address: the autolink is tried before
          // any rule that could match inside the word (marked's text regex
          // stops at the address start, and the url rule is what the loop
          // reaches there). Checking at the word start, rather than
          // backtracking from '@', also keeps the stop ahead of the scan.
          if (hasAt && isMailLocal(c) && (j === runStart || !isMailLocal(src.charCodeAt(j - 1)))) {
            if (isEmailStartAt(src, j)) {
              stop = j;
              break;
            }
          }
          if (c === 92 || c === 60 || c === 96 || c === 42 || c === 95 || c === 126 || c === 91) {
            stop = j;
            break;
          }
          if (c === 33 && src.charCodeAt(j + 1) === 91) {
            stop = j;
            break;
          }
          if (c === 10) {
            // Newline: a hard break needs two or more spaces right before
            // it, inside the part of the run not scanned yet. The run stops
            // at the first of them.
            let k = j - 1;
            while (k >= i && src.charCodeAt(k) === 32) k--;
            if (j - 1 - k >= 2) {
              stop = k + 1;
              break;
            }
          } else if (c === 119) {
            // www. only autolinks at the start of the run or after
            // whitespace or * _ ~ ( — mid-word it is plain text.
            if (
              src.charCodeAt(j + 1) === 119 &&
              src.charCodeAt(j + 2) === 119 &&
              src.charCodeAt(j + 3) === 46 &&
              (j === runStart || isWwwPrefixChar(src.charCodeAt(j - 1)))
            ) {
              stop = j;
              break;
            }
          } else if (c === 104 || c === 72) {
            if (isHttpAt(src, j)) {
              stop = j;
              break;
            }
          } else if (c === 102 || c === 70) {
            if (isFtpAt(src, j)) {
              stop = j;
              break;
            }
          } else if (c === 109) {
            // mailto: only autolinks at the start of the run or after a
            // non-alphanumeric character — mid-word it is plain text (and
            // the address after the colon may still autolink as e-mail).
            if (src.startsWith('mailto:', j) && (j === runStart || !isAlnum(src.charCodeAt(j - 1)))) {
              stop = j;
              break;
            }
          } else if (c === 120) {
            if (src.startsWith('xmpp:', j) && (j === runStart || !isAlnum(src.charCodeAt(j - 1)))) {
              stop = j;
              break;
            }
          }
          j++;
        }
        if (stop < 0) stop = n;
        // Emit the text run before the stop, merged with a preceding text
        // token. In a raw block the text is not unescaped.
        if (stop > runStart) {
          const raw = src.slice(runStart, stop);
          const text = this.state.inRawBlock || !raw.includes('&') ? raw : unescapeNumeric(raw, other);
          const last = tokens[tokens.length - 1];
          if (last && last.type === 'text') {
            last.raw += raw;
            last.text += text;
          } else {
            tokens.push({ type: 'text', raw, text, escaped: this.state.inRawBlock });
          }
          const lastChar = raw.charCodeAt(raw.length - 1);
          if (lastChar !== 95) r = raw.slice(-1);
          i = stop;
          runStart = stop;
        }
        if (stop >= n) break;
        // Dispatch at the stop position, in marked's rule order, restricted
        // to the rules that can match at this character.
        const c = src.charCodeAt(stop);
        const rest = src.slice(stop);
        let tok;
        if (c === 92) {
          tok = tz.escape(rest) || tz.br(rest);
        } else if (c === 60) {
          tok = tz.tag(rest) || tz.autolink(rest);
        } else if (c === 91 || c === 33) {
          tok = tz.link(rest) || tz.reflink(rest, this.tokens.links);
        } else if (c === 96) {
          tok = tz.codespan(rest);
        } else if (c === 42) {
          tok = tz.emStrong(rest, masked ??= this.computeMask(src), r);
        } else if (c === 95) {
          // '_' is also an e-mail local character: after emStrong fails,
          // marked's loop still tries the url rule here.
          tok = tz.emStrong(rest, masked ??= this.computeMask(src), r)
            || (!this.state.inLink ? tz.url(rest) : undefined);
        } else if (c === 126) {
          tok = tz.del(rest, masked ??= this.computeMask(src), r);
        } else if (c === 32) {
          tok = tz.br(rest);
        } else {
          // URL start (www. / scheme / e-mail word start), unless inside
          // a link already.
          tok = this.state.inLink ? undefined : tz.url(rest);
        }
        if (tok) {
          if (tok.type === 'text') {
            // Only reflink returns text tokens (an unresolved reference,
            // just its first character): merge it, but do not touch r.
            const last = tokens[tokens.length - 1];
            if (last && last.type === 'text') {
              last.raw += tok.raw;
              last.text += tok.text;
            } else {
              tokens.push(tok);
            }
          } else {
            tokens.push(tok);
          }
          r = '';
          i = stop + tok.raw.length;
          runStart = i;
        } else {
          // No rule matched: the character is literal text. A run of
          // backticks or tildes is consumed whole here (marked's text rule
          // takes the whole run as the first character of its match, so a
          // shorter run left behind must not pair up with a later one);
          // anything else advances by one character.
          if (c === 96 || c === 126) {
            let k = stop + 1;
            while (k < n && src.charCodeAt(k) === c) k++;
            i = k;
          } else {
            i = stop + 1;
          }
          runStart = stop;
        }
      }
    } finally {
      this.state.linkParenPossible = savedLinkParen;
    }
    return tokens;
  }
}

// ---------------------------------------------------------------------------
// One shared Lexer/Parser pair, reset before every parse. marked's parse()
// allocates a fresh Lexer, Parser, Tokenizer and option objects per document;
// the pair here is stateless across calls once its per-document fields are
// cleared (token list, link definitions, inline queue, lexer state).
// ---------------------------------------------------------------------------

const sharedTokenizer = new GuardedTokenizer();

const lexer = new FastLexer({
  async: false,
  breaks: false,
  extensions: null,
  gfm: true,
  hooks: null,
  pedantic: false,
  renderer: null,
  silent: false,
  tokenizer: sharedTokenizer,
  walkTokens: null,
});

const parser = new Parser({
  async: false,
  breaks: false,
  extensions: null,
  gfm: true,
  hooks: null,
  pedantic: false,
  renderer: null,
  silent: false,
  tokenizer: null,
  walkTokens: null,
});

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  lexer.tokens = [];
  lexer.tokens.links = Object.create(null);
  lexer.inlineQueue = [];
  lexer.state.inLink = false;
  lexer.state.inRawBlock = false;
  lexer.state.linkEmitted = false;
  lexer.state.linkParenPossible = true;
  lexer.state.top = true;
  return parser.parse(lexer.lex(markdown));
}
