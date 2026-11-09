"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/css-tree/cjs/tokenizer/types.cjs
var require_types = __commonJS({
  "node_modules/css-tree/cjs/tokenizer/types.cjs"(exports2) {
    "use strict";
    var EOF = 0;
    var Ident = 1;
    var Function = 2;
    var AtKeyword = 3;
    var Hash = 4;
    var String2 = 5;
    var BadString = 6;
    var Url = 7;
    var BadUrl = 8;
    var Delim = 9;
    var Number2 = 10;
    var Percentage = 11;
    var Dimension = 12;
    var WhiteSpace = 13;
    var CDO = 14;
    var CDC = 15;
    var Colon = 16;
    var Semicolon = 17;
    var Comma = 18;
    var LeftSquareBracket = 19;
    var RightSquareBracket = 20;
    var LeftParenthesis = 21;
    var RightParenthesis = 22;
    var LeftCurlyBracket = 23;
    var RightCurlyBracket = 24;
    var Comment = 25;
    exports2.AtKeyword = AtKeyword;
    exports2.BadString = BadString;
    exports2.BadUrl = BadUrl;
    exports2.CDC = CDC;
    exports2.CDO = CDO;
    exports2.Colon = Colon;
    exports2.Comma = Comma;
    exports2.Comment = Comment;
    exports2.Delim = Delim;
    exports2.Dimension = Dimension;
    exports2.EOF = EOF;
    exports2.Function = Function;
    exports2.Hash = Hash;
    exports2.Ident = Ident;
    exports2.LeftCurlyBracket = LeftCurlyBracket;
    exports2.LeftParenthesis = LeftParenthesis;
    exports2.LeftSquareBracket = LeftSquareBracket;
    exports2.Number = Number2;
    exports2.Percentage = Percentage;
    exports2.RightCurlyBracket = RightCurlyBracket;
    exports2.RightParenthesis = RightParenthesis;
    exports2.RightSquareBracket = RightSquareBracket;
    exports2.Semicolon = Semicolon;
    exports2.String = String2;
    exports2.Url = Url;
    exports2.WhiteSpace = WhiteSpace;
  }
});

// node_modules/css-tree/cjs/tokenizer/char-code-definitions.cjs
var require_char_code_definitions = __commonJS({
  "node_modules/css-tree/cjs/tokenizer/char-code-definitions.cjs"(exports2) {
    "use strict";
    var EOF = 0;
    function isDigit(code) {
      return code >= 48 && code <= 57;
    }
    function isHexDigit(code) {
      return isDigit(code) || // 0 .. 9
      code >= 65 && code <= 70 || // A .. F
      code >= 97 && code <= 102;
    }
    function isUppercaseLetter(code) {
      return code >= 65 && code <= 90;
    }
    function isLowercaseLetter(code) {
      return code >= 97 && code <= 122;
    }
    function isLetter(code) {
      return isUppercaseLetter(code) || isLowercaseLetter(code);
    }
    function isNonAscii(code) {
      return code >= 128;
    }
    function isNameStart(code) {
      return isLetter(code) || isNonAscii(code) || code === 95;
    }
    function isName(code) {
      return isNameStart(code) || isDigit(code) || code === 45;
    }
    function isNonPrintable(code) {
      return code >= 0 && code <= 8 || code === 11 || code >= 14 && code <= 31 || code === 127;
    }
    function isNewline(code) {
      return code === 10 || code === 13 || code === 12;
    }
    function isWhiteSpace(code) {
      return isNewline(code) || code === 32 || code === 9;
    }
    function isValidEscape(first, second) {
      if (first !== 92) {
        return false;
      }
      if (isNewline(second) || second === EOF) {
        return false;
      }
      return true;
    }
    function isIdentifierStart(first, second, third) {
      if (first === 45) {
        return isNameStart(second) || second === 45 || isValidEscape(second, third);
      }
      if (isNameStart(first)) {
        return true;
      }
      if (first === 92) {
        return isValidEscape(first, second);
      }
      return false;
    }
    function isNumberStart(first, second, third) {
      if (first === 43 || first === 45) {
        if (isDigit(second)) {
          return 2;
        }
        return second === 46 && isDigit(third) ? 3 : 0;
      }
      if (first === 46) {
        return isDigit(second) ? 2 : 0;
      }
      if (isDigit(first)) {
        return 1;
      }
      return 0;
    }
    function isBOM(code) {
      if (code === 65279) {
        return 1;
      }
      if (code === 65534) {
        return 1;
      }
      return 0;
    }
    var CATEGORY = new Array(128);
    var EofCategory = 128;
    var WhiteSpaceCategory = 130;
    var DigitCategory = 131;
    var NameStartCategory = 132;
    var NonPrintableCategory = 133;
    for (let i = 0; i < CATEGORY.length; i++) {
      CATEGORY[i] = isWhiteSpace(i) && WhiteSpaceCategory || isDigit(i) && DigitCategory || isNameStart(i) && NameStartCategory || isNonPrintable(i) && NonPrintableCategory || i || EofCategory;
    }
    function charCodeCategory(code) {
      return code < 128 ? CATEGORY[code] : NameStartCategory;
    }
    exports2.DigitCategory = DigitCategory;
    exports2.EofCategory = EofCategory;
    exports2.NameStartCategory = NameStartCategory;
    exports2.NonPrintableCategory = NonPrintableCategory;
    exports2.WhiteSpaceCategory = WhiteSpaceCategory;
    exports2.charCodeCategory = charCodeCategory;
    exports2.isBOM = isBOM;
    exports2.isDigit = isDigit;
    exports2.isHexDigit = isHexDigit;
    exports2.isIdentifierStart = isIdentifierStart;
    exports2.isLetter = isLetter;
    exports2.isLowercaseLetter = isLowercaseLetter;
    exports2.isName = isName;
    exports2.isNameStart = isNameStart;
    exports2.isNewline = isNewline;
    exports2.isNonAscii = isNonAscii;
    exports2.isNonPrintable = isNonPrintable;
    exports2.isNumberStart = isNumberStart;
    exports2.isUppercaseLetter = isUppercaseLetter;
    exports2.isValidEscape = isValidEscape;
    exports2.isWhiteSpace = isWhiteSpace;
  }
});

// node_modules/css-tree/cjs/tokenizer/utils.cjs
var require_utils = __commonJS({
  "node_modules/css-tree/cjs/tokenizer/utils.cjs"(exports2) {
    "use strict";
    var charCodeDefinitions = require_char_code_definitions();
    function getCharCode(source, offset) {
      return offset < source.length ? source.charCodeAt(offset) : 0;
    }
    function getNewlineLength(source, offset, code) {
      if (code === 13 && getCharCode(source, offset + 1) === 10) {
        return 2;
      }
      return 1;
    }
    function cmpChar(testStr, offset, referenceCode) {
      let code = testStr.charCodeAt(offset);
      if (charCodeDefinitions.isUppercaseLetter(code)) {
        code = code | 32;
      }
      return code === referenceCode;
    }
    function cmpStr(testStr, start, end, referenceStr) {
      if (end - start !== referenceStr.length) {
        return false;
      }
      if (start < 0 || end > testStr.length) {
        return false;
      }
      for (let i = start; i < end; i++) {
        const referenceCode = referenceStr.charCodeAt(i - start);
        let testCode = testStr.charCodeAt(i);
        if (charCodeDefinitions.isUppercaseLetter(testCode)) {
          testCode = testCode | 32;
        }
        if (testCode !== referenceCode) {
          return false;
        }
      }
      return true;
    }
    function findWhiteSpaceStart(source, offset) {
      for (; offset >= 0; offset--) {
        if (!charCodeDefinitions.isWhiteSpace(source.charCodeAt(offset))) {
          break;
        }
      }
      return offset + 1;
    }
    function findWhiteSpaceEnd(source, offset) {
      for (; offset < source.length; offset++) {
        if (!charCodeDefinitions.isWhiteSpace(source.charCodeAt(offset))) {
          break;
        }
      }
      return offset;
    }
    function findDecimalNumberEnd(source, offset) {
      for (; offset < source.length; offset++) {
        if (!charCodeDefinitions.isDigit(source.charCodeAt(offset))) {
          break;
        }
      }
      return offset;
    }
    function consumeEscaped(source, offset) {
      offset += 2;
      if (charCodeDefinitions.isHexDigit(getCharCode(source, offset - 1))) {
        for (const maxOffset = Math.min(source.length, offset + 5); offset < maxOffset; offset++) {
          if (!charCodeDefinitions.isHexDigit(getCharCode(source, offset))) {
            break;
          }
        }
        const code = getCharCode(source, offset);
        if (charCodeDefinitions.isWhiteSpace(code)) {
          offset += getNewlineLength(source, offset, code);
        }
      }
      return offset;
    }
    function consumeName(source, offset) {
      for (; offset < source.length; offset++) {
        const code = source.charCodeAt(offset);
        if (charCodeDefinitions.isName(code)) {
          continue;
        }
        if (charCodeDefinitions.isValidEscape(code, getCharCode(source, offset + 1))) {
          offset = consumeEscaped(source, offset) - 1;
          continue;
        }
        break;
      }
      return offset;
    }
    function consumeNumber(source, offset) {
      let code = source.charCodeAt(offset);
      if (code === 43 || code === 45) {
        code = source.charCodeAt(offset += 1);
      }
      if (charCodeDefinitions.isDigit(code)) {
        offset = findDecimalNumberEnd(source, offset + 1);
        code = source.charCodeAt(offset);
      }
      if (code === 46 && charCodeDefinitions.isDigit(source.charCodeAt(offset + 1))) {
        offset += 2;
        offset = findDecimalNumberEnd(source, offset);
      }
      if (cmpChar(
        source,
        offset,
        101
        /* e */
      )) {
        let sign = 0;
        code = source.charCodeAt(offset + 1);
        if (code === 45 || code === 43) {
          sign = 1;
          code = source.charCodeAt(offset + 2);
        }
        if (charCodeDefinitions.isDigit(code)) {
          offset = findDecimalNumberEnd(source, offset + 1 + sign + 1);
        }
      }
      return offset;
    }
    function consumeBadUrlRemnants(source, offset) {
      for (; offset < source.length; offset++) {
        const code = source.charCodeAt(offset);
        if (code === 41) {
          offset++;
          break;
        }
        if (charCodeDefinitions.isValidEscape(code, getCharCode(source, offset + 1))) {
          offset = consumeEscaped(source, offset);
        }
      }
      return offset;
    }
    function decodeEscaped(escaped) {
      if (escaped.length === 1 && !charCodeDefinitions.isHexDigit(escaped.charCodeAt(0))) {
        return escaped[0];
      }
      let code = parseInt(escaped, 16);
      if (code === 0 || // If this number is zero,
      code >= 55296 && code <= 57343 || // or is for a surrogate,
      code > 1114111) {
        code = 65533;
      }
      return String.fromCodePoint(code);
    }
    exports2.cmpChar = cmpChar;
    exports2.cmpStr = cmpStr;
    exports2.consumeBadUrlRemnants = consumeBadUrlRemnants;
    exports2.consumeEscaped = consumeEscaped;
    exports2.consumeName = consumeName;
    exports2.consumeNumber = consumeNumber;
    exports2.decodeEscaped = decodeEscaped;
    exports2.findDecimalNumberEnd = findDecimalNumberEnd;
    exports2.findWhiteSpaceEnd = findWhiteSpaceEnd;
    exports2.findWhiteSpaceStart = findWhiteSpaceStart;
    exports2.getNewlineLength = getNewlineLength;
  }
});

// node_modules/css-tree/cjs/tokenizer/names.cjs
var require_names = __commonJS({
  "node_modules/css-tree/cjs/tokenizer/names.cjs"(exports2, module2) {
    "use strict";
    var tokenNames = [
      "EOF-token",
      "ident-token",
      "function-token",
      "at-keyword-token",
      "hash-token",
      "string-token",
      "bad-string-token",
      "url-token",
      "bad-url-token",
      "delim-token",
      "number-token",
      "percentage-token",
      "dimension-token",
      "whitespace-token",
      "CDO-token",
      "CDC-token",
      "colon-token",
      "semicolon-token",
      "comma-token",
      "[-token",
      "]-token",
      "(-token",
      ")-token",
      "{-token",
      "}-token",
      "comment-token"
    ];
    module2.exports = tokenNames;
  }
});

// node_modules/css-tree/cjs/tokenizer/adopt-buffer.cjs
var require_adopt_buffer = __commonJS({
  "node_modules/css-tree/cjs/tokenizer/adopt-buffer.cjs"(exports2) {
    "use strict";
    var MIN_SIZE = 16 * 1024;
    function adoptBuffer(buffer = null, size) {
      if (buffer === null || buffer.length < size) {
        return new Uint32Array(Math.max(size + 1024, MIN_SIZE));
      }
      return buffer;
    }
    exports2.adoptBuffer = adoptBuffer;
  }
});

// node_modules/css-tree/cjs/tokenizer/OffsetToLocation.cjs
var require_OffsetToLocation = __commonJS({
  "node_modules/css-tree/cjs/tokenizer/OffsetToLocation.cjs"(exports2) {
    "use strict";
    var adoptBuffer = require_adopt_buffer();
    var charCodeDefinitions = require_char_code_definitions();
    var N = 10;
    var F = 12;
    var R = 13;
    function computeLinesAndColumns(host) {
      const source = host.source;
      const sourceLength = source.length;
      const startOffset = source.length > 0 ? charCodeDefinitions.isBOM(source.charCodeAt(0)) : 0;
      const lines = adoptBuffer.adoptBuffer(host.lines, sourceLength);
      const columns = adoptBuffer.adoptBuffer(host.columns, sourceLength);
      let line = host.startLine;
      let column = host.startColumn;
      for (let i = startOffset; i < sourceLength; i++) {
        const code = source.charCodeAt(i);
        lines[i] = line;
        columns[i] = column++;
        if (code === N || code === R || code === F) {
          if (code === R && i + 1 < sourceLength && source.charCodeAt(i + 1) === N) {
            i++;
            lines[i] = line;
            columns[i] = column;
          }
          line++;
          column = 1;
        }
      }
      lines[sourceLength] = line;
      columns[sourceLength] = column;
      host.lines = lines;
      host.columns = columns;
      host.computed = true;
    }
    var OffsetToLocation = class {
      constructor(source, startOffset, startLine, startColumn) {
        this.setSource(source, startOffset, startLine, startColumn);
        this.lines = null;
        this.columns = null;
      }
      setSource(source = "", startOffset = 0, startLine = 1, startColumn = 1) {
        this.source = source;
        this.startOffset = startOffset;
        this.startLine = startLine;
        this.startColumn = startColumn;
        this.computed = false;
      }
      getLocation(offset, filename) {
        if (!this.computed) {
          computeLinesAndColumns(this);
        }
        return {
          source: filename,
          offset: this.startOffset + offset,
          line: this.lines[offset],
          column: this.columns[offset]
        };
      }
      getLocationRange(start, end, filename) {
        if (!this.computed) {
          computeLinesAndColumns(this);
        }
        return {
          source: filename,
          start: {
            offset: this.startOffset + start,
            line: this.lines[start],
            column: this.columns[start]
          },
          end: {
            offset: this.startOffset + end,
            line: this.lines[end],
            column: this.columns[end]
          }
        };
      }
    };
    exports2.OffsetToLocation = OffsetToLocation;
  }
});

// node_modules/css-tree/cjs/tokenizer/TokenStream.cjs
var require_TokenStream = __commonJS({
  "node_modules/css-tree/cjs/tokenizer/TokenStream.cjs"(exports2) {
    "use strict";
    var adoptBuffer = require_adopt_buffer();
    var utils = require_utils();
    var names = require_names();
    var types = require_types();
    var OFFSET_MASK = 16777215;
    var TYPE_SHIFT = 24;
    var BLOCK_OPEN_TOKEN = 1;
    var BLOCK_CLOSE_TOKEN = 2;
    var balancePair = new Uint8Array(32);
    balancePair[types.Function] = types.RightParenthesis;
    balancePair[types.LeftParenthesis] = types.RightParenthesis;
    balancePair[types.LeftSquareBracket] = types.RightSquareBracket;
    balancePair[types.LeftCurlyBracket] = types.RightCurlyBracket;
    var blockTokens = new Uint8Array(32);
    blockTokens[types.Function] = BLOCK_OPEN_TOKEN;
    blockTokens[types.LeftParenthesis] = BLOCK_OPEN_TOKEN;
    blockTokens[types.LeftSquareBracket] = BLOCK_OPEN_TOKEN;
    blockTokens[types.LeftCurlyBracket] = BLOCK_OPEN_TOKEN;
    blockTokens[types.RightParenthesis] = BLOCK_CLOSE_TOKEN;
    blockTokens[types.RightSquareBracket] = BLOCK_CLOSE_TOKEN;
    blockTokens[types.RightCurlyBracket] = BLOCK_CLOSE_TOKEN;
    function boundIndex(index, min, max) {
      return index < min ? min : index > max ? max : index;
    }
    var TokenStream = class {
      constructor(source, tokenize) {
        this.setSource(source, tokenize);
      }
      reset() {
        this.eof = false;
        this.tokenIndex = -1;
        this.tokenType = 0;
        this.tokenStart = this.firstCharOffset;
        this.tokenEnd = this.firstCharOffset;
      }
      setSource(source = "", tokenize = () => {
      }) {
        source = String(source || "");
        const sourceLength = source.length;
        const offsetAndType = adoptBuffer.adoptBuffer(this.offsetAndType, source.length + 1);
        const balance = adoptBuffer.adoptBuffer(this.balance, source.length + 1);
        let tokenCount = 0;
        let firstCharOffset = -1;
        let balanceCloseType = 0;
        let balanceStart = source.length;
        this.offsetAndType = null;
        this.balance = null;
        balance.fill(0);
        tokenize(source, (type, start, end) => {
          const index = tokenCount++;
          offsetAndType[index] = type << TYPE_SHIFT | end;
          if (firstCharOffset === -1) {
            firstCharOffset = start;
          }
          balance[index] = balanceStart;
          if (type === balanceCloseType) {
            const prevBalanceStart = balance[balanceStart];
            balance[balanceStart] = index;
            balanceStart = prevBalanceStart;
            balanceCloseType = balancePair[offsetAndType[prevBalanceStart] >> TYPE_SHIFT];
          } else if (this.isBlockOpenerTokenType(type)) {
            balanceStart = index;
            balanceCloseType = balancePair[type];
          }
        });
        offsetAndType[tokenCount] = types.EOF << TYPE_SHIFT | sourceLength;
        balance[tokenCount] = tokenCount;
        for (let i = 0; i < tokenCount; i++) {
          const balanceStart2 = balance[i];
          if (balanceStart2 <= i) {
            const balanceEnd = balance[balanceStart2];
            if (balanceEnd !== i) {
              balance[i] = balanceEnd;
            }
          } else if (balanceStart2 > tokenCount) {
            balance[i] = tokenCount;
          }
        }
        this.source = source;
        this.firstCharOffset = firstCharOffset === -1 ? 0 : firstCharOffset;
        this.tokenCount = tokenCount;
        this.offsetAndType = offsetAndType;
        this.balance = balance;
        this.reset();
        this.next();
      }
      lookupType(offset) {
        offset += this.tokenIndex;
        if (offset < this.tokenCount) {
          return this.offsetAndType[offset] >> TYPE_SHIFT;
        }
        return types.EOF;
      }
      lookupTypeNonSC(idx) {
        for (let offset = this.tokenIndex; offset < this.tokenCount; offset++) {
          const tokenType = this.offsetAndType[offset] >> TYPE_SHIFT;
          if (tokenType !== types.WhiteSpace && tokenType !== types.Comment) {
            if (idx-- === 0) {
              return tokenType;
            }
          }
        }
        return types.EOF;
      }
      lookupOffset(offset) {
        offset += this.tokenIndex;
        if (offset < this.tokenCount) {
          return this.offsetAndType[offset - 1] & OFFSET_MASK;
        }
        return this.source.length;
      }
      lookupOffsetNonSC(idx) {
        for (let offset = this.tokenIndex; offset < this.tokenCount; offset++) {
          const tokenType = this.offsetAndType[offset] >> TYPE_SHIFT;
          if (tokenType !== types.WhiteSpace && tokenType !== types.Comment) {
            if (idx-- === 0) {
              return offset - this.tokenIndex;
            }
          }
        }
        return types.EOF;
      }
      lookupValue(offset, referenceStr) {
        offset += this.tokenIndex;
        if (offset < this.tokenCount) {
          return utils.cmpStr(
            this.source,
            this.offsetAndType[offset - 1] & OFFSET_MASK,
            this.offsetAndType[offset] & OFFSET_MASK,
            referenceStr
          );
        }
        return false;
      }
      getTokenStart(tokenIndex) {
        if (tokenIndex === this.tokenIndex) {
          return this.tokenStart;
        }
        if (tokenIndex > 0) {
          return tokenIndex < this.tokenCount ? this.offsetAndType[tokenIndex - 1] & OFFSET_MASK : this.offsetAndType[this.tokenCount] & OFFSET_MASK;
        }
        return this.firstCharOffset;
      }
      getTokenEnd(tokenIndex) {
        if (tokenIndex === this.tokenIndex) {
          return this.tokenEnd;
        }
        return this.offsetAndType[boundIndex(tokenIndex, 0, this.tokenCount)] & OFFSET_MASK;
      }
      getTokenType(tokenIndex) {
        if (tokenIndex === this.tokenIndex) {
          return this.tokenType;
        }
        return this.offsetAndType[boundIndex(tokenIndex, 0, this.tokenCount)] >> TYPE_SHIFT;
      }
      substrToCursor(start) {
        return this.source.substring(start, this.tokenStart);
      }
      isBlockOpenerTokenType(tokenType) {
        return blockTokens[tokenType] === BLOCK_OPEN_TOKEN;
      }
      isBlockCloserTokenType(tokenType) {
        return blockTokens[tokenType] === BLOCK_CLOSE_TOKEN;
      }
      getBlockTokenPairIndex(tokenIndex) {
        const type = this.getTokenType(tokenIndex);
        if (blockTokens[type] === 1) {
          const pairIndex = this.balance[tokenIndex];
          const closeType = this.getTokenType(pairIndex);
          return balancePair[type] === closeType ? pairIndex : -1;
        } else if (blockTokens[type] === 2) {
          const pairIndex = this.balance[tokenIndex];
          const openType = this.getTokenType(pairIndex);
          return balancePair[openType] === type ? pairIndex : -1;
        }
        return -1;
      }
      isBalanceEdge(tokenIndex) {
        return this.balance[this.tokenIndex] < tokenIndex;
      }
      isDelim(code, offset) {
        if (offset) {
          return this.lookupType(offset) === types.Delim && this.source.charCodeAt(this.lookupOffset(offset)) === code;
        }
        return this.tokenType === types.Delim && this.source.charCodeAt(this.tokenStart) === code;
      }
      skip(tokenCount) {
        let next = this.tokenIndex + tokenCount;
        if (next < this.tokenCount) {
          this.tokenIndex = next;
          this.tokenStart = this.offsetAndType[next - 1] & OFFSET_MASK;
          next = this.offsetAndType[next];
          this.tokenType = next >> TYPE_SHIFT;
          this.tokenEnd = next & OFFSET_MASK;
        } else {
          this.tokenIndex = this.tokenCount;
          this.next();
        }
      }
      next() {
        let next = this.tokenIndex + 1;
        if (next < this.tokenCount) {
          this.tokenIndex = next;
          this.tokenStart = this.tokenEnd;
          next = this.offsetAndType[next];
          this.tokenType = next >> TYPE_SHIFT;
          this.tokenEnd = next & OFFSET_MASK;
        } else {
          this.eof = true;
          this.tokenIndex = this.tokenCount;
          this.tokenType = types.EOF;
          this.tokenStart = this.tokenEnd = this.source.length;
        }
      }
      skipSC() {
        while (this.tokenType === types.WhiteSpace || this.tokenType === types.Comment) {
          this.next();
        }
      }
      skipUntilBalanced(startToken, stopConsume) {
        let cursor = startToken;
        let balanceEnd = 0;
        let offset = 0;
        loop:
          for (; cursor < this.tokenCount; cursor++) {
            balanceEnd = this.balance[cursor];
            if (balanceEnd < startToken) {
              break loop;
            }
            offset = cursor > 0 ? this.offsetAndType[cursor - 1] & OFFSET_MASK : this.firstCharOffset;
            switch (stopConsume(this.source.charCodeAt(offset))) {
              case 1:
                break loop;
              case 2:
                cursor++;
                break loop;
              default:
                if (this.isBlockOpenerTokenType(this.offsetAndType[cursor] >> TYPE_SHIFT)) {
                  cursor = balanceEnd;
                }
            }
          }
        this.skip(cursor - this.tokenIndex);
      }
      forEachToken(fn) {
        for (let i = 0, offset = this.firstCharOffset; i < this.tokenCount; i++) {
          const start = offset;
          const item = this.offsetAndType[i];
          const end = item & OFFSET_MASK;
          const type = item >> TYPE_SHIFT;
          offset = end;
          fn(type, start, end, i);
        }
      }
      dump() {
        const tokens = new Array(this.tokenCount);
        this.forEachToken((type, start, end, index) => {
          tokens[index] = {
            idx: index,
            type: names[type],
            chunk: this.source.substring(start, end),
            balance: this.balance[index]
          };
        });
        return tokens;
      }
    };
    exports2.TokenStream = TokenStream;
  }
});

// node_modules/css-tree/cjs/tokenizer/index.cjs
var require_tokenizer = __commonJS({
  "node_modules/css-tree/cjs/tokenizer/index.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var charCodeDefinitions = require_char_code_definitions();
    var utils = require_utils();
    var names = require_names();
    var OffsetToLocation = require_OffsetToLocation();
    var TokenStream = require_TokenStream();
    function tokenize(source, onToken) {
      function getCharCode(offset2) {
        return offset2 < sourceLength ? source.charCodeAt(offset2) : 0;
      }
      function consumeNumericToken() {
        offset = utils.consumeNumber(source, offset);
        if (charCodeDefinitions.isIdentifierStart(getCharCode(offset), getCharCode(offset + 1), getCharCode(offset + 2))) {
          type = types.Dimension;
          offset = utils.consumeName(source, offset);
          return;
        }
        if (getCharCode(offset) === 37) {
          type = types.Percentage;
          offset++;
          return;
        }
        type = types.Number;
      }
      function consumeIdentLikeToken() {
        const nameStartOffset = offset;
        offset = utils.consumeName(source, offset);
        if (utils.cmpStr(source, nameStartOffset, offset, "url") && getCharCode(offset) === 40) {
          offset = utils.findWhiteSpaceEnd(source, offset + 1);
          if (getCharCode(offset) === 34 || getCharCode(offset) === 39) {
            type = types.Function;
            offset = nameStartOffset + 4;
            return;
          }
          consumeUrlToken();
          return;
        }
        if (getCharCode(offset) === 40) {
          type = types.Function;
          offset++;
          return;
        }
        type = types.Ident;
      }
      function consumeStringToken(endingCodePoint) {
        if (!endingCodePoint) {
          endingCodePoint = getCharCode(offset++);
        }
        type = types.String;
        for (; offset < source.length; offset++) {
          const code = source.charCodeAt(offset);
          switch (charCodeDefinitions.charCodeCategory(code)) {
            // ending code point
            case endingCodePoint:
              offset++;
              return;
            // EOF
            // case EofCategory:
            // This is a parse error. Return the <string-token>.
            // return;
            // newline
            case charCodeDefinitions.WhiteSpaceCategory:
              if (charCodeDefinitions.isNewline(code)) {
                offset += utils.getNewlineLength(source, offset, code);
                type = types.BadString;
                return;
              }
              break;
            // U+005C REVERSE SOLIDUS (\)
            case 92:
              if (offset === source.length - 1) {
                break;
              }
              const nextCode = getCharCode(offset + 1);
              if (charCodeDefinitions.isNewline(nextCode)) {
                offset += utils.getNewlineLength(source, offset + 1, nextCode);
              } else if (charCodeDefinitions.isValidEscape(code, nextCode)) {
                offset = utils.consumeEscaped(source, offset) - 1;
              }
              break;
          }
        }
      }
      function consumeUrlToken() {
        type = types.Url;
        offset = utils.findWhiteSpaceEnd(source, offset);
        for (; offset < source.length; offset++) {
          const code = source.charCodeAt(offset);
          switch (charCodeDefinitions.charCodeCategory(code)) {
            // U+0029 RIGHT PARENTHESIS ())
            case 41:
              offset++;
              return;
            // EOF
            // case EofCategory:
            // This is a parse error. Return the <url-token>.
            // return;
            // whitespace
            case charCodeDefinitions.WhiteSpaceCategory:
              offset = utils.findWhiteSpaceEnd(source, offset);
              if (getCharCode(offset) === 41 || offset >= source.length) {
                if (offset < source.length) {
                  offset++;
                }
                return;
              }
              offset = utils.consumeBadUrlRemnants(source, offset);
              type = types.BadUrl;
              return;
            // U+0022 QUOTATION MARK (")
            // U+0027 APOSTROPHE (')
            // U+0028 LEFT PARENTHESIS (()
            // non-printable code point
            case 34:
            case 39:
            case 40:
            case charCodeDefinitions.NonPrintableCategory:
              offset = utils.consumeBadUrlRemnants(source, offset);
              type = types.BadUrl;
              return;
            // U+005C REVERSE SOLIDUS (\)
            case 92:
              if (charCodeDefinitions.isValidEscape(code, getCharCode(offset + 1))) {
                offset = utils.consumeEscaped(source, offset) - 1;
                break;
              }
              offset = utils.consumeBadUrlRemnants(source, offset);
              type = types.BadUrl;
              return;
          }
        }
      }
      source = String(source || "");
      const sourceLength = source.length;
      let start = charCodeDefinitions.isBOM(getCharCode(0));
      let offset = start;
      let type;
      while (offset < sourceLength) {
        const code = source.charCodeAt(offset);
        switch (charCodeDefinitions.charCodeCategory(code)) {
          // whitespace
          case charCodeDefinitions.WhiteSpaceCategory:
            type = types.WhiteSpace;
            offset = utils.findWhiteSpaceEnd(source, offset + 1);
            break;
          // U+0022 QUOTATION MARK (")
          case 34:
            consumeStringToken();
            break;
          // U+0023 NUMBER SIGN (#)
          case 35:
            if (charCodeDefinitions.isName(getCharCode(offset + 1)) || charCodeDefinitions.isValidEscape(getCharCode(offset + 1), getCharCode(offset + 2))) {
              type = types.Hash;
              offset = utils.consumeName(source, offset + 1);
            } else {
              type = types.Delim;
              offset++;
            }
            break;
          // U+0027 APOSTROPHE (')
          case 39:
            consumeStringToken();
            break;
          // U+0028 LEFT PARENTHESIS (()
          case 40:
            type = types.LeftParenthesis;
            offset++;
            break;
          // U+0029 RIGHT PARENTHESIS ())
          case 41:
            type = types.RightParenthesis;
            offset++;
            break;
          // U+002B PLUS SIGN (+)
          case 43:
            if (charCodeDefinitions.isNumberStart(code, getCharCode(offset + 1), getCharCode(offset + 2))) {
              consumeNumericToken();
            } else {
              type = types.Delim;
              offset++;
            }
            break;
          // U+002C COMMA (,)
          case 44:
            type = types.Comma;
            offset++;
            break;
          // U+002D HYPHEN-MINUS (-)
          case 45:
            if (charCodeDefinitions.isNumberStart(code, getCharCode(offset + 1), getCharCode(offset + 2))) {
              consumeNumericToken();
            } else {
              if (getCharCode(offset + 1) === 45 && getCharCode(offset + 2) === 62) {
                type = types.CDC;
                offset = offset + 3;
              } else {
                if (charCodeDefinitions.isIdentifierStart(code, getCharCode(offset + 1), getCharCode(offset + 2))) {
                  consumeIdentLikeToken();
                } else {
                  type = types.Delim;
                  offset++;
                }
              }
            }
            break;
          // U+002E FULL STOP (.)
          case 46:
            if (charCodeDefinitions.isNumberStart(code, getCharCode(offset + 1), getCharCode(offset + 2))) {
              consumeNumericToken();
            } else {
              type = types.Delim;
              offset++;
            }
            break;
          // U+002F SOLIDUS (/)
          case 47:
            if (getCharCode(offset + 1) === 42) {
              type = types.Comment;
              offset = source.indexOf("*/", offset + 2);
              offset = offset === -1 ? source.length : offset + 2;
            } else {
              type = types.Delim;
              offset++;
            }
            break;
          // U+003A COLON (:)
          case 58:
            type = types.Colon;
            offset++;
            break;
          // U+003B SEMICOLON (;)
          case 59:
            type = types.Semicolon;
            offset++;
            break;
          // U+003C LESS-THAN SIGN (<)
          case 60:
            if (getCharCode(offset + 1) === 33 && getCharCode(offset + 2) === 45 && getCharCode(offset + 3) === 45) {
              type = types.CDO;
              offset = offset + 4;
            } else {
              type = types.Delim;
              offset++;
            }
            break;
          // U+0040 COMMERCIAL AT (@)
          case 64:
            if (charCodeDefinitions.isIdentifierStart(getCharCode(offset + 1), getCharCode(offset + 2), getCharCode(offset + 3))) {
              type = types.AtKeyword;
              offset = utils.consumeName(source, offset + 1);
            } else {
              type = types.Delim;
              offset++;
            }
            break;
          // U+005B LEFT SQUARE BRACKET ([)
          case 91:
            type = types.LeftSquareBracket;
            offset++;
            break;
          // U+005C REVERSE SOLIDUS (\)
          case 92:
            if (charCodeDefinitions.isValidEscape(code, getCharCode(offset + 1))) {
              consumeIdentLikeToken();
            } else {
              type = types.Delim;
              offset++;
            }
            break;
          // U+005D RIGHT SQUARE BRACKET (])
          case 93:
            type = types.RightSquareBracket;
            offset++;
            break;
          // U+007B LEFT CURLY BRACKET ({)
          case 123:
            type = types.LeftCurlyBracket;
            offset++;
            break;
          // U+007D RIGHT CURLY BRACKET (})
          case 125:
            type = types.RightCurlyBracket;
            offset++;
            break;
          // digit
          case charCodeDefinitions.DigitCategory:
            consumeNumericToken();
            break;
          // name-start code point
          case charCodeDefinitions.NameStartCategory:
            consumeIdentLikeToken();
            break;
          // EOF
          // case EofCategory:
          // Return an <EOF-token>.
          // break;
          // anything else
          default:
            type = types.Delim;
            offset++;
        }
        onToken(type, start, start = offset);
      }
    }
    exports2.AtKeyword = types.AtKeyword;
    exports2.BadString = types.BadString;
    exports2.BadUrl = types.BadUrl;
    exports2.CDC = types.CDC;
    exports2.CDO = types.CDO;
    exports2.Colon = types.Colon;
    exports2.Comma = types.Comma;
    exports2.Comment = types.Comment;
    exports2.Delim = types.Delim;
    exports2.Dimension = types.Dimension;
    exports2.EOF = types.EOF;
    exports2.Function = types.Function;
    exports2.Hash = types.Hash;
    exports2.Ident = types.Ident;
    exports2.LeftCurlyBracket = types.LeftCurlyBracket;
    exports2.LeftParenthesis = types.LeftParenthesis;
    exports2.LeftSquareBracket = types.LeftSquareBracket;
    exports2.Number = types.Number;
    exports2.Percentage = types.Percentage;
    exports2.RightCurlyBracket = types.RightCurlyBracket;
    exports2.RightParenthesis = types.RightParenthesis;
    exports2.RightSquareBracket = types.RightSquareBracket;
    exports2.Semicolon = types.Semicolon;
    exports2.String = types.String;
    exports2.Url = types.Url;
    exports2.WhiteSpace = types.WhiteSpace;
    exports2.tokenTypes = types;
    exports2.DigitCategory = charCodeDefinitions.DigitCategory;
    exports2.EofCategory = charCodeDefinitions.EofCategory;
    exports2.NameStartCategory = charCodeDefinitions.NameStartCategory;
    exports2.NonPrintableCategory = charCodeDefinitions.NonPrintableCategory;
    exports2.WhiteSpaceCategory = charCodeDefinitions.WhiteSpaceCategory;
    exports2.charCodeCategory = charCodeDefinitions.charCodeCategory;
    exports2.isBOM = charCodeDefinitions.isBOM;
    exports2.isDigit = charCodeDefinitions.isDigit;
    exports2.isHexDigit = charCodeDefinitions.isHexDigit;
    exports2.isIdentifierStart = charCodeDefinitions.isIdentifierStart;
    exports2.isLetter = charCodeDefinitions.isLetter;
    exports2.isLowercaseLetter = charCodeDefinitions.isLowercaseLetter;
    exports2.isName = charCodeDefinitions.isName;
    exports2.isNameStart = charCodeDefinitions.isNameStart;
    exports2.isNewline = charCodeDefinitions.isNewline;
    exports2.isNonAscii = charCodeDefinitions.isNonAscii;
    exports2.isNonPrintable = charCodeDefinitions.isNonPrintable;
    exports2.isNumberStart = charCodeDefinitions.isNumberStart;
    exports2.isUppercaseLetter = charCodeDefinitions.isUppercaseLetter;
    exports2.isValidEscape = charCodeDefinitions.isValidEscape;
    exports2.isWhiteSpace = charCodeDefinitions.isWhiteSpace;
    exports2.cmpChar = utils.cmpChar;
    exports2.cmpStr = utils.cmpStr;
    exports2.consumeBadUrlRemnants = utils.consumeBadUrlRemnants;
    exports2.consumeEscaped = utils.consumeEscaped;
    exports2.consumeName = utils.consumeName;
    exports2.consumeNumber = utils.consumeNumber;
    exports2.decodeEscaped = utils.decodeEscaped;
    exports2.findDecimalNumberEnd = utils.findDecimalNumberEnd;
    exports2.findWhiteSpaceEnd = utils.findWhiteSpaceEnd;
    exports2.findWhiteSpaceStart = utils.findWhiteSpaceStart;
    exports2.getNewlineLength = utils.getNewlineLength;
    exports2.tokenNames = names;
    exports2.OffsetToLocation = OffsetToLocation.OffsetToLocation;
    exports2.TokenStream = TokenStream.TokenStream;
    exports2.tokenize = tokenize;
  }
});

// node_modules/css-tree/cjs/utils/List.cjs
var require_List = __commonJS({
  "node_modules/css-tree/cjs/utils/List.cjs"(exports2) {
    "use strict";
    var releasedCursors = null;
    var List = class _List {
      static createItem(data) {
        return {
          prev: null,
          next: null,
          data
        };
      }
      constructor() {
        this.head = null;
        this.tail = null;
        this.cursor = null;
      }
      createItem(data) {
        return _List.createItem(data);
      }
      // cursor helpers
      allocateCursor(prev, next) {
        let cursor;
        if (releasedCursors !== null) {
          cursor = releasedCursors;
          releasedCursors = releasedCursors.cursor;
          cursor.prev = prev;
          cursor.next = next;
          cursor.cursor = this.cursor;
        } else {
          cursor = {
            prev,
            next,
            cursor: this.cursor
          };
        }
        this.cursor = cursor;
        return cursor;
      }
      releaseCursor() {
        const { cursor } = this;
        this.cursor = cursor.cursor;
        cursor.prev = null;
        cursor.next = null;
        cursor.cursor = releasedCursors;
        releasedCursors = cursor;
      }
      updateCursors(prevOld, prevNew, nextOld, nextNew) {
        let { cursor } = this;
        while (cursor !== null) {
          if (cursor.prev === prevOld) {
            cursor.prev = prevNew;
          }
          if (cursor.next === nextOld) {
            cursor.next = nextNew;
          }
          cursor = cursor.cursor;
        }
      }
      *[Symbol.iterator]() {
        for (let cursor = this.head; cursor !== null; cursor = cursor.next) {
          yield cursor.data;
        }
      }
      // getters
      get size() {
        let size = 0;
        for (let cursor = this.head; cursor !== null; cursor = cursor.next) {
          size++;
        }
        return size;
      }
      get isEmpty() {
        return this.head === null;
      }
      get first() {
        return this.head && this.head.data;
      }
      get last() {
        return this.tail && this.tail.data;
      }
      // convertors
      fromArray(array) {
        let cursor = null;
        this.head = null;
        for (let data of array) {
          const item = _List.createItem(data);
          if (cursor !== null) {
            cursor.next = item;
          } else {
            this.head = item;
          }
          item.prev = cursor;
          cursor = item;
        }
        this.tail = cursor;
        return this;
      }
      toArray() {
        return [...this];
      }
      toJSON() {
        return [...this];
      }
      // array-like methods
      forEach(fn, thisArg = this) {
        const cursor = this.allocateCursor(null, this.head);
        while (cursor.next !== null) {
          const item = cursor.next;
          cursor.next = item.next;
          fn.call(thisArg, item.data, item, this);
        }
        this.releaseCursor();
      }
      forEachRight(fn, thisArg = this) {
        const cursor = this.allocateCursor(this.tail, null);
        while (cursor.prev !== null) {
          const item = cursor.prev;
          cursor.prev = item.prev;
          fn.call(thisArg, item.data, item, this);
        }
        this.releaseCursor();
      }
      reduce(fn, initialValue, thisArg = this) {
        let cursor = this.allocateCursor(null, this.head);
        let acc = initialValue;
        let item;
        while (cursor.next !== null) {
          item = cursor.next;
          cursor.next = item.next;
          acc = fn.call(thisArg, acc, item.data, item, this);
        }
        this.releaseCursor();
        return acc;
      }
      reduceRight(fn, initialValue, thisArg = this) {
        let cursor = this.allocateCursor(this.tail, null);
        let acc = initialValue;
        let item;
        while (cursor.prev !== null) {
          item = cursor.prev;
          cursor.prev = item.prev;
          acc = fn.call(thisArg, acc, item.data, item, this);
        }
        this.releaseCursor();
        return acc;
      }
      some(fn, thisArg = this) {
        for (let cursor = this.head; cursor !== null; cursor = cursor.next) {
          if (fn.call(thisArg, cursor.data, cursor, this)) {
            return true;
          }
        }
        return false;
      }
      map(fn, thisArg = this) {
        const result = new _List();
        for (let cursor = this.head; cursor !== null; cursor = cursor.next) {
          result.appendData(fn.call(thisArg, cursor.data, cursor, this));
        }
        return result;
      }
      filter(fn, thisArg = this) {
        const result = new _List();
        for (let cursor = this.head; cursor !== null; cursor = cursor.next) {
          if (fn.call(thisArg, cursor.data, cursor, this)) {
            result.appendData(cursor.data);
          }
        }
        return result;
      }
      nextUntil(start, fn, thisArg = this) {
        if (start === null) {
          return;
        }
        const cursor = this.allocateCursor(null, start);
        while (cursor.next !== null) {
          const item = cursor.next;
          cursor.next = item.next;
          if (fn.call(thisArg, item.data, item, this)) {
            break;
          }
        }
        this.releaseCursor();
      }
      prevUntil(start, fn, thisArg = this) {
        if (start === null) {
          return;
        }
        const cursor = this.allocateCursor(start, null);
        while (cursor.prev !== null) {
          const item = cursor.prev;
          cursor.prev = item.prev;
          if (fn.call(thisArg, item.data, item, this)) {
            break;
          }
        }
        this.releaseCursor();
      }
      // mutation
      clear() {
        this.head = null;
        this.tail = null;
      }
      copy() {
        const result = new _List();
        for (let data of this) {
          result.appendData(data);
        }
        return result;
      }
      prepend(item) {
        this.updateCursors(null, item, this.head, item);
        if (this.head !== null) {
          this.head.prev = item;
          item.next = this.head;
        } else {
          this.tail = item;
        }
        this.head = item;
        return this;
      }
      prependData(data) {
        return this.prepend(_List.createItem(data));
      }
      append(item) {
        return this.insert(item);
      }
      appendData(data) {
        return this.insert(_List.createItem(data));
      }
      insert(item, before = null) {
        if (before !== null) {
          this.updateCursors(before.prev, item, before, item);
          if (before.prev === null) {
            if (this.head !== before) {
              throw new Error("before doesn't belong to list");
            }
            this.head = item;
            before.prev = item;
            item.next = before;
            this.updateCursors(null, item);
          } else {
            before.prev.next = item;
            item.prev = before.prev;
            before.prev = item;
            item.next = before;
          }
        } else {
          this.updateCursors(this.tail, item, null, item);
          if (this.tail !== null) {
            this.tail.next = item;
            item.prev = this.tail;
          } else {
            this.head = item;
          }
          this.tail = item;
        }
        return this;
      }
      insertData(data, before) {
        return this.insert(_List.createItem(data), before);
      }
      remove(item) {
        this.updateCursors(item, item.prev, item, item.next);
        if (item.prev !== null) {
          item.prev.next = item.next;
        } else {
          if (this.head !== item) {
            throw new Error("item doesn't belong to list");
          }
          this.head = item.next;
        }
        if (item.next !== null) {
          item.next.prev = item.prev;
        } else {
          if (this.tail !== item) {
            throw new Error("item doesn't belong to list");
          }
          this.tail = item.prev;
        }
        item.prev = null;
        item.next = null;
        return item;
      }
      push(data) {
        this.insert(_List.createItem(data));
      }
      pop() {
        return this.tail !== null ? this.remove(this.tail) : null;
      }
      unshift(data) {
        this.prepend(_List.createItem(data));
      }
      shift() {
        return this.head !== null ? this.remove(this.head) : null;
      }
      prependList(list) {
        return this.insertList(list, this.head);
      }
      appendList(list) {
        return this.insertList(list);
      }
      insertList(list, before) {
        if (list.head === null) {
          return this;
        }
        if (before !== void 0 && before !== null) {
          this.updateCursors(before.prev, list.tail, before, list.head);
          if (before.prev !== null) {
            before.prev.next = list.head;
            list.head.prev = before.prev;
          } else {
            this.head = list.head;
          }
          before.prev = list.tail;
          list.tail.next = before;
        } else {
          this.updateCursors(this.tail, list.tail, null, list.head);
          if (this.tail !== null) {
            this.tail.next = list.head;
            list.head.prev = this.tail;
          } else {
            this.head = list.head;
          }
          this.tail = list.tail;
        }
        list.head = null;
        list.tail = null;
        return this;
      }
      replace(oldItem, newItemOrList) {
        if ("head" in newItemOrList) {
          this.insertList(newItemOrList, oldItem);
        } else {
          this.insert(newItemOrList, oldItem);
        }
        this.remove(oldItem);
      }
    };
    exports2.List = List;
  }
});

// node_modules/css-tree/cjs/utils/create-custom-error.cjs
var require_create_custom_error = __commonJS({
  "node_modules/css-tree/cjs/utils/create-custom-error.cjs"(exports2) {
    "use strict";
    function createCustomError(name, message) {
      const error = Object.create(SyntaxError.prototype);
      const errorStack = new Error();
      return Object.assign(error, {
        name,
        message,
        get stack() {
          return (errorStack.stack || "").replace(/^(.+\n){1,3}/, `${name}: ${message}
`);
        }
      });
    }
    exports2.createCustomError = createCustomError;
  }
});

// node_modules/css-tree/cjs/parser/SyntaxError.cjs
var require_SyntaxError = __commonJS({
  "node_modules/css-tree/cjs/parser/SyntaxError.cjs"(exports2) {
    "use strict";
    var createCustomError = require_create_custom_error();
    var MAX_LINE_LENGTH = 100;
    var OFFSET_CORRECTION = 60;
    var TAB_REPLACEMENT = "    ";
    function sourceFragment({ source, line, column, baseLine, baseColumn }, extraLines) {
      function processLines(start, end) {
        return lines.slice(start, end).map(
          (line2, idx) => String(start + idx + 1).padStart(maxNumLength) + " |" + line2
        ).join("\n");
      }
      const prelines = "\n".repeat(Math.max(baseLine - 1, 0));
      const precolumns = " ".repeat(Math.max(baseColumn - 1, 0));
      const lines = (prelines + precolumns + source).split(/\r\n?|\n|\f/);
      const startLine = Math.max(1, line - extraLines) - 1;
      const endLine = Math.min(line + extraLines, lines.length + 1);
      const maxNumLength = Math.max(4, String(endLine).length) + 1;
      let cutLeft = 0;
      column += (TAB_REPLACEMENT.length - 1) * (lines[line - 1].substr(0, column - 1).match(/\t/g) || []).length;
      if (column > MAX_LINE_LENGTH) {
        cutLeft = column - OFFSET_CORRECTION + 3;
        column = OFFSET_CORRECTION - 2;
      }
      for (let i = startLine; i <= endLine; i++) {
        if (i >= 0 && i < lines.length) {
          lines[i] = lines[i].replace(/\t/g, TAB_REPLACEMENT);
          lines[i] = (cutLeft > 0 && lines[i].length > cutLeft ? "\u2026" : "") + lines[i].substr(cutLeft, MAX_LINE_LENGTH - 2) + (lines[i].length > cutLeft + MAX_LINE_LENGTH - 1 ? "\u2026" : "");
        }
      }
      return [
        processLines(startLine, line),
        new Array(column + maxNumLength + 2).join("-") + "^",
        processLines(line, endLine)
      ].filter(Boolean).join("\n").replace(/^(\s+\d+\s+\|\n)+/, "").replace(/\n(\s+\d+\s+\|)+$/, "");
    }
    function SyntaxError2(message, source, offset, line, column, baseLine = 1, baseColumn = 1) {
      const error = Object.assign(createCustomError.createCustomError("SyntaxError", message), {
        source,
        offset,
        line,
        column,
        sourceFragment(extraLines) {
          return sourceFragment({ source, line, column, baseLine, baseColumn }, isNaN(extraLines) ? 0 : extraLines);
        },
        get formattedMessage() {
          return `Parse error: ${message}
` + sourceFragment({ source, line, column, baseLine, baseColumn }, 2);
        }
      });
      return error;
    }
    exports2.SyntaxError = SyntaxError2;
  }
});

// node_modules/css-tree/cjs/parser/sequence.cjs
var require_sequence = __commonJS({
  "node_modules/css-tree/cjs/parser/sequence.cjs"(exports2) {
    "use strict";
    var types = require_types();
    function readSequence(recognizer) {
      const children = this.createList();
      let space = false;
      const context = {
        recognizer
      };
      while (!this.eof) {
        switch (this.tokenType) {
          case types.Comment:
            this.next();
            continue;
          case types.WhiteSpace:
            space = true;
            this.next();
            continue;
        }
        let child = recognizer.getNode.call(this, context);
        if (child === void 0) {
          break;
        }
        if (space) {
          if (recognizer.onWhiteSpace) {
            recognizer.onWhiteSpace.call(this, child, children, context);
          }
          space = false;
        }
        children.push(child);
      }
      if (space && recognizer.onWhiteSpace) {
        recognizer.onWhiteSpace.call(this, null, children, context);
      }
      return children;
    }
    exports2.readSequence = readSequence;
  }
});

// node_modules/css-tree/cjs/parser/create.cjs
var require_create = __commonJS({
  "node_modules/css-tree/cjs/parser/create.cjs"(exports2) {
    "use strict";
    var List = require_List();
    var SyntaxError2 = require_SyntaxError();
    var index = require_tokenizer();
    var sequence = require_sequence();
    var OffsetToLocation = require_OffsetToLocation();
    var TokenStream = require_TokenStream();
    var utils = require_utils();
    var types = require_types();
    var names = require_names();
    var NOOP = () => {
    };
    var EXCLAMATIONMARK = 33;
    var NUMBERSIGN = 35;
    var SEMICOLON = 59;
    var LEFTCURLYBRACKET = 123;
    var NULL = 0;
    var arrayMethods = {
      createList() {
        return [];
      },
      createSingleNodeList(node) {
        return [node];
      },
      getFirstListNode(list) {
        return list && list[0] || null;
      },
      getLastListNode(list) {
        return list && list.length > 0 ? list[list.length - 1] : null;
      }
    };
    var listMethods = {
      createList() {
        return new List.List();
      },
      createSingleNodeList(node) {
        return new List.List().appendData(node);
      },
      getFirstListNode(list) {
        return list && list.first;
      },
      getLastListNode(list) {
        return list && list.last;
      }
    };
    function createParseContext(name) {
      return function() {
        return this[name]();
      };
    }
    function fetchParseValues(dict) {
      const result = /* @__PURE__ */ Object.create(null);
      for (const name of Object.keys(dict)) {
        const item = dict[name];
        const fn = item.parse || item;
        if (fn) {
          result[name] = fn;
        }
      }
      return result;
    }
    function processConfig(config) {
      const parseConfig = {
        context: /* @__PURE__ */ Object.create(null),
        features: Object.assign(/* @__PURE__ */ Object.create(null), config.features),
        scope: Object.assign(/* @__PURE__ */ Object.create(null), config.scope),
        atrule: fetchParseValues(config.atrule),
        pseudo: fetchParseValues(config.pseudo),
        node: fetchParseValues(config.node)
      };
      for (const [name, context] of Object.entries(config.parseContext)) {
        switch (typeof context) {
          case "function":
            parseConfig.context[name] = context;
            break;
          case "string":
            parseConfig.context[name] = createParseContext(context);
            break;
        }
      }
      return {
        config: parseConfig,
        ...parseConfig,
        ...parseConfig.node
      };
    }
    function createParser(config) {
      let source = "";
      let filename = "<unknown>";
      let needPositions = false;
      let onParseError = NOOP;
      let onParseErrorThrow = false;
      const locationMap = new OffsetToLocation.OffsetToLocation();
      const parser = Object.assign(new TokenStream.TokenStream(), processConfig(config || {}), {
        parseAtrulePrelude: true,
        parseRulePrelude: true,
        parseValue: true,
        parseCustomProperty: false,
        readSequence: sequence.readSequence,
        consumeUntilBalanceEnd: () => 0,
        consumeUntilLeftCurlyBracket(code) {
          return code === LEFTCURLYBRACKET ? 1 : 0;
        },
        consumeUntilLeftCurlyBracketOrSemicolon(code) {
          return code === LEFTCURLYBRACKET || code === SEMICOLON ? 1 : 0;
        },
        consumeUntilExclamationMarkOrSemicolon(code) {
          return code === EXCLAMATIONMARK || code === SEMICOLON ? 1 : 0;
        },
        consumeUntilSemicolonIncluded(code) {
          return code === SEMICOLON ? 2 : 0;
        },
        createList: NOOP,
        createSingleNodeList: NOOP,
        getFirstListNode: NOOP,
        getLastListNode: NOOP,
        parseWithFallback(consumer, fallback) {
          const startIndex = this.tokenIndex;
          try {
            return consumer.call(this);
          } catch (e) {
            if (onParseErrorThrow) {
              throw e;
            }
            this.skip(startIndex - this.tokenIndex);
            const fallbackNode = fallback.call(this);
            onParseErrorThrow = true;
            onParseError(e, fallbackNode);
            onParseErrorThrow = false;
            return fallbackNode;
          }
        },
        lookupNonWSType(offset) {
          let type;
          do {
            type = this.lookupType(offset++);
            if (type !== types.WhiteSpace && type !== types.Comment) {
              return type;
            }
          } while (type !== NULL);
          return NULL;
        },
        charCodeAt(offset) {
          return offset >= 0 && offset < source.length ? source.charCodeAt(offset) : 0;
        },
        substring(offsetStart, offsetEnd) {
          return source.substring(offsetStart, offsetEnd);
        },
        substrToCursor(start) {
          return this.source.substring(start, this.tokenStart);
        },
        cmpChar(offset, charCode) {
          return utils.cmpChar(source, offset, charCode);
        },
        cmpStr(offsetStart, offsetEnd, str) {
          return utils.cmpStr(source, offsetStart, offsetEnd, str);
        },
        consume(tokenType) {
          const start = this.tokenStart;
          this.eat(tokenType);
          return this.substrToCursor(start);
        },
        consumeFunctionName() {
          const name = source.substring(this.tokenStart, this.tokenEnd - 1);
          this.eat(types.Function);
          return name;
        },
        consumeNumber(type) {
          const number = source.substring(this.tokenStart, utils.consumeNumber(source, this.tokenStart));
          this.eat(type);
          return number;
        },
        eat(tokenType) {
          if (this.tokenType !== tokenType) {
            const tokenName = names[tokenType].slice(0, -6).replace(/-/g, " ").replace(/^./, (m) => m.toUpperCase());
            let message = `${/[[\](){}]/.test(tokenName) ? `"${tokenName}"` : tokenName} is expected`;
            let offset = this.tokenStart;
            switch (tokenType) {
              case types.Ident:
                if (this.tokenType === types.Function || this.tokenType === types.Url) {
                  offset = this.tokenEnd - 1;
                  message = "Identifier is expected but function found";
                } else {
                  message = "Identifier is expected";
                }
                break;
              case types.Hash:
                if (this.isDelim(NUMBERSIGN)) {
                  this.next();
                  offset++;
                  message = "Name is expected";
                }
                break;
              case types.Percentage:
                if (this.tokenType === types.Number) {
                  offset = this.tokenEnd;
                  message = "Percent sign is expected";
                }
                break;
            }
            this.error(message, offset);
          }
          this.next();
        },
        eatIdent(name) {
          if (this.tokenType !== types.Ident || this.lookupValue(0, name) === false) {
            this.error(`Identifier "${name}" is expected`);
          }
          this.next();
        },
        eatDelim(code) {
          if (!this.isDelim(code)) {
            this.error(`Delim "${String.fromCharCode(code)}" is expected`);
          }
          this.next();
        },
        getLocation(start, end) {
          if (needPositions) {
            return locationMap.getLocationRange(
              start,
              end,
              filename
            );
          }
          return null;
        },
        getLocationFromList(list) {
          if (needPositions) {
            const head = this.getFirstListNode(list);
            const tail = this.getLastListNode(list);
            return locationMap.getLocationRange(
              head !== null ? head.loc.start.offset - locationMap.startOffset : this.tokenStart,
              tail !== null ? tail.loc.end.offset - locationMap.startOffset : this.tokenStart,
              filename
            );
          }
          return null;
        },
        error(message, offset) {
          const location = typeof offset !== "undefined" && offset < source.length ? locationMap.getLocation(offset) : this.eof ? locationMap.getLocation(utils.findWhiteSpaceStart(source, source.length - 1)) : locationMap.getLocation(this.tokenStart);
          throw new SyntaxError2.SyntaxError(
            message || "Unexpected input",
            source,
            location.offset,
            location.line,
            location.column,
            locationMap.startLine,
            locationMap.startColumn
          );
        }
      });
      const createTokenIterateAPI = () => ({
        filename,
        source,
        tokenCount: parser.tokenCount,
        getTokenType: (index2) => parser.getTokenType(index2),
        getTokenTypeName: (index2) => names[parser.getTokenType(index2)],
        getTokenStart: (index2) => parser.getTokenStart(index2),
        getTokenEnd: (index2) => parser.getTokenEnd(index2),
        getTokenValue: (index2) => parser.source.substring(parser.getTokenStart(index2), parser.getTokenEnd(index2)),
        substring: (start, end) => parser.source.substring(start, end),
        balance: parser.balance.subarray(0, parser.tokenCount + 1),
        isBlockOpenerTokenType: parser.isBlockOpenerTokenType,
        isBlockCloserTokenType: parser.isBlockCloserTokenType,
        getBlockTokenPairIndex: (index2) => parser.getBlockTokenPairIndex(index2),
        getLocation: (offset) => locationMap.getLocation(offset, filename),
        getRangeLocation: (start, end) => locationMap.getLocationRange(start, end, filename)
      });
      const parse = function(source_, options) {
        source = source_;
        options = options || {};
        parser.setSource(source, index.tokenize);
        locationMap.setSource(
          source,
          options.offset,
          options.line,
          options.column
        );
        filename = options.filename || "<unknown>";
        needPositions = Boolean(options.positions);
        onParseError = typeof options.onParseError === "function" ? options.onParseError : NOOP;
        onParseErrorThrow = false;
        parser.parseAtrulePrelude = "parseAtrulePrelude" in options ? Boolean(options.parseAtrulePrelude) : true;
        parser.parseRulePrelude = "parseRulePrelude" in options ? Boolean(options.parseRulePrelude) : true;
        parser.parseValue = "parseValue" in options ? Boolean(options.parseValue) : true;
        parser.parseCustomProperty = "parseCustomProperty" in options ? Boolean(options.parseCustomProperty) : false;
        const { context = "default", list = true, onComment, onToken } = options;
        if (context in parser.context === false) {
          throw new Error("Unknown context `" + context + "`");
        }
        Object.assign(parser, list ? listMethods : arrayMethods);
        if (Array.isArray(onToken)) {
          parser.forEachToken((type, start, end) => {
            onToken.push({ type, start, end });
          });
        } else if (typeof onToken === "function") {
          parser.forEachToken(onToken.bind(createTokenIterateAPI()));
        }
        if (typeof onComment === "function") {
          parser.forEachToken((type, start, end) => {
            if (type === types.Comment) {
              const loc = parser.getLocation(start, end);
              const value = utils.cmpStr(source, end - 2, end, "*/") ? source.slice(start + 2, end - 2) : source.slice(start + 2, end);
              onComment(value, loc);
            }
          });
        }
        const ast = parser.context[context].call(parser, options);
        if (!parser.eof) {
          parser.error();
        }
        return ast;
      };
      return Object.assign(parse, {
        SyntaxError: SyntaxError2.SyntaxError,
        config: parser.config
      });
    }
    exports2.createParser = createParser;
  }
});

// node_modules/source-map-js/lib/base64.js
var require_base64 = __commonJS({
  "node_modules/source-map-js/lib/base64.js"(exports2) {
    var intToCharMap = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("");
    exports2.encode = function(number) {
      if (0 <= number && number < intToCharMap.length) {
        return intToCharMap[number];
      }
      throw new TypeError("Must be between 0 and 63: " + number);
    };
    exports2.decode = function(charCode) {
      var bigA = 65;
      var bigZ = 90;
      var littleA = 97;
      var littleZ = 122;
      var zero = 48;
      var nine = 57;
      var plus = 43;
      var slash = 47;
      var littleOffset = 26;
      var numberOffset = 52;
      if (bigA <= charCode && charCode <= bigZ) {
        return charCode - bigA;
      }
      if (littleA <= charCode && charCode <= littleZ) {
        return charCode - littleA + littleOffset;
      }
      if (zero <= charCode && charCode <= nine) {
        return charCode - zero + numberOffset;
      }
      if (charCode == plus) {
        return 62;
      }
      if (charCode == slash) {
        return 63;
      }
      return -1;
    };
  }
});

// node_modules/source-map-js/lib/base64-vlq.js
var require_base64_vlq = __commonJS({
  "node_modules/source-map-js/lib/base64-vlq.js"(exports2) {
    var base64 = require_base64();
    var VLQ_BASE_SHIFT = 5;
    var VLQ_BASE = 1 << VLQ_BASE_SHIFT;
    var VLQ_BASE_MASK = VLQ_BASE - 1;
    var VLQ_CONTINUATION_BIT = VLQ_BASE;
    function toVLQSigned(aValue) {
      return aValue < 0 ? (-aValue << 1) + 1 : (aValue << 1) + 0;
    }
    function fromVLQSigned(aValue) {
      var isNegative = (aValue & 1) === 1;
      var shifted = aValue >> 1;
      return isNegative ? -shifted : shifted;
    }
    exports2.encode = function base64VLQ_encode(aValue) {
      var encoded = "";
      var digit;
      var vlq = toVLQSigned(aValue);
      do {
        digit = vlq & VLQ_BASE_MASK;
        vlq >>>= VLQ_BASE_SHIFT;
        if (vlq > 0) {
          digit |= VLQ_CONTINUATION_BIT;
        }
        encoded += base64.encode(digit);
      } while (vlq > 0);
      return encoded;
    };
    exports2.decode = function base64VLQ_decode(aStr, aIndex, aOutParam) {
      var strLen = aStr.length;
      var result = 0;
      var shift = 0;
      var continuation, digit;
      do {
        if (aIndex >= strLen) {
          throw new Error("Expected more digits in base 64 VLQ value.");
        }
        digit = base64.decode(aStr.charCodeAt(aIndex++));
        if (digit === -1) {
          throw new Error("Invalid base64 digit: " + aStr.charAt(aIndex - 1));
        }
        continuation = !!(digit & VLQ_CONTINUATION_BIT);
        digit &= VLQ_BASE_MASK;
        result = result + (digit << shift);
        shift += VLQ_BASE_SHIFT;
      } while (continuation);
      aOutParam.value = fromVLQSigned(result);
      aOutParam.rest = aIndex;
    };
  }
});

// node_modules/source-map-js/lib/util.js
var require_util = __commonJS({
  "node_modules/source-map-js/lib/util.js"(exports2) {
    function getArg(aArgs, aName, aDefaultValue) {
      if (aName in aArgs) {
        return aArgs[aName];
      } else if (arguments.length === 3) {
        return aDefaultValue;
      } else {
        throw new Error('"' + aName + '" is a required argument.');
      }
    }
    exports2.getArg = getArg;
    var urlRegexp = /^(?:([\w+\-.]+):)?\/\/(?:(\w+:\w+)@)?([\w.-]*)(?::(\d+))?(.*)$/;
    var dataUrlRegexp = /^data:.+\,.+$/;
    function urlParse(aUrl) {
      var match = aUrl.match(urlRegexp);
      if (!match) {
        return null;
      }
      return {
        scheme: match[1],
        auth: match[2],
        host: match[3],
        port: match[4],
        path: match[5]
      };
    }
    exports2.urlParse = urlParse;
    function urlGenerate(aParsedUrl) {
      var url = "";
      if (aParsedUrl.scheme) {
        url += aParsedUrl.scheme + ":";
      }
      url += "//";
      if (aParsedUrl.auth) {
        url += aParsedUrl.auth + "@";
      }
      if (aParsedUrl.host) {
        url += aParsedUrl.host;
      }
      if (aParsedUrl.port) {
        url += ":" + aParsedUrl.port;
      }
      if (aParsedUrl.path) {
        url += aParsedUrl.path;
      }
      return url;
    }
    exports2.urlGenerate = urlGenerate;
    var MAX_CACHED_INPUTS = 32;
    function lruMemoize(f) {
      var cache = [];
      return function(input) {
        for (var i = 0; i < cache.length; i++) {
          if (cache[i].input === input) {
            var temp = cache[0];
            cache[0] = cache[i];
            cache[i] = temp;
            return cache[0].result;
          }
        }
        var result = f(input);
        cache.unshift({
          input,
          result
        });
        if (cache.length > MAX_CACHED_INPUTS) {
          cache.pop();
        }
        return result;
      };
    }
    var normalize = lruMemoize(function normalize2(aPath) {
      var path = aPath;
      var url = urlParse(aPath);
      if (url) {
        if (!url.path) {
          return aPath;
        }
        path = url.path;
      }
      var isAbsolute = exports2.isAbsolute(path);
      var parts = [];
      var start = 0;
      var i = 0;
      while (true) {
        start = i;
        i = path.indexOf("/", start);
        if (i === -1) {
          parts.push(path.slice(start));
          break;
        } else {
          parts.push(path.slice(start, i));
          while (i < path.length && path[i] === "/") {
            i++;
          }
        }
      }
      for (var part, up = 0, i = parts.length - 1; i >= 0; i--) {
        part = parts[i];
        if (part === ".") {
          parts.splice(i, 1);
        } else if (part === "..") {
          up++;
        } else if (up > 0) {
          if (part === "") {
            parts.splice(i + 1, up);
            up = 0;
          } else {
            parts.splice(i, 2);
            up--;
          }
        }
      }
      path = parts.join("/");
      if (path === "") {
        path = isAbsolute ? "/" : ".";
      }
      if (url) {
        url.path = path;
        return urlGenerate(url);
      }
      return path;
    });
    exports2.normalize = normalize;
    function join(aRoot, aPath) {
      if (aRoot === "") {
        aRoot = ".";
      }
      if (aPath === "") {
        aPath = ".";
      }
      var aPathUrl = urlParse(aPath);
      var aRootUrl = urlParse(aRoot);
      if (aRootUrl) {
        aRoot = aRootUrl.path || "/";
      }
      if (aPathUrl && !aPathUrl.scheme) {
        if (aRootUrl) {
          aPathUrl.scheme = aRootUrl.scheme;
        }
        return urlGenerate(aPathUrl);
      }
      if (aPathUrl || aPath.match(dataUrlRegexp)) {
        return aPath;
      }
      if (aRootUrl && !aRootUrl.host && !aRootUrl.path) {
        aRootUrl.host = aPath;
        return urlGenerate(aRootUrl);
      }
      var joined = aPath.charAt(0) === "/" ? aPath : normalize(aRoot.replace(/\/+$/, "") + "/" + aPath);
      if (aRootUrl) {
        aRootUrl.path = joined;
        return urlGenerate(aRootUrl);
      }
      return joined;
    }
    exports2.join = join;
    exports2.isAbsolute = function(aPath) {
      return aPath.charAt(0) === "/" || urlRegexp.test(aPath);
    };
    function relative(aRoot, aPath) {
      if (aRoot === "") {
        aRoot = ".";
      }
      aRoot = aRoot.replace(/\/$/, "");
      var level = 0;
      while (aPath.indexOf(aRoot + "/") !== 0) {
        var index = aRoot.lastIndexOf("/");
        if (index < 0) {
          return aPath;
        }
        aRoot = aRoot.slice(0, index);
        if (aRoot.match(/^([^\/]+:\/)?\/*$/)) {
          return aPath;
        }
        ++level;
      }
      return Array(level + 1).join("../") + aPath.substr(aRoot.length + 1);
    }
    exports2.relative = relative;
    var supportsNullProto = (function() {
      var obj = /* @__PURE__ */ Object.create(null);
      return !("__proto__" in obj);
    })();
    function identity(s) {
      return s;
    }
    function toSetString(aStr) {
      if (isProtoString(aStr)) {
        return "$" + aStr;
      }
      return aStr;
    }
    exports2.toSetString = supportsNullProto ? identity : toSetString;
    function fromSetString(aStr) {
      if (isProtoString(aStr)) {
        return aStr.slice(1);
      }
      return aStr;
    }
    exports2.fromSetString = supportsNullProto ? identity : fromSetString;
    function isProtoString(s) {
      if (!s) {
        return false;
      }
      var length = s.length;
      if (length < 9) {
        return false;
      }
      if (s.charCodeAt(length - 1) !== 95 || s.charCodeAt(length - 2) !== 95 || s.charCodeAt(length - 3) !== 111 || s.charCodeAt(length - 4) !== 116 || s.charCodeAt(length - 5) !== 111 || s.charCodeAt(length - 6) !== 114 || s.charCodeAt(length - 7) !== 112 || s.charCodeAt(length - 8) !== 95 || s.charCodeAt(length - 9) !== 95) {
        return false;
      }
      for (var i = length - 10; i >= 0; i--) {
        if (s.charCodeAt(i) !== 36) {
          return false;
        }
      }
      return true;
    }
    function compareByOriginalPositions(mappingA, mappingB, onlyCompareOriginal) {
      var cmp = strcmp(mappingA.source, mappingB.source);
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.originalLine - mappingB.originalLine;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.originalColumn - mappingB.originalColumn;
      if (cmp !== 0 || onlyCompareOriginal) {
        return cmp;
      }
      cmp = mappingA.generatedColumn - mappingB.generatedColumn;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.generatedLine - mappingB.generatedLine;
      if (cmp !== 0) {
        return cmp;
      }
      return strcmp(mappingA.name, mappingB.name);
    }
    exports2.compareByOriginalPositions = compareByOriginalPositions;
    function compareByOriginalPositionsNoSource(mappingA, mappingB, onlyCompareOriginal) {
      var cmp;
      cmp = mappingA.originalLine - mappingB.originalLine;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.originalColumn - mappingB.originalColumn;
      if (cmp !== 0 || onlyCompareOriginal) {
        return cmp;
      }
      cmp = mappingA.generatedColumn - mappingB.generatedColumn;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.generatedLine - mappingB.generatedLine;
      if (cmp !== 0) {
        return cmp;
      }
      return strcmp(mappingA.name, mappingB.name);
    }
    exports2.compareByOriginalPositionsNoSource = compareByOriginalPositionsNoSource;
    function compareByGeneratedPositionsDeflated(mappingA, mappingB, onlyCompareGenerated) {
      var cmp = mappingA.generatedLine - mappingB.generatedLine;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.generatedColumn - mappingB.generatedColumn;
      if (cmp !== 0 || onlyCompareGenerated) {
        return cmp;
      }
      cmp = strcmp(mappingA.source, mappingB.source);
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.originalLine - mappingB.originalLine;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.originalColumn - mappingB.originalColumn;
      if (cmp !== 0) {
        return cmp;
      }
      return strcmp(mappingA.name, mappingB.name);
    }
    exports2.compareByGeneratedPositionsDeflated = compareByGeneratedPositionsDeflated;
    function compareByGeneratedPositionsDeflatedNoLine(mappingA, mappingB, onlyCompareGenerated) {
      var cmp = mappingA.generatedColumn - mappingB.generatedColumn;
      if (cmp !== 0 || onlyCompareGenerated) {
        return cmp;
      }
      cmp = strcmp(mappingA.source, mappingB.source);
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.originalLine - mappingB.originalLine;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.originalColumn - mappingB.originalColumn;
      if (cmp !== 0) {
        return cmp;
      }
      return strcmp(mappingA.name, mappingB.name);
    }
    exports2.compareByGeneratedPositionsDeflatedNoLine = compareByGeneratedPositionsDeflatedNoLine;
    function strcmp(aStr1, aStr2) {
      if (aStr1 === aStr2) {
        return 0;
      }
      if (aStr1 === null) {
        return 1;
      }
      if (aStr2 === null) {
        return -1;
      }
      if (aStr1 > aStr2) {
        return 1;
      }
      return -1;
    }
    function compareByGeneratedPositionsInflated(mappingA, mappingB) {
      var cmp = mappingA.generatedLine - mappingB.generatedLine;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.generatedColumn - mappingB.generatedColumn;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = strcmp(mappingA.source, mappingB.source);
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.originalLine - mappingB.originalLine;
      if (cmp !== 0) {
        return cmp;
      }
      cmp = mappingA.originalColumn - mappingB.originalColumn;
      if (cmp !== 0) {
        return cmp;
      }
      return strcmp(mappingA.name, mappingB.name);
    }
    exports2.compareByGeneratedPositionsInflated = compareByGeneratedPositionsInflated;
    function parseSourceMapInput(str) {
      return JSON.parse(str.replace(/^\)]}'[^\n]*\n/, ""));
    }
    exports2.parseSourceMapInput = parseSourceMapInput;
    function computeSourceURL(sourceRoot, sourceURL, sourceMapURL) {
      sourceURL = sourceURL || "";
      if (sourceRoot) {
        if (sourceRoot[sourceRoot.length - 1] !== "/" && sourceURL[0] !== "/") {
          sourceRoot += "/";
        }
        sourceURL = sourceRoot + sourceURL;
      }
      if (sourceMapURL) {
        var parsed = urlParse(sourceMapURL);
        if (!parsed) {
          throw new Error("sourceMapURL could not be parsed");
        }
        if (parsed.path) {
          var index = parsed.path.lastIndexOf("/");
          if (index >= 0) {
            parsed.path = parsed.path.substring(0, index + 1);
          }
        }
        sourceURL = join(urlGenerate(parsed), sourceURL);
      }
      return normalize(sourceURL);
    }
    exports2.computeSourceURL = computeSourceURL;
  }
});

// node_modules/source-map-js/lib/array-set.js
var require_array_set = __commonJS({
  "node_modules/source-map-js/lib/array-set.js"(exports2) {
    var util = require_util();
    var has = Object.prototype.hasOwnProperty;
    var hasNativeMap = typeof Map !== "undefined";
    function ArraySet() {
      this._array = [];
      this._set = hasNativeMap ? /* @__PURE__ */ new Map() : /* @__PURE__ */ Object.create(null);
    }
    ArraySet.fromArray = function ArraySet_fromArray(aArray, aAllowDuplicates) {
      var set = new ArraySet();
      for (var i = 0, len = aArray.length; i < len; i++) {
        set.add(aArray[i], aAllowDuplicates);
      }
      return set;
    };
    ArraySet.prototype.size = function ArraySet_size() {
      return hasNativeMap ? this._set.size : Object.getOwnPropertyNames(this._set).length;
    };
    ArraySet.prototype.add = function ArraySet_add(aStr, aAllowDuplicates) {
      var sStr = hasNativeMap ? aStr : util.toSetString(aStr);
      var isDuplicate = hasNativeMap ? this.has(aStr) : has.call(this._set, sStr);
      var idx = this._array.length;
      if (!isDuplicate || aAllowDuplicates) {
        this._array.push(aStr);
      }
      if (!isDuplicate) {
        if (hasNativeMap) {
          this._set.set(aStr, idx);
        } else {
          this._set[sStr] = idx;
        }
      }
    };
    ArraySet.prototype.has = function ArraySet_has(aStr) {
      if (hasNativeMap) {
        return this._set.has(aStr);
      } else {
        var sStr = util.toSetString(aStr);
        return has.call(this._set, sStr);
      }
    };
    ArraySet.prototype.indexOf = function ArraySet_indexOf(aStr) {
      if (hasNativeMap) {
        var idx = this._set.get(aStr);
        if (idx >= 0) {
          return idx;
        }
      } else {
        var sStr = util.toSetString(aStr);
        if (has.call(this._set, sStr)) {
          return this._set[sStr];
        }
      }
      throw new Error('"' + aStr + '" is not in the set.');
    };
    ArraySet.prototype.at = function ArraySet_at(aIdx) {
      if (aIdx >= 0 && aIdx < this._array.length) {
        return this._array[aIdx];
      }
      throw new Error("No element indexed by " + aIdx);
    };
    ArraySet.prototype.toArray = function ArraySet_toArray() {
      return this._array.slice();
    };
    exports2.ArraySet = ArraySet;
  }
});

// node_modules/source-map-js/lib/mapping-list.js
var require_mapping_list = __commonJS({
  "node_modules/source-map-js/lib/mapping-list.js"(exports2) {
    var util = require_util();
    function generatedPositionAfter(mappingA, mappingB) {
      var lineA = mappingA.generatedLine;
      var lineB = mappingB.generatedLine;
      var columnA = mappingA.generatedColumn;
      var columnB = mappingB.generatedColumn;
      return lineB > lineA || lineB == lineA && columnB >= columnA || util.compareByGeneratedPositionsInflated(mappingA, mappingB) <= 0;
    }
    function MappingList() {
      this._array = [];
      this._sorted = true;
      this._last = { generatedLine: -1, generatedColumn: 0 };
    }
    MappingList.prototype.unsortedForEach = function MappingList_forEach(aCallback, aThisArg) {
      this._array.forEach(aCallback, aThisArg);
    };
    MappingList.prototype.add = function MappingList_add(aMapping) {
      if (generatedPositionAfter(this._last, aMapping)) {
        this._last = aMapping;
        this._array.push(aMapping);
      } else {
        this._sorted = false;
        this._array.push(aMapping);
      }
    };
    MappingList.prototype.toArray = function MappingList_toArray() {
      if (!this._sorted) {
        this._array.sort(util.compareByGeneratedPositionsInflated);
        this._sorted = true;
      }
      return this._array;
    };
    exports2.MappingList = MappingList;
  }
});

// node_modules/source-map-js/lib/source-map-generator.js
var require_source_map_generator = __commonJS({
  "node_modules/source-map-js/lib/source-map-generator.js"(exports2) {
    var base64VLQ = require_base64_vlq();
    var util = require_util();
    var ArraySet = require_array_set().ArraySet;
    var MappingList = require_mapping_list().MappingList;
    function SourceMapGenerator(aArgs) {
      if (!aArgs) {
        aArgs = {};
      }
      this._file = util.getArg(aArgs, "file", null);
      this._sourceRoot = util.getArg(aArgs, "sourceRoot", null);
      this._skipValidation = util.getArg(aArgs, "skipValidation", false);
      this._ignoreInvalidMapping = util.getArg(aArgs, "ignoreInvalidMapping", false);
      this._sources = new ArraySet();
      this._names = new ArraySet();
      this._mappings = new MappingList();
      this._sourcesContents = null;
    }
    SourceMapGenerator.prototype._version = 3;
    SourceMapGenerator.fromSourceMap = function SourceMapGenerator_fromSourceMap(aSourceMapConsumer, generatorOps) {
      var sourceRoot = aSourceMapConsumer.sourceRoot;
      var generator = new SourceMapGenerator(Object.assign(generatorOps || {}, {
        file: aSourceMapConsumer.file,
        sourceRoot
      }));
      aSourceMapConsumer.eachMapping(function(mapping) {
        var newMapping = {
          generated: {
            line: mapping.generatedLine,
            column: mapping.generatedColumn
          }
        };
        if (mapping.source != null) {
          newMapping.source = mapping.source;
          if (sourceRoot != null) {
            newMapping.source = util.relative(sourceRoot, newMapping.source);
          }
          newMapping.original = {
            line: mapping.originalLine,
            column: mapping.originalColumn
          };
          if (mapping.name != null) {
            newMapping.name = mapping.name;
          }
        }
        generator.addMapping(newMapping);
      });
      aSourceMapConsumer.sources.forEach(function(sourceFile) {
        var sourceRelative = sourceFile;
        if (sourceRoot !== null) {
          sourceRelative = util.relative(sourceRoot, sourceFile);
        }
        if (!generator._sources.has(sourceRelative)) {
          generator._sources.add(sourceRelative);
        }
        var content = aSourceMapConsumer.sourceContentFor(sourceFile);
        if (content != null) {
          generator.setSourceContent(sourceFile, content);
        }
      });
      return generator;
    };
    SourceMapGenerator.prototype.addMapping = function SourceMapGenerator_addMapping(aArgs) {
      var generated = util.getArg(aArgs, "generated");
      var original = util.getArg(aArgs, "original", null);
      var source = util.getArg(aArgs, "source", null);
      var name = util.getArg(aArgs, "name", null);
      if (!this._skipValidation) {
        if (this._validateMapping(generated, original, source, name) === false) {
          return;
        }
      }
      if (source != null) {
        source = String(source);
        if (!this._sources.has(source)) {
          this._sources.add(source);
        }
      }
      if (name != null) {
        name = String(name);
        if (!this._names.has(name)) {
          this._names.add(name);
        }
      }
      this._mappings.add({
        generatedLine: generated.line,
        generatedColumn: generated.column,
        originalLine: original != null && original.line,
        originalColumn: original != null && original.column,
        source,
        name
      });
    };
    SourceMapGenerator.prototype.setSourceContent = function SourceMapGenerator_setSourceContent(aSourceFile, aSourceContent) {
      var source = aSourceFile;
      if (this._sourceRoot != null) {
        source = util.relative(this._sourceRoot, source);
      }
      if (aSourceContent != null) {
        if (!this._sourcesContents) {
          this._sourcesContents = /* @__PURE__ */ Object.create(null);
        }
        this._sourcesContents[util.toSetString(source)] = aSourceContent;
      } else if (this._sourcesContents) {
        delete this._sourcesContents[util.toSetString(source)];
        if (Object.keys(this._sourcesContents).length === 0) {
          this._sourcesContents = null;
        }
      }
    };
    SourceMapGenerator.prototype.applySourceMap = function SourceMapGenerator_applySourceMap(aSourceMapConsumer, aSourceFile, aSourceMapPath) {
      var sourceFile = aSourceFile;
      if (aSourceFile == null) {
        if (aSourceMapConsumer.file == null) {
          throw new Error(
            `SourceMapGenerator.prototype.applySourceMap requires either an explicit source file, or the source map's "file" property. Both were omitted.`
          );
        }
        sourceFile = aSourceMapConsumer.file;
      }
      var sourceRoot = this._sourceRoot;
      if (sourceRoot != null) {
        sourceFile = util.relative(sourceRoot, sourceFile);
      }
      var newSources = new ArraySet();
      var newNames = new ArraySet();
      this._mappings.unsortedForEach(function(mapping) {
        if (mapping.source === sourceFile && mapping.originalLine != null) {
          var original = aSourceMapConsumer.originalPositionFor({
            line: mapping.originalLine,
            column: mapping.originalColumn
          });
          if (original.source != null) {
            mapping.source = original.source;
            if (aSourceMapPath != null) {
              mapping.source = util.join(aSourceMapPath, mapping.source);
            }
            if (sourceRoot != null) {
              mapping.source = util.relative(sourceRoot, mapping.source);
            }
            mapping.originalLine = original.line;
            mapping.originalColumn = original.column;
            if (original.name != null) {
              mapping.name = original.name;
            }
          }
        }
        var source = mapping.source;
        if (source != null && !newSources.has(source)) {
          newSources.add(source);
        }
        var name = mapping.name;
        if (name != null && !newNames.has(name)) {
          newNames.add(name);
        }
      }, this);
      this._sources = newSources;
      this._names = newNames;
      aSourceMapConsumer.sources.forEach(function(sourceFile2) {
        var content = aSourceMapConsumer.sourceContentFor(sourceFile2);
        if (content != null) {
          if (aSourceMapPath != null) {
            sourceFile2 = util.join(aSourceMapPath, sourceFile2);
          }
          if (sourceRoot != null) {
            sourceFile2 = util.relative(sourceRoot, sourceFile2);
          }
          this.setSourceContent(sourceFile2, content);
        }
      }, this);
    };
    SourceMapGenerator.prototype._validateMapping = function SourceMapGenerator_validateMapping(aGenerated, aOriginal, aSource, aName) {
      if (aOriginal && typeof aOriginal.line !== "number" && typeof aOriginal.column !== "number") {
        var message = "original.line and original.column are not numbers -- you probably meant to omit the original mapping entirely and only map the generated position. If so, pass null for the original mapping instead of an object with empty or null values.";
        if (this._ignoreInvalidMapping) {
          if (typeof console !== "undefined" && console.warn) {
            console.warn(message);
          }
          return false;
        } else {
          throw new Error(message);
        }
      }
      if (aGenerated && "line" in aGenerated && "column" in aGenerated && aGenerated.line > 0 && aGenerated.column >= 0 && !aOriginal && !aSource && !aName) {
        return;
      } else if (aGenerated && "line" in aGenerated && "column" in aGenerated && aOriginal && "line" in aOriginal && "column" in aOriginal && aGenerated.line > 0 && aGenerated.column >= 0 && aOriginal.line > 0 && aOriginal.column >= 0 && aSource) {
        return;
      } else {
        var message = "Invalid mapping: " + JSON.stringify({
          generated: aGenerated,
          source: aSource,
          original: aOriginal,
          name: aName
        });
        if (this._ignoreInvalidMapping) {
          if (typeof console !== "undefined" && console.warn) {
            console.warn(message);
          }
          return false;
        } else {
          throw new Error(message);
        }
      }
    };
    SourceMapGenerator.prototype._serializeMappings = function SourceMapGenerator_serializeMappings() {
      var previousGeneratedColumn = 0;
      var previousGeneratedLine = 1;
      var previousOriginalColumn = 0;
      var previousOriginalLine = 0;
      var previousName = 0;
      var previousSource = 0;
      var result = "";
      var next;
      var mapping;
      var nameIdx;
      var sourceIdx;
      var mappings = this._mappings.toArray();
      for (var i = 0, len = mappings.length; i < len; i++) {
        mapping = mappings[i];
        next = "";
        if (mapping.generatedLine !== previousGeneratedLine) {
          previousGeneratedColumn = 0;
          while (mapping.generatedLine !== previousGeneratedLine) {
            next += ";";
            previousGeneratedLine++;
          }
        } else {
          if (i > 0) {
            if (!util.compareByGeneratedPositionsInflated(mapping, mappings[i - 1])) {
              continue;
            }
            next += ",";
          }
        }
        next += base64VLQ.encode(mapping.generatedColumn - previousGeneratedColumn);
        previousGeneratedColumn = mapping.generatedColumn;
        if (mapping.source != null) {
          sourceIdx = this._sources.indexOf(mapping.source);
          next += base64VLQ.encode(sourceIdx - previousSource);
          previousSource = sourceIdx;
          next += base64VLQ.encode(mapping.originalLine - 1 - previousOriginalLine);
          previousOriginalLine = mapping.originalLine - 1;
          next += base64VLQ.encode(mapping.originalColumn - previousOriginalColumn);
          previousOriginalColumn = mapping.originalColumn;
          if (mapping.name != null) {
            nameIdx = this._names.indexOf(mapping.name);
            next += base64VLQ.encode(nameIdx - previousName);
            previousName = nameIdx;
          }
        }
        result += next;
      }
      return result;
    };
    SourceMapGenerator.prototype._generateSourcesContent = function SourceMapGenerator_generateSourcesContent(aSources, aSourceRoot) {
      return aSources.map(function(source) {
        if (!this._sourcesContents) {
          return null;
        }
        if (aSourceRoot != null) {
          source = util.relative(aSourceRoot, source);
        }
        var key = util.toSetString(source);
        return Object.prototype.hasOwnProperty.call(this._sourcesContents, key) ? this._sourcesContents[key] : null;
      }, this);
    };
    SourceMapGenerator.prototype.toJSON = function SourceMapGenerator_toJSON() {
      var map = {
        version: this._version,
        sources: this._sources.toArray(),
        names: this._names.toArray(),
        mappings: this._serializeMappings()
      };
      if (this._file != null) {
        map.file = this._file;
      }
      if (this._sourceRoot != null) {
        map.sourceRoot = this._sourceRoot;
      }
      if (this._sourcesContents) {
        map.sourcesContent = this._generateSourcesContent(map.sources, map.sourceRoot);
      }
      return map;
    };
    SourceMapGenerator.prototype.toString = function SourceMapGenerator_toString() {
      return JSON.stringify(this.toJSON());
    };
    exports2.SourceMapGenerator = SourceMapGenerator;
  }
});

// node_modules/css-tree/cjs/generator/sourceMap.cjs
var require_sourceMap = __commonJS({
  "node_modules/css-tree/cjs/generator/sourceMap.cjs"(exports2) {
    "use strict";
    var sourceMapGenerator_js = require_source_map_generator();
    var trackNodes = /* @__PURE__ */ new Set(["Atrule", "Selector", "Declaration"]);
    function generateSourceMap(handlers) {
      const map = new sourceMapGenerator_js.SourceMapGenerator();
      const generated = {
        line: 1,
        column: 0
      };
      const original = {
        line: 0,
        // should be zero to add first mapping
        column: 0
      };
      const activatedGenerated = {
        line: 1,
        column: 0
      };
      const activatedMapping = {
        generated: activatedGenerated
      };
      let line = 1;
      let column = 0;
      let sourceMappingActive = false;
      const origHandlersNode = handlers.node;
      handlers.node = function(node) {
        if (node.loc && node.loc.start && trackNodes.has(node.type)) {
          const nodeLine = node.loc.start.line;
          const nodeColumn = node.loc.start.column - 1;
          if (original.line !== nodeLine || original.column !== nodeColumn) {
            original.line = nodeLine;
            original.column = nodeColumn;
            generated.line = line;
            generated.column = column;
            if (sourceMappingActive) {
              sourceMappingActive = false;
              if (generated.line !== activatedGenerated.line || generated.column !== activatedGenerated.column) {
                map.addMapping(activatedMapping);
              }
            }
            sourceMappingActive = true;
            map.addMapping({
              source: node.loc.source,
              original,
              generated
            });
          }
        }
        origHandlersNode.call(this, node);
        if (sourceMappingActive && trackNodes.has(node.type)) {
          activatedGenerated.line = line;
          activatedGenerated.column = column;
        }
      };
      const origHandlersEmit = handlers.emit;
      handlers.emit = function(value, type, auto) {
        for (let i = 0; i < value.length; i++) {
          if (value.charCodeAt(i) === 10) {
            line++;
            column = 0;
          } else {
            column++;
          }
        }
        origHandlersEmit(value, type, auto);
      };
      const origHandlersResult = handlers.result;
      handlers.result = function() {
        if (sourceMappingActive) {
          map.addMapping(activatedMapping);
        }
        return {
          css: origHandlersResult(),
          map
        };
      };
      return handlers;
    }
    exports2.generateSourceMap = generateSourceMap;
  }
});

// node_modules/css-tree/cjs/generator/token-before.cjs
var require_token_before = __commonJS({
  "node_modules/css-tree/cjs/generator/token-before.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var PLUSSIGN = 43;
    var HYPHENMINUS = 45;
    var code = (type, value) => {
      if (type === types.Delim) {
        type = value;
      }
      if (typeof type === "string") {
        type = Math.min(type.charCodeAt(0), 128) << 6;
      }
      return type << 1;
    };
    var specPairs = [
      [types.Ident, types.Ident],
      [types.Ident, types.Function],
      [types.Ident, types.Url],
      [types.Ident, types.BadUrl],
      [types.Ident, "-"],
      [types.Ident, types.Number],
      [types.Ident, types.Percentage],
      [types.Ident, types.Dimension],
      [types.Ident, types.CDC],
      [types.Ident, types.LeftParenthesis],
      [types.AtKeyword, types.Ident],
      [types.AtKeyword, types.Function],
      [types.AtKeyword, types.Url],
      [types.AtKeyword, types.BadUrl],
      [types.AtKeyword, "-"],
      [types.AtKeyword, types.Number],
      [types.AtKeyword, types.Percentage],
      [types.AtKeyword, types.Dimension],
      [types.AtKeyword, types.CDC],
      [types.Hash, types.Ident],
      [types.Hash, types.Function],
      [types.Hash, types.Url],
      [types.Hash, types.BadUrl],
      [types.Hash, "-"],
      [types.Hash, types.Number],
      [types.Hash, types.Percentage],
      [types.Hash, types.Dimension],
      [types.Hash, types.CDC],
      [types.Dimension, types.Ident],
      [types.Dimension, types.Function],
      [types.Dimension, types.Url],
      [types.Dimension, types.BadUrl],
      [types.Dimension, "-"],
      [types.Dimension, types.Number],
      [types.Dimension, types.Percentage],
      [types.Dimension, types.Dimension],
      [types.Dimension, types.CDC],
      ["#", types.Ident],
      ["#", types.Function],
      ["#", types.Url],
      ["#", types.BadUrl],
      ["#", "-"],
      ["#", types.Number],
      ["#", types.Percentage],
      ["#", types.Dimension],
      ["#", types.CDC],
      // https://github.com/w3c/csswg-drafts/pull/6874
      ["-", types.Ident],
      ["-", types.Function],
      ["-", types.Url],
      ["-", types.BadUrl],
      ["-", "-"],
      ["-", types.Number],
      ["-", types.Percentage],
      ["-", types.Dimension],
      ["-", types.CDC],
      // https://github.com/w3c/csswg-drafts/pull/6874
      [types.Number, types.Ident],
      [types.Number, types.Function],
      [types.Number, types.Url],
      [types.Number, types.BadUrl],
      [types.Number, types.Number],
      [types.Number, types.Percentage],
      [types.Number, types.Dimension],
      [types.Number, "%"],
      [types.Number, types.CDC],
      // https://github.com/w3c/csswg-drafts/pull/6874
      ["@", types.Ident],
      ["@", types.Function],
      ["@", types.Url],
      ["@", types.BadUrl],
      ["@", "-"],
      ["@", types.CDC],
      // https://github.com/w3c/csswg-drafts/pull/6874
      [".", types.Number],
      [".", types.Percentage],
      [".", types.Dimension],
      ["+", types.Number],
      ["+", types.Percentage],
      ["+", types.Dimension],
      ["/", "*"]
    ];
    var safePairs = specPairs.concat([
      [types.Ident, types.Hash],
      [types.Dimension, types.Hash],
      [types.Hash, types.Hash],
      [types.AtKeyword, types.LeftParenthesis],
      [types.AtKeyword, types.String],
      [types.AtKeyword, types.Colon],
      [types.Percentage, types.Percentage],
      [types.Percentage, types.Dimension],
      [types.Percentage, types.Function],
      [types.Percentage, "-"],
      [types.RightParenthesis, types.Ident],
      [types.RightParenthesis, types.Function],
      [types.RightParenthesis, types.Percentage],
      [types.RightParenthesis, types.Dimension],
      [types.RightParenthesis, types.Hash],
      [types.RightParenthesis, "-"]
    ]);
    function createMap(pairs) {
      const isWhiteSpaceRequired = new Set(
        pairs.map(([prev, next]) => code(prev) << 16 | code(next))
      );
      return function(prevCode, type, value) {
        const nextCode = code(type, value);
        const nextCharCode = value.charCodeAt(0);
        const emitWs = nextCharCode === HYPHENMINUS && type !== types.Ident && type !== types.Function && type !== types.CDC || nextCharCode === PLUSSIGN ? isWhiteSpaceRequired.has((prevCode & 65534) << 16 | nextCharCode << 7) : isWhiteSpaceRequired.has((prevCode & 65534) << 16 | nextCode);
        return nextCode | emitWs;
      };
    }
    var spec = createMap(specPairs);
    var safe = createMap(safePairs);
    exports2.safe = safe;
    exports2.spec = spec;
  }
});

// node_modules/css-tree/cjs/generator/create.cjs
var require_create2 = __commonJS({
  "node_modules/css-tree/cjs/generator/create.cjs"(exports2) {
    "use strict";
    var index = require_tokenizer();
    var sourceMap = require_sourceMap();
    var tokenBefore = require_token_before();
    var types = require_types();
    var REVERSESOLIDUS = 92;
    function processChildren(node, delimeter) {
      if (typeof delimeter === "function") {
        let prev = null;
        node.children.forEach((node2) => {
          if (prev !== null) {
            delimeter.call(this, prev);
          }
          this.node(node2);
          prev = node2;
        });
        return;
      }
      node.children.forEach(this.node, this);
    }
    function createGenerator(config) {
      const types$1 = /* @__PURE__ */ new Map();
      for (let [name, item] of Object.entries(config.node)) {
        const fn = item.generate || item;
        if (typeof fn === "function") {
          types$1.set(name, item.generate || item);
        }
      }
      return function(node, options) {
        let buffer = "";
        let prevCode = 0;
        let handlers = {
          node(node2) {
            if (types$1.has(node2.type)) {
              types$1.get(node2.type).call(publicApi, node2);
            } else {
              throw new Error("Unknown node type: " + node2.type);
            }
          },
          tokenBefore: tokenBefore.safe,
          token(type, value, suppressAutoWhiteSpace) {
            prevCode = this.tokenBefore(prevCode, type, value);
            if (!suppressAutoWhiteSpace && prevCode & 1) {
              this.emit(" ", types.WhiteSpace, true);
            }
            this.emit(value, type, false);
            if (type === types.Delim && value.charCodeAt(0) === REVERSESOLIDUS) {
              this.emit("\n", types.WhiteSpace, true);
            }
          },
          emit(value) {
            buffer += value;
          },
          result() {
            return buffer;
          }
        };
        if (options) {
          if (typeof options.decorator === "function") {
            handlers = options.decorator(handlers);
          }
          if (options.sourceMap) {
            handlers = sourceMap.generateSourceMap(handlers);
          }
          if (options.mode in tokenBefore) {
            handlers.tokenBefore = tokenBefore[options.mode];
          }
        }
        const publicApi = {
          node: (node2) => handlers.node(node2),
          children: processChildren,
          token: (type, value) => handlers.token(type, value),
          tokenize: (raw) => index.tokenize(raw, (type, start, end) => {
            handlers.token(
              type,
              raw.slice(start, end),
              start !== 0
              // suppress auto whitespace for internal value tokens
            );
          })
        };
        handlers.node(node);
        return handlers.result();
      };
    }
    exports2.createGenerator = createGenerator;
  }
});

// node_modules/css-tree/cjs/convertor/create.cjs
var require_create3 = __commonJS({
  "node_modules/css-tree/cjs/convertor/create.cjs"(exports2) {
    "use strict";
    var List = require_List();
    function createConvertor(walk) {
      return {
        fromPlainObject(ast) {
          walk(ast, {
            enter(node) {
              if (node.children && node.children instanceof List.List === false) {
                node.children = new List.List().fromArray(node.children);
              }
            }
          });
          return ast;
        },
        toPlainObject(ast) {
          walk(ast, {
            leave(node) {
              if (node.children && node.children instanceof List.List) {
                node.children = node.children.toArray();
              }
            }
          });
          return ast;
        }
      };
    }
    exports2.createConvertor = createConvertor;
  }
});

// node_modules/css-tree/cjs/walker/create.cjs
var require_create4 = __commonJS({
  "node_modules/css-tree/cjs/walker/create.cjs"(exports2) {
    "use strict";
    var { hasOwnProperty: hasOwnProperty2 } = Object.prototype;
    var noop = function() {
    };
    function ensureFunction(value) {
      return typeof value === "function" ? value : noop;
    }
    function invokeForType(fn, type) {
      return function(node, item, list) {
        if (node.type === type) {
          fn.call(this, node, item, list);
        }
      };
    }
    function getWalkersFromStructure(name, nodeType) {
      const structure = nodeType.structure;
      const walkers = [];
      for (const key in structure) {
        if (hasOwnProperty2.call(structure, key) === false) {
          continue;
        }
        let fieldTypes = structure[key];
        const walker = {
          name: key,
          type: false,
          nullable: false
        };
        if (!Array.isArray(fieldTypes)) {
          fieldTypes = [fieldTypes];
        }
        for (const fieldType of fieldTypes) {
          if (fieldType === null) {
            walker.nullable = true;
          } else if (typeof fieldType === "string") {
            walker.type = "node";
          } else if (Array.isArray(fieldType)) {
            walker.type = "list";
          }
        }
        if (walker.type) {
          walkers.push(walker);
        }
      }
      if (walkers.length) {
        return {
          context: nodeType.walkContext,
          fields: walkers
        };
      }
      return null;
    }
    function getTypesFromConfig(config) {
      const types = {};
      for (const name in config.node) {
        if (hasOwnProperty2.call(config.node, name)) {
          const nodeType = config.node[name];
          if (!nodeType.structure) {
            throw new Error("Missed `structure` field in `" + name + "` node type definition");
          }
          types[name] = getWalkersFromStructure(name, nodeType);
        }
      }
      return types;
    }
    function createTypeIterator(config, reverse) {
      const fields = config.fields.slice();
      const contextName = config.context;
      const useContext = typeof contextName === "string";
      if (reverse) {
        fields.reverse();
      }
      return function(node, context, walk, walkReducer) {
        let prevContextValue;
        if (useContext) {
          prevContextValue = context[contextName];
          context[contextName] = node;
        }
        for (const field of fields) {
          const ref = node[field.name];
          if (!field.nullable || ref) {
            if (field.type === "list") {
              const breakWalk = reverse ? ref.reduceRight(walkReducer, false) : ref.reduce(walkReducer, false);
              if (breakWalk) {
                return true;
              }
            } else if (walk(ref)) {
              return true;
            }
          }
        }
        if (useContext) {
          context[contextName] = prevContextValue;
        }
      };
    }
    function createFastTraveralMap({
      StyleSheet,
      Atrule,
      Rule,
      Block,
      DeclarationList
    }) {
      return {
        Atrule: {
          StyleSheet,
          Atrule,
          Rule,
          Block
        },
        Rule: {
          StyleSheet,
          Atrule,
          Rule,
          Block
        },
        Declaration: {
          StyleSheet,
          Atrule,
          Rule,
          Block,
          DeclarationList
        }
      };
    }
    function createWalker(config) {
      const types = getTypesFromConfig(config);
      const iteratorsNatural = {};
      const iteratorsReverse = {};
      const breakWalk = /* @__PURE__ */ Symbol("break-walk");
      const skipNode = /* @__PURE__ */ Symbol("skip-node");
      for (const name in types) {
        if (hasOwnProperty2.call(types, name) && types[name] !== null) {
          iteratorsNatural[name] = createTypeIterator(types[name], false);
          iteratorsReverse[name] = createTypeIterator(types[name], true);
        }
      }
      const fastTraversalIteratorsNatural = createFastTraveralMap(iteratorsNatural);
      const fastTraversalIteratorsReverse = createFastTraveralMap(iteratorsReverse);
      const walk = function(root, options) {
        function walkNode(node, item, list) {
          const enterRet = enter.call(context, node, item, list);
          if (enterRet === breakWalk) {
            return true;
          }
          if (enterRet === skipNode) {
            return false;
          }
          if (iterators.hasOwnProperty(node.type)) {
            if (iterators[node.type](node, context, walkNode, walkReducer)) {
              return true;
            }
          }
          if (leave.call(context, node, item, list) === breakWalk) {
            return true;
          }
          return false;
        }
        let enter = noop;
        let leave = noop;
        let iterators = iteratorsNatural;
        let walkReducer = (ret, data, item, list) => ret || walkNode(data, item, list);
        const context = {
          break: breakWalk,
          skip: skipNode,
          root,
          stylesheet: null,
          atrule: null,
          atrulePrelude: null,
          rule: null,
          selector: null,
          block: null,
          declaration: null,
          function: null
        };
        if (typeof options === "function") {
          enter = options;
        } else if (options) {
          enter = ensureFunction(options.enter);
          leave = ensureFunction(options.leave);
          if (options.reverse) {
            iterators = iteratorsReverse;
          }
          if (options.visit) {
            if (fastTraversalIteratorsNatural.hasOwnProperty(options.visit)) {
              iterators = options.reverse ? fastTraversalIteratorsReverse[options.visit] : fastTraversalIteratorsNatural[options.visit];
            } else if (!types.hasOwnProperty(options.visit)) {
              throw new Error("Bad value `" + options.visit + "` for `visit` option (should be: " + Object.keys(types).sort().join(", ") + ")");
            }
            enter = invokeForType(enter, options.visit);
            leave = invokeForType(leave, options.visit);
          }
        }
        if (enter === noop && leave === noop) {
          throw new Error("Neither `enter` nor `leave` walker handler is set or both aren't a function");
        }
        walkNode(root);
      };
      walk.break = breakWalk;
      walk.skip = skipNode;
      walk.find = function(ast, fn) {
        let found = null;
        walk(ast, function(node, item, list) {
          if (fn.call(this, node, item, list)) {
            found = node;
            return breakWalk;
          }
        });
        return found;
      };
      walk.findLast = function(ast, fn) {
        let found = null;
        walk(ast, {
          reverse: true,
          enter(node, item, list) {
            if (fn.call(this, node, item, list)) {
              found = node;
              return breakWalk;
            }
          }
        });
        return found;
      };
      walk.findAll = function(ast, fn) {
        const found = [];
        walk(ast, function(node, item, list) {
          if (fn.call(this, node, item, list)) {
            found.push(node);
          }
        });
        return found;
      };
      return walk;
    }
    exports2.createWalker = createWalker;
  }
});

// node_modules/css-tree/cjs/definition-syntax/generate.cjs
var require_generate = __commonJS({
  "node_modules/css-tree/cjs/definition-syntax/generate.cjs"(exports2) {
    "use strict";
    function noop(value) {
      return value;
    }
    function generateMultiplier(multiplier) {
      const { min, max, comma } = multiplier;
      if (min === 0 && max === 0) {
        return comma ? "#?" : "*";
      }
      if (min === 0 && max === 1) {
        return "?";
      }
      if (min === 1 && max === 0) {
        return comma ? "#" : "+";
      }
      if (min === 1 && max === 1) {
        return "";
      }
      return (comma ? "#" : "") + (min === max ? "{" + min + "}" : "{" + min + "," + (max !== 0 ? max : "") + "}");
    }
    function generateTypeOpts(node) {
      switch (node.type) {
        case "Range":
          return " [" + (node.min === null ? "-\u221E" : node.min) + "," + (node.max === null ? "\u221E" : node.max) + "]";
        default:
          throw new Error("Unknown node type `" + node.type + "`");
      }
    }
    function generateSequence(node, decorate, forceBraces, compact) {
      const combinator = node.combinator === " " || compact ? node.combinator : " " + node.combinator + " ";
      const result = node.terms.map((term) => internalGenerate(term, decorate, forceBraces, compact)).join(combinator);
      if (node.explicit || forceBraces) {
        return (compact || result[0] === "," ? "[" : "[ ") + result + (compact ? "]" : " ]");
      }
      return result;
    }
    function internalGenerate(node, decorate, forceBraces, compact) {
      let result;
      switch (node.type) {
        case "Group":
          result = generateSequence(node, decorate, forceBraces, compact) + (node.disallowEmpty ? "!" : "");
          break;
        case "Multiplier":
          return internalGenerate(node.term, decorate, forceBraces, compact) + decorate(generateMultiplier(node), node);
        case "Boolean":
          result = "<boolean-expr[" + internalGenerate(node.term, decorate, forceBraces, compact) + "]>";
          break;
        case "Type":
          result = "<" + node.name + (node.opts ? decorate(generateTypeOpts(node.opts), node.opts) : "") + ">";
          break;
        case "Property":
          result = "<'" + node.name + "'>";
          break;
        case "Keyword":
          result = node.name;
          break;
        case "AtKeyword":
          result = "@" + node.name;
          break;
        case "Function":
          result = node.name + "(";
          break;
        case "String":
        case "Token":
          result = node.value;
          break;
        case "Comma":
          result = ",";
          break;
        default:
          throw new Error("Unknown node type `" + node.type + "`");
      }
      return decorate(result, node);
    }
    function generate(node, options) {
      let decorate = noop;
      let forceBraces = false;
      let compact = false;
      if (typeof options === "function") {
        decorate = options;
      } else if (options) {
        forceBraces = Boolean(options.forceBraces);
        compact = Boolean(options.compact);
        if (typeof options.decorate === "function") {
          decorate = options.decorate;
        }
      }
      return internalGenerate(node, decorate, forceBraces, compact);
    }
    exports2.generate = generate;
  }
});

// node_modules/css-tree/cjs/lexer/error.cjs
var require_error = __commonJS({
  "node_modules/css-tree/cjs/lexer/error.cjs"(exports2) {
    "use strict";
    var createCustomError = require_create_custom_error();
    var generate = require_generate();
    var defaultLoc = { offset: 0, line: 1, column: 1 };
    function locateMismatch(matchResult, node) {
      const tokens = matchResult.tokens;
      const longestMatch = matchResult.longestMatch;
      const mismatchNode = longestMatch < tokens.length ? tokens[longestMatch].node || null : null;
      const badNode = mismatchNode !== node ? mismatchNode : null;
      let mismatchOffset = 0;
      let mismatchLength = 0;
      let entries = 0;
      let css = "";
      let start;
      let end;
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i].value;
        if (i === longestMatch) {
          mismatchLength = token.length;
          mismatchOffset = css.length;
        }
        if (badNode !== null && tokens[i].node === badNode) {
          if (i <= longestMatch) {
            entries++;
          } else {
            entries = 0;
          }
        }
        css += token;
      }
      if (longestMatch === tokens.length || entries > 1) {
        start = fromLoc(badNode || node, "end") || buildLoc(defaultLoc, css);
        end = buildLoc(start);
      } else {
        start = fromLoc(badNode, "start") || buildLoc(fromLoc(node, "start") || defaultLoc, css.slice(0, mismatchOffset));
        end = fromLoc(badNode, "end") || buildLoc(start, css.substr(mismatchOffset, mismatchLength));
      }
      return {
        css,
        mismatchOffset,
        mismatchLength,
        start,
        end
      };
    }
    function fromLoc(node, point) {
      const value = node && node.loc && node.loc[point];
      if (value) {
        return "line" in value ? buildLoc(value) : value;
      }
      return null;
    }
    function buildLoc({ offset, line, column }, extra) {
      const loc = {
        offset,
        line,
        column
      };
      if (extra) {
        const lines = extra.split(/\n|\r\n?|\f/);
        loc.offset += extra.length;
        loc.line += lines.length - 1;
        loc.column = lines.length === 1 ? loc.column + extra.length : lines.pop().length + 1;
      }
      return loc;
    }
    var SyntaxReferenceError = function(type, referenceName) {
      const error = createCustomError.createCustomError(
        "SyntaxReferenceError",
        type + (referenceName ? " `" + referenceName + "`" : "")
      );
      error.reference = referenceName;
      return error;
    };
    var SyntaxMatchError = function(message, syntax, node, matchResult) {
      const error = createCustomError.createCustomError("SyntaxMatchError", message);
      const {
        css,
        mismatchOffset,
        mismatchLength,
        start,
        end
      } = locateMismatch(matchResult, node);
      error.rawMessage = message;
      error.syntax = syntax ? generate.generate(syntax) : "<generic>";
      error.css = css;
      error.mismatchOffset = mismatchOffset;
      error.mismatchLength = mismatchLength;
      error.message = message + "\n  syntax: " + error.syntax + "\n   value: " + (css || "<empty string>") + "\n  --------" + new Array(error.mismatchOffset + 1).join("-") + "^";
      Object.assign(error, start);
      error.loc = {
        source: node && node.loc && node.loc.source || "<unknown>",
        start,
        end
      };
      return error;
    };
    exports2.SyntaxMatchError = SyntaxMatchError;
    exports2.SyntaxReferenceError = SyntaxReferenceError;
  }
});

// node_modules/css-tree/cjs/utils/names.cjs
var require_names2 = __commonJS({
  "node_modules/css-tree/cjs/utils/names.cjs"(exports2) {
    "use strict";
    var keywords = /* @__PURE__ */ new Map();
    var properties = /* @__PURE__ */ new Map();
    var HYPHENMINUS = 45;
    var keyword = getKeywordDescriptor;
    var property = getPropertyDescriptor;
    var vendorPrefix = getVendorPrefix;
    function isCustomProperty(str, offset) {
      offset = offset || 0;
      return str.length - offset >= 2 && str.charCodeAt(offset) === HYPHENMINUS && str.charCodeAt(offset + 1) === HYPHENMINUS;
    }
    function getVendorPrefix(str, offset) {
      offset = offset || 0;
      if (str.length - offset >= 3) {
        if (str.charCodeAt(offset) === HYPHENMINUS && str.charCodeAt(offset + 1) !== HYPHENMINUS) {
          const secondDashIndex = str.indexOf("-", offset + 2);
          if (secondDashIndex !== -1) {
            return str.substring(offset, secondDashIndex + 1);
          }
        }
      }
      return "";
    }
    function getKeywordDescriptor(keyword2) {
      if (keywords.has(keyword2)) {
        return keywords.get(keyword2);
      }
      const name = keyword2.toLowerCase();
      let descriptor = keywords.get(name);
      if (descriptor === void 0) {
        const custom = isCustomProperty(name, 0);
        const vendor = !custom ? getVendorPrefix(name, 0) : "";
        descriptor = Object.freeze({
          basename: name.substr(vendor.length),
          name,
          prefix: vendor,
          vendor,
          custom
        });
      }
      keywords.set(keyword2, descriptor);
      return descriptor;
    }
    function getPropertyDescriptor(property2) {
      if (properties.has(property2)) {
        return properties.get(property2);
      }
      let name = property2;
      let hack = property2[0];
      if (hack === "/") {
        hack = property2[1] === "/" ? "//" : "/";
      } else if (hack !== "_" && hack !== "*" && hack !== "$" && hack !== "#" && hack !== "+" && hack !== "&") {
        hack = "";
      }
      const custom = isCustomProperty(name, hack.length);
      if (!custom) {
        name = name.toLowerCase();
        if (properties.has(name)) {
          const descriptor2 = properties.get(name);
          properties.set(property2, descriptor2);
          return descriptor2;
        }
      }
      const vendor = !custom ? getVendorPrefix(name, hack.length) : "";
      const prefix = name.substr(0, hack.length + vendor.length);
      const descriptor = Object.freeze({
        basename: name.substr(prefix.length),
        name: name.substr(hack.length),
        hack,
        vendor,
        prefix,
        custom
      });
      properties.set(property2, descriptor);
      return descriptor;
    }
    exports2.isCustomProperty = isCustomProperty;
    exports2.keyword = keyword;
    exports2.property = property;
    exports2.vendorPrefix = vendorPrefix;
  }
});

// node_modules/css-tree/cjs/lexer/generic-const.cjs
var require_generic_const = __commonJS({
  "node_modules/css-tree/cjs/lexer/generic-const.cjs"(exports2) {
    "use strict";
    var cssWideKeywords = [
      "initial",
      "inherit",
      "unset",
      "revert",
      "revert-layer"
    ];
    exports2.cssWideKeywords = cssWideKeywords;
  }
});

// node_modules/css-tree/cjs/lexer/generic-an-plus-b.cjs
var require_generic_an_plus_b = __commonJS({
  "node_modules/css-tree/cjs/lexer/generic-an-plus-b.cjs"(exports2, module2) {
    "use strict";
    var charCodeDefinitions = require_char_code_definitions();
    var types = require_types();
    var utils = require_utils();
    var PLUSSIGN = 43;
    var HYPHENMINUS = 45;
    var N = 110;
    var DISALLOW_SIGN = true;
    var ALLOW_SIGN = false;
    function isDelim(token, code) {
      return token !== null && token.type === types.Delim && token.value.charCodeAt(0) === code;
    }
    function skipSC(token, offset, getNextToken) {
      while (token !== null && (token.type === types.WhiteSpace || token.type === types.Comment)) {
        token = getNextToken(++offset);
      }
      return offset;
    }
    function checkInteger(token, valueOffset, disallowSign, offset) {
      if (!token) {
        return 0;
      }
      const code = token.value.charCodeAt(valueOffset);
      if (code === PLUSSIGN || code === HYPHENMINUS) {
        if (disallowSign) {
          return 0;
        }
        valueOffset++;
      }
      for (; valueOffset < token.value.length; valueOffset++) {
        if (!charCodeDefinitions.isDigit(token.value.charCodeAt(valueOffset))) {
          return 0;
        }
      }
      return offset + 1;
    }
    function consumeB(token, offset_, getNextToken) {
      let sign = false;
      let offset = skipSC(token, offset_, getNextToken);
      token = getNextToken(offset);
      if (token === null) {
        return offset_;
      }
      if (token.type !== types.Number) {
        if (isDelim(token, PLUSSIGN) || isDelim(token, HYPHENMINUS)) {
          sign = true;
          offset = skipSC(getNextToken(++offset), offset, getNextToken);
          token = getNextToken(offset);
          if (token === null || token.type !== types.Number) {
            return 0;
          }
        } else {
          return offset_;
        }
      }
      if (!sign) {
        const code = token.value.charCodeAt(0);
        if (code !== PLUSSIGN && code !== HYPHENMINUS) {
          return 0;
        }
      }
      return checkInteger(token, sign ? 0 : 1, sign, offset);
    }
    function anPlusB(token, getNextToken) {
      let offset = 0;
      if (!token) {
        return 0;
      }
      if (token.type === types.Number) {
        return checkInteger(token, 0, ALLOW_SIGN, offset);
      } else if (token.type === types.Ident && token.value.charCodeAt(0) === HYPHENMINUS) {
        if (!utils.cmpChar(token.value, 1, N)) {
          return 0;
        }
        switch (token.value.length) {
          // -n
          // -n <signed-integer>
          // -n ['+' | '-'] <signless-integer>
          case 2:
            return consumeB(getNextToken(++offset), offset, getNextToken);
          // -n- <signless-integer>
          case 3:
            if (token.value.charCodeAt(2) !== HYPHENMINUS) {
              return 0;
            }
            offset = skipSC(getNextToken(++offset), offset, getNextToken);
            token = getNextToken(offset);
            return checkInteger(token, 0, DISALLOW_SIGN, offset);
          // <dashndashdigit-ident>
          default:
            if (token.value.charCodeAt(2) !== HYPHENMINUS) {
              return 0;
            }
            return checkInteger(token, 3, DISALLOW_SIGN, offset);
        }
      } else if (token.type === types.Ident || isDelim(token, PLUSSIGN) && getNextToken(offset + 1).type === types.Ident) {
        if (token.type !== types.Ident) {
          token = getNextToken(++offset);
        }
        if (token === null || !utils.cmpChar(token.value, 0, N)) {
          return 0;
        }
        switch (token.value.length) {
          // '+'? n
          // '+'? n <signed-integer>
          // '+'? n ['+' | '-'] <signless-integer>
          case 1:
            return consumeB(getNextToken(++offset), offset, getNextToken);
          // '+'? n- <signless-integer>
          case 2:
            if (token.value.charCodeAt(1) !== HYPHENMINUS) {
              return 0;
            }
            offset = skipSC(getNextToken(++offset), offset, getNextToken);
            token = getNextToken(offset);
            return checkInteger(token, 0, DISALLOW_SIGN, offset);
          // '+'? <ndashdigit-ident>
          default:
            if (token.value.charCodeAt(1) !== HYPHENMINUS) {
              return 0;
            }
            return checkInteger(token, 2, DISALLOW_SIGN, offset);
        }
      } else if (token.type === types.Dimension) {
        let code = token.value.charCodeAt(0);
        let sign = code === PLUSSIGN || code === HYPHENMINUS ? 1 : 0;
        let i = sign;
        for (; i < token.value.length; i++) {
          if (!charCodeDefinitions.isDigit(token.value.charCodeAt(i))) {
            break;
          }
        }
        if (i === sign) {
          return 0;
        }
        if (!utils.cmpChar(token.value, i, N)) {
          return 0;
        }
        if (i + 1 === token.value.length) {
          return consumeB(getNextToken(++offset), offset, getNextToken);
        } else {
          if (token.value.charCodeAt(i + 1) !== HYPHENMINUS) {
            return 0;
          }
          if (i + 2 === token.value.length) {
            offset = skipSC(getNextToken(++offset), offset, getNextToken);
            token = getNextToken(offset);
            return checkInteger(token, 0, DISALLOW_SIGN, offset);
          } else {
            return checkInteger(token, i + 2, DISALLOW_SIGN, offset);
          }
        }
      }
      return 0;
    }
    module2.exports = anPlusB;
  }
});

// node_modules/css-tree/cjs/lexer/generic-urange.cjs
var require_generic_urange = __commonJS({
  "node_modules/css-tree/cjs/lexer/generic-urange.cjs"(exports2, module2) {
    "use strict";
    var charCodeDefinitions = require_char_code_definitions();
    var types = require_types();
    var utils = require_utils();
    var PLUSSIGN = 43;
    var HYPHENMINUS = 45;
    var QUESTIONMARK = 63;
    var U = 117;
    function isDelim(token, code) {
      return token !== null && token.type === types.Delim && token.value.charCodeAt(0) === code;
    }
    function startsWith(token, code) {
      return token.value.charCodeAt(0) === code;
    }
    function hexSequence(token, offset, allowDash) {
      let hexlen = 0;
      for (let pos = offset; pos < token.value.length; pos++) {
        const code = token.value.charCodeAt(pos);
        if (code === HYPHENMINUS && allowDash && hexlen !== 0) {
          hexSequence(token, offset + hexlen + 1, false);
          return 6;
        }
        if (!charCodeDefinitions.isHexDigit(code)) {
          return 0;
        }
        if (++hexlen > 6) {
          return 0;
        }
      }
      return hexlen;
    }
    function withQuestionMarkSequence(consumed, length, getNextToken) {
      if (!consumed) {
        return 0;
      }
      while (isDelim(getNextToken(length), QUESTIONMARK)) {
        if (++consumed > 6) {
          return 0;
        }
        length++;
      }
      return length;
    }
    function urange(token, getNextToken) {
      let length = 0;
      if (token === null || token.type !== types.Ident || !utils.cmpChar(token.value, 0, U)) {
        return 0;
      }
      token = getNextToken(++length);
      if (token === null) {
        return 0;
      }
      if (isDelim(token, PLUSSIGN)) {
        token = getNextToken(++length);
        if (token === null) {
          return 0;
        }
        if (token.type === types.Ident) {
          return withQuestionMarkSequence(hexSequence(token, 0, true), ++length, getNextToken);
        }
        if (isDelim(token, QUESTIONMARK)) {
          return withQuestionMarkSequence(1, ++length, getNextToken);
        }
        return 0;
      }
      if (token.type === types.Number) {
        const consumedHexLength = hexSequence(token, 1, true);
        if (consumedHexLength === 0) {
          return 0;
        }
        token = getNextToken(++length);
        if (token === null) {
          return length;
        }
        if (token.type === types.Dimension || token.type === types.Number) {
          if (!startsWith(token, HYPHENMINUS) || !hexSequence(token, 1, false)) {
            return 0;
          }
          return length + 1;
        }
        return withQuestionMarkSequence(consumedHexLength, length, getNextToken);
      }
      if (token.type === types.Dimension) {
        return withQuestionMarkSequence(hexSequence(token, 1, true), ++length, getNextToken);
      }
      return 0;
    }
    module2.exports = urange;
  }
});

// node_modules/css-tree/cjs/lexer/generic.cjs
var require_generic = __commonJS({
  "node_modules/css-tree/cjs/lexer/generic.cjs"(exports2) {
    "use strict";
    var genericConst = require_generic_const();
    var genericAnPlusB = require_generic_an_plus_b();
    var genericUrange = require_generic_urange();
    var charCodeDefinitions = require_char_code_definitions();
    var types = require_types();
    var utils = require_utils();
    var calcFunctionNames = [
      "calc(",
      "-moz-calc(",
      "-webkit-calc("
    ];
    var comparisonFunctionNames = [
      "min(",
      "max(",
      "clamp("
    ];
    var steppedValueFunctionNames = [
      "round(",
      "mod(",
      "rem("
    ];
    var trigNumberFunctionNames = [
      "sin(",
      "cos(",
      "tan("
    ];
    var trigAngleFunctionNames = [
      "asin(",
      "acos(",
      "atan(",
      "atan2("
    ];
    var otherNumberFunctionNames = [
      "pow(",
      "sqrt(",
      "log(",
      "exp(",
      "sign("
    ];
    var expNumberDimensionPercentageFunctionNames = [
      "hypot("
    ];
    var signFunctionNames = [
      "abs("
    ];
    var numberFunctionNames = [
      ...calcFunctionNames,
      ...comparisonFunctionNames,
      ...steppedValueFunctionNames,
      ...trigNumberFunctionNames,
      ...otherNumberFunctionNames,
      ...expNumberDimensionPercentageFunctionNames,
      ...signFunctionNames
    ];
    var percentageFunctionNames = [
      ...calcFunctionNames,
      ...comparisonFunctionNames,
      ...steppedValueFunctionNames,
      ...expNumberDimensionPercentageFunctionNames,
      ...signFunctionNames
    ];
    var dimensionFunctionNames = [
      ...calcFunctionNames,
      ...comparisonFunctionNames,
      ...steppedValueFunctionNames,
      ...trigAngleFunctionNames,
      ...expNumberDimensionPercentageFunctionNames,
      ...signFunctionNames
    ];
    var balancePair = /* @__PURE__ */ new Map([
      [types.Function, types.RightParenthesis],
      [types.LeftParenthesis, types.RightParenthesis],
      [types.LeftSquareBracket, types.RightSquareBracket],
      [types.LeftCurlyBracket, types.RightCurlyBracket]
    ]);
    function charCodeAt(str, index) {
      return index < str.length ? str.charCodeAt(index) : 0;
    }
    function eqStr(actual, expected) {
      return utils.cmpStr(actual, 0, actual.length, expected);
    }
    function eqStrAny(actual, expected) {
      for (let i = 0; i < expected.length; i++) {
        if (eqStr(actual, expected[i])) {
          return true;
        }
      }
      return false;
    }
    function isPostfixIeHack(str, offset) {
      if (offset !== str.length - 2) {
        return false;
      }
      return charCodeAt(str, offset) === 92 && // U+005C REVERSE SOLIDUS (\)
      charCodeDefinitions.isDigit(charCodeAt(str, offset + 1));
    }
    function outOfRange(opts, value, numEnd) {
      if (opts && opts.type === "Range") {
        const num = Number(
          numEnd !== void 0 && numEnd !== value.length ? value.substr(0, numEnd) : value
        );
        if (isNaN(num)) {
          return true;
        }
        if (opts.min !== null && num < opts.min && typeof opts.min !== "string") {
          return true;
        }
        if (opts.max !== null && num > opts.max && typeof opts.max !== "string") {
          return true;
        }
      }
      return false;
    }
    function consumeFunction(token, getNextToken) {
      let balanceCloseType = 0;
      let balanceStash = [];
      let length = 0;
      scan:
        do {
          switch (token.type) {
            case types.RightCurlyBracket:
            case types.RightParenthesis:
            case types.RightSquareBracket:
              if (token.type !== balanceCloseType) {
                break scan;
              }
              balanceCloseType = balanceStash.pop();
              if (balanceStash.length === 0) {
                length++;
                break scan;
              }
              break;
            case types.Function:
            case types.LeftParenthesis:
            case types.LeftSquareBracket:
            case types.LeftCurlyBracket:
              balanceStash.push(balanceCloseType);
              balanceCloseType = balancePair.get(token.type);
              break;
          }
          length++;
        } while (token = getNextToken(length));
      return length;
    }
    function math(next, functionNames) {
      return function(token, getNextToken, opts) {
        if (token === null) {
          return 0;
        }
        if (token.type === types.Function && eqStrAny(token.value, functionNames)) {
          return consumeFunction(token, getNextToken);
        }
        return next(token, getNextToken, opts);
      };
    }
    function tokenType(expectedTokenType) {
      return function(token) {
        if (token === null || token.type !== expectedTokenType) {
          return 0;
        }
        return 1;
      };
    }
    function customIdent(token) {
      if (token === null || token.type !== types.Ident) {
        return 0;
      }
      const name = token.value.toLowerCase();
      if (eqStrAny(name, genericConst.cssWideKeywords)) {
        return 0;
      }
      if (eqStr(name, "default")) {
        return 0;
      }
      return 1;
    }
    function dashedIdent(token) {
      if (token === null || token.type !== types.Ident) {
        return 0;
      }
      if (charCodeAt(token.value, 0) !== 45 || charCodeAt(token.value, 1) !== 45) {
        return 0;
      }
      return 1;
    }
    function customPropertyName(token) {
      if (!dashedIdent(token)) {
        return 0;
      }
      if (token.value === "--") {
        return 0;
      }
      return 1;
    }
    function hexColor(token) {
      if (token === null || token.type !== types.Hash) {
        return 0;
      }
      const length = token.value.length;
      if (length !== 4 && length !== 5 && length !== 7 && length !== 9) {
        return 0;
      }
      for (let i = 1; i < length; i++) {
        if (!charCodeDefinitions.isHexDigit(charCodeAt(token.value, i))) {
          return 0;
        }
      }
      return 1;
    }
    function idSelector(token) {
      if (token === null || token.type !== types.Hash) {
        return 0;
      }
      if (!charCodeDefinitions.isIdentifierStart(charCodeAt(token.value, 1), charCodeAt(token.value, 2), charCodeAt(token.value, 3))) {
        return 0;
      }
      return 1;
    }
    function declarationValue(token, getNextToken) {
      if (!token) {
        return 0;
      }
      let balanceCloseType = 0;
      let balanceStash = [];
      let length = 0;
      scan:
        do {
          switch (token.type) {
            // ... <bad-string-token>, <bad-url-token>,
            case types.BadString:
            case types.BadUrl:
              break scan;
            // ... unmatched <)-token>, <]-token>, or <}-token>,
            case types.RightCurlyBracket:
            case types.RightParenthesis:
            case types.RightSquareBracket:
              if (token.type !== balanceCloseType) {
                break scan;
              }
              balanceCloseType = balanceStash.pop();
              break;
            // ... or top-level <semicolon-token> tokens
            case types.Semicolon:
              if (balanceCloseType === 0) {
                break scan;
              }
              break;
            // ... or <delim-token> tokens with a value of "!"
            case types.Delim:
              if (balanceCloseType === 0 && token.value === "!") {
                break scan;
              }
              break;
            case types.Function:
            case types.LeftParenthesis:
            case types.LeftSquareBracket:
            case types.LeftCurlyBracket:
              balanceStash.push(balanceCloseType);
              balanceCloseType = balancePair.get(token.type);
              break;
          }
          length++;
        } while (token = getNextToken(length));
      return length;
    }
    function anyValue(token, getNextToken) {
      if (!token) {
        return 0;
      }
      let balanceCloseType = 0;
      let balanceStash = [];
      let length = 0;
      scan:
        do {
          switch (token.type) {
            // ... does not contain <bad-string-token>, <bad-url-token>,
            case types.BadString:
            case types.BadUrl:
              break scan;
            // ... unmatched <)-token>, <]-token>, or <}-token>,
            case types.RightCurlyBracket:
            case types.RightParenthesis:
            case types.RightSquareBracket:
              if (token.type !== balanceCloseType) {
                break scan;
              }
              balanceCloseType = balanceStash.pop();
              break;
            case types.Function:
            case types.LeftParenthesis:
            case types.LeftSquareBracket:
            case types.LeftCurlyBracket:
              balanceStash.push(balanceCloseType);
              balanceCloseType = balancePair.get(token.type);
              break;
          }
          length++;
        } while (token = getNextToken(length));
      return length;
    }
    function dimension(type) {
      if (type) {
        type = new Set(type);
      }
      return function(token, getNextToken, opts) {
        if (token === null || token.type !== types.Dimension) {
          return 0;
        }
        const numberEnd = utils.consumeNumber(token.value, 0);
        if (type !== null) {
          const reverseSolidusOffset = token.value.indexOf("\\", numberEnd);
          const unit = reverseSolidusOffset === -1 || !isPostfixIeHack(token.value, reverseSolidusOffset) ? token.value.substr(numberEnd) : token.value.substring(numberEnd, reverseSolidusOffset);
          if (type.has(unit.toLowerCase()) === false) {
            return 0;
          }
        }
        if (outOfRange(opts, token.value, numberEnd)) {
          return 0;
        }
        return 1;
      };
    }
    function percentage(token, getNextToken, opts) {
      if (token === null || token.type !== types.Percentage) {
        return 0;
      }
      if (outOfRange(opts, token.value, token.value.length - 1)) {
        return 0;
      }
      return 1;
    }
    function zero(next) {
      if (typeof next !== "function") {
        next = function() {
          return 0;
        };
      }
      return function(token, getNextToken, opts) {
        if (token !== null && token.type === types.Number) {
          if (Number(token.value) === 0) {
            return 1;
          }
        }
        return next(token, getNextToken, opts);
      };
    }
    function number(token, getNextToken, opts) {
      if (token === null) {
        return 0;
      }
      const numberEnd = utils.consumeNumber(token.value, 0);
      const isNumber2 = numberEnd === token.value.length;
      if (!isNumber2 && !isPostfixIeHack(token.value, numberEnd)) {
        return 0;
      }
      if (outOfRange(opts, token.value, numberEnd)) {
        return 0;
      }
      return 1;
    }
    function integer(token, getNextToken, opts) {
      if (token === null || token.type !== types.Number) {
        return 0;
      }
      let i = charCodeAt(token.value, 0) === 43 || // U+002B PLUS SIGN (+)
      charCodeAt(token.value, 0) === 45 ? 1 : 0;
      for (; i < token.value.length; i++) {
        if (!charCodeDefinitions.isDigit(charCodeAt(token.value, i))) {
          return 0;
        }
      }
      if (outOfRange(opts, token.value, i)) {
        return 0;
      }
      return 1;
    }
    var tokenTypes = {
      "ident-token": tokenType(types.Ident),
      "function-token": tokenType(types.Function),
      "at-keyword-token": tokenType(types.AtKeyword),
      "hash-token": tokenType(types.Hash),
      "string-token": tokenType(types.String),
      "bad-string-token": tokenType(types.BadString),
      "url-token": tokenType(types.Url),
      "bad-url-token": tokenType(types.BadUrl),
      "delim-token": tokenType(types.Delim),
      "number-token": tokenType(types.Number),
      "percentage-token": tokenType(types.Percentage),
      "dimension-token": tokenType(types.Dimension),
      "whitespace-token": tokenType(types.WhiteSpace),
      "CDO-token": tokenType(types.CDO),
      "CDC-token": tokenType(types.CDC),
      "colon-token": tokenType(types.Colon),
      "semicolon-token": tokenType(types.Semicolon),
      "comma-token": tokenType(types.Comma),
      "[-token": tokenType(types.LeftSquareBracket),
      "]-token": tokenType(types.RightSquareBracket),
      "(-token": tokenType(types.LeftParenthesis),
      ")-token": tokenType(types.RightParenthesis),
      "{-token": tokenType(types.LeftCurlyBracket),
      "}-token": tokenType(types.RightCurlyBracket)
    };
    var productionTypes = {
      // token type aliases
      "string": tokenType(types.String),
      "ident": tokenType(types.Ident),
      // percentage
      "percentage": math(percentage, percentageFunctionNames),
      // numeric
      "zero": zero(),
      "number": math(number, numberFunctionNames),
      "integer": math(integer, numberFunctionNames),
      // complex types
      "custom-ident": customIdent,
      "dashed-ident": dashedIdent,
      "custom-property-name": customPropertyName,
      "hex-color": hexColor,
      "id-selector": idSelector,
      // element( <id-selector> )
      "an-plus-b": genericAnPlusB,
      "urange": genericUrange,
      "declaration-value": declarationValue,
      "any-value": anyValue
    };
    var unitGroups = [
      "length",
      "angle",
      "time",
      "frequency",
      "resolution",
      "flex",
      "decibel",
      "semitones"
    ];
    function createDemensionTypes(units) {
      const {
        angle,
        decibel,
        frequency,
        flex,
        length,
        resolution,
        semitones,
        time
      } = units || {};
      return {
        "dimension": math(dimension(null), dimensionFunctionNames),
        "angle": math(dimension(angle), dimensionFunctionNames),
        "decibel": math(dimension(decibel), dimensionFunctionNames),
        "frequency": math(dimension(frequency), dimensionFunctionNames),
        "flex": math(dimension(flex), dimensionFunctionNames),
        "length": math(zero(dimension(length)), dimensionFunctionNames),
        "resolution": math(dimension(resolution), dimensionFunctionNames),
        "semitones": math(dimension(semitones), dimensionFunctionNames),
        "time": math(dimension(time), dimensionFunctionNames)
      };
    }
    function createAttrUnit(units) {
      const unitSet = /* @__PURE__ */ new Set();
      for (const group of unitGroups) {
        if (Array.isArray(units[group])) {
          for (const unit of units[group]) {
            unitSet.add(unit.toLowerCase());
          }
        }
      }
      return function attrUnit(token) {
        if (token === null) {
          return 0;
        }
        if (token.type === types.Delim && token.value === "%") {
          return 1;
        }
        if (token.type === types.Ident && unitSet.has(token.value.toLowerCase())) {
          return 1;
        }
        return 0;
      };
    }
    function createGenericTypes(units) {
      return {
        ...tokenTypes,
        ...productionTypes,
        ...createDemensionTypes(units),
        "attr-unit": createAttrUnit(units)
      };
    }
    exports2.createDemensionTypes = createDemensionTypes;
    exports2.createGenericTypes = createGenericTypes;
    exports2.productionTypes = productionTypes;
    exports2.tokenTypes = tokenTypes;
    exports2.unitGroups = unitGroups;
  }
});

// node_modules/css-tree/cjs/lexer/units.cjs
var require_units = __commonJS({
  "node_modules/css-tree/cjs/lexer/units.cjs"(exports2) {
    "use strict";
    var length = [
      // absolute length units https://www.w3.org/TR/css-values-3/#lengths
      "cm",
      "mm",
      "q",
      "in",
      "pt",
      "pc",
      "px",
      // font-relative length units https://drafts.csswg.org/css-values-4/#font-relative-lengths
      "em",
      "rem",
      "ex",
      "rex",
      "cap",
      "rcap",
      "ch",
      "rch",
      "ic",
      "ric",
      "lh",
      "rlh",
      // viewport-percentage lengths https://drafts.csswg.org/css-values-4/#viewport-relative-lengths
      "vw",
      "svw",
      "lvw",
      "dvw",
      "vh",
      "svh",
      "lvh",
      "dvh",
      "vi",
      "svi",
      "lvi",
      "dvi",
      "vb",
      "svb",
      "lvb",
      "dvb",
      "vmin",
      "svmin",
      "lvmin",
      "dvmin",
      "vmax",
      "svmax",
      "lvmax",
      "dvmax",
      // container relative lengths https://drafts.csswg.org/css-contain-3/#container-lengths
      "cqw",
      "cqh",
      "cqi",
      "cqb",
      "cqmin",
      "cqmax"
    ];
    var angle = ["deg", "grad", "rad", "turn"];
    var time = ["s", "ms"];
    var frequency = ["hz", "khz"];
    var resolution = ["dpi", "dpcm", "dppx", "x"];
    var flex = ["fr"];
    var decibel = ["db"];
    var semitones = ["st"];
    exports2.angle = angle;
    exports2.decibel = decibel;
    exports2.flex = flex;
    exports2.frequency = frequency;
    exports2.length = length;
    exports2.resolution = resolution;
    exports2.semitones = semitones;
    exports2.time = time;
  }
});

// node_modules/css-tree/cjs/lexer/prepare-tokens.cjs
var require_prepare_tokens = __commonJS({
  "node_modules/css-tree/cjs/lexer/prepare-tokens.cjs"(exports2, module2) {
    "use strict";
    var index = require_tokenizer();
    var astToTokens = {
      decorator(handlers) {
        const tokens = [];
        let curNode = null;
        return {
          ...handlers,
          node(node) {
            const tmp = curNode;
            curNode = node;
            handlers.node.call(this, node);
            curNode = tmp;
          },
          emit(value, type, auto) {
            tokens.push({
              type,
              value,
              node: auto ? null : curNode
            });
          },
          result() {
            return tokens;
          }
        };
      }
    };
    function stringToTokens(str) {
      const tokens = [];
      index.tokenize(
        str,
        (type, start, end) => tokens.push({
          type,
          value: str.slice(start, end),
          node: null
        })
      );
      return tokens;
    }
    function prepareTokens(value, syntax) {
      if (typeof value === "string") {
        return stringToTokens(value);
      }
      return syntax.generate(value, astToTokens);
    }
    module2.exports = prepareTokens;
  }
});

// node_modules/css-tree/cjs/definition-syntax/SyntaxError.cjs
var require_SyntaxError2 = __commonJS({
  "node_modules/css-tree/cjs/definition-syntax/SyntaxError.cjs"(exports2) {
    "use strict";
    var createCustomError = require_create_custom_error();
    function SyntaxError2(message, input, offset) {
      return Object.assign(createCustomError.createCustomError("SyntaxError", message), {
        input,
        offset,
        rawMessage: message,
        message: message + "\n  " + input + "\n--" + new Array((offset || input.length) + 1).join("-") + "^"
      });
    }
    exports2.SyntaxError = SyntaxError2;
  }
});

// node_modules/css-tree/cjs/definition-syntax/scanner.cjs
var require_scanner = __commonJS({
  "node_modules/css-tree/cjs/definition-syntax/scanner.cjs"(exports2) {
    "use strict";
    var SyntaxError2 = require_SyntaxError2();
    var TAB = 9;
    var N = 10;
    var F = 12;
    var R = 13;
    var SPACE = 32;
    var NAME_CHAR = new Uint8Array(128).map(
      (_, idx) => /[a-zA-Z0-9\-]/.test(String.fromCharCode(idx)) ? 1 : 0
    );
    var Scanner = class {
      constructor(str) {
        this.str = str;
        this.pos = 0;
      }
      charCodeAt(pos) {
        return pos < this.str.length ? this.str.charCodeAt(pos) : 0;
      }
      charCode() {
        return this.charCodeAt(this.pos);
      }
      isNameCharCode(code = this.charCode()) {
        return code < 128 && NAME_CHAR[code] === 1;
      }
      nextCharCode() {
        return this.charCodeAt(this.pos + 1);
      }
      nextNonWsCode(pos) {
        return this.charCodeAt(this.findWsEnd(pos));
      }
      skipWs() {
        this.pos = this.findWsEnd(this.pos);
      }
      findWsEnd(pos) {
        for (; pos < this.str.length; pos++) {
          const code = this.str.charCodeAt(pos);
          if (code !== R && code !== N && code !== F && code !== SPACE && code !== TAB) {
            break;
          }
        }
        return pos;
      }
      substringToPos(end) {
        return this.str.substring(this.pos, this.pos = end);
      }
      eat(code) {
        if (this.charCode() !== code) {
          this.error("Expect `" + String.fromCharCode(code) + "`");
        }
        this.pos++;
      }
      peek() {
        return this.pos < this.str.length ? this.str.charAt(this.pos++) : "";
      }
      error(message) {
        throw new SyntaxError2.SyntaxError(message, this.str, this.pos);
      }
      scanSpaces() {
        return this.substringToPos(this.findWsEnd(this.pos));
      }
      scanWord() {
        let end = this.pos;
        for (; end < this.str.length; end++) {
          const code = this.str.charCodeAt(end);
          if (code >= 128 || NAME_CHAR[code] === 0) {
            break;
          }
        }
        if (this.pos === end) {
          this.error("Expect a keyword");
        }
        return this.substringToPos(end);
      }
      scanNumber() {
        let end = this.pos;
        for (; end < this.str.length; end++) {
          const code = this.str.charCodeAt(end);
          if (code < 48 || code > 57) {
            break;
          }
        }
        if (this.pos === end) {
          this.error("Expect a number");
        }
        return this.substringToPos(end);
      }
      scanString() {
        const end = this.str.indexOf("'", this.pos + 1);
        if (end === -1) {
          this.pos = this.str.length;
          this.error("Expect an apostrophe");
        }
        return this.substringToPos(end + 1);
      }
    };
    exports2.Scanner = Scanner;
  }
});

// node_modules/css-tree/cjs/definition-syntax/parse.cjs
var require_parse = __commonJS({
  "node_modules/css-tree/cjs/definition-syntax/parse.cjs"(exports2) {
    "use strict";
    var scanner = require_scanner();
    var TAB = 9;
    var N = 10;
    var F = 12;
    var R = 13;
    var SPACE = 32;
    var EXCLAMATIONMARK = 33;
    var NUMBERSIGN = 35;
    var AMPERSAND = 38;
    var APOSTROPHE = 39;
    var LEFTPARENTHESIS = 40;
    var RIGHTPARENTHESIS = 41;
    var ASTERISK = 42;
    var PLUSSIGN = 43;
    var COMMA = 44;
    var HYPERMINUS = 45;
    var LESSTHANSIGN = 60;
    var GREATERTHANSIGN = 62;
    var QUESTIONMARK = 63;
    var COMMERCIALAT = 64;
    var LEFTSQUAREBRACKET = 91;
    var RIGHTSQUAREBRACKET = 93;
    var LEFTCURLYBRACKET = 123;
    var VERTICALLINE = 124;
    var RIGHTCURLYBRACKET = 125;
    var INFINITY = 8734;
    var COMBINATOR_PRECEDENCE = {
      " ": 1,
      "&&": 2,
      "||": 3,
      "|": 4
    };
    function readMultiplierRange(scanner2) {
      let min = null;
      let max = null;
      scanner2.eat(LEFTCURLYBRACKET);
      scanner2.skipWs();
      min = scanner2.scanNumber(scanner2);
      scanner2.skipWs();
      if (scanner2.charCode() === COMMA) {
        scanner2.pos++;
        scanner2.skipWs();
        if (scanner2.charCode() !== RIGHTCURLYBRACKET) {
          max = scanner2.scanNumber(scanner2);
          scanner2.skipWs();
        }
      } else {
        max = min;
      }
      scanner2.eat(RIGHTCURLYBRACKET);
      return {
        min: Number(min),
        max: max ? Number(max) : 0
      };
    }
    function readMultiplier(scanner2) {
      let range = null;
      let comma = false;
      switch (scanner2.charCode()) {
        case ASTERISK:
          scanner2.pos++;
          range = {
            min: 0,
            max: 0
          };
          break;
        case PLUSSIGN:
          scanner2.pos++;
          range = {
            min: 1,
            max: 0
          };
          break;
        case QUESTIONMARK:
          scanner2.pos++;
          range = {
            min: 0,
            max: 1
          };
          break;
        case NUMBERSIGN:
          scanner2.pos++;
          comma = true;
          if (scanner2.charCode() === LEFTCURLYBRACKET) {
            range = readMultiplierRange(scanner2);
          } else if (scanner2.charCode() === QUESTIONMARK) {
            scanner2.pos++;
            range = {
              min: 0,
              max: 0
            };
          } else {
            range = {
              min: 1,
              max: 0
            };
          }
          break;
        case LEFTCURLYBRACKET:
          range = readMultiplierRange(scanner2);
          break;
        default:
          return null;
      }
      return {
        type: "Multiplier",
        comma,
        min: range.min,
        max: range.max,
        term: null
      };
    }
    function maybeMultiplied(scanner2, node) {
      const multiplier = readMultiplier(scanner2);
      if (multiplier !== null) {
        multiplier.term = node;
        if (scanner2.charCode() === NUMBERSIGN && scanner2.charCodeAt(scanner2.pos - 1) === PLUSSIGN) {
          return maybeMultiplied(scanner2, multiplier);
        }
        if (scanner2.charCode() === QUESTIONMARK && scanner2.charCodeAt(scanner2.pos - 1) === RIGHTCURLYBRACKET) {
          return maybeMultiplied(scanner2, multiplier);
        }
        return multiplier;
      }
      return node;
    }
    function maybeToken(scanner2) {
      const ch = scanner2.peek();
      if (ch === "") {
        return null;
      }
      return maybeMultiplied(scanner2, {
        type: "Token",
        value: ch
      });
    }
    function readProperty(scanner2) {
      let name;
      scanner2.eat(LESSTHANSIGN);
      scanner2.eat(APOSTROPHE);
      name = scanner2.scanWord();
      scanner2.eat(APOSTROPHE);
      scanner2.eat(GREATERTHANSIGN);
      return maybeMultiplied(scanner2, {
        type: "Property",
        name
      });
    }
    function readTypeRange(scanner2) {
      let min = null;
      let max = null;
      let sign = 1;
      scanner2.eat(LEFTSQUAREBRACKET);
      if (scanner2.charCode() === HYPERMINUS) {
        scanner2.peek();
        sign = -1;
      }
      if (sign == -1 && scanner2.charCode() === INFINITY) {
        scanner2.peek();
      } else {
        min = sign * Number(scanner2.scanNumber(scanner2));
        if (scanner2.isNameCharCode()) {
          min += scanner2.scanWord();
        }
      }
      scanner2.skipWs();
      scanner2.eat(COMMA);
      scanner2.skipWs();
      if (scanner2.charCode() === INFINITY) {
        scanner2.peek();
      } else {
        sign = 1;
        if (scanner2.charCode() === HYPERMINUS) {
          scanner2.peek();
          sign = -1;
        }
        max = sign * Number(scanner2.scanNumber(scanner2));
        if (scanner2.isNameCharCode()) {
          max += scanner2.scanWord();
        }
      }
      scanner2.eat(RIGHTSQUAREBRACKET);
      return {
        type: "Range",
        min,
        max
      };
    }
    function readType(scanner2) {
      let name;
      let opts = null;
      scanner2.eat(LESSTHANSIGN);
      name = scanner2.scanWord();
      if (name === "boolean-expr") {
        scanner2.eat(LEFTSQUAREBRACKET);
        const implicitGroup = readImplicitGroup(scanner2, RIGHTSQUAREBRACKET);
        scanner2.eat(RIGHTSQUAREBRACKET);
        scanner2.eat(GREATERTHANSIGN);
        return maybeMultiplied(scanner2, {
          type: "Boolean",
          term: implicitGroup.terms.length === 1 ? implicitGroup.terms[0] : implicitGroup
        });
      }
      if (scanner2.charCode() === LEFTPARENTHESIS && scanner2.nextCharCode() === RIGHTPARENTHESIS) {
        scanner2.pos += 2;
        name += "()";
      }
      if (scanner2.charCodeAt(scanner2.findWsEnd(scanner2.pos)) === LEFTSQUAREBRACKET) {
        scanner2.skipWs();
        opts = readTypeRange(scanner2);
      }
      scanner2.eat(GREATERTHANSIGN);
      return maybeMultiplied(scanner2, {
        type: "Type",
        name,
        opts
      });
    }
    function readKeywordOrFunction(scanner2) {
      const name = scanner2.scanWord();
      if (scanner2.charCode() === LEFTPARENTHESIS) {
        scanner2.pos++;
        return {
          type: "Function",
          name
        };
      }
      return maybeMultiplied(scanner2, {
        type: "Keyword",
        name
      });
    }
    function regroupTerms(terms, combinators) {
      function createGroup(terms2, combinator2) {
        return {
          type: "Group",
          terms: terms2,
          combinator: combinator2,
          disallowEmpty: false,
          explicit: false
        };
      }
      let combinator;
      combinators = Object.keys(combinators).sort((a, b) => COMBINATOR_PRECEDENCE[a] - COMBINATOR_PRECEDENCE[b]);
      while (combinators.length > 0) {
        combinator = combinators.shift();
        let i = 0;
        let subgroupStart = 0;
        for (; i < terms.length; i++) {
          const term = terms[i];
          if (term.type === "Combinator") {
            if (term.value === combinator) {
              if (subgroupStart === -1) {
                subgroupStart = i - 1;
              }
              terms.splice(i, 1);
              i--;
            } else {
              if (subgroupStart !== -1 && i - subgroupStart > 1) {
                terms.splice(
                  subgroupStart,
                  i - subgroupStart,
                  createGroup(terms.slice(subgroupStart, i), combinator)
                );
                i = subgroupStart + 1;
              }
              subgroupStart = -1;
            }
          }
        }
        if (subgroupStart !== -1 && combinators.length) {
          terms.splice(
            subgroupStart,
            i - subgroupStart,
            createGroup(terms.slice(subgroupStart, i), combinator)
          );
        }
      }
      return combinator;
    }
    function readImplicitGroup(scanner2, stopCharCode = -1) {
      const combinators = /* @__PURE__ */ Object.create(null);
      const terms = [];
      let prevToken = null;
      let prevTokenPos = scanner2.pos;
      let prevTokenIsFunction = false;
      while (scanner2.charCode() !== stopCharCode) {
        let token = prevTokenIsFunction ? readImplicitGroup(scanner2, RIGHTPARENTHESIS) : peek(scanner2);
        if (!token) {
          break;
        }
        if (token.type === "Spaces") {
          continue;
        }
        if (prevTokenIsFunction) {
          if (token.terms.length === 0) {
            prevTokenIsFunction = false;
            continue;
          }
          if (token.combinator === " ") {
            while (token.terms.length > 1) {
              combinators[" "] = true;
              terms.push({
                type: "Combinator",
                value: " "
              }, token.terms.shift());
            }
            token = token.terms[0];
          }
        }
        if (token.type === "Combinator") {
          if (prevToken === null || prevToken.type === "Combinator") {
            scanner2.pos = prevTokenPos;
            scanner2.error("Unexpected combinator");
          }
          combinators[token.value] = true;
        } else if (prevToken !== null && prevToken.type !== "Combinator") {
          combinators[" "] = true;
          terms.push({
            type: "Combinator",
            value: " "
          });
        }
        terms.push(token);
        prevToken = token;
        prevTokenPos = scanner2.pos;
        prevTokenIsFunction = token.type === "Function";
      }
      if (prevToken !== null && prevToken.type === "Combinator") {
        scanner2.pos -= prevTokenPos;
        scanner2.error("Unexpected combinator");
      }
      return {
        type: "Group",
        terms,
        combinator: regroupTerms(terms, combinators) || " ",
        disallowEmpty: false,
        explicit: false
      };
    }
    function readGroup(scanner2) {
      let result;
      scanner2.eat(LEFTSQUAREBRACKET);
      result = readImplicitGroup(scanner2, RIGHTSQUAREBRACKET);
      scanner2.eat(RIGHTSQUAREBRACKET);
      result.explicit = true;
      if (scanner2.charCode() === EXCLAMATIONMARK) {
        scanner2.pos++;
        result.disallowEmpty = true;
      }
      return result;
    }
    function peek(scanner2) {
      let code = scanner2.charCode();
      switch (code) {
        case RIGHTSQUAREBRACKET:
          break;
        case LEFTSQUAREBRACKET:
          return maybeMultiplied(scanner2, readGroup(scanner2));
        case LESSTHANSIGN:
          return scanner2.nextCharCode() === APOSTROPHE ? readProperty(scanner2) : readType(scanner2);
        case VERTICALLINE:
          return {
            type: "Combinator",
            value: scanner2.substringToPos(
              scanner2.pos + (scanner2.nextCharCode() === VERTICALLINE ? 2 : 1)
            )
          };
        case AMPERSAND:
          scanner2.pos++;
          scanner2.eat(AMPERSAND);
          return {
            type: "Combinator",
            value: "&&"
          };
        case COMMA:
          scanner2.pos++;
          return {
            type: "Comma"
          };
        case APOSTROPHE:
          return maybeMultiplied(scanner2, {
            type: "String",
            value: scanner2.scanString()
          });
        case SPACE:
        case TAB:
        case N:
        case R:
        case F:
          return {
            type: "Spaces",
            value: scanner2.scanSpaces()
          };
        case COMMERCIALAT:
          code = scanner2.nextCharCode();
          if (scanner2.isNameCharCode(code)) {
            scanner2.pos++;
            return {
              type: "AtKeyword",
              name: scanner2.scanWord()
            };
          }
          return maybeToken(scanner2);
        case ASTERISK:
        case PLUSSIGN:
        case QUESTIONMARK:
        case NUMBERSIGN:
        case EXCLAMATIONMARK:
          break;
        case LEFTCURLYBRACKET:
          code = scanner2.nextCharCode();
          if (code < 48 || code > 57) {
            return maybeToken(scanner2);
          }
          break;
        default:
          if (scanner2.isNameCharCode(code)) {
            return readKeywordOrFunction(scanner2);
          }
          return maybeToken(scanner2);
      }
    }
    function parse(source) {
      const scanner$1 = new scanner.Scanner(source);
      const result = readImplicitGroup(scanner$1);
      if (scanner$1.pos !== source.length) {
        scanner$1.error("Unexpected input");
      }
      if (result.terms.length === 1 && result.terms[0].type === "Group") {
        return result.terms[0];
      }
      return result;
    }
    exports2.parse = parse;
  }
});

// node_modules/css-tree/cjs/lexer/match-graph.cjs
var require_match_graph = __commonJS({
  "node_modules/css-tree/cjs/lexer/match-graph.cjs"(exports2) {
    "use strict";
    var parse = require_parse();
    var MATCH = { type: "Match" };
    var MISMATCH = { type: "Mismatch" };
    var DISALLOW_EMPTY = { type: "DisallowEmpty" };
    var LEFTPARENTHESIS = 40;
    var RIGHTPARENTHESIS = 41;
    function createCondition(match, thenBranch, elseBranch) {
      if (thenBranch === MATCH && elseBranch === MISMATCH) {
        return match;
      }
      if (match === MATCH && thenBranch === MATCH && elseBranch === MATCH) {
        return match;
      }
      if (match.type === "If" && match.else === MISMATCH && thenBranch === MATCH) {
        thenBranch = match.then;
        match = match.match;
      }
      return {
        type: "If",
        match,
        then: thenBranch,
        else: elseBranch
      };
    }
    function isFunctionType(name) {
      return name.length > 2 && name.charCodeAt(name.length - 2) === LEFTPARENTHESIS && name.charCodeAt(name.length - 1) === RIGHTPARENTHESIS;
    }
    function isEnumCapatible(term) {
      return term.type === "Keyword" || term.type === "AtKeyword" || term.type === "Function" || term.type === "Type" && isFunctionType(term.name);
    }
    function groupNode(terms, combinator = " ", explicit = false) {
      return {
        type: "Group",
        terms,
        combinator,
        disallowEmpty: false,
        explicit
      };
    }
    function replaceTypeInGraph(node, replacements, visited = /* @__PURE__ */ new Set()) {
      if (!visited.has(node)) {
        visited.add(node);
        switch (node.type) {
          case "If":
            node.match = replaceTypeInGraph(node.match, replacements, visited);
            node.then = replaceTypeInGraph(node.then, replacements, visited);
            node.else = replaceTypeInGraph(node.else, replacements, visited);
            break;
          case "Type":
            return replacements[node.name] || node;
        }
      }
      return node;
    }
    function buildGroupMatchGraph(combinator, terms, atLeastOneTermMatched) {
      switch (combinator) {
        case " ": {
          let result = MATCH;
          for (let i = terms.length - 1; i >= 0; i--) {
            const term = terms[i];
            result = createCondition(
              term,
              result,
              MISMATCH
            );
          }
          return result;
        }
        case "|": {
          let result = MISMATCH;
          let map = null;
          for (let i = terms.length - 1; i >= 0; i--) {
            let term = terms[i];
            if (isEnumCapatible(term)) {
              if (map === null && i > 0 && isEnumCapatible(terms[i - 1])) {
                map = /* @__PURE__ */ Object.create(null);
                result = createCondition(
                  {
                    type: "Enum",
                    map
                  },
                  MATCH,
                  result
                );
              }
              if (map !== null) {
                const key = (isFunctionType(term.name) ? term.name.slice(0, -1) : term.name).toLowerCase();
                if (key in map === false) {
                  map[key] = term;
                  continue;
                }
              }
            }
            map = null;
            result = createCondition(
              term,
              MATCH,
              result
            );
          }
          return result;
        }
        case "&&": {
          if (terms.length > 5) {
            return {
              type: "MatchOnce",
              terms,
              all: true
            };
          }
          let result = MISMATCH;
          for (let i = terms.length - 1; i >= 0; i--) {
            const term = terms[i];
            let thenClause;
            if (terms.length > 1) {
              thenClause = buildGroupMatchGraph(
                combinator,
                terms.filter(function(newGroupTerm) {
                  return newGroupTerm !== term;
                }),
                false
              );
            } else {
              thenClause = MATCH;
            }
            result = createCondition(
              term,
              thenClause,
              result
            );
          }
          return result;
        }
        case "||": {
          if (terms.length > 5) {
            return {
              type: "MatchOnce",
              terms,
              all: false
            };
          }
          let result = atLeastOneTermMatched ? MATCH : MISMATCH;
          for (let i = terms.length - 1; i >= 0; i--) {
            const term = terms[i];
            let thenClause;
            if (terms.length > 1) {
              thenClause = buildGroupMatchGraph(
                combinator,
                terms.filter(function(newGroupTerm) {
                  return newGroupTerm !== term;
                }),
                true
              );
            } else {
              thenClause = MATCH;
            }
            result = createCondition(
              term,
              thenClause,
              result
            );
          }
          return result;
        }
      }
    }
    function buildMultiplierMatchGraph(node) {
      let result = MATCH;
      let matchTerm = buildMatchGraphInternal(node.term);
      if (node.max === 0) {
        matchTerm = createCondition(
          matchTerm,
          DISALLOW_EMPTY,
          MISMATCH
        );
        result = createCondition(
          matchTerm,
          null,
          // will be a loop
          MISMATCH
        );
        result.then = createCondition(
          MATCH,
          MATCH,
          result
          // make a loop
        );
        if (node.comma) {
          result.then.else = createCondition(
            { type: "Comma", syntax: node },
            result,
            MISMATCH
          );
        }
      } else {
        for (let i = node.min || 1; i <= node.max; i++) {
          if (node.comma && result !== MATCH) {
            result = createCondition(
              { type: "Comma", syntax: node },
              result,
              MISMATCH
            );
          }
          result = createCondition(
            matchTerm,
            createCondition(
              MATCH,
              MATCH,
              result
            ),
            MISMATCH
          );
        }
      }
      if (node.min === 0) {
        result = createCondition(
          MATCH,
          MATCH,
          result
        );
      } else {
        for (let i = 0; i < node.min - 1; i++) {
          if (node.comma && result !== MATCH) {
            result = createCondition(
              { type: "Comma", syntax: node },
              result,
              MISMATCH
            );
          }
          result = createCondition(
            matchTerm,
            result,
            MISMATCH
          );
        }
      }
      return result;
    }
    function buildMatchGraphInternal(node) {
      if (typeof node === "function") {
        return {
          type: "Generic",
          fn: node
        };
      }
      switch (node.type) {
        case "Group": {
          let result = buildGroupMatchGraph(
            node.combinator,
            node.terms.map(buildMatchGraphInternal),
            false
          );
          if (node.disallowEmpty) {
            result = createCondition(
              result,
              DISALLOW_EMPTY,
              MISMATCH
            );
          }
          return result;
        }
        case "Multiplier":
          return buildMultiplierMatchGraph(node);
        // https://drafts.csswg.org/css-values-5/#boolean
        case "Boolean": {
          const term = buildMatchGraphInternal(node.term);
          const matchNode = buildMatchGraphInternal(groupNode([
            groupNode([
              { type: "Keyword", name: "not" },
              { type: "Type", name: "!boolean-group" }
            ]),
            groupNode([
              { type: "Type", name: "!boolean-group" },
              groupNode([
                { type: "Multiplier", comma: false, min: 0, max: 0, term: groupNode([
                  { type: "Keyword", name: "and" },
                  { type: "Type", name: "!boolean-group" }
                ]) },
                { type: "Multiplier", comma: false, min: 0, max: 0, term: groupNode([
                  { type: "Keyword", name: "or" },
                  { type: "Type", name: "!boolean-group" }
                ]) }
              ], "|")
            ])
          ], "|"));
          const booleanGroup = buildMatchGraphInternal(
            groupNode([
              { type: "Type", name: "!term" },
              groupNode([
                { type: "Token", value: "(" },
                { type: "Type", name: "!self" },
                { type: "Token", value: ")" }
              ]),
              { type: "Type", name: "general-enclosed" }
            ], "|")
          );
          replaceTypeInGraph(booleanGroup, { "!term": term, "!self": matchNode });
          replaceTypeInGraph(matchNode, { "!boolean-group": booleanGroup });
          return matchNode;
        }
        case "Type":
        case "Property":
          return {
            type: node.type,
            name: node.name,
            syntax: node
          };
        case "Keyword":
          return {
            type: node.type,
            name: node.name.toLowerCase(),
            syntax: node
          };
        case "AtKeyword":
          return {
            type: node.type,
            name: "@" + node.name.toLowerCase(),
            syntax: node
          };
        case "Function":
          return {
            type: node.type,
            name: node.name.toLowerCase() + "(",
            syntax: node
          };
        case "String":
          if (node.value.length === 3) {
            return {
              type: "Token",
              value: node.value.charAt(1),
              syntax: node
            };
          }
          return {
            type: node.type,
            value: node.value.substr(1, node.value.length - 2).replace(/\\'/g, "'"),
            syntax: node
          };
        case "Token":
          return {
            type: node.type,
            value: node.value,
            syntax: node
          };
        case "Comma":
          return {
            type: node.type,
            syntax: node
          };
        default:
          throw new Error("Unknown node type:", node.type);
      }
    }
    function buildMatchGraph(syntaxTree, ref) {
      if (typeof syntaxTree === "string") {
        syntaxTree = parse.parse(syntaxTree);
      }
      return {
        type: "MatchGraph",
        match: buildMatchGraphInternal(syntaxTree),
        syntax: ref || null,
        source: syntaxTree
      };
    }
    exports2.DISALLOW_EMPTY = DISALLOW_EMPTY;
    exports2.MATCH = MATCH;
    exports2.MISMATCH = MISMATCH;
    exports2.buildMatchGraph = buildMatchGraph;
  }
});

// node_modules/css-tree/cjs/lexer/match.cjs
var require_match = __commonJS({
  "node_modules/css-tree/cjs/lexer/match.cjs"(exports2) {
    "use strict";
    var matchGraph = require_match_graph();
    var types = require_types();
    var { hasOwnProperty: hasOwnProperty2 } = Object.prototype;
    var STUB = 0;
    var TOKEN = 1;
    var OPEN_SYNTAX = 2;
    var CLOSE_SYNTAX = 3;
    var EXIT_REASON_MATCH = "Match";
    var EXIT_REASON_MISMATCH = "Mismatch";
    var EXIT_REASON_ITERATION_LIMIT = "Maximum iteration number exceeded (please fill an issue on https://github.com/csstree/csstree/issues)";
    var ITERATION_LIMIT = 15e3;
    function reverseList(list) {
      let prev = null;
      let next = null;
      let item = list;
      while (item !== null) {
        next = item.prev;
        item.prev = prev;
        prev = item;
        item = next;
      }
      return prev;
    }
    function areStringsEqualCaseInsensitive(testStr, referenceStr) {
      if (testStr.length !== referenceStr.length) {
        return false;
      }
      for (let i = 0; i < testStr.length; i++) {
        const referenceCode = referenceStr.charCodeAt(i);
        let testCode = testStr.charCodeAt(i);
        if (testCode >= 65 && testCode <= 90) {
          testCode = testCode | 32;
        }
        if (testCode !== referenceCode) {
          return false;
        }
      }
      return true;
    }
    function isContextEdgeDelim(token) {
      if (token.type !== types.Delim) {
        return false;
      }
      return token.value !== "?";
    }
    function isCommaContextStart(token) {
      if (token === null) {
        return true;
      }
      return token.type === types.Comma || token.type === types.Function || token.type === types.LeftParenthesis || token.type === types.LeftSquareBracket || token.type === types.LeftCurlyBracket || isContextEdgeDelim(token);
    }
    function isCommaContextEnd(token) {
      if (token === null) {
        return true;
      }
      return token.type === types.RightParenthesis || token.type === types.RightSquareBracket || token.type === types.RightCurlyBracket || token.type === types.Delim && token.value === "/";
    }
    function internalMatch(tokens, state, syntaxes) {
      function moveToNextToken() {
        do {
          tokenIndex++;
          token = tokenIndex < tokens.length ? tokens[tokenIndex] : null;
        } while (token !== null && (token.type === types.WhiteSpace || token.type === types.Comment));
      }
      function getNextToken(offset) {
        const nextIndex = tokenIndex + offset;
        return nextIndex < tokens.length ? tokens[nextIndex] : null;
      }
      function stateSnapshotFromSyntax(nextState, prev) {
        return {
          nextState,
          matchStack,
          syntaxStack,
          thenStack,
          tokenIndex,
          prev
        };
      }
      function pushThenStack(nextState) {
        thenStack = {
          nextState,
          matchStack,
          syntaxStack,
          prev: thenStack
        };
      }
      function pushElseStack(nextState) {
        elseStack = stateSnapshotFromSyntax(nextState, elseStack);
      }
      function addTokenToMatch() {
        matchStack = {
          type: TOKEN,
          syntax: state.syntax,
          token,
          prev: matchStack
        };
        moveToNextToken();
        syntaxStash = null;
        if (tokenIndex > longestMatch) {
          longestMatch = tokenIndex;
        }
      }
      function openSyntax() {
        syntaxStack = {
          syntax: state.syntax,
          opts: state.syntax.opts || syntaxStack !== null && syntaxStack.opts || null,
          prev: syntaxStack
        };
        matchStack = {
          type: OPEN_SYNTAX,
          syntax: state.syntax,
          token: matchStack.token,
          prev: matchStack
        };
      }
      function closeSyntax() {
        if (matchStack.type === OPEN_SYNTAX) {
          matchStack = matchStack.prev;
        } else {
          matchStack = {
            type: CLOSE_SYNTAX,
            syntax: syntaxStack.syntax,
            token: matchStack.token,
            prev: matchStack
          };
        }
        syntaxStack = syntaxStack.prev;
      }
      let syntaxStack = null;
      let thenStack = null;
      let elseStack = null;
      let syntaxStash = null;
      let iterationCount = 0;
      let exitReason = null;
      let token = null;
      let tokenIndex = -1;
      let longestMatch = 0;
      let matchStack = {
        type: STUB,
        syntax: null,
        token: null,
        prev: null
      };
      moveToNextToken();
      while (exitReason === null && ++iterationCount < ITERATION_LIMIT) {
        switch (state.type) {
          case "Match":
            if (thenStack === null) {
              if (token !== null) {
                if (tokenIndex !== tokens.length - 1 || token.value !== "\\0" && token.value !== "\\9") {
                  state = matchGraph.MISMATCH;
                  break;
                }
              }
              exitReason = EXIT_REASON_MATCH;
              break;
            }
            state = thenStack.nextState;
            if (state === matchGraph.DISALLOW_EMPTY) {
              if (thenStack.matchStack === matchStack) {
                state = matchGraph.MISMATCH;
                break;
              } else {
                state = matchGraph.MATCH;
              }
            }
            while (thenStack.syntaxStack !== syntaxStack) {
              closeSyntax();
            }
            thenStack = thenStack.prev;
            break;
          case "Mismatch":
            if (syntaxStash !== null && syntaxStash !== false) {
              if (elseStack === null || tokenIndex > elseStack.tokenIndex) {
                elseStack = syntaxStash;
                syntaxStash = false;
              }
            } else if (elseStack === null) {
              exitReason = EXIT_REASON_MISMATCH;
              break;
            }
            state = elseStack.nextState;
            thenStack = elseStack.thenStack;
            syntaxStack = elseStack.syntaxStack;
            matchStack = elseStack.matchStack;
            tokenIndex = elseStack.tokenIndex;
            token = tokenIndex < tokens.length ? tokens[tokenIndex] : null;
            elseStack = elseStack.prev;
            break;
          case "MatchGraph":
            state = state.match;
            break;
          case "If":
            if (state.else !== matchGraph.MISMATCH) {
              pushElseStack(state.else);
            }
            if (state.then !== matchGraph.MATCH) {
              pushThenStack(state.then);
            }
            state = state.match;
            break;
          case "MatchOnce":
            state = {
              type: "MatchOnceBuffer",
              syntax: state,
              index: 0,
              mask: 0
            };
            break;
          case "MatchOnceBuffer": {
            const terms = state.syntax.terms;
            if (state.index === terms.length) {
              if (state.mask === 0 || state.syntax.all) {
                state = matchGraph.MISMATCH;
                break;
              }
              state = matchGraph.MATCH;
              break;
            }
            if (state.mask === (1 << terms.length) - 1) {
              state = matchGraph.MATCH;
              break;
            }
            for (; state.index < terms.length; state.index++) {
              const matchFlag = 1 << state.index;
              if ((state.mask & matchFlag) === 0) {
                pushElseStack(state);
                pushThenStack({
                  type: "AddMatchOnce",
                  syntax: state.syntax,
                  mask: state.mask | matchFlag
                });
                state = terms[state.index++];
                break;
              }
            }
            break;
          }
          case "AddMatchOnce":
            state = {
              type: "MatchOnceBuffer",
              syntax: state.syntax,
              index: 0,
              mask: state.mask
            };
            break;
          case "Enum":
            if (token !== null) {
              let name = token.value.toLowerCase();
              if (name.indexOf("\\") !== -1) {
                name = name.replace(/\\[09].*$/, "");
              }
              if (hasOwnProperty2.call(state.map, name)) {
                state = state.map[name];
                break;
              }
            }
            state = matchGraph.MISMATCH;
            break;
          case "Generic": {
            const opts = syntaxStack !== null ? syntaxStack.opts : null;
            const lastTokenIndex2 = tokenIndex + Math.floor(state.fn(token, getNextToken, opts));
            if (!isNaN(lastTokenIndex2) && lastTokenIndex2 > tokenIndex) {
              while (tokenIndex < lastTokenIndex2) {
                addTokenToMatch();
              }
              state = matchGraph.MATCH;
            } else {
              state = matchGraph.MISMATCH;
            }
            break;
          }
          case "Type":
          case "Property": {
            const syntaxDict = state.type === "Type" ? "types" : "properties";
            const dictSyntax = hasOwnProperty2.call(syntaxes, syntaxDict) ? syntaxes[syntaxDict][state.name] : null;
            if (!dictSyntax || !dictSyntax.match) {
              throw new Error(
                "Bad syntax reference: " + (state.type === "Type" ? "<" + state.name + ">" : "<'" + state.name + "'>")
              );
            }
            if (syntaxStash !== false && token !== null && state.type === "Type") {
              const lowPriorityMatching = (
                // https://drafts.csswg.org/css-values-4/#custom-idents
                // When parsing positionally-ambiguous keywords in a property value, a <custom-ident> production
                // can only claim the keyword if no other unfulfilled production can claim it.
                state.name === "custom-ident" && token.type === types.Ident || // https://drafts.csswg.org/css-values-4/#lengths
                // ... if a `0` could be parsed as either a <number> or a <length> in a property (such as line-height),
                // it must parse as a <number>
                state.name === "length" && token.value === "0"
              );
              if (lowPriorityMatching) {
                if (syntaxStash === null) {
                  syntaxStash = stateSnapshotFromSyntax(state, elseStack);
                }
                state = matchGraph.MISMATCH;
                break;
              }
            }
            openSyntax();
            state = dictSyntax.matchRef || dictSyntax.match;
            break;
          }
          case "Keyword": {
            const name = state.name;
            if (token !== null) {
              let keywordName = token.value;
              if (keywordName.indexOf("\\") !== -1) {
                keywordName = keywordName.replace(/\\[09].*$/, "");
              }
              if (areStringsEqualCaseInsensitive(keywordName, name)) {
                addTokenToMatch();
                state = matchGraph.MATCH;
                break;
              }
            }
            state = matchGraph.MISMATCH;
            break;
          }
          case "AtKeyword":
          case "Function":
            if (token !== null && areStringsEqualCaseInsensitive(token.value, state.name)) {
              addTokenToMatch();
              state = matchGraph.MATCH;
              break;
            }
            state = matchGraph.MISMATCH;
            break;
          case "Token":
            if (token !== null && token.value === state.value) {
              addTokenToMatch();
              state = matchGraph.MATCH;
              break;
            }
            state = matchGraph.MISMATCH;
            break;
          case "Comma":
            if (token !== null && token.type === types.Comma) {
              if (isCommaContextStart(matchStack.token)) {
                state = matchGraph.MISMATCH;
              } else {
                addTokenToMatch();
                state = isCommaContextEnd(token) ? matchGraph.MISMATCH : matchGraph.MATCH;
              }
            } else {
              state = isCommaContextStart(matchStack.token) || isCommaContextEnd(token) ? matchGraph.MATCH : matchGraph.MISMATCH;
            }
            break;
          case "String":
            let string = "";
            let lastTokenIndex = tokenIndex;
            for (; lastTokenIndex < tokens.length && string.length < state.value.length; lastTokenIndex++) {
              string += tokens[lastTokenIndex].value;
            }
            if (areStringsEqualCaseInsensitive(string, state.value)) {
              while (tokenIndex < lastTokenIndex) {
                addTokenToMatch();
              }
              state = matchGraph.MATCH;
            } else {
              state = matchGraph.MISMATCH;
            }
            break;
          default:
            throw new Error("Unknown node type: " + state.type);
        }
      }
      switch (exitReason) {
        case null:
          console.warn("[csstree-match] BREAK after " + ITERATION_LIMIT + " iterations");
          exitReason = EXIT_REASON_ITERATION_LIMIT;
          matchStack = null;
          break;
        case EXIT_REASON_MATCH:
          while (syntaxStack !== null) {
            closeSyntax();
          }
          break;
        default:
          matchStack = null;
      }
      return {
        tokens,
        reason: exitReason,
        iterations: iterationCount,
        match: matchStack,
        longestMatch
      };
    }
    function matchAsList(tokens, matchGraph2, syntaxes) {
      const matchResult = internalMatch(tokens, matchGraph2, syntaxes || {});
      if (matchResult.match !== null) {
        let item = reverseList(matchResult.match).prev;
        matchResult.match = [];
        while (item !== null) {
          switch (item.type) {
            case OPEN_SYNTAX:
            case CLOSE_SYNTAX:
              matchResult.match.push({
                type: item.type,
                syntax: item.syntax
              });
              break;
            default:
              matchResult.match.push({
                token: item.token.value,
                node: item.token.node
              });
              break;
          }
          item = item.prev;
        }
      }
      return matchResult;
    }
    function matchAsTree(tokens, matchGraph2, syntaxes) {
      const matchResult = internalMatch(tokens, matchGraph2, syntaxes || {});
      if (matchResult.match === null) {
        return matchResult;
      }
      let item = matchResult.match;
      let host = matchResult.match = {
        syntax: matchGraph2.syntax || null,
        match: []
      };
      const hostStack = [host];
      item = reverseList(item).prev;
      while (item !== null) {
        switch (item.type) {
          case OPEN_SYNTAX:
            host.match.push(host = {
              syntax: item.syntax,
              match: []
            });
            hostStack.push(host);
            break;
          case CLOSE_SYNTAX:
            hostStack.pop();
            host = hostStack[hostStack.length - 1];
            break;
          default:
            host.match.push({
              syntax: item.syntax || null,
              token: item.token.value,
              node: item.token.node
            });
        }
        item = item.prev;
      }
      return matchResult;
    }
    exports2.matchAsList = matchAsList;
    exports2.matchAsTree = matchAsTree;
  }
});

// node_modules/css-tree/cjs/lexer/trace.cjs
var require_trace = __commonJS({
  "node_modules/css-tree/cjs/lexer/trace.cjs"(exports2) {
    "use strict";
    function getTrace(node) {
      function shouldPutToTrace(syntax) {
        if (syntax === null) {
          return false;
        }
        return syntax.type === "Type" || syntax.type === "Property" || syntax.type === "Keyword";
      }
      function hasMatch(matchNode) {
        if (Array.isArray(matchNode.match)) {
          for (let i = 0; i < matchNode.match.length; i++) {
            if (hasMatch(matchNode.match[i])) {
              if (shouldPutToTrace(matchNode.syntax)) {
                result.unshift(matchNode.syntax);
              }
              return true;
            }
          }
        } else if (matchNode.node === node) {
          result = shouldPutToTrace(matchNode.syntax) ? [matchNode.syntax] : [];
          return true;
        }
        return false;
      }
      let result = null;
      if (this.matched !== null) {
        hasMatch(this.matched);
      }
      return result;
    }
    function isType(node, type) {
      return testNode(this, node, (match) => match.type === "Type" && match.name === type);
    }
    function isProperty(node, property) {
      return testNode(this, node, (match) => match.type === "Property" && match.name === property);
    }
    function isKeyword(node) {
      return testNode(this, node, (match) => match.type === "Keyword");
    }
    function testNode(match, node, fn) {
      const trace = getTrace.call(match, node);
      if (trace === null) {
        return false;
      }
      return trace.some(fn);
    }
    exports2.getTrace = getTrace;
    exports2.isKeyword = isKeyword;
    exports2.isProperty = isProperty;
    exports2.isType = isType;
  }
});

// node_modules/css-tree/cjs/lexer/search.cjs
var require_search = __commonJS({
  "node_modules/css-tree/cjs/lexer/search.cjs"(exports2) {
    "use strict";
    var List = require_List();
    function getFirstMatchNode(matchNode) {
      if ("node" in matchNode) {
        return matchNode.node;
      }
      return getFirstMatchNode(matchNode.match[0]);
    }
    function getLastMatchNode(matchNode) {
      if ("node" in matchNode) {
        return matchNode.node;
      }
      return getLastMatchNode(matchNode.match[matchNode.match.length - 1]);
    }
    function matchFragments(lexer, ast, match, type, name) {
      function findFragments(matchNode) {
        if (matchNode.syntax !== null && matchNode.syntax.type === type && matchNode.syntax.name === name) {
          const start = getFirstMatchNode(matchNode);
          const end = getLastMatchNode(matchNode);
          lexer.syntax.walk(ast, function(node, item, list) {
            if (node === start) {
              const nodes = new List.List();
              do {
                nodes.appendData(item.data);
                if (item.data === end) {
                  break;
                }
                item = item.next;
              } while (item !== null);
              fragments.push({
                parent: list,
                nodes
              });
            }
          });
        }
        if (Array.isArray(matchNode.match)) {
          matchNode.match.forEach(findFragments);
        }
      }
      const fragments = [];
      if (match.matched !== null) {
        findFragments(match.matched);
      }
      return fragments;
    }
    exports2.matchFragments = matchFragments;
  }
});

// node_modules/css-tree/cjs/lexer/structure.cjs
var require_structure = __commonJS({
  "node_modules/css-tree/cjs/lexer/structure.cjs"(exports2) {
    "use strict";
    var List = require_List();
    var { hasOwnProperty: hasOwnProperty2 } = Object.prototype;
    function isValidNumber(value) {
      return typeof value === "number" && isFinite(value) && Math.floor(value) === value && value >= 0;
    }
    function isValidLocation(loc) {
      return Boolean(loc) && isValidNumber(loc.offset) && isValidNumber(loc.line) && isValidNumber(loc.column);
    }
    function createNodeStructureChecker(type, fields) {
      return function checkNode(node, warn) {
        if (!node || node.constructor !== Object) {
          return warn(node, "Type of node should be an Object");
        }
        for (let key in node) {
          let valid = true;
          if (hasOwnProperty2.call(node, key) === false) {
            continue;
          }
          if (key === "type") {
            if (node.type !== type) {
              warn(node, "Wrong node type `" + node.type + "`, expected `" + type + "`");
            }
          } else if (key === "loc") {
            if (node.loc === null) {
              continue;
            } else if (node.loc && node.loc.constructor === Object) {
              if (typeof node.loc.source !== "string") {
                key += ".source";
              } else if (!isValidLocation(node.loc.start)) {
                key += ".start";
              } else if (!isValidLocation(node.loc.end)) {
                key += ".end";
              } else {
                continue;
              }
            }
            valid = false;
          } else if (fields.hasOwnProperty(key)) {
            valid = false;
            for (let i = 0; !valid && i < fields[key].length; i++) {
              const fieldType = fields[key][i];
              switch (fieldType) {
                case String:
                  valid = typeof node[key] === "string";
                  break;
                case Boolean:
                  valid = typeof node[key] === "boolean";
                  break;
                case null:
                  valid = node[key] === null;
                  break;
                default:
                  if (typeof fieldType === "string") {
                    valid = node[key] && node[key].type === fieldType;
                  } else if (Array.isArray(fieldType)) {
                    valid = node[key] instanceof List.List;
                  }
              }
            }
          } else {
            warn(node, "Unknown field `" + key + "` for " + type + " node type");
          }
          if (!valid) {
            warn(node, "Bad value for `" + type + "." + key + "`");
          }
        }
        for (const key in fields) {
          if (hasOwnProperty2.call(fields, key) && hasOwnProperty2.call(node, key) === false) {
            warn(node, "Field `" + type + "." + key + "` is missed");
          }
        }
      };
    }
    function genTypesList(fieldTypes, path) {
      const docsTypes = [];
      for (let i = 0; i < fieldTypes.length; i++) {
        const fieldType = fieldTypes[i];
        if (fieldType === String || fieldType === Boolean) {
          docsTypes.push(fieldType.name.toLowerCase());
        } else if (fieldType === null) {
          docsTypes.push("null");
        } else if (typeof fieldType === "string") {
          docsTypes.push(fieldType);
        } else if (Array.isArray(fieldType)) {
          docsTypes.push("List<" + (genTypesList(fieldType, path) || "any") + ">");
        } else {
          throw new Error("Wrong value `" + fieldType + "` in `" + path + "` structure definition");
        }
      }
      return docsTypes.join(" | ");
    }
    function processStructure(name, nodeType) {
      const structure = nodeType.structure;
      const fields = {
        type: String,
        loc: true
      };
      const docs = {
        type: '"' + name + '"'
      };
      for (const key in structure) {
        if (hasOwnProperty2.call(structure, key) === false) {
          continue;
        }
        const fieldTypes = fields[key] = Array.isArray(structure[key]) ? structure[key].slice() : [structure[key]];
        docs[key] = genTypesList(fieldTypes, name + "." + key);
      }
      return {
        docs,
        check: createNodeStructureChecker(name, fields)
      };
    }
    function getStructureFromConfig(config) {
      const structure = {};
      if (config.node) {
        for (const name in config.node) {
          if (hasOwnProperty2.call(config.node, name)) {
            const nodeType = config.node[name];
            if (nodeType.structure) {
              structure[name] = processStructure(name, nodeType);
            } else {
              throw new Error("Missed `structure` field in `" + name + "` node type definition");
            }
          }
        }
      }
      return structure;
    }
    exports2.getStructureFromConfig = getStructureFromConfig;
  }
});

// node_modules/css-tree/cjs/definition-syntax/walk.cjs
var require_walk = __commonJS({
  "node_modules/css-tree/cjs/definition-syntax/walk.cjs"(exports2) {
    "use strict";
    var noop = function() {
    };
    function ensureFunction(value) {
      return typeof value === "function" ? value : noop;
    }
    function walk(node, options, context) {
      function walk2(node2) {
        enter.call(context, node2);
        switch (node2.type) {
          case "Group":
            node2.terms.forEach(walk2);
            break;
          case "Multiplier":
          case "Boolean":
            walk2(node2.term);
            break;
          case "Type":
          case "Property":
          case "Keyword":
          case "AtKeyword":
          case "Function":
          case "String":
          case "Token":
          case "Comma":
            break;
          default:
            throw new Error("Unknown type: " + node2.type);
        }
        leave.call(context, node2);
      }
      let enter = noop;
      let leave = noop;
      if (typeof options === "function") {
        enter = options;
      } else if (options) {
        enter = ensureFunction(options.enter);
        leave = ensureFunction(options.leave);
      }
      if (enter === noop && leave === noop) {
        throw new Error("Neither `enter` nor `leave` walker handler is set or both aren't a function");
      }
      walk2(node);
    }
    exports2.walk = walk;
  }
});

// node_modules/css-tree/cjs/lexer/Lexer.cjs
var require_Lexer = __commonJS({
  "node_modules/css-tree/cjs/lexer/Lexer.cjs"(exports2) {
    "use strict";
    var error = require_error();
    var names = require_names2();
    var genericConst = require_generic_const();
    var generic = require_generic();
    var units = require_units();
    var prepareTokens = require_prepare_tokens();
    var matchGraph = require_match_graph();
    var match = require_match();
    var trace = require_trace();
    var search = require_search();
    var structure = require_structure();
    var parse = require_parse();
    var generate = require_generate();
    var walk = require_walk();
    function dumpMapSyntax(map, compact, syntaxAsAst) {
      const result = {};
      for (const name in map) {
        if (map[name].syntax) {
          result[name] = syntaxAsAst ? map[name].syntax : generate.generate(map[name].syntax, { compact });
        }
      }
      return result;
    }
    function dumpAtruleMapSyntax(map, compact, syntaxAsAst) {
      const result = {};
      for (const [name, atrule] of Object.entries(map)) {
        result[name] = {
          prelude: atrule.prelude && (syntaxAsAst ? atrule.prelude.syntax : generate.generate(atrule.prelude.syntax, { compact })),
          descriptors: atrule.descriptors && dumpMapSyntax(atrule.descriptors, compact, syntaxAsAst)
        };
      }
      return result;
    }
    function valueHasVar(tokens) {
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].value.toLowerCase() === "var(") {
          return true;
        }
      }
      return false;
    }
    function syntaxHasTopLevelCommaMultiplier(syntax) {
      const singleTerm = syntax.terms[0];
      return syntax.explicit === false && syntax.terms.length === 1 && singleTerm.type === "Multiplier" && singleTerm.comma === true;
    }
    function buildMatchResult(matched, error2, iterations) {
      return {
        matched,
        iterations,
        error: error2,
        ...trace
      };
    }
    function matchSyntax(lexer, syntax, value, useCssWideKeywords) {
      const tokens = prepareTokens(value, lexer.syntax);
      let result;
      if (valueHasVar(tokens)) {
        return buildMatchResult(null, new Error("Matching for a tree with var() is not supported"));
      }
      if (useCssWideKeywords) {
        result = match.matchAsTree(tokens, lexer.cssWideKeywordsSyntax, lexer);
      }
      if (!useCssWideKeywords || !result.match) {
        result = match.matchAsTree(tokens, syntax.match, lexer);
        if (!result.match) {
          return buildMatchResult(
            null,
            new error.SyntaxMatchError(result.reason, syntax.syntax, value, result),
            result.iterations
          );
        }
      }
      return buildMatchResult(result.match, null, result.iterations);
    }
    var Lexer = class {
      constructor(config, syntax, structure$1) {
        this.cssWideKeywords = genericConst.cssWideKeywords;
        this.syntax = syntax;
        this.generic = false;
        this.units = { ...units };
        this.atrules = /* @__PURE__ */ Object.create(null);
        this.properties = /* @__PURE__ */ Object.create(null);
        this.types = /* @__PURE__ */ Object.create(null);
        this.structure = structure$1 || structure.getStructureFromConfig(config);
        if (config) {
          if (config.cssWideKeywords) {
            this.cssWideKeywords = config.cssWideKeywords;
          }
          if (config.units) {
            for (const group of Object.keys(units)) {
              if (Array.isArray(config.units[group])) {
                this.units[group] = config.units[group];
              }
            }
          }
          if (config.types) {
            for (const [name, type] of Object.entries(config.types)) {
              this.addType_(name, type);
            }
          }
          if (config.generic) {
            this.generic = true;
            for (const [name, value] of Object.entries(generic.createGenericTypes(this.units))) {
              this.addType_(name, value);
            }
          }
          if (config.atrules) {
            for (const [name, atrule] of Object.entries(config.atrules)) {
              this.addAtrule_(name, atrule);
            }
          }
          if (config.properties) {
            for (const [name, property] of Object.entries(config.properties)) {
              this.addProperty_(name, property);
            }
          }
        }
        this.cssWideKeywordsSyntax = matchGraph.buildMatchGraph(this.cssWideKeywords.join(" |  "));
      }
      checkStructure(ast) {
        function collectWarning(node, message) {
          warns.push({ node, message });
        }
        const structure2 = this.structure;
        const warns = [];
        this.syntax.walk(ast, function(node) {
          if (structure2.hasOwnProperty(node.type)) {
            structure2[node.type].check(node, collectWarning);
          } else {
            collectWarning(node, "Unknown node type `" + node.type + "`");
          }
        });
        return warns.length ? warns : false;
      }
      createDescriptor(syntax, type, name, parent = null) {
        const ref = {
          type,
          name
        };
        const descriptor = {
          type,
          name,
          parent,
          serializable: typeof syntax === "string" || syntax && typeof syntax.type === "string",
          syntax: null,
          match: null,
          matchRef: null
          // used for properties when a syntax referenced as <'property'> in other syntax definitions
        };
        if (typeof syntax === "function") {
          descriptor.match = matchGraph.buildMatchGraph(syntax, ref);
        } else {
          if (typeof syntax === "string") {
            Object.defineProperty(descriptor, "syntax", {
              get() {
                Object.defineProperty(descriptor, "syntax", {
                  value: parse.parse(syntax)
                });
                return descriptor.syntax;
              }
            });
          } else {
            descriptor.syntax = syntax;
          }
          Object.defineProperty(descriptor, "match", {
            get() {
              Object.defineProperty(descriptor, "match", {
                value: matchGraph.buildMatchGraph(descriptor.syntax, ref)
              });
              return descriptor.match;
            }
          });
          if (type === "Property") {
            Object.defineProperty(descriptor, "matchRef", {
              get() {
                const syntax2 = descriptor.syntax;
                const value = syntaxHasTopLevelCommaMultiplier(syntax2) ? matchGraph.buildMatchGraph({
                  ...syntax2,
                  terms: [syntax2.terms[0].term]
                }, ref) : null;
                Object.defineProperty(descriptor, "matchRef", {
                  value
                });
                return value;
              }
            });
          }
        }
        return descriptor;
      }
      addAtrule_(name, syntax) {
        if (!syntax) {
          return;
        }
        this.atrules[name] = {
          type: "Atrule",
          name,
          prelude: syntax.prelude ? this.createDescriptor(syntax.prelude, "AtrulePrelude", name) : null,
          descriptors: syntax.descriptors ? Object.keys(syntax.descriptors).reduce(
            (map, descName) => {
              map[descName] = this.createDescriptor(syntax.descriptors[descName], "AtruleDescriptor", descName, name);
              return map;
            },
            /* @__PURE__ */ Object.create(null)
          ) : null
        };
      }
      addProperty_(name, syntax) {
        if (!syntax) {
          return;
        }
        this.properties[name] = this.createDescriptor(syntax, "Property", name);
      }
      addType_(name, syntax) {
        if (!syntax) {
          return;
        }
        this.types[name] = this.createDescriptor(syntax, "Type", name);
      }
      checkAtruleName(atruleName) {
        if (!this.getAtrule(atruleName)) {
          return new error.SyntaxReferenceError("Unknown at-rule", "@" + atruleName);
        }
      }
      checkAtrulePrelude(atruleName, prelude) {
        const error2 = this.checkAtruleName(atruleName);
        if (error2) {
          return error2;
        }
        const atrule = this.getAtrule(atruleName);
        if (!atrule.prelude && prelude) {
          return new SyntaxError("At-rule `@" + atruleName + "` should not contain a prelude");
        }
        if (atrule.prelude && !prelude) {
          if (!matchSyntax(this, atrule.prelude, "", false).matched) {
            return new SyntaxError("At-rule `@" + atruleName + "` should contain a prelude");
          }
        }
      }
      checkAtruleDescriptorName(atruleName, descriptorName) {
        const error$1 = this.checkAtruleName(atruleName);
        if (error$1) {
          return error$1;
        }
        const atrule = this.getAtrule(atruleName);
        const descriptor = names.keyword(descriptorName);
        if (!atrule.descriptors) {
          return new SyntaxError("At-rule `@" + atruleName + "` has no known descriptors");
        }
        if (!atrule.descriptors[descriptor.name] && !atrule.descriptors[descriptor.basename]) {
          return new error.SyntaxReferenceError("Unknown at-rule descriptor", descriptorName);
        }
      }
      checkPropertyName(propertyName) {
        if (!this.getProperty(propertyName)) {
          return new error.SyntaxReferenceError("Unknown property", propertyName);
        }
      }
      matchAtrulePrelude(atruleName, prelude) {
        const error2 = this.checkAtrulePrelude(atruleName, prelude);
        if (error2) {
          return buildMatchResult(null, error2);
        }
        const atrule = this.getAtrule(atruleName);
        if (!atrule.prelude) {
          return buildMatchResult(null, null);
        }
        return matchSyntax(this, atrule.prelude, prelude || "", false);
      }
      matchAtruleDescriptor(atruleName, descriptorName, value) {
        const error2 = this.checkAtruleDescriptorName(atruleName, descriptorName);
        if (error2) {
          return buildMatchResult(null, error2);
        }
        const atrule = this.getAtrule(atruleName);
        const descriptor = names.keyword(descriptorName);
        return matchSyntax(this, atrule.descriptors[descriptor.name] || atrule.descriptors[descriptor.basename], value, false);
      }
      matchDeclaration(node) {
        if (node.type !== "Declaration") {
          return buildMatchResult(null, new Error("Not a Declaration node"));
        }
        return this.matchProperty(node.property, node.value);
      }
      matchProperty(propertyName, value) {
        if (names.property(propertyName).custom) {
          return buildMatchResult(null, new Error("Lexer matching doesn't applicable for custom properties"));
        }
        const error2 = this.checkPropertyName(propertyName);
        if (error2) {
          return buildMatchResult(null, error2);
        }
        return matchSyntax(this, this.getProperty(propertyName), value, true);
      }
      matchType(typeName, value) {
        const typeSyntax = this.getType(typeName);
        if (!typeSyntax) {
          return buildMatchResult(null, new error.SyntaxReferenceError("Unknown type", typeName));
        }
        return matchSyntax(this, typeSyntax, value, false);
      }
      match(syntax, value) {
        if (typeof syntax !== "string" && (!syntax || !syntax.type)) {
          return buildMatchResult(null, new error.SyntaxReferenceError("Bad syntax"));
        }
        if (typeof syntax === "string" || !syntax.match) {
          syntax = this.createDescriptor(syntax, "Type", "anonymous");
        }
        return matchSyntax(this, syntax, value, false);
      }
      findValueFragments(propertyName, value, type, name) {
        return search.matchFragments(this, value, this.matchProperty(propertyName, value), type, name);
      }
      findDeclarationValueFragments(declaration, type, name) {
        return search.matchFragments(this, declaration.value, this.matchDeclaration(declaration), type, name);
      }
      findAllFragments(ast, type, name) {
        const result = [];
        this.syntax.walk(ast, {
          visit: "Declaration",
          enter: (declaration) => {
            result.push.apply(result, this.findDeclarationValueFragments(declaration, type, name));
          }
        });
        return result;
      }
      getAtrule(atruleName, fallbackBasename = true) {
        const atrule = names.keyword(atruleName);
        const atruleEntry = atrule.vendor && fallbackBasename ? this.atrules[atrule.name] || this.atrules[atrule.basename] : this.atrules[atrule.name];
        return atruleEntry || null;
      }
      getAtrulePrelude(atruleName, fallbackBasename = true) {
        const atrule = this.getAtrule(atruleName, fallbackBasename);
        return atrule && atrule.prelude || null;
      }
      getAtruleDescriptor(atruleName, name) {
        return this.atrules.hasOwnProperty(atruleName) && this.atrules.declarators ? this.atrules[atruleName].declarators[name] || null : null;
      }
      getProperty(propertyName, fallbackBasename = true) {
        const property = names.property(propertyName);
        const propertyEntry = property.vendor && fallbackBasename ? this.properties[property.name] || this.properties[property.basename] : this.properties[property.name];
        return propertyEntry || null;
      }
      getType(name) {
        return hasOwnProperty.call(this.types, name) ? this.types[name] : null;
      }
      validate() {
        function syntaxRef(name, isType) {
          return isType ? `<${name}>` : `<'${name}'>`;
        }
        function validate(syntax, name, broken, descriptor) {
          if (broken.has(name)) {
            return broken.get(name);
          }
          broken.set(name, false);
          if (descriptor.syntax !== null) {
            walk.walk(descriptor.syntax, function(node) {
              if (node.type !== "Type" && node.type !== "Property") {
                return;
              }
              const map = node.type === "Type" ? syntax.types : syntax.properties;
              const brokenMap = node.type === "Type" ? brokenTypes : brokenProperties;
              if (!hasOwnProperty.call(map, node.name)) {
                errors.push(`${syntaxRef(name, broken === brokenTypes)} used missed syntax definition ${syntaxRef(node.name, node.type === "Type")}`);
                broken.set(name, true);
              } else if (validate(syntax, node.name, brokenMap, map[node.name])) {
                errors.push(`${syntaxRef(name, broken === brokenTypes)} used broken syntax definition ${syntaxRef(node.name, node.type === "Type")}`);
                broken.set(name, true);
              }
            }, this);
          }
        }
        const errors = [];
        let brokenTypes = /* @__PURE__ */ new Map();
        let brokenProperties = /* @__PURE__ */ new Map();
        for (const key in this.types) {
          validate(this, key, brokenTypes, this.types[key]);
        }
        for (const key in this.properties) {
          validate(this, key, brokenProperties, this.properties[key]);
        }
        const brokenTypesArray = [...brokenTypes.keys()].filter((name) => brokenTypes.get(name));
        const brokenPropertiesArray = [...brokenProperties.keys()].filter((name) => brokenProperties.get(name));
        if (brokenTypesArray.length || brokenPropertiesArray.length) {
          return {
            errors,
            types: brokenTypesArray,
            properties: brokenPropertiesArray
          };
        }
        return null;
      }
      dump(syntaxAsAst, pretty) {
        return {
          generic: this.generic,
          cssWideKeywords: this.cssWideKeywords,
          units: this.units,
          types: dumpMapSyntax(this.types, !pretty, syntaxAsAst),
          properties: dumpMapSyntax(this.properties, !pretty, syntaxAsAst),
          atrules: dumpAtruleMapSyntax(this.atrules, !pretty, syntaxAsAst)
        };
      }
      toString() {
        return JSON.stringify(this.dump());
      }
    };
    exports2.Lexer = Lexer;
  }
});

// node_modules/css-tree/cjs/syntax/config/mix.cjs
var require_mix = __commonJS({
  "node_modules/css-tree/cjs/syntax/config/mix.cjs"(exports2, module2) {
    "use strict";
    function appendOrSet(a, b) {
      if (typeof b === "string" && /^\s*\|/.test(b)) {
        return typeof a === "string" ? a + b : b.replace(/^\s*\|\s*/, "");
      }
      return b || null;
    }
    function extractProps(obj, props) {
      const result = /* @__PURE__ */ Object.create(null);
      for (const prop of Object.keys(obj)) {
        if (props.includes(prop)) {
          result[prop] = obj[prop];
        }
      }
      return result;
    }
    function mergeDicts(base, ext, fields) {
      const result = { ...base };
      for (const [key, props] of Object.entries(ext)) {
        result[key] = {
          ...result[key],
          ...fields ? extractProps(props, fields) : props
        };
      }
      return result;
    }
    function mix(dest, src) {
      const result = { ...dest };
      for (const [prop, value] of Object.entries(src)) {
        switch (prop) {
          case "generic":
            result[prop] = Boolean(value);
            break;
          case "cssWideKeywords":
            result[prop] = dest[prop] ? [...dest[prop], ...value] : value || [];
            break;
          case "units":
            result[prop] = { ...dest[prop] };
            for (const [name, patch] of Object.entries(value)) {
              result[prop][name] = Array.isArray(patch) ? patch : [];
            }
            break;
          case "atrules":
            result[prop] = { ...dest[prop] };
            for (const [name, atrule] of Object.entries(value)) {
              const exists = result[prop][name] || {};
              const current = result[prop][name] = {
                prelude: exists.prelude || null,
                descriptors: {
                  ...exists.descriptors
                }
              };
              if (!atrule) {
                continue;
              }
              current.prelude = atrule.prelude ? appendOrSet(current.prelude, atrule.prelude) : current.prelude || null;
              for (const [descriptorName, descriptorValue] of Object.entries(atrule.descriptors || {})) {
                current.descriptors[descriptorName] = descriptorValue ? appendOrSet(current.descriptors[descriptorName], descriptorValue) : null;
              }
              if (!Object.keys(current.descriptors).length) {
                current.descriptors = null;
              }
            }
            break;
          case "types":
          case "properties":
            result[prop] = { ...dest[prop] };
            for (const [name, syntax] of Object.entries(value)) {
              result[prop][name] = appendOrSet(result[prop][name], syntax);
            }
            break;
          case "parseContext":
            result[prop] = {
              ...dest[prop],
              ...value
            };
            break;
          case "scope":
          case "features":
            result[prop] = mergeDicts(dest[prop], value);
            break;
          case "atrule":
          case "pseudo":
            result[prop] = mergeDicts(dest[prop], value, ["parse"]);
            break;
          case "node":
            result[prop] = mergeDicts(dest[prop], value, ["name", "structure", "parse", "generate", "walkContext"]);
            break;
        }
      }
      return result;
    }
    module2.exports = mix;
  }
});

// node_modules/css-tree/cjs/syntax/create.cjs
var require_create5 = __commonJS({
  "node_modules/css-tree/cjs/syntax/create.cjs"(exports2, module2) {
    "use strict";
    var index = require_tokenizer();
    var create = require_create();
    var create$2 = require_create2();
    var create$3 = require_create3();
    var create$1 = require_create4();
    var Lexer = require_Lexer();
    var mix = require_mix();
    function createSyntax(config) {
      const parse = create.createParser(config);
      const walk = create$1.createWalker(config);
      const generate = create$2.createGenerator(config);
      const { fromPlainObject, toPlainObject } = create$3.createConvertor(walk);
      const syntax = {
        lexer: null,
        createLexer: (config2) => new Lexer.Lexer(config2, syntax, syntax.lexer.structure),
        tokenize: index.tokenize,
        parse,
        generate,
        walk,
        find: walk.find,
        findLast: walk.findLast,
        findAll: walk.findAll,
        fromPlainObject,
        toPlainObject,
        fork(extension) {
          const base = mix({}, config);
          return createSyntax(
            typeof extension === "function" ? extension(base) : mix(base, extension)
          );
        }
      };
      syntax.lexer = new Lexer.Lexer({
        generic: config.generic,
        cssWideKeywords: config.cssWideKeywords,
        units: config.units,
        types: config.types,
        atrules: config.atrules,
        properties: config.properties,
        node: config.node
      }, syntax);
      return syntax;
    }
    var createSyntax$1 = (config) => createSyntax(mix({}, config));
    module2.exports = createSyntax$1;
  }
});

// node_modules/css-tree/data/patch.json
var require_patch = __commonJS({
  "node_modules/css-tree/data/patch.json"(exports2, module2) {
    module2.exports = {
      atrules: {
        charset: {
          prelude: "<string>"
        },
        container: {
          prelude: "[ <container-name> ]? <container-condition>"
        },
        "font-face": {
          descriptors: {
            "unicode-range": {
              comment: "replaces <unicode-range>, an old production name",
              syntax: "<urange>#"
            }
          }
        },
        "font-features-values": {
          comment: "The features values syntax is defined in https://www.w3.org/TR/css-fonts-4/#at-ruledef-font-feature-values",
          prelude: "[<string> | <custom-ident>]+",
          descriptors: {
            "font-display": "auto | block | swap | fallback | optional"
          }
        },
        scope: {
          prelude: "[ ( <scope-start> ) ]? [ to ( <scope-end> ) ]?"
        },
        "position-try": {
          comment: "The list of descriptors: https://developer.mozilla.org/en-US/docs/Web/CSS/@position-try",
          descriptors: {
            top: "<'top'>",
            left: "<'left'>",
            bottom: "<'bottom'>",
            right: "<'right'>",
            "inset-block-start": "<'inset-block-start'>",
            "inset-block-end": "<'inset-block-end'>",
            "inset-inline-start": "<'inset-inline-start'>",
            "inset-inline-end": "<'inset-inline-end'>",
            "inset-block": "<'inset-block'>",
            "inset-inline": "<'inset-inline'>",
            inset: "<'inset'>",
            "margin-top": "<'margin-top'>",
            "margin-left": "<'margin-left'>",
            "margin-bottom": "<'margin-bottom'>",
            "margin-right": "<'margin-right'>",
            "margin-block-start": "<'margin-block-start'>",
            "margin-block-end": "<'margin-block-end'>",
            "margin-inline-start": "<'margin-inline-start'>",
            "margin-inline-end": "<'margin-inline-end'>",
            margin: "<'margin'>",
            "margin-block": "<'margin-block'>",
            "margin-inline": "<'margin-inline'>",
            width: "<'width'>",
            height: "<'height'>",
            "min-width": "<'min-width'>",
            "min-height": "<'min-height'>",
            "max-width": "<'max-width'>",
            "max-height": "<'max-height'>",
            "block-size": "<'block-size'>",
            "inline-size": "<'inline-size'>",
            "min-block-size": "<'min-block-size'>",
            "min-inline-size": "<'min-inline-size'>",
            "max-block-size": "<'max-block-size'>",
            "max-inline-size": "<'max-inline-size'>",
            "align-self": "<'align-self'> | anchor-center",
            "justify-self": "<'justify-self'> | anchor-center"
          }
        }
      },
      properties: {
        "-moz-background-clip": {
          comment: "deprecated syntax in old Firefox, https://developer.mozilla.org/en/docs/Web/CSS/background-clip",
          syntax: "padding | border"
        },
        "-moz-border-radius-bottomleft": {
          comment: "https://developer.mozilla.org/en-US/docs/Web/CSS/border-bottom-left-radius",
          syntax: "<'border-bottom-left-radius'>"
        },
        "-moz-border-radius-bottomright": {
          comment: "https://developer.mozilla.org/en-US/docs/Web/CSS/border-bottom-right-radius",
          syntax: "<'border-bottom-right-radius'>"
        },
        "-moz-border-radius-topleft": {
          comment: "https://developer.mozilla.org/en-US/docs/Web/CSS/border-top-left-radius",
          syntax: "<'border-top-left-radius'>"
        },
        "-moz-border-radius-topright": {
          comment: "https://developer.mozilla.org/en-US/docs/Web/CSS/border-bottom-right-radius",
          syntax: "<'border-bottom-right-radius'>"
        },
        "-moz-control-character-visibility": {
          comment: "firefox specific keywords, https://bugzilla.mozilla.org/show_bug.cgi?id=947588",
          syntax: "visible | hidden"
        },
        "-moz-osx-font-smoothing": {
          comment: "misssed old syntax https://developer.mozilla.org/en-US/docs/Web/CSS/font-smooth",
          syntax: "auto | grayscale"
        },
        "-moz-user-select": {
          comment: "https://developer.mozilla.org/en-US/docs/Web/CSS/user-select",
          syntax: "none | text | all | -moz-none"
        },
        "-ms-flex-align": {
          comment: "misssed old syntax implemented in IE, https://www.w3.org/TR/2012/WD-css3-flexbox-20120322/#flex-align",
          syntax: "start | end | center | baseline | stretch"
        },
        "-ms-flex-item-align": {
          comment: "misssed old syntax implemented in IE, https://www.w3.org/TR/2012/WD-css3-flexbox-20120322/#flex-align",
          syntax: "auto | start | end | center | baseline | stretch"
        },
        "-ms-flex-line-pack": {
          comment: "misssed old syntax implemented in IE, https://www.w3.org/TR/2012/WD-css3-flexbox-20120322/#flex-line-pack",
          syntax: "start | end | center | justify | distribute | stretch"
        },
        "-ms-flex-negative": {
          comment: "misssed old syntax implemented in IE; TODO: find references for comfirmation",
          syntax: "<'flex-shrink'>"
        },
        "-ms-flex-pack": {
          comment: "misssed old syntax implemented in IE, https://www.w3.org/TR/2012/WD-css3-flexbox-20120322/#flex-pack",
          syntax: "start | end | center | justify | distribute"
        },
        "-ms-flex-order": {
          comment: "misssed old syntax implemented in IE; https://msdn.microsoft.com/en-us/library/jj127303(v=vs.85).aspx",
          syntax: "<integer>"
        },
        "-ms-flex-positive": {
          comment: "misssed old syntax implemented in IE; TODO: find references for comfirmation",
          syntax: "<'flex-grow'>"
        },
        "-ms-flex-preferred-size": {
          comment: "misssed old syntax implemented in IE; TODO: find references for comfirmation",
          syntax: "<'flex-basis'>"
        },
        "-ms-interpolation-mode": {
          comment: "https://msdn.microsoft.com/en-us/library/ff521095(v=vs.85).aspx",
          syntax: "nearest-neighbor | bicubic"
        },
        "-ms-grid-column-align": {
          comment: "add this property first since it uses as fallback for flexbox, https://msdn.microsoft.com/en-us/library/windows/apps/hh466338.aspx",
          syntax: "start | end | center | stretch"
        },
        "-ms-grid-row-align": {
          comment: "add this property first since it uses as fallback for flexbox, https://msdn.microsoft.com/en-us/library/windows/apps/hh466348.aspx",
          syntax: "start | end | center | stretch"
        },
        "-ms-hyphenate-limit-last": {
          comment: "misssed old syntax implemented in IE; https://www.w3.org/TR/css-text-4/#hyphenate-line-limits",
          syntax: "none | always | column | page | spread"
        },
        "-webkit-appearance": {
          comment: "webkit specific keywords",
          references: [
            "http://css-infos.net/property/-webkit-appearance"
          ],
          syntax: "none | button | button-bevel | caps-lock-indicator | caret | checkbox | default-button | inner-spin-button | listbox | listitem | media-controls-background | media-controls-fullscreen-background | media-current-time-display | media-enter-fullscreen-button | media-exit-fullscreen-button | media-fullscreen-button | media-mute-button | media-overlay-play-button | media-play-button | media-seek-back-button | media-seek-forward-button | media-slider | media-sliderthumb | media-time-remaining-display | media-toggle-closed-captions-button | media-volume-slider | media-volume-slider-container | media-volume-sliderthumb | menulist | menulist-button | menulist-text | menulist-textfield | meter | progress-bar | progress-bar-value | push-button | radio | scrollbarbutton-down | scrollbarbutton-left | scrollbarbutton-right | scrollbarbutton-up | scrollbargripper-horizontal | scrollbargripper-vertical | scrollbarthumb-horizontal | scrollbarthumb-vertical | scrollbartrack-horizontal | scrollbartrack-vertical | searchfield | searchfield-cancel-button | searchfield-decoration | searchfield-results-button | searchfield-results-decoration | slider-horizontal | slider-vertical | sliderthumb-horizontal | sliderthumb-vertical | square-button | textarea | textfield | -apple-pay-button"
        },
        "-webkit-background-clip": {
          comment: "https://developer.mozilla.org/en/docs/Web/CSS/background-clip",
          syntax: "[ <visual-box> | border | padding | content | text ]#"
        },
        "-webkit-column-break-after": {
          comment: "added, http://help.dottoro.com/lcrthhhv.php",
          syntax: "always | auto | avoid"
        },
        "-webkit-column-break-before": {
          comment: "added, http://help.dottoro.com/lcxquvkf.php",
          syntax: "always | auto | avoid"
        },
        "-webkit-column-break-inside": {
          comment: "added, http://help.dottoro.com/lclhnthl.php",
          syntax: "always | auto | avoid"
        },
        "-webkit-font-smoothing": {
          comment: "https://developer.mozilla.org/en-US/docs/Web/CSS/font-smooth",
          syntax: "auto | none | antialiased | subpixel-antialiased"
        },
        "-webkit-mask-box-image": {
          comment: "missed; https://developer.mozilla.org/en-US/docs/Web/CSS/-webkit-mask-box-image",
          syntax: "[ <url> | <gradient> | none ] [ <length-percentage>{4} <-webkit-mask-box-repeat>{2} ]?"
        },
        "-webkit-print-color-adjust": {
          comment: "missed",
          references: [
            "https://developer.mozilla.org/en/docs/Web/CSS/-webkit-print-color-adjust"
          ],
          syntax: "economy | exact"
        },
        "-webkit-text-security": {
          comment: "missed; http://help.dottoro.com/lcbkewgt.php",
          syntax: "none | circle | disc | square"
        },
        "-webkit-user-drag": {
          comment: "missed; http://help.dottoro.com/lcbixvwm.php",
          syntax: "none | element | auto"
        },
        "-webkit-user-select": {
          comment: "auto is supported by old webkit, https://developer.mozilla.org/en-US/docs/Web/CSS/user-select",
          syntax: "auto | none | text | all"
        },
        "alignment-baseline": {
          comment: "added SVG property",
          references: [
            "https://www.w3.org/TR/SVG/text.html#AlignmentBaselineProperty"
          ],
          syntax: "auto | baseline | before-edge | text-before-edge | middle | central | after-edge | text-after-edge | ideographic | alphabetic | hanging | mathematical"
        },
        "baseline-shift": {
          comment: "added SVG property",
          references: [
            "https://www.w3.org/TR/SVG/text.html#BaselineShiftProperty"
          ],
          syntax: "baseline | sub | super | <svg-length>"
        },
        behavior: {
          comment: "added old IE property https://msdn.microsoft.com/en-us/library/ms530723(v=vs.85).aspx",
          syntax: "<url>+"
        },
        "container-type": {
          comment: "https://www.w3.org/TR/css-contain-3/#propdef-container-type",
          syntax: "normal || [ size | inline-size ]"
        },
        cue: {
          comment: "https://www.w3.org/TR/css3-speech/#property-index",
          syntax: "<'cue-before'> <'cue-after'>?"
        },
        "cue-after": {
          comment: "https://www.w3.org/TR/css3-speech/#property-index",
          syntax: "<url> <decibel>? | none"
        },
        "cue-before": {
          comment: "https://www.w3.org/TR/css3-speech/#property-index",
          syntax: "<url> <decibel>? | none"
        },
        cursor: {
          comment: "added legacy keywords: hand, -webkit-grab. -webkit-grabbing, -webkit-zoom-in, -webkit-zoom-out, -moz-grab, -moz-grabbing, -moz-zoom-in, -moz-zoom-out",
          references: [
            "https://www.sitepoint.com/css3-cursor-styles/"
          ],
          syntax: "[ [ <url> [ <x> <y> ]? , ]* [ auto | default | none | context-menu | help | pointer | progress | wait | cell | crosshair | text | vertical-text | alias | copy | move | no-drop | not-allowed | e-resize | n-resize | ne-resize | nw-resize | s-resize | se-resize | sw-resize | w-resize | ew-resize | ns-resize | nesw-resize | nwse-resize | col-resize | row-resize | all-scroll | zoom-in | zoom-out | grab | grabbing | hand | -webkit-grab | -webkit-grabbing | -webkit-zoom-in | -webkit-zoom-out | -moz-grab | -moz-grabbing | -moz-zoom-in | -moz-zoom-out ] ]"
        },
        display: {
          comment: "extended with -ms-flexbox",
          syntax: "| <-non-standard-display>"
        },
        position: {
          comment: "extended with -webkit-sticky",
          syntax: "| -webkit-sticky"
        },
        "dominant-baseline": {
          comment: "added SVG property",
          references: [
            "https://www.w3.org/TR/SVG/text.html#DominantBaselineProperty"
          ],
          syntax: "auto | use-script | no-change | reset-size | ideographic | alphabetic | hanging | mathematical | central | middle | text-after-edge | text-before-edge"
        },
        "image-rendering": {
          comment: "extended with <-non-standard-image-rendering>, added SVG keywords optimizeSpeed and optimizeQuality",
          references: [
            "https://developer.mozilla.org/en/docs/Web/CSS/image-rendering",
            "https://www.w3.org/TR/SVG/painting.html#ImageRenderingProperty"
          ],
          syntax: "| optimizeSpeed | optimizeQuality | <-non-standard-image-rendering>"
        },
        "fill-opacity": {
          comment: "added SVG property",
          references: [
            "https://developer.mozilla.org/en-US/docs/Web/CSS/fill-opacity",
            "https://www.w3.org/TR/SVG/painting.html#FillProperty"
          ],
          syntax: "<number-zero-one> | <percentage>"
        },
        filter: {
          comment: "extend with IE legacy syntaxes",
          syntax: "| <-ms-filter-function-list>"
        },
        font: {
          comment: "align with font-4, fix <'font-family'>#, add non standard fonts",
          references: [
            "https://drafts.csswg.org/css-fonts-4/#font-prop",
            "https://github.com/w3c/csswg-drafts/pull/10832",
            "https://webkit.org/blog/3709/using-the-system-font-in-web-content/"
          ],
          syntax: "[ [ <'font-style'> || <font-variant-css2> || <'font-weight'> || <font-width-css3> ]? <'font-size'> [ / <'line-height'> ]? <'font-family'># ] | <system-family-name> | <-non-standard-font>"
        },
        "glyph-orientation-horizontal": {
          comment: "added SVG property",
          references: [
            "https://www.w3.org/TR/SVG/text.html#GlyphOrientationHorizontalProperty"
          ],
          syntax: "<angle>"
        },
        "glyph-orientation-vertical": {
          comment: "added SVG property",
          references: [
            "https://www.w3.org/TR/SVG/text.html#GlyphOrientationVerticalProperty"
          ],
          syntax: "<angle>"
        },
        kerning: {
          comment: "added SVG property",
          references: [
            "https://www.w3.org/TR/SVG/text.html#KerningProperty"
          ],
          syntax: "auto | <svg-length>"
        },
        "letter-spacing": {
          comment: "fix syntax <length> -> <length-percentage>",
          references: [
            "https://developer.mozilla.org/en-US/docs/Web/SVG/Attribute/letter-spacing"
          ],
          syntax: "normal | <length-percentage>"
        },
        "max-width": {
          comment: "extend by non-standard size keywords https://developer.mozilla.org/en-US/docs/Web/CSS/width",
          syntax: "| stretch | <-non-standard-size>"
        },
        "max-height": {
          comment: "extend by non-standard size keywords https://developer.mozilla.org/en-US/docs/Web/CSS/width",
          syntax: "| stretch | <-non-standard-size>"
        },
        width: {
          references: [
            "https://developer.mozilla.org/en-US/docs/Web/CSS/width",
            "https://github.com/csstree/stylelint-validator/issues/29"
          ],
          syntax: "| stretch | <-non-standard-size>"
        },
        height: {
          syntax: "| stretch | <-non-standard-size>"
        },
        "min-width": {
          comment: "extend by non-standard width keywords https://developer.mozilla.org/en-US/docs/Web/CSS/width",
          syntax: "| stretch | <-non-standard-size>"
        },
        "min-height": {
          syntax: "| stretch | <-non-standard-size>"
        },
        overflow: {
          comment: "extend by vendor keywords https://developer.mozilla.org/en-US/docs/Web/CSS/overflow",
          syntax: "| <-non-standard-overflow>"
        },
        "overflow-x": {
          comment: "extend by vendor keywords https://developer.mozilla.org/en-US/docs/Web/CSS/overflow-x",
          syntax: "| <-non-standard-overflow>"
        },
        "overflow-y": {
          comment: "extend by vendor keywords https://developer.mozilla.org/en-US/docs/Web/CSS/overflow-y",
          syntax: "| <-non-standard-overflow>"
        },
        "overflow-block": {
          comment: "extend by vendor keywords https://developer.mozilla.org/en-US/docs/Web/CSS/overflow-y",
          syntax: "| <-non-standard-overflow>"
        },
        "overflow-inline": {
          comment: "extend by vendor keywords https://developer.mozilla.org/en-US/docs/Web/CSS/overflow-x",
          syntax: "| <-non-standard-overflow>"
        },
        pause: {
          comment: "https://www.w3.org/TR/css3-speech/#property-index",
          syntax: "<'pause-before'> <'pause-after'>?"
        },
        "pause-after": {
          comment: "https://www.w3.org/TR/css3-speech/#property-index",
          syntax: "<time> | none | x-weak | weak | medium | strong | x-strong"
        },
        "pause-before": {
          comment: "https://www.w3.org/TR/css3-speech/#property-index",
          syntax: "<time> | none | x-weak | weak | medium | strong | x-strong"
        },
        "position-try-options": {
          comment: "https://developer.mozilla.org/en-US/docs/Web/CSS/position-try-fallbacks",
          syntax: "<'position-try-fallbacks'>"
        },
        rest: {
          comment: "https://www.w3.org/TR/css3-speech/#property-index",
          syntax: "<'rest-before'> <'rest-after'>?"
        },
        "rest-after": {
          comment: "https://www.w3.org/TR/css3-speech/#property-index",
          syntax: "<time> | none | x-weak | weak | medium | strong | x-strong"
        },
        "rest-before": {
          comment: "https://www.w3.org/TR/css3-speech/#property-index",
          syntax: "<time> | none | x-weak | weak | medium | strong | x-strong"
        },
        speak: {
          comment: "https://www.w3.org/TR/css3-speech/#property-index",
          syntax: "auto | never | always"
        },
        "stroke-dasharray": {
          comment: "added SVG property; a list of comma and/or white space separated <length>s and <percentage>s",
          references: [
            "https://www.w3.org/TR/SVG/painting.html#StrokeProperties"
          ],
          syntax: "none | [ <svg-length>+ ]#"
        },
        "stroke-dashoffset": {
          comment: "added SVG property",
          references: [
            "https://www.w3.org/TR/SVG/painting.html#StrokeProperties"
          ],
          syntax: "<svg-length>"
        },
        "stroke-linejoin": {
          comment: "added SVG property",
          references: [
            "https://www.w3.org/TR/SVG/painting.html#StrokeProperties"
          ],
          syntax: "miter | round | bevel"
        },
        "stroke-miterlimit": {
          comment: "added SVG property (<miterlimit> = <number-one-or-greater>) ",
          references: [
            "https://www.w3.org/TR/SVG/painting.html#StrokeProperties"
          ],
          syntax: "<number-one-or-greater>"
        },
        "stroke-width": {
          comment: "added SVG property",
          references: [
            "https://www.w3.org/TR/SVG/painting.html#StrokeProperties"
          ],
          syntax: "<svg-length>"
        },
        "unicode-bidi": {
          comment: "added prefixed keywords https://developer.mozilla.org/en-US/docs/Web/CSS/unicode-bidi",
          syntax: "| -moz-isolate | -moz-isolate-override | -moz-plaintext | -webkit-isolate | -webkit-isolate-override | -webkit-plaintext"
        },
        "voice-balance": {
          comment: "https://www.w3.org/TR/css3-speech/#property-index",
          syntax: "<number> | left | center | right | leftwards | rightwards"
        },
        "voice-duration": {
          comment: "https://www.w3.org/TR/css3-speech/#property-index",
          syntax: "auto | <time>"
        },
        "voice-family": {
          comment: "<name> -> <family-name>, https://www.w3.org/TR/css3-speech/#property-index",
          syntax: "[ [ <family-name> | <generic-voice> ] , ]* [ <family-name> | <generic-voice> ] | preserve"
        },
        "voice-pitch": {
          comment: "https://www.w3.org/TR/css3-speech/#property-index",
          syntax: "<frequency> && absolute | [ [ x-low | low | medium | high | x-high ] || [ <frequency> | <semitones> | <percentage> ] ]"
        },
        "voice-range": {
          comment: "https://www.w3.org/TR/css3-speech/#property-index",
          syntax: "<frequency> && absolute | [ [ x-low | low | medium | high | x-high ] || [ <frequency> | <semitones> | <percentage> ] ]"
        },
        "voice-rate": {
          comment: "https://www.w3.org/TR/css3-speech/#property-index",
          syntax: "[ normal | x-slow | slow | medium | fast | x-fast ] || <percentage>"
        },
        "voice-stress": {
          comment: "https://www.w3.org/TR/css3-speech/#property-index",
          syntax: "normal | strong | moderate | none | reduced"
        },
        "voice-volume": {
          comment: "https://www.w3.org/TR/css3-speech/#property-index",
          syntax: "silent | [ [ x-soft | soft | medium | loud | x-loud ] || <decibel> ]"
        },
        "writing-mode": {
          comment: "extend with SVG keywords",
          syntax: "| <svg-writing-mode>"
        },
        "white-space-trim": {
          syntax: "none | discard-before || discard-after || discard-inner",
          comment: "missed, https://www.w3.org/TR/css-text-4/#white-space-trim"
        }
      },
      types: {
        "-legacy-gradient": {
          comment: "added collection of legacy gradient syntaxes",
          syntax: "<-webkit-gradient()> | <-legacy-linear-gradient> | <-legacy-repeating-linear-gradient> | <-legacy-radial-gradient> | <-legacy-repeating-radial-gradient>"
        },
        "-legacy-linear-gradient": {
          comment: "like standard syntax but w/o `to` keyword https://developer.mozilla.org/en-US/docs/Web/CSS/linear-gradient",
          syntax: "-moz-linear-gradient( <-legacy-linear-gradient-arguments> ) | -webkit-linear-gradient( <-legacy-linear-gradient-arguments> ) | -o-linear-gradient( <-legacy-linear-gradient-arguments> )"
        },
        "-legacy-repeating-linear-gradient": {
          comment: "like standard syntax but w/o `to` keyword https://developer.mozilla.org/en-US/docs/Web/CSS/linear-gradient",
          syntax: "-moz-repeating-linear-gradient( <-legacy-linear-gradient-arguments> ) | -webkit-repeating-linear-gradient( <-legacy-linear-gradient-arguments> ) | -o-repeating-linear-gradient( <-legacy-linear-gradient-arguments> )"
        },
        "-legacy-linear-gradient-arguments": {
          comment: "like standard syntax but w/o `to` keyword https://developer.mozilla.org/en-US/docs/Web/CSS/linear-gradient",
          syntax: "[ <angle> | <side-or-corner> ]? , <color-stop-list>"
        },
        "-legacy-radial-gradient": {
          comment: "deprecated syntax that implemented by some browsers https://www.w3.org/TR/2011/WD-css3-images-20110908/#radial-gradients",
          syntax: "-moz-radial-gradient( <-legacy-radial-gradient-arguments> ) | -webkit-radial-gradient( <-legacy-radial-gradient-arguments> ) | -o-radial-gradient( <-legacy-radial-gradient-arguments> )"
        },
        "-legacy-repeating-radial-gradient": {
          comment: "deprecated syntax that implemented by some browsers https://www.w3.org/TR/2011/WD-css3-images-20110908/#radial-gradients",
          syntax: "-moz-repeating-radial-gradient( <-legacy-radial-gradient-arguments> ) | -webkit-repeating-radial-gradient( <-legacy-radial-gradient-arguments> ) | -o-repeating-radial-gradient( <-legacy-radial-gradient-arguments> )"
        },
        "-legacy-radial-gradient-arguments": {
          comment: "deprecated syntax that implemented by some browsers https://www.w3.org/TR/2011/WD-css3-images-20110908/#radial-gradients",
          syntax: "[ <position> , ]? [ [ [ <-legacy-radial-gradient-shape> || <-legacy-radial-gradient-size> ] | [ <length> | <percentage> ]{2} ] , ]? <color-stop-list>"
        },
        "-legacy-radial-gradient-size": {
          comment: "before a standard it contains 2 extra keywords (`contain` and `cover`) https://www.w3.org/TR/2011/WD-css3-images-20110908/#ltsize",
          syntax: "closest-side | closest-corner | farthest-side | farthest-corner | contain | cover"
        },
        "-legacy-radial-gradient-shape": {
          comment: "define to double sure it doesn't extends in future https://www.w3.org/TR/2011/WD-css3-images-20110908/#ltshape",
          syntax: "circle | ellipse"
        },
        "-non-standard-font": {
          comment: "non standard fonts",
          references: [
            "https://webkit.org/blog/3709/using-the-system-font-in-web-content/"
          ],
          syntax: "-apple-system-body | -apple-system-headline | -apple-system-subheadline | -apple-system-caption1 | -apple-system-caption2 | -apple-system-footnote | -apple-system-short-body | -apple-system-short-headline | -apple-system-short-subheadline | -apple-system-short-caption1 | -apple-system-short-footnote | -apple-system-tall-body"
        },
        "-non-standard-color": {
          comment: "non standard colors",
          references: [
            "http://cssdot.ru/%D0%A1%D0%BF%D1%80%D0%B0%D0%B2%D0%BE%D1%87%D0%BD%D0%B8%D0%BA_CSS/color-i305.html",
            "https://developer.mozilla.org/en-US/docs/Web/CSS/color_value#Mozilla_Color_Preference_Extensions"
          ],
          syntax: "-moz-ButtonDefault | -moz-ButtonHoverFace | -moz-ButtonHoverText | -moz-CellHighlight | -moz-CellHighlightText | -moz-Combobox | -moz-ComboboxText | -moz-Dialog | -moz-DialogText | -moz-dragtargetzone | -moz-EvenTreeRow | -moz-Field | -moz-FieldText | -moz-html-CellHighlight | -moz-html-CellHighlightText | -moz-mac-accentdarkestshadow | -moz-mac-accentdarkshadow | -moz-mac-accentface | -moz-mac-accentlightesthighlight | -moz-mac-accentlightshadow | -moz-mac-accentregularhighlight | -moz-mac-accentregularshadow | -moz-mac-chrome-active | -moz-mac-chrome-inactive | -moz-mac-focusring | -moz-mac-menuselect | -moz-mac-menushadow | -moz-mac-menutextselect | -moz-MenuHover | -moz-MenuHoverText | -moz-MenuBarText | -moz-MenuBarHoverText | -moz-nativehyperlinktext | -moz-OddTreeRow | -moz-win-communicationstext | -moz-win-mediatext | -moz-activehyperlinktext | -moz-default-background-color | -moz-default-color | -moz-hyperlinktext | -moz-visitedhyperlinktext | -webkit-activelink | -webkit-focus-ring-color | -webkit-link | -webkit-text"
        },
        "-non-standard-image-rendering": {
          comment: "non-standard keywords http://phrogz.net/tmp/canvas_image_zoom.html",
          syntax: "optimize-contrast | -moz-crisp-edges | -o-crisp-edges | -webkit-optimize-contrast"
        },
        "-non-standard-overflow": {
          comment: "non-standard keywords https://developer.mozilla.org/en-US/docs/Web/CSS/overflow",
          syntax: "overlay | -moz-scrollbars-none | -moz-scrollbars-horizontal | -moz-scrollbars-vertical | -moz-hidden-unscrollable"
        },
        "-non-standard-size": {
          comment: "non-standard keywords https://developer.mozilla.org/en-US/docs/Web/CSS/width",
          syntax: "intrinsic | min-intrinsic | -webkit-fill-available | -webkit-fit-content | -webkit-min-content | -webkit-max-content  | -moz-available | -moz-fit-content | -moz-min-content | -moz-max-content"
        },
        "-webkit-gradient()": {
          comment: "first Apple proposal gradient syntax https://webkit.org/blog/175/introducing-css-gradients/ - TODO: simplify when after match algorithm improvement ( [, point, radius | , point] -> [, radius]? , point )",
          syntax: "-webkit-gradient( <-webkit-gradient-type>, <-webkit-gradient-point> [, <-webkit-gradient-point> | , <-webkit-gradient-radius>, <-webkit-gradient-point> ] [, <-webkit-gradient-radius>]? [, <-webkit-gradient-color-stop>]* )"
        },
        "-webkit-gradient-color-stop": {
          comment: "first Apple proposal gradient syntax https://webkit.org/blog/175/introducing-css-gradients/",
          syntax: "from( <color> ) | color-stop( [ <number-zero-one> | <percentage> ] , <color> ) | to( <color> )"
        },
        "-webkit-gradient-point": {
          comment: "first Apple proposal gradient syntax https://webkit.org/blog/175/introducing-css-gradients/",
          syntax: "[ left | center | right | <length-percentage> ] [ top | center | bottom | <length-percentage> ]"
        },
        "-webkit-gradient-radius": {
          comment: "first Apple proposal gradient syntax https://webkit.org/blog/175/introducing-css-gradients/",
          syntax: "<length> | <percentage>"
        },
        "-webkit-gradient-type": {
          comment: "first Apple proposal gradient syntax https://webkit.org/blog/175/introducing-css-gradients/",
          syntax: "linear | radial"
        },
        "-webkit-mask-box-repeat": {
          comment: "missed; https://developer.mozilla.org/en-US/docs/Web/CSS/-webkit-mask-box-image",
          syntax: "repeat | stretch | round"
        },
        "-ms-filter-function-list": {
          comment: "https://developer.mozilla.org/en-US/docs/Web/CSS/-ms-filter",
          syntax: "<-ms-filter-function>+"
        },
        "-ms-filter-function": {
          comment: "https://developer.mozilla.org/en-US/docs/Web/CSS/-ms-filter",
          syntax: "<-ms-filter-function-progid> | <-ms-filter-function-legacy>"
        },
        "-ms-filter-function-progid": {
          comment: "https://developer.mozilla.org/en-US/docs/Web/CSS/-ms-filter",
          syntax: "'progid:' [ <ident-token> '.' ]* [ <ident-token> | <function-token> <any-value>? ) ]"
        },
        "-ms-filter-function-legacy": {
          comment: "https://developer.mozilla.org/en-US/docs/Web/CSS/-ms-filter",
          syntax: "<ident-token> | <function-token> <any-value>? )"
        },
        age: {
          comment: "https://www.w3.org/TR/css3-speech/#voice-family",
          syntax: "child | young | old"
        },
        "attr-name": {
          syntax: "<wq-name>"
        },
        "attr-fallback": {
          syntax: "<any-value>"
        },
        autospace: {
          syntax: "no-autospace | [ ideograph-alpha || ideograph-numeric || punctuation ] || [ insert | replace ]"
        },
        bottom: {
          comment: "missed; not sure we should add it, but no others except `shape` is using it so it's ok for now; https://drafts.fxtf.org/css-masking-1/#funcdef-clip-rect",
          syntax: "<length> | auto"
        },
        "content-list": {
          comment: "added attr(), see https://github.com/csstree/csstree/issues/201",
          syntax: "[ <string> | contents | <image> | <counter> | <quote> | <target> | <leader()> | <attr()> ]+"
        },
        "container-condition": {
          comment: "missed, https://drafts.csswg.org/css-contain-3/#container-rule",
          syntax: "not <query-in-parens> | <query-in-parens> [ [ and <query-in-parens> ]* | [ or <query-in-parens> ]* ]"
        },
        "coord-box": {
          syntax: "content-box | padding-box | border-box | fill-box | stroke-box | view-box"
        },
        "cubic-bezier-easing-function": {
          comment: "missed, https://drafts.csswg.org/css-easing-1/#cubic-bezier-easing-function",
          syntax: "ease | ease-in | ease-out | ease-in-out | cubic-bezier( <number [0,1]> , <number> , <number [0,1]> , <number> )"
        },
        "element()": {
          comment: "https://drafts.csswg.org/css-gcpm/#element-syntax & https://drafts.csswg.org/css-images-4/#element-notation",
          syntax: "element( <custom-ident> , [ first | start | last | first-except ]? ) | element( <id-selector> )"
        },
        "generic-voice": {
          comment: "https://www.w3.org/TR/css3-speech/#voice-family",
          syntax: "[ <age>? <gender> <integer>? ]"
        },
        gender: {
          comment: "https://www.w3.org/TR/css3-speech/#voice-family",
          syntax: "male | female | neutral"
        },
        "general-enclosed": {
          comment: "remove ident-token, optional any-value, brackets (see https://drafts.csswg.org/mediaqueries-5/#typedef-general-enclosed)",
          syntax: "[ <function-token> <any-value>? ) ] | [ ( <any-value>? ) ]"
        },
        "generic-family": {
          comment: "new definition on font-4, https://drafts.csswg.org/css-fonts-4/#typedef-generic-family",
          syntax: "<generic-script-specific>| <generic-complete> | <generic-incomplete> | <-non-standard-generic-family>"
        },
        "generic-script-specific": {
          syntax: "generic(kai) | generic(fangsong) | generic(nastaliq)"
        },
        "-non-standard-generic-family": {
          syntax: "-apple-system | BlinkMacSystemFont",
          references: [
            "https://css-tricks.com/snippets/css/system-font-stack/",
            "https://webkit.org/blog/3709/using-the-system-font-in-web-content/"
          ]
        },
        gradient: {
          comment: "added legacy syntaxes support",
          syntax: "| <-legacy-gradient>"
        },
        "intrinsic-size-keyword": {
          comment: "Missing from mdn-data. 4.3. Intrinsic Size Keywords https://www.w3.org/TR/css-sizing-4/#intrinsic-size-keywords",
          syntax: "min-content | max-content | fit-content"
        },
        left: {
          comment: "missed; not sure we should add it, but no others except `shape` is using it so it's ok for now; https://drafts.fxtf.org/css-masking-1/#funcdef-clip-rect",
          syntax: "<length> | auto"
        },
        color: {
          comment: "css-color-5, added non standard color names",
          syntax: "<color-base> | currentColor | <system-color> | <device-cmyk()>  | <light-dark()> | <-non-standard-color>"
        },
        "device-cmyk()": {
          syntax: "<legacy-device-cmyk-syntax> | <modern-device-cmyk-syntax>"
        },
        "legacy-device-cmyk-syntax": {
          syntax: "device-cmyk( <number>#{4} )"
        },
        "modern-device-cmyk-syntax": {
          syntax: "device-cmyk( <cmyk-component>{4} [ / [ <alpha-value> | none ] ]? )"
        },
        "cmyk-component": {
          syntax: "<number> | <percentage> | none"
        },
        "color-mix()": {
          syntax: "color-mix( <color-interpolation-method> , [ <color> && <percentage [0,100]>? ]#{2} )"
        },
        "color-space": {
          syntax: "<rectangular-color-space> | <polar-color-space> | <custom-color-space>"
        },
        paint: {
          comment: "used by SVG https://www.w3.org/TR/SVG/painting.html#SpecifyingPaint",
          syntax: "none | <color> | <url> [ none | <color> ]? | context-fill | context-stroke"
        },
        right: {
          comment: "missed; not sure we should add it, but no others except `shape` is using it so it's ok for now; https://drafts.fxtf.org/css-masking-1/#funcdef-clip-rect",
          syntax: "<length> | auto"
        },
        shape: {
          comment: "missed spaces in function body and add backwards compatible syntax",
          syntax: "rect( <top>, <right>, <bottom>, <left> ) | rect( <top> <right> <bottom> <left> )"
        },
        "scope-start": {
          syntax: "<forgiving-selector-list>"
        },
        "scope-end": {
          syntax: "<forgiving-selector-list>"
        },
        "forgiving-selector-list": {
          syntax: "<complex-real-selector-list>"
        },
        "forgiving-relative-selector-list": {
          syntax: "<relative-real-selector-list>"
        },
        "complex-real-selector-list": {
          syntax: "<complex-real-selector>#"
        },
        "simple-selector-list": {
          syntax: "<simple-selector>#"
        },
        "relative-real-selector-list": {
          syntax: "<relative-real-selector>#"
        },
        "complex-selector": {
          syntax: "<complex-selector-unit> [ <combinator>? <complex-selector-unit> ]*"
        },
        "complex-selector-unit": {
          syntax: "[ <compound-selector>? <pseudo-compound-selector>* ]!"
        },
        "complex-real-selector": {
          syntax: "<compound-selector> [ <combinator>? <compound-selector> ]*"
        },
        "relative-real-selector": {
          syntax: "<combinator>? <complex-real-selector>"
        },
        "compound-selector": {
          syntax: "[ <type-selector>? <subclass-selector>* ]!"
        },
        "pseudo-compound-selector": {
          syntax: " <pseudo-element-selector> <pseudo-class-selector>*"
        },
        "simple-selector": {
          syntax: "<type-selector> | <subclass-selector>"
        },
        combinator: {
          syntax: "'>' | '+' | '~' | [ '|' '|' ]"
        },
        "pseudo-element-selector": {
          syntax: "':' <pseudo-class-selector> | <legacy-pseudo-element-selector>"
        },
        "legacy-pseudo-element-selector": {
          syntax: " ':' [before | after | first-line | first-letter]"
        },
        "svg-length": {
          comment: "All coordinates and lengths in SVG can be specified with or without a unit identifier",
          references: [
            "https://www.w3.org/TR/SVG11/coords.html#Units"
          ],
          syntax: "<percentage> | <length> | <number>"
        },
        "svg-writing-mode": {
          comment: "SVG specific keywords (deprecated for CSS)",
          references: [
            "https://developer.mozilla.org/en/docs/Web/CSS/writing-mode",
            "https://www.w3.org/TR/SVG/text.html#WritingModeProperty"
          ],
          syntax: "lr-tb | rl-tb | tb-rl | lr | rl | tb"
        },
        top: {
          comment: "missed; not sure we should add it, but no others except `shape` is using it so it's ok for now; https://drafts.fxtf.org/css-masking-1/#funcdef-clip-rect",
          syntax: "<length> | auto"
        },
        x: {
          comment: "missed; not sure we should add it, but no others except `cursor` is using it so it's ok for now; https://drafts.csswg.org/css-ui-3/#cursor",
          syntax: "<number>"
        },
        y: {
          comment: "missed; not sure we should add it, but no others except `cursor` is using so it's ok for now; https://drafts.csswg.org/css-ui-3/#cursor",
          syntax: "<number>"
        },
        declaration: {
          comment: "missed, restored by https://drafts.csswg.org/css-syntax",
          syntax: "<ident-token> : <declaration-value>? [ '!' important ]?"
        },
        "declaration-list": {
          comment: "missed, restored by https://drafts.csswg.org/css-syntax",
          syntax: "[ <declaration>? ';' ]* <declaration>?"
        },
        url: {
          comment: "https://drafts.csswg.org/css-values-4/#urls",
          syntax: "url( <string> <url-modifier>* ) | <url-token>"
        },
        "url-modifier": {
          comment: "https://drafts.csswg.org/css-values-4/#typedef-url-modifier",
          syntax: "<ident> | <function-token> <any-value> )"
        },
        "number-zero-one": {
          syntax: "<number [0,1]>"
        },
        "number-one-or-greater": {
          syntax: "<number [1,\u221E]>"
        },
        "color()": {
          syntax: "color( <colorspace-params> [ / [ <alpha-value> | none ] ]? )"
        },
        "colorspace-params": {
          syntax: "[ <predefined-rgb-params> | <xyz-params>]"
        },
        "xyz-params": {
          syntax: "<xyz-space> [ <number> | <percentage> | none ]{3}"
        },
        "xyz-space": {
          syntax: "xyz | xyz-d50 | xyz-d65"
        },
        "query-in-parens": {
          comment: "missed, https://drafts.csswg.org/css-contain-3/#container-rule",
          syntax: "( <container-condition> ) | ( <size-feature> ) | style( <style-query> ) | <general-enclosed>"
        },
        "size-feature": {
          comment: "missed, https://drafts.csswg.org/css-contain-3/#typedef-size-feature",
          syntax: "<mf-plain> | <mf-boolean> | <mf-range>"
        },
        "style-query": {
          comment: "missed, https://drafts.csswg.org/css-contain-3/#container-rule",
          syntax: "<style-condition> | <style-feature>"
        },
        "style-condition": {
          comment: "missed, https://drafts.csswg.org/css-contain-3/#container-rule",
          syntax: "not <style-in-parens> | <style-in-parens> [ [ and <style-in-parens> ]* | [ or <style-in-parens> ]* ]"
        },
        "style-in-parens": {
          comment: "missed, https://drafts.csswg.org/css-contain-3/#container-rule",
          syntax: "( <style-condition> ) | ( <style-feature> ) | <general-enclosed>"
        },
        "-non-standard-display": {
          syntax: "-ms-inline-flexbox | -ms-grid | -ms-inline-grid | -webkit-flex | -webkit-inline-flex | -webkit-box | -webkit-inline-box | -moz-inline-stack | -moz-box | -moz-inline-box"
        },
        "inset-area": {
          syntax: "[ [ left | center | right | span-left | span-right | x-start | x-end | span-x-start | span-x-end | x-self-start | x-self-end | span-x-self-start | span-x-self-end | span-all ] || [ top | center | bottom | span-top | span-bottom | y-start | y-end | span-y-start | span-y-end | y-self-start | y-self-end | span-y-self-start | span-y-self-end | span-all ] | [ block-start | center | block-end | span-block-start | span-block-end | span-all ] || [ inline-start | center | inline-end | span-inline-start | span-inline-end | span-all ] | [ self-block-start | self-block-end | span-self-block-start | span-self-block-end | span-all ] || [ self-inline-start | self-inline-end | span-self-inline-start | span-self-inline-end | span-all ] | [ start | center | end | span-start | span-end | span-all ]{1,2} | [ self-start | center | self-end | span-self-start | span-self-end | span-all ]{1,2} ]",
          comment: "initial name for <position-area> before renamed",
          references: [
            "https://www.w3.org/TR/css-anchor-position-1/#inset-area"
          ]
        },
        "position-area": {
          syntax: "[ [ left | center | right | span-left | span-right | x-start | x-end | span-x-start | span-x-end | x-self-start | x-self-end | span-x-self-start | span-x-self-end | span-all ] || [ top | center | bottom | span-top | span-bottom | y-start | y-end | span-y-start | span-y-end | y-self-start | y-self-end | span-y-self-start | span-y-self-end | span-all ] | [ block-start | center | block-end | span-block-start | span-block-end | span-all ] || [ inline-start | center | inline-end | span-inline-start | span-inline-end | span-all ] | [ self-block-start | center | self-block-end | span-self-block-start | span-self-block-end | span-all ] || [ self-inline-start | center | self-inline-end | span-self-inline-start | span-self-inline-end | span-all ] | [ start | center | end | span-start | span-end | span-all ]{1,2} | [ self-start | center | self-end | span-self-start | span-self-end | span-all ]{1,2} ]",
          comment: "replaced <inset-area>",
          references: [
            "https://drafts.csswg.org/css-anchor-position-1/#typedef-position-area"
          ]
        },
        syntax: {
          syntax: "'*' | <syntax-component> [ <syntax-combinator> <syntax-component> ]* | <syntax-string>"
        },
        "syntax-component": {
          syntax: "<syntax-single-component> <syntax-multiplier>? | '<' transform-list '>'"
        },
        "syntax-single-component": {
          syntax: "'<' <syntax-type-name> '>' | <ident>"
        },
        "syntax-type-name": {
          syntax: "angle | color | custom-ident | image | integer | length | length-percentage | number | percentage | resolution | string | time | url | transform-function"
        },
        "syntax-combinator": {
          syntax: "'|'"
        },
        "syntax-multiplier": {
          syntax: "'#' | '+'"
        },
        "syntax-string": {
          syntax: "<string>"
        }
      }
    };
  }
});

// node_modules/css-tree/cjs/data-patch.cjs
var require_data_patch = __commonJS({
  "node_modules/css-tree/cjs/data-patch.cjs"(exports2, module2) {
    "use strict";
    var patch = require_patch();
    var patch$1 = patch;
    module2.exports = patch$1;
  }
});

// node_modules/mdn-data/css/at-rules.json
var require_at_rules = __commonJS({
  "node_modules/mdn-data/css/at-rules.json"(exports2, module2) {
    module2.exports = {
      "@charset": {
        syntax: '@charset "<charset>";',
        groups: [
          "CSS Syntax"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@charset"
      },
      "@counter-style": {
        syntax: "@counter-style <counter-style-name> {\n  [ system: <counter-system>; ] ||\n  [ symbols: <counter-symbols>; ] ||\n  [ additive-symbols: <additive-symbols>; ] ||\n  [ negative: <negative-symbol>; ] ||\n  [ prefix: <prefix>; ] ||\n  [ suffix: <suffix>; ] ||\n  [ range: <range>; ] ||\n  [ pad: <padding>; ] ||\n  [ speak-as: <speak-as>; ] ||\n  [ fallback: <counter-style-name>; ]\n}",
        interfaces: [
          "CSSCounterStyleRule"
        ],
        groups: [
          "CSS Counter Styles"
        ],
        descriptors: {
          "additive-symbols": {
            syntax: "[ <integer [0,\u221E]> && <symbol> ]#",
            media: "all",
            initial: "n/a (required)",
            percentages: "no",
            computed: "asSpecified",
            order: "orderOfAppearance",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@counter-style/additive-symbols"
          },
          fallback: {
            syntax: "<counter-style-name>",
            media: "all",
            initial: "decimal",
            percentages: "no",
            computed: "asSpecified",
            order: "uniqueOrder",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@counter-style/fallback"
          },
          negative: {
            syntax: "<symbol> <symbol>?",
            media: "all",
            initial: '"-" hyphen-minus',
            percentages: "no",
            computed: "asSpecified",
            order: "orderOfAppearance",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@counter-style/negative"
          },
          pad: {
            syntax: "<integer [0,\u221E]> && <symbol>",
            media: "all",
            initial: '0 ""',
            percentages: "no",
            computed: "asSpecified",
            order: "uniqueOrder",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@counter-style/pad"
          },
          prefix: {
            syntax: "<symbol>",
            media: "all",
            initial: '""',
            percentages: "no",
            computed: "asSpecified",
            order: "uniqueOrder",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@counter-style/prefix"
          },
          range: {
            syntax: "[ [ <integer> | infinite ]{2} ]# | auto",
            media: "all",
            initial: "auto",
            percentages: "no",
            computed: "asSpecified",
            order: "orderOfAppearance",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@counter-style/range"
          },
          "speak-as": {
            syntax: "auto | bullets | numbers | words | spell-out | <counter-style-name>",
            media: "all",
            initial: "auto",
            percentages: "no",
            computed: "asSpecified",
            order: "uniqueOrder",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@counter-style/speak-as"
          },
          suffix: {
            syntax: "<symbol>",
            media: "all",
            initial: '". "',
            percentages: "no",
            computed: "asSpecified",
            order: "uniqueOrder",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@counter-style/suffix"
          },
          symbols: {
            syntax: "<symbol>+",
            media: "all",
            initial: "n/a (required)",
            percentages: "no",
            computed: "asSpecified",
            order: "orderOfAppearance",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@counter-style/symbols"
          },
          system: {
            syntax: "cyclic | numeric | alphabetic | symbolic | additive | [ fixed <integer>? ] | [ extends <counter-style-name> ]",
            media: "all",
            initial: "symbolic",
            percentages: "no",
            computed: "asSpecified",
            order: "uniqueOrder",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@counter-style/system"
          }
        },
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@counter-style"
      },
      "@container": {
        syntax: "@container <container-condition># {\n  <block-contents>\n}",
        interfaces: [
          "CSSContainerRule"
        ],
        groups: [
          "CSS Conditional Rules"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@container"
      },
      "@document": {
        syntax: "@document [ <url> | url-prefix(<string>) | domain(<string>) | media-document(<string>) | regexp(<string>) ]# {\n  <group-rule-body>\n}",
        interfaces: [
          "CSSDocumentRule"
        ],
        groups: [
          "CSS Conditional Rules"
        ],
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@document"
      },
      "@font-face": {
        syntax: "@font-face {\n  [ font-family: <family-name>; ] ||\n  [ src: <src>; ] ||\n  [ unicode-range: <unicode-range>; ] ||\n  [ font-variant: <font-variant>; ] ||\n  [ font-feature-settings: <font-feature-settings>; ] ||\n  [ font-variation-settings: <font-variation-settings>; ] ||\n  [ font-stretch: <font-stretch>; ] ||\n  [ font-weight: <font-weight>; ] ||\n  [ font-style: <font-style>; ] ||\n  [ size-adjust: <size-adjust>; ] ||\n  [ ascent-override: <ascent-override>; ] ||\n  [ descent-override: <descent-override>; ] ||\n  [ line-gap-override: <line-gap-override>; ]\n}",
        interfaces: [
          "CSSFontFaceRule"
        ],
        groups: [
          "CSS Fonts"
        ],
        descriptors: {
          "ascent-override": {
            syntax: "normal | <percentage>",
            media: "all",
            initial: "normal",
            percentages: "asSpecified",
            computed: "asSpecified",
            order: "orderOfAppearance",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-face/ascent-override"
          },
          "descent-override": {
            syntax: "normal | <percentage>",
            media: "all",
            initial: "normal",
            percentages: "asSpecified",
            computed: "asSpecified",
            order: "orderOfAppearance",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-face/descent-override"
          },
          "font-display": {
            syntax: "auto | block | swap | fallback | optional",
            media: "visual",
            percentages: "no",
            initial: "auto",
            computed: "asSpecified",
            order: "uniqueOrder",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-face/font-display"
          },
          "font-family": {
            syntax: "<family-name>",
            media: "all",
            initial: "n/a (required)",
            percentages: "no",
            computed: "asSpecified",
            order: "uniqueOrder",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-face/font-family"
          },
          "font-feature-settings": {
            syntax: "normal | <feature-tag-value>#",
            media: "all",
            initial: "normal",
            percentages: "no",
            computed: "asSpecified",
            order: "orderOfAppearance",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-face/font-feature-settings"
          },
          "font-stretch": {
            syntax: "<font-stretch-absolute>{1,2}",
            media: "all",
            initial: "normal",
            percentages: "no",
            computed: "asSpecified",
            order: "uniqueOrder",
            status: "obsolete",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-face/font-stretch"
          },
          "font-style": {
            syntax: "normal | italic | oblique <angle>{0,2}",
            media: "all",
            initial: "normal",
            percentages: "no",
            computed: "asSpecified",
            order: "uniqueOrder",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-face/font-style"
          },
          "font-variation-settings": {
            syntax: "normal | [ <string> <number> ]#",
            media: "all",
            initial: "normal",
            percentages: "no",
            computed: "asSpecified",
            order: "orderOfAppearance",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-face/font-variation-settings"
          },
          "font-weight": {
            syntax: "<font-weight-absolute>{1,2}",
            media: "all",
            initial: "normal",
            percentages: "no",
            computed: "asSpecified",
            order: "uniqueOrder",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-face/font-weight"
          },
          "line-gap-override": {
            syntax: "normal | <percentage>",
            media: "all",
            initial: "normal",
            percentages: "asSpecified",
            computed: "asSpecified",
            order: "orderOfAppearance",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-face/line-gap-override"
          },
          "size-adjust": {
            syntax: "<percentage>",
            media: "all",
            initial: "100%",
            percentages: "asSpecified",
            computed: "asSpecified",
            order: "orderOfAppearance",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-face/size-adjust"
          },
          src: {
            syntax: "[ <url> [ format( <string># ) ]? | local( <family-name> ) ]#",
            media: "all",
            initial: "n/a (required)",
            percentages: "no",
            computed: "asSpecified",
            order: "orderOfAppearance",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-face/src"
          },
          "unicode-range": {
            syntax: "<unicode-range-token>#",
            media: "all",
            initial: "U+0-10FFFF",
            percentages: "no",
            computed: "asSpecified",
            order: "orderOfAppearance",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-face/unicode-range"
          }
        },
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-face"
      },
      "@font-feature-values": {
        syntax: "@font-feature-values <family-name># {\n  <feature-value-block-list>\n}",
        interfaces: [
          "CSSFontFeatureValuesRule"
        ],
        groups: [
          "CSS Fonts"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-feature-values"
      },
      "@font-palette-values": {
        syntax: "@font-palette-values <dashed-ident> {\n  <declaration-list>\n}",
        interfaces: [
          "CSSFontPaletteValuesRule"
        ],
        groups: [
          "CSS Fonts"
        ],
        descriptors: {
          "base-palette": {
            syntax: "light | dark | <integer [0,\u221E]>",
            media: "all",
            initial: "n/a (required)",
            percentages: "no",
            computed: "asSpecified",
            order: "uniqueOrder",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-palette-values/base-palette"
          },
          "font-family": {
            syntax: "<family-name>#",
            media: "all",
            initial: "n/a (required)",
            percentages: "no",
            computed: "asSpecified",
            order: "orderOfAppearance",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-palette-values/font-family"
          },
          "override-colors": {
            syntax: "[ <integer [0,\u221E]> <color> ]#",
            media: "all",
            initial: "n/a (required)",
            percentages: "no",
            computed: "asSpecified",
            order: "orderOfAppearance",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-palette-values/override-colors"
          }
        },
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@font-palette-values"
      },
      "@import": {
        syntax: "@import [ <string> | <url> ]\n        [ layer | layer(<layer-name>) ]?\n        [ supports( [ <supports-condition> | <declaration> ] ) ]?\n        <media-query-list>? ;",
        interfaces: [
          "CSSImportRule"
        ],
        groups: [
          "CSS Cascading and Inheritance"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@import"
      },
      "@keyframes": {
        syntax: "@keyframes <keyframes-name> {\n  <qualified-rule-list>\n}",
        interfaces: [
          "CSSKeyframeRule",
          "CSSKeyframesRule"
        ],
        groups: [
          "CSS Animations"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@keyframes"
      },
      "@layer": {
        syntax: "@layer [ <layer-name># | <layer-name>?  {\n  <stylesheet>\n} ]",
        interfaces: [
          "CSSLayerBlockRule",
          "CSSLayerStatementRule"
        ],
        groups: [
          "CSS Cascading and Inheritance"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@layer"
      },
      "@media": {
        syntax: "@media <media-query-list> {\n  <group-rule-body>\n}",
        interfaces: [
          "CSSMediaRule"
        ],
        groups: [
          "CSS Conditional Rules",
          "Media Queries"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@media"
      },
      "@namespace": {
        syntax: "@namespace <namespace-prefix>? [ <string> | <url> ];",
        interfaces: [
          "CSSNamespaceRule"
        ],
        groups: [
          "CSS Namespaces"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@namespace"
      },
      "@page": {
        syntax: "@page <page-selector-list> {\n  <page-body>\n}",
        interfaces: [
          "CSSPageRule"
        ],
        groups: [
          "CSS Paged Media"
        ],
        descriptors: {
          bleed: {
            syntax: "auto | <length>",
            media: [
              "visual",
              "paged"
            ],
            initial: "auto",
            percentages: "no",
            computed: "asSpecified",
            order: "uniqueOrder",
            status: "standard"
          },
          marks: {
            syntax: "none | [ crop || cross ]",
            media: [
              "visual",
              "paged"
            ],
            initial: "none",
            percentages: "no",
            computed: "asSpecified",
            order: "orderOfAppearance",
            status: "standard"
          },
          "page-orientation": {
            syntax: "upright | rotate-left | rotate-right",
            media: [
              "visual",
              "paged"
            ],
            initial: "upright",
            percentages: "no",
            computed: "asSpecified",
            order: "orderOfAppearance",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@page/page-orientation"
          },
          size: {
            syntax: "<length [0,\u221E]>{1,2} | auto | [ <page-size> || [ portrait | landscape ] ]",
            media: [
              "visual",
              "paged"
            ],
            initial: "auto",
            percentages: "no",
            computed: "asSpecifiedRelativeToAbsoluteLengths",
            order: "orderOfAppearance",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@page/size"
          }
        },
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@page"
      },
      "@position-try": {
        syntax: "@position-try <dashed-ident> {\n  <declaration-list>\n}",
        interfaces: [
          "CSSPositionTryRule"
        ],
        groups: [
          "CSS Anchor Positioning"
        ],
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@position-try"
      },
      "@property": {
        syntax: "@property <custom-property-name> {\n  <declaration-list>\n}",
        interfaces: [
          "CSSPropertyRule"
        ],
        groups: [
          "CSS Houdini"
        ],
        descriptors: {
          inherits: {
            syntax: "true | false",
            media: "all",
            percentages: "no",
            initial: "auto",
            computed: "asSpecified",
            order: "uniqueOrder",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@property/inherits"
          },
          "initial-value": {
            syntax: "<declaration-value>?",
            media: "all",
            initial: "n/a (required)",
            percentages: "no",
            computed: "asSpecified",
            order: "uniqueOrder",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@property/initial-value"
          },
          syntax: {
            syntax: "<string>",
            media: "all",
            percentages: "no",
            initial: "n/a (required)",
            computed: "asSpecified",
            order: "uniqueOrder",
            status: "standard",
            mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@property/syntax"
          }
        },
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@property"
      },
      "@scope": {
        syntax: "@scope [(<scope-start>)]? [to (<scope-end>)]? {\n  <rule-list>\n}",
        interfaces: [
          "CSSScopeRule"
        ],
        groups: [
          "CSS Conditional Rules"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@scope"
      },
      "@starting-style": {
        syntax: "@starting-style {\n  <declaration-list> | <group-rule-body>\n}",
        interfaces: [
          "CSSStartingStyleRule"
        ],
        groups: [
          "CSS Transitions"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@starting-style"
      },
      "@supports": {
        syntax: "@supports <supports-condition> {\n  <group-rule-body>\n}",
        interfaces: [
          "CSSSupportsRule"
        ],
        groups: [
          "CSS Conditional Rules"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@supports"
      },
      "@view-transition": {
        syntax: "@view-transition {\n  <declaration-list>\n}",
        interfaces: [
          "CSSViewTransitionRule"
        ],
        groups: [
          "CSS View Transitions"
        ],
        descriptors: {
          navigation: {
            syntax: "auto | none",
            media: "all",
            initial: "none",
            percentages: "no",
            computed: "asSpecified",
            order: "uniqueOrder",
            status: "standard"
          },
          types: {
            syntax: "none | <custom-ident>+",
            media: "all",
            initial: "none",
            percentages: "no",
            computed: "asSpecified",
            order: "uniqueOrder",
            status: "standard"
          }
        },
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/@view-transition"
      }
    };
  }
});

// node_modules/mdn-data/css/properties.json
var require_properties = __commonJS({
  "node_modules/mdn-data/css/properties.json"(exports2, module2) {
    module2.exports = {
      "--*": {
        syntax: "<declaration-value>",
        media: "all",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Custom Properties for Cascading Variables"
        ],
        initial: "seeProse",
        appliesto: "allElements",
        computed: "asSpecifiedWithVarsSubstituted",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/--*"
      },
      "-ms-accelerator": {
        syntax: "false | true",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "false",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-block-progression": {
        syntax: "tb | rl | bt | lr",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "tb",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-content-zoom-chaining": {
        syntax: "none | chained",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "none",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-content-zoom-limit": {
        syntax: "<'-ms-content-zoom-limit-min'> <'-ms-content-zoom-limit-max'>",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: [
          "-ms-content-zoom-limit-max",
          "-ms-content-zoom-limit-min"
        ],
        groups: [
          "Microsoft Extensions"
        ],
        initial: [
          "-ms-content-zoom-limit-max",
          "-ms-content-zoom-limit-min"
        ],
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: [
          "-ms-content-zoom-limit-max",
          "-ms-content-zoom-limit-min"
        ],
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-content-zoom-limit-max": {
        syntax: "<percentage>",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "maxZoomFactor",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "400%",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-content-zoom-limit-min": {
        syntax: "<percentage>",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "minZoomFactor",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "100%",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-content-zoom-snap": {
        syntax: "<'-ms-content-zoom-snap-type'> || <'-ms-content-zoom-snap-points'>",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: [
          "-ms-content-zoom-snap-type",
          "-ms-content-zoom-snap-points"
        ],
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: [
          "-ms-content-zoom-snap-type",
          "-ms-content-zoom-snap-points"
        ],
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-content-zoom-snap-points": {
        syntax: "snapInterval( <percentage>, <percentage> ) | snapList( <percentage># )",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "snapInterval(0%, 100%)",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-content-zoom-snap-type": {
        syntax: "none | proximity | mandatory",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "none",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-content-zooming": {
        syntax: "none | zoom",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "zoomForTheTopLevelNoneForTheRest",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-filter": {
        syntax: "<string>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: '""',
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-flow-from": {
        syntax: "[ none | <custom-ident> ]#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "none",
        appliesto: "nonReplacedElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-flow-into": {
        syntax: "[ none | <custom-ident> ]#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "none",
        appliesto: "iframeElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-grid-columns": {
        syntax: "none | <track-list> | <auto-track-list>",
        media: "visual",
        inherited: false,
        animationType: "simpleListOfLpcDifferenceLpc",
        percentages: "referToDimensionOfContentArea",
        groups: [
          "CSS Grid Layout"
        ],
        initial: "none",
        appliesto: "gridContainers",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-grid-rows": {
        syntax: "none | <track-list> | <auto-track-list>",
        media: "visual",
        inherited: false,
        animationType: "simpleListOfLpcDifferenceLpc",
        percentages: "referToDimensionOfContentArea",
        groups: [
          "CSS Grid Layout"
        ],
        initial: "none",
        appliesto: "gridContainers",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-high-contrast-adjust": {
        syntax: "auto | none",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-hyphenate-limit-chars": {
        syntax: "auto | <integer>{1,3}",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-hyphenate-limit-lines": {
        syntax: "no-limit | <integer>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "no-limit",
        appliesto: "blockContainerElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-hyphenate-limit-zone": {
        syntax: "<percentage> | <length>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "referToLineBoxWidth",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "0",
        appliesto: "blockContainerElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-ime-align": {
        syntax: "auto | after",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-overflow-style": {
        syntax: "auto | none | scrollbar | -ms-autohiding-scrollbar",
        media: "interactive",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "auto",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scroll-chaining": {
        syntax: "chained | none",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "chained",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scroll-limit": {
        syntax: "<'-ms-scroll-limit-x-min'> <'-ms-scroll-limit-y-min'> <'-ms-scroll-limit-x-max'> <'-ms-scroll-limit-y-max'>",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: [
          "-ms-scroll-limit-x-min",
          "-ms-scroll-limit-y-min",
          "-ms-scroll-limit-x-max",
          "-ms-scroll-limit-y-max"
        ],
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: [
          "-ms-scroll-limit-x-min",
          "-ms-scroll-limit-y-min",
          "-ms-scroll-limit-x-max",
          "-ms-scroll-limit-y-max"
        ],
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scroll-limit-x-max": {
        syntax: "auto | <length>",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "auto",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scroll-limit-x-min": {
        syntax: "<length>",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "0",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scroll-limit-y-max": {
        syntax: "auto | <length>",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "auto",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scroll-limit-y-min": {
        syntax: "<length>",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "0",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scroll-rails": {
        syntax: "none | railed",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "railed",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scroll-snap-points-x": {
        syntax: "snapInterval( <length-percentage>, <length-percentage> ) | snapList( <length-percentage># )",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "snapInterval(0px, 100%)",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scroll-snap-points-y": {
        syntax: "snapInterval( <length-percentage>, <length-percentage> ) | snapList( <length-percentage># )",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "snapInterval(0px, 100%)",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scroll-snap-type": {
        syntax: "none | proximity | mandatory",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "none",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scroll-snap-x": {
        syntax: "<'-ms-scroll-snap-type'> <'-ms-scroll-snap-points-x'>",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: [
          "-ms-scroll-snap-type",
          "-ms-scroll-snap-points-x"
        ],
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: [
          "-ms-scroll-snap-type",
          "-ms-scroll-snap-points-x"
        ],
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scroll-snap-y": {
        syntax: "<'-ms-scroll-snap-type'> <'-ms-scroll-snap-points-y'>",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: [
          "-ms-scroll-snap-type",
          "-ms-scroll-snap-points-y"
        ],
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: [
          "-ms-scroll-snap-type",
          "-ms-scroll-snap-points-y"
        ],
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scroll-translation": {
        syntax: "none | vertical-to-horizontal",
        media: "interactive",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scrollbar-3dlight-color": {
        syntax: "<color>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "dependsOnUserAgent",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scrollbar-arrow-color": {
        syntax: "<color>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "ButtonText",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scrollbar-base-color": {
        syntax: "<color>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "dependsOnUserAgent",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scrollbar-darkshadow-color": {
        syntax: "<color>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "ThreeDDarkShadow",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scrollbar-face-color": {
        syntax: "<color>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "ThreeDFace",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scrollbar-highlight-color": {
        syntax: "<color>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "ThreeDHighlight",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scrollbar-shadow-color": {
        syntax: "<color>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "ThreeDDarkShadow",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-scrollbar-track-color": {
        syntax: "<color>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "Scrollbar",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-text-autospace": {
        syntax: "none | ideograph-alpha | ideograph-numeric | ideograph-parenthesis | ideograph-space",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-touch-select": {
        syntax: "grippers | none",
        media: "interactive",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "grippers",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-user-select": {
        syntax: "none | element | text",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "text",
        appliesto: "nonReplacedElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-wrap-flow": {
        syntax: "auto | both | start | end | maximum | clear",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "auto",
        appliesto: "blockLevelElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-wrap-margin": {
        syntax: "<length>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "0",
        appliesto: "exclusionElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-ms-wrap-through": {
        syntax: "wrap | none",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Microsoft Extensions"
        ],
        initial: "wrap",
        appliesto: "blockLevelElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-moz-appearance": {
        syntax: "none | button | button-arrow-down | button-arrow-next | button-arrow-previous | button-arrow-up | button-bevel | button-focus | caret | checkbox | checkbox-container | checkbox-label | checkmenuitem | dualbutton | groupbox | listbox | listitem | menuarrow | menubar | menucheckbox | menuimage | menuitem | menuitemtext | menulist | menulist-button | menulist-text | menulist-textfield | menupopup | menuradio | menuseparator | meterbar | meterchunk | progressbar | progressbar-vertical | progresschunk | progresschunk-vertical | radio | radio-container | radio-label | radiomenuitem | range | range-thumb | resizer | resizerpanel | scale-horizontal | scalethumbend | scalethumb-horizontal | scalethumbstart | scalethumbtick | scalethumb-vertical | scale-vertical | scrollbarbutton-down | scrollbarbutton-left | scrollbarbutton-right | scrollbarbutton-up | scrollbarthumb-horizontal | scrollbarthumb-vertical | scrollbartrack-horizontal | scrollbartrack-vertical | searchfield | separator | sheet | spinner | spinner-downbutton | spinner-textfield | spinner-upbutton | splitter | statusbar | statusbarpanel | tab | tabpanel | tabpanels | tab-scroll-arrow-back | tab-scroll-arrow-forward | textfield | textfield-multiline | toolbar | toolbarbutton | toolbarbutton-dropdown | toolbargripper | toolbox | tooltip | treeheader | treeheadercell | treeheadersortarrow | treeitem | treeline | treetwisty | treetwistyopen | treeview | -moz-mac-unified-toolbar | -moz-win-borderless-glass | -moz-win-browsertabbar-toolbox | -moz-win-communicationstext | -moz-win-communications-toolbox | -moz-win-exclude-glass | -moz-win-glass | -moz-win-mediatext | -moz-win-media-toolbox | -moz-window-button-box | -moz-window-button-box-maximized | -moz-window-button-close | -moz-window-button-maximize | -moz-window-button-minimize | -moz-window-button-restore | -moz-window-frame-bottom | -moz-window-frame-left | -moz-window-frame-right | -moz-window-titlebar | -moz-window-titlebar-maximized",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions",
          "WebKit Extensions"
        ],
        initial: "noneButOverriddenInUserAgentCSS",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/appearance"
      },
      "-moz-binding": {
        syntax: "<url> | none",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "none",
        appliesto: "allElementsExceptGeneratedContentOrPseudoElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-moz-border-bottom-colors": {
        syntax: "<color>+ | none",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-moz-border-left-colors": {
        syntax: "<color>+ | none",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-moz-border-right-colors": {
        syntax: "<color>+ | none",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-moz-border-top-colors": {
        syntax: "<color>+ | none",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-moz-context-properties": {
        syntax: "none | [ fill | fill-opacity | stroke | stroke-opacity ]#",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "none",
        appliesto: "allElementsThatCanReferenceImages",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-moz-float-edge": {
        syntax: "border-box | content-box | margin-box | padding-box",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "content-box",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-moz-float-edge"
      },
      "-moz-force-broken-image-icon": {
        syntax: "0 | 1",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "0",
        appliesto: "images",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-moz-force-broken-image-icon"
      },
      "-moz-orient": {
        syntax: "inline | block | horizontal | vertical",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "inline",
        appliesto: "anyElementEffectOnProgressAndMeter",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-moz-orient"
      },
      "-moz-outline-radius": {
        syntax: "<outline-radius>{1,4} [ / <outline-radius>{1,4} ]?",
        media: "visual",
        inherited: false,
        animationType: [
          "-moz-outline-radius-topleft",
          "-moz-outline-radius-topright",
          "-moz-outline-radius-bottomright",
          "-moz-outline-radius-bottomleft"
        ],
        percentages: [
          "-moz-outline-radius-topleft",
          "-moz-outline-radius-topright",
          "-moz-outline-radius-bottomright",
          "-moz-outline-radius-bottomleft"
        ],
        groups: [
          "Mozilla Extensions"
        ],
        initial: [
          "-moz-outline-radius-topleft",
          "-moz-outline-radius-topright",
          "-moz-outline-radius-bottomright",
          "-moz-outline-radius-bottomleft"
        ],
        appliesto: "allElements",
        computed: [
          "-moz-outline-radius-topleft",
          "-moz-outline-radius-topright",
          "-moz-outline-radius-bottomright",
          "-moz-outline-radius-bottomleft"
        ],
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-moz-outline-radius-bottomleft": {
        syntax: "<outline-radius>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToDimensionOfBorderBox",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "0",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-moz-outline-radius-bottomright": {
        syntax: "<outline-radius>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToDimensionOfBorderBox",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "0",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-moz-outline-radius-topleft": {
        syntax: "<outline-radius>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToDimensionOfBorderBox",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "0",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-moz-outline-radius-topright": {
        syntax: "<outline-radius>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToDimensionOfBorderBox",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "0",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-moz-stack-sizing": {
        syntax: "ignore | stretch-to-fit",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "stretch-to-fit",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-moz-text-blink": {
        syntax: "none | blink",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-moz-user-focus": {
        syntax: "ignore | normal | select-after | select-before | select-menu | select-same | select-all | none",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-moz-user-focus"
      },
      "-moz-user-input": {
        syntax: "auto | none | enabled | disabled",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-moz-user-input"
      },
      "-moz-user-modify": {
        syntax: "read-only | read-write | write-only",
        media: "interactive",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "read-only",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/user-modify"
      },
      "-moz-window-dragging": {
        syntax: "drag | no-drag",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "drag",
        appliesto: "allElementsCreatingNativeWindows",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-moz-window-shadow": {
        syntax: "default | menu | tooltip | sheet | none",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "default",
        appliesto: "allElementsCreatingNativeWindows",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-webkit-appearance": {
        syntax: "none | button | button-bevel | caret | checkbox | default-button | inner-spin-button | listbox | listitem | media-controls-background | media-controls-fullscreen-background | media-current-time-display | media-enter-fullscreen-button | media-exit-fullscreen-button | media-fullscreen-button | media-mute-button | media-overlay-play-button | media-play-button | media-seek-back-button | media-seek-forward-button | media-slider | media-sliderthumb | media-time-remaining-display | media-toggle-closed-captions-button | media-volume-slider | media-volume-slider-container | media-volume-sliderthumb | menulist | menulist-button | menulist-text | menulist-textfield | meter | progress-bar | progress-bar-value | push-button | radio | searchfield | searchfield-cancel-button | searchfield-decoration | searchfield-results-button | searchfield-results-decoration | slider-horizontal | slider-vertical | sliderthumb-horizontal | sliderthumb-vertical | square-button | textarea | textfield | -apple-pay-button",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "noneButOverriddenInUserAgentCSS",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/appearance"
      },
      "-webkit-border-before": {
        syntax: "<'border-width'> || <'border-style'> || <color>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: [
          "-webkit-border-before-width"
        ],
        groups: [
          "WebKit Extensions"
        ],
        initial: [
          "border-width",
          "border-style",
          "color"
        ],
        appliesto: "allElements",
        computed: [
          "border-width",
          "border-style",
          "color"
        ],
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-webkit-border-before"
      },
      "-webkit-border-before-color": {
        syntax: "<color>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "currentcolor",
        appliesto: "allElements",
        computed: "computedColor",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-webkit-border-before-style": {
        syntax: "<'border-style'>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-webkit-border-before-width": {
        syntax: "<'border-width'>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "logicalWidthOfContainingBlock",
        groups: [
          "WebKit Extensions"
        ],
        initial: "medium",
        appliesto: "allElements",
        computed: "absoluteLengthZeroIfBorderStyleNoneOrHidden",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-webkit-box-reflect": {
        syntax: "[ above | below | right | left ]? <length>? <image>?",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-webkit-box-reflect"
      },
      "-webkit-line-clamp": {
        syntax: "none | <integer>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "WebKit Extensions",
          "CSS Overflow"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-webkit-line-clamp"
      },
      "-webkit-mask": {
        syntax: "[ <mask-reference> || <position> [ / <bg-size> ]? || <repeat-style> || [ <visual-box> | border | padding | content | text ] || [ <visual-box> | border | padding | content ] ]#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: [
          "-webkit-mask-image",
          "-webkit-mask-repeat",
          "-webkit-mask-attachment",
          "-webkit-mask-position",
          "-webkit-mask-origin",
          "-webkit-mask-clip"
        ],
        appliesto: "allElements",
        computed: [
          "-webkit-mask-image",
          "-webkit-mask-repeat",
          "-webkit-mask-attachment",
          "-webkit-mask-position",
          "-webkit-mask-origin",
          "-webkit-mask-clip"
        ],
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask"
      },
      "-webkit-mask-attachment": {
        syntax: "<attachment>#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "scroll",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "orderOfAppearance",
        status: "nonstandard"
      },
      "-webkit-mask-clip": {
        syntax: "[ <coord-box> | no-clip | border | padding | content | text ]#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "border",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "orderOfAppearance",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-clip"
      },
      "-webkit-mask-composite": {
        syntax: "<composite-style>#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "source-over",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "orderOfAppearance",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-webkit-mask-composite"
      },
      "-webkit-mask-image": {
        syntax: "<mask-reference>#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "absoluteURIOrNone",
        order: "orderOfAppearance",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-image"
      },
      "-webkit-mask-origin": {
        syntax: "[ <coord-box> | border | padding | content ]#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "padding",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "orderOfAppearance",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-origin"
      },
      "-webkit-mask-position": {
        syntax: "<position>#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "referToSizeOfElement",
        groups: [
          "WebKit Extensions"
        ],
        initial: "0% 0%",
        appliesto: "allElements",
        computed: "absoluteLengthOrPercentage",
        order: "orderOfAppearance",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-position"
      },
      "-webkit-mask-position-x": {
        syntax: "[ <length-percentage> | left | center | right ]#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "referToSizeOfElement",
        groups: [
          "WebKit Extensions"
        ],
        initial: "0%",
        appliesto: "allElements",
        computed: "absoluteLengthOrPercentage",
        order: "orderOfAppearance",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-webkit-mask-position-x"
      },
      "-webkit-mask-position-y": {
        syntax: "[ <length-percentage> | top | center | bottom ]#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "referToSizeOfElement",
        groups: [
          "WebKit Extensions"
        ],
        initial: "0%",
        appliesto: "allElements",
        computed: "absoluteLengthOrPercentage",
        order: "orderOfAppearance",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-webkit-mask-position-y"
      },
      "-webkit-mask-repeat": {
        syntax: "<repeat-style>#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "repeat",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "orderOfAppearance",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-repeat"
      },
      "-webkit-mask-repeat-x": {
        syntax: "repeat | no-repeat | space | round",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "repeat",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "orderOfAppearance",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-webkit-mask-repeat-x"
      },
      "-webkit-mask-repeat-y": {
        syntax: "repeat | no-repeat | space | round",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "repeat",
        appliesto: "allElements",
        computed: "absoluteLengthOrPercentage",
        order: "orderOfAppearance",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-webkit-mask-repeat-y"
      },
      "-webkit-mask-size": {
        syntax: "<bg-size>#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "relativeToBackgroundPositioningArea",
        groups: [
          "WebKit Extensions"
        ],
        initial: "auto auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "orderOfAppearance",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-size"
      },
      "-webkit-overflow-scrolling": {
        syntax: "auto | touch",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "auto",
        appliesto: "scrollingBoxes",
        computed: "asSpecified",
        order: "orderOfAppearance",
        status: "nonstandard"
      },
      "-webkit-tap-highlight-color": {
        syntax: "<color>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "black",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-webkit-tap-highlight-color"
      },
      "-webkit-text-fill-color": {
        syntax: "<color>",
        media: "visual",
        inherited: true,
        animationType: "color",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "currentcolor",
        appliesto: "allElements",
        computed: "computedColor",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-webkit-text-fill-color"
      },
      "-webkit-text-stroke": {
        syntax: "<length> || <color>",
        media: "visual",
        inherited: true,
        animationType: [
          "-webkit-text-stroke-width",
          "-webkit-text-stroke-color"
        ],
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: [
          "-webkit-text-stroke-width",
          "-webkit-text-stroke-color"
        ],
        appliesto: "allElements",
        computed: [
          "-webkit-text-stroke-width",
          "-webkit-text-stroke-color"
        ],
        order: "canonicalOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-webkit-text-stroke"
      },
      "-webkit-text-stroke-color": {
        syntax: "<color>",
        media: "visual",
        inherited: true,
        animationType: "color",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "currentcolor",
        appliesto: "allElements",
        computed: "computedColor",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-webkit-text-stroke-color"
      },
      "-webkit-text-stroke-width": {
        syntax: "<length>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "0",
        appliesto: "allElements",
        computed: "absoluteLength",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-webkit-text-stroke-width"
      },
      "-webkit-touch-callout": {
        syntax: "default | none",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "default",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/-webkit-touch-callout"
      },
      "-webkit-user-modify": {
        syntax: "read-only | read-write | read-write-plaintext-only",
        media: "interactive",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "read-only",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "-webkit-user-select": {
        syntax: "auto | text | none | all",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "WebKit Extensions"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/user-select"
      },
      "accent-color": {
        syntax: "auto | <color>",
        media: "interactive",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asAutoOrColor",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/accent-color"
      },
      "align-content": {
        syntax: "normal | <baseline-position> | <content-distribution> | <overflow-position>? <content-position>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Box Alignment",
          "CSS Flexible Box Layout"
        ],
        initial: "normal",
        appliesto: "blockContainersMultiColumnContainersFlexContainersGridContainers",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/align-content"
      },
      "align-items": {
        syntax: "normal | stretch | <baseline-position> | [ <overflow-position>? <self-position> ] | anchor-center",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Box Alignment",
          "CSS Flexible Box Layout"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/align-items"
      },
      "align-self": {
        syntax: "auto | normal | stretch | <baseline-position> | <overflow-position>? <self-position> | anchor-center",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Box Alignment",
          "CSS Flexible Box Layout"
        ],
        initial: "auto",
        appliesto: "flexItemsGridItemsAndAbsolutelyPositionedBoxes",
        computed: "autoOnAbsolutelyPositionedElementsValueOfAlignItemsOnParent",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/align-self"
      },
      "align-tracks": {
        syntax: "[ normal | <baseline-position> | <content-distribution> | <overflow-position>? <content-position> ]#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Grid Layout"
        ],
        initial: "normal",
        appliesto: "gridContainersWithMasonryLayoutInTheirBlockAxis",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "alignment-baseline": {
        syntax: "baseline | alphabetic | ideographic | middle | central | mathematical | text-before-edge | text-after-edge",
        media: "none",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Inline"
        ],
        initial: "baseline",
        appliesto: "inlineLevelBoxesFlexItemsGridItemsTableCellsAndSVGTextContentElements",
        computed: "theSpecifiedKeyword",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/alignment-baseline"
      },
      all: {
        syntax: "initial | inherit | unset | revert | revert-layer",
        media: "noPracticalMedia",
        inherited: false,
        animationType: "eachOfShorthandPropertiesExceptUnicodeBiDiAndDirection",
        percentages: "no",
        groups: [
          "CSS Cascading and Inheritance"
        ],
        initial: "noPracticalInitialValue",
        appliesto: "allElements",
        computed: "asSpecifiedAppliesToEachProperty",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/all"
      },
      "anchor-name": {
        syntax: "none | <dashed-ident>#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Anchor Positioning"
        ],
        initial: "none",
        appliesto: "allElementsThatGenerateAPrincipalBox",
        computed: "asSpecified",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/anchor-name"
      },
      "anchor-scope": {
        syntax: "none | all | <dashed-ident>#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Anchor Positioning"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "experimental"
      },
      animation: {
        syntax: "<single-animation>#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Animations"
        ],
        initial: [
          "animation-name",
          "animation-duration",
          "animation-timing-function",
          "animation-delay",
          "animation-iteration-count",
          "animation-direction",
          "animation-fill-mode",
          "animation-play-state",
          "animation-timeline"
        ],
        appliesto: "allElements",
        computed: [
          "animation-name",
          "animation-duration",
          "animation-timing-function",
          "animation-delay",
          "animation-direction",
          "animation-iteration-count",
          "animation-fill-mode",
          "animation-play-state",
          "animation-timeline"
        ],
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/animation"
      },
      "animation-composition": {
        syntax: "<single-animation-composition>#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Animations"
        ],
        initial: "replace",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/animation-composition"
      },
      "animation-delay": {
        syntax: "<time>#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Animations"
        ],
        initial: "0s",
        appliesto: "allElementsAndPseudos",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/animation-delay"
      },
      "animation-direction": {
        syntax: "<single-animation-direction>#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Animations"
        ],
        initial: "normal",
        appliesto: "allElementsAndPseudos",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/animation-direction"
      },
      "animation-duration": {
        syntax: "[ auto | <time [0s,\u221E]> ]#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Animations"
        ],
        initial: "0s",
        appliesto: "allElementsAndPseudos",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/animation-duration"
      },
      "animation-fill-mode": {
        syntax: "<single-animation-fill-mode>#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Animations"
        ],
        initial: "none",
        appliesto: "allElementsAndPseudos",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/animation-fill-mode"
      },
      "animation-iteration-count": {
        syntax: "<single-animation-iteration-count>#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Animations"
        ],
        initial: "1",
        appliesto: "allElementsAndPseudos",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/animation-iteration-count"
      },
      "animation-name": {
        syntax: "[ none | <keyframes-name> ]#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Animations"
        ],
        initial: "none",
        appliesto: "allElementsAndPseudos",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/animation-name"
      },
      "animation-play-state": {
        syntax: "<single-animation-play-state>#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Animations"
        ],
        initial: "running",
        appliesto: "allElementsAndPseudos",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/animation-play-state"
      },
      "animation-range": {
        syntax: "[ <'animation-range-start'> <'animation-range-end'>? ]#",
        media: "visual",
        inherited: false,
        animationType: [
          "animation-range-start",
          "animation-range-end"
        ],
        percentages: "relativeToTimelineRangeIfSpecifiedOtherwiseEntireTimeline",
        groups: [
          "Scroll-driven Animations"
        ],
        initial: [
          "animation-range-start",
          "animation-range-end"
        ],
        appliesto: "allElements",
        computed: [
          "animation-range-start",
          "animation-range-end"
        ],
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/animation-range"
      },
      "animation-range-end": {
        syntax: "[ normal | <length-percentage> | <timeline-range-name> <length-percentage>? ]#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "relativeToTimelineRangeIfSpecifiedOtherwiseEntireTimeline",
        groups: [
          "Scroll-driven Animations"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "listEachItemConsistingOfNormalLengthPercentageOrNameLengthPercentage",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/animation-range-end"
      },
      "animation-range-start": {
        syntax: "[ normal | <length-percentage> | <timeline-range-name> <length-percentage>? ]#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "relativeToTimelineRangeIfSpecifiedOtherwiseEntireTimeline",
        groups: [
          "Scroll-driven Animations"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "listEachItemConsistingOfNormalLengthPercentageOrNameLengthPercentage",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/animation-range-start"
      },
      "animation-timeline": {
        syntax: "<single-animation-timeline>#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Animations"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "listEachItemIdentifierOrNoneAuto",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/animation-timeline"
      },
      "animation-timing-function": {
        syntax: "<easing-function>#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Animations"
        ],
        initial: "ease",
        appliesto: "allElementsAndPseudos",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/animation-timing-function"
      },
      "animation-trigger": {
        syntax: "[ none | [ <dashed-ident> <animation-action>+ ]+ ]#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Animations"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/Reference/Properties/animation-trigger"
      },
      appearance: {
        syntax: "none | auto | <compat-auto> | <compat-special>",
        media: "all",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/appearance"
      },
      "aspect-ratio": {
        syntax: "auto || <ratio>",
        media: "all",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Box Sizing"
        ],
        initial: "auto",
        appliesto: "allElementsExceptInlineBoxesAndInternalRubyOrTableBoxes",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/aspect-ratio"
      },
      "backdrop-filter": {
        syntax: "none | <filter-value-list>",
        media: "visual",
        inherited: false,
        animationType: "filterList",
        percentages: "no",
        groups: [
          "Filter Effects"
        ],
        initial: "none",
        appliesto: "allElementsSVGContainerElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/backdrop-filter"
      },
      "backface-visibility": {
        syntax: "visible | hidden",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Transforms"
        ],
        initial: "visible",
        appliesto: "transformableElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/backface-visibility"
      },
      background: {
        syntax: "<bg-layer>#? , <final-bg-layer>",
        media: "visual",
        inherited: false,
        animationType: [
          "background-color",
          "background-image",
          "background-clip",
          "background-position",
          "background-size",
          "background-repeat",
          "background-attachment"
        ],
        percentages: [
          "background-position",
          "background-size"
        ],
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "background-image",
          "background-position",
          "background-size",
          "background-repeat",
          "background-origin",
          "background-clip",
          "background-attachment",
          "background-color"
        ],
        appliesto: "allElements",
        computed: [
          "background-image",
          "background-position",
          "background-size",
          "background-repeat",
          "background-origin",
          "background-clip",
          "background-attachment",
          "background-color"
        ],
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/background"
      },
      "background-attachment": {
        syntax: "<attachment>#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "scroll",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/background-attachment"
      },
      "background-blend-mode": {
        syntax: "<blend-mode>#",
        media: "none",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "Compositing and Blending"
        ],
        initial: "normal",
        appliesto: "allElementsSVGContainerGraphicsAndGraphicsReferencingElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/background-blend-mode"
      },
      "background-clip": {
        syntax: "<bg-clip>#",
        media: "visual",
        inherited: false,
        animationType: "repeatableList",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "border-box",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/background-clip"
      },
      "background-color": {
        syntax: "<color>",
        media: "visual",
        inherited: false,
        animationType: "color",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "transparent",
        appliesto: "allElements",
        computed: "computedColor",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/background-color"
      },
      "background-image": {
        syntax: "<bg-image>#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecifiedURLsAbsolute",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/background-image"
      },
      "background-origin": {
        syntax: "<visual-box>#",
        media: "visual",
        inherited: false,
        animationType: "repeatableList",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "padding-box",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/background-origin"
      },
      "background-position": {
        syntax: "<bg-position>#",
        media: "visual",
        inherited: false,
        animationType: "repeatableList",
        percentages: "referToSizeOfBackgroundPositioningAreaMinusBackgroundImageSize",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "0% 0%",
        appliesto: "allElements",
        computed: [
          "background-position-x",
          "background-position-y"
        ],
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/background-position"
      },
      "background-position-x": {
        syntax: "[ center | [ [ left | right | x-start | x-end ]? <length-percentage>? ]! ]#",
        media: "visual",
        inherited: false,
        animationType: "repeatableList",
        percentages: "referToWidthOfBackgroundPositioningAreaMinusBackgroundImageWidth",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "0%",
        appliesto: "allElements",
        computed: "listEachItemConsistingOfAbsoluteLengthPercentageAndOrigin",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/background-position-x"
      },
      "background-position-y": {
        syntax: "[ center | [ [ top | bottom | y-start | y-end ]? <length-percentage>? ]! ]#",
        media: "visual",
        inherited: false,
        animationType: "repeatableList",
        percentages: "referToHeightOfBackgroundPositioningAreaMinusBackgroundImageHeight",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "0%",
        appliesto: "allElements",
        computed: "listEachItemConsistingOfAbsoluteLengthPercentageAndOrigin",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/background-position-y"
      },
      "background-repeat": {
        syntax: "<repeat-style>#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "repeat",
        appliesto: "allElements",
        computed: "listEachItemHasTwoKeywordsOnePerDimension",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/background-repeat"
      },
      "background-size": {
        syntax: "<bg-size>#",
        media: "visual",
        inherited: false,
        animationType: "repeatableList",
        percentages: "relativeToBackgroundPositioningArea",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "auto auto",
        appliesto: "allElements",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/background-size"
      },
      "baseline-shift": {
        syntax: "<length-percentage> | sub | super | baseline",
        media: "none",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "referToTheUsedValueOfLineHeight",
        groups: [
          "CSS Inline"
        ],
        initial: "0",
        appliesto: "inlineLevelBoxesAndSVGTextContentElements",
        computed: "theSpecifiedKeywordOrAComputedLengthPercentageValue",
        order: "perGrammar",
        status: "standard"
      },
      "baseline-source": {
        syntax: "auto | first | last",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Inline"
        ],
        initial: "auto",
        appliesto: "inlineLevelBoxes",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/baseline-source"
      },
      "block-size": {
        syntax: "<'width'>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "blockSizeOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "auto",
        appliesto: "sameAsWidthAndHeight",
        computed: "sameAsWidthAndHeight",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/block-size"
      },
      border: {
        syntax: "<line-width> || <line-style> || <color>",
        media: "visual",
        inherited: false,
        animationType: [
          "border-width",
          "border-style",
          "border-color"
        ],
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "border-width",
          "border-style",
          "border-color"
        ],
        appliesto: "allElements",
        computed: [
          "border-width",
          "border-style",
          "border-color"
        ],
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border"
      },
      "border-block": {
        syntax: "<'border-block-start'>",
        media: "visual",
        inherited: false,
        animationType: [
          "border-block-width",
          "border-block-style",
          "border-block-color"
        ],
        percentages: "no",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: [
          "border-block-width",
          "border-block-style",
          "border-block-color"
        ],
        appliesto: "allElements",
        computed: [
          "border-block-width",
          "border-block-style",
          "border-block-color"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-block"
      },
      "border-block-color": {
        syntax: "<'border-top-color'>{1,2}",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "currentcolor",
        appliesto: "allElements",
        computed: "computedColor",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-block-color"
      },
      "border-block-end": {
        syntax: "<'border-top-width'> || <'border-top-style'> || <color>",
        media: "visual",
        inherited: false,
        animationType: [
          "border-block-end-color",
          "border-block-end-style",
          "border-block-end-width"
        ],
        percentages: "no",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: [
          "border-top-width",
          "border-top-style",
          "border-top-color"
        ],
        appliesto: "allElements",
        computed: [
          "border-top-width",
          "border-top-style",
          "border-top-color"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-block-end"
      },
      "border-block-end-color": {
        syntax: "<'border-top-color'>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "currentcolor",
        appliesto: "allElements",
        computed: "computedColor",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-block-end-color"
      },
      "border-block-end-style": {
        syntax: "<'border-top-style'>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-block-end-style"
      },
      "border-block-end-width": {
        syntax: "<'border-top-width'>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "logicalWidthOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "medium",
        appliesto: "allElements",
        computed: "absoluteLengthZeroIfBorderStyleNoneOrHidden",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-block-end-width"
      },
      "border-block-start": {
        syntax: "<'border-top-width'> || <'border-top-style'> || <color>",
        media: "visual",
        inherited: false,
        animationType: [
          "border-block-start-color",
          "border-block-start-style",
          "border-block-start-width"
        ],
        percentages: "no",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: [
          "border-width",
          "border-style",
          "color"
        ],
        appliesto: "allElements",
        computed: [
          "border-width",
          "border-style",
          "border-block-start-color"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-block-start"
      },
      "border-block-start-color": {
        syntax: "<'border-top-color'>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "currentcolor",
        appliesto: "allElements",
        computed: "computedColor",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-block-start-color"
      },
      "border-block-start-style": {
        syntax: "<'border-top-style'>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-block-start-style"
      },
      "border-block-start-width": {
        syntax: "<'border-top-width'>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "logicalWidthOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "medium",
        appliesto: "allElements",
        computed: "absoluteLengthZeroIfBorderStyleNoneOrHidden",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-block-start-width"
      },
      "border-block-style": {
        syntax: "<'border-top-style'>{1,2}",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-block-style"
      },
      "border-block-width": {
        syntax: "<'border-top-width'>{1,2}",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "logicalWidthOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "medium",
        appliesto: "allElements",
        computed: "absoluteLengthZeroIfBorderStyleNoneOrHidden",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-block-width"
      },
      "border-bottom": {
        syntax: "<line-width> || <line-style> || <color>",
        media: "visual",
        inherited: false,
        animationType: [
          "border-bottom-color",
          "border-bottom-style",
          "border-bottom-width"
        ],
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "border-bottom-width",
          "border-bottom-style",
          "border-bottom-color"
        ],
        appliesto: "allElements",
        computed: [
          "border-bottom-width",
          "border-bottom-style",
          "border-bottom-color"
        ],
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-bottom"
      },
      "border-bottom-color": {
        syntax: "<'border-top-color'>",
        media: "visual",
        inherited: false,
        animationType: "color",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "currentcolor",
        appliesto: "allElements",
        computed: "computedColor",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-bottom-color"
      },
      "border-bottom-left-radius": {
        syntax: "<length-percentage [0,\u221E]>{1,2}",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToDimensionOfBorderBox",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "0",
        appliesto: "allElementsUAsNotRequiredWhenCollapse",
        computed: "twoAbsoluteLengthOrPercentages",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-bottom-left-radius"
      },
      "border-bottom-right-radius": {
        syntax: "<length-percentage [0,\u221E]>{1,2}",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToDimensionOfBorderBox",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "0",
        appliesto: "allElementsUAsNotRequiredWhenCollapse",
        computed: "twoAbsoluteLengthOrPercentages",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-bottom-right-radius"
      },
      "border-bottom-style": {
        syntax: "<line-style>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-bottom-style"
      },
      "border-bottom-width": {
        syntax: "<line-width>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "medium",
        appliesto: "allElements",
        computed: "absoluteLengthOr0IfBorderBottomStyleNoneOrHidden",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-bottom-width"
      },
      "border-collapse": {
        syntax: "separate | collapse",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Table"
        ],
        initial: "separate",
        appliesto: "tableElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-collapse"
      },
      "border-color": {
        syntax: "<color>{1,4}",
        media: "visual",
        inherited: false,
        animationType: [
          "border-bottom-color",
          "border-left-color",
          "border-right-color",
          "border-top-color"
        ],
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "border-top-color",
          "border-right-color",
          "border-bottom-color",
          "border-left-color"
        ],
        appliesto: "allElements",
        computed: [
          "border-bottom-color",
          "border-left-color",
          "border-right-color",
          "border-top-color"
        ],
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-color"
      },
      "border-end-end-radius": {
        syntax: "<'border-top-left-radius'>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToDimensionOfBorderBox",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "0",
        appliesto: "allElementsUAsNotRequiredWhenCollapse",
        computed: "twoAbsoluteLengthOrPercentages",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-end-end-radius"
      },
      "border-end-start-radius": {
        syntax: "<'border-top-left-radius'>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToDimensionOfBorderBox",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "0",
        appliesto: "allElementsUAsNotRequiredWhenCollapse",
        computed: "twoAbsoluteLengthOrPercentages",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-end-start-radius"
      },
      "border-image": {
        syntax: "<'border-image-source'> || <'border-image-slice'> [ / <'border-image-width'> | / <'border-image-width'>? / <'border-image-outset'> ]? || <'border-image-repeat'>",
        media: "visual",
        inherited: false,
        animationType: [
          "border-image-outset",
          "border-image-repeat",
          "border-image-slice",
          "border-image-source",
          "border-image-width"
        ],
        percentages: [
          "border-image-slice",
          "border-image-width"
        ],
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "border-image-source",
          "border-image-slice",
          "border-image-width",
          "border-image-outset",
          "border-image-repeat"
        ],
        appliesto: "allElementsExceptTableElementsWhenCollapse",
        computed: [
          "border-image-outset",
          "border-image-repeat",
          "border-image-slice",
          "border-image-source",
          "border-image-width"
        ],
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-image"
      },
      "border-image-outset": {
        syntax: "[ <length [0,\u221E]> | <number [0,\u221E]> ]{1,4}",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "0",
        appliesto: "allElementsExceptTableElementsWhenCollapse",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-image-outset"
      },
      "border-image-repeat": {
        syntax: "[ stretch | repeat | round | space ]{1,2}",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "stretch",
        appliesto: "allElementsExceptTableElementsWhenCollapse",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-image-repeat"
      },
      "border-image-slice": {
        syntax: "[ <number [0,\u221E]> | <percentage [0,\u221E]> ]{1,4} && fill?",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "referToSizeOfBorderImage",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "100%",
        appliesto: "allElementsExceptTableElementsWhenCollapse",
        computed: "oneToFourPercentagesOrAbsoluteLengthsPlusFill",
        order: "percentagesOrLengthsFollowedByFill",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-image-slice"
      },
      "border-image-source": {
        syntax: "none | <image>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "none",
        appliesto: "allElementsExceptTableElementsWhenCollapse",
        computed: "noneOrImageWithAbsoluteURI",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-image-source"
      },
      "border-image-width": {
        syntax: "[ <length-percentage [0,\u221E]> | <number [0,\u221E]> | auto ]{1,4}",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "referToWidthOrHeightOfBorderImageArea",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "1",
        appliesto: "allElementsExceptTableElementsWhenCollapse",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-image-width"
      },
      "border-inline": {
        syntax: "<'border-block-start'>",
        media: "visual",
        inherited: false,
        animationType: [
          "border-inline-color",
          "border-inline-style",
          "border-inline-width"
        ],
        percentages: "no",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: [
          "border-inline-width",
          "border-inline-style",
          "border-inline-color"
        ],
        appliesto: "allElements",
        computed: [
          "border-inline-width",
          "border-inline-style",
          "border-inline-color"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-inline"
      },
      "border-inline-color": {
        syntax: "<'border-top-color'>{1,2}",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "currentcolor",
        appliesto: "allElements",
        computed: "computedColor",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-inline-color"
      },
      "border-inline-end": {
        syntax: "<'border-top-width'> || <'border-top-style'> || <color>",
        media: "visual",
        inherited: false,
        animationType: [
          "border-inline-end-color",
          "border-inline-end-style",
          "border-inline-end-width"
        ],
        percentages: "no",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: [
          "border-width",
          "border-style",
          "color"
        ],
        appliesto: "allElements",
        computed: [
          "border-width",
          "border-style",
          "border-inline-end-color"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-inline-end"
      },
      "border-inline-end-color": {
        syntax: "<'border-top-color'>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "currentcolor",
        appliesto: "allElements",
        computed: "computedColor",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-inline-end-color"
      },
      "border-inline-end-style": {
        syntax: "<'border-top-style'>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-inline-end-style"
      },
      "border-inline-end-width": {
        syntax: "<'border-top-width'>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "logicalWidthOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "medium",
        appliesto: "allElements",
        computed: "absoluteLengthZeroIfBorderStyleNoneOrHidden",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-inline-end-width"
      },
      "border-inline-start": {
        syntax: "<'border-top-width'> || <'border-top-style'> || <color>",
        media: "visual",
        inherited: false,
        animationType: [
          "border-inline-start-color",
          "border-inline-start-style",
          "border-inline-start-width"
        ],
        percentages: "no",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: [
          "border-width",
          "border-style",
          "color"
        ],
        appliesto: "allElements",
        computed: [
          "border-width",
          "border-style",
          "border-inline-start-color"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-inline-start"
      },
      "border-inline-start-color": {
        syntax: "<'border-top-color'>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "currentcolor",
        appliesto: "allElements",
        computed: "computedColor",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-inline-start-color"
      },
      "border-inline-start-style": {
        syntax: "<'border-top-style'>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-inline-start-style"
      },
      "border-inline-start-width": {
        syntax: "<'border-top-width'>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "logicalWidthOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "medium",
        appliesto: "allElements",
        computed: "absoluteLengthZeroIfBorderStyleNoneOrHidden",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-inline-start-width"
      },
      "border-inline-style": {
        syntax: "<'border-top-style'>{1,2}",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-inline-style"
      },
      "border-inline-width": {
        syntax: "<'border-top-width'>{1,2}",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "logicalWidthOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "medium",
        appliesto: "allElements",
        computed: "absoluteLengthZeroIfBorderStyleNoneOrHidden",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-inline-width"
      },
      "border-left": {
        syntax: "<line-width> || <line-style> || <color>",
        media: "visual",
        inherited: false,
        animationType: [
          "border-left-color",
          "border-left-style",
          "border-left-width"
        ],
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "border-left-width",
          "border-left-style",
          "border-left-color"
        ],
        appliesto: "allElements",
        computed: [
          "border-left-width",
          "border-left-style",
          "border-left-color"
        ],
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-left"
      },
      "border-left-color": {
        syntax: "<color>",
        media: "visual",
        inherited: false,
        animationType: "color",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "currentcolor",
        appliesto: "allElements",
        computed: "computedColor",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-left-color"
      },
      "border-left-style": {
        syntax: "<line-style>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-left-style"
      },
      "border-left-width": {
        syntax: "<line-width>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "medium",
        appliesto: "allElements",
        computed: "absoluteLengthOr0IfBorderLeftStyleNoneOrHidden",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-left-width"
      },
      "border-radius": {
        syntax: "<length-percentage [0,\u221E]>{1,4} [ / <length-percentage [0,\u221E]>{1,4} ]?",
        media: "visual",
        inherited: false,
        animationType: [
          "border-top-left-radius",
          "border-top-right-radius",
          "border-bottom-right-radius",
          "border-bottom-left-radius"
        ],
        percentages: "referToDimensionOfBorderBox",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "border-top-left-radius",
          "border-top-right-radius",
          "border-bottom-right-radius",
          "border-bottom-left-radius"
        ],
        appliesto: "allElementsUAsNotRequiredWhenCollapse",
        computed: [
          "border-bottom-left-radius",
          "border-bottom-right-radius",
          "border-top-left-radius",
          "border-top-right-radius"
        ],
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-radius"
      },
      "border-right": {
        syntax: "<line-width> || <line-style> || <color>",
        media: "visual",
        inherited: false,
        animationType: [
          "border-right-color",
          "border-right-style",
          "border-right-width"
        ],
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "border-right-width",
          "border-right-style",
          "border-right-color"
        ],
        appliesto: "allElements",
        computed: [
          "border-right-width",
          "border-right-style",
          "border-right-color"
        ],
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-right"
      },
      "border-right-color": {
        syntax: "<color>",
        media: "visual",
        inherited: false,
        animationType: "color",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "currentcolor",
        appliesto: "allElements",
        computed: "computedColor",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-right-color"
      },
      "border-right-style": {
        syntax: "<line-style>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-right-style"
      },
      "border-right-width": {
        syntax: "<line-width>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "medium",
        appliesto: "allElements",
        computed: "absoluteLengthOr0IfBorderRightStyleNoneOrHidden",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-right-width"
      },
      "border-spacing": {
        syntax: "<length>{1,2}",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Table"
        ],
        initial: "0",
        appliesto: "tableElements",
        computed: "twoAbsoluteLengths",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-spacing"
      },
      "border-start-end-radius": {
        syntax: "<'border-top-left-radius'>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToDimensionOfBorderBox",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "0",
        appliesto: "allElementsUAsNotRequiredWhenCollapse",
        computed: "twoAbsoluteLengthOrPercentages",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-start-end-radius"
      },
      "border-start-start-radius": {
        syntax: "<'border-top-left-radius'>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToDimensionOfBorderBox",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "0",
        appliesto: "allElementsUAsNotRequiredWhenCollapse",
        computed: "twoAbsoluteLengthOrPercentages",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-start-start-radius"
      },
      "border-style": {
        syntax: "<line-style>{1,4}",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "border-top-style",
          "border-right-style",
          "border-bottom-style",
          "border-left-style"
        ],
        appliesto: "allElements",
        computed: [
          "border-bottom-style",
          "border-left-style",
          "border-right-style",
          "border-top-style"
        ],
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-style"
      },
      "border-top": {
        syntax: "<line-width> || <line-style> || <color>",
        media: "visual",
        inherited: false,
        animationType: [
          "border-top-color",
          "border-top-style",
          "border-top-width"
        ],
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "border-top-width",
          "border-top-style",
          "border-top-color"
        ],
        appliesto: "allElements",
        computed: [
          "border-top-width",
          "border-top-style",
          "border-top-color"
        ],
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-top"
      },
      "border-top-color": {
        syntax: "<color>",
        media: "visual",
        inherited: false,
        animationType: "color",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "currentcolor",
        appliesto: "allElements",
        computed: "computedColor",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-top-color"
      },
      "border-top-left-radius": {
        syntax: "<length-percentage [0,\u221E]>{1,2}",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToDimensionOfBorderBox",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "0",
        appliesto: "allElementsUAsNotRequiredWhenCollapse",
        computed: "twoAbsoluteLengthOrPercentages",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-top-left-radius"
      },
      "border-top-right-radius": {
        syntax: "<length-percentage [0,\u221E]>{1,2}",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToDimensionOfBorderBox",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "0",
        appliesto: "allElementsUAsNotRequiredWhenCollapse",
        computed: "twoAbsoluteLengthOrPercentages",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-top-right-radius"
      },
      "border-top-style": {
        syntax: "<line-style>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-top-style"
      },
      "border-top-width": {
        syntax: "<line-width>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "medium",
        appliesto: "allElements",
        computed: "absoluteLengthOr0IfBorderTopStyleNoneOrHidden",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-top-width"
      },
      "border-width": {
        syntax: "<line-width>{1,4}",
        media: "visual",
        inherited: false,
        animationType: [
          "border-bottom-width",
          "border-left-width",
          "border-right-width",
          "border-top-width"
        ],
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "border-top-width",
          "border-right-width",
          "border-bottom-width",
          "border-left-width"
        ],
        appliesto: "allElements",
        computed: [
          "border-bottom-width",
          "border-left-width",
          "border-right-width",
          "border-top-width"
        ],
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/border-width"
      },
      bottom: {
        syntax: "auto | <length-percentage> | <anchor()> | <anchor-size()>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToContainingBlockHeight",
        groups: [
          "CSS Anchor Positioning",
          "CSS Positioned Layout"
        ],
        initial: "auto",
        appliesto: "positionedElements",
        computed: "lengthAbsolutePercentageAsSpecifiedOtherwiseAuto",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/bottom"
      },
      "box-align": {
        syntax: "start | center | end | baseline | stretch",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions",
          "WebKit Extensions"
        ],
        initial: "stretch",
        appliesto: "elementsWithDisplayBoxOrInlineBox",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/box-align"
      },
      "box-decoration-break": {
        syntax: "slice | clone",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fragmentation"
        ],
        initial: "slice",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/box-decoration-break"
      },
      "box-direction": {
        syntax: "normal | reverse | inherit",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions",
          "WebKit Extensions"
        ],
        initial: "normal",
        appliesto: "elementsWithDisplayBoxOrInlineBox",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/box-direction"
      },
      "box-flex": {
        syntax: "<number>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions",
          "WebKit Extensions"
        ],
        initial: "0",
        appliesto: "directChildrenOfElementsWithDisplayMozBoxMozInlineBox",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/box-flex"
      },
      "box-flex-group": {
        syntax: "<integer>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions",
          "WebKit Extensions"
        ],
        initial: "1",
        appliesto: "inFlowChildrenOfBoxElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/box-flex-group"
      },
      "box-lines": {
        syntax: "single | multiple",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions",
          "WebKit Extensions"
        ],
        initial: "single",
        appliesto: "boxElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/box-lines"
      },
      "box-ordinal-group": {
        syntax: "<integer>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions",
          "WebKit Extensions"
        ],
        initial: "1",
        appliesto: "childrenOfBoxElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/box-ordinal-group"
      },
      "box-orient": {
        syntax: "horizontal | vertical | inline-axis | block-axis | inherit",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions",
          "WebKit Extensions"
        ],
        initial: "inline-axis",
        appliesto: "elementsWithDisplayBoxOrInlineBox",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/box-orient"
      },
      "box-pack": {
        syntax: "start | center | end | justify",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions",
          "WebKit Extensions"
        ],
        initial: "start",
        appliesto: "elementsWithDisplayMozBoxMozInlineBox",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/box-pack"
      },
      "box-shadow": {
        syntax: "none | <shadow>#",
        media: "visual",
        inherited: false,
        animationType: "shadowList",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "absoluteLengthsSpecifiedColorAsSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/box-shadow"
      },
      "box-sizing": {
        syntax: "content-box | border-box",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Box Sizing"
        ],
        initial: "content-box",
        appliesto: "allElementsAcceptingWidthOrHeight",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/box-sizing"
      },
      "break-after": {
        syntax: "auto | avoid | always | all | avoid-page | page | left | right | recto | verso | avoid-column | column | avoid-region | region",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fragmentation"
        ],
        initial: "auto",
        appliesto: "blockLevelElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/break-after"
      },
      "break-before": {
        syntax: "auto | avoid | always | all | avoid-page | page | left | right | recto | verso | avoid-column | column | avoid-region | region",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fragmentation"
        ],
        initial: "auto",
        appliesto: "blockLevelElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/break-before"
      },
      "break-inside": {
        syntax: "auto | avoid | avoid-page | avoid-column | avoid-region",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fragmentation"
        ],
        initial: "auto",
        appliesto: "blockLevelElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/break-inside"
      },
      "caption-side": {
        syntax: "top | bottom",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Table"
        ],
        initial: "top",
        appliesto: "tableCaptionElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/caption-side"
      },
      caret: {
        syntax: "<'caret-color'> || <'caret-animation'> || <'caret-shape'>",
        media: "interactive",
        inherited: true,
        animationType: [
          "caret-color",
          "caret-animation",
          "caret-shape"
        ],
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: [
          "caret-color",
          "caret-animation",
          "caret-shape"
        ],
        appliesto: "textOrElementsThatAcceptInput",
        computed: [
          "caret-color",
          "caret-animation",
          "caret-shape"
        ],
        order: "perGrammar",
        status: "standard"
      },
      "caret-animation": {
        syntax: "auto | manual",
        media: "interactive",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: "auto",
        appliesto: "textOrElementsThatAcceptInput",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/caret-animation"
      },
      "caret-color": {
        syntax: "auto | <color>",
        media: "interactive",
        inherited: true,
        animationType: "color",
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: "auto",
        appliesto: "textOrElementsThatAcceptInput",
        computed: "asAutoOrColor",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/caret-color"
      },
      "caret-shape": {
        syntax: "auto | bar | block | underscore",
        media: "interactive",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: "auto",
        appliesto: "textOrElementsThatAcceptInput",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard"
      },
      clear: {
        syntax: "none | left | right | both | inline-start | inline-end",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Positioned Layout"
        ],
        initial: "none",
        appliesto: "blockLevelElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/clear"
      },
      clip: {
        syntax: "<shape> | auto",
        media: "visual",
        inherited: false,
        animationType: "rectangle",
        percentages: "no",
        groups: [
          "CSS Masking"
        ],
        initial: "auto",
        appliesto: "absolutelyPositionedElements",
        computed: "autoOrRectangle",
        order: "uniqueOrder",
        status: "obsolete",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/clip"
      },
      "clip-path": {
        syntax: "<clip-source> | [ <basic-shape> || <geometry-box> ] | none",
        media: "visual",
        inherited: false,
        animationType: "basicShapeOtherwiseNo",
        percentages: "referToReferenceBoxWhenSpecifiedOtherwiseBorderBox",
        groups: [
          "CSS Masking"
        ],
        initial: "none",
        appliesto: "allElementsSVGContainerElements",
        computed: "asSpecifiedURLsAbsolute",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/clip-path"
      },
      "clip-rule": {
        syntax: "nonzero | evenodd",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Masking"
        ],
        initial: "nonzero",
        appliesto: "limitedSVGElementsGraphics",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/clip-rule"
      },
      color: {
        syntax: "<color>",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Color"
        ],
        initial: "canvastext",
        appliesto: "allElementsAndText",
        computed: "computedColor",
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/color"
      },
      "color-interpolation-filters": {
        syntax: "auto | sRGB | linearRGB",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Filter Effects"
        ],
        initial: "linearRGB",
        appliesto: "limitedSVGElementsFilterPrimitives",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/color-interpolation-filters"
      },
      "color-scheme": {
        syntax: "normal | [ light | dark | <custom-ident> ]+ && only?",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Color"
        ],
        initial: "normal",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/color-scheme"
      },
      "column-count": {
        syntax: "<integer> | auto",
        media: "visual",
        inherited: false,
        animationType: "integer",
        percentages: "no",
        groups: [
          "CSS Multi-column Layout"
        ],
        initial: "auto",
        appliesto: "blockContainersExceptTableWrappers",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/column-count"
      },
      "column-fill": {
        syntax: "auto | balance",
        media: "visualInContinuousMediaNoEffectInOverflowColumns",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Multi-column Layout"
        ],
        initial: "balance",
        appliesto: "multicolElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/column-fill"
      },
      "column-gap": {
        syntax: "normal | <length-percentage>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToDimensionOfContentArea",
        groups: [
          "CSS Box Alignment",
          "CSS Multi-column Layout"
        ],
        initial: "normal",
        appliesto: "multiColumnElementsFlexContainersGridContainers",
        computed: "asSpecifiedWithLengthsAbsoluteAndNormalComputingToZeroExceptMultiColumn",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/column-gap"
      },
      "column-height": {
        syntax: "auto | <length [0,\u221E]>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Box Sizing",
          "CSS Multi-column Layout"
        ],
        initial: "auto",
        appliesto: "blockContainersExceptTableWrappers",
        computed: "autoOrAbsoluteLength",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/column-height"
      },
      "column-rule": {
        syntax: "<'column-rule-width'> || <'column-rule-style'> || <'column-rule-color'>",
        media: "visual",
        inherited: false,
        animationType: [
          "column-rule-color",
          "column-rule-style",
          "column-rule-width"
        ],
        percentages: "no",
        groups: [
          "CSS Multi-column Layout"
        ],
        initial: [
          "column-rule-width",
          "column-rule-style",
          "column-rule-color"
        ],
        appliesto: "multicolElements",
        computed: [
          "column-rule-color",
          "column-rule-style",
          "column-rule-width"
        ],
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/column-rule"
      },
      "column-rule-color": {
        syntax: "<color>",
        media: "visual",
        inherited: false,
        animationType: "color",
        percentages: "no",
        groups: [
          "CSS Multi-column Layout"
        ],
        initial: "currentcolor",
        appliesto: "multicolElements",
        computed: "computedColor",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/column-rule-color"
      },
      "column-rule-style": {
        syntax: "<'border-style'>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Multi-column Layout"
        ],
        initial: "none",
        appliesto: "multicolElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/column-rule-style"
      },
      "column-rule-width": {
        syntax: "<'border-width'>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "no",
        groups: [
          "CSS Multi-column Layout"
        ],
        initial: "medium",
        appliesto: "multicolElements",
        computed: "absoluteLength0IfColumnRuleStyleNoneOrHidden",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/column-rule-width"
      },
      "column-span": {
        syntax: "none | all",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Multi-column Layout"
        ],
        initial: "none",
        appliesto: "inFlowBlockLevelElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/column-span"
      },
      "column-width": {
        syntax: "auto | <length [0,\u221E]>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Box Sizing",
          "CSS Multi-column Layout"
        ],
        initial: "auto",
        appliesto: "blockContainersExceptTableWrappers",
        computed: "autoOrAbsoluteLength",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/column-width"
      },
      "column-wrap": {
        syntax: "auto | nowrap | wrap",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Box Sizing",
          "CSS Multi-column Layout"
        ],
        initial: "auto",
        appliesto: "multicolElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/column-wrap"
      },
      columns: {
        syntax: "[ <'column-width'> || <'column-count'> ] [ / <'column-height'> ]?",
        media: "visual",
        inherited: false,
        animationType: [
          "column-width",
          "column-count",
          "column-height"
        ],
        percentages: "no",
        groups: [
          "CSS Multi-column Layout"
        ],
        initial: [
          "column-width",
          "column-count",
          "column-height"
        ],
        appliesto: "blockContainersExceptTableWrappers",
        computed: [
          "column-width",
          "column-count",
          "column-height"
        ],
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/columns"
      },
      contain: {
        syntax: "none | strict | content | [ [ size || inline-size ] || layout || style || paint ]",
        media: "all",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Containment"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/contain"
      },
      "contain-intrinsic-block-size": {
        syntax: "auto? [ none | <length> ]",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Box Sizing"
        ],
        initial: "none",
        appliesto: "elementsForWhichSizeContainmentCanApply",
        computed: "asSpecifiedWithLengthValuesComputed",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/contain-intrinsic-block-size"
      },
      "contain-intrinsic-height": {
        syntax: "auto? [ none | <length> ]",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Box Sizing"
        ],
        initial: "none",
        appliesto: "elementsForWhichSizeContainmentCanApply",
        computed: "asSpecifiedWithLengthValuesComputed",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/contain-intrinsic-height"
      },
      "contain-intrinsic-inline-size": {
        syntax: "auto? [ none | <length> ]",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Box Sizing"
        ],
        initial: "none",
        appliesto: "elementsForWhichSizeContainmentCanApply",
        computed: "asSpecifiedWithLengthValuesComputed",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/contain-intrinsic-inline-size"
      },
      "contain-intrinsic-size": {
        syntax: "[ auto? [ none | <length> ] ]{1,2}",
        media: "visual",
        inherited: false,
        animationType: [
          "contain-intrinsic-width",
          "contain-intrinsic-height"
        ],
        percentages: [
          "contain-intrinsic-width",
          "contain-intrinsic-height"
        ],
        groups: [
          "CSS Box Sizing"
        ],
        initial: [
          "contain-intrinsic-width",
          "contain-intrinsic-height"
        ],
        appliesto: "elementsForWhichSizeContainmentCanApply",
        computed: [
          "contain-intrinsic-width",
          "contain-intrinsic-height"
        ],
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/contain-intrinsic-size"
      },
      "contain-intrinsic-width": {
        syntax: "auto? [ none | <length> ]",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Box Sizing"
        ],
        initial: "none",
        appliesto: "elementsForWhichSizeContainmentCanApply",
        computed: "asSpecifiedWithLengthValuesComputed",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/contain-intrinsic-width"
      },
      container: {
        syntax: "<'container-name'> [ / <'container-type'> ]?",
        media: "visual",
        inherited: false,
        animationType: [
          "container-name",
          "container-type"
        ],
        percentages: [
          "container-name",
          "container-type"
        ],
        groups: [
          "CSS Conditional Rules"
        ],
        initial: [
          "container-name",
          "container-type"
        ],
        appliesto: "allElements",
        computed: [
          "container-name",
          "container-type"
        ],
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/container"
      },
      "container-name": {
        syntax: "none | <custom-ident>+",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Conditional Rules"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "noneOrOrderedListOfIdentifiers",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/container-name"
      },
      "container-type": {
        syntax: "normal | [ [ size | inline-size ] || scroll-state ]",
        media: "visual",
        inherited: false,
        animationType: "color",
        percentages: "no",
        groups: [
          "CSS Conditional Rules"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/container-type"
      },
      content: {
        syntax: "normal | none | [ <content-replacement> | <content-list> ] [ / [ <string> | <counter> | <attr()> ]+ ]?",
        media: "all",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Generated Content"
        ],
        initial: "normal",
        appliesto: "allElementsTreeAbidingPseudoElementsPageMarginBoxes",
        computed: "normalOnElementsForPseudosNoneAbsoluteURIStringOrAsSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/content"
      },
      "content-visibility": {
        syntax: "visible | auto | hidden",
        media: "all",
        inherited: false,
        animationType: "discreteButVisibleForDurationWhenAnimatedHidden",
        percentages: "no",
        groups: [
          "CSS Containment"
        ],
        initial: "visible",
        appliesto: "elementsForWhichSizeContainmentCanApply",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/content-visibility"
      },
      "corner-block-end-shape": {
        syntax: "<corner-shape-value>{1,2}",
        media: "visual",
        inherited: false,
        animationType: [
          "corner-end-start-shape",
          "corner-end-end-shape"
        ],
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "corner-end-start-shape",
          "corner-end-end-shape"
        ],
        appliesto: "allElements",
        computed: [
          "corner-end-start-shape",
          "corner-end-end-shape"
        ],
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/corner-block-end-shape"
      },
      "corner-block-start-shape": {
        syntax: "<corner-shape-value>{1,2}",
        media: "visual",
        inherited: false,
        animationType: [
          "corner-start-start-shape",
          "corner-start-end-shape"
        ],
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "corner-start-start-shape",
          "corner-start-end-shape"
        ],
        appliesto: "allElements",
        computed: [
          "corner-start-start-shape",
          "corner-start-end-shape"
        ],
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/corner-block-start-shape"
      },
      "corner-bottom-shape": {
        syntax: "<corner-shape-value>{1,2}",
        media: "visual",
        inherited: false,
        animationType: [
          "corner-bottom-left-shape",
          "corner-bottom-right-shape"
        ],
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "corner-bottom-left-shape",
          "corner-bottom-right-shape"
        ],
        appliesto: "allElements",
        computed: [
          "corner-bottom-left-shape",
          "corner-bottom-right-shape"
        ],
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/corner-bottom-shape"
      },
      "corner-bottom-left-shape": {
        syntax: "<corner-shape-value>",
        media: "visual",
        inherited: false,
        animationType: "superellipseInterpolation",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "round",
        appliesto: "allElements",
        computed: "correspondingSuperellipse",
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/corner-bottom-left-shape"
      },
      "corner-bottom-right-shape": {
        syntax: "<corner-shape-value>",
        media: "visual",
        inherited: false,
        animationType: "superellipseInterpolation",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "round",
        appliesto: "allElements",
        computed: "correspondingSuperellipse",
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/corner-bottom-right-shape"
      },
      "corner-end-end-shape": {
        syntax: "<corner-shape-value>",
        media: "visual",
        inherited: false,
        animationType: "superellipseInterpolation",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "round",
        appliesto: "allElements",
        computed: "correspondingSuperellipse",
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/corner-end-end-shape"
      },
      "corner-end-start-shape": {
        syntax: "<corner-shape-value>",
        media: "visual",
        inherited: false,
        animationType: "superellipseInterpolation",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "round",
        appliesto: "allElements",
        computed: "correspondingSuperellipse",
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/corner-end-start-shape"
      },
      "corner-inline-end-shape": {
        syntax: "<corner-shape-value>{1,2}",
        media: "visual",
        inherited: false,
        animationType: [
          "corner-start-end-shape",
          "corner-end-end-shape"
        ],
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "corner-start-end-shape",
          "corner-end-end-shape"
        ],
        appliesto: "allElements",
        computed: [
          "corner-start-end-shape",
          "corner-end-end-shape"
        ],
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/corner-inline-end-shape"
      },
      "corner-inline-start-shape": {
        syntax: "<corner-shape-value>{1,2}",
        media: "visual",
        inherited: false,
        animationType: [
          "corner-start-start-shape",
          "corner-start-end-shape"
        ],
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "corner-start-start-shape",
          "corner-start-end-shape"
        ],
        appliesto: "allElements",
        computed: [
          "corner-start-start-shape",
          "corner-start-end-shape"
        ],
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/corner-inline-start-shape"
      },
      "corner-left-shape": {
        syntax: "<corner-shape-value>{1,2}",
        media: "visual",
        inherited: false,
        animationType: [
          "corner-top-left-shape",
          "corner-bottom-left-shape"
        ],
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "corner-top-left-shape",
          "corner-bottom-left-shape"
        ],
        appliesto: "allElements",
        computed: [
          "corner-top-left-shape",
          "corner-bottom-left-shape"
        ],
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/corner-left-shape"
      },
      "corner-right-shape": {
        syntax: "<corner-shape-value>{1,2}",
        media: "visual",
        inherited: false,
        animationType: [
          "corner-top-right-shape",
          "corner-bottom-right-shape"
        ],
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "corner-top-right-shape",
          "corner-bottom-right-shape"
        ],
        appliesto: "allElements",
        computed: [
          "corner-top-right-shape",
          "corner-bottom-right-shape"
        ],
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/corner-right-shape"
      },
      "corner-shape": {
        syntax: "<corner-shape-value>{1,4}",
        media: "visual",
        inherited: false,
        animationType: [
          "corner-top-left-shape",
          "corner-top-right-shape",
          "corner-bottom-left-shape",
          "corner-bottom-right-shape"
        ],
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "corner-top-left-shape",
          "corner-top-right-shape",
          "corner-bottom-left-shape",
          "corner-bottom-right-shape"
        ],
        appliesto: "allElements",
        computed: [
          "corner-top-left-shape",
          "corner-top-right-shape",
          "corner-bottom-left-shape",
          "corner-bottom-right-shape"
        ],
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/corner-shape"
      },
      "corner-start-start-shape": {
        syntax: "<corner-shape-value>",
        media: "visual",
        inherited: false,
        animationType: "superellipseInterpolation",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "round",
        appliesto: "allElements",
        computed: "correspondingSuperellipse",
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/corner-start-start-shape"
      },
      "corner-start-end-shape": {
        syntax: "<corner-shape-value>",
        media: "visual",
        inherited: false,
        animationType: "superellipseInterpolation",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "round",
        appliesto: "allElements",
        computed: "correspondingSuperellipse",
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/corner-start-end-shape"
      },
      "corner-top-shape": {
        syntax: "<corner-shape-value>{1,2}",
        media: "visual",
        inherited: false,
        animationType: [
          "corner-top-left-shape",
          "corner-top-right-shape"
        ],
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: [
          "corner-top-left-shape",
          "corner-top-right-shape"
        ],
        appliesto: "allElements",
        computed: [
          "corner-top-left-shape",
          "corner-top-right-shape"
        ],
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/corner-top-shape"
      },
      "corner-top-left-shape": {
        syntax: "<corner-shape-value>",
        media: "visual",
        inherited: false,
        animationType: "superellipseInterpolation",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "round",
        appliesto: "allElements",
        computed: "correspondingSuperellipse",
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/corner-top-left-shape"
      },
      "corner-top-right-shape": {
        syntax: "<corner-shape-value>",
        media: "visual",
        inherited: false,
        animationType: "superellipseInterpolation",
        percentages: "no",
        groups: [
          "CSS Backgrounds and Borders"
        ],
        initial: "round",
        appliesto: "allElements",
        computed: "correspondingSuperellipse",
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/corner-top-right-shape"
      },
      "counter-increment": {
        syntax: "[ <counter-name> <integer>? ]+ | none",
        media: "all",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Lists and Counters"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/counter-increment"
      },
      "counter-reset": {
        syntax: "[ <counter-name> <integer>? | <reversed-counter-name> <integer>? ]+ | none",
        media: "all",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Lists and Counters"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/counter-reset"
      },
      "counter-set": {
        syntax: "[ <counter-name> <integer>? ]+ | none",
        media: "all",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Lists and Counters"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/counter-set"
      },
      cursor: {
        syntax: "[ [ <url> [ <x> <y> ]? , ]* <cursor-predefined> ]",
        media: [
          "visual",
          "interactive"
        ],
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecifiedURLsAbsolute",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/cursor"
      },
      cx: {
        syntax: "<length> | <percentage>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "referToSVGViewportWidth",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "0",
        appliesto: "limitedSVGElementsEllipse",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/cx"
      },
      cy: {
        syntax: "<length> | <percentage>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "referToSVGViewportHeight",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "0",
        appliesto: "limitedSVGElementsEllipse",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/cy"
      },
      d: {
        syntax: "none | path(<string>)",
        media: "visual",
        inherited: false,
        animationType: "basicShapeOtherwiseNo",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "none",
        appliesto: "limitedSVGElementsPath",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/d"
      },
      direction: {
        syntax: "ltr | rtl",
        media: "visual",
        inherited: true,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Writing Modes"
        ],
        initial: "ltr",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/direction"
      },
      display: {
        syntax: "[ <display-outside> || <display-inside> ] | <display-listitem> | <display-internal> | <display-box> | <display-legacy>",
        media: "all",
        inherited: false,
        animationType: "discreteButVisibleForDurationWhenAnimatedNone",
        percentages: "no",
        groups: [
          "CSS Display"
        ],
        initial: "inline",
        appliesto: "allElements",
        computed: "asSpecifiedExceptPositionedFloatingAndRootElementsKeywordMaybeDifferent",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/display"
      },
      "dominant-baseline": {
        syntax: "auto | text-bottom | alphabetic | ideographic | middle | central | mathematical | hanging | text-top",
        media: "all",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Inline",
          "Scalable Vector Graphics"
        ],
        initial: "auto",
        appliesto: "blockContainersFlexContainersGridContainersInlineBoxesTableRowsSVGTextContentElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/dominant-baseline"
      },
      "dynamic-range-limit": {
        syntax: "standard | no-limit | constrained | <dynamic-range-limit-mix()>",
        media: "visual",
        inherited: true,
        animationType: "byDynamicRangeLimitMix",
        percentages: "no",
        groups: [
          "CSS Color"
        ],
        initial: "no-limit",
        appliesto: "allElements",
        computed: "computedValueForDynamicRangeLimit",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/dynamic-range-limit"
      },
      "empty-cells": {
        syntax: "show | hide",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Table"
        ],
        initial: "show",
        appliesto: "tableCellElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/empty-cells"
      },
      "field-sizing": {
        syntax: "content | fixed",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: "fixed",
        appliesto: "elementsWithDefaultPreferredSize",
        computed: "asSpecified",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/field-sizing"
      },
      fill: {
        syntax: "<paint>",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "black",
        appliesto: "limitedSVGElementsShapeText",
        computed: "asColorOrAbsoluteURL",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/fill"
      },
      "fill-opacity": {
        syntax: "<'opacity'>",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "mapToRange0To1",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "1",
        appliesto: "limitedSVGElementsShapeText",
        computed: "specifiedValueNumberClipped0To1",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/fill-opacity"
      },
      "fill-rule": {
        syntax: "nonzero | evenodd",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "nonzero",
        appliesto: "limitedSVGElementsShapeText",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/fill-rule"
      },
      filter: {
        syntax: "none | <filter-value-list>",
        media: "visual",
        inherited: false,
        animationType: "filterList",
        percentages: "no",
        groups: [
          "Filter Effects"
        ],
        initial: "none",
        appliesto: "allElementsSVGContainerElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/filter"
      },
      flex: {
        syntax: "none | [ <'flex-grow'> <'flex-shrink'>? || <'flex-basis'> ]",
        media: "visual",
        inherited: false,
        animationType: [
          "flex-grow",
          "flex-shrink",
          "flex-basis"
        ],
        percentages: "no",
        groups: [
          "CSS Flexible Box Layout"
        ],
        initial: [
          "flex-grow",
          "flex-shrink",
          "flex-basis"
        ],
        appliesto: "flexItemsAndInFlowPseudos",
        computed: [
          "flex-grow",
          "flex-shrink",
          "flex-basis"
        ],
        order: "orderOfAppearance",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/flex"
      },
      "flex-basis": {
        syntax: "content | <'width'>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToFlexContainersInnerMainSize",
        groups: [
          "CSS Flexible Box Layout"
        ],
        initial: "auto",
        appliesto: "flexItemsAndInFlowPseudos",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "lengthOrPercentageBeforeKeywordIfBothPresent",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/flex-basis"
      },
      "flex-direction": {
        syntax: "row | row-reverse | column | column-reverse",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Flexible Box Layout"
        ],
        initial: "row",
        appliesto: "flexContainers",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/flex-direction"
      },
      "flex-flow": {
        syntax: "<'flex-direction'> || <'flex-wrap'>",
        media: "visual",
        inherited: false,
        animationType: [
          "flex-direction",
          "flex-wrap"
        ],
        percentages: "no",
        groups: [
          "CSS Flexible Box Layout"
        ],
        initial: [
          "flex-direction",
          "flex-wrap"
        ],
        appliesto: "flexContainers",
        computed: [
          "flex-direction",
          "flex-wrap"
        ],
        order: "orderOfAppearance",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/flex-flow"
      },
      "flex-grow": {
        syntax: "<number>",
        media: "visual",
        inherited: false,
        animationType: "number",
        percentages: "no",
        groups: [
          "CSS Flexible Box Layout"
        ],
        initial: "0",
        appliesto: "flexItemsAndInFlowPseudos",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/flex-grow"
      },
      "flex-shrink": {
        syntax: "<number>",
        media: "visual",
        inherited: false,
        animationType: "number",
        percentages: "no",
        groups: [
          "CSS Flexible Box Layout"
        ],
        initial: "1",
        appliesto: "flexItemsAndInFlowPseudos",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/flex-shrink"
      },
      "flex-wrap": {
        syntax: "nowrap | wrap | wrap-reverse",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Flexible Box Layout"
        ],
        initial: "nowrap",
        appliesto: "flexContainers",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/flex-wrap"
      },
      float: {
        syntax: "left | right | none | inline-start | inline-end",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Positioned Layout"
        ],
        initial: "none",
        appliesto: "allElementsNoEffectIfDisplayNone",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/float"
      },
      "flood-color": {
        syntax: "<color>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValue",
        percentages: "no",
        groups: [
          "Filter Effects"
        ],
        initial: "black",
        appliesto: "limitedSVGElementsFloodAndDropShadow",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/flood-color"
      },
      "flood-opacity": {
        syntax: "<'opacity'>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValue",
        percentages: "no",
        groups: [
          "Filter Effects"
        ],
        initial: "black",
        appliesto: "limitedSVGElementsFloodAndDropShadow",
        computed: "specifiedValueClipped0To1",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/flood-opacity"
      },
      font: {
        syntax: "[ [ <'font-style'> || <font-variant-css2> || <'font-weight'> || <font-width-css3> ]? <'font-size'> [ / <'line-height'> ]? <'font-family'># ] | <system-family-name>",
        media: "visual",
        inherited: true,
        animationType: [
          "font-style",
          "font-variant",
          "font-weight",
          "font-stretch",
          "font-size",
          "line-height",
          "font-family"
        ],
        percentages: [
          "font-size",
          "line-height"
        ],
        groups: [
          "CSS Fonts"
        ],
        initial: [
          "font-style",
          "font-variant",
          "font-weight",
          "font-stretch",
          "font-size",
          "line-height",
          "font-family"
        ],
        appliesto: "allElementsAndText",
        computed: [
          "font-style",
          "font-variant",
          "font-weight",
          "font-stretch",
          "font-size",
          "line-height",
          "font-family"
        ],
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font"
      },
      "font-family": {
        syntax: "[ <family-name> | <generic-family> ]#",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "dependsOnUserAgent",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-family"
      },
      "font-feature-settings": {
        syntax: "normal | <feature-tag-value>#",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "normal",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-feature-settings"
      },
      "font-kerning": {
        syntax: "auto | normal | none",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "auto",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-kerning"
      },
      "font-language-override": {
        syntax: "normal | <string>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "normal",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-language-override"
      },
      "font-optical-sizing": {
        syntax: "auto | none",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "auto",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-optical-sizing"
      },
      "font-palette": {
        syntax: "normal | light | dark | <palette-identifier> | <palette-mix()>",
        media: "visual",
        inherited: true,
        animationType: "byComputedValue",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "normal",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-palette"
      },
      "font-size": {
        syntax: "<absolute-size> | <relative-size> | <length-percentage [0,\u221E]> | math",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "referToParentElementsFontSize",
        groups: [
          "CSS Fonts"
        ],
        initial: "medium",
        appliesto: "allElementsAndText",
        computed: "absoluteLength",
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-size"
      },
      "font-size-adjust": {
        syntax: "none | [ ex-height | cap-height | ch-width | ic-width | ic-height ]? [ from-font | <number> ]",
        media: "visual",
        inherited: true,
        animationType: "number",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "none",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-size-adjust"
      },
      "font-smooth": {
        syntax: "auto | never | always | <absolute-size> | <length>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-smooth"
      },
      "font-stretch": {
        syntax: "<font-stretch-absolute>",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "normal",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "obsolete",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-stretch"
      },
      "font-style": {
        syntax: "normal | italic | oblique <angle>?",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueTypeNormalAnimatesAsObliqueZeroDeg",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "normal",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-style"
      },
      "font-synthesis": {
        syntax: "none | [ weight || style || small-caps || position]",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "weight style small-caps position ",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-synthesis"
      },
      "font-synthesis-position": {
        syntax: "auto | none",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "none",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-synthesis-position"
      },
      "font-synthesis-small-caps": {
        syntax: "auto | none",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "auto",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-synthesis-small-caps"
      },
      "font-synthesis-style": {
        syntax: "auto | none",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "auto",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-synthesis-style"
      },
      "font-synthesis-weight": {
        syntax: "auto | none",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "auto",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-synthesis-weight"
      },
      "font-variant": {
        syntax: "normal | none | [ <common-lig-values> || <discretionary-lig-values> || <historical-lig-values> || <contextual-alt-values> || stylistic( <feature-value-name> ) || historical-forms || styleset( <feature-value-name># ) || character-variant( <feature-value-name># ) || swash( <feature-value-name> ) || ornaments( <feature-value-name> ) || annotation( <feature-value-name> ) || [ small-caps | all-small-caps | petite-caps | all-petite-caps | unicase | titling-caps ] || <numeric-figure-values> || <numeric-spacing-values> || <numeric-fraction-values> || ordinal || slashed-zero || <east-asian-variant-values> || <east-asian-width-values> || ruby ]",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "normal",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-variant"
      },
      "font-variant-alternates": {
        syntax: "normal | [ stylistic( <feature-value-name> ) || historical-forms || styleset( <feature-value-name># ) || character-variant( <feature-value-name># ) || swash( <feature-value-name> ) || ornaments( <feature-value-name> ) || annotation( <feature-value-name> ) ]",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "normal",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-variant-alternates"
      },
      "font-variant-caps": {
        syntax: "normal | small-caps | all-small-caps | petite-caps | all-petite-caps | unicase | titling-caps",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "normal",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-variant-caps"
      },
      "font-variant-east-asian": {
        syntax: "normal | [ <east-asian-variant-values> || <east-asian-width-values> || ruby ]",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "normal",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-variant-east-asian"
      },
      "font-variant-emoji": {
        syntax: "normal | text | emoji | unicode",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "normal",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-variant-emoji"
      },
      "font-variant-ligatures": {
        syntax: "normal | none | [ <common-lig-values> || <discretionary-lig-values> || <historical-lig-values> || <contextual-alt-values> ]",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "normal",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-variant-ligatures"
      },
      "font-variant-numeric": {
        syntax: "normal | [ <numeric-figure-values> || <numeric-spacing-values> || <numeric-fraction-values> || ordinal || slashed-zero ]",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "normal",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-variant-numeric"
      },
      "font-variant-position": {
        syntax: "normal | sub | super",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "normal",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-variant-position"
      },
      "font-variation-settings": {
        syntax: "normal | [ <string> <number> ]#",
        media: "visual",
        inherited: true,
        animationType: "transform",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-variation-settings"
      },
      "font-weight": {
        syntax: "<font-weight-absolute> | bolder | lighter",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "normal",
        appliesto: "allElementsAndText",
        computed: "keywordOrNumericalValueBolderLighterTransformedToRealValue",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/font-weight"
      },
      "font-width": {
        syntax: "normal | <percentage [0,\u221E]> | ultra-condensed | extra-condensed | condensed | semi-condensed | semi-expanded | expanded | extra-expanded | ultra-expanded",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Fonts"
        ],
        initial: "normal",
        appliesto: "allElementsAndText",
        computed: "percentage",
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "experimental"
      },
      "forced-color-adjust": {
        syntax: "auto | none | preserve-parent-color",
        media: "visual",
        inherited: true,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Color"
        ],
        initial: "auto",
        appliesto: "allElementsAndText",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/forced-color-adjust"
      },
      gap: {
        syntax: "<'row-gap'> <'column-gap'>?",
        media: "visual",
        inherited: false,
        animationType: [
          "row-gap",
          "column-gap"
        ],
        percentages: "no",
        groups: [
          "CSS Box Alignment"
        ],
        initial: [
          "row-gap",
          "column-gap"
        ],
        appliesto: "multiColumnElementsFlexContainersGridContainers",
        computed: [
          "row-gap",
          "column-gap"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/gap"
      },
      grid: {
        syntax: "<'grid-template'> | <'grid-template-rows'> / [ auto-flow && dense? ] <'grid-auto-columns'>? | [ auto-flow && dense? ] <'grid-auto-rows'>? / <'grid-template-columns'>",
        media: "visual",
        inherited: false,
        animationType: [
          "grid-template-rows",
          "grid-template-columns",
          "grid-template-areas",
          "grid-auto-rows",
          "grid-auto-columns",
          "grid-auto-flow",
          "grid-column-gap",
          "grid-row-gap",
          "column-gap",
          "row-gap"
        ],
        percentages: [
          "grid-template-rows",
          "grid-template-columns",
          "grid-auto-rows",
          "grid-auto-columns"
        ],
        groups: [
          "CSS Grid Layout"
        ],
        initial: [
          "grid-template-rows",
          "grid-template-columns",
          "grid-template-areas",
          "grid-auto-rows",
          "grid-auto-columns",
          "grid-auto-flow",
          "grid-column-gap",
          "grid-row-gap",
          "column-gap",
          "row-gap"
        ],
        appliesto: "gridContainers",
        computed: [
          "grid-template-rows",
          "grid-template-columns",
          "grid-template-areas",
          "grid-auto-rows",
          "grid-auto-columns",
          "grid-auto-flow",
          "grid-column-gap",
          "grid-row-gap",
          "column-gap",
          "row-gap"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/grid"
      },
      "grid-area": {
        syntax: "<grid-line> [ / <grid-line> ]{0,3}",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Grid Layout"
        ],
        initial: [
          "grid-row-start",
          "grid-column-start",
          "grid-row-end",
          "grid-column-end"
        ],
        appliesto: "gridItemsAndBoxesWithinGridContainer",
        computed: [
          "grid-row-start",
          "grid-column-start",
          "grid-row-end",
          "grid-column-end"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/grid-area"
      },
      "grid-auto-columns": {
        syntax: "<track-size>+",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "referToDimensionOfContentArea",
        groups: [
          "CSS Grid Layout"
        ],
        initial: "auto",
        appliesto: "gridContainers",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/grid-auto-columns"
      },
      "grid-auto-flow": {
        syntax: "[ row | column ] || dense",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Grid Layout"
        ],
        initial: "row",
        appliesto: "gridContainers",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/grid-auto-flow"
      },
      "grid-auto-rows": {
        syntax: "<track-size>+",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "referToDimensionOfContentArea",
        groups: [
          "CSS Grid Layout"
        ],
        initial: "auto",
        appliesto: "gridContainers",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/grid-auto-rows"
      },
      "grid-column": {
        syntax: "<grid-line> [ / <grid-line> ]?",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Grid Layout"
        ],
        initial: [
          "grid-column-start",
          "grid-column-end"
        ],
        appliesto: "gridItemsAndBoxesWithinGridContainer",
        computed: [
          "grid-column-start",
          "grid-column-end"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/grid-column"
      },
      "grid-column-end": {
        syntax: "<grid-line>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Grid Layout"
        ],
        initial: "auto",
        appliesto: "gridItemsAndBoxesWithinGridContainer",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/grid-column-end"
      },
      "grid-column-gap": {
        syntax: "<length-percentage>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "referToDimensionOfContentArea",
        groups: [
          "CSS Grid Layout"
        ],
        initial: "0",
        appliesto: "gridContainers",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "uniqueOrder",
        status: "obsolete",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/column-gap"
      },
      "grid-column-start": {
        syntax: "<grid-line>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Grid Layout"
        ],
        initial: "auto",
        appliesto: "gridItemsAndBoxesWithinGridContainer",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/grid-column-start"
      },
      "grid-gap": {
        syntax: "<'grid-row-gap'> <'grid-column-gap'>?",
        media: "visual",
        inherited: false,
        animationType: [
          "grid-row-gap",
          "grid-column-gap"
        ],
        percentages: "no",
        groups: [
          "CSS Grid Layout"
        ],
        initial: [
          "grid-row-gap",
          "grid-column-gap"
        ],
        appliesto: "gridContainers",
        computed: [
          "grid-row-gap",
          "grid-column-gap"
        ],
        order: "uniqueOrder",
        status: "obsolete",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/gap"
      },
      "grid-row": {
        syntax: "<grid-line> [ / <grid-line> ]?",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Grid Layout"
        ],
        initial: [
          "grid-row-start",
          "grid-row-end"
        ],
        appliesto: "gridItemsAndBoxesWithinGridContainer",
        computed: [
          "grid-row-start",
          "grid-row-end"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/grid-row"
      },
      "grid-row-end": {
        syntax: "<grid-line>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Grid Layout"
        ],
        initial: "auto",
        appliesto: "gridItemsAndBoxesWithinGridContainer",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/grid-row-end"
      },
      "grid-row-gap": {
        syntax: "<length-percentage>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "referToDimensionOfContentArea",
        groups: [
          "CSS Grid Layout"
        ],
        initial: "0",
        appliesto: "gridContainers",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "uniqueOrder",
        status: "obsolete",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/row-gap"
      },
      "grid-row-start": {
        syntax: "<grid-line>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Grid Layout"
        ],
        initial: "auto",
        appliesto: "gridItemsAndBoxesWithinGridContainer",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/grid-row-start"
      },
      "grid-template": {
        syntax: "none | [ <'grid-template-rows'> / <'grid-template-columns'> ] | [ <line-names>? <string> <track-size>? <line-names>? ]+ [ / <explicit-track-list> ]?",
        media: "visual",
        inherited: false,
        animationType: [
          "grid-template-columns",
          "grid-template-rows",
          "grid-template-areas"
        ],
        percentages: [
          "grid-template-columns",
          "grid-template-rows"
        ],
        groups: [
          "CSS Grid Layout"
        ],
        initial: [
          "grid-template-columns",
          "grid-template-rows",
          "grid-template-areas"
        ],
        appliesto: "gridContainers",
        computed: [
          "grid-template-columns",
          "grid-template-rows",
          "grid-template-areas"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/grid-template"
      },
      "grid-template-areas": {
        syntax: "none | <string>+",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Grid Layout"
        ],
        initial: "none",
        appliesto: "gridContainers",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/grid-template-areas"
      },
      "grid-template-columns": {
        syntax: "none | <track-list> | <auto-track-list> | subgrid <line-name-list>?",
        media: "visual",
        inherited: false,
        animationType: "simpleListOfLpcDifferenceLpc",
        percentages: "referToDimensionOfContentArea",
        groups: [
          "CSS Grid Layout"
        ],
        initial: "none",
        appliesto: "gridContainers",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/grid-template-columns"
      },
      "grid-template-rows": {
        syntax: "none | <track-list> | <auto-track-list> | subgrid <line-name-list>?",
        media: "visual",
        inherited: false,
        animationType: "simpleListOfLpcDifferenceLpc",
        percentages: "referToDimensionOfContentArea",
        groups: [
          "CSS Grid Layout"
        ],
        initial: "none",
        appliesto: "gridContainers",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/grid-template-rows"
      },
      "hanging-punctuation": {
        syntax: "none | [ first || [ force-end | allow-end ] || last ]",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/hanging-punctuation"
      },
      height: {
        syntax: "auto | <length-percentage [0,\u221E]> | min-content | max-content | fit-content | fit-content(<length-percentage [0,\u221E]>) | <calc-size()> | <anchor-size()>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "regardingHeightOfGeneratedBoxContainingBlockPercentagesRelativeToContainingBlock",
        groups: [
          "CSS Box Sizing"
        ],
        initial: "auto",
        appliesto: "allElementsButNonReplacedAndTableColumns",
        computed: "percentageAutoOrAbsoluteLength",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/height"
      },
      "hyphenate-character": {
        syntax: "auto | <string>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/hyphenate-character"
      },
      "hyphenate-limit-chars": {
        syntax: "[ auto | <integer> ]{1,3}",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/hyphenate-limit-chars"
      },
      hyphens: {
        syntax: "none | manual | auto",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "manual",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/hyphens"
      },
      "image-orientation": {
        syntax: "from-image | <angle> | [ <angle>? flip ]",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Images"
        ],
        initial: "from-image",
        appliesto: "allElements",
        computed: "angleRoundedToNextQuarter",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/image-orientation"
      },
      "image-rendering": {
        syntax: "auto | crisp-edges | pixelated | smooth",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Images"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/image-rendering"
      },
      "image-resolution": {
        syntax: "[ from-image || <resolution> ] && snap?",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Images"
        ],
        initial: "1dppx",
        appliesto: "allElements",
        computed: "asSpecifiedWithExceptionOfResolution",
        order: "uniqueOrder",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/image-resolution"
      },
      "ime-mode": {
        syntax: "auto | normal | active | inactive | disabled",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: "auto",
        appliesto: "textFields",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "obsolete"
      },
      "initial-letter": {
        syntax: "normal | [ <number> <integer>? ]",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Inline"
        ],
        initial: "normal",
        appliesto: "firstLetterPseudoElementsAndInlineLevelFirstChildren",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/initial-letter"
      },
      "initial-letter-align": {
        syntax: "[ auto | alphabetic | hanging | ideographic ]",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Inline"
        ],
        initial: "auto",
        appliesto: "firstLetterPseudoElementsAndInlineLevelFirstChildren",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "experimental"
      },
      "inline-size": {
        syntax: "<'width'>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "inlineSizeOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "auto",
        appliesto: "sameAsWidthAndHeight",
        computed: "sameAsWidthAndHeight",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/inline-size"
      },
      inset: {
        syntax: "<'top'>{1,4}",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "logicalHeightOrWidthOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values",
          "CSS Positioned Layout"
        ],
        initial: [
          "top",
          "bottom",
          "left",
          "right"
        ],
        appliesto: "positionedElements",
        computed: [
          "top",
          "bottom",
          "left",
          "right"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/inset"
      },
      "inset-block": {
        syntax: "<'top'>{1,2}",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "logicalHeightOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values",
          "CSS Positioned Layout"
        ],
        initial: [
          "inset-block-start",
          "inset-block-end"
        ],
        appliesto: "positionedElements",
        computed: [
          "inset-block-start",
          "inset-block-end"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/inset-block"
      },
      "inset-block-end": {
        syntax: "<'top'>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "logicalHeightOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values",
          "CSS Positioned Layout"
        ],
        initial: "auto",
        appliesto: "positionedElements",
        computed: "sameAsBoxOffsets",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/inset-block-end"
      },
      "inset-block-start": {
        syntax: "<'top'>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "logicalHeightOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values",
          "CSS Positioned Layout"
        ],
        initial: "auto",
        appliesto: "positionedElements",
        computed: "sameAsBoxOffsets",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/inset-block-start"
      },
      "inset-inline": {
        syntax: "<'top'>{1,2}",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "logicalWidthOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values",
          "CSS Positioned Layout"
        ],
        initial: [
          "inset-inline-start",
          "inset-inline-end"
        ],
        appliesto: "positionedElements",
        computed: [
          "inset-inline-start",
          "inset-inline-end"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/inset-inline"
      },
      "inset-inline-end": {
        syntax: "<'top'>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "logicalWidthOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values",
          "CSS Positioned Layout"
        ],
        initial: "auto",
        appliesto: "positionedElements",
        computed: "sameAsBoxOffsets",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/inset-inline-end"
      },
      "inset-inline-start": {
        syntax: "<'top'>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "logicalWidthOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values",
          "CSS Positioned Layout"
        ],
        initial: "auto",
        appliesto: "positionedElements",
        computed: "sameAsBoxOffsets",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/inset-inline-start"
      },
      "interpolate-size": {
        syntax: "numeric-only | allow-keywords",
        media: "none",
        inherited: true,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Values and Units"
        ],
        initial: "numeric-only",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/interpolate-size"
      },
      isolation: {
        syntax: "auto | isolate",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "Compositing and Blending"
        ],
        initial: "auto",
        appliesto: "allElementsSVGContainerGraphicsAndGraphicsReferencingElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/isolation"
      },
      interactivity: {
        syntax: "auto | inert",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/interactivity"
      },
      "interest-delay": {
        syntax: "<'interest-delay-start'>{1,2}",
        media: "visual",
        inherited: true,
        animationType: [
          "interest-delay-start",
          "interest-delay-end"
        ],
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: [
          "interest-delay-start",
          "interest-delay-end"
        ],
        appliesto: "allElements",
        computed: [
          "interest-delay-start",
          "interest-delay-end"
        ],
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/interest-delay-end"
      },
      "interest-delay-end": {
        syntax: "normal | <time>",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "normalOrComputedTime",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/interest-delay-end"
      },
      "interest-delay-start": {
        syntax: "normal | <time>",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "normalOrComputedTime",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/interest-delay-start"
      },
      "justify-content": {
        syntax: "normal | <content-distribution> | <overflow-position>? [ <content-position> | left | right ]",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Box Alignment",
          "CSS Flexible Box Layout"
        ],
        initial: "normal",
        appliesto: "flexContainers",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/justify-content"
      },
      "justify-items": {
        syntax: "normal | stretch | <baseline-position> | <overflow-position>? [ <self-position> | left | right ] | legacy | legacy && [ left | right | center ] | anchor-center",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Box Alignment"
        ],
        initial: "legacy",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/justify-items"
      },
      "justify-self": {
        syntax: "auto | normal | stretch | <baseline-position> | <overflow-position>? [ <self-position> | left | right ] | anchor-center",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Box Alignment"
        ],
        initial: "auto",
        appliesto: "blockLevelBoxesAndAbsolutelyPositionedBoxesAndGridItems",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/justify-self"
      },
      "justify-tracks": {
        syntax: "[ normal | <content-distribution> | <overflow-position>? [ <content-position> | left | right ] ]#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Grid Layout"
        ],
        initial: "normal",
        appliesto: "gridContainersWithMasonryLayoutInTheirInlineAxis",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      left: {
        syntax: "auto | <length-percentage> | <anchor()> | <anchor-size()>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToWidthOfContainingBlock",
        groups: [
          "CSS Anchor Positioning",
          "CSS Positioned Layout"
        ],
        initial: "auto",
        appliesto: "positionedElements",
        computed: "lengthAbsolutePercentageAsSpecifiedOtherwiseAuto",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/left"
      },
      "letter-spacing": {
        syntax: "normal | <length>",
        media: "visual",
        inherited: true,
        animationType: "length",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "optimumValueOfAbsoluteLengthOrNormal",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/letter-spacing"
      },
      "lighting-color": {
        syntax: "<color>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValue",
        percentages: "no",
        groups: [
          "Filter Effects"
        ],
        initial: "white",
        appliesto: "limitedSVGElementsLightSource",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/lighting-color"
      },
      "line-break": {
        syntax: "auto | loose | normal | strict | anywhere",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/line-break"
      },
      "line-clamp": {
        syntax: "none | <integer>",
        media: "visual",
        inherited: false,
        animationType: "integer",
        percentages: "no",
        groups: [
          "CSS Overflow"
        ],
        initial: "none",
        appliesto: "blockContainersExceptMultiColumnContainers",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/line-clamp"
      },
      "line-height": {
        syntax: "normal | <number> | <length> | <percentage>",
        media: "visual",
        inherited: true,
        animationType: "numberOrLength",
        percentages: "referToElementFontSize",
        groups: [
          "CSS Inline"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "absoluteLengthOrAsSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/line-height"
      },
      "line-height-step": {
        syntax: "<length>",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Rhythmic Sizing"
        ],
        initial: "0",
        appliesto: "blockContainers",
        computed: "absoluteLength",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/line-height-step"
      },
      "list-style": {
        syntax: "<'list-style-type'> || <'list-style-position'> || <'list-style-image'>",
        media: "visual",
        inherited: true,
        animationType: [
          "list-style-image",
          "list-style-position",
          "list-style-type"
        ],
        percentages: "no",
        groups: [
          "CSS Lists and Counters"
        ],
        initial: [
          "list-style-type",
          "list-style-position",
          "list-style-image"
        ],
        appliesto: "listItems",
        computed: [
          "list-style-image",
          "list-style-position",
          "list-style-type"
        ],
        order: "orderOfAppearance",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/list-style"
      },
      "list-style-image": {
        syntax: "<image> | none",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Lists and Counters"
        ],
        initial: "none",
        appliesto: "listItems",
        computed: "theKeywordListStyleImageNoneOrComputedValue",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/list-style-image"
      },
      "list-style-position": {
        syntax: "inside | outside",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Lists and Counters"
        ],
        initial: "outside",
        appliesto: "listItems",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/list-style-position"
      },
      "list-style-type": {
        syntax: "<counter-style> | <string> | none",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Lists and Counters"
        ],
        initial: "disc",
        appliesto: "listItems",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/list-style-type"
      },
      margin: {
        syntax: "<'margin-top'>{1,4}",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "referToWidthOfContainingBlock",
        groups: [
          "CSS Box Model"
        ],
        initial: [
          "margin-bottom",
          "margin-left",
          "margin-right",
          "margin-top"
        ],
        appliesto: "allElementsExceptTableDisplayTypes",
        computed: [
          "margin-bottom",
          "margin-left",
          "margin-right",
          "margin-top"
        ],
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/margin"
      },
      "margin-block": {
        syntax: "<'margin-top'>{1,2}",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "dependsOnLayoutModel",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: [
          "margin-block-start",
          "margin-block-end"
        ],
        appliesto: "sameAsMargin",
        computed: [
          "margin-block-start",
          "margin-block-end"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/margin-block"
      },
      "margin-block-end": {
        syntax: "<'margin-top'>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "dependsOnLayoutModel",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "0",
        appliesto: "sameAsMargin",
        computed: "lengthAbsolutePercentageAsSpecifiedOtherwiseAuto",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/margin-block-end"
      },
      "margin-block-start": {
        syntax: "<'margin-top'>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "dependsOnLayoutModel",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "0",
        appliesto: "sameAsMargin",
        computed: "lengthAbsolutePercentageAsSpecifiedOtherwiseAuto",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/margin-block-start"
      },
      "margin-bottom": {
        syntax: "<length-percentage> | auto | <anchor-size()>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "referToWidthOfContainingBlock",
        groups: [
          "CSS Anchor Positioning",
          "CSS Box Model"
        ],
        initial: "0",
        appliesto: "allElementsExceptTableDisplayTypes",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/margin-bottom"
      },
      "margin-inline": {
        syntax: "<'margin-top'>{1,2}",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "dependsOnLayoutModel",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: [
          "margin-inline-start",
          "margin-inline-end"
        ],
        appliesto: "sameAsMargin",
        computed: [
          "margin-inline-start",
          "margin-inline-end"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/margin-inline"
      },
      "margin-inline-end": {
        syntax: "<'margin-top'>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "dependsOnLayoutModel",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "0",
        appliesto: "sameAsMargin",
        computed: "lengthAbsolutePercentageAsSpecifiedOtherwiseAuto",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/margin-inline-end"
      },
      "margin-inline-start": {
        syntax: "<'margin-top'>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "dependsOnLayoutModel",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "0",
        appliesto: "sameAsMargin",
        computed: "lengthAbsolutePercentageAsSpecifiedOtherwiseAuto",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/margin-inline-start"
      },
      "margin-left": {
        syntax: "<length-percentage> | auto | <anchor-size()>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "referToWidthOfContainingBlock",
        groups: [
          "CSS Anchor Positioning",
          "CSS Box Model"
        ],
        initial: "0",
        appliesto: "allElementsExceptTableDisplayTypes",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/margin-left"
      },
      "margin-right": {
        syntax: "<length-percentage> | auto | <anchor-size()>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "referToWidthOfContainingBlock",
        groups: [
          "CSS Anchor Positioning",
          "CSS Box Model"
        ],
        initial: "0",
        appliesto: "allElementsExceptTableDisplayTypes",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/margin-right"
      },
      "margin-top": {
        syntax: "<length-percentage> | auto | <anchor-size()>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "referToWidthOfContainingBlock",
        groups: [
          "CSS Anchor Positioning",
          "CSS Box Model"
        ],
        initial: "0",
        appliesto: "allElementsExceptTableDisplayTypes",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/margin-top"
      },
      "margin-trim": {
        syntax: "none | in-flow | all",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Box Model"
        ],
        initial: "none",
        appliesto: "blockContainersAndMultiColumnContainers",
        computed: "asSpecified",
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter"
        ],
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/margin-trim"
      },
      marker: {
        syntax: "none | <url>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: [
          "marker-start",
          "marker-mid",
          "marker-end"
        ],
        appliesto: "limitedSVGElementsShapes",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/marker"
      },
      "marker-end": {
        syntax: "none | <url>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "none",
        appliesto: "limitedSVGElementsShapes",
        computed: "asSpecifiedURLsAbsolute",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/marker-end"
      },
      "marker-mid": {
        syntax: "none | <url>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "none",
        appliesto: "limitedSVGElementsShapes",
        computed: "asSpecifiedURLsAbsolute",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/marker-mid"
      },
      "marker-start": {
        syntax: "none | <url>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "none",
        appliesto: "limitedSVGElementsShapes",
        computed: "asSpecifiedURLsAbsolute",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/marker-start"
      },
      mask: {
        syntax: "<mask-layer>#",
        media: "visual",
        inherited: false,
        animationType: [
          "mask-image",
          "mask-mode",
          "mask-repeat",
          "mask-position",
          "mask-clip",
          "mask-origin",
          "mask-size",
          "mask-composite"
        ],
        percentages: [
          "mask-position"
        ],
        groups: [
          "CSS Masking"
        ],
        initial: [
          "mask-image",
          "mask-mode",
          "mask-repeat",
          "mask-position",
          "mask-clip",
          "mask-origin",
          "mask-size",
          "mask-composite"
        ],
        appliesto: "allElementsSVGContainerElements",
        computed: [
          "mask-image",
          "mask-mode",
          "mask-repeat",
          "mask-position",
          "mask-clip",
          "mask-origin",
          "mask-size",
          "mask-composite"
        ],
        order: "perGrammar",
        stacking: true,
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask"
      },
      "mask-border": {
        syntax: "<'mask-border-source'> || <'mask-border-slice'> [ / <'mask-border-width'>? [ / <'mask-border-outset'> ]? ]? || <'mask-border-repeat'> || <'mask-border-mode'>",
        media: "visual",
        inherited: false,
        animationType: [
          "mask-border-mode",
          "mask-border-outset",
          "mask-border-repeat",
          "mask-border-slice",
          "mask-border-source",
          "mask-border-width"
        ],
        percentages: [
          "mask-border-slice",
          "mask-border-width"
        ],
        groups: [
          "CSS Masking"
        ],
        initial: [
          "mask-border-mode",
          "mask-border-outset",
          "mask-border-repeat",
          "mask-border-slice",
          "mask-border-source",
          "mask-border-width"
        ],
        appliesto: "allElementsSVGContainerElements",
        computed: [
          "mask-border-mode",
          "mask-border-outset",
          "mask-border-repeat",
          "mask-border-slice",
          "mask-border-source",
          "mask-border-width"
        ],
        order: "perGrammar",
        stacking: true,
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-border"
      },
      "mask-border-mode": {
        syntax: "luminance | alpha",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Masking"
        ],
        initial: "alpha",
        appliesto: "allElementsSVGContainerElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-border-mode"
      },
      "mask-border-outset": {
        syntax: "[ <length> | <number> ]{1,4}",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Masking"
        ],
        initial: "0",
        appliesto: "allElementsSVGContainerElements",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-border-outset"
      },
      "mask-border-repeat": {
        syntax: "[ stretch | repeat | round | space ]{1,2}",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Masking"
        ],
        initial: "stretch",
        appliesto: "allElementsSVGContainerElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-border-repeat"
      },
      "mask-border-slice": {
        syntax: "<number-percentage>{1,4} fill?",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "referToSizeOfMaskBorderImage",
        groups: [
          "CSS Masking"
        ],
        initial: "0",
        appliesto: "allElementsSVGContainerElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-border-slice"
      },
      "mask-border-source": {
        syntax: "none | <image>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Masking"
        ],
        initial: "none",
        appliesto: "allElementsSVGContainerElements",
        computed: "asSpecifiedURLsAbsolute",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-border-source"
      },
      "mask-border-width": {
        syntax: "[ <length-percentage> | <number> | auto ]{1,4}",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "relativeToMaskBorderImageArea",
        groups: [
          "CSS Masking"
        ],
        initial: "auto",
        appliesto: "allElementsSVGContainerElements",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-border-width"
      },
      "mask-clip": {
        syntax: "[ <coord-box> | no-clip ]#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Masking"
        ],
        initial: "border-box",
        appliesto: "allElementsSVGContainerElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-clip"
      },
      "mask-composite": {
        syntax: "<compositing-operator>#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Masking"
        ],
        initial: "add",
        appliesto: "allElementsSVGContainerElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-composite"
      },
      "mask-image": {
        syntax: "<mask-reference>#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Masking"
        ],
        initial: "none",
        appliesto: "allElementsSVGContainerElements",
        computed: "asSpecifiedURLsAbsolute",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-image"
      },
      "mask-mode": {
        syntax: "<masking-mode>#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Masking"
        ],
        initial: "match-source",
        appliesto: "allElementsSVGContainerElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-mode"
      },
      "mask-origin": {
        syntax: "<coord-box>#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Masking"
        ],
        initial: "border-box",
        appliesto: "allElementsSVGContainerElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-origin"
      },
      "mask-position": {
        syntax: "<position>#",
        media: "visual",
        inherited: false,
        animationType: "repeatableList",
        percentages: "referToSizeOfMaskPaintingArea",
        groups: [
          "CSS Masking"
        ],
        initial: "0% 0%",
        appliesto: "allElementsSVGContainerElements",
        computed: "consistsOfTwoKeywordsForOriginAndOffsets",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-position"
      },
      "mask-repeat": {
        syntax: "<repeat-style>#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Masking"
        ],
        initial: "repeat",
        appliesto: "allElementsSVGContainerElements",
        computed: "consistsOfTwoDimensionKeywords",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-repeat"
      },
      "mask-size": {
        syntax: "<bg-size>#",
        media: "visual",
        inherited: false,
        animationType: "repeatableList",
        percentages: "no",
        groups: [
          "CSS Masking"
        ],
        initial: "auto",
        appliesto: "allElementsSVGContainerElements",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-size"
      },
      "mask-type": {
        syntax: "luminance | alpha",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Masking"
        ],
        initial: "luminance",
        appliesto: "maskElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mask-type"
      },
      "masonry-auto-flow": {
        syntax: "[ pack | next ] || [ definite-first | ordered ]",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Grid Layout"
        ],
        initial: "pack",
        appliesto: "gridContainersWithMasonryLayout",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/grid-auto-flow"
      },
      "math-depth": {
        syntax: "auto-add | add(<integer>) | <integer>",
        media: "visual",
        inherited: true,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "MathML"
        ],
        initial: "0",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/math-depth"
      },
      "math-shift": {
        syntax: "normal | compact",
        media: "visual",
        inherited: true,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "MathML"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/math-shift"
      },
      "math-style": {
        syntax: "normal | compact",
        media: "visual",
        inherited: true,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "MathML"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/math-style"
      },
      "max-block-size": {
        syntax: "<'max-width'>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "blockSizeOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "none",
        appliesto: "sameAsWidthAndHeight",
        computed: "sameAsMaxWidthAndMaxHeight",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/max-block-size"
      },
      "max-height": {
        syntax: "none | <length-percentage [0,\u221E]> | min-content | max-content | fit-content | fit-content(<length-percentage [0,\u221E]>) | <calc-size()> | <anchor-size()>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "regardingHeightOfGeneratedBoxContainingBlockPercentagesNone",
        groups: [
          "CSS Box Sizing"
        ],
        initial: "none",
        appliesto: "allElementsButNonReplacedAndTableColumns",
        computed: "percentageAsSpecifiedAbsoluteLengthOrNone",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/max-height"
      },
      "max-inline-size": {
        syntax: "<'max-width'>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "inlineSizeOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "none",
        appliesto: "sameAsWidthAndHeight",
        computed: "sameAsMaxWidthAndMaxHeight",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/max-inline-size"
      },
      "max-lines": {
        syntax: "none | <integer>",
        media: "visual",
        inherited: false,
        animationType: "integer",
        percentages: "no",
        groups: [
          "CSS Overflow"
        ],
        initial: "none",
        appliesto: "blockContainersExceptMultiColumnContainers",
        computed: "asSpecified",
        order: "perGrammar",
        status: "experimental"
      },
      "max-width": {
        syntax: "none | <length-percentage [0,\u221E]> | min-content | max-content | fit-content | fit-content(<length-percentage [0,\u221E]>) | <calc-size()> | <anchor-size()>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToWidthOfContainingBlock",
        groups: [
          "CSS Box Sizing"
        ],
        initial: "none",
        appliesto: "allElementsButNonReplacedAndTableRows",
        computed: "percentageAsSpecifiedAbsoluteLengthOrNone",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/max-width"
      },
      "min-block-size": {
        syntax: "<'min-width'>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "blockSizeOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "0",
        appliesto: "sameAsWidthAndHeight",
        computed: "sameAsMinWidthAndMinHeight",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/min-block-size"
      },
      "min-height": {
        syntax: "auto | <length-percentage [0,\u221E]> | min-content | max-content | fit-content | fit-content(<length-percentage [0,\u221E]>) | <calc-size()> | <anchor-size()>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "regardingHeightOfGeneratedBoxContainingBlockPercentages0",
        groups: [
          "CSS Box Sizing"
        ],
        initial: "auto",
        appliesto: "allElementsButNonReplacedAndTableColumns",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/min-height"
      },
      "min-inline-size": {
        syntax: "<'min-width'>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "inlineSizeOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "0",
        appliesto: "sameAsWidthAndHeight",
        computed: "sameAsMinWidthAndMinHeight",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/min-inline-size"
      },
      "min-width": {
        syntax: "auto | <length-percentage [0,\u221E]> | min-content | max-content | fit-content | fit-content(<length-percentage [0,\u221E]>) | <calc-size()> | <anchor-size()>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToWidthOfContainingBlock",
        groups: [
          "CSS Box Sizing"
        ],
        initial: "auto",
        appliesto: "allElementsButNonReplacedAndTableRows",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/min-width"
      },
      "mix-blend-mode": {
        syntax: "<blend-mode> | plus-darker | plus-lighter",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "Compositing and Blending"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        stacking: true,
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/mix-blend-mode"
      },
      "object-fit": {
        syntax: "fill | contain | cover | none | scale-down",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Images"
        ],
        initial: "fill",
        appliesto: "replacedElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/object-fit"
      },
      "object-position": {
        syntax: "<position>",
        media: "visual",
        inherited: true,
        animationType: "repeatableList",
        percentages: "referToWidthAndHeightOfElement",
        groups: [
          "CSS Images"
        ],
        initial: "50% 50%",
        appliesto: "replacedElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/object-position"
      },
      "object-view-box": {
        syntax: "none | <basic-shape-rect>",
        media: "visual",
        inherited: false,
        animationType: "asIfPossibleOtherwiseDiscrete",
        percentages: "no",
        groups: [
          "CSS Images"
        ],
        initial: "none",
        appliesto: "replacedElements",
        computed: "specifiedKeywordOrComputedFunction",
        order: "perGrammar",
        status: "experimental"
      },
      offset: {
        syntax: "[ <'offset-position'>? [ <'offset-path'> [ <'offset-distance'> || <'offset-rotate'> ]? ]? ]! [ / <'offset-anchor'> ]?",
        media: "visual",
        inherited: false,
        animationType: [
          "offset-position",
          "offset-path",
          "offset-distance",
          "offset-anchor",
          "offset-rotate"
        ],
        percentages: [
          "offset-position",
          "offset-distance",
          "offset-anchor"
        ],
        groups: [
          "Motion Path"
        ],
        initial: [
          "offset-position",
          "offset-path",
          "offset-distance",
          "offset-anchor",
          "offset-rotate"
        ],
        appliesto: "transformableElements",
        computed: [
          "offset-position",
          "offset-path",
          "offset-distance",
          "offset-anchor",
          "offset-rotate"
        ],
        order: "perGrammar",
        stacking: true,
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/offset"
      },
      "offset-anchor": {
        syntax: "auto | <position>",
        media: "visual",
        inherited: false,
        animationType: "position",
        percentages: "relativeToWidthAndHeight",
        groups: [
          "Motion Path"
        ],
        initial: "auto",
        appliesto: "transformableElements",
        computed: "forLengthAbsoluteValueOtherwisePercentage",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/offset-anchor"
      },
      "offset-distance": {
        syntax: "<length-percentage>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToTotalPathLength",
        groups: [
          "Motion Path"
        ],
        initial: "0",
        appliesto: "transformableElements",
        computed: "forLengthAbsoluteValueOtherwisePercentage",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/offset-distance"
      },
      "offset-path": {
        syntax: "none | <offset-path> || <coord-box>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "Motion Path"
        ],
        initial: "none",
        appliesto: "transformableElements",
        computed: "asSpecified",
        order: "perGrammar",
        stacking: true,
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/offset-path"
      },
      "offset-position": {
        syntax: "normal | auto | <position>",
        media: "visual",
        inherited: false,
        animationType: "position",
        percentages: "referToSizeOfContainingBlock",
        groups: [
          "Motion Path"
        ],
        initial: "normal",
        appliesto: "transformableElements",
        computed: "forLengthAbsoluteValueOtherwisePercentage",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/offset-position"
      },
      "offset-rotate": {
        syntax: "[ auto | reverse ] || <angle>",
        media: "visual",
        inherited: false,
        animationType: "angleOrBasicShapeOrPath",
        percentages: "no",
        groups: [
          "Motion Path"
        ],
        initial: "auto",
        appliesto: "transformableElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/offset-rotate"
      },
      opacity: {
        syntax: "<opacity-value>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "mapToRange0To1",
        groups: [
          "CSS Color"
        ],
        initial: "1",
        appliesto: "allElements",
        computed: "specifiedValueNumberClipped0To1",
        order: "perGrammar",
        alsoAppliesTo: [
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/opacity"
      },
      order: {
        syntax: "<integer>",
        media: "visual",
        inherited: false,
        animationType: "integer",
        percentages: "no",
        groups: [
          "CSS Display"
        ],
        initial: "0",
        appliesto: "flexItemsGridItemsAbsolutelyPositionedContainerChildren",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/order"
      },
      orphans: {
        syntax: "<integer>",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Fragmentation"
        ],
        initial: "2",
        appliesto: "blockContainerElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/orphans"
      },
      outline: {
        syntax: "<'outline-width'> || <'outline-style'> || <'outline-color'>",
        media: [
          "visual",
          "interactive"
        ],
        inherited: false,
        animationType: [
          "outline-width",
          "outline-style",
          "outline-color"
        ],
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: [
          "outline-width",
          "outline-style",
          "outline-color"
        ],
        appliesto: "allElements",
        computed: [
          "outline-width",
          "outline-style",
          "outline-color"
        ],
        order: "orderOfAppearance",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/outline"
      },
      "outline-color": {
        syntax: "auto | <color>",
        media: [
          "visual",
          "interactive"
        ],
        inherited: false,
        animationType: "color",
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "autoForTranslucentColorRGBAOtherwiseRGB",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/outline-color"
      },
      "outline-offset": {
        syntax: "<length>",
        media: [
          "visual",
          "interactive"
        ],
        inherited: false,
        animationType: "length",
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: "0",
        appliesto: "allElements",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/outline-offset"
      },
      "outline-style": {
        syntax: "auto | <outline-line-style>",
        media: [
          "visual",
          "interactive"
        ],
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/outline-style"
      },
      "outline-width": {
        syntax: "<line-width>",
        media: [
          "visual",
          "interactive"
        ],
        inherited: false,
        animationType: "length",
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: "medium",
        appliesto: "allElements",
        computed: "absoluteLength0ForNone",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/outline-width"
      },
      overflow: {
        syntax: "[ visible | hidden | clip | scroll | auto ]{1,2}",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Overflow"
        ],
        initial: "visible",
        appliesto: "blockContainersFlexContainersGridContainers",
        computed: [
          "overflow-x",
          "overflow-y"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/overflow"
      },
      "overflow-anchor": {
        syntax: "auto | none",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Scroll Anchoring"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/overflow-anchor"
      },
      "overflow-block": {
        syntax: "visible | hidden | clip | scroll | auto",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Overflow"
        ],
        initial: "auto",
        appliesto: "blockContainersFlexContainersGridContainers",
        computed: "asSpecifiedButVisibleOrClipReplacedToAutoOrHiddenIfOtherValueDifferent",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/overflow-block"
      },
      "overflow-clip-box": {
        syntax: "padding-box | content-box",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Mozilla Extensions"
        ],
        initial: "padding-box",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "nonstandard"
      },
      "overflow-clip-margin": {
        syntax: "<visual-box> || <length [0,\u221E]>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Overflow"
        ],
        initial: "0px",
        appliesto: "allElements",
        computed: "theComputedLengthAndVisualBox",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/overflow-clip-margin"
      },
      "overflow-inline": {
        syntax: "visible | hidden | clip | scroll | auto",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Overflow"
        ],
        initial: "auto",
        appliesto: "blockContainersFlexContainersGridContainers",
        computed: "asSpecifiedButVisibleOrClipReplacedToAutoOrHiddenIfOtherValueDifferent",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/overflow-inline"
      },
      "overflow-wrap": {
        syntax: "normal | break-word | anywhere",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "normal",
        appliesto: "textElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/overflow-wrap"
      },
      "overflow-x": {
        syntax: "visible | hidden | clip | scroll | auto",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Overflow"
        ],
        initial: "visible",
        appliesto: "blockContainersFlexContainersGridContainers",
        computed: "asSpecifiedButVisibleOrClipReplacedToAutoOrHiddenIfOtherValueDifferent",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/overflow-x"
      },
      "overflow-y": {
        syntax: "visible | hidden | clip | scroll | auto",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Overflow"
        ],
        initial: "visible",
        appliesto: "blockContainersFlexContainersGridContainers",
        computed: "asSpecifiedButVisibleOrClipReplacedToAutoOrHiddenIfOtherValueDifferent",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/overflow-y"
      },
      overlay: {
        syntax: "none | auto",
        media: "visual",
        inherited: false,
        animationType: "discreteButVisibleForDurationWhenAnimatedNone",
        percentages: "no",
        groups: [
          "CSS Positioned Layout"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/overlay"
      },
      "overscroll-behavior": {
        syntax: "[ contain | none | auto ]{1,2}",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Overscroll Behavior"
        ],
        initial: "auto",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: [
          "overscroll-behavior-x",
          "overscroll-behavior-y"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/overscroll-behavior"
      },
      "overscroll-behavior-block": {
        syntax: "contain | none | auto",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Overscroll Behavior"
        ],
        initial: "auto",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/overscroll-behavior-block"
      },
      "overscroll-behavior-inline": {
        syntax: "contain | none | auto",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Overscroll Behavior"
        ],
        initial: "auto",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/overscroll-behavior-inline"
      },
      "overscroll-behavior-x": {
        syntax: "contain | none | auto",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Overscroll Behavior"
        ],
        initial: "auto",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/overscroll-behavior-x"
      },
      "overscroll-behavior-y": {
        syntax: "contain | none | auto",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Overscroll Behavior"
        ],
        initial: "auto",
        appliesto: "nonReplacedBlockAndInlineBlockElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/overscroll-behavior-y"
      },
      padding: {
        syntax: "<'padding-top'>{1,4}",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "referToWidthOfContainingBlock",
        groups: [
          "CSS Box Model"
        ],
        initial: [
          "padding-bottom",
          "padding-left",
          "padding-right",
          "padding-top"
        ],
        appliesto: "allElementsExceptInternalTableDisplayTypes",
        computed: [
          "padding-bottom",
          "padding-left",
          "padding-right",
          "padding-top"
        ],
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/padding"
      },
      "padding-block": {
        syntax: "<'padding-top'>{1,2}",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "logicalWidthOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: [
          "padding-block-start",
          "padding-block-end"
        ],
        appliesto: "allElementsExceptInternalTableDisplayTypes",
        computed: [
          "padding-block-start",
          "padding-block-end"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/padding-block"
      },
      "padding-block-end": {
        syntax: "<'padding-top'>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "logicalWidthOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "0",
        appliesto: "allElementsExceptInternalTableDisplayTypes",
        computed: "asLength",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/padding-block-end"
      },
      "padding-block-start": {
        syntax: "<'padding-top'>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "logicalWidthOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "0",
        appliesto: "allElementsExceptInternalTableDisplayTypes",
        computed: "asLength",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/padding-block-start"
      },
      "padding-bottom": {
        syntax: "<length-percentage [0,\u221E]>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "referToWidthOfContainingBlock",
        groups: [
          "CSS Box Model"
        ],
        initial: "0",
        appliesto: "allElementsExceptInternalTableDisplayTypes",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/padding-bottom"
      },
      "padding-inline": {
        syntax: "<'padding-top'>{1,2}",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "logicalWidthOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: [
          "padding-inline-start",
          "padding-inline-end"
        ],
        appliesto: "allElementsExceptInternalTableDisplayTypes",
        computed: [
          "padding-inline-start",
          "padding-inline-end"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/padding-inline"
      },
      "padding-inline-end": {
        syntax: "<'padding-top'>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "logicalWidthOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "0",
        appliesto: "allElementsExceptInternalTableDisplayTypes",
        computed: "asLength",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/padding-inline-end"
      },
      "padding-inline-start": {
        syntax: "<'padding-top'>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "logicalWidthOfContainingBlock",
        groups: [
          "CSS Logical Properties and Values"
        ],
        initial: "0",
        appliesto: "allElementsExceptInternalTableDisplayTypes",
        computed: "asLength",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/padding-inline-start"
      },
      "padding-left": {
        syntax: "<length-percentage [0,\u221E]>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "referToWidthOfContainingBlock",
        groups: [
          "CSS Box Model"
        ],
        initial: "0",
        appliesto: "allElementsExceptInternalTableDisplayTypes",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/padding-left"
      },
      "padding-right": {
        syntax: "<length-percentage [0,\u221E]>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "referToWidthOfContainingBlock",
        groups: [
          "CSS Box Model"
        ],
        initial: "0",
        appliesto: "allElementsExceptInternalTableDisplayTypes",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/padding-right"
      },
      "padding-top": {
        syntax: "<length-percentage [0,\u221E]>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "referToWidthOfContainingBlock",
        groups: [
          "CSS Box Model"
        ],
        initial: "0",
        appliesto: "allElementsExceptInternalTableDisplayTypes",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/padding-top"
      },
      page: {
        syntax: "auto | <custom-ident>",
        media: "paged",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Paged Media"
        ],
        initial: "auto",
        appliesto: "blockElementsInNormalFlow",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/page"
      },
      "page-break-after": {
        syntax: "auto | always | avoid | left | right | recto | verso",
        media: [
          "visual",
          "paged"
        ],
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Paged Media"
        ],
        initial: "auto",
        appliesto: "blockElementsInNormalFlow",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "obsolete",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/page-break-after"
      },
      "page-break-before": {
        syntax: "auto | always | avoid | left | right | recto | verso",
        media: [
          "visual",
          "paged"
        ],
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Paged Media"
        ],
        initial: "auto",
        appliesto: "blockElementsInNormalFlow",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "obsolete",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/page-break-before"
      },
      "page-break-inside": {
        syntax: "auto | avoid",
        media: [
          "visual",
          "paged"
        ],
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Paged Media"
        ],
        initial: "auto",
        appliesto: "blockElementsInNormalFlow",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "obsolete",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/page-break-inside"
      },
      "paint-order": {
        syntax: "normal | [ fill || stroke || markers ]",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "normal",
        appliesto: "textElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/paint-order"
      },
      perspective: {
        syntax: "none | <length>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "no",
        groups: [
          "CSS Transforms"
        ],
        initial: "none",
        appliesto: "transformableElements",
        computed: "absoluteLengthOrNone",
        order: "uniqueOrder",
        stacking: true,
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/perspective"
      },
      "perspective-origin": {
        syntax: "<position>",
        media: "visual",
        inherited: false,
        animationType: "simpleListOfLpc",
        percentages: "referToSizeOfBoundingBox",
        groups: [
          "CSS Transforms"
        ],
        initial: "50% 50%",
        appliesto: "transformableElements",
        computed: "forLengthAbsoluteValueOtherwisePercentage",
        order: "oneOrTwoValuesLengthAbsoluteKeywordsPercentages",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/perspective-origin"
      },
      "place-content": {
        syntax: "<'align-content'> <'justify-content'>?",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Box Alignment"
        ],
        initial: [
          "align-content",
          "justify-content"
        ],
        appliesto: "multilineFlexContainers",
        computed: [
          "align-content",
          "justify-content"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/place-content"
      },
      "place-items": {
        syntax: "<'align-items'> <'justify-items'>?",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Box Alignment"
        ],
        initial: [
          "align-items",
          "justify-items"
        ],
        appliesto: "allElements",
        computed: [
          "align-items",
          "justify-items"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/place-items"
      },
      "place-self": {
        syntax: "<'align-self'> <'justify-self'>?",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Box Alignment"
        ],
        initial: [
          "align-self",
          "justify-self"
        ],
        appliesto: "blockLevelBoxesAndAbsolutelyPositionedBoxesAndGridItems",
        computed: [
          "align-self",
          "justify-self"
        ],
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/place-self"
      },
      "pointer-events": {
        syntax: "auto | none | visiblePainted | visibleFill | visibleStroke | visible | painted | fill | stroke | all | inherit",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/pointer-events"
      },
      position: {
        syntax: "static | relative | absolute | sticky | fixed",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Positioned Layout"
        ],
        initial: "static",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        stacking: true,
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/position"
      },
      "position-anchor": {
        syntax: "auto | none | <anchor-name>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Anchor Positioning"
        ],
        initial: "none",
        appliesto: "absolutelyPositionedElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/position-anchor"
      },
      "position-area": {
        syntax: "none | <position-area>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Anchor Positioning"
        ],
        initial: "none",
        appliesto: "positionedElementsWithADefaultAnchorElement",
        computed: "asSpecified",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/position-area"
      },
      "position-try": {
        syntax: "<'position-try-order'>? <'position-try-fallbacks'>",
        media: "visual",
        inherited: false,
        animationType: [
          "position-try-fallbacks",
          "position-try-order"
        ],
        percentages: [
          "position-try-fallbacks",
          "position-try-order"
        ],
        groups: [
          "CSS Anchor Positioning"
        ],
        initial: [
          "position-try-fallbacks",
          "position-try-order"
        ],
        appliesto: "absolutelyPositionedElements",
        computed: [
          "position-try-fallbacks",
          "position-try-order"
        ],
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/position-try"
      },
      "position-try-fallbacks": {
        syntax: "none | [ [<dashed-ident> || <try-tactic>] | <'position-area'> ]#",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Anchor Positioning"
        ],
        initial: "none",
        appliesto: "absolutelyPositionedElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/position-try-fallbacks"
      },
      "position-try-order": {
        syntax: "normal | <try-size>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Anchor Positioning"
        ],
        initial: "normal",
        appliesto: "absolutelyPositionedElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/position-try-order"
      },
      "position-visibility": {
        syntax: "always | [ anchors-valid || anchors-visible || no-overflow ]",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Anchor Positioning"
        ],
        initial: "anchors-visible",
        appliesto: "absolutelyPositionedElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/position-visibility"
      },
      "print-color-adjust": {
        syntax: "economy | exact",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Color"
        ],
        initial: "economy",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/print-color-adjust"
      },
      quotes: {
        syntax: "none | auto | [ <string> <string> ]+",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Generated Content"
        ],
        initial: "dependsOnUserAgent",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/quotes"
      },
      r: {
        syntax: "<length> | <percentage>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "referToSVGViewportSize",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "0",
        appliesto: "limitedSVGElementsCircle",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/r"
      },
      "reading-flow": {
        syntax: "normal | source-order | flex-visual | flex-flow | grid-rows | grid-columns | grid-order",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Display"
        ],
        initial: "normal",
        appliesto: "blockContainersFlexContainersGridContainers",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/reading-flow"
      },
      "reading-order": {
        syntax: "<integer>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Display"
        ],
        initial: "0",
        appliesto: "blockContainersFlexContainersGridContainers",
        computed: "specifiedInteger",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/reading-order"
      },
      resize: {
        syntax: "none | both | horizontal | vertical | block | inline",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: "none",
        appliesto: "elementsWithOverflowNotVisibleAndReplacedElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/resize"
      },
      right: {
        syntax: "auto | <length-percentage> | <anchor()> | <anchor-size()>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToWidthOfContainingBlock",
        groups: [
          "CSS Anchor Positioning",
          "CSS Positioned Layout"
        ],
        initial: "auto",
        appliesto: "positionedElements",
        computed: "lengthAbsolutePercentageAsSpecifiedOtherwiseAuto",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/right"
      },
      rotate: {
        syntax: "none | <angle> | [ x | y | z | <number>{3} ] && <angle>",
        media: "visual",
        inherited: false,
        animationType: "transform",
        percentages: "no",
        groups: [
          "CSS Transforms"
        ],
        initial: "none",
        appliesto: "transformableElements",
        computed: "asSpecified",
        order: "perGrammar",
        stacking: true,
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/rotate"
      },
      "row-gap": {
        syntax: "normal | <length-percentage>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToDimensionOfContentArea",
        groups: [
          "CSS Box Alignment"
        ],
        initial: "normal",
        appliesto: "multiColumnElementsFlexContainersGridContainers",
        computed: "asSpecifiedWithLengthsAbsoluteAndNormalComputingToZeroExceptMultiColumn",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/row-gap"
      },
      "ruby-align": {
        syntax: "start | center | space-between | space-around",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Ruby"
        ],
        initial: "space-around",
        appliesto: "rubyBasesAnnotationsBaseAnnotationContainers",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/ruby-align"
      },
      "ruby-merge": {
        syntax: "separate | collapse | auto",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Ruby"
        ],
        initial: "separate",
        appliesto: "rubyAnnotationContainers",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "experimental"
      },
      "ruby-overhang": {
        syntax: "auto | none",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Ruby"
        ],
        initial: "auto",
        appliesto: "rubyAnnotationContainers",
        computed: "theSpecifiedKeyword",
        order: "perGrammar",
        status: "standard"
      },
      "ruby-position": {
        syntax: "[ alternate || [ over | under ] ] | inter-character",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Ruby"
        ],
        initial: "alternate",
        appliesto: "rubyAnnotationContainers",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/ruby-position"
      },
      rx: {
        syntax: "<length> | <percentage>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "referToSVGViewportWidth",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "0",
        appliesto: "limitedSVGElementsEllipseRect",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/rx"
      },
      ry: {
        syntax: "<length> | <percentage>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "referToSVGViewportHeight",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "0",
        appliesto: "limitedSVGElementsEllipseRect",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/ry"
      },
      scale: {
        syntax: "none | [ <number> | <percentage> ]{1,3}",
        media: "visual",
        inherited: false,
        animationType: "transform",
        percentages: "no",
        groups: [
          "CSS Transforms"
        ],
        initial: "none",
        appliesto: "transformableElements",
        computed: "asSpecified",
        order: "perGrammar",
        stacking: true,
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scale"
      },
      "scroll-behavior": {
        syntax: "auto | smooth",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Overflow"
        ],
        initial: "auto",
        appliesto: "scrollingBoxes",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-behavior"
      },
      "scroll-initial-target": {
        syntax: "none | nearest",
        media: "noPracticalMedia",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "theSpecifiedKeyword",
        order: "perGrammar",
        status: "experimental"
      },
      "scroll-margin": {
        syntax: "<length>{1,4}",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: [
          "scroll-margin-bottom",
          "scroll-margin-left",
          "scroll-margin-right",
          "scroll-margin-top"
        ],
        appliesto: "allElements",
        computed: [
          "scroll-margin-bottom",
          "scroll-margin-left",
          "scroll-margin-right",
          "scroll-margin-top"
        ],
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-margin"
      },
      "scroll-margin-block": {
        syntax: "<length>{1,2}",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: [
          "scroll-margin-block-start",
          "scroll-margin-block-end"
        ],
        appliesto: "allElements",
        computed: [
          "scroll-margin-block-start",
          "scroll-margin-block-end"
        ],
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-margin-block"
      },
      "scroll-margin-block-end": {
        syntax: "<length>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "0",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-margin-block-end"
      },
      "scroll-margin-block-start": {
        syntax: "<length>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "0",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-margin-block-start"
      },
      "scroll-margin-bottom": {
        syntax: "<length>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "0",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-margin-bottom"
      },
      "scroll-margin-inline": {
        syntax: "<length>{1,2}",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: [
          "scroll-margin-inline-start",
          "scroll-margin-inline-end"
        ],
        appliesto: "allElements",
        computed: [
          "scroll-margin-inline-start",
          "scroll-margin-inline-end"
        ],
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-margin-inline"
      },
      "scroll-margin-inline-end": {
        syntax: "<length>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "0",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-margin-inline-end"
      },
      "scroll-margin-inline-start": {
        syntax: "<length>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "0",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-margin-inline-start"
      },
      "scroll-margin-left": {
        syntax: "<length>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "0",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-margin-left"
      },
      "scroll-margin-right": {
        syntax: "<length>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "0",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-margin-right"
      },
      "scroll-margin-top": {
        syntax: "<length>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "0",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-margin-top"
      },
      "scroll-marker-group": {
        syntax: "none | before | after",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Overflow"
        ],
        initial: "none",
        appliesto: "scrollContainers",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-marker-group"
      },
      "scroll-padding": {
        syntax: "[ auto | <length-percentage> ]{1,4}",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "relativeToTheScrollContainersScrollport",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: [
          "scroll-padding-bottom",
          "scroll-padding-left",
          "scroll-padding-right",
          "scroll-padding-top"
        ],
        appliesto: "scrollContainers",
        computed: [
          "scroll-padding-bottom",
          "scroll-padding-left",
          "scroll-padding-right",
          "scroll-padding-top"
        ],
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-padding"
      },
      "scroll-padding-block": {
        syntax: "[ auto | <length-percentage> ]{1,2}",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "relativeToTheScrollContainersScrollport",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: [
          "scroll-padding-block-start",
          "scroll-padding-block-end"
        ],
        appliesto: "scrollContainers",
        computed: [
          "scroll-padding-block-start",
          "scroll-padding-block-end"
        ],
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-padding-block"
      },
      "scroll-padding-block-end": {
        syntax: "auto | <length-percentage>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "relativeToTheScrollContainersScrollport",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "auto",
        appliesto: "scrollContainers",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-padding-block-end"
      },
      "scroll-padding-block-start": {
        syntax: "auto | <length-percentage>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "relativeToTheScrollContainersScrollport",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "auto",
        appliesto: "scrollContainers",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-padding-block-start"
      },
      "scroll-padding-bottom": {
        syntax: "auto | <length-percentage>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "relativeToTheScrollContainersScrollport",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "auto",
        appliesto: "scrollContainers",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-padding-bottom"
      },
      "scroll-padding-inline": {
        syntax: "[ auto | <length-percentage> ]{1,2}",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "relativeToTheScrollContainersScrollport",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: [
          "scroll-padding-inline-start",
          "scroll-padding-inline-end"
        ],
        appliesto: "scrollContainers",
        computed: [
          "scroll-padding-inline-start",
          "scroll-padding-inline-end"
        ],
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-padding-inline"
      },
      "scroll-padding-inline-end": {
        syntax: "auto | <length-percentage>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "relativeToTheScrollContainersScrollport",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "auto",
        appliesto: "scrollContainers",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-padding-inline-end"
      },
      "scroll-padding-inline-start": {
        syntax: "auto | <length-percentage>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "relativeToTheScrollContainersScrollport",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "auto",
        appliesto: "scrollContainers",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-padding-inline-start"
      },
      "scroll-padding-left": {
        syntax: "auto | <length-percentage>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "relativeToTheScrollContainersScrollport",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "auto",
        appliesto: "scrollContainers",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-padding-left"
      },
      "scroll-padding-right": {
        syntax: "auto | <length-percentage>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "relativeToTheScrollContainersScrollport",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "auto",
        appliesto: "scrollContainers",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-padding-right"
      },
      "scroll-padding-top": {
        syntax: "auto | <length-percentage>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "relativeToTheScrollContainersScrollport",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "auto",
        appliesto: "scrollContainers",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-padding-top"
      },
      "scroll-snap-align": {
        syntax: "[ none | start | end | center ]{1,2}",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-snap-align"
      },
      "scroll-snap-coordinate": {
        syntax: "none | <position>#",
        media: "interactive",
        inherited: false,
        animationType: "position",
        percentages: "referToBorderBox",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "uniqueOrder",
        status: "obsolete"
      },
      "scroll-snap-destination": {
        syntax: "<position>",
        media: "interactive",
        inherited: false,
        animationType: "position",
        percentages: "relativeToScrollContainerPaddingBoxAxis",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "0px 0px",
        appliesto: "scrollContainers",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "uniqueOrder",
        status: "obsolete"
      },
      "scroll-snap-points-x": {
        syntax: "none | repeat( <length-percentage> )",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "relativeToScrollContainerPaddingBoxAxis",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "none",
        appliesto: "scrollContainers",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "uniqueOrder",
        status: "obsolete"
      },
      "scroll-snap-points-y": {
        syntax: "none | repeat( <length-percentage> )",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "relativeToScrollContainerPaddingBoxAxis",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "none",
        appliesto: "scrollContainers",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "uniqueOrder",
        status: "obsolete"
      },
      "scroll-snap-stop": {
        syntax: "normal | always",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-snap-stop"
      },
      "scroll-snap-type": {
        syntax: "none | [ x | y | block | inline | both ] [ mandatory | proximity ]?",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-snap-type"
      },
      "scroll-snap-type-x": {
        syntax: "none | mandatory | proximity",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "none",
        appliesto: "scrollContainers",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "obsolete"
      },
      "scroll-snap-type-y": {
        syntax: "none | mandatory | proximity",
        media: "interactive",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Scroll Snap"
        ],
        initial: "none",
        appliesto: "scrollContainers",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "obsolete"
      },
      "scroll-target-group": {
        syntax: "none | auto",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Overflow"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-target-group"
      },
      "scroll-timeline": {
        syntax: "[ <'scroll-timeline-name'> <'scroll-timeline-axis'>? ]#",
        media: "visual",
        inherited: false,
        animationType: [
          "scroll-timeline-name",
          "scroll-timeline-axis"
        ],
        percentages: "no",
        groups: [
          "Scroll-driven Animations"
        ],
        initial: [
          "scroll-timeline-name",
          "scroll-timeline-axis"
        ],
        appliesto: "scrollContainers",
        computed: [
          "scroll-timeline-name",
          "scroll-timeline-axis"
        ],
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-timeline"
      },
      "scroll-timeline-axis": {
        syntax: "[ block | inline | x | y ]#",
        media: "interactive",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "Scroll-driven Animations"
        ],
        initial: "block",
        appliesto: "scrollContainers",
        computed: "asSpecified",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-timeline-axis"
      },
      "scroll-timeline-name": {
        syntax: "[ none | <dashed-ident> ]#",
        media: "interactive",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "Scroll-driven Animations"
        ],
        initial: "none",
        appliesto: "scrollContainers",
        computed: "noneOrOrderedListOfIdentifiers",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scroll-timeline-name"
      },
      "scrollbar-color": {
        syntax: "auto | <color>{2}",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Scrollbars Styling"
        ],
        initial: "auto",
        appliesto: "scrollingBoxes",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scrollbar-color"
      },
      "scrollbar-gutter": {
        syntax: "auto | stable && both-edges?",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Overflow"
        ],
        initial: "auto",
        appliesto: "scrollingBoxes",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scrollbar-gutter"
      },
      "scrollbar-width": {
        syntax: "auto | thin | none",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Scrollbars Styling"
        ],
        initial: "auto",
        appliesto: "scrollingBoxes",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/scrollbar-width"
      },
      "shape-image-threshold": {
        syntax: "<opacity-value>",
        media: "visual",
        inherited: false,
        animationType: "number",
        percentages: "no",
        groups: [
          "CSS Shapes"
        ],
        initial: "0.0",
        appliesto: "floats",
        computed: "specifiedValueNumberClipped0To1",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/shape-image-threshold"
      },
      "shape-margin": {
        syntax: "<length-percentage>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToWidthOfContainingBlock",
        groups: [
          "CSS Shapes"
        ],
        initial: "0",
        appliesto: "floats",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/shape-margin"
      },
      "shape-outside": {
        syntax: "none | [ <shape-box> || <basic-shape> ] | <image>",
        media: "visual",
        inherited: false,
        animationType: "basicShapeOtherwiseNo",
        percentages: "no",
        groups: [
          "CSS Shapes"
        ],
        initial: "none",
        appliesto: "floats",
        computed: "asDefinedForBasicShapeWithAbsoluteURIOtherwiseAsSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/shape-outside"
      },
      "shape-rendering": {
        syntax: "auto | optimizeSpeed | crispEdges | geometricPrecision",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "auto",
        appliesto: "limitedSVGElementsShapes",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/shape-rendering"
      },
      "speak-as": {
        syntax: "normal | spell-out || digits || [ literal-punctuation | no-punctuation ]",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Speech"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "specifiedValue",
        order: "perGrammar",
        status: "experimental"
      },
      "stop-color": {
        syntax: "<'color'>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "black",
        appliesto: "limitedSVGElementsStop",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/stop-color"
      },
      "stop-opacity": {
        syntax: "<'opacity'>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "black",
        appliesto: "limitedSVGElementsStop",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/stop-opacity"
      },
      stroke: {
        syntax: "<paint>",
        media: "visual",
        inherited: true,
        animationType: [
          "stroke-dasharray",
          "stroke-dashoffset",
          "stroke-linecap",
          "stroke-linejoin",
          "stroke-miterlimit",
          "stroke-opacity",
          "stroke-width"
        ],
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: [
          "stroke-dasharray",
          "stroke-dashoffset",
          "stroke-linecap",
          "stroke-linejoin",
          "stroke-miterlimit",
          "stroke-opacity",
          "stroke-width"
        ],
        appliesto: "asLonghands",
        computed: "asLonghands",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/stroke"
      },
      "stroke-color": {
        syntax: "<color>",
        media: "visual",
        inherited: true,
        animationType: "byComputedValue",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "transparent",
        appliesto: "textAndSVGShapes",
        computed: "computedColor",
        order: "perGrammar",
        status: "experimental"
      },
      "stroke-dasharray": {
        syntax: "none | <dasharray>",
        media: "visual",
        inherited: true,
        animationType: "repeatableList",
        percentages: "referToSVGViewportDiagonal",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "none",
        appliesto: "limitedSVGElementsShapes",
        computed: "listEachItemConsistingOfAbsoluteLengthPercentageOrKeyword",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/stroke-dasharray"
      },
      "stroke-dashoffset": {
        syntax: "<length-percentage> | <number>",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "referToSVGViewportDiagonal",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "0",
        appliesto: "limitedSVGElementsShapes",
        computed: "absoluteLengthOrPercentageNumbersConverted",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/stroke-dashoffset"
      },
      "stroke-linecap": {
        syntax: "butt | round | square",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "butt",
        appliesto: "limitedSVGElementsShapes",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/stroke-linecap"
      },
      "stroke-linejoin": {
        syntax: "miter | miter-clip | round | bevel | arcs",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "miter",
        appliesto: "limitedSVGElementsShapes",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/stroke-linejoin"
      },
      "stroke-miterlimit": {
        syntax: "<number>",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "4",
        appliesto: "limitedSVGElementsShapes",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/stroke-miterlimit"
      },
      "stroke-opacity": {
        syntax: "<'opacity'>",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "1",
        appliesto: "limitedSVGElementsShapes",
        computed: "specifiedValueClipped0To1",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/stroke-opacity"
      },
      "stroke-width": {
        syntax: "<length-percentage> | <number>",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "referToSVGViewportDiagonal",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "1px",
        appliesto: "limitedSVGElementsShapes",
        computed: "absoluteLengthOrPercentageNumbersConverted",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/stroke-width"
      },
      "tab-size": {
        syntax: "<integer> | <length>",
        media: "visual",
        inherited: true,
        animationType: "length",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "8",
        appliesto: "blockContainers",
        computed: "specifiedIntegerOrAbsoluteLength",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/tab-size"
      },
      "table-layout": {
        syntax: "auto | fixed",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Table"
        ],
        initial: "auto",
        appliesto: "tableElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/table-layout"
      },
      "text-align": {
        syntax: "start | end | left | right | center | justify | match-parent",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "startOrNamelessValueIfLTRRightIfRTL",
        appliesto: "blockContainers",
        computed: "asSpecifiedExceptMatchParent",
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-align"
      },
      "text-align-last": {
        syntax: "auto | start | end | left | right | center | justify",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "auto",
        appliesto: "blockContainers",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-align-last"
      },
      "text-anchor": {
        syntax: "start | middle | end",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "start",
        appliesto: "limitedSVGElementsTextContent",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-anchor"
      },
      "text-autospace": {
        syntax: "normal | <autospace> | auto",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "normal",
        appliesto: "textElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-autospace"
      },
      "text-box": {
        syntax: "normal | <'text-box-trim'> || <'text-box-edge'>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Inline"
        ],
        initial: "normal",
        appliesto: "blockContainersAndInlineBoxes",
        computed: "theSpecifiedKeyword",
        order: "perGrammar",
        status: "standard"
      },
      "text-box-edge": {
        syntax: "auto | <text-edge>",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Inline"
        ],
        initial: "auto",
        appliesto: "blockContainersAndInlineBoxes",
        computed: "theSpecifiedKeyword",
        order: "perGrammar",
        status: "standard"
      },
      "text-box-trim": {
        syntax: "none | trim-start | trim-end | trim-both",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Inline"
        ],
        initial: "none",
        appliesto: "blockContainersAndInlineBoxes",
        computed: "theSpecifiedKeyword",
        order: "perGrammar",
        status: "standard"
      },
      "text-combine-upright": {
        syntax: "none | all | [ digits <integer>? ]",
        media: "visual",
        inherited: true,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Writing Modes"
        ],
        initial: "none",
        appliesto: "nonReplacedInlineElements",
        computed: "keywordPlusIntegerIfDigits",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-combine-upright"
      },
      "text-decoration": {
        syntax: "<'text-decoration-line'> || <'text-decoration-style'> || <'text-decoration-color'> || <'text-decoration-thickness'>",
        media: "visual",
        inherited: false,
        animationType: [
          "text-decoration-color",
          "text-decoration-style",
          "text-decoration-line",
          "text-decoration-thickness"
        ],
        percentages: "no",
        groups: [
          "CSS Text Decoration"
        ],
        initial: [
          "text-decoration-color",
          "text-decoration-style",
          "text-decoration-line"
        ],
        appliesto: "allElements",
        computed: [
          "text-decoration-line",
          "text-decoration-style",
          "text-decoration-color",
          "text-decoration-thickness"
        ],
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-decoration"
      },
      "text-decoration-color": {
        syntax: "<color>",
        media: "visual",
        inherited: false,
        animationType: "color",
        percentages: "no",
        groups: [
          "CSS Text Decoration"
        ],
        initial: "currentcolor",
        appliesto: "allElements",
        computed: "computedColor",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-decoration-color"
      },
      "text-decoration-inset": {
        syntax: "<length>{1,2} | auto",
        media: "visual",
        inherited: false,
        animationType: "byComputedValue",
        percentages: "no",
        groups: [
          "CSS Text Decoration"
        ],
        initial: "0",
        appliesto: "allElements",
        computed: "absoluteLengthOrKeyword",
        order: "perGrammar",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-decoration-inset"
      },
      "text-decoration-line": {
        syntax: "none | [ underline || overline || line-through || blink ] | spelling-error | grammar-error",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text Decoration"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "orderOfAppearance",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-decoration-line"
      },
      "text-decoration-skip": {
        syntax: "none | [ objects || [ spaces | [ leading-spaces || trailing-spaces ] ] || edges || box-decoration ]",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text Decoration"
        ],
        initial: "objects",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "orderOfAppearance",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-decoration-skip"
      },
      "text-decoration-skip-ink": {
        syntax: "auto | all | none",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text Decoration"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "orderOfAppearance",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-decoration-skip-ink"
      },
      "text-decoration-style": {
        syntax: "solid | double | dotted | dashed | wavy",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text Decoration"
        ],
        initial: "solid",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-decoration-style"
      },
      "text-decoration-thickness": {
        syntax: "auto | from-font | <length> | <percentage>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "referToElementFontSize",
        groups: [
          "CSS Text Decoration"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-decoration-thickness"
      },
      "text-emphasis": {
        syntax: "<'text-emphasis-style'> || <'text-emphasis-color'>",
        media: "visual",
        inherited: true,
        animationType: [
          "text-emphasis-color",
          "text-emphasis-style"
        ],
        percentages: "no",
        groups: [
          "CSS Text Decoration"
        ],
        initial: [
          "text-emphasis-style",
          "text-emphasis-color"
        ],
        appliesto: "allElements",
        computed: [
          "text-emphasis-style",
          "text-emphasis-color"
        ],
        order: "orderOfAppearance",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-emphasis"
      },
      "text-emphasis-color": {
        syntax: "<color>",
        media: "visual",
        inherited: true,
        animationType: "color",
        percentages: "no",
        groups: [
          "CSS Text Decoration"
        ],
        initial: "currentcolor",
        appliesto: "allElements",
        computed: "computedColor",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-emphasis-color"
      },
      "text-emphasis-position": {
        syntax: "auto | [ over | under ] && [ right | left ]?",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text Decoration"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-emphasis-position"
      },
      "text-emphasis-style": {
        syntax: "none | [ [ filled | open ] || [ dot | circle | double-circle | triangle | sesame ] ] | <string>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text Decoration"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-emphasis-style"
      },
      "text-indent": {
        syntax: "<length-percentage> && hanging? && each-line?",
        media: "visual",
        inherited: true,
        animationType: "lpc",
        percentages: "referToWidthOfContainingBlock",
        groups: [
          "CSS Text"
        ],
        initial: "0",
        appliesto: "blockContainers",
        computed: "percentageOrAbsoluteLengthPlusKeywords",
        order: "lengthOrPercentageBeforeKeywords",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-indent"
      },
      "text-justify": {
        syntax: "auto | inter-character | inter-word | none",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "auto",
        appliesto: "inlineLevelAndTableCellElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-justify"
      },
      "text-orientation": {
        syntax: "mixed | upright | sideways",
        media: "visual",
        inherited: true,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Writing Modes"
        ],
        initial: "mixed",
        appliesto: "allElementsExceptTableRowGroupsRowsColumnGroupsAndColumns",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-orientation"
      },
      "text-overflow": {
        syntax: "[ clip | ellipsis | <string> ]{1,2}",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Overflow"
        ],
        initial: "clip",
        appliesto: "blockContainerElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-overflow"
      },
      "text-rendering": {
        syntax: "auto | optimizeSpeed | optimizeLegibility | geometricPrecision",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "auto",
        appliesto: "textElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-rendering"
      },
      "text-shadow": {
        syntax: "none | <shadow-t>#",
        media: "visual",
        inherited: true,
        animationType: "shadowList",
        percentages: "no",
        groups: [
          "CSS Text Decoration"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "colorPlusThreeAbsoluteLengths",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-shadow"
      },
      "text-size-adjust": {
        syntax: "none | auto | <percentage>",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "referToSizeOfFont",
        groups: [
          "CSS Mobile Text Size Adjustment"
        ],
        initial: "autoForSmartphoneBrowsersSupportingInflation",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-size-adjust"
      },
      "text-spacing-trim": {
        syntax: "space-all | normal | space-first | trim-start",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "normal",
        appliesto: "textElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-spacing-trim"
      },
      "text-transform": {
        syntax: "none | [ capitalize | uppercase | lowercase ] || full-width || full-size-kana | math-auto",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text",
          "MathML"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-transform"
      },
      "text-underline-offset": {
        syntax: "auto | <length> | <percentage>",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "referToElementFontSize",
        groups: [
          "CSS Text Decoration"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-underline-offset"
      },
      "text-underline-position": {
        syntax: "auto | from-font | [ under || [ left | right ] ]",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text Decoration"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "orderOfAppearance",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-underline-position"
      },
      "text-wrap": {
        syntax: "<'text-wrap-mode'> || <'text-wrap-style'>",
        media: "visual",
        inherited: true,
        animationType: [
          "text-wrap-mode",
          "text-wrap-style"
        ],
        percentages: [
          "text-wrap-mode",
          "text-wrap-style"
        ],
        groups: [
          "CSS Text"
        ],
        initial: "wrap",
        appliesto: "textAndBlockContainers",
        computed: [
          "text-wrap-mode",
          "text-wrap-style"
        ],
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-wrap"
      },
      "text-wrap-mode": {
        syntax: "wrap | nowrap",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "wrap",
        appliesto: "textAndBlockContainers",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-wrap-mode"
      },
      "text-wrap-style": {
        syntax: "auto | balance | stable | pretty",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "auto",
        appliesto: "textAndBlockContainers",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/text-wrap-style"
      },
      "timeline-scope": {
        syntax: "none | <dashed-ident>#",
        media: "interactive",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "Scroll-driven Animations"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "noneOrOrderedListOfIdentifiers",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/timeline-scope"
      },
      "timeline-trigger": {
        syntax: "none | [ <'timeline-trigger-name'> <'timeline-trigger-source'> <'timeline-trigger-range'> [ '/' <'timeline-trigger-exit-range'> ]? ]#",
        media: "visual",
        inherited: false,
        animationType: [
          "timeline-trigger-name",
          "timeline-trigger-source",
          "timeline-trigger-range",
          "timeline-trigger-exit-range"
        ],
        percentages: "no",
        groups: [
          "CSS Animations"
        ],
        initial: [
          "timeline-trigger-name",
          "timeline-trigger-source",
          "timeline-trigger-range",
          "timeline-trigger-exit-range"
        ],
        appliesto: "allElements",
        computed: [
          "timeline-trigger-name",
          "timeline-trigger-source",
          "timeline-trigger-range",
          "timeline-trigger-exit-range"
        ],
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/Reference/Properties/timeline-trigger"
      },
      "timeline-trigger-name": {
        syntax: "none | <dashed-ident>#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Animations"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/Reference/Properties/timeline-trigger-name"
      },
      "timeline-trigger-exit-range": {
        syntax: "[ <'timeline-trigger-exit-range-start'> <'timeline-trigger-exit-range-end'>? ]#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: [
          "timeline-trigger-exit-range-start",
          "timeline-trigger-exit-range-end"
        ],
        groups: [
          "CSS Animations"
        ],
        initial: [
          "timeline-trigger-exit-range-start",
          "timeline-trigger-exit-range-end"
        ],
        appliesto: "allElements",
        computed: [
          "timeline-trigger-exit-range-start",
          "timeline-trigger-exit-range-end"
        ],
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/Reference/Properties/timeline-trigger-exit-range"
      },
      "timeline-trigger-exit-range-end": {
        syntax: "[ auto | normal | <length-percentage> | <timeline-range-name> <length-percentage>? ]#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "relativeToTimelineRangeIfSpecifiedOtherwiseEntireTimeline",
        groups: [
          "CSS Animations"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "listEachItemConsistingOfNormalLengthPercentageOrNameLengthPercentage",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/Reference/Properties/timeline-trigger-exit-range-end"
      },
      "timeline-trigger-exit-range-start": {
        syntax: "[ auto | normal | <length-percentage> | <timeline-range-name> <length-percentage>? ]#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "relativeToTimelineRangeIfSpecifiedOtherwiseEntireTimeline",
        groups: [
          "CSS Animations"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "listEachItemConsistingOfNormalLengthPercentageOrNameLengthPercentage",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/Reference/Properties/timeline-trigger-exit-range-start"
      },
      "timeline-trigger-range": {
        syntax: "[ <'timeline-trigger-range-start'> <'timeline-trigger-range-end'>? ]#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: [
          "timeline-trigger-range-start",
          "timeline-trigger-range-end"
        ],
        groups: [
          "CSS Animations"
        ],
        initial: [
          "timeline-trigger-range-start",
          "timeline-trigger-range-end"
        ],
        appliesto: "allElements",
        computed: [
          "timeline-trigger-range-start",
          "timeline-trigger-range-end"
        ],
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/Reference/Properties/timeline-trigger-range"
      },
      "timeline-trigger-range-end": {
        syntax: "[ normal | <length-percentage> | <timeline-range-name> <length-percentage>? ]#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "relativeToTimelineRangeIfSpecifiedOtherwiseEntireTimeline",
        groups: [
          "CSS Animations"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "listEachItemConsistingOfNormalLengthPercentageOrNameLengthPercentage",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/Reference/Properties/timeline-trigger-range-end"
      },
      "timeline-trigger-range-start": {
        syntax: "[ normal | <length-percentage> | <timeline-range-name> <length-percentage>? ]#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "relativeToTimelineRangeIfSpecifiedOtherwiseEntireTimeline",
        groups: [
          "CSS Animations"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "listEachItemConsistingOfNormalLengthPercentageOrNameLengthPercentage",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/Reference/Properties/timeline-trigger-range-start"
      },
      "timeline-trigger-source": {
        syntax: "<single-animation-timeline>#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Animations"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "listOfNoneAutoIdentScrollOrView",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/Reference/Properties/timeline-trigger-source"
      },
      top: {
        syntax: "auto | <length-percentage> | <anchor()> | <anchor-size()>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToContainingBlockHeight",
        groups: [
          "CSS Anchor Positioning",
          "CSS Positioned Layout"
        ],
        initial: "auto",
        appliesto: "positionedElements",
        computed: "lengthAbsolutePercentageAsSpecifiedOtherwiseAuto",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/top"
      },
      "touch-action": {
        syntax: "auto | none | [ [ pan-x | pan-left | pan-right ] || [ pan-y | pan-up | pan-down ] || pinch-zoom ] | manipulation",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "Pointer Events"
        ],
        initial: "auto",
        appliesto: "allElementsExceptNonReplacedInlineElementsTableRowsColumnsRowColumnGroups",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/touch-action"
      },
      transform: {
        syntax: "none | <transform-list>",
        media: "visual",
        inherited: false,
        animationType: "transform",
        percentages: "referToSizeOfBoundingBox",
        groups: [
          "CSS Transforms"
        ],
        initial: "none",
        appliesto: "transformableElements",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "uniqueOrder",
        stacking: true,
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/transform"
      },
      "transform-box": {
        syntax: "content-box | border-box | fill-box | stroke-box | view-box",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Transforms"
        ],
        initial: "view-box",
        appliesto: "transformableElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/transform-box"
      },
      "transform-origin": {
        syntax: "[ <length-percentage> | left | center | right | top | bottom ] | [ [ <length-percentage> | left | center | right ] && [ <length-percentage> | top | center | bottom ] ] <length>?",
        media: "visual",
        inherited: false,
        animationType: "simpleListOfLpc",
        percentages: "referToSizeOfBoundingBox",
        groups: [
          "CSS Transforms"
        ],
        initial: "50% 50% 0",
        appliesto: "transformableElements",
        computed: "forLengthAbsoluteValueOtherwisePercentage",
        order: "oneOrTwoValuesLengthAbsoluteKeywordsPercentages",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/transform-origin"
      },
      "transform-style": {
        syntax: "flat | preserve-3d",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Transforms"
        ],
        initial: "flat",
        appliesto: "transformableElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        stacking: true,
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/transform-style"
      },
      transition: {
        syntax: "<single-transition>#",
        media: "interactive",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Transitions"
        ],
        initial: [
          "transition-delay",
          "transition-duration",
          "transition-property",
          "transition-timing-function",
          "transition-behavior"
        ],
        appliesto: "allElementsAndPseudos",
        computed: [
          "transition-delay",
          "transition-duration",
          "transition-property",
          "transition-timing-function",
          "transition-behavior"
        ],
        order: "orderOfAppearance",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/transition"
      },
      "transition-behavior": {
        syntax: "<transition-behavior-value>#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Transitions"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/transition-behavior"
      },
      "transition-delay": {
        syntax: "<time>#",
        media: "interactive",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Transitions"
        ],
        initial: "0s",
        appliesto: "allElementsAndPseudos",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/transition-delay"
      },
      "transition-duration": {
        syntax: "<time>#",
        media: "interactive",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Transitions"
        ],
        initial: "0s",
        appliesto: "allElementsAndPseudos",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/transition-duration"
      },
      "transition-property": {
        syntax: "none | <single-transition-property>#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Transitions"
        ],
        initial: "all",
        appliesto: "allElementsAndPseudos",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/transition-property"
      },
      "transition-timing-function": {
        syntax: "<easing-function>#",
        media: "interactive",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Transitions"
        ],
        initial: "ease",
        appliesto: "allElementsAndPseudos",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/transition-timing-function"
      },
      translate: {
        syntax: "none | <length-percentage> [ <length-percentage> <length>? ]?",
        media: "visual",
        inherited: false,
        animationType: "transform",
        percentages: "referToSizeOfBoundingBox",
        groups: [
          "CSS Transforms"
        ],
        initial: "none",
        appliesto: "transformableElements",
        computed: "asSpecifiedRelativeToAbsoluteLengths",
        order: "perGrammar",
        stacking: true,
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/translate"
      },
      "trigger-scope": {
        syntax: "none | all | <dashed-ident>#",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Animations"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/Reference/Properties/trigger-scope"
      },
      "unicode-bidi": {
        syntax: "normal | embed | isolate | bidi-override | isolate-override | plaintext",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Writing Modes"
        ],
        initial: "normal",
        appliesto: "allElementsSomeValuesNoEffectOnNonInlineElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/unicode-bidi"
      },
      "user-select": {
        syntax: "auto | text | none | all",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Basic User Interface"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/user-select"
      },
      "vector-effect": {
        syntax: "none | non-scaling-stroke | non-scaling-size | non-rotation | fixed-position",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "none",
        appliesto: "limitedSVGElementsGraphicsAndUse",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/vector-effect"
      },
      "vertical-align": {
        syntax: "baseline | sub | super | text-top | text-bottom | middle | top | bottom | <percentage> | <length>",
        media: "visual",
        inherited: false,
        animationType: "length",
        percentages: "referToLineHeight",
        groups: [
          "CSS Inline"
        ],
        initial: "baseline",
        appliesto: "inlineLevelAndTableCellElements",
        computed: "absoluteLengthOrKeyword",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/vertical-align"
      },
      "view-timeline": {
        syntax: "[ <'view-timeline-name'> [ <'view-timeline-axis'> || <'view-timeline-inset'> ]? ]#",
        media: "visual",
        inherited: false,
        animationType: [
          "view-timeline-name",
          "view-timeline-axis"
        ],
        percentages: "no",
        groups: [
          "Scroll-driven Animations"
        ],
        initial: [
          "view-timeline-name",
          "view-timeline-axis"
        ],
        appliesto: "allElements",
        computed: [
          "view-timeline-name",
          "view-timeline-axis"
        ],
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/view-timeline"
      },
      "view-timeline-axis": {
        syntax: "[ block | inline | x | y ]#",
        media: "interactive",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "Scroll-driven Animations"
        ],
        initial: "block",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/view-timeline-axis"
      },
      "view-timeline-inset": {
        syntax: "[ [ auto | <length-percentage> ]{1,2} ]#",
        media: "interactive",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "relativeToCorrespondingDimensionOfRelevantScrollport",
        groups: [
          "Scroll-driven Animations"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "listEachItemConsistingOfPairsOfAutoOrLengthPercentage",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/view-timeline-inset"
      },
      "view-timeline-name": {
        syntax: "[ none | <dashed-ident> ]#",
        media: "interactive",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "Scroll-driven Animations"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "noneOrOrderedListOfIdentifiers",
        order: "perGrammar",
        status: "experimental",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/view-timeline-name"
      },
      "view-transition-class": {
        syntax: "none | <custom-ident>+",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS View Transitions"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard"
      },
      "view-transition-name": {
        syntax: "none | <custom-ident> | match-element",
        media: "visual",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS View Transitions"
        ],
        initial: "none",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/view-transition-name"
      },
      visibility: {
        syntax: "visible | hidden | collapse",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Display",
          "Scalable Vector Graphics"
        ],
        initial: "visible",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/visibility"
      },
      "white-space": {
        syntax: "normal | pre | pre-wrap | pre-line | <'white-space-collapse'> || <'text-wrap-mode'>",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/white-space"
      },
      "white-space-collapse": {
        syntax: "collapse | preserve | preserve-breaks | preserve-spaces | break-spaces",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "collapse",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/white-space-collapse"
      },
      widows: {
        syntax: "<integer>",
        media: "visual",
        inherited: true,
        animationType: "byComputedValueType",
        percentages: "no",
        groups: [
          "CSS Fragmentation"
        ],
        initial: "2",
        appliesto: "blockContainerElements",
        computed: "asSpecified",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/widows"
      },
      width: {
        syntax: "auto | <length-percentage [0,\u221E]> | min-content | max-content | fit-content | fit-content(<length-percentage [0,\u221E]>) | <calc-size()> | <anchor-size()>",
        media: "visual",
        inherited: false,
        animationType: "lpc",
        percentages: "referToWidthOfContainingBlock",
        groups: [
          "CSS Box Sizing"
        ],
        initial: "auto",
        appliesto: "allElementsButNonReplacedAndTableRows",
        computed: "percentageAutoOrAbsoluteLength",
        order: "lengthOrPercentageBeforeKeywordIfBothPresent",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/width"
      },
      "will-change": {
        syntax: "auto | <animateable-feature>#",
        media: "all",
        inherited: false,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Will Change"
        ],
        initial: "auto",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/will-change"
      },
      "word-break": {
        syntax: "normal | break-all | keep-all | break-word | auto-phrase",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/word-break"
      },
      "word-spacing": {
        syntax: "normal | <length>",
        media: "visual",
        inherited: true,
        animationType: "length",
        percentages: "referToWidthOfAffectedGlyph",
        groups: [
          "CSS Text"
        ],
        initial: "normal",
        appliesto: "allElements",
        computed: "absoluteLength",
        order: "uniqueOrder",
        alsoAppliesTo: [
          "::first-letter",
          "::first-line",
          "::placeholder"
        ],
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/word-spacing"
      },
      "word-wrap": {
        syntax: "normal | break-word",
        media: "visual",
        inherited: true,
        animationType: "discrete",
        percentages: "no",
        groups: [
          "CSS Text"
        ],
        initial: "normal",
        appliesto: "nonReplacedInlineElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/overflow-wrap"
      },
      "writing-mode": {
        syntax: "horizontal-tb | vertical-rl | vertical-lr | sideways-rl | sideways-lr",
        media: "visual",
        inherited: true,
        animationType: "notAnimatable",
        percentages: "no",
        groups: [
          "CSS Writing Modes"
        ],
        initial: "horizontal-tb",
        appliesto: "allElementsExceptTableRowColumnGroupsTableRowsColumns",
        computed: "asSpecified",
        order: "uniqueOrder",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/writing-mode"
      },
      x: {
        syntax: "<length> | <percentage>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "referToSVGViewportWidth",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "0",
        appliesto: "limitedSVGElementsGeometry",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/x"
      },
      y: {
        syntax: "<length> | <percentage>",
        media: "visual",
        inherited: false,
        animationType: "byComputedValueType",
        percentages: "referToSVGViewportHeight",
        groups: [
          "Scalable Vector Graphics"
        ],
        initial: "0",
        appliesto: "limitedSVGElementsGeometry",
        computed: "percentageAsSpecifiedOrAbsoluteLength",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/y"
      },
      "z-index": {
        syntax: "auto | <integer>",
        media: "visual",
        inherited: false,
        animationType: "integer",
        percentages: "no",
        groups: [
          "CSS Positioned Layout"
        ],
        initial: "auto",
        appliesto: "positionedElements",
        computed: "asSpecified",
        order: "uniqueOrder",
        stacking: true,
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/z-index"
      },
      zoom: {
        syntax: "normal | reset | <number [0,\u221E]> || <percentage [0,\u221E]>",
        media: "visual",
        inherited: false,
        animationType: "notAnimatable",
        percentages: "convertedToNumber",
        groups: [
          "CSS Viewport"
        ],
        initial: "1",
        appliesto: "allElements",
        computed: "asSpecifiedButWithPercentageConvertedToTheEquivalentNumber",
        order: "perGrammar",
        status: "standard",
        mdn_url: "https://developer.mozilla.org/docs/Web/CSS/zoom"
      }
    };
  }
});

// node_modules/mdn-data/css/syntaxes.json
var require_syntaxes = __commonJS({
  "node_modules/mdn-data/css/syntaxes.json"(exports2, module2) {
    module2.exports = {
      "abs()": {
        syntax: "abs( <calc-sum> )"
      },
      "absolute-size": {
        syntax: "xx-small | x-small | small | medium | large | x-large | xx-large | xxx-large"
      },
      "acos()": {
        syntax: "acos( <calc-sum> )"
      },
      "alpha-value": {
        syntax: "<number> | <percentage>"
      },
      "an+b": {
        syntax: "odd | even | <integer> | <n-dimension> | '+'?\u2020 n | -n | <ndashdigit-dimension> | '+'?\u2020 <ndashdigit-ident> | <dashndashdigit-ident> | <n-dimension> <signed-integer> | '+'?\u2020 n <signed-integer> | -n <signed-integer> | <ndash-dimension> <signless-integer> | '+'?\u2020 n- <signless-integer> | -n- <signless-integer> | <n-dimension> ['+' | '-'] <signless-integer> | '+'?\u2020 n ['+' | '-'] <signless-integer> | -n ['+' | '-'] <signless-integer>"
      },
      "anchor()": {
        syntax: "anchor( <anchor-name>? && <anchor-side>, <length-percentage>? )"
      },
      "anchor-name": {
        syntax: "<dashed-ident>"
      },
      "anchor-side": {
        syntax: "inside | outside | top | left | right | bottom | start | end | self-start | self-end | <percentage> | center"
      },
      "anchor-size": {
        syntax: "width | height | block | inline | self-block | self-inline"
      },
      "anchor-size()": {
        syntax: "anchor-size( [ <anchor-name> || <anchor-size> ]? , <length-percentage>? )"
      },
      "angle-percentage": {
        syntax: "<angle> | <percentage>"
      },
      "angular-color-hint": {
        syntax: "<angle-percentage> | <zero>"
      },
      "angular-color-stop": {
        syntax: "<color> <color-stop-angle>?"
      },
      "angular-color-stop-list": {
        syntax: "<angular-color-stop> , [ <angular-color-hint>? , <angular-color-stop> ]#?"
      },
      "animateable-feature": {
        syntax: "scroll-position | contents | <custom-ident>"
      },
      "animation-action": {
        syntax: "none | play | play-once | play-forwards | play-backwards | pause | reset | replay"
      },
      "asin()": {
        syntax: "asin( <calc-sum> )"
      },
      "atan()": {
        syntax: "atan( <calc-sum> )"
      },
      "atan2()": {
        syntax: "atan2( <calc-sum>, <calc-sum> )"
      },
      attachment: {
        syntax: "scroll | fixed | local"
      },
      "attr()": {
        syntax: "attr( <attr-name> <attr-type>? , <declaration-value>? )"
      },
      "attr-matcher": {
        syntax: "[ '~' | '|' | '^' | '$' | '*' ]? '='"
      },
      "attr-modifier": {
        syntax: "i | s"
      },
      "attr-type": {
        syntax: "type( <syntax> ) | raw-string | number | <attr-unit>"
      },
      "attribute-selector": {
        syntax: "'[' <wq-name> ']' | '[' <wq-name> <attr-matcher> [ <string-token> | <ident-token> ] <attr-modifier>? ']'"
      },
      "auto-repeat": {
        syntax: "repeat( [ auto-fill | auto-fit ] , [ <line-names>? <fixed-size> ]+ <line-names>? )"
      },
      "auto-track-list": {
        syntax: "[ <line-names>? [ <fixed-size> | <fixed-repeat> ] ]* <line-names>? <auto-repeat>\n[ <line-names>? [ <fixed-size> | <fixed-repeat> ] ]* <line-names>?"
      },
      axis: {
        syntax: "block | inline | x | y"
      },
      "baseline-position": {
        syntax: "[ first | last ]? baseline"
      },
      "basic-shape": {
        syntax: "<inset()> | <xywh()> | <rect()> | <circle()> | <ellipse()> | <polygon()> | <path()>"
      },
      "basic-shape-rect": {
        syntax: "<inset()> | <rect()> | <xywh()>"
      },
      "bg-clip": {
        syntax: "<visual-box> | border-area | text"
      },
      "bg-image": {
        syntax: "<image> | none"
      },
      "bg-layer": {
        syntax: "<bg-image> || <bg-position> [ / <bg-size> ]? || <repeat-style> || <attachment> || <visual-box> || <visual-box>"
      },
      "bg-position": {
        syntax: "[ [ left | center | right | top | bottom | <length-percentage> ] | [ left | center | right | <length-percentage> ] [ top | center | bottom | <length-percentage> ] | [ center | [ left | right ] <length-percentage>? ] && [ center | [ top | bottom ] <length-percentage>? ] ]"
      },
      "bg-size": {
        syntax: "[ <length-percentage [0,\u221E]> | auto ]{1,2} | cover | contain"
      },
      "blend-mode": {
        syntax: "normal | multiply | screen | overlay | darken | lighten | color-dodge | color-burn | hard-light | soft-light | difference | exclusion | hue | saturation | color | luminosity"
      },
      "blur()": {
        syntax: "blur( <length>? )"
      },
      "brightness()": {
        syntax: "brightness( [ <number> | <percentage> ]? )"
      },
      "calc()": {
        syntax: "calc( <calc-sum> )"
      },
      "calc-constant": {
        syntax: "e | pi | infinity | -infinity | NaN"
      },
      "calc-product": {
        syntax: "<calc-value> [ '*' <calc-value> | '/' <number> ]*"
      },
      "calc-size()": {
        syntax: "calc-size( <calc-size-basis>, <calc-sum> )"
      },
      "calc-size-basis": {
        syntax: "<intrinsic-size-keyword> | <calc-size()> | any | <calc-sum>"
      },
      "calc-sum": {
        syntax: "<calc-product> [ [ '+' | '-' ] <calc-product> ]*"
      },
      "calc-value": {
        syntax: "<number> | <dimension> | <percentage> | <calc-constant> | ( <calc-sum> )"
      },
      "cf-final-image": {
        syntax: "<image> | <color>"
      },
      "cf-mixing-image": {
        syntax: "<percentage>? && <image>"
      },
      "circle()": {
        syntax: "circle( <radial-size>? [ at <position> ]? )"
      },
      "clamp()": {
        syntax: "clamp( <calc-sum>#{3} )"
      },
      "class-selector": {
        syntax: "'.' <ident-token>"
      },
      "clip-source": {
        syntax: "<url>"
      },
      color: {
        syntax: "<color-base> | currentColor | <system-color> | <light-dark()> | <deprecated-system-color>"
      },
      "color()": {
        syntax: "color( [ from <color> ]? <colorspace-params> [ / [ <alpha-value> | none ] ]? )"
      },
      "color-base": {
        syntax: "<hex-color> | <color-function> | <named-color> | <color-mix()> | transparent"
      },
      "color-function": {
        syntax: "<rgb()> | <rgba()> | <hsl()> | <hsla()> | <hwb()> | <lab()> | <lch()> | <oklab()> | <oklch()> | <color()>"
      },
      "color-interpolation-method": {
        syntax: "in [ <rectangular-color-space> | <polar-color-space> <hue-interpolation-method>? | <custom-color-space> ]"
      },
      "color-mix()": {
        syntax: "color-mix( <color-interpolation-method> , [ <color> && <percentage [0,100]>? ]#{2})"
      },
      "color-stop": {
        syntax: "<color-stop-length> | <color-stop-angle>"
      },
      "color-stop-angle": {
        syntax: "[ <angle-percentage> | <zero> ]{1,2}"
      },
      "color-stop-length": {
        syntax: "<length-percentage>{1,2}"
      },
      "color-stop-list": {
        syntax: "<linear-color-stop> , [ <linear-color-hint>? , <linear-color-stop> ]#?"
      },
      "colorspace-params": {
        syntax: "[<custom-params> | <predefined-rgb-params> | <xyz-params>]"
      },
      combinator: {
        syntax: "'>' | '+' | '~' | [ '||' ]"
      },
      "common-lig-values": {
        syntax: "[ common-ligatures | no-common-ligatures ]"
      },
      "compat-auto": {
        syntax: "searchfield | textarea | checkbox | radio | menulist | listbox | meter | progress-bar | button"
      },
      "compat-special": {
        syntax: "textfield | menulist-button"
      },
      "complex-selector": {
        syntax: "<compound-selector> [ <combinator>? <compound-selector> ]*"
      },
      "complex-selector-list": {
        syntax: "<complex-selector>#"
      },
      "composite-style": {
        syntax: "clear | copy | source-over | source-in | source-out | source-atop | destination-over | destination-in | destination-out | destination-atop | xor"
      },
      "compositing-operator": {
        syntax: "add | subtract | intersect | exclude"
      },
      "compound-selector": {
        syntax: "[ <type-selector>? <subclass-selector>* [ <pseudo-element-selector> <pseudo-class-selector>* ]* ]!"
      },
      "compound-selector-list": {
        syntax: "<compound-selector>#"
      },
      "conic-gradient()": {
        syntax: "conic-gradient( [ <conic-gradient-syntax> ] )"
      },
      "conic-gradient-syntax": {
        syntax: "[ [ [ from [ <angle> | <zero> ] ]? [ at <position> ]? ] || <color-interpolation-method> ]? , <angular-color-stop-list>"
      },
      "container-condition": {
        syntax: "[ <container-name>? <container-query>? ]!"
      },
      "container-name": {
        syntax: "<custom-ident>"
      },
      "container-query": {
        syntax: "not <query-in-parens> | <query-in-parens> [ [ and <query-in-parens> ]* | [ or <query-in-parens> ]* ]"
      },
      "content-distribution": {
        syntax: "space-between | space-around | space-evenly | stretch"
      },
      "content-list": {
        syntax: "[ <string> | <image> | <attr()> | <quote> | <counter> ]+"
      },
      "content-position": {
        syntax: "center | start | end | flex-start | flex-end"
      },
      "content-replacement": {
        syntax: "<image>"
      },
      "contextual-alt-values": {
        syntax: "[ contextual | no-contextual ]"
      },
      "contrast()": {
        syntax: "contrast( [ <number> | <percentage> ]? )"
      },
      "coord-box": {
        syntax: "<paint-box> | view-box"
      },
      "corner-shape-value": {
        syntax: "round | scoop | bevel | notch | square | squircle | <superellipse()>"
      },
      "cos()": {
        syntax: "cos( <calc-sum> )"
      },
      counter: {
        syntax: "<counter()> | <counters()>"
      },
      "counter()": {
        syntax: "counter( <counter-name>, <counter-style>? )"
      },
      "counter-name": {
        syntax: "<custom-ident>"
      },
      "counter-style": {
        syntax: "<counter-style-name> | symbols()"
      },
      "counter-style-name": {
        syntax: "<custom-ident>"
      },
      "counters()": {
        syntax: "counters( <counter-name>, <string>, <counter-style>? )"
      },
      "cross-fade()": {
        syntax: "cross-fade( <cf-mixing-image> , <cf-final-image>? )"
      },
      "cubic-bezier()": {
        syntax: "cubic-bezier( [ <number [0,1]>, <number> ]#{2} )"
      },
      "cubic-bezier-easing-function": {
        syntax: "ease | ease-in | ease-out | ease-in-out | <cubic-bezier()>"
      },
      "cursor-predefined": {
        syntax: "auto | default | none | context-menu | help | pointer | progress | wait | cell | crosshair | text | vertical-text | alias | copy | move | no-drop | not-allowed | e-resize | n-resize | ne-resize | nw-resize | s-resize | se-resize | sw-resize | w-resize | ew-resize | ns-resize | nesw-resize | nwse-resize | col-resize | row-resize | all-scroll | zoom-in | zoom-out | grab | grabbing"
      },
      "custom-color-space": {
        syntax: "<dashed-ident>"
      },
      "custom-params": {
        syntax: "<dashed-ident> [ <number> | <percentage> | none ]+"
      },
      dasharray: {
        syntax: "[ [ <length-percentage> | <number> ]+ ]#"
      },
      "dashndashdigit-ident": {
        syntax: "<ident-token>"
      },
      "deprecated-system-color": {
        syntax: "ActiveBorder | ActiveCaption | AppWorkspace | Background | ButtonHighlight | ButtonShadow | CaptionText | InactiveBorder | InactiveCaption | InactiveCaptionText | InfoBackground | InfoText | Menu | MenuText | Scrollbar | ThreeDDarkShadow | ThreeDFace | ThreeDHighlight | ThreeDLightShadow | ThreeDShadow | Window | WindowFrame | WindowText"
      },
      "discretionary-lig-values": {
        syntax: "[ discretionary-ligatures | no-discretionary-ligatures ]"
      },
      "display-box": {
        syntax: "contents | none"
      },
      "display-inside": {
        syntax: "flow | flow-root | table | flex | grid | ruby"
      },
      "display-internal": {
        syntax: "table-row-group | table-header-group | table-footer-group | table-row | table-cell | table-column-group | table-column | table-caption | ruby-base | ruby-text | ruby-base-container | ruby-text-container"
      },
      "display-legacy": {
        syntax: "inline-block | inline-list-item | inline-table | inline-flex | inline-grid"
      },
      "display-listitem": {
        syntax: "<display-outside>? && [ flow | flow-root ]? && list-item"
      },
      "display-outside": {
        syntax: "block | inline | run-in"
      },
      "drop-shadow()": {
        syntax: "drop-shadow( [ <color>? && <length>{2,3} ] )"
      },
      "dynamic-range-limit-mix()": {
        syntax: "dynamic-range-limit-mix( [ <'dynamic-range-limit'> && <percentage [0,100]> ]#{2,} )"
      },
      "easing-function": {
        syntax: "<linear-easing-function> | <cubic-bezier-easing-function> | <step-easing-function>"
      },
      "east-asian-variant-values": {
        syntax: "[ jis78 | jis83 | jis90 | jis04 | simplified | traditional ]"
      },
      "east-asian-width-values": {
        syntax: "[ full-width | proportional-width ]"
      },
      "element()": {
        syntax: "element( <id-selector> )"
      },
      "ellipse()": {
        syntax: "ellipse( <radial-size>? [ at <position> ]? )"
      },
      "env()": {
        syntax: "env( <custom-ident> , <declaration-value>? )"
      },
      "exp()": {
        syntax: "exp( <calc-sum> )"
      },
      "explicit-track-list": {
        syntax: "[ <line-names>? <track-size> ]+ <line-names>?"
      },
      "family-name": {
        syntax: "<string> | <custom-ident>+"
      },
      "feature-tag-value": {
        syntax: "<string> [ <integer> | on | off ]?"
      },
      "feature-type": {
        syntax: "@stylistic | @historical-forms | @styleset | @character-variant | @swash | @ornaments | @annotation"
      },
      "feature-value-block": {
        syntax: "<feature-type> '{' <feature-value-declaration-list> '}'"
      },
      "feature-value-block-list": {
        syntax: "<feature-value-block>+"
      },
      "feature-value-declaration": {
        syntax: "<custom-ident>: <integer>+;"
      },
      "feature-value-declaration-list": {
        syntax: "<feature-value-declaration>"
      },
      "feature-value-name": {
        syntax: "<custom-ident>"
      },
      "filter-function": {
        syntax: "<blur()> | <brightness()> | <contrast()> | <drop-shadow()> | <grayscale()> | <hue-rotate()> | <invert()> | <opacity()> | <saturate()> | <sepia()>"
      },
      "filter-value-list": {
        syntax: "[ <filter-function> | <url> ]+"
      },
      "final-bg-layer": {
        syntax: "<bg-image> || <bg-position> [ / <bg-size> ]? || <repeat-style> || <attachment> || <visual-box> || <visual-box> || <'background-color'>"
      },
      "fit-content()": {
        syntax: "fit-content( <length-percentage [0,\u221E]> )"
      },
      "fixed-breadth": {
        syntax: "<length-percentage>"
      },
      "fixed-repeat": {
        syntax: "repeat( [ <integer [1,\u221E]> ] , [ <line-names>? <fixed-size> ]+ <line-names>? )"
      },
      "fixed-size": {
        syntax: "<fixed-breadth> | minmax( <fixed-breadth> , <track-breadth> ) | minmax( <inflexible-breadth> , <fixed-breadth> )"
      },
      "font-stretch-absolute": {
        syntax: "normal | ultra-condensed | extra-condensed | condensed | semi-condensed | semi-expanded | expanded | extra-expanded | ultra-expanded | <percentage>"
      },
      "font-variant-css2": {
        syntax: "normal | small-caps"
      },
      "font-weight-absolute": {
        syntax: "normal | bold | <number [1,1000]>"
      },
      "font-width-css3": {
        syntax: "normal | ultra-condensed | extra-condensed | condensed | semi-condensed | semi-expanded | expanded | extra-expanded | ultra-expanded"
      },
      "form-control-identifier": {
        syntax: "select"
      },
      "frequency-percentage": {
        syntax: "<frequency> | <percentage>"
      },
      "generic-complete": {
        syntax: "serif | sans-serif | system-ui | cursive | fantasy | math | monospace"
      },
      "general-enclosed": {
        syntax: "[ <function-token> <any-value> ) ] | ( <ident> <any-value> )"
      },
      "generic-family": {
        syntax: "<generic-complete> | <generic-incomplete> | emoji | fangsong"
      },
      "generic-incomplete": {
        syntax: "ui-serif | ui-sans-serif | ui-monospace | ui-rounded"
      },
      "geometry-box": {
        syntax: "<shape-box> | fill-box | stroke-box | view-box"
      },
      gradient: {
        syntax: "<linear-gradient()> | <repeating-linear-gradient()> | <radial-gradient()> | <repeating-radial-gradient()> | <conic-gradient()> | <repeating-conic-gradient()>"
      },
      "grayscale()": {
        syntax: "grayscale( [ <number> | <percentage> ]? )"
      },
      "grid-line": {
        syntax: "auto | <custom-ident> | [ <integer> && <custom-ident>? ] | [ span && [ <integer> || <custom-ident> ] ]"
      },
      "historical-lig-values": {
        syntax: "[ historical-ligatures | no-historical-ligatures ]"
      },
      "hsl()": {
        syntax: "hsl( <hue>, <percentage>, <percentage>, <alpha-value>? ) | hsl( [ <hue> | none ] [ <percentage> | <number> | none ] [ <percentage> | <number> | none ] [ / [ <alpha-value> | none ] ]? )"
      },
      "hsla()": {
        syntax: "hsla( <hue>, <percentage>, <percentage>, <alpha-value>? ) | hsla( [ <hue> | none ] [ <percentage> | <number> | none ] [ <percentage> | <number> | none ] [ / [ <alpha-value> | none ] ]? )"
      },
      hue: {
        syntax: "<number> | <angle>"
      },
      "hue-interpolation-method": {
        syntax: "[ shorter | longer | increasing | decreasing ] hue"
      },
      "hue-rotate()": {
        syntax: "hue-rotate( [ <angle> | <zero> ]? )"
      },
      "hwb()": {
        syntax: "hwb( [ <hue> | none ] [ <percentage> | <number> | none ] [ <percentage> | <number> | none ] [ / [ <alpha-value> | none ] ]? )"
      },
      "hypot()": {
        syntax: "hypot( <calc-sum># )"
      },
      "id-selector": {
        syntax: "<hash-token>"
      },
      image: {
        syntax: "<url> | <image()> | <image-set()> | <element()> | <paint()> | <cross-fade()> | <gradient>"
      },
      "image()": {
        syntax: "image( <image-tags>? [ <image-src>? , <color>? ]! )"
      },
      "image-set()": {
        syntax: "image-set( <image-set-option># )"
      },
      "image-set-option": {
        syntax: "[ <image> | <string> ] [ <resolution> || type(<string>) ]"
      },
      "image-src": {
        syntax: "<url> | <string>"
      },
      "image-tags": {
        syntax: "ltr | rtl"
      },
      "inflexible-breadth": {
        syntax: "<length-percentage> | min-content | max-content | auto"
      },
      "inset()": {
        syntax: "inset( <length-percentage>{1,4} [ round <'border-radius'> ]? )"
      },
      integer: {
        syntax: "<number-token>"
      },
      "invert()": {
        syntax: "invert( [ <number> | <percentage> ]? )"
      },
      "keyframe-block": {
        syntax: "<keyframe-selector># {\n  <declaration-list>\n}"
      },
      "keyframe-selector": {
        syntax: "from | to | <percentage [0,100]> | <timeline-range-name> <percentage>"
      },
      "keyframes-name": {
        syntax: "<custom-ident> | <string>"
      },
      "lab()": {
        syntax: "lab( [<percentage> | <number> | none] [ <percentage> | <number> | none] [ <percentage> | <number> | none] [ / [<alpha-value> | none] ]? )"
      },
      "layer()": {
        syntax: "layer( <layer-name> )"
      },
      "layer-name": {
        syntax: "<ident> [ '.' <ident> ]*"
      },
      "lch()": {
        syntax: "lch( [<percentage> | <number> | none] [ <percentage> | <number> | none] [ <hue> | none] [ / [<alpha-value> | none] ]? )"
      },
      "leader()": {
        syntax: "leader( <leader-type> )"
      },
      "leader-type": {
        syntax: "dotted | solid | space | <string>"
      },
      "length-percentage": {
        syntax: "<length> | <percentage>"
      },
      "light-dark()": {
        syntax: "light-dark( <color>, <color> )"
      },
      "line-name-list": {
        syntax: "[ <line-names> | <name-repeat> ]+"
      },
      "line-names": {
        syntax: "'[' <custom-ident>* ']'"
      },
      "line-style": {
        syntax: "none | hidden | dotted | dashed | solid | double | groove | ridge | inset | outset"
      },
      "line-width": {
        syntax: "<length> | thin | medium | thick"
      },
      "linear()": {
        syntax: "linear( [ <number> && <percentage>{0,2} ]# )"
      },
      "linear-color-hint": {
        syntax: "<length-percentage>"
      },
      "linear-color-stop": {
        syntax: "<color> <color-stop-length>?"
      },
      "linear-easing-function": {
        syntax: "linear | <linear()>"
      },
      "linear-gradient()": {
        syntax: "linear-gradient( [ <linear-gradient-syntax> ] )"
      },
      "linear-gradient-syntax": {
        syntax: "[ [ <angle> | <zero> | to <side-or-corner> ] || <color-interpolation-method> ]? , <color-stop-list>"
      },
      "log()": {
        syntax: "log( <calc-sum>, <calc-sum>? )"
      },
      "mask-layer": {
        syntax: "<mask-reference> || <position> [ / <bg-size> ]? || <repeat-style> || <geometry-box> || [ <geometry-box> | no-clip ] || <compositing-operator> || <masking-mode>"
      },
      "mask-position": {
        syntax: "[ <length-percentage> | left | center | right ] [ <length-percentage> | top | center | bottom ]?"
      },
      "mask-reference": {
        syntax: "none | <image> | <mask-source>"
      },
      "mask-source": {
        syntax: "<url>"
      },
      "masking-mode": {
        syntax: "alpha | luminance | match-source"
      },
      "matrix()": {
        syntax: "matrix( <number>#{6} )"
      },
      "matrix3d()": {
        syntax: "matrix3d( <number>#{16} )"
      },
      "max()": {
        syntax: "max( <calc-sum># )"
      },
      "media-and": {
        syntax: "<media-in-parens> [ and <media-in-parens> ]+"
      },
      "media-condition": {
        syntax: "<media-not> | <media-and> | <media-or> | <media-in-parens>"
      },
      "media-condition-without-or": {
        syntax: "<media-not> | <media-and> | <media-in-parens>"
      },
      "media-feature": {
        syntax: "( [ <mf-plain> | <mf-boolean> | <mf-range> ] )"
      },
      "media-in-parens": {
        syntax: "( <media-condition> ) | <media-feature> | <general-enclosed>"
      },
      "media-not": {
        syntax: "not <media-in-parens>"
      },
      "media-or": {
        syntax: "<media-in-parens> [ or <media-in-parens> ]+"
      },
      "media-query": {
        syntax: "<media-condition> | [ not | only ]? <media-type> [ and <media-condition-without-or> ]?"
      },
      "media-query-list": {
        syntax: "<media-query>#"
      },
      "media-type": {
        syntax: "<ident>"
      },
      "mf-boolean": {
        syntax: "<mf-name>"
      },
      "mf-name": {
        syntax: "<ident>"
      },
      "mf-plain": {
        syntax: "<mf-name> : <mf-value>"
      },
      "mf-range": {
        syntax: "<mf-name> [ '<' | '>' ]? '='? <mf-value>\n| <mf-value> [ '<' | '>' ]? '='? <mf-name>\n| <mf-value> '<' '='? <mf-name> '<' '='? <mf-value>\n| <mf-value> '>' '='? <mf-name> '>' '='? <mf-value>"
      },
      "mf-value": {
        syntax: "<number> | <dimension> | <ident> | <ratio>"
      },
      "min()": {
        syntax: "min( <calc-sum># )"
      },
      "minmax()": {
        syntax: "minmax( [ <length-percentage> | min-content | max-content | auto ] , [ <length-percentage> | <flex> | min-content | max-content | auto ] )"
      },
      "mod()": {
        syntax: "mod( <calc-sum>, <calc-sum> )"
      },
      "n-dimension": {
        syntax: "<dimension-token>"
      },
      "name-repeat": {
        syntax: "repeat( [ <integer [1,\u221E]> | auto-fill ], <line-names>+ )"
      },
      "named-color": {
        syntax: "aliceblue | antiquewhite | aqua | aquamarine | azure | beige | bisque | black | blanchedalmond | blue | blueviolet | brown | burlywood | cadetblue | chartreuse | chocolate | coral | cornflowerblue | cornsilk | crimson | cyan | darkblue | darkcyan | darkgoldenrod | darkgray | darkgreen | darkgrey | darkkhaki | darkmagenta | darkolivegreen | darkorange | darkorchid | darkred | darksalmon | darkseagreen | darkslateblue | darkslategray | darkslategrey | darkturquoise | darkviolet | deeppink | deepskyblue | dimgray | dimgrey | dodgerblue | firebrick | floralwhite | forestgreen | fuchsia | gainsboro | ghostwhite | gold | goldenrod | gray | green | greenyellow | grey | honeydew | hotpink | indianred | indigo | ivory | khaki | lavender | lavenderblush | lawngreen | lemonchiffon | lightblue | lightcoral | lightcyan | lightgoldenrodyellow | lightgray | lightgreen | lightgrey | lightpink | lightsalmon | lightseagreen | lightskyblue | lightslategray | lightslategrey | lightsteelblue | lightyellow | lime | limegreen | linen | magenta | maroon | mediumaquamarine | mediumblue | mediumorchid | mediumpurple | mediumseagreen | mediumslateblue | mediumspringgreen | mediumturquoise | mediumvioletred | midnightblue | mintcream | mistyrose | moccasin | navajowhite | navy | oldlace | olive | olivedrab | orange | orangered | orchid | palegoldenrod | palegreen | paleturquoise | palevioletred | papayawhip | peachpuff | peru | pink | plum | powderblue | purple | rebeccapurple | red | rosybrown | royalblue | saddlebrown | salmon | sandybrown | seagreen | seashell | sienna | silver | skyblue | slateblue | slategray | slategrey | snow | springgreen | steelblue | tan | teal | thistle | tomato | turquoise | violet | wheat | white | whitesmoke | yellow | yellowgreen"
      },
      "namespace-prefix": {
        syntax: "<ident>"
      },
      "ndash-dimension": {
        syntax: "<dimension-token>"
      },
      "ndashdigit-dimension": {
        syntax: "<dimension-token>"
      },
      "ndashdigit-ident": {
        syntax: "<ident-token>"
      },
      "ns-prefix": {
        syntax: "[ <ident-token> | '*' ]? '|'"
      },
      "number-percentage": {
        syntax: "<number> | <percentage>"
      },
      "numeric-figure-values": {
        syntax: "[ lining-nums | oldstyle-nums ]"
      },
      "numeric-fraction-values": {
        syntax: "[ diagonal-fractions | stacked-fractions ]"
      },
      "numeric-spacing-values": {
        syntax: "[ proportional-nums | tabular-nums ]"
      },
      "offset-path": {
        syntax: "<ray()> | <url> | <basic-shape>"
      },
      "oklab()": {
        syntax: "oklab( [ <percentage> | <number> | none] [ <percentage> | <number> | none] [ <percentage> | <number> | none] [ / [<alpha-value> | none] ]? )"
      },
      "oklch()": {
        syntax: "oklch( [ <percentage> | <number> | none] [ <percentage> | <number> | none] [ <hue> | none] [ / [<alpha-value> | none] ]? )"
      },
      "opacity()": {
        syntax: "opacity( [ <number> | <percentage> ]? )"
      },
      "opacity-value": {
        syntax: "<number> | <percentage>"
      },
      "outline-line-style": {
        syntax: "none | dotted | dashed | solid | double | groove | ridge | inset | outset"
      },
      "outline-radius": {
        syntax: "<length> | <percentage>"
      },
      "overflow-position": {
        syntax: "unsafe | safe"
      },
      "page-body": {
        syntax: "<declaration>? [ ; <page-body> ]? | <page-margin-box> <page-body>"
      },
      "page-margin-box": {
        syntax: "<page-margin-box-type> '{' <declaration-list> '}'"
      },
      "page-margin-box-type": {
        syntax: "@top-left-corner | @top-left | @top-center | @top-right | @top-right-corner | @bottom-left-corner | @bottom-left | @bottom-center | @bottom-right | @bottom-right-corner | @left-top | @left-middle | @left-bottom | @right-top | @right-middle | @right-bottom"
      },
      "page-selector": {
        syntax: "<pseudo-page>+ | <ident> <pseudo-page>*"
      },
      "page-selector-list": {
        syntax: "[ <page-selector># ]?"
      },
      "page-size": {
        syntax: "A5 | A4 | A3 | B5 | B4 | JIS-B5 | JIS-B4 | letter | legal | ledger"
      },
      paint: {
        syntax: "none | <color> | <url> [none | <color>]? | context-fill | context-stroke"
      },
      "paint()": {
        syntax: "paint( <ident>, <declaration-value>? )"
      },
      "paint-box": {
        syntax: "<visual-box> | fill-box | stroke-box"
      },
      "palette-identifier": {
        syntax: "<dashed-ident>"
      },
      "palette-mix()": {
        syntax: "palette-mix(<color-interpolation-method> , [ [normal | light | dark | <palette-identifier> | <palette-mix()> ] && <percentage [0,100]>? ]#{2})"
      },
      "path()": {
        syntax: "path( <'fill-rule'>? , <string> )"
      },
      "perspective()": {
        syntax: "perspective( [ <length [0,\u221E]> | none ] )"
      },
      "polar-color-space": {
        syntax: "hsl | hwb | lch | oklch"
      },
      "polygon()": {
        syntax: "polygon( <'fill-rule'>? , [ <length-percentage> <length-percentage> ]# )"
      },
      position: {
        syntax: "[ [ left | center | right ] || [ top | center | bottom ] | [ left | center | right | <length-percentage> ] [ top | center | bottom | <length-percentage> ]? | [ [ left | right ] <length-percentage> ] && [ [ top | bottom ] <length-percentage> ] ]"
      },
      "position-area": {
        syntax: "[ left | center | right | span-left | span-right | x-start | x-end | span-x-start | span-x-end | x-self-start | x-self-end | span-x-self-start | span-x-self-end | span-all ] || [ top | center | bottom | span-top | span-bottom | y-start | y-end | span-y-start | span-y-end | y-self-start | y-self-end | span-y-self-start | span-y-self-end | span-all ] | [ block-start | center | block-end | span-block-start | span-block-end | span-all ] || [ inline-start | center | inline-end | span-inline-start | span-inline-end | span-all ] | [ self-block-start | center | self-block-end | span-self-block-start | span-self-block-end | span-all ] || [ self-inline-start | center | self-inline-end | span-self-inline-start | span-self-inline-end | span-all ] | [ start | center | end | span-start | span-end | span-all ]{1,2} | [ self-start | center | self-end | span-self-start | span-self-end | span-all ]{1,2}"
      },
      "pow()": {
        syntax: "pow( <calc-sum>, <calc-sum> )"
      },
      "predefined-rgb": {
        syntax: "srgb | srgb-linear | display-p3 | display-p3-linear | a98-rgb | prophoto-rgb | rec2020"
      },
      "predefined-rgb-params": {
        syntax: "<predefined-rgb> [ <number> | <percentage> | none ]{3}"
      },
      "pseudo-class-selector": {
        syntax: "':' <ident-token> | ':' <function-token> <any-value> ')'"
      },
      "pseudo-element-selector": {
        syntax: "':' <pseudo-class-selector>"
      },
      "pseudo-page": {
        syntax: ": [ left | right | first | blank ]"
      },
      "query-in-parens": {
        syntax: "( <container-query> ) | ( <size-feature> ) | style( <style-query> ) | scroll-state( <scroll-state-query> ) | <general-enclosed>"
      },
      quote: {
        syntax: "open-quote | close-quote | no-open-quote | no-close-quote"
      },
      "radial-extent": {
        syntax: "closest-corner | closest-side | farthest-corner | farthest-side"
      },
      "radial-gradient()": {
        syntax: "radial-gradient( [ <radial-gradient-syntax> ] )"
      },
      "radial-gradient-syntax": {
        syntax: "[ [ [ <radial-shape> || <radial-size> ]? [ at <position> ]? ] || <color-interpolation-method> ]? , <color-stop-list>"
      },
      "radial-shape": {
        syntax: "circle | ellipse"
      },
      "radial-size": {
        syntax: "<radial-extent> | <length [0,\u221E]> | <length-percentage [0,\u221E]>{2}"
      },
      ratio: {
        syntax: "<number [0,\u221E]> [ / <number [0,\u221E]> ]?"
      },
      "ray()": {
        syntax: "ray( <angle> && <ray-size>? && contain? && [at <position>]? )"
      },
      "ray-size": {
        syntax: "closest-side | closest-corner | farthest-side | farthest-corner | sides"
      },
      "rect()": {
        syntax: "rect( [ <length-percentage> | auto ]{4} [ round <'border-radius'> ]? )"
      },
      "rectangular-color-space": {
        syntax: "srgb | srgb-linear | display-p3 | display-p3-linear | a98-rgb | prophoto-rgb | rec2020 | lab | oklab | xyz | xyz-d50 | xyz-d65"
      },
      "relative-selector": {
        syntax: "<combinator>? <complex-selector>"
      },
      "relative-selector-list": {
        syntax: "<relative-selector>#"
      },
      "relative-size": {
        syntax: "larger | smaller"
      },
      "rem()": {
        syntax: "rem( <calc-sum>, <calc-sum> )"
      },
      "repeat-style": {
        syntax: "repeat-x | repeat-y | [ repeat | space | round | no-repeat ]{1,2}"
      },
      "repeating-conic-gradient()": {
        syntax: "repeating-conic-gradient( [ <conic-gradient-syntax> ] )"
      },
      "repeating-linear-gradient()": {
        syntax: "repeating-linear-gradient( [ <linear-gradient-syntax> ] )"
      },
      "repeating-radial-gradient()": {
        syntax: "repeating-radial-gradient( [ <radial-gradient-syntax> ] )"
      },
      "reversed-counter-name": {
        syntax: "reversed( <counter-name> )"
      },
      "rgb()": {
        syntax: "rgb( <percentage>#{3} , <alpha-value>? ) | rgb( <number>#{3} , <alpha-value>? ) | rgb( [ <number> | <percentage> | none ]{3} [ / [ <alpha-value> | none ] ]? )"
      },
      "rgba()": {
        syntax: "rgba( <percentage>#{3} , <alpha-value>? ) | rgba( <number>#{3} , <alpha-value>? ) | rgba( [ <number> | <percentage> | none ]{3} [ / [ <alpha-value> | none ] ]? )"
      },
      "rotate()": {
        syntax: "rotate( [ <angle> | <zero> ] )"
      },
      "rotate3d()": {
        syntax: "rotate3d( <number> , <number> , <number> , [ <angle> | <zero> ] )"
      },
      "rotateX()": {
        syntax: "rotateX( [ <angle> | <zero> ] )"
      },
      "rotateY()": {
        syntax: "rotateY( [ <angle> | <zero> ] )"
      },
      "rotateZ()": {
        syntax: "rotateZ( [ <angle> | <zero> ] )"
      },
      "round()": {
        syntax: "round( <rounding-strategy>?, <calc-sum>, <calc-sum> )"
      },
      "rounding-strategy": {
        syntax: "nearest | up | down | to-zero"
      },
      "saturate()": {
        syntax: "saturate( [ <number> | <percentage> ]? )"
      },
      "scale()": {
        syntax: "scale( [ <number> | <percentage> ]#{1,2} )"
      },
      "scale3d()": {
        syntax: "scale3d( [ <number> | <percentage> ]#{3} )"
      },
      "scaleX()": {
        syntax: "scaleX( [ <number> | <percentage> ] )"
      },
      "scaleY()": {
        syntax: "scaleY( [ <number> | <percentage> ] )"
      },
      "scaleZ()": {
        syntax: "scaleZ( [ <number> | <percentage> ] )"
      },
      "scope-end": {
        syntax: "<selector-list>"
      },
      "scope-start": {
        syntax: "<selector-list>"
      },
      "scroll()": {
        syntax: "scroll( [ <scroller> || <axis> ]? )"
      },
      scroller: {
        syntax: "root | nearest | self"
      },
      "scroll-state-feature": {
        syntax: "<media-query-list>"
      },
      "scroll-state-in-parens": {
        syntax: "( <scroll-state-query> ) | ( <scroll-state-feature> ) | <general-enclosed>"
      },
      "scroll-state-query": {
        syntax: "not <scroll-state-in-parens> | <scroll-state-in-parens> [ [ and <scroll-state-in-parens> ]* | [ or <scroll-state-in-parens> ]* ] | <scroll-state-feature>"
      },
      "selector-list": {
        syntax: "<complex-selector-list>"
      },
      "self-position": {
        syntax: "center | start | end | self-start | self-end | flex-start | flex-end"
      },
      "sepia()": {
        syntax: "sepia( [ <number> | <percentage> ]? )"
      },
      shadow: {
        syntax: "inset? && <length>{2,4} && <color>?"
      },
      "shadow-t": {
        syntax: "[ <length>{2,3} && <color>? ]"
      },
      shape: {
        syntax: "rect(<top>, <right>, <bottom>, <left>)"
      },
      "shape-box": {
        syntax: "<visual-box> | margin-box"
      },
      "side-or-corner": {
        syntax: "[ left | right ] || [ top | bottom ]"
      },
      "sign()": {
        syntax: "sign( <calc-sum> )"
      },
      "signed-integer": {
        syntax: "<number-token>"
      },
      "signless-integer": {
        syntax: "<number-token>"
      },
      "sin()": {
        syntax: "sin( <calc-sum> )"
      },
      "single-animation": {
        syntax: "<'animation-duration'> || <easing-function> || <'animation-delay'> || <single-animation-iteration-count> || <single-animation-direction> || <single-animation-fill-mode> || <single-animation-play-state> || [ none | <keyframes-name> ] || <single-animation-timeline>"
      },
      "single-animation-composition": {
        syntax: "replace | add | accumulate"
      },
      "single-animation-direction": {
        syntax: "normal | reverse | alternate | alternate-reverse"
      },
      "single-animation-fill-mode": {
        syntax: "none | forwards | backwards | both"
      },
      "single-animation-iteration-count": {
        syntax: "infinite | <number>"
      },
      "single-animation-play-state": {
        syntax: "running | paused"
      },
      "single-animation-timeline": {
        syntax: "auto | none | <dashed-ident> | <scroll()> | <view()>"
      },
      "single-transition": {
        syntax: "[ none | <single-transition-property> ] || <time> || <easing-function> || <time> || <transition-behavior-value>"
      },
      "single-transition-property": {
        syntax: "all | <custom-ident>"
      },
      size: {
        syntax: "closest-side | farthest-side | closest-corner | farthest-corner | <length> | <length-percentage>{2}"
      },
      "size-feature": {
        syntax: "<media-query-list>"
      },
      "skew()": {
        syntax: "skew( [ <angle> | <zero> ] , [ <angle> | <zero> ]? )"
      },
      "skewX()": {
        syntax: "skewX( [ <angle> | <zero> ] )"
      },
      "skewY()": {
        syntax: "skewY( [ <angle> | <zero> ] )"
      },
      "sqrt()": {
        syntax: "sqrt( <calc-sum> )"
      },
      "step-position": {
        syntax: "jump-start | jump-end | jump-none | jump-both | start | end"
      },
      "step-easing-function": {
        syntax: "step-start | step-end | <steps()>"
      },
      "steps()": {
        syntax: "steps( <integer>, <step-position>? )"
      },
      "style-feature": {
        syntax: "<declaration>"
      },
      "style-in-parens": {
        syntax: "( <style-query> ) | ( <style-feature> ) | <general-enclosed>"
      },
      "style-query": {
        syntax: "not <style-in-parens> | <style-in-parens> [ [ and <style-in-parens> ]* | [ or <style-in-parens> ]* ] | <style-feature>"
      },
      "subclass-selector": {
        syntax: "<id-selector> | <class-selector> | <attribute-selector> | <pseudo-class-selector>"
      },
      "superellipse()": {
        syntax: "superellipse( [ <number> | infinity | -infinity ] )"
      },
      "supports-condition": {
        syntax: "not <supports-in-parens> | <supports-in-parens> [ and <supports-in-parens> ]* | <supports-in-parens> [ or <supports-in-parens> ]*"
      },
      "supports-decl": {
        syntax: "( <declaration> )"
      },
      "supports-feature": {
        syntax: "<supports-decl> | <supports-selector-fn>"
      },
      "supports-in-parens": {
        syntax: "( <supports-condition> ) | <supports-feature> | <general-enclosed>"
      },
      "supports-selector-fn": {
        syntax: "selector( <complex-selector> )"
      },
      symbol: {
        syntax: "<string> | <image> | <custom-ident>"
      },
      "symbols()": {
        syntax: "symbols( <symbols-type>? [ <string> | <image> ]+ )"
      },
      "symbols-type": {
        syntax: "cyclic | numeric | alphabetic | symbolic | fixed"
      },
      "system-color": {
        syntax: "AccentColor | AccentColorText | ActiveText | ButtonBorder | ButtonFace | ButtonText | Canvas | CanvasText | Field | FieldText | GrayText | Highlight | HighlightText | LinkText | Mark | MarkText | SelectedItem | SelectedItemText | VisitedText"
      },
      "system-family-name": {
        syntax: "caption | icon | menu | message-box | small-caption | status-bar"
      },
      "tan()": {
        syntax: "tan( <calc-sum> )"
      },
      target: {
        syntax: "<target-counter()> | <target-counters()> | <target-text()>"
      },
      "target-counter()": {
        syntax: "target-counter( [ <string> | <url> ] , <custom-ident> , <counter-style>? )"
      },
      "target-counters()": {
        syntax: "target-counters( [ <string> | <url> ] , <custom-ident> , <string> , <counter-style>? )"
      },
      "target-text()": {
        syntax: "target-text( [ <string> | <url> ] , [ content | before | after | first-letter ]? )"
      },
      "text-edge": {
        syntax: "[ text | cap | ex | ideographic | ideographic-ink ] [ text | alphabetic | ideographic | ideographic-ink ]?"
      },
      "time-percentage": {
        syntax: "<time> | <percentage>"
      },
      "timeline-range-name": {
        syntax: "cover | contain | entry | exit | entry-crossing | exit-crossing"
      },
      "track-breadth": {
        syntax: "<length-percentage> | <flex> | min-content | max-content | auto"
      },
      "track-list": {
        syntax: "[ <line-names>? [ <track-size> | <track-repeat> ] ]+ <line-names>?"
      },
      "track-repeat": {
        syntax: "repeat( [ <integer [1,\u221E]> ] , [ <line-names>? <track-size> ]+ <line-names>? )"
      },
      "track-size": {
        syntax: "<track-breadth> | minmax( <inflexible-breadth> , <track-breadth> ) | fit-content( <length-percentage> )"
      },
      "transform-function": {
        syntax: "<matrix()> | <translate()> | <translateX()> | <translateY()> | <scale()> | <scaleX()> | <scaleY()> | <rotate()> | <skew()> | <skewX()> | <skewY()> | <matrix3d()> | <translate3d()> | <translateZ()> | <scale3d()> | <scaleZ()> | <rotate3d()> | <rotateX()> | <rotateY()> | <rotateZ()> | <perspective()>"
      },
      "transform-list": {
        syntax: "<transform-function>+"
      },
      "transition-behavior-value": {
        syntax: "normal | allow-discrete"
      },
      "translate()": {
        syntax: "translate( <length-percentage> , <length-percentage>? )"
      },
      "translate3d()": {
        syntax: "translate3d( <length-percentage> , <length-percentage> , <length> )"
      },
      "translateX()": {
        syntax: "translateX( <length-percentage> )"
      },
      "translateY()": {
        syntax: "translateY( <length-percentage> )"
      },
      "translateZ()": {
        syntax: "translateZ( <length> )"
      },
      "try-size": {
        syntax: "most-width | most-height | most-block-size | most-inline-size"
      },
      "try-tactic": {
        syntax: "flip-block || flip-inline || flip-start"
      },
      "type-or-unit": {
        syntax: "string | color | url | integer | number | length | angle | time | frequency | cap | ch | em | ex | ic | lh | rlh | rem | vb | vi | vw | vh | vmin | vmax | mm | Q | cm | in | pt | pc | px | deg | grad | rad | turn | ms | s | Hz | kHz | %"
      },
      "type-selector": {
        syntax: "<wq-name> | <ns-prefix>? '*'"
      },
      "var()": {
        syntax: "var( <custom-property-name> , <declaration-value>? )"
      },
      "view()": {
        syntax: "view([<axis> || <'view-timeline-inset'>]?)"
      },
      "viewport-length": {
        syntax: "auto | <length-percentage>"
      },
      "visual-box": {
        syntax: "content-box | padding-box | border-box"
      },
      "wq-name": {
        syntax: "<ns-prefix>? <ident-token>"
      },
      "xywh()": {
        syntax: "xywh( <length-percentage>{2} <length-percentage [0,\u221E]>{2} [ round <'border-radius'> ]? )"
      },
      xyz: {
        syntax: "xyz | xyz-d50 | xyz-d65"
      },
      "xyz-params": {
        syntax: "<xyz> [ <number> | <percentage> | none ]{3}"
      }
    };
  }
});

// node_modules/css-tree/cjs/data.cjs
var require_data = __commonJS({
  "node_modules/css-tree/cjs/data.cjs"(exports2, module2) {
    "use strict";
    var dataPatch = require_data_patch();
    var mdnAtrules = require_at_rules();
    var mdnProperties = require_properties();
    var mdnSyntaxes = require_syntaxes();
    var hasOwn = Object.hasOwn || ((object, property) => Object.prototype.hasOwnProperty.call(object, property));
    var extendSyntax = /^\s*\|\s*/;
    function preprocessAtrules(dict) {
      const result = /* @__PURE__ */ Object.create(null);
      for (const [atruleName, atrule] of Object.entries(dict)) {
        let descriptors = null;
        if (atrule.descriptors) {
          descriptors = /* @__PURE__ */ Object.create(null);
          for (const [name, descriptor] of Object.entries(atrule.descriptors)) {
            descriptors[name] = descriptor.syntax;
          }
        }
        result[atruleName.substr(1)] = {
          prelude: atrule.syntax.trim().replace(/\{(.|\s)+\}/, "").match(/^@\S+\s+([^;\{]*)/)[1].trim() || null,
          descriptors
        };
      }
      return result;
    }
    function patchDictionary(dict, patchDict) {
      const result = /* @__PURE__ */ Object.create(null);
      for (const [key, value] of Object.entries(dict)) {
        if (value) {
          result[key] = value.syntax || value;
        }
      }
      for (const key of Object.keys(patchDict)) {
        if (hasOwn(dict, key)) {
          if (patchDict[key].syntax) {
            result[key] = extendSyntax.test(patchDict[key].syntax) ? result[key] + " " + patchDict[key].syntax.trim() : patchDict[key].syntax;
          } else {
            delete result[key];
          }
        } else {
          if (patchDict[key].syntax) {
            result[key] = patchDict[key].syntax.replace(extendSyntax, "");
          }
        }
      }
      return result;
    }
    function preprocessPatchAtrulesDescritors(declarations) {
      const result = {};
      for (const [key, value] of Object.entries(declarations || {})) {
        result[key] = typeof value === "string" ? { syntax: value } : value;
      }
      return result;
    }
    function patchAtrules(dict, patchDict) {
      const result = {};
      for (const key in dict) {
        if (patchDict[key] === null) {
          continue;
        }
        const atrulePatch = patchDict[key] || {};
        result[key] = {
          prelude: key in patchDict && "prelude" in atrulePatch ? atrulePatch.prelude : dict[key].prelude || null,
          descriptors: patchDictionary(
            dict[key].descriptors || {},
            preprocessPatchAtrulesDescritors(atrulePatch.descriptors)
          )
        };
      }
      for (const [key, atrulePatch] of Object.entries(patchDict)) {
        if (atrulePatch && !hasOwn(dict, key)) {
          result[key] = {
            prelude: atrulePatch.prelude || null,
            descriptors: atrulePatch.descriptors ? patchDictionary({}, preprocessPatchAtrulesDescritors(atrulePatch.descriptors)) : null
          };
        }
      }
      return result;
    }
    var definitions = {
      types: patchDictionary(mdnSyntaxes, dataPatch.types),
      atrules: patchAtrules(preprocessAtrules(mdnAtrules), dataPatch.atrules),
      properties: patchDictionary(mdnProperties, dataPatch.properties)
    };
    module2.exports = definitions;
  }
});

// node_modules/css-tree/cjs/syntax/node/AnPlusB.cjs
var require_AnPlusB = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/AnPlusB.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var charCodeDefinitions = require_char_code_definitions();
    var PLUSSIGN = 43;
    var HYPHENMINUS = 45;
    var N = 110;
    var DISALLOW_SIGN = true;
    var ALLOW_SIGN = false;
    function checkInteger(offset, disallowSign) {
      let pos = this.tokenStart + offset;
      const code = this.charCodeAt(pos);
      if (code === PLUSSIGN || code === HYPHENMINUS) {
        if (disallowSign) {
          this.error("Number sign is not allowed");
        }
        pos++;
      }
      for (; pos < this.tokenEnd; pos++) {
        if (!charCodeDefinitions.isDigit(this.charCodeAt(pos))) {
          this.error("Integer is expected", pos);
        }
      }
    }
    function checkTokenIsInteger(disallowSign) {
      return checkInteger.call(this, 0, disallowSign);
    }
    function expectCharCode(offset, code) {
      if (!this.cmpChar(this.tokenStart + offset, code)) {
        let msg = "";
        switch (code) {
          case N:
            msg = "N is expected";
            break;
          case HYPHENMINUS:
            msg = "HyphenMinus is expected";
            break;
        }
        this.error(msg, this.tokenStart + offset);
      }
    }
    function consumeB() {
      let offset = 0;
      let sign = 0;
      let type = this.tokenType;
      while (type === types.WhiteSpace || type === types.Comment) {
        type = this.lookupType(++offset);
      }
      if (type !== types.Number) {
        if (this.isDelim(PLUSSIGN, offset) || this.isDelim(HYPHENMINUS, offset)) {
          sign = this.isDelim(PLUSSIGN, offset) ? PLUSSIGN : HYPHENMINUS;
          do {
            type = this.lookupType(++offset);
          } while (type === types.WhiteSpace || type === types.Comment);
          if (type !== types.Number) {
            this.skip(offset);
            checkTokenIsInteger.call(this, DISALLOW_SIGN);
          }
        } else {
          return null;
        }
      }
      if (offset > 0) {
        this.skip(offset);
      }
      if (sign === 0) {
        type = this.charCodeAt(this.tokenStart);
        if (type !== PLUSSIGN && type !== HYPHENMINUS) {
          this.error("Number sign is expected");
        }
      }
      checkTokenIsInteger.call(this, sign !== 0);
      return sign === HYPHENMINUS ? "-" + this.consume(types.Number) : this.consume(types.Number);
    }
    var name = "AnPlusB";
    var structure = {
      a: [String, null],
      b: [String, null]
    };
    function parse() {
      const start = this.tokenStart;
      let a = null;
      let b = null;
      if (this.tokenType === types.Number) {
        checkTokenIsInteger.call(this, ALLOW_SIGN);
        b = this.consume(types.Number);
      } else if (this.tokenType === types.Ident && this.cmpChar(this.tokenStart, HYPHENMINUS)) {
        a = "-1";
        expectCharCode.call(this, 1, N);
        switch (this.tokenEnd - this.tokenStart) {
          // -n
          // -n <signed-integer>
          // -n ['+' | '-'] <signless-integer>
          case 2:
            this.next();
            b = consumeB.call(this);
            break;
          // -n- <signless-integer>
          case 3:
            expectCharCode.call(this, 2, HYPHENMINUS);
            this.next();
            this.skipSC();
            checkTokenIsInteger.call(this, DISALLOW_SIGN);
            b = "-" + this.consume(types.Number);
            break;
          // <dashndashdigit-ident>
          default:
            expectCharCode.call(this, 2, HYPHENMINUS);
            checkInteger.call(this, 3, DISALLOW_SIGN);
            this.next();
            b = this.substrToCursor(start + 2);
        }
      } else if (this.tokenType === types.Ident || this.isDelim(PLUSSIGN) && this.lookupType(1) === types.Ident) {
        let sign = 0;
        a = "1";
        if (this.isDelim(PLUSSIGN)) {
          sign = 1;
          this.next();
        }
        expectCharCode.call(this, 0, N);
        switch (this.tokenEnd - this.tokenStart) {
          // '+'? n
          // '+'? n <signed-integer>
          // '+'? n ['+' | '-'] <signless-integer>
          case 1:
            this.next();
            b = consumeB.call(this);
            break;
          // '+'? n- <signless-integer>
          case 2:
            expectCharCode.call(this, 1, HYPHENMINUS);
            this.next();
            this.skipSC();
            checkTokenIsInteger.call(this, DISALLOW_SIGN);
            b = "-" + this.consume(types.Number);
            break;
          // '+'? <ndashdigit-ident>
          default:
            expectCharCode.call(this, 1, HYPHENMINUS);
            checkInteger.call(this, 2, DISALLOW_SIGN);
            this.next();
            b = this.substrToCursor(start + sign + 1);
        }
      } else if (this.tokenType === types.Dimension) {
        const code = this.charCodeAt(this.tokenStart);
        const sign = code === PLUSSIGN || code === HYPHENMINUS;
        let i = this.tokenStart + sign;
        for (; i < this.tokenEnd; i++) {
          if (!charCodeDefinitions.isDigit(this.charCodeAt(i))) {
            break;
          }
        }
        if (i === this.tokenStart + sign) {
          this.error("Integer is expected", this.tokenStart + sign);
        }
        expectCharCode.call(this, i - this.tokenStart, N);
        a = this.substring(start, i);
        if (i + 1 === this.tokenEnd) {
          this.next();
          b = consumeB.call(this);
        } else {
          expectCharCode.call(this, i - this.tokenStart + 1, HYPHENMINUS);
          if (i + 2 === this.tokenEnd) {
            this.next();
            this.skipSC();
            checkTokenIsInteger.call(this, DISALLOW_SIGN);
            b = "-" + this.consume(types.Number);
          } else {
            checkInteger.call(this, i - this.tokenStart + 2, DISALLOW_SIGN);
            this.next();
            b = this.substrToCursor(i + 1);
          }
        }
      } else {
        this.error();
      }
      if (a !== null && a.charCodeAt(0) === PLUSSIGN) {
        a = a.substr(1);
      }
      if (b !== null && b.charCodeAt(0) === PLUSSIGN) {
        b = b.substr(1);
      }
      return {
        type: "AnPlusB",
        loc: this.getLocation(start, this.tokenStart),
        a,
        b
      };
    }
    function generate(node) {
      if (node.a) {
        const a = node.a === "+1" && "n" || node.a === "1" && "n" || node.a === "-1" && "-n" || node.a + "n";
        if (node.b) {
          const b = node.b[0] === "-" || node.b[0] === "+" ? node.b : "+" + node.b;
          this.tokenize(a + b);
        } else {
          this.tokenize(a);
        }
      } else {
        this.tokenize(node.b);
      }
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Atrule.cjs
var require_Atrule = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Atrule.cjs"(exports2) {
    "use strict";
    var types = require_types();
    function consumeRaw() {
      return this.Raw(this.consumeUntilLeftCurlyBracketOrSemicolon, true);
    }
    function isDeclarationBlockAtrule() {
      for (let offset = 1, type; type = this.lookupType(offset); offset++) {
        if (type === types.RightCurlyBracket) {
          return true;
        }
        if (type === types.LeftCurlyBracket || type === types.AtKeyword) {
          return false;
        }
      }
      return false;
    }
    var name = "Atrule";
    var walkContext = "atrule";
    var structure = {
      name: String,
      prelude: ["AtrulePrelude", "Raw", null],
      block: ["Block", null]
    };
    function parse(isDeclaration = false) {
      const start = this.tokenStart;
      let name2;
      let nameLowerCase;
      let prelude = null;
      let block = null;
      this.eat(types.AtKeyword);
      name2 = this.substrToCursor(start + 1);
      nameLowerCase = name2.toLowerCase();
      this.skipSC();
      if (this.eof === false && this.tokenType !== types.LeftCurlyBracket && this.tokenType !== types.Semicolon) {
        if (this.parseAtrulePrelude) {
          prelude = this.parseWithFallback(this.AtrulePrelude.bind(this, name2, isDeclaration), consumeRaw);
        } else {
          prelude = consumeRaw.call(this, this.tokenIndex);
        }
        this.skipSC();
      }
      switch (this.tokenType) {
        case types.Semicolon:
          this.next();
          break;
        case types.LeftCurlyBracket:
          if (hasOwnProperty.call(this.atrule, nameLowerCase) && typeof this.atrule[nameLowerCase].block === "function") {
            block = this.atrule[nameLowerCase].block.call(this, isDeclaration);
          } else {
            block = this.Block(isDeclarationBlockAtrule.call(this));
          }
          break;
      }
      return {
        type: "Atrule",
        loc: this.getLocation(start, this.tokenStart),
        name: name2,
        prelude,
        block
      };
    }
    function generate(node) {
      this.token(types.AtKeyword, "@" + node.name);
      if (node.prelude !== null) {
        this.node(node.prelude);
      }
      if (node.block) {
        this.node(node.block);
      } else {
        this.token(types.Semicolon, ";");
      }
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
    exports2.walkContext = walkContext;
  }
});

// node_modules/css-tree/cjs/syntax/node/AtrulePrelude.cjs
var require_AtrulePrelude = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/AtrulePrelude.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "AtrulePrelude";
    var walkContext = "atrulePrelude";
    var structure = {
      children: [[]]
    };
    function parse(name2) {
      let children = null;
      if (name2 !== null) {
        name2 = name2.toLowerCase();
      }
      this.skipSC();
      if (hasOwnProperty.call(this.atrule, name2) && typeof this.atrule[name2].prelude === "function") {
        children = this.atrule[name2].prelude.call(this);
      } else {
        children = this.readSequence(this.scope.AtrulePrelude);
      }
      this.skipSC();
      if (this.eof !== true && this.tokenType !== types.LeftCurlyBracket && this.tokenType !== types.Semicolon) {
        this.error("Semicolon or block is expected");
      }
      return {
        type: "AtrulePrelude",
        loc: this.getLocationFromList(children),
        children
      };
    }
    function generate(node) {
      this.children(node);
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
    exports2.walkContext = walkContext;
  }
});

// node_modules/css-tree/cjs/syntax/node/AttributeSelector.cjs
var require_AttributeSelector = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/AttributeSelector.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var DOLLARSIGN = 36;
    var ASTERISK = 42;
    var EQUALSSIGN = 61;
    var CIRCUMFLEXACCENT = 94;
    var VERTICALLINE = 124;
    var TILDE = 126;
    function getAttributeName() {
      if (this.eof) {
        this.error("Unexpected end of input");
      }
      const start = this.tokenStart;
      let expectIdent = false;
      if (this.isDelim(ASTERISK)) {
        expectIdent = true;
        this.next();
      } else if (!this.isDelim(VERTICALLINE)) {
        this.eat(types.Ident);
      }
      if (this.isDelim(VERTICALLINE)) {
        if (this.charCodeAt(this.tokenStart + 1) !== EQUALSSIGN) {
          this.next();
          this.eat(types.Ident);
        } else if (expectIdent) {
          this.error("Identifier is expected", this.tokenEnd);
        }
      } else if (expectIdent) {
        this.error("Vertical line is expected");
      }
      return {
        type: "Identifier",
        loc: this.getLocation(start, this.tokenStart),
        name: this.substrToCursor(start)
      };
    }
    function getOperator() {
      const start = this.tokenStart;
      const code = this.charCodeAt(start);
      if (code !== EQUALSSIGN && // =
      code !== TILDE && // ~=
      code !== CIRCUMFLEXACCENT && // ^=
      code !== DOLLARSIGN && // $=
      code !== ASTERISK && // *=
      code !== VERTICALLINE) {
        this.error("Attribute selector (=, ~=, ^=, $=, *=, |=) is expected");
      }
      this.next();
      if (code !== EQUALSSIGN) {
        if (!this.isDelim(EQUALSSIGN)) {
          this.error("Equal sign is expected");
        }
        this.next();
      }
      return this.substrToCursor(start);
    }
    var name = "AttributeSelector";
    var structure = {
      name: "Identifier",
      matcher: [String, null],
      value: ["String", "Identifier", null],
      flags: [String, null]
    };
    function parse() {
      const start = this.tokenStart;
      let name2;
      let matcher = null;
      let value = null;
      let flags = null;
      this.eat(types.LeftSquareBracket);
      this.skipSC();
      name2 = getAttributeName.call(this);
      this.skipSC();
      if (this.tokenType !== types.RightSquareBracket) {
        if (this.tokenType !== types.Ident) {
          matcher = getOperator.call(this);
          this.skipSC();
          value = this.tokenType === types.String ? this.String() : this.Identifier();
          this.skipSC();
        }
        if (this.tokenType === types.Ident) {
          flags = this.consume(types.Ident);
          this.skipSC();
        }
      }
      this.eat(types.RightSquareBracket);
      return {
        type: "AttributeSelector",
        loc: this.getLocation(start, this.tokenStart),
        name: name2,
        matcher,
        value,
        flags
      };
    }
    function generate(node) {
      this.token(types.Delim, "[");
      this.node(node.name);
      if (node.matcher !== null) {
        this.tokenize(node.matcher);
        this.node(node.value);
      }
      if (node.flags !== null) {
        this.token(types.Ident, node.flags);
      }
      this.token(types.Delim, "]");
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Block.cjs
var require_Block = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Block.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var AMPERSAND = 38;
    function consumeRaw() {
      return this.Raw(null, true);
    }
    function consumeRule() {
      return this.parseWithFallback(this.Rule, consumeRaw);
    }
    function consumeRawDeclaration() {
      return this.Raw(this.consumeUntilSemicolonIncluded, true);
    }
    function consumeDeclaration() {
      if (this.tokenType === types.Semicolon) {
        return consumeRawDeclaration.call(this, this.tokenIndex);
      }
      const node = this.parseWithFallback(this.Declaration, consumeRawDeclaration);
      if (this.tokenType === types.Semicolon) {
        this.next();
      }
      return node;
    }
    var name = "Block";
    var walkContext = "block";
    var structure = {
      children: [[
        "Atrule",
        "Rule",
        "Declaration"
      ]]
    };
    function parse(isStyleBlock) {
      const consumer = isStyleBlock ? consumeDeclaration : consumeRule;
      const start = this.tokenStart;
      let children = this.createList();
      this.eat(types.LeftCurlyBracket);
      scan:
        while (!this.eof) {
          switch (this.tokenType) {
            case types.RightCurlyBracket:
              break scan;
            case types.WhiteSpace:
            case types.Comment:
              this.next();
              break;
            case types.AtKeyword:
              children.push(this.parseWithFallback(this.Atrule.bind(this, isStyleBlock), consumeRaw));
              break;
            default:
              if (isStyleBlock && this.isDelim(AMPERSAND)) {
                children.push(consumeRule.call(this));
              } else {
                children.push(consumer.call(this));
              }
          }
        }
      if (!this.eof) {
        this.eat(types.RightCurlyBracket);
      }
      return {
        type: "Block",
        loc: this.getLocation(start, this.tokenStart),
        children
      };
    }
    function generate(node) {
      this.token(types.LeftCurlyBracket, "{");
      this.children(node, (prev) => {
        if (prev.type === "Declaration") {
          this.token(types.Semicolon, ";");
        }
      });
      this.token(types.RightCurlyBracket, "}");
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
    exports2.walkContext = walkContext;
  }
});

// node_modules/css-tree/cjs/syntax/node/Brackets.cjs
var require_Brackets = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Brackets.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "Brackets";
    var structure = {
      children: [[]]
    };
    function parse(readSequence, recognizer) {
      const start = this.tokenStart;
      let children = null;
      this.eat(types.LeftSquareBracket);
      children = readSequence.call(this, recognizer);
      if (!this.eof) {
        this.eat(types.RightSquareBracket);
      }
      return {
        type: "Brackets",
        loc: this.getLocation(start, this.tokenStart),
        children
      };
    }
    function generate(node) {
      this.token(types.Delim, "[");
      this.children(node);
      this.token(types.Delim, "]");
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/CDC.cjs
var require_CDC = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/CDC.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "CDC";
    var structure = [];
    function parse() {
      const start = this.tokenStart;
      this.eat(types.CDC);
      return {
        type: "CDC",
        loc: this.getLocation(start, this.tokenStart)
      };
    }
    function generate() {
      this.token(types.CDC, "-->");
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/CDO.cjs
var require_CDO = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/CDO.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "CDO";
    var structure = [];
    function parse() {
      const start = this.tokenStart;
      this.eat(types.CDO);
      return {
        type: "CDO",
        loc: this.getLocation(start, this.tokenStart)
      };
    }
    function generate() {
      this.token(types.CDO, "<!--");
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/ClassSelector.cjs
var require_ClassSelector = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/ClassSelector.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var FULLSTOP = 46;
    var name = "ClassSelector";
    var structure = {
      name: String
    };
    function parse() {
      this.eatDelim(FULLSTOP);
      return {
        type: "ClassSelector",
        loc: this.getLocation(this.tokenStart - 1, this.tokenEnd),
        name: this.consume(types.Ident)
      };
    }
    function generate(node) {
      this.token(types.Delim, ".");
      this.token(types.Ident, node.name);
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Combinator.cjs
var require_Combinator = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Combinator.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var PLUSSIGN = 43;
    var SOLIDUS = 47;
    var GREATERTHANSIGN = 62;
    var TILDE = 126;
    var name = "Combinator";
    var structure = {
      name: String
    };
    function parse() {
      const start = this.tokenStart;
      let name2;
      switch (this.tokenType) {
        case types.WhiteSpace:
          name2 = " ";
          break;
        case types.Delim:
          switch (this.charCodeAt(this.tokenStart)) {
            case GREATERTHANSIGN:
            case PLUSSIGN:
            case TILDE:
              this.next();
              break;
            case SOLIDUS:
              this.next();
              this.eatIdent("deep");
              this.eatDelim(SOLIDUS);
              break;
            default:
              this.error("Combinator is expected");
          }
          name2 = this.substrToCursor(start);
          break;
      }
      return {
        type: "Combinator",
        loc: this.getLocation(start, this.tokenStart),
        name: name2
      };
    }
    function generate(node) {
      this.tokenize(node.name);
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Comment.cjs
var require_Comment = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Comment.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var ASTERISK = 42;
    var SOLIDUS = 47;
    var name = "Comment";
    var structure = {
      value: String
    };
    function parse() {
      const start = this.tokenStart;
      let end = this.tokenEnd;
      this.eat(types.Comment);
      if (end - start + 2 >= 2 && this.charCodeAt(end - 2) === ASTERISK && this.charCodeAt(end - 1) === SOLIDUS) {
        end -= 2;
      }
      return {
        type: "Comment",
        loc: this.getLocation(start, this.tokenStart),
        value: this.substring(start + 2, end)
      };
    }
    function generate(node) {
      this.token(types.Comment, "/*" + node.value + "*/");
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Condition.cjs
var require_Condition = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Condition.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var likelyFeatureToken = /* @__PURE__ */ new Set([types.Colon, types.RightParenthesis, types.EOF]);
    var name = "Condition";
    var structure = {
      kind: String,
      children: [[
        "Identifier",
        "Feature",
        "FeatureFunction",
        "FeatureRange",
        "SupportsDeclaration"
      ]]
    };
    function featureOrRange(kind) {
      if (this.lookupTypeNonSC(1) === types.Ident && likelyFeatureToken.has(this.lookupTypeNonSC(2))) {
        return this.Feature(kind);
      }
      return this.FeatureRange(kind);
    }
    var parentheses = {
      media: featureOrRange,
      container: featureOrRange,
      supports() {
        return this.SupportsDeclaration();
      }
    };
    function parse(kind = "media") {
      const children = this.createList();
      scan: while (!this.eof) {
        switch (this.tokenType) {
          case types.Comment:
          case types.WhiteSpace:
            this.next();
            continue;
          case types.Ident:
            children.push(this.Identifier());
            break;
          case types.LeftParenthesis: {
            let term = this.parseWithFallback(
              () => parentheses[kind].call(this, kind),
              () => null
            );
            if (!term) {
              term = this.parseWithFallback(
                () => {
                  this.eat(types.LeftParenthesis);
                  const res = this.Condition(kind);
                  this.eat(types.RightParenthesis);
                  return res;
                },
                () => {
                  return this.GeneralEnclosed(kind);
                }
              );
            }
            children.push(term);
            break;
          }
          case types.Function: {
            let term = this.parseWithFallback(
              () => this.FeatureFunction(kind),
              () => null
            );
            if (!term) {
              term = this.GeneralEnclosed(kind);
            }
            children.push(term);
            break;
          }
          default:
            break scan;
        }
      }
      if (children.isEmpty) {
        this.error("Condition is expected");
      }
      return {
        type: "Condition",
        loc: this.getLocationFromList(children),
        kind,
        children
      };
    }
    function generate(node) {
      node.children.forEach((child) => {
        if (child.type === "Condition") {
          this.token(types.LeftParenthesis, "(");
          this.node(child);
          this.token(types.RightParenthesis, ")");
        } else {
          this.node(child);
        }
      });
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Declaration.cjs
var require_Declaration = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Declaration.cjs"(exports2) {
    "use strict";
    var names = require_names2();
    var types = require_types();
    var EXCLAMATIONMARK = 33;
    var NUMBERSIGN = 35;
    var DOLLARSIGN = 36;
    var AMPERSAND = 38;
    var ASTERISK = 42;
    var PLUSSIGN = 43;
    var SOLIDUS = 47;
    function consumeValueRaw() {
      return this.Raw(this.consumeUntilExclamationMarkOrSemicolon, true);
    }
    function consumeCustomPropertyRaw() {
      return this.Raw(this.consumeUntilExclamationMarkOrSemicolon, false);
    }
    function consumeValue() {
      const startValueToken = this.tokenIndex;
      const value = this.Value();
      if (value.type !== "Raw" && this.eof === false && this.tokenType !== types.Semicolon && this.isDelim(EXCLAMATIONMARK) === false && this.isBalanceEdge(startValueToken) === false) {
        this.error();
      }
      return value;
    }
    var name = "Declaration";
    var walkContext = "declaration";
    var structure = {
      important: [Boolean, String],
      property: String,
      value: ["Value", "Raw"]
    };
    function parse() {
      const start = this.tokenStart;
      const startToken = this.tokenIndex;
      const property = readProperty.call(this);
      const customProperty = names.isCustomProperty(property);
      const parseValue = customProperty ? this.parseCustomProperty : this.parseValue;
      const consumeRaw = customProperty ? consumeCustomPropertyRaw : consumeValueRaw;
      let important = false;
      let value;
      this.skipSC();
      this.eat(types.Colon);
      const valueStart = this.tokenIndex;
      if (!customProperty) {
        this.skipSC();
      }
      if (parseValue) {
        value = this.parseWithFallback(consumeValue, consumeRaw);
      } else {
        value = consumeRaw.call(this, this.tokenIndex);
      }
      if (customProperty && value.type === "Value" && value.children.isEmpty) {
        for (let offset = valueStart - this.tokenIndex; offset <= 0; offset++) {
          if (this.lookupType(offset) === types.WhiteSpace) {
            value.children.appendData({
              type: "WhiteSpace",
              loc: null,
              value: " "
            });
            break;
          }
        }
      }
      if (this.isDelim(EXCLAMATIONMARK)) {
        important = getImportant.call(this);
        this.skipSC();
      }
      if (this.eof === false && this.tokenType !== types.Semicolon && this.isBalanceEdge(startToken) === false) {
        this.error();
      }
      return {
        type: "Declaration",
        loc: this.getLocation(start, this.tokenStart),
        important,
        property,
        value
      };
    }
    function generate(node) {
      this.token(types.Ident, node.property);
      this.token(types.Colon, ":");
      this.node(node.value);
      if (node.important) {
        this.token(types.Delim, "!");
        this.token(types.Ident, node.important === true ? "important" : node.important);
      }
    }
    function readProperty() {
      const start = this.tokenStart;
      if (this.tokenType === types.Delim) {
        switch (this.charCodeAt(this.tokenStart)) {
          case ASTERISK:
          case DOLLARSIGN:
          case PLUSSIGN:
          case NUMBERSIGN:
          case AMPERSAND:
            this.next();
            break;
          // TODO: not sure we should support this hack
          case SOLIDUS:
            this.next();
            if (this.isDelim(SOLIDUS)) {
              this.next();
            }
            break;
        }
      }
      if (this.tokenType === types.Hash) {
        this.eat(types.Hash);
      } else {
        this.eat(types.Ident);
      }
      return this.substrToCursor(start);
    }
    function getImportant() {
      this.eat(types.Delim);
      this.skipSC();
      const important = this.consume(types.Ident);
      return important === "important" ? true : important;
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
    exports2.walkContext = walkContext;
  }
});

// node_modules/css-tree/cjs/syntax/node/DeclarationList.cjs
var require_DeclarationList = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/DeclarationList.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var AMPERSAND = 38;
    function consumeRaw() {
      return this.Raw(this.consumeUntilSemicolonIncluded, true);
    }
    var name = "DeclarationList";
    var structure = {
      children: [[
        "Declaration",
        "Atrule",
        "Rule"
      ]]
    };
    function parse() {
      const children = this.createList();
      while (!this.eof) {
        switch (this.tokenType) {
          case types.WhiteSpace:
          case types.Comment:
          case types.Semicolon:
            this.next();
            break;
          case types.AtKeyword:
            children.push(this.parseWithFallback(this.Atrule.bind(this, true), consumeRaw));
            break;
          default:
            if (this.isDelim(AMPERSAND)) {
              children.push(this.parseWithFallback(this.Rule, consumeRaw));
            } else {
              children.push(this.parseWithFallback(this.Declaration, consumeRaw));
            }
        }
      }
      return {
        type: "DeclarationList",
        loc: this.getLocationFromList(children),
        children
      };
    }
    function generate(node) {
      this.children(node, (prev) => {
        if (prev.type === "Declaration") {
          this.token(types.Semicolon, ";");
        }
      });
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Dimension.cjs
var require_Dimension = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Dimension.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "Dimension";
    var structure = {
      value: String,
      unit: String
    };
    function parse() {
      const start = this.tokenStart;
      const value = this.consumeNumber(types.Dimension);
      return {
        type: "Dimension",
        loc: this.getLocation(start, this.tokenStart),
        value,
        unit: this.substring(start + value.length, this.tokenStart)
      };
    }
    function generate(node) {
      this.token(types.Dimension, node.value + node.unit);
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Feature.cjs
var require_Feature = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Feature.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var SOLIDUS = 47;
    var name = "Feature";
    var structure = {
      kind: String,
      name: String,
      value: ["Identifier", "Number", "Dimension", "Ratio", "Function", null]
    };
    function parse(kind) {
      const start = this.tokenStart;
      let name2;
      let value = null;
      this.eat(types.LeftParenthesis);
      this.skipSC();
      name2 = this.consume(types.Ident);
      this.skipSC();
      if (this.tokenType !== types.RightParenthesis) {
        this.eat(types.Colon);
        this.skipSC();
        switch (this.tokenType) {
          case types.Number:
            if (this.lookupNonWSType(1) === types.Delim) {
              value = this.Ratio();
            } else {
              value = this.Number();
            }
            break;
          case types.Dimension:
            value = this.Dimension();
            break;
          case types.Ident:
            value = this.Identifier();
            break;
          case types.Function:
            value = this.parseWithFallback(
              () => {
                const res = this.Function(this.readSequence, this.scope.Value);
                this.skipSC();
                if (this.isDelim(SOLIDUS)) {
                  this.error();
                }
                return res;
              },
              () => {
                return this.Ratio();
              }
            );
            break;
          default:
            this.error("Number, dimension, ratio or identifier is expected");
        }
        this.skipSC();
      }
      if (!this.eof) {
        this.eat(types.RightParenthesis);
      }
      return {
        type: "Feature",
        loc: this.getLocation(start, this.tokenStart),
        kind,
        name: name2,
        value
      };
    }
    function generate(node) {
      this.token(types.LeftParenthesis, "(");
      this.token(types.Ident, node.name);
      if (node.value !== null) {
        this.token(types.Colon, ":");
        this.node(node.value);
      }
      this.token(types.RightParenthesis, ")");
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/FeatureFunction.cjs
var require_FeatureFunction = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/FeatureFunction.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "FeatureFunction";
    var structure = {
      kind: String,
      feature: String,
      value: ["Declaration", "Selector"]
    };
    function getFeatureParser(kind, name2) {
      const featuresOfKind = this.features[kind] || {};
      const parser = featuresOfKind[name2];
      if (typeof parser !== "function") {
        this.error(`Unknown feature ${name2}()`);
      }
      return parser;
    }
    function parse(kind = "unknown") {
      const start = this.tokenStart;
      const functionName = this.consumeFunctionName();
      const valueParser = getFeatureParser.call(this, kind, functionName.toLowerCase());
      this.skipSC();
      const value = this.parseWithFallback(
        () => {
          const startValueToken = this.tokenIndex;
          const value2 = valueParser.call(this);
          if (this.eof === false && this.isBalanceEdge(startValueToken) === false) {
            this.error();
          }
          return value2;
        },
        () => this.Raw(null, false)
      );
      if (!this.eof) {
        this.eat(types.RightParenthesis);
      }
      return {
        type: "FeatureFunction",
        loc: this.getLocation(start, this.tokenStart),
        kind,
        feature: functionName,
        value
      };
    }
    function generate(node) {
      this.token(types.Function, node.feature + "(");
      this.node(node.value);
      this.token(types.RightParenthesis, ")");
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/FeatureRange.cjs
var require_FeatureRange = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/FeatureRange.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var SOLIDUS = 47;
    var LESSTHANSIGN = 60;
    var EQUALSSIGN = 61;
    var GREATERTHANSIGN = 62;
    var name = "FeatureRange";
    var structure = {
      kind: String,
      left: ["Identifier", "Number", "Dimension", "Ratio", "Function"],
      leftComparison: String,
      middle: ["Identifier", "Number", "Dimension", "Ratio", "Function"],
      rightComparison: [String, null],
      right: ["Identifier", "Number", "Dimension", "Ratio", "Function", null]
    };
    function readTerm() {
      this.skipSC();
      switch (this.tokenType) {
        case types.Number:
          if (this.isDelim(SOLIDUS, this.lookupOffsetNonSC(1))) {
            return this.Ratio();
          } else {
            return this.Number();
          }
        case types.Dimension:
          return this.Dimension();
        case types.Ident:
          return this.Identifier();
        case types.Function:
          return this.parseWithFallback(
            () => {
              const res = this.Function(this.readSequence, this.scope.Value);
              this.skipSC();
              if (this.isDelim(SOLIDUS)) {
                this.error();
              }
              return res;
            },
            () => {
              return this.Ratio();
            }
          );
        default:
          this.error("Number, dimension, ratio or identifier is expected");
      }
    }
    function readComparison(expectColon) {
      this.skipSC();
      if (this.isDelim(LESSTHANSIGN) || this.isDelim(GREATERTHANSIGN)) {
        const value = this.source[this.tokenStart];
        this.next();
        if (this.isDelim(EQUALSSIGN)) {
          this.next();
          return value + "=";
        }
        return value;
      }
      if (this.isDelim(EQUALSSIGN)) {
        return "=";
      }
      this.error(`Expected ${expectColon ? '":", ' : ""}"<", ">", "=" or ")"`);
    }
    function parse(kind = "unknown") {
      const start = this.tokenStart;
      this.skipSC();
      this.eat(types.LeftParenthesis);
      const left = readTerm.call(this);
      const leftComparison = readComparison.call(this, left.type === "Identifier");
      const middle = readTerm.call(this);
      let rightComparison = null;
      let right = null;
      if (this.lookupNonWSType(0) !== types.RightParenthesis) {
        rightComparison = readComparison.call(this);
        right = readTerm.call(this);
      }
      this.skipSC();
      this.eat(types.RightParenthesis);
      return {
        type: "FeatureRange",
        loc: this.getLocation(start, this.tokenStart),
        kind,
        left,
        leftComparison,
        middle,
        rightComparison,
        right
      };
    }
    function generate(node) {
      this.token(types.LeftParenthesis, "(");
      this.node(node.left);
      this.tokenize(node.leftComparison);
      this.node(node.middle);
      if (node.right) {
        this.tokenize(node.rightComparison);
        this.node(node.right);
      }
      this.token(types.RightParenthesis, ")");
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Function.cjs
var require_Function = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Function.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "Function";
    var walkContext = "function";
    var structure = {
      name: String,
      children: [[]]
    };
    function parse(readSequence, recognizer) {
      const start = this.tokenStart;
      const name2 = this.consumeFunctionName();
      const nameLowerCase = name2.toLowerCase();
      let children;
      children = recognizer.hasOwnProperty(nameLowerCase) ? recognizer[nameLowerCase].call(this, recognizer) : readSequence.call(this, recognizer);
      if (!this.eof) {
        this.eat(types.RightParenthesis);
      }
      return {
        type: "Function",
        loc: this.getLocation(start, this.tokenStart),
        name: name2,
        children
      };
    }
    function generate(node) {
      this.token(types.Function, node.name + "(");
      this.children(node);
      this.token(types.RightParenthesis, ")");
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
    exports2.walkContext = walkContext;
  }
});

// node_modules/css-tree/cjs/syntax/node/GeneralEnclosed.cjs
var require_GeneralEnclosed = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/GeneralEnclosed.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "GeneralEnclosed";
    var structure = {
      kind: String,
      function: [String, null],
      children: [[]]
    };
    function parse(kind) {
      const start = this.tokenStart;
      let functionName = null;
      if (this.tokenType === types.Function) {
        functionName = this.consumeFunctionName();
      } else {
        this.eat(types.LeftParenthesis);
      }
      const children = this.parseWithFallback(
        () => {
          const startValueToken = this.tokenIndex;
          const children2 = this.readSequence(this.scope.Value);
          if (this.eof === false && this.isBalanceEdge(startValueToken) === false) {
            this.error();
          }
          return children2;
        },
        () => this.createSingleNodeList(
          this.Raw(null, false)
        )
      );
      if (!this.eof) {
        this.eat(types.RightParenthesis);
      }
      return {
        type: "GeneralEnclosed",
        loc: this.getLocation(start, this.tokenStart),
        kind,
        function: functionName,
        children
      };
    }
    function generate(node) {
      if (node.function) {
        this.token(types.Function, node.function + "(");
      } else {
        this.token(types.LeftParenthesis, "(");
      }
      this.children(node);
      this.token(types.RightParenthesis, ")");
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Hash.cjs
var require_Hash = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Hash.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var xxx = "XXX";
    var name = "Hash";
    var structure = {
      value: String
    };
    function parse() {
      const start = this.tokenStart;
      this.eat(types.Hash);
      return {
        type: "Hash",
        loc: this.getLocation(start, this.tokenStart),
        value: this.substrToCursor(start + 1)
      };
    }
    function generate(node) {
      this.token(types.Hash, "#" + node.value);
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
    exports2.xxx = xxx;
  }
});

// node_modules/css-tree/cjs/syntax/node/Identifier.cjs
var require_Identifier = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Identifier.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "Identifier";
    var structure = {
      name: String
    };
    function parse() {
      return {
        type: "Identifier",
        loc: this.getLocation(this.tokenStart, this.tokenEnd),
        name: this.consume(types.Ident)
      };
    }
    function generate(node) {
      this.token(types.Ident, node.name);
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/IdSelector.cjs
var require_IdSelector = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/IdSelector.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "IdSelector";
    var structure = {
      name: String
    };
    function parse() {
      const start = this.tokenStart;
      this.eat(types.Hash);
      return {
        type: "IdSelector",
        loc: this.getLocation(start, this.tokenStart),
        name: this.substrToCursor(start + 1)
      };
    }
    function generate(node) {
      this.token(types.Delim, "#" + node.name);
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Layer.cjs
var require_Layer = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Layer.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var FULLSTOP = 46;
    var name = "Layer";
    var structure = {
      name: String
    };
    function parse() {
      let tokenStart = this.tokenStart;
      let name2 = this.consume(types.Ident);
      while (this.isDelim(FULLSTOP)) {
        this.eat(types.Delim);
        name2 += "." + this.consume(types.Ident);
      }
      return {
        type: "Layer",
        loc: this.getLocation(tokenStart, this.tokenStart),
        name: name2
      };
    }
    function generate(node) {
      this.tokenize(node.name);
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/LayerList.cjs
var require_LayerList = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/LayerList.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "LayerList";
    var structure = {
      children: [[
        "Layer"
      ]]
    };
    function parse() {
      const children = this.createList();
      this.skipSC();
      while (!this.eof) {
        children.push(this.Layer());
        if (this.lookupTypeNonSC(0) !== types.Comma) {
          break;
        }
        this.skipSC();
        this.next();
        this.skipSC();
      }
      return {
        type: "LayerList",
        loc: this.getLocationFromList(children),
        children
      };
    }
    function generate(node) {
      this.children(node, () => this.token(types.Comma, ","));
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/MediaQuery.cjs
var require_MediaQuery = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/MediaQuery.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "MediaQuery";
    var structure = {
      modifier: [String, null],
      mediaType: [String, null],
      condition: ["Condition", null]
    };
    function parse() {
      const start = this.tokenStart;
      let modifier = null;
      let mediaType = null;
      let condition = null;
      this.skipSC();
      if (this.tokenType === types.Ident && this.lookupTypeNonSC(1) !== types.LeftParenthesis) {
        const ident = this.consume(types.Ident);
        const identLowerCase = ident.toLowerCase();
        if (identLowerCase === "not" || identLowerCase === "only") {
          this.skipSC();
          modifier = identLowerCase;
          mediaType = this.consume(types.Ident);
        } else {
          mediaType = ident;
        }
        switch (this.lookupTypeNonSC(0)) {
          case types.Ident: {
            this.skipSC();
            this.eatIdent("and");
            condition = this.Condition("media");
            break;
          }
          case types.LeftCurlyBracket:
          case types.Semicolon:
          case types.Comma:
          case types.EOF:
            break;
          default:
            this.error("Identifier or parenthesis is expected");
        }
      } else {
        switch (this.tokenType) {
          case types.Ident:
          case types.LeftParenthesis:
          case types.Function: {
            condition = this.Condition("media");
            break;
          }
          case types.LeftCurlyBracket:
          case types.Semicolon:
          case types.EOF:
            break;
          default:
            this.error("Identifier or parenthesis is expected");
        }
      }
      return {
        type: "MediaQuery",
        loc: this.getLocation(start, this.tokenStart),
        modifier,
        mediaType,
        condition
      };
    }
    function generate(node) {
      if (node.mediaType) {
        if (node.modifier) {
          this.token(types.Ident, node.modifier);
        }
        this.token(types.Ident, node.mediaType);
        if (node.condition) {
          this.token(types.Ident, "and");
          this.node(node.condition);
        }
      } else if (node.condition) {
        this.node(node.condition);
      }
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/MediaQueryList.cjs
var require_MediaQueryList = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/MediaQueryList.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "MediaQueryList";
    var structure = {
      children: [[
        "MediaQuery"
      ]]
    };
    function parse() {
      const children = this.createList();
      this.skipSC();
      while (!this.eof) {
        children.push(this.MediaQuery());
        if (this.tokenType !== types.Comma) {
          break;
        }
        this.next();
      }
      return {
        type: "MediaQueryList",
        loc: this.getLocationFromList(children),
        children
      };
    }
    function generate(node) {
      this.children(node, () => this.token(types.Comma, ","));
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/NestingSelector.cjs
var require_NestingSelector = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/NestingSelector.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var AMPERSAND = 38;
    var name = "NestingSelector";
    var structure = {};
    function parse() {
      const start = this.tokenStart;
      this.eatDelim(AMPERSAND);
      return {
        type: "NestingSelector",
        loc: this.getLocation(start, this.tokenStart)
      };
    }
    function generate() {
      this.token(types.Delim, "&");
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Nth.cjs
var require_Nth = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Nth.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "Nth";
    var structure = {
      nth: ["AnPlusB", "Identifier"],
      selector: ["SelectorList", null]
    };
    function parse() {
      this.skipSC();
      const start = this.tokenStart;
      let end = start;
      let selector = null;
      let nth;
      if (this.lookupValue(0, "odd") || this.lookupValue(0, "even")) {
        nth = this.Identifier();
      } else {
        nth = this.AnPlusB();
      }
      end = this.tokenStart;
      this.skipSC();
      if (this.lookupValue(0, "of")) {
        this.next();
        selector = this.SelectorList();
        end = this.tokenStart;
      }
      return {
        type: "Nth",
        loc: this.getLocation(start, end),
        nth,
        selector
      };
    }
    function generate(node) {
      this.node(node.nth);
      if (node.selector !== null) {
        this.token(types.Ident, "of");
        this.node(node.selector);
      }
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Number.cjs
var require_Number = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Number.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "Number";
    var structure = {
      value: String
    };
    function parse() {
      return {
        type: "Number",
        loc: this.getLocation(this.tokenStart, this.tokenEnd),
        value: this.consume(types.Number)
      };
    }
    function generate(node) {
      this.token(types.Number, node.value);
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Operator.cjs
var require_Operator = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Operator.cjs"(exports2) {
    "use strict";
    var name = "Operator";
    var structure = {
      value: String
    };
    function parse() {
      const start = this.tokenStart;
      this.next();
      return {
        type: "Operator",
        loc: this.getLocation(start, this.tokenStart),
        value: this.substrToCursor(start)
      };
    }
    function generate(node) {
      this.tokenize(node.value);
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Parentheses.cjs
var require_Parentheses = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Parentheses.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "Parentheses";
    var structure = {
      children: [[]]
    };
    function parse(readSequence, recognizer) {
      const start = this.tokenStart;
      let children = null;
      this.eat(types.LeftParenthesis);
      children = readSequence.call(this, recognizer);
      if (!this.eof) {
        this.eat(types.RightParenthesis);
      }
      return {
        type: "Parentheses",
        loc: this.getLocation(start, this.tokenStart),
        children
      };
    }
    function generate(node) {
      this.token(types.LeftParenthesis, "(");
      this.children(node);
      this.token(types.RightParenthesis, ")");
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Percentage.cjs
var require_Percentage = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Percentage.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "Percentage";
    var structure = {
      value: String
    };
    function parse() {
      return {
        type: "Percentage",
        loc: this.getLocation(this.tokenStart, this.tokenEnd),
        value: this.consumeNumber(types.Percentage)
      };
    }
    function generate(node) {
      this.token(types.Percentage, node.value + "%");
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/PseudoClassSelector.cjs
var require_PseudoClassSelector = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/PseudoClassSelector.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "PseudoClassSelector";
    var walkContext = "function";
    var structure = {
      name: String,
      children: [["Raw"], null]
    };
    function parse() {
      const start = this.tokenStart;
      let children = null;
      let name2;
      let nameLowerCase;
      this.eat(types.Colon);
      if (this.tokenType === types.Function) {
        name2 = this.consumeFunctionName();
        nameLowerCase = name2.toLowerCase();
        if (this.lookupNonWSType(0) == types.RightParenthesis) {
          children = this.createList();
        } else if (hasOwnProperty.call(this.pseudo, nameLowerCase)) {
          this.skipSC();
          children = this.pseudo[nameLowerCase].call(this);
          this.skipSC();
        } else {
          children = this.createList();
          children.push(
            this.Raw(null, false)
          );
        }
        this.eat(types.RightParenthesis);
      } else {
        name2 = this.consume(types.Ident);
      }
      return {
        type: "PseudoClassSelector",
        loc: this.getLocation(start, this.tokenStart),
        name: name2,
        children
      };
    }
    function generate(node) {
      this.token(types.Colon, ":");
      if (node.children === null) {
        this.token(types.Ident, node.name);
      } else {
        this.token(types.Function, node.name + "(");
        this.children(node);
        this.token(types.RightParenthesis, ")");
      }
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
    exports2.walkContext = walkContext;
  }
});

// node_modules/css-tree/cjs/syntax/node/PseudoElementSelector.cjs
var require_PseudoElementSelector = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/PseudoElementSelector.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "PseudoElementSelector";
    var walkContext = "function";
    var structure = {
      name: String,
      children: [["Raw"], null]
    };
    function parse() {
      const start = this.tokenStart;
      let children = null;
      let name2;
      let nameLowerCase;
      this.eat(types.Colon);
      this.eat(types.Colon);
      if (this.tokenType === types.Function) {
        name2 = this.consumeFunctionName();
        nameLowerCase = name2.toLowerCase();
        if (this.lookupNonWSType(0) == types.RightParenthesis) {
          children = this.createList();
        } else if (hasOwnProperty.call(this.pseudo, nameLowerCase)) {
          this.skipSC();
          children = this.pseudo[nameLowerCase].call(this);
          this.skipSC();
        } else {
          children = this.createList();
          children.push(
            this.Raw(null, false)
          );
        }
        this.eat(types.RightParenthesis);
      } else {
        name2 = this.consume(types.Ident);
      }
      return {
        type: "PseudoElementSelector",
        loc: this.getLocation(start, this.tokenStart),
        name: name2,
        children
      };
    }
    function generate(node) {
      this.token(types.Colon, ":");
      this.token(types.Colon, ":");
      if (node.children === null) {
        this.token(types.Ident, node.name);
      } else {
        this.token(types.Function, node.name + "(");
        this.children(node);
        this.token(types.RightParenthesis, ")");
      }
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
    exports2.walkContext = walkContext;
  }
});

// node_modules/css-tree/cjs/syntax/node/Ratio.cjs
var require_Ratio = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Ratio.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var SOLIDUS = 47;
    function consumeTerm() {
      this.skipSC();
      switch (this.tokenType) {
        case types.Number:
          return this.Number();
        case types.Function:
          return this.Function(this.readSequence, this.scope.Value);
        default:
          this.error("Number of function is expected");
      }
    }
    var name = "Ratio";
    var structure = {
      left: ["Number", "Function"],
      right: ["Number", "Function", null]
    };
    function parse() {
      const start = this.tokenStart;
      const left = consumeTerm.call(this);
      let right = null;
      this.skipSC();
      if (this.isDelim(SOLIDUS)) {
        this.eatDelim(SOLIDUS);
        right = consumeTerm.call(this);
      }
      return {
        type: "Ratio",
        loc: this.getLocation(start, this.tokenStart),
        left,
        right
      };
    }
    function generate(node) {
      this.node(node.left);
      this.token(types.Delim, "/");
      if (node.right) {
        this.node(node.right);
      } else {
        this.node(types.Number, 1);
      }
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Raw.cjs
var require_Raw = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Raw.cjs"(exports2) {
    "use strict";
    var types = require_types();
    function getOffsetExcludeWS() {
      if (this.tokenIndex > 0) {
        if (this.lookupType(-1) === types.WhiteSpace) {
          return this.tokenIndex > 1 ? this.getTokenStart(this.tokenIndex - 1) : this.firstCharOffset;
        }
      }
      return this.tokenStart;
    }
    var name = "Raw";
    var structure = {
      value: String
    };
    function parse(consumeUntil, excludeWhiteSpace) {
      const startOffset = this.getTokenStart(this.tokenIndex);
      let endOffset;
      this.skipUntilBalanced(this.tokenIndex, consumeUntil || this.consumeUntilBalanceEnd);
      if (excludeWhiteSpace && this.tokenStart > startOffset) {
        endOffset = getOffsetExcludeWS.call(this);
      } else {
        endOffset = this.tokenStart;
      }
      return {
        type: "Raw",
        loc: this.getLocation(startOffset, endOffset),
        value: this.substring(startOffset, endOffset)
      };
    }
    function generate(node) {
      this.tokenize(node.value);
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Rule.cjs
var require_Rule = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Rule.cjs"(exports2) {
    "use strict";
    var types = require_types();
    function consumeRaw() {
      return this.Raw(this.consumeUntilLeftCurlyBracket, true);
    }
    function consumePrelude() {
      const prelude = this.SelectorList();
      if (prelude.type !== "Raw" && this.eof === false && this.tokenType !== types.LeftCurlyBracket) {
        this.error();
      }
      return prelude;
    }
    var name = "Rule";
    var walkContext = "rule";
    var structure = {
      prelude: ["SelectorList", "Raw"],
      block: ["Block"]
    };
    function parse() {
      const startToken = this.tokenIndex;
      const startOffset = this.tokenStart;
      let prelude;
      let block;
      if (this.parseRulePrelude) {
        prelude = this.parseWithFallback(consumePrelude, consumeRaw);
      } else {
        prelude = consumeRaw.call(this, startToken);
      }
      block = this.Block(true);
      return {
        type: "Rule",
        loc: this.getLocation(startOffset, this.tokenStart),
        prelude,
        block
      };
    }
    function generate(node) {
      this.node(node.prelude);
      this.node(node.block);
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
    exports2.walkContext = walkContext;
  }
});

// node_modules/css-tree/cjs/syntax/node/Scope.cjs
var require_Scope = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Scope.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "Scope";
    var structure = {
      root: ["SelectorList", "Raw", null],
      limit: ["SelectorList", "Raw", null]
    };
    function parse() {
      let root = null;
      let limit = null;
      this.skipSC();
      const startOffset = this.tokenStart;
      if (this.tokenType === types.LeftParenthesis) {
        this.next();
        this.skipSC();
        root = this.parseWithFallback(
          this.SelectorList,
          () => this.Raw(false, true)
        );
        this.skipSC();
        this.eat(types.RightParenthesis);
      }
      if (this.lookupNonWSType(0) === types.Ident) {
        this.skipSC();
        this.eatIdent("to");
        this.skipSC();
        this.eat(types.LeftParenthesis);
        this.skipSC();
        limit = this.parseWithFallback(
          this.SelectorList,
          () => this.Raw(false, true)
        );
        this.skipSC();
        this.eat(types.RightParenthesis);
      }
      return {
        type: "Scope",
        loc: this.getLocation(startOffset, this.tokenStart),
        root,
        limit
      };
    }
    function generate(node) {
      if (node.root) {
        this.token(types.LeftParenthesis, "(");
        this.node(node.root);
        this.token(types.RightParenthesis, ")");
      }
      if (node.limit) {
        this.token(types.Ident, "to");
        this.token(types.LeftParenthesis, "(");
        this.node(node.limit);
        this.token(types.RightParenthesis, ")");
      }
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Selector.cjs
var require_Selector = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Selector.cjs"(exports2) {
    "use strict";
    var name = "Selector";
    var structure = {
      children: [[
        "TypeSelector",
        "IdSelector",
        "ClassSelector",
        "AttributeSelector",
        "PseudoClassSelector",
        "PseudoElementSelector",
        "Combinator"
      ]]
    };
    function parse() {
      const children = this.readSequence(this.scope.Selector);
      if (this.getFirstListNode(children) === null) {
        this.error("Selector is expected");
      }
      return {
        type: "Selector",
        loc: this.getLocationFromList(children),
        children
      };
    }
    function generate(node) {
      this.children(node);
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/SelectorList.cjs
var require_SelectorList = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/SelectorList.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "SelectorList";
    var walkContext = "selector";
    var structure = {
      children: [[
        "Selector",
        "Raw"
      ]]
    };
    function parse() {
      const children = this.createList();
      while (!this.eof) {
        children.push(this.Selector());
        if (this.tokenType === types.Comma) {
          this.next();
          continue;
        }
        break;
      }
      return {
        type: "SelectorList",
        loc: this.getLocationFromList(children),
        children
      };
    }
    function generate(node) {
      this.children(node, () => this.token(types.Comma, ","));
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
    exports2.walkContext = walkContext;
  }
});

// node_modules/css-tree/cjs/utils/string.cjs
var require_string = __commonJS({
  "node_modules/css-tree/cjs/utils/string.cjs"(exports2) {
    "use strict";
    var charCodeDefinitions = require_char_code_definitions();
    var utils = require_utils();
    var REVERSE_SOLIDUS = 92;
    var QUOTATION_MARK = 34;
    var APOSTROPHE = 39;
    function decode2(str) {
      const len = str.length;
      const firstChar = str.charCodeAt(0);
      const start = firstChar === QUOTATION_MARK || firstChar === APOSTROPHE ? 1 : 0;
      const end = start === 1 && len > 1 && str.charCodeAt(len - 1) === firstChar ? len - 2 : len - 1;
      let decoded = "";
      for (let i = start; i <= end; i++) {
        let code = str.charCodeAt(i);
        if (code === REVERSE_SOLIDUS) {
          if (i === end) {
            if (i !== len - 1) {
              decoded = str.substr(i + 1);
            }
            break;
          }
          code = str.charCodeAt(++i);
          if (charCodeDefinitions.isValidEscape(REVERSE_SOLIDUS, code)) {
            const escapeStart = i - 1;
            const escapeEnd = utils.consumeEscaped(str, escapeStart);
            i = escapeEnd - 1;
            decoded += utils.decodeEscaped(str.substring(escapeStart + 1, escapeEnd));
          } else {
            if (code === 13 && str.charCodeAt(i + 1) === 10) {
              i++;
            }
          }
        } else {
          decoded += str[i];
        }
      }
      return decoded;
    }
    function encode2(str, apostrophe) {
      const quote = apostrophe ? "'" : '"';
      const quoteCode = apostrophe ? APOSTROPHE : QUOTATION_MARK;
      let encoded = "";
      let wsBeforeHexIsNeeded = false;
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code === 0) {
          encoded += "\uFFFD";
          continue;
        }
        if (code <= 31 || code === 127) {
          encoded += "\\" + code.toString(16);
          wsBeforeHexIsNeeded = true;
          continue;
        }
        if (code === quoteCode || code === REVERSE_SOLIDUS) {
          encoded += "\\" + str.charAt(i);
          wsBeforeHexIsNeeded = false;
        } else {
          if (wsBeforeHexIsNeeded && (charCodeDefinitions.isHexDigit(code) || charCodeDefinitions.isWhiteSpace(code))) {
            encoded += " ";
          }
          encoded += str.charAt(i);
          wsBeforeHexIsNeeded = false;
        }
      }
      return quote + encoded + quote;
    }
    exports2.decode = decode2;
    exports2.encode = encode2;
  }
});

// node_modules/css-tree/cjs/syntax/node/String.cjs
var require_String = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/String.cjs"(exports2) {
    "use strict";
    var string = require_string();
    var types = require_types();
    var name = "String";
    var structure = {
      value: String
    };
    function parse() {
      return {
        type: "String",
        loc: this.getLocation(this.tokenStart, this.tokenEnd),
        value: string.decode(this.consume(types.String))
      };
    }
    function generate(node) {
      this.token(types.String, string.encode(node.value));
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/StyleSheet.cjs
var require_StyleSheet = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/StyleSheet.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var EXCLAMATIONMARK = 33;
    function consumeRaw() {
      return this.Raw(null, false);
    }
    var name = "StyleSheet";
    var walkContext = "stylesheet";
    var structure = {
      children: [[
        "Comment",
        "CDO",
        "CDC",
        "Atrule",
        "Rule",
        "Raw"
      ]]
    };
    function parse() {
      const start = this.tokenStart;
      const children = this.createList();
      let child;
      while (!this.eof) {
        switch (this.tokenType) {
          case types.WhiteSpace:
            this.next();
            continue;
          case types.Comment:
            if (this.charCodeAt(this.tokenStart + 2) !== EXCLAMATIONMARK) {
              this.next();
              continue;
            }
            child = this.Comment();
            break;
          case types.CDO:
            child = this.CDO();
            break;
          case types.CDC:
            child = this.CDC();
            break;
          // CSS Syntax Module Level 3
          // §2.2 Error handling
          // At the "top level" of a stylesheet, an <at-keyword-token> starts an at-rule.
          case types.AtKeyword:
            child = this.parseWithFallback(this.Atrule, consumeRaw);
            break;
          // Anything else starts a qualified rule ...
          default:
            child = this.parseWithFallback(this.Rule, consumeRaw);
        }
        children.push(child);
      }
      return {
        type: "StyleSheet",
        loc: this.getLocation(start, this.tokenStart),
        children
      };
    }
    function generate(node) {
      this.children(node);
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
    exports2.walkContext = walkContext;
  }
});

// node_modules/css-tree/cjs/syntax/node/SupportsDeclaration.cjs
var require_SupportsDeclaration = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/SupportsDeclaration.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var name = "SupportsDeclaration";
    var structure = {
      declaration: "Declaration"
    };
    function parse() {
      const start = this.tokenStart;
      this.eat(types.LeftParenthesis);
      this.skipSC();
      const declaration = this.Declaration();
      if (!this.eof) {
        this.eat(types.RightParenthesis);
      }
      return {
        type: "SupportsDeclaration",
        loc: this.getLocation(start, this.tokenStart),
        declaration
      };
    }
    function generate(node) {
      this.token(types.LeftParenthesis, "(");
      this.node(node.declaration);
      this.token(types.RightParenthesis, ")");
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/TypeSelector.cjs
var require_TypeSelector = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/TypeSelector.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var ASTERISK = 42;
    var VERTICALLINE = 124;
    function eatIdentifierOrAsterisk() {
      if (this.tokenType !== types.Ident && this.isDelim(ASTERISK) === false) {
        this.error("Identifier or asterisk is expected");
      }
      this.next();
    }
    var name = "TypeSelector";
    var structure = {
      name: String
    };
    function parse() {
      const start = this.tokenStart;
      if (this.isDelim(VERTICALLINE)) {
        this.next();
        eatIdentifierOrAsterisk.call(this);
      } else {
        eatIdentifierOrAsterisk.call(this);
        if (this.isDelim(VERTICALLINE)) {
          this.next();
          eatIdentifierOrAsterisk.call(this);
        }
      }
      return {
        type: "TypeSelector",
        loc: this.getLocation(start, this.tokenStart),
        name: this.substrToCursor(start)
      };
    }
    function generate(node) {
      this.tokenize(node.name);
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/UnicodeRange.cjs
var require_UnicodeRange = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/UnicodeRange.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var charCodeDefinitions = require_char_code_definitions();
    var PLUSSIGN = 43;
    var HYPHENMINUS = 45;
    var QUESTIONMARK = 63;
    function eatHexSequence(offset, allowDash) {
      let len = 0;
      for (let pos = this.tokenStart + offset; pos < this.tokenEnd; pos++) {
        const code = this.charCodeAt(pos);
        if (code === HYPHENMINUS && allowDash && len !== 0) {
          eatHexSequence.call(this, offset + len + 1, false);
          return -1;
        }
        if (!charCodeDefinitions.isHexDigit(code)) {
          this.error(
            allowDash && len !== 0 ? "Hyphen minus" + (len < 6 ? " or hex digit" : "") + " is expected" : len < 6 ? "Hex digit is expected" : "Unexpected input",
            pos
          );
        }
        if (++len > 6) {
          this.error("Too many hex digits", pos);
        }
      }
      this.next();
      return len;
    }
    function eatQuestionMarkSequence(max) {
      let count = 0;
      while (this.isDelim(QUESTIONMARK)) {
        if (++count > max) {
          this.error("Too many question marks");
        }
        this.next();
      }
    }
    function startsWith(code) {
      if (this.charCodeAt(this.tokenStart) !== code) {
        this.error((code === PLUSSIGN ? "Plus sign" : "Hyphen minus") + " is expected");
      }
    }
    function scanUnicodeRange() {
      let hexLength = 0;
      switch (this.tokenType) {
        case types.Number:
          hexLength = eatHexSequence.call(this, 1, true);
          if (this.isDelim(QUESTIONMARK)) {
            eatQuestionMarkSequence.call(this, 6 - hexLength);
            break;
          }
          if (this.tokenType === types.Dimension || this.tokenType === types.Number) {
            startsWith.call(this, HYPHENMINUS);
            eatHexSequence.call(this, 1, false);
            break;
          }
          break;
        case types.Dimension:
          hexLength = eatHexSequence.call(this, 1, true);
          if (hexLength > 0) {
            eatQuestionMarkSequence.call(this, 6 - hexLength);
          }
          break;
        default:
          this.eatDelim(PLUSSIGN);
          if (this.tokenType === types.Ident) {
            hexLength = eatHexSequence.call(this, 0, true);
            if (hexLength > 0) {
              eatQuestionMarkSequence.call(this, 6 - hexLength);
            }
            break;
          }
          if (this.isDelim(QUESTIONMARK)) {
            this.next();
            eatQuestionMarkSequence.call(this, 5);
            break;
          }
          this.error("Hex digit or question mark is expected");
      }
    }
    var name = "UnicodeRange";
    var structure = {
      value: String
    };
    function parse() {
      const start = this.tokenStart;
      this.eatIdent("u");
      scanUnicodeRange.call(this);
      return {
        type: "UnicodeRange",
        loc: this.getLocation(start, this.tokenStart),
        value: this.substrToCursor(start)
      };
    }
    function generate(node) {
      this.tokenize(node.value);
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/utils/url.cjs
var require_url = __commonJS({
  "node_modules/css-tree/cjs/utils/url.cjs"(exports2) {
    "use strict";
    var charCodeDefinitions = require_char_code_definitions();
    var utils = require_utils();
    var SPACE = 32;
    var REVERSE_SOLIDUS = 92;
    var QUOTATION_MARK = 34;
    var APOSTROPHE = 39;
    var LEFTPARENTHESIS = 40;
    var RIGHTPARENTHESIS = 41;
    function decode2(str) {
      const len = str.length;
      let start = 4;
      let end = str.charCodeAt(len - 1) === RIGHTPARENTHESIS ? len - 2 : len - 1;
      let decoded = "";
      while (start < end && charCodeDefinitions.isWhiteSpace(str.charCodeAt(start))) {
        start++;
      }
      while (start < end && charCodeDefinitions.isWhiteSpace(str.charCodeAt(end))) {
        end--;
      }
      for (let i = start; i <= end; i++) {
        let code = str.charCodeAt(i);
        if (code === REVERSE_SOLIDUS) {
          if (i === end) {
            if (i !== len - 1) {
              decoded = str.substr(i + 1);
            }
            break;
          }
          code = str.charCodeAt(++i);
          if (charCodeDefinitions.isValidEscape(REVERSE_SOLIDUS, code)) {
            const escapeStart = i - 1;
            const escapeEnd = utils.consumeEscaped(str, escapeStart);
            i = escapeEnd - 1;
            decoded += utils.decodeEscaped(str.substring(escapeStart + 1, escapeEnd));
          } else {
            if (code === 13 && str.charCodeAt(i + 1) === 10) {
              i++;
            }
          }
        } else {
          decoded += str[i];
        }
      }
      return decoded;
    }
    function encode2(str) {
      let encoded = "";
      let wsBeforeHexIsNeeded = false;
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code === 0) {
          encoded += "\uFFFD";
          continue;
        }
        if (code <= 31 || code === 127) {
          encoded += "\\" + code.toString(16);
          wsBeforeHexIsNeeded = true;
          continue;
        }
        if (code === SPACE || code === REVERSE_SOLIDUS || code === QUOTATION_MARK || code === APOSTROPHE || code === LEFTPARENTHESIS || code === RIGHTPARENTHESIS) {
          encoded += "\\" + str.charAt(i);
          wsBeforeHexIsNeeded = false;
        } else {
          if (wsBeforeHexIsNeeded && charCodeDefinitions.isHexDigit(code)) {
            encoded += " ";
          }
          encoded += str.charAt(i);
          wsBeforeHexIsNeeded = false;
        }
      }
      return "url(" + encoded + ")";
    }
    exports2.decode = decode2;
    exports2.encode = encode2;
  }
});

// node_modules/css-tree/cjs/syntax/node/Url.cjs
var require_Url = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Url.cjs"(exports2) {
    "use strict";
    var url = require_url();
    var string = require_string();
    var types = require_types();
    var name = "Url";
    var structure = {
      value: String
    };
    function parse() {
      const start = this.tokenStart;
      let value;
      switch (this.tokenType) {
        case types.Url:
          value = url.decode(this.consume(types.Url));
          break;
        case types.Function:
          if (!this.cmpStr(this.tokenStart, this.tokenEnd, "url(")) {
            this.error("Function name must be `url`");
          }
          this.eat(types.Function);
          this.skipSC();
          value = string.decode(this.consume(types.String));
          this.skipSC();
          if (!this.eof) {
            this.eat(types.RightParenthesis);
          }
          break;
        default:
          this.error("Url or Function is expected");
      }
      return {
        type: "Url",
        loc: this.getLocation(start, this.tokenStart),
        value
      };
    }
    function generate(node) {
      this.token(types.Url, url.encode(node.value));
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/Value.cjs
var require_Value = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/Value.cjs"(exports2) {
    "use strict";
    var name = "Value";
    var structure = {
      children: [[]]
    };
    function parse() {
      const start = this.tokenStart;
      const children = this.readSequence(this.scope.Value);
      return {
        type: "Value",
        loc: this.getLocation(start, this.tokenStart),
        children
      };
    }
    function generate(node) {
      this.children(node);
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/WhiteSpace.cjs
var require_WhiteSpace = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/WhiteSpace.cjs"(exports2) {
    "use strict";
    var types = require_types();
    var SPACE = Object.freeze({
      type: "WhiteSpace",
      loc: null,
      value: " "
    });
    var name = "WhiteSpace";
    var structure = {
      value: String
    };
    function parse() {
      this.eat(types.WhiteSpace);
      return SPACE;
    }
    function generate(node) {
      this.token(types.WhiteSpace, node.value);
    }
    exports2.generate = generate;
    exports2.name = name;
    exports2.parse = parse;
    exports2.structure = structure;
  }
});

// node_modules/css-tree/cjs/syntax/node/index.cjs
var require_node = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/index.cjs"(exports2) {
    "use strict";
    var AnPlusB = require_AnPlusB();
    var Atrule = require_Atrule();
    var AtrulePrelude = require_AtrulePrelude();
    var AttributeSelector = require_AttributeSelector();
    var Block = require_Block();
    var Brackets = require_Brackets();
    var CDC = require_CDC();
    var CDO = require_CDO();
    var ClassSelector = require_ClassSelector();
    var Combinator = require_Combinator();
    var Comment = require_Comment();
    var Condition = require_Condition();
    var Declaration = require_Declaration();
    var DeclarationList = require_DeclarationList();
    var Dimension = require_Dimension();
    var Feature = require_Feature();
    var FeatureFunction = require_FeatureFunction();
    var FeatureRange = require_FeatureRange();
    var Function = require_Function();
    var GeneralEnclosed = require_GeneralEnclosed();
    var Hash = require_Hash();
    var Identifier = require_Identifier();
    var IdSelector = require_IdSelector();
    var Layer = require_Layer();
    var LayerList = require_LayerList();
    var MediaQuery = require_MediaQuery();
    var MediaQueryList = require_MediaQueryList();
    var NestingSelector = require_NestingSelector();
    var Nth = require_Nth();
    var Number$1 = require_Number();
    var Operator = require_Operator();
    var Parentheses = require_Parentheses();
    var Percentage = require_Percentage();
    var PseudoClassSelector = require_PseudoClassSelector();
    var PseudoElementSelector = require_PseudoElementSelector();
    var Ratio = require_Ratio();
    var Raw = require_Raw();
    var Rule = require_Rule();
    var Scope = require_Scope();
    var Selector = require_Selector();
    var SelectorList = require_SelectorList();
    var String$1 = require_String();
    var StyleSheet = require_StyleSheet();
    var SupportsDeclaration = require_SupportsDeclaration();
    var TypeSelector = require_TypeSelector();
    var UnicodeRange = require_UnicodeRange();
    var Url = require_Url();
    var Value = require_Value();
    var WhiteSpace = require_WhiteSpace();
    exports2.AnPlusB = AnPlusB;
    exports2.Atrule = Atrule;
    exports2.AtrulePrelude = AtrulePrelude;
    exports2.AttributeSelector = AttributeSelector;
    exports2.Block = Block;
    exports2.Brackets = Brackets;
    exports2.CDC = CDC;
    exports2.CDO = CDO;
    exports2.ClassSelector = ClassSelector;
    exports2.Combinator = Combinator;
    exports2.Comment = Comment;
    exports2.Condition = Condition;
    exports2.Declaration = Declaration;
    exports2.DeclarationList = DeclarationList;
    exports2.Dimension = Dimension;
    exports2.Feature = Feature;
    exports2.FeatureFunction = FeatureFunction;
    exports2.FeatureRange = FeatureRange;
    exports2.Function = Function;
    exports2.GeneralEnclosed = GeneralEnclosed;
    exports2.Hash = Hash;
    exports2.Identifier = Identifier;
    exports2.IdSelector = IdSelector;
    exports2.Layer = Layer;
    exports2.LayerList = LayerList;
    exports2.MediaQuery = MediaQuery;
    exports2.MediaQueryList = MediaQueryList;
    exports2.NestingSelector = NestingSelector;
    exports2.Nth = Nth;
    exports2.Number = Number$1;
    exports2.Operator = Operator;
    exports2.Parentheses = Parentheses;
    exports2.Percentage = Percentage;
    exports2.PseudoClassSelector = PseudoClassSelector;
    exports2.PseudoElementSelector = PseudoElementSelector;
    exports2.Ratio = Ratio;
    exports2.Raw = Raw;
    exports2.Rule = Rule;
    exports2.Scope = Scope;
    exports2.Selector = Selector;
    exports2.SelectorList = SelectorList;
    exports2.String = String$1;
    exports2.StyleSheet = StyleSheet;
    exports2.SupportsDeclaration = SupportsDeclaration;
    exports2.TypeSelector = TypeSelector;
    exports2.UnicodeRange = UnicodeRange;
    exports2.Url = Url;
    exports2.Value = Value;
    exports2.WhiteSpace = WhiteSpace;
  }
});

// node_modules/css-tree/cjs/syntax/config/lexer.cjs
var require_lexer = __commonJS({
  "node_modules/css-tree/cjs/syntax/config/lexer.cjs"(exports2, module2) {
    "use strict";
    var genericConst = require_generic_const();
    var data = require_data();
    var index = require_node();
    var lexerConfig = {
      generic: true,
      cssWideKeywords: genericConst.cssWideKeywords,
      ...data,
      node: index
    };
    module2.exports = lexerConfig;
  }
});

// node_modules/css-tree/cjs/syntax/scope/default.cjs
var require_default = __commonJS({
  "node_modules/css-tree/cjs/syntax/scope/default.cjs"(exports2, module2) {
    "use strict";
    var types = require_types();
    var NUMBERSIGN = 35;
    var ASTERISK = 42;
    var PLUSSIGN = 43;
    var HYPHENMINUS = 45;
    var SOLIDUS = 47;
    var U = 117;
    function defaultRecognizer(context) {
      switch (this.tokenType) {
        case types.Hash:
          return this.Hash();
        case types.Comma:
          return this.Operator();
        case types.LeftParenthesis:
          return this.Parentheses(this.readSequence, context.recognizer);
        case types.LeftSquareBracket:
          return this.Brackets(this.readSequence, context.recognizer);
        case types.String:
          return this.String();
        case types.Dimension:
          return this.Dimension();
        case types.Percentage:
          return this.Percentage();
        case types.Number:
          return this.Number();
        case types.Function:
          return this.cmpStr(this.tokenStart, this.tokenEnd, "url(") ? this.Url() : this.Function(this.readSequence, context.recognizer);
        case types.Url:
          return this.Url();
        case types.Ident:
          if (this.cmpChar(this.tokenStart, U) && this.cmpChar(this.tokenStart + 1, PLUSSIGN)) {
            return this.UnicodeRange();
          } else {
            return this.Identifier();
          }
        case types.Delim: {
          const code = this.charCodeAt(this.tokenStart);
          if (code === SOLIDUS || code === ASTERISK || code === PLUSSIGN || code === HYPHENMINUS) {
            return this.Operator();
          }
          if (code === NUMBERSIGN) {
            this.error("Hex or identifier is expected", this.tokenStart + 1);
          }
          break;
        }
      }
    }
    module2.exports = defaultRecognizer;
  }
});

// node_modules/css-tree/cjs/syntax/scope/atrulePrelude.cjs
var require_atrulePrelude = __commonJS({
  "node_modules/css-tree/cjs/syntax/scope/atrulePrelude.cjs"(exports2, module2) {
    "use strict";
    var _default = require_default();
    var atrulePrelude = {
      getNode: _default
    };
    module2.exports = atrulePrelude;
  }
});

// node_modules/css-tree/cjs/syntax/scope/selector.cjs
var require_selector = __commonJS({
  "node_modules/css-tree/cjs/syntax/scope/selector.cjs"(exports2, module2) {
    "use strict";
    var types = require_types();
    var NUMBERSIGN = 35;
    var AMPERSAND = 38;
    var ASTERISK = 42;
    var PLUSSIGN = 43;
    var SOLIDUS = 47;
    var FULLSTOP = 46;
    var GREATERTHANSIGN = 62;
    var VERTICALLINE = 124;
    var TILDE = 126;
    function onWhiteSpace(next, children) {
      if (children.last !== null && children.last.type !== "Combinator" && next !== null && next.type !== "Combinator") {
        children.push({
          // FIXME: this.Combinator() should be used instead
          type: "Combinator",
          loc: null,
          name: " "
        });
      }
    }
    function getNode() {
      switch (this.tokenType) {
        case types.LeftSquareBracket:
          return this.AttributeSelector();
        case types.Hash:
          return this.IdSelector();
        case types.Colon:
          if (this.lookupType(1) === types.Colon) {
            return this.PseudoElementSelector();
          } else {
            return this.PseudoClassSelector();
          }
        case types.Ident:
          return this.TypeSelector();
        case types.Number:
        case types.Percentage:
          return this.Percentage();
        case types.Dimension:
          if (this.charCodeAt(this.tokenStart) === FULLSTOP) {
            this.error("Identifier is expected", this.tokenStart + 1);
          }
          break;
        case types.Delim: {
          const code = this.charCodeAt(this.tokenStart);
          switch (code) {
            case PLUSSIGN:
            case GREATERTHANSIGN:
            case TILDE:
            case SOLIDUS:
              return this.Combinator();
            case FULLSTOP:
              return this.ClassSelector();
            case ASTERISK:
            case VERTICALLINE:
              return this.TypeSelector();
            case NUMBERSIGN:
              return this.IdSelector();
            case AMPERSAND:
              return this.NestingSelector();
          }
          break;
        }
      }
    }
    var Selector = {
      onWhiteSpace,
      getNode
    };
    module2.exports = Selector;
  }
});

// node_modules/css-tree/cjs/syntax/function/expression.cjs
var require_expression = __commonJS({
  "node_modules/css-tree/cjs/syntax/function/expression.cjs"(exports2, module2) {
    "use strict";
    function expressionFn() {
      return this.createSingleNodeList(
        this.Raw(null, false)
      );
    }
    module2.exports = expressionFn;
  }
});

// node_modules/css-tree/cjs/syntax/function/var.cjs
var require_var = __commonJS({
  "node_modules/css-tree/cjs/syntax/function/var.cjs"(exports2, module2) {
    "use strict";
    var types = require_types();
    function varFn() {
      const children = this.createList();
      this.skipSC();
      children.push(this.Identifier());
      this.skipSC();
      if (this.tokenType === types.Comma) {
        children.push(this.Operator());
        const startIndex = this.tokenIndex;
        const value = this.parseCustomProperty ? this.Value(null) : this.Raw(this.consumeUntilExclamationMarkOrSemicolon, false);
        if (value.type === "Value" && value.children.isEmpty) {
          for (let offset = startIndex - this.tokenIndex; offset <= 0; offset++) {
            if (this.lookupType(offset) === types.WhiteSpace) {
              value.children.appendData({
                type: "WhiteSpace",
                loc: null,
                value: " "
              });
              break;
            }
          }
        }
        children.push(value);
      }
      return children;
    }
    module2.exports = varFn;
  }
});

// node_modules/css-tree/cjs/syntax/scope/value.cjs
var require_value = __commonJS({
  "node_modules/css-tree/cjs/syntax/scope/value.cjs"(exports2, module2) {
    "use strict";
    var _default = require_default();
    var expression = require_expression();
    var _var = require_var();
    function isPlusMinusOperator(node) {
      return node !== null && node.type === "Operator" && (node.value[node.value.length - 1] === "-" || node.value[node.value.length - 1] === "+");
    }
    var value = {
      getNode: _default,
      onWhiteSpace(next, children) {
        if (isPlusMinusOperator(next)) {
          next.value = " " + next.value;
        }
        if (isPlusMinusOperator(children.last)) {
          children.last.value += " ";
        }
      },
      "expression": expression,
      "var": _var
    };
    module2.exports = value;
  }
});

// node_modules/css-tree/cjs/syntax/scope/index.cjs
var require_scope = __commonJS({
  "node_modules/css-tree/cjs/syntax/scope/index.cjs"(exports2) {
    "use strict";
    var atrulePrelude = require_atrulePrelude();
    var selector = require_selector();
    var value = require_value();
    exports2.AtrulePrelude = atrulePrelude;
    exports2.Selector = selector;
    exports2.Value = value;
  }
});

// node_modules/css-tree/cjs/syntax/atrule/container.cjs
var require_container = __commonJS({
  "node_modules/css-tree/cjs/syntax/atrule/container.cjs"(exports2, module2) {
    "use strict";
    var types = require_types();
    var nonContainerNameKeywords = /* @__PURE__ */ new Set(["none", "and", "not", "or"]);
    var container = {
      parse: {
        prelude() {
          const children = this.createList();
          if (this.tokenType === types.Ident) {
            const name = this.substring(this.tokenStart, this.tokenEnd);
            if (!nonContainerNameKeywords.has(name.toLowerCase())) {
              children.push(this.Identifier());
            }
          }
          children.push(this.Condition("container"));
          return children;
        },
        block(nested = false) {
          return this.Block(nested);
        }
      }
    };
    module2.exports = container;
  }
});

// node_modules/css-tree/cjs/syntax/atrule/font-face.cjs
var require_font_face = __commonJS({
  "node_modules/css-tree/cjs/syntax/atrule/font-face.cjs"(exports2, module2) {
    "use strict";
    var fontFace = {
      parse: {
        prelude: null,
        block() {
          return this.Block(true);
        }
      }
    };
    module2.exports = fontFace;
  }
});

// node_modules/css-tree/cjs/syntax/atrule/import.cjs
var require_import = __commonJS({
  "node_modules/css-tree/cjs/syntax/atrule/import.cjs"(exports2, module2) {
    "use strict";
    var types = require_types();
    function parseWithFallback(parse, fallback) {
      return this.parseWithFallback(
        () => {
          try {
            return parse.call(this);
          } finally {
            this.skipSC();
            if (this.lookupNonWSType(0) !== types.RightParenthesis) {
              this.error();
            }
          }
        },
        fallback || (() => this.Raw(null, true))
      );
    }
    var parseFunctions = {
      layer() {
        this.skipSC();
        const children = this.createList();
        const node = parseWithFallback.call(this, this.Layer);
        if (node.type !== "Raw" || node.value !== "") {
          children.push(node);
        }
        return children;
      },
      supports() {
        this.skipSC();
        const children = this.createList();
        const node = parseWithFallback.call(
          this,
          this.Declaration,
          () => parseWithFallback.call(this, () => this.Condition("supports"))
        );
        if (node.type !== "Raw" || node.value !== "") {
          children.push(node);
        }
        return children;
      }
    };
    var importAtrule = {
      parse: {
        prelude() {
          const children = this.createList();
          switch (this.tokenType) {
            case types.String:
              children.push(this.String());
              break;
            case types.Url:
            case types.Function:
              children.push(this.Url());
              break;
            default:
              this.error("String or url() is expected");
          }
          this.skipSC();
          if (this.tokenType === types.Ident && this.cmpStr(this.tokenStart, this.tokenEnd, "layer")) {
            children.push(this.Identifier());
          } else if (this.tokenType === types.Function && this.cmpStr(this.tokenStart, this.tokenEnd, "layer(")) {
            children.push(this.Function(null, parseFunctions));
          }
          this.skipSC();
          if (this.tokenType === types.Function && this.cmpStr(this.tokenStart, this.tokenEnd, "supports(")) {
            children.push(this.Function(null, parseFunctions));
          }
          if (this.lookupNonWSType(0) === types.Ident || this.lookupNonWSType(0) === types.LeftParenthesis) {
            children.push(this.MediaQueryList());
          }
          return children;
        },
        block: null
      }
    };
    module2.exports = importAtrule;
  }
});

// node_modules/css-tree/cjs/syntax/atrule/layer.cjs
var require_layer = __commonJS({
  "node_modules/css-tree/cjs/syntax/atrule/layer.cjs"(exports2, module2) {
    "use strict";
    var layer = {
      parse: {
        prelude() {
          return this.createSingleNodeList(
            this.LayerList()
          );
        },
        block() {
          return this.Block(false);
        }
      }
    };
    module2.exports = layer;
  }
});

// node_modules/css-tree/cjs/syntax/atrule/media.cjs
var require_media = __commonJS({
  "node_modules/css-tree/cjs/syntax/atrule/media.cjs"(exports2, module2) {
    "use strict";
    var media = {
      parse: {
        prelude() {
          return this.createSingleNodeList(
            this.MediaQueryList()
          );
        },
        block(nested = false) {
          return this.Block(nested);
        }
      }
    };
    module2.exports = media;
  }
});

// node_modules/css-tree/cjs/syntax/atrule/nest.cjs
var require_nest = __commonJS({
  "node_modules/css-tree/cjs/syntax/atrule/nest.cjs"(exports2, module2) {
    "use strict";
    var nest = {
      parse: {
        prelude() {
          return this.createSingleNodeList(
            this.SelectorList()
          );
        },
        block() {
          return this.Block(true);
        }
      }
    };
    module2.exports = nest;
  }
});

// node_modules/css-tree/cjs/syntax/atrule/page.cjs
var require_page = __commonJS({
  "node_modules/css-tree/cjs/syntax/atrule/page.cjs"(exports2, module2) {
    "use strict";
    var page = {
      parse: {
        prelude() {
          return this.createSingleNodeList(
            this.SelectorList()
          );
        },
        block() {
          return this.Block(true);
        }
      }
    };
    module2.exports = page;
  }
});

// node_modules/css-tree/cjs/syntax/atrule/scope.cjs
var require_scope2 = __commonJS({
  "node_modules/css-tree/cjs/syntax/atrule/scope.cjs"(exports2, module2) {
    "use strict";
    var scope = {
      parse: {
        prelude() {
          return this.createSingleNodeList(
            this.Scope()
          );
        },
        block(nested = false) {
          return this.Block(nested);
        }
      }
    };
    module2.exports = scope;
  }
});

// node_modules/css-tree/cjs/syntax/atrule/starting-style.cjs
var require_starting_style = __commonJS({
  "node_modules/css-tree/cjs/syntax/atrule/starting-style.cjs"(exports2, module2) {
    "use strict";
    var startingStyle = {
      parse: {
        prelude: null,
        block(nested = false) {
          return this.Block(nested);
        }
      }
    };
    module2.exports = startingStyle;
  }
});

// node_modules/css-tree/cjs/syntax/atrule/supports.cjs
var require_supports = __commonJS({
  "node_modules/css-tree/cjs/syntax/atrule/supports.cjs"(exports2, module2) {
    "use strict";
    var supports = {
      parse: {
        prelude() {
          return this.createSingleNodeList(
            this.Condition("supports")
          );
        },
        block(nested = false) {
          return this.Block(nested);
        }
      }
    };
    module2.exports = supports;
  }
});

// node_modules/css-tree/cjs/syntax/atrule/index.cjs
var require_atrule = __commonJS({
  "node_modules/css-tree/cjs/syntax/atrule/index.cjs"(exports2, module2) {
    "use strict";
    var container = require_container();
    var fontFace = require_font_face();
    var _import = require_import();
    var layer = require_layer();
    var media = require_media();
    var nest = require_nest();
    var page = require_page();
    var scope = require_scope2();
    var startingStyle = require_starting_style();
    var supports = require_supports();
    var atrule = {
      container,
      "font-face": fontFace,
      import: _import,
      layer,
      media,
      nest,
      page,
      scope,
      "starting-style": startingStyle,
      supports
    };
    module2.exports = atrule;
  }
});

// node_modules/css-tree/cjs/syntax/pseudo/lang.cjs
var require_lang = __commonJS({
  "node_modules/css-tree/cjs/syntax/pseudo/lang.cjs"(exports2) {
    "use strict";
    var types = require_types();
    function parseLanguageRangeList() {
      const children = this.createList();
      this.skipSC();
      loop: while (!this.eof) {
        switch (this.tokenType) {
          case types.Ident:
            children.push(this.Identifier());
            break;
          case types.String:
            children.push(this.String());
            break;
          case types.Comma:
            children.push(this.Operator());
            break;
          case types.RightParenthesis:
            break loop;
          default:
            this.error("Identifier, string or comma is expected");
        }
        this.skipSC();
      }
      return children;
    }
    exports2.parseLanguageRangeList = parseLanguageRangeList;
  }
});

// node_modules/css-tree/cjs/syntax/pseudo/index.cjs
var require_pseudo = __commonJS({
  "node_modules/css-tree/cjs/syntax/pseudo/index.cjs"(exports2, module2) {
    "use strict";
    var lang = require_lang();
    var selectorList = {
      parse() {
        return this.createSingleNodeList(
          this.SelectorList()
        );
      }
    };
    var selector = {
      parse() {
        return this.createSingleNodeList(
          this.Selector()
        );
      }
    };
    var identList = {
      parse() {
        return this.createSingleNodeList(
          this.Identifier()
        );
      }
    };
    var langList = {
      parse: lang.parseLanguageRangeList
    };
    var nth = {
      parse() {
        return this.createSingleNodeList(
          this.Nth()
        );
      }
    };
    var pseudo = {
      "dir": identList,
      "has": selectorList,
      "lang": langList,
      "matches": selectorList,
      "is": selectorList,
      "-moz-any": selectorList,
      "-webkit-any": selectorList,
      "where": selectorList,
      "not": selectorList,
      "nth-child": nth,
      "nth-last-child": nth,
      "nth-last-of-type": nth,
      "nth-of-type": nth,
      "slotted": selector,
      "host": selector,
      "host-context": selector
    };
    module2.exports = pseudo;
  }
});

// node_modules/css-tree/cjs/syntax/node/index-parse.cjs
var require_index_parse = __commonJS({
  "node_modules/css-tree/cjs/syntax/node/index-parse.cjs"(exports2) {
    "use strict";
    var AnPlusB = require_AnPlusB();
    var Atrule = require_Atrule();
    var AtrulePrelude = require_AtrulePrelude();
    var AttributeSelector = require_AttributeSelector();
    var Block = require_Block();
    var Brackets = require_Brackets();
    var CDC = require_CDC();
    var CDO = require_CDO();
    var ClassSelector = require_ClassSelector();
    var Combinator = require_Combinator();
    var Comment = require_Comment();
    var Condition = require_Condition();
    var Declaration = require_Declaration();
    var DeclarationList = require_DeclarationList();
    var Dimension = require_Dimension();
    var Feature = require_Feature();
    var FeatureFunction = require_FeatureFunction();
    var FeatureRange = require_FeatureRange();
    var Function = require_Function();
    var GeneralEnclosed = require_GeneralEnclosed();
    var Hash = require_Hash();
    var Identifier = require_Identifier();
    var IdSelector = require_IdSelector();
    var Layer = require_Layer();
    var LayerList = require_LayerList();
    var MediaQuery = require_MediaQuery();
    var MediaQueryList = require_MediaQueryList();
    var NestingSelector = require_NestingSelector();
    var Nth = require_Nth();
    var Number2 = require_Number();
    var Operator = require_Operator();
    var Parentheses = require_Parentheses();
    var Percentage = require_Percentage();
    var PseudoClassSelector = require_PseudoClassSelector();
    var PseudoElementSelector = require_PseudoElementSelector();
    var Ratio = require_Ratio();
    var Raw = require_Raw();
    var Rule = require_Rule();
    var Scope = require_Scope();
    var Selector = require_Selector();
    var SelectorList = require_SelectorList();
    var String2 = require_String();
    var StyleSheet = require_StyleSheet();
    var SupportsDeclaration = require_SupportsDeclaration();
    var TypeSelector = require_TypeSelector();
    var UnicodeRange = require_UnicodeRange();
    var Url = require_Url();
    var Value = require_Value();
    var WhiteSpace = require_WhiteSpace();
    exports2.AnPlusB = AnPlusB.parse;
    exports2.Atrule = Atrule.parse;
    exports2.AtrulePrelude = AtrulePrelude.parse;
    exports2.AttributeSelector = AttributeSelector.parse;
    exports2.Block = Block.parse;
    exports2.Brackets = Brackets.parse;
    exports2.CDC = CDC.parse;
    exports2.CDO = CDO.parse;
    exports2.ClassSelector = ClassSelector.parse;
    exports2.Combinator = Combinator.parse;
    exports2.Comment = Comment.parse;
    exports2.Condition = Condition.parse;
    exports2.Declaration = Declaration.parse;
    exports2.DeclarationList = DeclarationList.parse;
    exports2.Dimension = Dimension.parse;
    exports2.Feature = Feature.parse;
    exports2.FeatureFunction = FeatureFunction.parse;
    exports2.FeatureRange = FeatureRange.parse;
    exports2.Function = Function.parse;
    exports2.GeneralEnclosed = GeneralEnclosed.parse;
    exports2.Hash = Hash.parse;
    exports2.Identifier = Identifier.parse;
    exports2.IdSelector = IdSelector.parse;
    exports2.Layer = Layer.parse;
    exports2.LayerList = LayerList.parse;
    exports2.MediaQuery = MediaQuery.parse;
    exports2.MediaQueryList = MediaQueryList.parse;
    exports2.NestingSelector = NestingSelector.parse;
    exports2.Nth = Nth.parse;
    exports2.Number = Number2.parse;
    exports2.Operator = Operator.parse;
    exports2.Parentheses = Parentheses.parse;
    exports2.Percentage = Percentage.parse;
    exports2.PseudoClassSelector = PseudoClassSelector.parse;
    exports2.PseudoElementSelector = PseudoElementSelector.parse;
    exports2.Ratio = Ratio.parse;
    exports2.Raw = Raw.parse;
    exports2.Rule = Rule.parse;
    exports2.Scope = Scope.parse;
    exports2.Selector = Selector.parse;
    exports2.SelectorList = SelectorList.parse;
    exports2.String = String2.parse;
    exports2.StyleSheet = StyleSheet.parse;
    exports2.SupportsDeclaration = SupportsDeclaration.parse;
    exports2.TypeSelector = TypeSelector.parse;
    exports2.UnicodeRange = UnicodeRange.parse;
    exports2.Url = Url.parse;
    exports2.Value = Value.parse;
    exports2.WhiteSpace = WhiteSpace.parse;
  }
});

// node_modules/css-tree/cjs/syntax/config/parser.cjs
var require_parser = __commonJS({
  "node_modules/css-tree/cjs/syntax/config/parser.cjs"(exports2, module2) {
    "use strict";
    var index = require_scope();
    var index$1 = require_atrule();
    var index$2 = require_pseudo();
    var indexParse = require_index_parse();
    var config = {
      parseContext: {
        default: "StyleSheet",
        stylesheet: "StyleSheet",
        atrule: "Atrule",
        atrulePrelude(options) {
          return this.AtrulePrelude(options.atrule ? String(options.atrule) : null);
        },
        mediaQueryList: "MediaQueryList",
        mediaQuery: "MediaQuery",
        condition(options) {
          return this.Condition(options.kind);
        },
        rule: "Rule",
        selectorList: "SelectorList",
        selector: "Selector",
        block() {
          return this.Block(true);
        },
        declarationList: "DeclarationList",
        declaration: "Declaration",
        value: "Value"
      },
      features: {
        supports: {
          selector() {
            return this.Selector();
          }
        },
        container: {
          style() {
            return this.Declaration();
          }
        }
      },
      scope: index,
      atrule: index$1,
      pseudo: index$2,
      node: indexParse
    };
    module2.exports = config;
  }
});

// node_modules/css-tree/cjs/syntax/config/walker.cjs
var require_walker = __commonJS({
  "node_modules/css-tree/cjs/syntax/config/walker.cjs"(exports2, module2) {
    "use strict";
    var index = require_node();
    var config = {
      node: index
    };
    module2.exports = config;
  }
});

// node_modules/css-tree/cjs/syntax/index.cjs
var require_syntax = __commonJS({
  "node_modules/css-tree/cjs/syntax/index.cjs"(exports2, module2) {
    "use strict";
    var create = require_create5();
    var lexer = require_lexer();
    var parser = require_parser();
    var walker = require_walker();
    var syntax = create({
      ...lexer,
      ...parser,
      ...walker
    });
    module2.exports = syntax;
  }
});

// node_modules/css-tree/package.json
var require_package = __commonJS({
  "node_modules/css-tree/package.json"(exports2, module2) {
    module2.exports = {
      name: "css-tree",
      version: "3.2.1",
      description: "A tool set for CSS: fast detailed parser (CSS \u2192 AST), walker (AST traversal), generator (AST \u2192 CSS) and lexer (validation and matching) based on specs and browser implementations",
      author: "Roman Dvornov <rdvornov@gmail.com> (https://github.com/lahmatiy)",
      license: "MIT",
      repository: "csstree/csstree",
      keywords: [
        "css",
        "ast",
        "tokenizer",
        "parser",
        "walker",
        "lexer",
        "generator",
        "utils",
        "syntax",
        "validation"
      ],
      type: "module",
      module: "./lib/index.js",
      sideEffects: false,
      main: "./cjs/index.cjs",
      exports: {
        ".": {
          import: "./lib/index.js",
          require: "./cjs/index.cjs"
        },
        "./dist/*": "./dist/*.js",
        "./package.json": "./package.json",
        "./tokenizer": {
          import: "./lib/tokenizer/index.js",
          require: "./cjs/tokenizer/index.cjs"
        },
        "./parser": {
          import: "./lib/parser/index.js",
          require: "./cjs/parser/index.cjs"
        },
        "./selector-parser": {
          import: "./lib/parser/parse-selector.js",
          require: "./cjs/parser/parse-selector.cjs"
        },
        "./generator": {
          import: "./lib/generator/index.js",
          require: "./cjs/generator/index.cjs"
        },
        "./walker": {
          import: "./lib/walker/index.js",
          require: "./cjs/walker/index.cjs"
        },
        "./convertor": {
          import: "./lib/convertor/index.js",
          require: "./cjs/convertor/index.cjs"
        },
        "./lexer": {
          import: "./lib/lexer/index.js",
          require: "./cjs/lexer/index.cjs"
        },
        "./definition-syntax": {
          import: "./lib/definition-syntax/index.js",
          require: "./cjs/definition-syntax/index.cjs"
        },
        "./definition-syntax-data": {
          import: "./lib/data.js",
          require: "./cjs/data.cjs"
        },
        "./definition-syntax-data-patch": {
          import: "./lib/data-patch.js",
          require: "./cjs/data-patch.cjs"
        },
        "./utils": {
          import: "./lib/utils/index.js",
          require: "./cjs/utils/index.cjs"
        }
      },
      browser: {
        "./cjs/data.cjs": "./dist/data.cjs",
        "./cjs/version.cjs": "./dist/version.cjs",
        "./lib/data.js": "./dist/data.js",
        "./lib/version.js": "./dist/version.js"
      },
      unpkg: "dist/csstree.esm.js",
      jsdelivr: "dist/csstree.esm.js",
      scripts: {
        watch: "npm run build -- --watch",
        build: "npm run bundle && npm run esm-to-cjs --",
        "build-and-test": "npm run build && npm run test:dist && npm run test:cjs",
        bundle: "node scripts/bundle",
        "bundle-and-test": "npm run bundle && npm run test:dist",
        "esm-to-cjs": "node scripts/esm-to-cjs.cjs",
        "esm-to-cjs-and-test": "npm run esm-to-cjs && npm run test:cjs",
        lint: "eslint lib scripts && node scripts/review-syntax-patch --lint && node scripts/update-docs --lint",
        "lint-and-test": "npm run lint && npm test",
        "update:docs": "node scripts/update-docs",
        "review:syntax-patch": "node scripts/review-syntax-patch",
        test: "mocha lib/__tests --require lib/__tests/helpers/setup.js --reporter progress",
        "test:cjs": "mocha cjs/__tests --require lib/__tests/helpers/setup.js --reporter progress",
        "test:dist": "mocha dist/__tests --reporter progress",
        coverage: "c8 --exclude lib/__tests --reporter=lcovonly npm test",
        prepublishOnly: "npm run lint-and-test && npm run build-and-test"
      },
      dependencies: {
        "mdn-data": "2.27.1",
        "source-map-js": "^1.2.1"
      },
      devDependencies: {
        c8: "^11.0.0",
        clap: "^2.0.1",
        esbuild: "^0.27.3",
        eslint: "^8.50.0",
        "json-to-ast": "^2.1.0",
        mocha: "^9.2.2",
        rollup: "^2.80.0"
      },
      engines: {
        node: "^10 || ^12.20.0 || ^14.13.0 || >=15.0.0"
      },
      files: [
        "data",
        "dist",
        "cjs",
        "!cjs/__tests",
        "lib",
        "!lib/__tests"
      ]
    };
  }
});

// node_modules/css-tree/cjs/version.cjs
var require_version = __commonJS({
  "node_modules/css-tree/cjs/version.cjs"(exports2) {
    "use strict";
    var { version } = require_package();
    exports2.version = version;
  }
});

// node_modules/css-tree/cjs/definition-syntax/index.cjs
var require_definition_syntax = __commonJS({
  "node_modules/css-tree/cjs/definition-syntax/index.cjs"(exports2) {
    "use strict";
    var SyntaxError2 = require_SyntaxError2();
    var generate = require_generate();
    var parse = require_parse();
    var walk = require_walk();
    exports2.SyntaxError = SyntaxError2.SyntaxError;
    exports2.generate = generate.generate;
    exports2.parse = parse.parse;
    exports2.walk = walk.walk;
  }
});

// node_modules/css-tree/cjs/utils/clone.cjs
var require_clone = __commonJS({
  "node_modules/css-tree/cjs/utils/clone.cjs"(exports2) {
    "use strict";
    var List = require_List();
    function clone(node) {
      const result = {};
      for (const key of Object.keys(node)) {
        let value = node[key];
        if (value) {
          if (Array.isArray(value) || value instanceof List.List) {
            value = value.map(clone);
          } else if (value.constructor === Object) {
            value = clone(value);
          }
        }
        result[key] = value;
      }
      return result;
    }
    exports2.clone = clone;
  }
});

// node_modules/css-tree/cjs/utils/ident.cjs
var require_ident = __commonJS({
  "node_modules/css-tree/cjs/utils/ident.cjs"(exports2) {
    "use strict";
    var charCodeDefinitions = require_char_code_definitions();
    var utils = require_utils();
    var REVERSE_SOLIDUS = 92;
    function decode2(str) {
      const end = str.length - 1;
      let decoded = "";
      for (let i = 0; i < str.length; i++) {
        let code = str.charCodeAt(i);
        if (code === REVERSE_SOLIDUS) {
          if (i === end) {
            break;
          }
          code = str.charCodeAt(++i);
          if (charCodeDefinitions.isValidEscape(REVERSE_SOLIDUS, code)) {
            const escapeStart = i - 1;
            const escapeEnd = utils.consumeEscaped(str, escapeStart);
            i = escapeEnd - 1;
            decoded += utils.decodeEscaped(str.substring(escapeStart + 1, escapeEnd));
          } else {
            if (code === 13 && str.charCodeAt(i + 1) === 10) {
              i++;
            }
          }
        } else {
          decoded += str[i];
        }
      }
      return decoded;
    }
    function encode2(str) {
      let encoded = "";
      if (str.length === 1 && str.charCodeAt(0) === 45) {
        return "\\-";
      }
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code === 0) {
          encoded += "\uFFFD";
          continue;
        }
        if (
          // If the character is in the range [\1-\1f] (U+0001 to U+001F) or is U+007F ...
          // Note: Do not compare with 0x0001 since 0x0000 is precessed before
          code <= 31 || code === 127 || // [or] ... is in the range [0-9] (U+0030 to U+0039),
          code >= 48 && code <= 57 && // If the character is the first character ...
          (i === 0 || // If the character is the second character ... and the first character is a "-" (U+002D)
          i === 1 && str.charCodeAt(0) === 45)
        ) {
          encoded += "\\" + code.toString(16) + " ";
          continue;
        }
        if (charCodeDefinitions.isName(code)) {
          encoded += str.charAt(i);
        } else {
          encoded += "\\" + str.charAt(i);
        }
      }
      return encoded;
    }
    exports2.decode = decode2;
    exports2.encode = encode2;
  }
});

// node_modules/css-tree/cjs/index.cjs
var require_cjs = __commonJS({
  "node_modules/css-tree/cjs/index.cjs"(exports2) {
    "use strict";
    var index$1 = require_syntax();
    var version = require_version();
    var create = require_create5();
    var List = require_List();
    var Lexer = require_Lexer();
    var index = require_definition_syntax();
    var clone = require_clone();
    var names$1 = require_names2();
    var ident = require_ident();
    var string = require_string();
    var url = require_url();
    var types = require_types();
    var names = require_names();
    var TokenStream = require_TokenStream();
    var OffsetToLocation = require_OffsetToLocation();
    var {
      tokenize,
      parse,
      generate,
      lexer,
      createLexer,
      walk,
      find,
      findLast,
      findAll,
      toPlainObject,
      fromPlainObject,
      fork
    } = index$1;
    exports2.version = version.version;
    exports2.createSyntax = create;
    exports2.List = List.List;
    exports2.Lexer = Lexer.Lexer;
    exports2.definitionSyntax = index;
    exports2.clone = clone.clone;
    exports2.isCustomProperty = names$1.isCustomProperty;
    exports2.keyword = names$1.keyword;
    exports2.property = names$1.property;
    exports2.vendorPrefix = names$1.vendorPrefix;
    exports2.ident = ident;
    exports2.string = string;
    exports2.url = url;
    exports2.tokenTypes = types;
    exports2.tokenNames = names;
    exports2.TokenStream = TokenStream.TokenStream;
    exports2.OffsetToLocation = OffsetToLocation.OffsetToLocation;
    exports2.createLexer = createLexer;
    exports2.find = find;
    exports2.findAll = findAll;
    exports2.findLast = findLast;
    exports2.fork = fork;
    exports2.fromPlainObject = fromPlainObject;
    exports2.generate = generate;
    exports2.lexer = lexer;
    exports2.parse = parse;
    exports2.toPlainObject = toPlainObject;
    exports2.tokenize = tokenize;
    exports2.walk = walk;
  }
});

// node_modules/entities/dist/decode-codepoint.js
function isInvalidCodePoint(codePoint) {
  return codePoint === 0 || codePoint >= 55296 && codePoint <= 57343 || codePoint > 1114111;
}
function replaceCodePoint(codePoint) {
  if (isInvalidCodePoint(codePoint)) {
    return 65533;
  }
  if (codePoint >= 128 && codePoint <= 159) {
    return c1[codePoint - 128] || codePoint;
  }
  return codePoint;
}
function replaceCodePointXML(codePoint) {
  return isInvalidCodePoint(codePoint) ? 65533 : codePoint;
}
function codePointToString(codePoint) {
  return codePoint - 1 >>> 0 < 127 || codePoint - 160 >>> 0 < 55136 ? String.fromCharCode(codePoint) : String.fromCodePoint(replaceCodePoint(codePoint));
}
var c1;
var init_decode_codepoint = __esm({
  "node_modules/entities/dist/decode-codepoint.js"() {
    c1 = [
      8364,
      0,
      8218,
      402,
      8222,
      8230,
      8224,
      8225,
      710,
      8240,
      352,
      8249,
      338,
      0,
      381,
      0,
      0,
      8216,
      8217,
      8220,
      8221,
      8226,
      8211,
      8212,
      732,
      8482,
      353,
      8250,
      339,
      0,
      382,
      376
    ];
  }
});

// node_modules/entities/dist/internal/decode-shared.js
function decodeTrieDict(input, resultLength, atomCount, dict1AtomCount, ngramCount, dictSize) {
  const base = 91;
  const inputLength = input.length;
  const twoCharBias = dictSize * (base - 1);
  let pos = 0;
  const readSlotCode = () => {
    const c12 = BASE91_INVERSE[input.charCodeAt(pos++)];
    return c12 < dictSize ? c12 : c12 * base - twoCharBias + BASE91_INVERSE[input.charCodeAt(pos++)];
  };
  const dict2AtomCount = atomCount - dict1AtomCount;
  const slotCount = atomCount + ngramCount;
  const single = new Int32Array(slotCount);
  single.fill(-1, dict1AtomCount, dictSize);
  single.fill(-1, dictSize + dict2AtomCount, slotCount);
  const start = new Int32Array(slotCount);
  const length = new Int32Array(slotCount);
  function decodeDelta(count, off) {
    let previous = 0;
    let slot = off;
    const end = off + count;
    while (slot < end) {
      const code = BASE91_INVERSE[input.charCodeAt(pos++)];
      if (code < 89) {
        previous += code;
        single[slot++] = previous;
      } else if (code === 89) {
        let runLength = BASE91_INVERSE[input.charCodeAt(pos++)] + 2;
        while (runLength--)
          single[slot++] = ++previous;
      } else {
        const next = BASE91_INVERSE[input.charCodeAt(pos++)];
        previous += 89 + // eslint-disable-next-line unicorn/prefer-minimal-ternary -- branches read a different number of side-effecting input bytes
        (next < 90 ? next * base + BASE91_INVERSE[input.charCodeAt(pos++)] : BASE91_INVERSE[input.charCodeAt(pos++)] * 8281 + BASE91_INVERSE[input.charCodeAt(pos++)] * base + BASE91_INVERSE[input.charCodeAt(pos++)]);
        single[slot++] = previous;
      }
    }
  }
  decodeDelta(dict1AtomCount, 0);
  decodeDelta(dict2AtomCount, dictSize);
  const references = new Int32Array(ngramCount * 2);
  let poolSize = 0;
  let ngramIndex = 0;
  function readNgramReferences(count, startSlot) {
    for (let index = 0; index < count; index++) {
      const slot = startSlot + index;
      const a = readSlotCode();
      const b = readSlotCode();
      references[ngramIndex * 2] = a;
      references[ngramIndex * 2 + 1] = b;
      ngramIndex += 1;
      start[slot] = poolSize;
      const entryLength = (single[a] < 0 ? length[a] : 1) + (single[b] < 0 ? length[b] : 1);
      length[slot] = entryLength;
      poolSize += entryLength;
    }
  }
  readNgramReferences(ngramCount - dictSize + dict1AtomCount, dictSize + dict2AtomCount);
  readNgramReferences(dictSize - dict1AtomCount, dict1AtomCount);
  const pool = new Uint16Array(poolSize);
  let write = 0;
  for (let index = 0; index < ngramIndex; index++) {
    for (let half = 0; half < 2; half++) {
      const source = references[index * 2 + half];
      const value = single[source];
      if (value < 0) {
        let read = start[source];
        const readEnd = read + length[source];
        while (read < readEnd)
          pool[write++] = pool[read++];
      } else {
        pool[write++] = value;
      }
    }
  }
  const out = new Uint16Array(resultLength);
  let outIndex = 0;
  while (pos < inputLength) {
    let slot = BASE91_INVERSE[input.charCodeAt(pos++)];
    if (slot >= dictSize) {
      slot = slot * base - twoCharBias + BASE91_INVERSE[input.charCodeAt(pos++)];
    }
    const value = single[slot];
    if (value < 0) {
      let read = start[slot];
      const readEnd = read + length[slot];
      while (read < readEnd)
        out[outIndex++] = pool[read++];
    } else {
      out[outIndex++] = value;
    }
  }
  return out;
}
var BASE91_INVERSE;
var init_decode_shared = __esm({
  "node_modules/entities/dist/internal/decode-shared.js"() {
    BASE91_INVERSE = /* @__PURE__ */ (() => {
      const table = new Uint8Array(127);
      let code = 0;
      for (let char = 33; char <= 126; char++) {
        if (char !== 34 && char !== 36 && char !== 92) {
          table[char] = code++;
        }
      }
      return table;
    })();
  }
});

// node_modules/entities/dist/generated/decode-data-html.js
var htmlDecodeTree;
var init_decode_data_html = __esm({
  "node_modules/entities/dist/generated/decode-data-html.js"() {
    init_decode_shared();
    htmlDecodeTree = /* @__PURE__ */ decodeTrieDict("!}.&u%}'&}*'~!6*)%&,~!J~!J~%L~y<~!R,~~%Lu~~#GD~~#|)1#%}^%}2%+#.##%##%}&%##%'#%##&%#%#'%#&#%#&#'#%%#&#%##%#)%''%&%#%#'%#%%#%%}%%%#%#&(23#%%#&-%0%('1#(##%#'##+%'*.:1}#%#6-+(%'%%#%%%}#L'2351&('%}&/N'(0(/*-%(%%}#'+&T%7.2}#&%&#%#36/5##%&%%#&#%%#))2%%##%&&'0~!#*+&'%1~!%).'3q?&%'1~!.##%6(~!+%%%(Gw'rT~!E#<nA%#jZ~!H%(~!42##~!*31&~!G%U~#)5~#`3~!J~!Z~%]~%Y~%C~!q~!u~#kz~%#~!6'~!D~!U~!?~#T~!c%~!G#'~%7|~!G~!J~!G&~#pb~(Df}#%}*&}#%##%##%##&#-}&'#'&%#.++}%mI,#,@&(}*%}*'%&##&#%##%}&0}#.},U},%}+%}&%}#%##&}B%(}(%}+%)})%##%#&}&%##%&}<%}>%#%&}*%}(%}9%}/%})%}*%}*%}?&}&%}3%}&*#%})%#%#)}#&#-#+*%E%%'%'#%}#*V##&##I}#&&##%&%#&&Qf%%))w/0+&%#(#.%-''''++++7}>%4'',##1,#%#&%##&#'##&#*#9)%&%}#*}%,#+P(%A&%#'&##wSD',9E00#y#@}(+}&%&>~!#~!X}#*}(&&}(&}(,%}%&#+&}#&}I%#%}%)#(},'%#*}4%%#%}(''}#/##(##),%-##%%)#&}(.}&%#&}%%}*&#%},&&}&%}#%*'#%})%}D&}&%}-&}6&#&}-,%}#%})-(~+`~,=?~I9'9%~!,#%})%})%}@%}?%}(~!?~#<~#pP~#BG~#=1#%K+~#?#~%;)~#A~#mF1~#A'~'X%'~#lR~#N~'N~#r~#m#-~#i'?%#'%~#B%##%,%#~#_%#0%~#]732~,w~2+#:&#%&'0%&>%}#>##F+)#%&&#(+_}4&}-%}(&}@&}O7Fdf0@+/v4}&WU##&/0#&'('B#%}.%}'+#%}#%%&#&%#%##+#&#)#6#'#.},%}c%},%#%##%&#&%#&~#>'*-.%##%##%}#%%}%'~#)D1}#%*&~#_%%'(~#S2%'.}#~#=##*'*-%}&'%'##&&~'E%.#&~#M4}%%##&'%#~#O1##%&#'+~#<B%##%%'%+~#;#@%}#&%#&&%#(~#H1}'%'##&&~#?A}&'~#D#%32}'&&&&~#[}'(#%}'~#;C})&}%%#%~#=&%,3}%'(#%%~#^'#&&)#%'~#Y%-~#d-%'~#^%%&#&&&}#~#b~2t*&'~&(~&@~0%~e~3}%*''0})&}+~!9##-}#%-hD*)1fC#%/&/fB#40~!+#)*4~!+~!K'&:~!/*7~!.#~!H~!L':~%x&~!H#~!*~%1~!I#~!+A~#p'~!F~~#-#~,,(~.Z~!V~%;'B'mq-W~!N~%I%#&&#&}#%},%%}'%}+X#%}#&}(%}'%}<%}#%}%%'}'%}:~![)9@~%>~#UA%-%##&~!C%~!-.9:~!1~!-^2/:a~!y,D*J#-5)/4~%23,~#G~!L1~!0X3`~!2+~!!0-~&E~!W~!o,>Y&]~%cZx_&~#O*9#A#'#+I'%#)~!0B*-5A+-((F&*M#)(-7-5+'-3a5Vi~!Y~!?+[)%3),ERHm~!+:D,VG.+)?fB%%*(%)'(#&80%1'8`K8?`+'Z#&O&'H5#*9)A%%5&3))0%39+.*7#()&&*=4@**L)<'_&*+..;(#*+)./&0#3)%')-8(4ixD(&.}%,('aI:,)%,k2231T)I'#/-W7,/'Q#.'Y24+h')37</31&83##&0#),H(?'&?/1##%#&&#%''-%&&&#(&''&#.-'%#%%(,')*'&#&#'##%(%(#%('#&##%%%%('%#%#%%#%#&%##h>w+v<ayvyvcg.uuhKr}g/v|g>u9i[~>g5uI~=RvdwEg;v/g;uk!!TTSx]@RT!U!#!@VBRUU!'UTe-d0c`e&gSdicedFcrdTaqb.kYcAohdYd@a3e+d}dMdtd.aJ#bqcK`dle/e.e'dwdPdodddjbEb}ogd^ofdpduc6j?l%d{drdqc)d7bacOdQ%T#Y)X.sR[yH>6Vyv3[xwLu>vo'!*.[yBacahoj>6Rew3[xqdZa#!a&#^(X-[yG>6Vyu3[xvg3sEr|g.u/Ri9db0T#^(Xa)!-[y;>6Vylg4wKs{JwNZt3@3r=c4Z([xlg;wKt!cpq's@v7A'*a(a+!-a#[y<3Dt?3Dt'>6Vym3[xmg9rxsNJwLZt4~?r?db1T#`-!(Xa,!0[yS>6Vz%NuQs.g4wKtnJwNZtS@3r>c4Z([y%g;wKtrdga8!a(!#&T*Y-Xa#!a0<or[yc3Dtq>6Vz43[y3JwNZtf@3s!Ju}!%Dti:pm3c_%X#tjB5pkd6q!r]u?voC'*-a.a2!0a&a+[yI3DtI3Ds~3DtH>6Vyw3[xx;:s#~<5pKJwNZtE@3r~d`a)!a2T#a.(!+U.X1[yT3Dt`3Dtv>6Vz&3[y&g9rxwzcxstPu.<rAJwLZtT~?r@dZa%!a.&^*Za(/Reu[ya>6Vz23[y1g3sEr}wkg{NuQRg{ci(U#5@b`~,cg#U(2WnH5wugcRh7dX#T(Y,a'Ta!!a,[yZ<]mj>6Vz,3[y+Pv#5ReZKu+=,%!H}7ABwkaS?Rh:BcW(X#<]mrj:ubv/ARekdg%!(!a.*Ta(Y.X1!#sP>Rl*Dt6[y>>6Vyo3Wf*jOvuumvuRgRJuq*!:9<B@bX~3jVv&v@s@5Re[d/rQt{uAvo&a&a*)a2!,0Wf!3Dt0=Bs'>6Re}3[xy~<5s%JwJZt1~Gs)c;&!#2sJkNuXvzq7rxu,Re8dka4!a8(aEZ+a@Y.X1Xa)[yd=Bs(3DtP>6Vz53[y4cX#X&Re:avRe9~<5s&JwJZtQ~Gs*i^rzvdRg+Jv{%!2sbB@bX}kdga,!Za?&^*T1/!a'Dt+[y6>6Vyf3Wf%g/u;s4hGu6?Rh-JvZ,!c%#&RoX54Rivj7uyvf8RgTKvZB%*!2sGh<vu5Rgq<=C::9bb~#dZ#T&Ta6Y.X*Dt>[y93Wf)coZ(T,6VyifluvRgC@95@B@bX~/hFu34cC#T,k/unq8w8Q5RkUklwQuzunq8w8Q5Rk8d/rJu?v8w9)-&!a0a;a&aIWejg3sEr/h1s<DtDJvyZqY5aws3Jvy!&Wei~Hr1:au5@Bag>23E~5c:Z&bX};kKv?w&unuVu5Rjc;>bs)#~@:Rh.=ay<a]C;b`}Vd6s/t{uAvoaxa()!a,a7%-a#a2Dt,[yF2Wo[>6Vyt3[xuNuPRi&NuPwpi#RoWh?vf8Ri%Jv]!%Ri:KvxD!.'2WeAjZu`q9rxu,Re7woeAg-unLq(qA_/*2Wg_g3u5q^9:4E}/jTrxrzv=Wkkd~0UX#^^Xa-a1a5T&a=U1a'*aEa]!a*aPaA-adok[y54Rn>;:p3~Dp5g9rpsFNvZqjg3uJp4~<5p0Pw;5qlJwNZt*@3p1Pw:5p/Ou!5p2JvG'!6Vye=<qnJvh_[xhg3v,Rh3kOwOw-sDuev/Re^dha[a%!%!a+#Ta7)-5TaCaO!aka!a)sf[yb2>Rl!9ARiq5E}Qg=ucRkBE|oJrJ_@Wk~@Wk{JrJ_@Wk|@WkyJrJ_@Wk}@WkzJvO_[y2g-vMRmiKuYC!)&>Ri;>Ri<@3RkNc](X#@9Rk=g5vuRmhKvDB!+'=]meg3u4Rmgd)#Y'Vz3CARmfd`a+!%T'!+#Ta1Ta6TaM-sTDt9[yA9sYd'%Y#s[[xpj:ueunaXRgEjRq,v-vuqdd2'`#6Rev<32@5>:2<E}5xIo9a*X#Y(;5RePJvD_g>vyRgNj8w)v8<wggs:RgXiZt|vjx,hSq3ah!-(~@:Ro/Ou!5RhWj^v(pyw8unRhUdx-UY#^Ua.a3a70!)%UX1TaDa)'omRiRRhE[y:3Dsz=Br,>6Vyj3[xkg6ruwjcqsrPw;5r*Ku]D'Zt-@3r(~?r.i[vwv]dU1a--U#`a4(g/vsRhPOu!5RhLj:rmu9Wo!~@:wdh@g/vsRiTjXuvvNr}:RhBj^v(pyw8unRn]dz1UYa'a+^Y(!aETZalaRY.Ta?a4[yDJw1!#qLsW>6Vyrfzq-pLflpwRe|Js>%!Dt@3Dt&Jvy_[xs~HrnjMuwpsw'RecKu+D#'!t<~Grl~?rjg5u-x,gwp{ah!-(~@:Rg~Ou!5Rh'jXuvvNr}:Rh#cW#X/c;&!#2sLi[v7u7RgpJv)(!iLrxu,Re6j7v@s@5Se[e7d`aW!Za(a`T.a#!a3!&aDa-!9)Dt_=6s+3[x~~DR|h~DS6avhGun5RkZj3w)v-]mkKunB!&*]kb97R|i<ARk<c:Z(6Vy}Juh'!wziMRoS:F|vkLuauJv5vtvQRh1d='T+Y#VyO~DR|jcF#T'7R|g97R|kJv3'!ay<Rj,Jvh&!:ReXcsa6*a+#a#_aIRf9aLRf?c,Z&Rf5Rf7c.Z&Rf;Rf>cQ#%T'p-Rf8Rf=ct#%'(*!,p,Rf4p+Rf6Rf:Rf<d~'Ua%U*^UYa(!a,-!#a4YaTalaEX0a8a<Weo3Dt/3Dsx=Br93Wen~Dr;~<5p<JwNZt2@3p=Pw:5p;Ou!5r3c7&!#:p>3Ds}KvGB)_6Vyk2sM=<r7x'eovA(!hFu1ARf}cV#X&@r5j6rvwQa^Rf3c=Za'wkghJv__g;unRggA53B9=b^}%j6uduo5Jq;!(hIv%2Re`Ou4ARe_e%a#^^^Xa&!a*a2!&a6YaP!*ad!#a:aE/5Rn?[y@>6Vyp;:pE~DrY~<5pBJwNZt8@3pCh=rt3rWPw:5pAJup_[xoNuPpF9c!#'45pD5ARn)d8#X'X*3@rU72s]h>v<<sSjJpqvewOJq/(!hNw'5ReBk0s2u3w/w'5ReE5@Jq.!a+JQ!&WeU23d(#Y&RjG5]jBk!u7w&u0udARjEe#+^^^Ub#!a2/a`Z(agT1!a-a;|@TaG!aS[yV=Re~fow'RguNuPRe?bz#'>RoUWeL>:Cbb|?JwPZtVg6ruRmzJvD'!6Vz(g/vmRh~Jvy_[y(g9voRgyx*cy(#2>Ri2B9b]~9kIw9u7rluJu3Rg]dI#a%UY'@=p%CAx.gQZ&RhwwygtRm{x5g_Z'+ABqR9Woa=Bp&dV#^*Xa'!&@o{g4v]Rk;Jv{!%Rk[wkkiA5RkiwwfUB=x,fUuqC&*!>RfTg8v0RfV~ARfSd;rJsAuAv9wR'ae+/aO!a@aza/a#[yQ@Wg!2Wemg3sEr0JvB_g>uvReWg2v+Re=KupB_+[y!2AbY~-~Hr2AJwD!(h<~El>h<~El?Kun@+_:9b`}Kg-v/Ri3g;vtwyk_9]k_d=&T#*U.6qh@Ab`|K9:H|CJv[!&3Dtex'fDwC%!Rf[9WlMd[(^X,!a%Z06Vz!@WgBg=v~Rgvg,QRe@awd,#Y+jTv|Q~EfWj]uNr|~FRfXdy#Y&^Ua%!aO.!(a)Ua;=!a@aKap!a-,a!Ta]a[rSa]p?[y82sK=Bq~;:p:~<5p8Pw:5p7d'#Y'Wf(;RnRi[u4w&RgJJvG'!6Vyh=<r#ijuuv/sIKuYD'ZtG@3p9~Gr&d2#`(g<vtRgFj`u5w&rqpxRf2CJuY!+:wfnTOu!5Rg}jNs1ucv&RfwJvA!&3@q|BDcC#T,k/unq8w8Q5RkTklwQuzunq8w8Q5Rk9dga#!a'!a=#a0!:+Tb*b@aO.a4!aba8aFJv^}?!VyR~Dr<g;u%Rn.~<5p[x'e`wNZtR@3p]Pw:5pZhNvjBp.woe_g5u-r4JwF!%DtO3:ooc7&!#:p^3DtpLuGw(!+%)Dtk6Vz#2sd=<r8d'#Y([y#<x3gJt`w@!)%}MRiowzikRij=]ilxAf3,U(#B2Rf#g0v-Rm[ck{`U#]giKv3>)!&6Ri154s,KuGB_%@r68r:dJ|t`#X(9<E|u2@H|rx3gJu?w'!+'1Nu7Reg4=H~+9<wxgY95Rm]xLggZ-`(X}U2:Ri4h<uOawRmsJv__5@bb{jbV~3dka#a'a]!,#a+U=a>b6a3b%!/aKa/)!arwve^VyJ;:pR~DpTg3uJpS~<5pOPw;5qmPw:5pNOu!5pQJvG'!6Vyx=<qoJvA!{~Jup!%@qk7Rn/KvyD!}''[xz;>wkh'?Rh,x8gyt`w5D!&),(SgyccRgztJ@3pPB5p#d'(Y#<]mmifubw&RgoJvE&!82s^JvF&!8Rf,ADb]~;x=h'rNu]vK!,%'*0RnORh)4Rh*AqQg-vaRnNg;wHwkh'ba~4cE#Ta*x3gctyw@'!+%RnFRnD<4Rn@hFvK5RnCxWg[#`&a0Ua()`1Rm75Rg[c]%X#qi8Rg^NvdRj>BwzgZauwji7Rm6A4wgg]d1#&(*,.0a#Rm;Rm<Rm=Rm>Rm?Rm@RmARmBe%#^^^Xaea?aC/b+(,!a+a#!a/!>a&Ta<aKbD!2wphBRnk[yPw}hE|.=Br-3Dtm>6Vy~g6urRf.x,hPrNav!%'RnqRo%Ro#Nu;q[Pw;5r+JwNZtM@3r)d'#Y'Weh;xChL#`&RnmRnoKu}>%(!Rne~Bs-;2wjcussJv+'!aYSO}6@B<5?ba~8LrNvj!.%*ROwungw~ng~:9;Ri^>wtnig;wHRnixDh@|(UZ.x1h@|)!#:2<H|*xHn]#-UX'3Ro)z=iT}6ARns=Bwsn_wpnaRncw]aR(#UXa&Ua*a/=]iPd'#Y&Ro'WnXf{QRm2hNvj]nZd`'T~&1`{|`#9b]{}c:'!#Wl{>@=be}]?cl{{U#:5Abb}Jds#^YaF!a*b4a#a3aPa>&Tb!bH!*a_!Eau?/a&RjY<]gj>6Vz*;:pe~DrZg,QRj1JwNZtX@wihspcJvZ&!VyX9WmOJu|!|N2WmHJvh&!]ht~Bpbcn&T(!#RmQ<s7Nu;padH#X'`+WmJ@>RmKCARhnKup=!)&Wf+:RhqNuPpf9c!#'45pd5AwghpARn(Ls@w!%,)!RmP@Wfe<E|IJva!&WmNg8vsRmLd`*.`#Y'Xa!axRn*]hrA8Rhug5s@rXg8u!RmMd8#X'X*3@rV72smdI*#UY&RmICARho~GsgxVgd)Ta'U-Y&Xa!T#RnEWnA@Wffg1uDRi0hFvK5RnBxGnG&#`%owp)@wsf+bX}Ze-*1!a*^^^Ua|!#a.aq&Ya2!a>.a6!a:aO`aJDtL[y`@Wg#>6Vz12@wzoYRoZNuPRi!NuPRhzg=ucRi,@=b`{Yg=ucRi-ACJvB!&Sh[ebSh]ebi`wUuFRm4Jw2_[y0JvB!.<Ju(!&SoG}6Shd}6<Ju(!&SoH}6She}6Kur@._g5vHRieJvx!{L2G{Kx6gd'T#?Rh82Wi5cZ#X(g1w)Rm5dW-Y(Ta#!a)!#aYa=wnfE=su2>>bU{0j9udv:<svj8uQv-7RgHdE%#^'sq9sp=>Bb_{TJv`!&g/r|snj6v(us5d,#Y(56H}[978H}]Jw5!&g1rushJvB!+j;v{u5?zDhd}6}bj;v{u5?zDhe}6}ce*#`(^^^a[aea!=!a6a*aoXb1a.!aAbL!b>,b'aL!aV@Wf|2Wlg3[y/JwNZt^@3piPw:5pgJunZou3@rsJva&!Vy_g<v~Rm#JvG'!6Vz0=<r{Ju{%!:pj@WfsiXuJu3Rm:JvZ&!WfA~Bph@c4Z&Dtwax5rubx(#:awRk1@d,#Y&RfjRfid1#,Y(@Wfp2Wlrg5s@ryKu[@!,'=]ig9wlk?Rk>g5u-rqJvy'!@9RkQcH(T#=>Ri~@<wkj(Wj(KuZB*!&<7rw@9RkRcH(T#=>Ri}@<wkj)Wj)dg(Ta2Xa9X#`-!a*CARhg@@=I}d9x;c~#X%so=<sj>2@@=aybb}XjWv0Q~EfEj3vLv;<d,#Y(56H}`978H}_dgaPaFa'a/!#a3Y0a_a;a|!1(a7-[yE3[xt;:pJNvZrrg3uJrvJwNZt=@3pIh=rt3rxPw:5pGOu!5rpJvG'!6Vys=<rz@c4Z&Dt(ax5rtJvZ!&~BpH@wsfNg-vaRlNci*U#=<wei<F}a5@Jq.!a*JQ!%@qZ23d(#Y&RjH5]jCk!u7w&u0udARjFd/prq=tyvpaEa(a:.!a1aZ(@@=I}:9wpd%=<sX55w_h}@@=I{t=ay<aU@@=I}T=ay<2@@=I})?C9:9au@9Cb]}DP~=x-fAZ(2Wl1=ay<aU@@=I}>5@d##Y+jTv|vV~EfFj]uNpn~FRfGdgaK!Z2&!a8a-Tb({E!acTbM*!a(DtY[yYd'%Y#sl[y*hHvh>Re5x2c{Z}.j4uCvcawRiMd+#X+_x&d!},<5RkX;2Hzw@x,gavfB-!{CcF&T#Roe;RodwWbBg5urRgaKvHC*_6Vz+<4opieuew&Rmq@d]&Y)X,T#X0Rh}<BqP=4qS9:ReMg/ujReNJw0!/<Jui%!bd{kawwnemRelAxUa?a3#*.&UX(Ya+a/RhvRnQ<o}9Wmtd-#Y&RgSRmw9;Rmxay=Rmyg-vaRmuxEhSrNu,v-voC!%(aR.a(a7+1Ro1>Ro5CE{A9b]{@;5x#eO{:g;urRi+KrNA!%(Ro3>Ro79;Ri_Ku@>{;&!x%gX|{KunA_+g5QRj/g3u5Rj#g>uERj%wio/xRhS&!,!#^1U}wba{8>>@=be}qC@:D5ba{7Ku+A&!}x?ba}t>>@=be}se(aA^^^Uat!b0#{pa+awUazbGa#aLb9bgaWac'a5TbS=Br!d1#`%scp_Jvl!#rT>Re0JvX&!VyN=H{Fcm#U&:pY=ReaJv2&!]h0=]nUJvG'!6Vy|=<r%JrM_=]h2@Wlud'#)U'Wf'b]{i=]h/Jvh!&~BpWg=v]RnMx+ny#'Nu;pVwjnu=]nwxJnx,T#`&Reqwjnt=]nvieu9vrRjLLuYwP(#+!th@wih5pX~Gr'g5v/Rh4KunA'!-CARnP@wwiN:Rm_9x'cvw>!|l=<saKvAA!0&3@q}>w^e1bp#&Re2Re3BDx7gH#T|f5H|eKuZ>!%(:qNAH{]Jv6!+3B2B9=b^{X<5<B92:E{ZLvhwA(a;a%!igQuyRmad+#Y}m@3Rh5d8#X'X*:AqUAHzmaxwbh<aXRnVcF}RT#Nw&cj#U(BWnug/vsRntdka)(a3+.Zb7aYYan1!bVa@Xa}[y^@b[{G=H{+hFu73Rj&Pv#5ReQcK%T#sig1v{Rj'Ku+D#'!t]~Grm~?rkKuMB!01d5#`'Vy.ta3Dtu~Hroc8#'{^45s85AwZbP&!#Rn!wghxWn#KvEA!)&2RlA2RlBx:h|#(T,=]j09Wobz>x]z/@awRoTd+#Y(az]hFhCrm4d,#Y+jTv|Q~EfMj]uNr|~FRfOdCa!Xa9_X#@<plJvf!%b`{(9;Rgwc;.!#2x7cw#T|UDb]|T5Ju={(!=@E{&Jv)&!Ab`{'awJvf!~*>>@=be{#KuY>!+&4Ezyi[ugv&RjIdea+T)#UXa&T-T&a!Rh9auRmW=]kLg5vuRn+g3u4Rn-Ow6ARn,hHus5xNk?#UX(U~)/g8v0RkD~AwkkF?Ri.OuNBwkkA?Ri/d|a2`a*^UYa.!aBTZaTa'Xa;!(!2!-a#b2[yC>6Vyq3[xr2Wi?g1rusVh%s?DtF~<5rbJs;%!DtBfswKtCj[uvuSsEu3RgVx3o:u+wN'*Zt;@3rd~Grh~?rfg8w)Lq)qE&-a%!>bI|`jWv0vV~EfCjTv|vV~Ef@j]uNpn~FRfBcK#T']gWNu7x,k7q4ai(0!hHv8<RhmkMu9vrsBuev/RhlCJvB!,g<v{wchh~@:Rhji[vrv{wchi~@:RhkdS&a5UY#Ta!RgPwwiI5BwciI~@:Rh`x'iJvj'!5]iJPu8Bwch]~@:Rhach)U#h3rp]gLh@t|Ax,hTq3ah!-(~@:Ro0Ou!5RhXj^v(pyw8unRhVd|)`,^UYas!a?/a2Z'a^Ta{Tb7Ta(a#!a,Wf&9sZ3DtAadamov=Bqt3[xig8vsRm~>waiL2b`{QJv*_Ouv2qgj<v]v2BqfdR'X*X#Y-@3qr~Gqv~?p6hHv-]glPup5Lq+q?_%*b_{qF{n9b^{rOu4ARhpKvCD!+&~Bqp:5Dbb}nwoiKl&unuTuBv]v+ueunaXRf0=Jvh!0nKufu8v1w&w7q%w&uHrz:Rgnj5w,uxDJq/(!hNw'5ReCk0s2u3w/w'5ReFd>Za&!*UaA=<wkgsRnSJv^!%Refifw3vyRgOKu_B'!,<]gkiiu:w&Rh<=C@a^<B57@2F{[<B5@aW:=3away9A5aW=<B=C@a^<B57@2F{Ie-#`(^^^bCara.b8aza6!/bZ,!adTbnTbOb+aFaS!aAT9@Wf~2Wli3Dtl2@d,#Y&RfnRfmJwJZtN~GqyJva&!VyMg<v~Rm%iXuJu3Rm9Jv[_=]ih9wlkDRkCd1#`(@Wg>2Wls3cH#T(@<Rj*=>Ri|b~'#23s9h<~El.d'#Y&Dtxi^rzvdRl#d*#U%(o|B2s`hJwSaxRmDKv4B&!1:Rmdd5#`'Vx}to~Hq{x'f1v3(!BA5ba|bJv_&!Wfug1v]ReIdO+U/Y#&G}-8wze=Rh{g1v]ReHg/uQRf/by#)ibQwERl/cH#T(@<Rj+=>Ri{cNu+vlax-!(#a0qa9<Rii2;;bU{H;x<i=&X#Rk`<4wwi=C9H~8xAI(Y#<azRi@45wXI<B9;5bb~7dL(X#Xa(+!aL6Vy{g5QqOau:5au2@ay547EzbxOcU(UX-T#Ta#:Cbb|A?wjh/b_|SOw6ARgtihr}u7Rhy<d1#T)X1@@=I|~=ay<2@@=aybb}Sj3vLv;<d,#Y(56H}A978H}@dGpvs@uAu`vcw9*!aFa+ai%(b!aXa8.a?a[ozWey=sU2@G}Nch&U#Rf_WexKu+D#'!t:~Gr`~?r^j]uNr|~FRg*j^psurwJt|RmcKv)@&!)7Rkv~Br[@wxfO:Rl3co#U'6Rezj_q#vIuavjRltwzeyh@vr5JqD0!>aY?C9:9au@9Cb]}9cl#U*5;5<H||jbuus1ucv&Rfvg1v~d/pppzqFr^a--a~!aMat1(hFv;Wiz@@=Izoj5uuv-7Rix~Cw`fk2WlVcZ#X,k)u3vWs@u2]ktg;wEx'fBq(_2Wg/jTv|vV~EfoJv]!15x'hzqG!(P~EfU~CRl_j6v(us5x4i-#T(2WmZ?C2F|d>Kq<aj1!*jTqIsBv=Wl`~Cw`fi2WlWj`v0u*~>RlR=c>Z,k#u3vWs@u2]kr<c1Z+jTqIsBv=Wla~Cw`fm2WlXdmb3!a{(arZa`bkTa%TbQTa-a9+c'!aM!/[yL=Bqug.w'RifhFvyDRj.g>vgwyk^9]k^Jv3_@WfbAARkhJw2_[x|JvB_wkoIRoKwkoJRoLd'(Y#<]gm=<9<H|yd'%_X#skDtb3awwqkgNulRkgdB#^',9:p'hJwSaxRmEBwVb8@4=H|qLu+w50&!)@3qs~?pU>Awwn;;Rn=c:Z'ARn<=<qwKvC@!/&~BqqJv6!&]eVb^z^xRge'/a%+^`#Sge}6<4Rn3=]n0Pw2>Rn8Jw0!&>Rn:>Rn6cY#a7+!a&=<wkaNw~h3z_c5Z{=wjh#=]nLKv^D!&)Vyz=bW|swYb<WetcG#T(2wxa@qVx@gD#Y&b^|V5JwG&!5bb|pg/w&RgD@x=kHs=uAvn!a%%/'+RmSRh694Ro`g-vaRmRhHv-]mlxCcS#`&ba~.5cD#Ta)P~=d,#Y(56H{>978H{Dd_#{2^Y%_+qbbb{6g3sERhsbU{?dfa.,`a(Xa<!aiX#(55RiG54RiHcI#T'WiU3RiVNvdwtfcRlKNvdd,#Y&RlHRlExQgf.1*^T'X#Sgf}6Wn4=]hfPrk>Rn7Jw0!&>Rn5>Rn9Lunw?&a2!,5<oq@@wqfdRlJj5Q~=d,#Y(~ARfcOuN]fdDKw;ay(}i!547E}j?cI#T(@5bV}iCbV}hdv(^^Tb?a40,b##Tbo!a*bR!a<b|a/!aKai!aU[yK=]o^g:v>ReGJwPZtK<7Rh+h<~El,Pv#5ReR@awwxjCg,ulRjDJv6&!]j!z?aQeeg>w=Sh<eeJw;!&axEzOg,Qosc!#*:wkeJ]eJ>x'h-u(!%Ro.w~h.zPdNZ(X,Ya![x{;9ReY;wkgxRiF:x?ap#Y&RmUg<s2Rkod]+UY0TZ'!a&A9sw<=bczLNvuw{gqzNhJwSaxRmCKuLay!#&s_Rf-55b^{uJvZa!!c%#(55Ri654wmiu5RiuawLu,vp!+}^%b_}Y9;wkgxba}o>A9:=b^}zKuh=a''!3awRk3c*'!#aHRk6c+Z&Rk5Rk4Jv)&!awRjSawd9*`#0?C2@EzMj8u<uJ5RmbjQrquJu3x,k>uq@_+=ayb^|W~ARkEOuN]k@7dhzV^X/X&a-#zRzSb`zXcJzTT#2WkVKvDBzW!%FzY9;5bbzWjQrquJu3Jw3%!b`zU=ayb^zQd:#X(T-a!6Vyywxh}=b]{Jg=u1RiAdGp~qHtzv!w(wA+a+a;<!aJaYai'anasb(=azRmV:Cbb{MLq2vb!%')RjuRjrRjtRjqx3jnqCw3!%')Rk(Rk+Rk&Rk)Lq2vb!%')Rj{RjxRjzRjwLq2vb!%')RjsRjpRjfRjex3jcqCw3!%')Rk'Rk*RjkRjl9<CbbzfOu4ARhxLq2vb!%')RjyRjvRjhRjgx=joq*uKvb!%')+-Rk.Rk%Rj~Rk-Rk#Rj}x=jdq*uKvb!%')+-Rk,Rk!Rj|RjmRjjRjidAq&qKs@uAv8Aa.'*-a@a&0!aM@a5[y73Dsy3Ds|3Dt):wxgI2sHJwJZt.~Gqxwsf0ikrzt}Rl0Jvy_[xj~HqzKv_A|D!&WfP8axRoVcf,U#k(v]v+ueunaXRf1Ju}'!g8u#Ri=jQw!sCunLprq>!,')~<5qeGzq9F{W=c##%s5au:5aU3CBE|;d4#X(D!a&6Vygx(b;#(=]ed?C2F{N<capoq2r[a&!aPa9,'Pw;5s:@@=I|,55w_h|@@=IzcP~=x'fCqB_2Wl2>aU@@=I|1OuNBc1Z+jTqIsBv=Wlc~Cw`fl2WlZ~AcTa%!Z+jTqIsBv=Wlb~Cw`fh2WlYk+uNqJsBv=WlSg,u3dca3#UXaMYa)TaB-=cM|7T#<bI}l5@B932:aV2G{BOuNBJq:|M!5Ezt=<B=C@a^<B57@2F{v>cB{/T#=ay<bI{3Jv6!a.6BKq0ah&+!5E}HP~Ef{978BaU@@=Iza<7d#.Y#978BaU@@=IzH~AJq0!(@@=IzG978BaU@@=IzFe,aU*Y&^^^bvJb,b:bFad!a,c2Ta>aL.bo6!a#CbTa'T#Re{2Wlh2@G{yg6t~Ro_NvdRfticuRQRllJv3&!x&c|zs@Jw3!%RflwpfkRlpKuL;%(!Re<@G|C2GzdhIvuBwgjAg-u0RjAKQB%!(GzZ@G|5NuuRl7d='T+Y#Vy[g<v~Rm!==G|>JvA!)@wma=]m1ifuaw&RmnLs@vT'!|/+[y,g:v>ReTJw1!#qX=x!eC{bLu+wT&)ZtZauq_~Graci&U#F|89:r_Lupvq!.)&2RlG8RfaC=x!eF{_h?rpWlmd&'!#X|&]k::xJey#`'T|+<E|&2@H|%dE#(^,g;u.RiEg6vjRiC9xCkA{O|zY#g=ucRmXKs0@!&*@G|m@awRknJuh!,3d(}gY}eJvj!%Rm):Jw3!%Rm+Rm-Ls0w(&!a(a#@b[|6cZ#X'7RkxWgAOu4ARn'dH'U#Y*Vz-Wm'CARm}d]*#a%^a*T'aK!a<9bV{PC=p*Jw4!&SgxcbB5r]idw(wBRmF7xFkt#&`(Rm/Rm8E|!JuY_9:Rl5=wrgr2:bbxd@xXfB(a*#T+!.X0X1Ta/a'T&RlDRfL>RlyARl9b[z[>RfZ:RlL:RfRwlg/ARl;9;RlxKv,A/!%7s69<74=BA5ba{-8Bde#`a<XaKYa1,a'P~=wxfB2bZ}}?C972@@=I}r8@55B9;5bb}G978B2@@=aybb}3j3vLv;<Jw3&!>Rfk=ayb^}4~Ad1#`*@@=aybb{w2@>==<bbz]dx+UY#^UaF!a9!bB'Ya1.!ajXa#%olRhD[y=3Dt#Ov5BrHKuMB%!(Rf^Wep~HrJwkiQjKr|~FRg)Ku+D#'!t5~GrF~?rDdV)UY,Z/_7RkuG{<~BrBg,rlsO:235B@bX}|d?a1!#`(6Vyn5@d##Y+jTv|vV~EfIj]uNpn~FRfH7Lq2vb1!a9-978BaU@@=Iz9978BbU}#~AJq0!(@@=Iz8978BaU@@=Iz7~AJQ|}!978BbU}!JvkaK!AdUa21-U#`a+(g/vsRn~Ou!5RPj:rmu9WhOjXuvvNr}:RhAj^v(pyw8unRn[kPr}p|u7vwv]RiSBd;pppzq@qHQa?(b.!a.a`@.|xa(hFv;Wiyj5uuv-7Riw~Cw`fg2WlU978BbU|wOuNBJqG!(P~EfD~CRlQcZ#X,k)u3vWs@u2]ksg;wEx'f@q1_2Wg.j]uNpn~FRfqJv]!15x'h{qG!(@@=IzK~CRl^j6v(us5x4i,#T(2WmY?C2F{1>Kq<aj1!*jTqIsBv=Wld~Cw`fj2Wl[j`v0u*~>RlT=c>Z,k#u3vWs@u2]kq<c1Z+jTqIsBv=Wle~Cw`fn2Wl]dn1#c(a(b^a2!b/bAT(bj!aDa7bu,a_a{c0!2T0g:v>ReD2@G{42@G{5~DpM~<5rc=Bx6i>{RT#RnI@zCx]y]z:2Jv[!zr5Awyk]9]k]dD(Y+X#6Vz.g=wKtgwhaCwgmTWj2Lu,w%_+/[y-B;b^xeg3u3Rj-2@bX{*KrJ<!+'@Wg(g?QRlC@Jv`!%b[zIwsfII}8JQ_@w|kW|=Jv(%!AqcOuNBJvEzh!bYzjLs@wP#(0!oy@>RkdJwMZtc3Dtd@BcG#T'9bWxg2@2Fznd*#Y+;2x'c}w<zizixNgwa#Z'U+!/!a'!a+w~g~z6wcn{Rn}wcnzRn|5Rh%=]nJg5vuRmvNvdRlvcprJu}w*az*a#!%.a.'Bot9qT]kj@Wg'ay2Gzv@Jv`!%b[zEwsfHI}1;ck#Ux`<Cbbx_Lu+w!a&0*!wko*wwo,So,}6Juqxf!E}PigQuyRm`d3(`#8>Rn%:A5B;bZ~%KvhCa!a2!x>k7#Uxb@b{#xaRk7Jw0!)>wwhlShl}6>wwhmShm}6CJvB!.x'hhvj{!!5Bwkhhbaz}x'hivjz~!5Bwkhibaz|xEhTrNu,v-vpD!a%&/)a3a.,%Ro2t[CE{)@3re9b]{%wjo09:rgc:Z&Ro6=<riifuaw&RmoKrNA!%(Ro4>Ro89;Ri`dSaL'UYzxZb)7Rka3xRhT&!,!#^1U}vbaz{>>@=be}yC@:D5bazzKu+A&!}{?ba}y>>@=be}wxBh[t`u~vJvr!%a!a()a,a0a4RoC=]o;Ju(!%RoGRhdwjh`=]oAg>w#Ro?g5vuRo=NvdRl|Ku]C.!&;RoEJvB!%RoORoMBx'h[v+_?w~h`}~5?w~hd~!xKh]oiptu-utv.vp!#%&a30a@a'a+(a/aOp(o~p!RoDJu(!%RoHRhewjha=]oBNvdRl}g>w#Ro@g5vuRo>c[#X']o<CauRoRAd-#Y':RkpauRoQKu]C.!&;RoFJvB!%RoNRoPBx'h]v+_?w~ha}t5?w~he}ue!/UbhYacXaW^Tc&a;b:a-c/#b&aja1(!cL+!bKbt!bmcRc9aIc?8[yW3Dtt94Rg`Jv}!&SiRMzBhEebShEMNuPRe>x7gL#TzuwjirRipc<Z&>on;>z=h-MSh.Mwqczx'a7vj&!>Re4@=ResJt__NuPRi*NuPRi)j]uNr|~FRfzKrJ>_+@Wfy@Wf]2WocKrJ<!+'@Wg%g/QRl@@Jv`!&awRl<wsfFIzgLu(w*!.*&ShBMwvhIRhI9;RhNx1hK'!#Sn]Mx1hK~0!#:2<H~7cNu+w7D*'1ZtW>Rn1~?rOc:Z&Rn2=<rQ<7wjh&=BSnLMc]#X(6Vz)w[b=a!U#9wzgMc3#&(RgMRitRis<x,gKt`ax!&+SioM=BSilMc3#&(RgKRinRimKurB,!&SiQMzBhDebShDM6BJQ!(P~Efx978B2@@=I}WLrJw!!,a*&@G}O@9wkibRid@@x'fKwC!&SlDMSfLMjUv~Q~EfKKv3@a+!(hFv-]mpx/hYZ(C5RiWz<o/MwkhY?So/M@x,gbvfB*&!SgEM:SoeeehFu3:Rgbda(,^TZa)X/7Sg[eb:2RgI~BrMC@wgkc:wwkcRerx3h(uUvK!&*,SnOM4Sh*MArRg;wHRh(x=h;rJvPwI!a4',a'0@Wg&=BSh/Mg>w=Rh=g3w*wwgGRgGcW(X#;Sg}M2Gzk@Jv`!&awRl=wsfGIz`dKZ*T'Y-:RhR7RhQg5u-p`j6v(us5d,#Y+~Awkia?RicOuNBwkibba}Ld6p~tyu_vbAa'a+!a/'a3aEa8a!>Sh,ebJv{!&Sh@ebSaReb9;SgwebNuPRi(NvdRl)NuPRi'hHu^<Rm^Jvv_@Wl(g;u1Si/ebKu'B&!*Sh?eb@Wl'z@aPeb95Si.ebcpputyvjB)!,&a+0a%ShAMWeK@G}C@WfJ9;RhMwvhH9w{ia}ix,hJvRA1(!zAn[MRhHx1hJ~*!#hFv(BSn[MBJQ!(@@=I~'978B2@@=I}2db.Ua<'X}+T#a0XaG2G}E;wkg|wuh!Rh!x,hZu,@)!&So0MVy)C5RiXACJvB!&5RiY5RiZg8w)cG}*T#2@bU}=KsA>(!a.3wkhZba~(x,h^u(A!&(SoCMRhb5Bz=h[eb?w~hb~6x,h_u(A!&(SoDMRhc5Bz=h]eb?w~hc~6e)aA1T#T,^^^c-bMb&blcPaP(a/!0!bA=b5c@a(!bfbrc#2afwmhARnjwchORnp2Wlf3DtsNvdRl-2@wpa<]m0bx(#:awRk2@Jw3!%RfhwpfgRlnKQB%!(G{V@G|'NuuRl6d='T+Y#VyUg<v~Rl~==G|<Jv+'!aYShC}6@B<5?ba~8@Jw3'!g2QRljhLrpWlOd+#Y'g.w'rIg>w*wgj@g-u0Rj@Lu+wT&)ZtUauq]~GrGci&U#F|39:rELrNvj!.%*RhCwunfw~nf~:9;Ri]>wtnhg;wHRnhx3hDs@v~!/+'@Wfr@9RkSNu&Rlo=@<5GzoKs0@_+@Wl+@awRkmJuh!-3d(}pY#qWJvj!%Rm(:Jw3!%Rm,Rm*de&!1U-U#`)Re;@G|.@9Ri82@wjfvRlq=@<5GzpLvOvr!).&2RlF8Rf`C=x!eE{.Jw3_g2QRlkhLrpWlPde(!#U{s,UXa*Ta'[y'g:v>ReS;x0PZ&RnlRnn~HrKJw1}f!=x!eB|2w]aP(#Xa&a*Ta.Ua2a7=]iOd'#Y&Ro&WnWg;u.RiDg6vjRiBNvdRlzhNvj]nYJuW_2Wm3x)kFze{9d])!a.!,Y01!#&aC!a3RndC=ox~BrC@2b^{pg,rlse7x'ksuq!%Rm.E{xidw(wBRmGx9o+)X#wwo-So-}69:Rl4@xSf@a#XZ'X)X,Ta(/ARl8b[xc>RfY:RlI:RfQwlg.ARl:9;Rlwdn'#^XafaQa1X1TaHTa)@b[{zcZ#X'7RkwWg@Ou4ARn&x)kG#{,g7u/RkGdH'U#Y*Vz'Wm&CARm|bx#(A]gUbUzJj9Q~=d,#Y(56H}l978H{U7d,0#U*2>ABb_xZ978BbU{e~AJQ{g!978BbU{hxMh?ad{oUYZ.x1h?{l!#:2<H{mx3n[t{vl!,&a%3Ro(z=iS}6ARnr=Bwsn^wvn`Rnbd`*T}B0!#^X'BG{c9b]{a>>@=be}F?JvS!&BG{d7BG}(Bde#`a1X,Ya@!a'P~=wxf@2bZ}I56B2@@=aybb}08@55B9;5bb}<j3vLv;<Jw3&!>Rfg=ayb^}&OuNBKuLA!)a!P~=x#fD{f2@>==<bbzl?C972@@=Ix^d6rSu,v7w*C(0a)a6#B+a%!sQ[y?3Dt%3[xn~<5rLOu!5p@Ku+D#'!t7~GrP~?rNKvlaya7'!h+v-5qMg=t|cd,U#5AAaa5Abb{S@52B5@a[@52B5Gx[iXueu;d<#`a(!/549C;ag>23ExY5@Dah89b^~689Jv)!~2b[~1Lv'w(%*!a#bX|aPrmawRe]keu7uhv-q6rxu,q`xTo]/a5aU!bNaDXbi!b-!ao!b<bwA!#5@B932:aV2G|:d-)Y#hJrL>RhG<7@C5<H|_=Cau:5aj5@B932:bJ|ng>vIbs)#?C2F|9jPv0w.vISh-MKvUaz(.!9ABbb|[5;5<H|Eg>unwfh;9:4E|YjQsBt|vjx'hYq3!(?C2F|J:2<BaY?C2F|GOu!5x,g|p{ah!-(?C2F|c9:4E|OjXuvvNr}:Rh&i[w*t|cd+U#jJvsu)vsSn~Mkfrmu9p}u7vwv]So!McW#Xa!ax5@A5aY:5;5<H|>kJv~vYrquJu3x4ib#T)2@SmZM?C2F|Bj:rmu9@xPhI(a*a#U#`a3-5Abb|L~@:RhK9:4E|0@52B5G|#C::aY?C2F|-:2<BaY?C2F|.5Jvk!a)javYrquJu3x4ia#T)2@SmYM?C2F|HAxPhH(!a#U#`a*-5Abb|4~@:RhJ9:4E|R@52B5G|F:2<BaY?C2F|Sc^#Xa2j=Qq5CJvB!-g<v{z;hhM?C2F|Zi[vrv{z;hiM?C2F|XKsA>!a)-g<v{z;h[eb?C2F|]i[vrv{z;h]eb?C2F|^iZu.vix,hZq3ah!.(?C2F|QOu!5ShXM:2<BaY?C2F|P", 13494, 2713, 49, 25, 61);
  }
});

// node_modules/entities/dist/generated/decode-data-xml.js
var xmlDecodeTree;
var init_decode_data_xml = __esm({
  "node_modules/entities/dist/generated/decode-data-xml.js"() {
    xmlDecodeTree = /* @__PURE__ */ new Uint16Array([
      512,
      26465,
      29036,
      7,
      0,
      2,
      4,
      116,
      24638,
      116,
      24636,
      8693,
      29807,
      24610,
      621,
      1,
      0,
      0,
      3,
      112,
      24614,
      111,
      115,
      24615
    ]);
  }
});

// node_modules/entities/dist/internal/bin-trie-flags.js
var BinTrieFlags;
var init_bin_trie_flags = __esm({
  "node_modules/entities/dist/internal/bin-trie-flags.js"() {
    (function(BinTrieFlags2) {
      BinTrieFlags2[BinTrieFlags2["VALUE_LENGTH"] = 49152] = "VALUE_LENGTH";
      BinTrieFlags2[BinTrieFlags2["FLAG13"] = 8192] = "FLAG13";
      BinTrieFlags2[BinTrieFlags2["BRANCH_LENGTH"] = 8064] = "BRANCH_LENGTH";
      BinTrieFlags2[BinTrieFlags2["JUMP_TABLE"] = 127] = "JUMP_TABLE";
      BinTrieFlags2[BinTrieFlags2["VALUE_MASK"] = 8191] = "VALUE_MASK";
    })(BinTrieFlags || (BinTrieFlags = {}));
  }
});

// node_modules/entities/dist/decode.js
function unpackConsumed(packed) {
  const consumed = packed >>> CONSUMED_SHIFT;
  return consumed === CONSUMED_OVERFLOW ? longNumericConsumed : consumed;
}
function isNumber(code) {
  return code - CharCodes.ZERO >>> 0 <= 9;
}
function isHexadecimalCharacter(code) {
  return (code | TO_LOWER_BIT) - CharCodes.LOWER_A >>> 0 <= 5;
}
function isAlpha(code) {
  return (code | TO_LOWER_BIT) - CharCodes.LOWER_A >>> 0 <= 25;
}
function isEntityInAttributeInvalidEnd(code) {
  return code === CharCodes.EQUALS || isAlpha(code) || isNumber(code);
}
function determineBranch(decodeTree, current, nodeIndex, char) {
  const branchCount = (current & BinTrieFlags.BRANCH_LENGTH) >> 7;
  const jumpOffset = current & BinTrieFlags.JUMP_TABLE;
  if (jumpOffset) {
    if (branchCount === 0) {
      return char === jumpOffset ? nodeIndex : -1;
    }
    const slot = char - jumpOffset;
    if (slot >>> 0 >= branchCount)
      return -1;
    const stored = decodeTree[nodeIndex + slot];
    return stored === 0 ? -1 : nodeIndex + branchCount + stored - 1 & 65535;
  }
  if (branchCount === 0)
    return -1;
  const packedKeySlots = branchCount + 1 >> 1;
  const branchEnd = nodeIndex + packedKeySlots + branchCount;
  for (let index = 0; index < branchCount; index++) {
    const packed = decodeTree[nodeIndex + (index >> 1)];
    const key = packed >> ((index & 1) << 3) & 255;
    if (key === char) {
      const pointerIndex = nodeIndex + packedKeySlots + index;
      return branchEnd + decodeTree[pointerIndex] & 65535;
    }
    if (key > char)
      return -1;
  }
  return -1;
}
function readTrieValue(decodeTree, nodeIndex, valueLength) {
  if (valueLength === 1) {
    return String.fromCharCode(decodeTree[nodeIndex] & BinTrieFlags.VALUE_MASK);
  }
  if (valueLength === 2) {
    return String.fromCharCode(decodeTree[nodeIndex + 1]);
  }
  return String.fromCharCode(decodeTree[nodeIndex + 1], decodeTree[nodeIndex + 2]);
}
function parseNumericEntity(input, numberStart, inputLength) {
  let offset = numberStart + 1;
  let cp = 0;
  let digitStart = offset;
  if (offset < inputLength && (input.charCodeAt(offset) | TO_LOWER_BIT) === CharCodes.LOWER_X) {
    offset += 1;
    digitStart = offset;
    while (offset < inputLength) {
      const char = input.charCodeAt(offset);
      if (isNumber(char)) {
        cp = cp * 16 + (char - CharCodes.ZERO);
      } else if (isHexadecimalCharacter(char)) {
        cp = cp * 16 + ((char | TO_LOWER_BIT) - CharCodes.LOWER_A + 10);
      } else {
        break;
      }
      offset += 1;
    }
  } else {
    while (offset < inputLength) {
      const digit = input.charCodeAt(offset) - CharCodes.ZERO;
      if (digit >>> 0 > 9)
        break;
      cp = cp * 10 + digit;
      offset += 1;
    }
  }
  if (offset === digitStart)
    return 0;
  if (offset < inputLength && input.charCodeAt(offset) === CharCodes.SEMI) {
    offset += 1;
  }
  if (cp > 1114111)
    cp = 1114112;
  let consumed = offset - numberStart;
  if (consumed >= CONSUMED_OVERFLOW) {
    longNumericConsumed = consumed;
    consumed = CONSUMED_OVERFLOW;
  }
  return consumed << CONSUMED_SHIFT | cp;
}
function decodeWithTrie(input, isStrict, isAttribute) {
  const decodeTree = htmlDecodeTree;
  let offset = input.indexOf("&");
  if (offset < 0)
    return input;
  const inputLength = input.length;
  let chunkStart = 0;
  let result = "";
  const root = decodeTree[0];
  const rootJumpOffset = root & BinTrieFlags.JUMP_TABLE;
  const rootBranchCount = (root & BinTrieFlags.BRANCH_LENGTH) >> 7;
  do {
    const entityStart = offset + 1;
    const firstChar = input.charCodeAt(entityStart);
    let consumed;
    let value;
    if (firstChar === CharCodes.NUM) {
      const packed = parseNumericEntity(input, entityStart, inputLength);
      consumed = unpackConsumed(packed);
      if (isStrict && consumed > 0 && input.charCodeAt(entityStart + consumed - 1) !== CharCodes.SEMI) {
        consumed = 0;
      }
      value = consumed === 0 ? "" : codePointToString(packed & CODE_POINT_MASK);
    } else if (isAlpha(firstChar)) {
      consumed = 0;
      value = "";
      const rootSlotIndex = firstChar - rootJumpOffset;
      let nodeIndex;
      if (rootSlotIndex >>> 0 < rootBranchCount) {
        const stored = decodeTree[1 + rootSlotIndex];
        nodeIndex = stored === 0 ? -1 : rootBranchCount + stored & 65535;
      } else {
        nodeIndex = -1;
      }
      let bestNodeIndex = 0;
      let bestValueLength = 0;
      let current = nodeIndex < 0 ? 0 : decodeTree[nodeIndex];
      let index = entityStart + 1;
      trie: while (index < inputLength) {
        while (
          // Value-less, non-run node with a nonzero jump offset.
          (current & (BinTrieFlags.VALUE_LENGTH | BinTrieFlags.FLAG13)) === 0 && (current & BinTrieFlags.JUMP_TABLE) !== 0
        ) {
          const jumpOffset = current & BinTrieFlags.JUMP_TABLE;
          const branchCount = (current & BinTrieFlags.BRANCH_LENGTH) >> 7;
          if (branchCount === 0) {
            if (input.charCodeAt(index) !== jumpOffset)
              break trie;
            nodeIndex += 1;
          } else {
            const slot = input.charCodeAt(index) - jumpOffset;
            if (slot >>> 0 >= branchCount)
              break trie;
            const stored = decodeTree[nodeIndex + 1 + slot];
            if (stored === 0)
              break trie;
            nodeIndex = nodeIndex + branchCount + stored & 65535;
          }
          current = decodeTree[nodeIndex];
          index += 1;
          if (index >= inputLength)
            break trie;
        }
        if ((current & (BinTrieFlags.VALUE_LENGTH | BinTrieFlags.FLAG13)) === BinTrieFlags.FLAG13) {
          const runLength = (current & BinTrieFlags.BRANCH_LENGTH) >> 7;
          if (input.charCodeAt(index) !== (current & BinTrieFlags.JUMP_TABLE)) {
            break;
          }
          index += 1;
          const remaining = runLength - 1;
          let wordIndex = nodeIndex + 1;
          let charIndexInPacked = 0;
          for (; charIndexInPacked + 1 < remaining; charIndexInPacked += 2) {
            const packed = decodeTree[wordIndex];
            if (input.charCodeAt(index) !== (packed & 255))
              break trie;
            index += 1;
            if (input.charCodeAt(index) !== (packed >> 8 & 255))
              break trie;
            index += 1;
            wordIndex += 1;
          }
          if (charIndexInPacked < remaining) {
            if (input.charCodeAt(index) !== (decodeTree[wordIndex] & 255))
              break;
            index += 1;
          }
          nodeIndex += 1 + (runLength >> 1);
          current = decodeTree[nodeIndex];
          continue;
        }
        const valueLength = current >>> 14;
        const char = input.charCodeAt(index);
        if (valueLength !== 0) {
          if (char === CharCodes.SEMI) {
            consumed = index - entityStart + 1;
            value = valueLength === 1 ? String.fromCharCode(current & BinTrieFlags.VALUE_MASK) : readTrieValue(decodeTree, nodeIndex, valueLength);
            break;
          }
          if (!isStrict && (current & BinTrieFlags.FLAG13) === 0) {
            consumed = index - entityStart;
            bestNodeIndex = nodeIndex;
            bestValueLength = valueLength;
          }
          if (valueLength === 1)
            break;
        }
        const next = determineBranch(decodeTree, current, nodeIndex + (valueLength || 1), char);
        if (next < 0)
          break;
        nodeIndex = next;
        current = decodeTree[nodeIndex];
        index += 1;
      }
      if (value === "") {
        const finalVL = current >>> 14;
        if (finalVL !== 0 && !isStrict && (current & BinTrieFlags.FLAG13) === 0) {
          consumed = index - entityStart;
          bestNodeIndex = nodeIndex;
          bestValueLength = finalVL;
        }
        if (consumed > 0) {
          value = readTrieValue(decodeTree, bestNodeIndex, bestValueLength);
        }
      }
    } else {
      consumed = 0;
      value = "";
    }
    if (consumed === 0 || isAttribute && firstChar !== CharCodes.NUM && input.charCodeAt(entityStart + consumed - 1) !== CharCodes.SEMI && entityStart + consumed < inputLength && isEntityInAttributeInvalidEnd(input.charCodeAt(entityStart + consumed))) {
      offset = entityStart;
    } else {
      if (chunkStart < offset) {
        result += input.slice(chunkStart, offset);
      }
      result += value;
      offset = chunkStart = entityStart + consumed;
    }
    if (input.charCodeAt(offset) !== CharCodes.AMP) {
      offset = input.indexOf("&", offset);
    }
  } while (offset >= 0);
  return result + input.slice(chunkStart);
}
function decodeHTML(htmlString, mode = DecodingMode.Legacy) {
  return decodeWithTrie(htmlString, mode === DecodingMode.Strict, mode === DecodingMode.Attribute);
}
function decodeHTMLAttribute(htmlAttribute) {
  return decodeWithTrie(htmlAttribute, false, true);
}
function decodeHTMLStrict(htmlString) {
  return decodeWithTrie(htmlString, true, false);
}
function decodeXML(xmlString) {
  let offset = xmlString.indexOf("&");
  if (offset < 0)
    return xmlString;
  let lastIndex = 0;
  let result = "";
  do {
    const start = offset + 1;
    let consumed = 0;
    let value = "";
    const c12 = xmlString.charCodeAt(start);
    if (c12 === CharCodes.NUM) {
      const packed = parseNumericEntity(xmlString, start, xmlString.length);
      consumed = unpackConsumed(packed);
      if (consumed === 0 || xmlString.charCodeAt(start + consumed - 1) !== CharCodes.SEMI) {
        consumed = 0;
      } else {
        const codePoint = packed & CODE_POINT_MASK;
        value = codePoint - 1 >>> 0 < 55295 ? String.fromCharCode(codePoint) : String.fromCodePoint(replaceCodePointXML(codePoint));
      }
    } else {
      switch (c12) {
        // &lt; / &gt;
        case 108:
        case 103: {
          if (xmlString.charCodeAt(start + 1) === 116 && xmlString.charCodeAt(start + 2) === CharCodes.SEMI) {
            consumed = 3;
            value = c12 === 108 ? "<" : ">";
          }
          break;
        }
        // &amp; / &apos;
        case 97: {
          const c2 = xmlString.charCodeAt(start + 1);
          if (c2 === 109 && xmlString.charCodeAt(start + 2) === 112 && xmlString.charCodeAt(start + 3) === CharCodes.SEMI) {
            consumed = 4;
            value = "&";
          } else if (c2 === 112 && xmlString.charCodeAt(start + 2) === 111 && xmlString.charCodeAt(start + 3) === 115 && xmlString.charCodeAt(start + 4) === CharCodes.SEMI) {
            consumed = 5;
            value = "'";
          }
          break;
        }
        // &quot;
        case 113: {
          if (xmlString.charCodeAt(start + 1) === 117 && xmlString.charCodeAt(start + 2) === 111 && xmlString.charCodeAt(start + 3) === 116 && xmlString.charCodeAt(start + 4) === CharCodes.SEMI) {
            consumed = 5;
            value = '"';
          }
          break;
        }
      }
    }
    if (consumed > 0) {
      if (lastIndex < offset)
        result += xmlString.slice(lastIndex, offset);
      result += value;
      offset = lastIndex = start + consumed;
    } else {
      offset = start;
    }
    offset = xmlString.charCodeAt(offset) === CharCodes.AMP ? offset : xmlString.indexOf("&", offset);
  } while (offset >= 0);
  return result + xmlString.slice(lastIndex);
}
var CharCodes, TO_LOWER_BIT, CONSUMED_SHIFT, CODE_POINT_MASK, CONSUMED_OVERFLOW, longNumericConsumed, EntityDecoderState, DecodingMode, EntityDecoder;
var init_decode = __esm({
  "node_modules/entities/dist/decode.js"() {
    init_decode_codepoint();
    init_decode_data_html();
    init_decode_data_xml();
    init_bin_trie_flags();
    (function(CharCodes2) {
      CharCodes2[CharCodes2["AMP"] = 38] = "AMP";
      CharCodes2[CharCodes2["NUM"] = 35] = "NUM";
      CharCodes2[CharCodes2["SEMI"] = 59] = "SEMI";
      CharCodes2[CharCodes2["EQUALS"] = 61] = "EQUALS";
      CharCodes2[CharCodes2["ZERO"] = 48] = "ZERO";
      CharCodes2[CharCodes2["NINE"] = 57] = "NINE";
      CharCodes2[CharCodes2["LOWER_A"] = 97] = "LOWER_A";
      CharCodes2[CharCodes2["LOWER_X"] = 120] = "LOWER_X";
    })(CharCodes || (CharCodes = {}));
    TO_LOWER_BIT = 32;
    CONSUMED_SHIFT = 21;
    CODE_POINT_MASK = 2097151;
    CONSUMED_OVERFLOW = 2047;
    longNumericConsumed = 0;
    (function(EntityDecoderState2) {
      EntityDecoderState2[EntityDecoderState2["EntityStart"] = 0] = "EntityStart";
      EntityDecoderState2[EntityDecoderState2["NumericStart"] = 1] = "NumericStart";
      EntityDecoderState2[EntityDecoderState2["NumericDecimal"] = 2] = "NumericDecimal";
      EntityDecoderState2[EntityDecoderState2["NumericHex"] = 3] = "NumericHex";
      EntityDecoderState2[EntityDecoderState2["NamedEntity"] = 4] = "NamedEntity";
    })(EntityDecoderState || (EntityDecoderState = {}));
    (function(DecodingMode2) {
      DecodingMode2[DecodingMode2["Legacy"] = 0] = "Legacy";
      DecodingMode2[DecodingMode2["Strict"] = 1] = "Strict";
      DecodingMode2[DecodingMode2["Attribute"] = 2] = "Attribute";
    })(DecodingMode || (DecodingMode = {}));
    EntityDecoder = class {
      decodeTree;
      emitCodePoint;
      errors;
      /** The current state of the decoder. */
      state = EntityDecoderState.EntityStart;
      /** Characters that were consumed while parsing an entity. */
      consumed = 1;
      /**
       * The result of the entity.
       *
       * For named entities: the trie index of the best legacy match so far
       * (0 = none). For numeric entities: the accumulated code point.
       */
      result = 0;
      /** The current index in the decode tree. */
      treeIndex = 0;
      /**
       * Characters consumed since the last recorded legacy match, plus one.
       * Invariant at the top of the `stateNamedEntity` loop: `excess` equals
       * the number of unrecorded consumed characters + 1.
       */
      // biome-ignore lint/correctness/noUnusedPrivateClassMembers: False positive (read via destructuring)
      excess = 1;
      /** The mode in which the decoder is operating. */
      decodeMode = DecodingMode.Strict;
      /** The number of characters that have been consumed in the current run. */
      // biome-ignore lint/correctness/noUnusedPrivateClassMembers: False positive
      runConsumed = 0;
      constructor(decodeTree, emitCodePoint, errors) {
        this.decodeTree = decodeTree;
        this.emitCodePoint = emitCodePoint;
        this.errors = errors;
      }
      /**
       * Resets the instance to make it reusable.
       * @param decodeMode Entity decoding mode to use.
       */
      startEntity(decodeMode) {
        this.decodeMode = decodeMode;
        this.state = EntityDecoderState.EntityStart;
        this.result = 0;
        this.treeIndex = 0;
        this.excess = 1;
        this.consumed = 1;
        this.runConsumed = 0;
      }
      /**
       * Write an entity to the decoder. This can be called multiple times with partial entities.
       * If the entity is incomplete, the decoder will return -1.
       *
       * Mirrors the non-streaming `decodeWithTrie`, but with the ability to stop decoding if the
       * entity is incomplete, and resume when the next string is written.
       * @param input The string containing the entity (or a continuation of the entity).
       * @param offset The offset at which the entity begins. Should be 0 if this is not the first call.
       * @returns The number of characters that were consumed, or -1 if the entity is incomplete.
       */
      write(input, offset) {
        switch (this.state) {
          case EntityDecoderState.EntityStart: {
            if (input.charCodeAt(offset) === CharCodes.NUM) {
              this.state = EntityDecoderState.NumericStart;
              this.consumed += 1;
              return this.stateNumericStart(input, offset + 1);
            }
            this.state = EntityDecoderState.NamedEntity;
            return this.stateNamedEntity(input, offset);
          }
          case EntityDecoderState.NumericStart: {
            return this.stateNumericStart(input, offset);
          }
          case EntityDecoderState.NumericDecimal: {
            return this.stateNumericDecimal(input, offset);
          }
          case EntityDecoderState.NumericHex: {
            return this.stateNumericHex(input, offset);
          }
          default: {
            return this.stateNamedEntity(input, offset);
          }
        }
      }
      /**
       * Switches between the numeric decimal and hexadecimal states.
       *
       * Equivalent to the `Numeric character reference state` in the HTML spec.
       * @param input The string containing the entity (or a continuation of the entity).
       * @param offset The current offset.
       * @returns The number of characters that were consumed, or -1 if the entity is incomplete.
       */
      // eslint-disable-next-line unicorn/consistent-class-member-order
      stateNumericStart(input, offset) {
        if (offset >= input.length) {
          return -1;
        }
        if ((input.charCodeAt(offset) | TO_LOWER_BIT) === CharCodes.LOWER_X) {
          this.state = EntityDecoderState.NumericHex;
          this.consumed += 1;
          return this.stateNumericHex(input, offset + 1);
        }
        this.state = EntityDecoderState.NumericDecimal;
        return this.stateNumericDecimal(input, offset);
      }
      /**
       * Parses a hexadecimal numeric entity.
       *
       * Equivalent to the `Hexademical character reference state` in the HTML
       * spec. Digit parsing matches the hex loop in `parseNumericEntity`.
       * The accumulated value is preserved for numeric validation callbacks.
       * @param input The string containing the entity (or a continuation of the entity).
       * @param offset The current offset.
       * @returns The number of characters that were consumed, or -1 if the entity is incomplete.
       */
      stateNumericHex(input, offset) {
        const inputLength = input.length;
        let { result } = this;
        let { consumed } = this;
        while (offset < inputLength) {
          const char = input.charCodeAt(offset);
          if (isNumber(char) || isHexadecimalCharacter(char)) {
            const digit = char <= CharCodes.NINE ? char - CharCodes.ZERO : (char | TO_LOWER_BIT) - CharCodes.LOWER_A + 10;
            result = result * 16 + digit;
            consumed += 1;
            offset += 1;
          } else {
            this.result = result;
            this.consumed = consumed;
            return this.emitNumericEntity(char, 3);
          }
        }
        this.result = result;
        this.consumed = consumed;
        return -1;
      }
      /**
       * Parses a decimal numeric entity.
       *
       * Equivalent to the `Decimal character reference state` in the HTML
       * spec. Digit parsing matches the decimal loop in `parseNumericEntity`.
       * The accumulated value is preserved for numeric validation callbacks.
       * @param input The string containing the entity (or a continuation of the entity).
       * @param offset The current offset.
       * @returns The number of characters that were consumed, or -1 if the entity is incomplete.
       */
      stateNumericDecimal(input, offset) {
        const inputLength = input.length;
        let { result } = this;
        let { consumed } = this;
        while (offset < inputLength) {
          const digit = input.charCodeAt(offset) - CharCodes.ZERO;
          if (digit >>> 0 > 9) {
            this.result = result;
            this.consumed = consumed;
            return this.emitNumericEntity(digit + CharCodes.ZERO, 2);
          }
          result = result * 10 + digit;
          consumed += 1;
          offset += 1;
        }
        this.result = result;
        this.consumed = consumed;
        return -1;
      }
      /**
       * Validate and emit a numeric entity.
       *
       * Implements the logic from the `Hexademical character reference start
       * state` and `Numeric character reference end state` in the HTML spec.
       * @param lastCp The last code point of the entity. Used to see if the
       *               entity was terminated with a semicolon.
       * @param expectedLength The minimum number of characters that should be
       *                       consumed. Used to validate that at least one digit
       *                       was consumed.
       * @returns The number of characters that were consumed.
       */
      emitNumericEntity(lastCp, expectedLength) {
        if (this.consumed <= expectedLength) {
          this.errors?.absenceOfDigitsInNumericCharacterReference(this.consumed);
          return 0;
        }
        if (lastCp === CharCodes.SEMI) {
          this.consumed += 1;
        } else if (this.decodeMode === DecodingMode.Strict) {
          return 0;
        }
        this.emitCodePoint((this.decodeTree === xmlDecodeTree ? replaceCodePointXML : replaceCodePoint)(this.result), this.consumed);
        if (this.errors) {
          if (lastCp !== CharCodes.SEMI) {
            this.errors.missingSemicolonAfterCharacterReference();
          }
          this.errors.validateNumericCharacterReference(this.result);
        }
        return this.consumed;
      }
      /**
       * Flush locally-tracked walk state back to the fields, then emit the
       * recorded legacy match or reject (cold path — at most once per
       * entity). Called after failed navigation (leaf node, branch miss, or
       * compact-run mismatch). In attribute mode, reject if no legacy was
       * recorded at the current node, if we descended past it, or if the
       * pending input character is an invalid attribute terminator.
       * @param consumed Locally-tracked consumed count.
       * @param excess Locally-tracked excess count.
       * @param char Pending input character (may be the mismatching char).
       * @param valueLength Value length at the current trie node.
       */
      flushAndEmitLegacyOrReject(consumed, excess, char, valueLength) {
        this.consumed = consumed;
        this.excess = excess;
        return this.result === 0 || this.decodeMode === DecodingMode.Attribute && (valueLength === 0 || excess > 1 || isEntityInAttributeInvalidEnd(char)) ? 0 : this.emitNotTerminatedNamedEntity();
      }
      /**
       * Parses a named entity.
       *
       * Equivalent to the `Named character reference state` in the HTML spec.
       * @param input The string containing the entity (or a continuation of the entity).
       * @param offset The current offset.
       * @returns The number of characters that were consumed, or -1 if the entity is incomplete.
       */
      stateNamedEntity(input, offset) {
        const { decodeTree } = this;
        const inputLength = input.length;
        const isStrict = this.decodeMode === DecodingMode.Strict;
        let { treeIndex } = this;
        let { excess } = this;
        let { consumed } = this;
        let current = decodeTree[treeIndex];
        while (offset < inputLength) {
          while ((current & (BinTrieFlags.VALUE_LENGTH | BinTrieFlags.FLAG13)) === 0 && (current & BinTrieFlags.JUMP_TABLE) !== 0) {
            const char2 = input.charCodeAt(offset);
            const jumpOffset = current & BinTrieFlags.JUMP_TABLE;
            const branchCount = (current & BinTrieFlags.BRANCH_LENGTH) >> 7;
            if (branchCount === 0) {
              if (char2 !== jumpOffset) {
                return this.flushAndEmitLegacyOrReject(consumed, excess, char2, 0);
              }
              treeIndex += 1;
            } else {
              const slot = char2 - jumpOffset;
              if (slot >>> 0 >= branchCount) {
                return this.flushAndEmitLegacyOrReject(consumed, excess, char2, 0);
              }
              const stored = decodeTree[treeIndex + 1 + slot];
              if (stored === 0) {
                return this.flushAndEmitLegacyOrReject(consumed, excess, char2, 0);
              }
              treeIndex = treeIndex + branchCount + stored & 65535;
            }
            current = decodeTree[treeIndex];
            offset += 1;
            excess += 1;
            if (offset >= inputLength)
              break;
          }
          if (offset >= inputLength)
            break;
          if ((current & (BinTrieFlags.VALUE_LENGTH | BinTrieFlags.FLAG13)) === BinTrieFlags.FLAG13) {
            const runLength = (current & BinTrieFlags.BRANCH_LENGTH) >> 7;
            let { runConsumed } = this;
            if (runConsumed === 0) {
              const char2 = input.charCodeAt(offset);
              if (char2 !== (current & BinTrieFlags.JUMP_TABLE)) {
                return this.flushAndEmitLegacyOrReject(consumed, excess, char2, 0);
              }
              offset += 1;
              excess += 1;
              runConsumed = 1;
            }
            while (runConsumed < runLength) {
              if (offset >= inputLength) {
                this.treeIndex = treeIndex;
                this.excess = excess;
                this.consumed = consumed;
                this.runConsumed = runConsumed;
                return -1;
              }
              const charIndexInPacked = runConsumed - 1;
              const packedWord = decodeTree[treeIndex + 1 + (charIndexInPacked >> 1)];
              const expectedChar = packedWord >> ((charIndexInPacked & 1) << 3) & 255;
              const char2 = input.charCodeAt(offset);
              if (char2 !== expectedChar) {
                this.runConsumed = 0;
                return this.flushAndEmitLegacyOrReject(consumed, excess, char2, 0);
              }
              offset += 1;
              excess += 1;
              runConsumed += 1;
            }
            this.runConsumed = 0;
            treeIndex += 1 + (runLength >> 1);
            current = decodeTree[treeIndex];
            continue;
          }
          const valueLength = current >>> 14;
          const char = input.charCodeAt(offset);
          if (valueLength !== 0) {
            if (!isStrict && (current & BinTrieFlags.FLAG13) === 0) {
              this.result = treeIndex;
              consumed += excess - 1;
              excess = 1;
            }
            if (char === CharCodes.SEMI) {
              return this.emitNamedEntityData(treeIndex, valueLength, consumed + excess);
            }
            if (valueLength === 1) {
              return this.flushAndEmitLegacyOrReject(consumed, excess, char, valueLength);
            }
          }
          const next = determineBranch(decodeTree, current, treeIndex + (valueLength || 1), char);
          if (next < 0) {
            return this.flushAndEmitLegacyOrReject(consumed, excess, char, valueLength);
          }
          treeIndex = next;
          current = decodeTree[treeIndex];
          offset += 1;
          excess += 1;
        }
        if (!isStrict && current >>> 14 !== 0 && (current & BinTrieFlags.FLAG13) === 0) {
          this.result = treeIndex;
          consumed += excess - 1;
          excess = 1;
        }
        this.treeIndex = treeIndex;
        this.excess = excess;
        this.consumed = consumed;
        return -1;
      }
      /**
       * Emit a named entity that was not terminated with a semicolon.
       * @returns The number of characters consumed.
       */
      emitNotTerminatedNamedEntity() {
        const { result, decodeTree } = this;
        const valueLength = decodeTree[result] >>> 14;
        this.emitNamedEntityData(result, valueLength, this.consumed);
        this.errors?.missingSemicolonAfterCharacterReference();
        return this.consumed;
      }
      /**
       * Emit a named entity.
       * @param result The index of the entity in the decode tree.
       * @param valueLength Encoded value length (header plus any value words).
       * @param consumed The number of characters consumed.
       * @returns The number of characters consumed.
       */
      emitNamedEntityData(result, valueLength, consumed) {
        const { decodeTree } = this;
        this.emitCodePoint(valueLength === 1 ? decodeTree[result] & BinTrieFlags.VALUE_MASK : decodeTree[result + 1], consumed);
        if (valueLength === 3) {
          this.emitCodePoint(decodeTree[result + 2], consumed);
        }
        return consumed;
      }
      /**
       * Signal to the parser that the end of the input was reached.
       *
       * Remaining data will be emitted and relevant errors will be produced.
       * @returns The number of characters consumed.
       */
      end() {
        switch (this.state) {
          case EntityDecoderState.NamedEntity: {
            return this.result !== 0 && (this.decodeMode !== DecodingMode.Attribute || this.result === this.treeIndex) ? this.emitNotTerminatedNamedEntity() : 0;
          }
          // Otherwise, emit a numeric entity if we have one.
          case EntityDecoderState.NumericDecimal: {
            return this.emitNumericEntity(0, 2);
          }
          case EntityDecoderState.NumericHex: {
            return this.emitNumericEntity(0, 3);
          }
          case EntityDecoderState.NumericStart: {
            this.errors?.absenceOfDigitsInNumericCharacterReference(this.consumed);
            return 0;
          }
          default: {
            return 0;
          }
        }
      }
    };
  }
});

// node_modules/entities/dist/escape.js
function getEscape(char) {
  return char === 34 ? "&quot;" : char === 38 ? "&amp;" : char === 39 ? "&apos;" : char === 60 ? "&lt;" : char === 62 ? "&gt;" : "&nbsp;";
}
function isXmlEscapable(code) {
  return code >= 128 || code >= 32 && code < 64 && (XML_BITSET_VALUE >>> code & 1) === 1;
}
function encodeXML(input) {
  const { length } = input;
  let out;
  let last = 0;
  let index = 0;
  while (index < length) {
    const char = input.charCodeAt(index);
    if (!isXmlEscapable(char)) {
      const bound = Math.min(index + 32, length);
      let next = index + 1;
      while (next < bound && !isXmlEscapable(input.charCodeAt(next))) {
        next++;
      }
      if (next < bound) {
        index = next;
        continue;
      }
      if (next >= length)
        break;
      xmlEncodeRegex.lastIndex = next;
      if (!xmlEncodeRegex.test(input))
        break;
      index = xmlEncodeRegex.lastIndex - 1;
      continue;
    }
    if (out === void 0)
      out = input.substring(0, index);
    else if (last !== index)
      out += input.substring(last, index);
    if (char < 64) {
      out += getEscape(char);
      last = index += 1;
      continue;
    }
    const cp = input.codePointAt(index);
    out += `&#x${cp.toString(16)};`;
    if (cp !== char)
      index++;
    last = index += 1;
  }
  if (out === void 0)
    return input;
  if (last < length)
    out += input.substr(last);
  return out;
}
function escapeWithRegex(re, data) {
  re.lastIndex = 0;
  if (!re.test(data))
    return data;
  let out = "";
  let last = 0;
  do {
    const index = re.lastIndex - 1;
    if (last !== index)
      out += data.substring(last, index);
    const char = data.charCodeAt(index);
    out += getEscape(char);
    last = index + 1;
  } while (re.test(data));
  return out + data.substring(last);
}
function escapeUTF8(data) {
  return escapeWithRegex(xmlEscapeRegex, data);
}
function escapeAttribute(data) {
  return escapeWithRegex(attributeEscapeRegex, data);
}
function escapeText(data) {
  return escapeWithRegex(textEscapeRegex, data);
}
var XML_BITSET_VALUE, xmlEncodeRegex, escape, xmlEscapeRegex, attributeEscapeRegex, textEscapeRegex;
var init_escape = __esm({
  "node_modules/entities/dist/escape.js"() {
    XML_BITSET_VALUE = 1342177476;
    xmlEncodeRegex = /["&'<>\u0080-\uFFFF]/g;
    escape = encodeXML;
    xmlEscapeRegex = /["&'<>]/g;
    attributeEscapeRegex = /["&\u{A0}]/gu;
    textEscapeRegex = /[&<>\u{A0}]/gu;
  }
});

// node_modules/entities/dist/generated/encode-html.js
var encode_html_default;
var init_encode_html = __esm({
  "node_modules/entities/dist/generated/encode-html.js"() {
    encode_html_default = "9Tab;NewLine;22excl;quot;num;dollar;percnt;amp;apos;lpar;rpar;ast;plus;comma;1period;sol;10colon;semi;lt;{8402nvlt;}equals;{8421bne;}gt;{8402nvgt;}quest;commat;26lbrack;bsol;rbrack;Hat;lowbar;DiacriticalGrave;5{106fjlig;}20lbrace;verbar;rbrace;34nbsp;iexcl;cent;pound;curren;yen;brvbar;sect;die;copy;ordf;laquo;not;shy;circledR;macr;deg;PlusMinus;sup2;sup3;acute;micro;para;centerdot;cedil;sup1;ordm;raquo;frac14;frac12;frac34;iquest;Agrave;Aacute;Acirc;Atilde;Auml;angst;AElig;Ccedil;Egrave;Eacute;Ecirc;Euml;Igrave;Iacute;Icirc;Iuml;ETH;Ntilde;Ograve;Oacute;Ocirc;Otilde;Ouml;times;Oslash;Ugrave;Uacute;Ucirc;Uuml;Yacute;THORN;szlig;agrave;aacute;acirc;atilde;auml;aring;aelig;ccedil;egrave;eacute;ecirc;euml;igrave;iacute;icirc;iuml;eth;ntilde;ograve;oacute;ocirc;otilde;ouml;div;oslash;ugrave;uacute;ucirc;uuml;yacute;thorn;yuml;Amacr;amacr;Abreve;abreve;Aogon;aogon;Cacute;cacute;Ccirc;ccirc;Cdot;cdot;Ccaron;ccaron;Dcaron;dcaron;Dstrok;dstrok;Emacr;emacr;2Edot;edot;Eogon;eogon;Ecaron;ecaron;Gcirc;gcirc;Gbreve;gbreve;Gdot;gdot;Gcedil;1Hcirc;hcirc;Hstrok;hstrok;Itilde;itilde;Imacr;imacr;2Iogon;iogon;Idot;imath;IJlig;ijlig;Jcirc;jcirc;Kcedil;kcedil;kgreen;Lacute;lacute;Lcedil;lcedil;Lcaron;lcaron;Lmidot;lmidot;Lstrok;lstrok;Nacute;nacute;Ncedil;ncedil;Ncaron;ncaron;napos;ENG;eng;Omacr;omacr;2Odblac;odblac;OElig;oelig;Racute;racute;Rcedil;rcedil;Rcaron;rcaron;Sacute;sacute;Scirc;scirc;Scedil;scedil;Scaron;scaron;Tcedil;tcedil;Tcaron;tcaron;Tstrok;tstrok;Utilde;utilde;Umacr;umacr;Ubreve;ubreve;Uring;uring;Udblac;udblac;Uogon;uogon;Wcirc;wcirc;Ycirc;ycirc;Yuml;Zacute;zacute;Zdot;zdot;Zcaron;zcaron;19fnof;34imped;63gacute;65jmath;142circ;caron;16breve;DiacriticalDot;ring;ogon;DiacriticalTilde;dblac;51DownBreve;127Alpha;Beta;Gamma;Delta;Epsilon;Zeta;Eta;Theta;Iota;Kappa;Lambda;Mu;Nu;Xi;Omicron;Pi;Rho;1Sigma;Tau;Upsilon;Phi;Chi;Psi;ohm;7alpha;beta;gamma;delta;epsi;zeta;eta;theta;iota;kappa;lambda;mu;nu;xi;omicron;pi;rho;sigmaf;sigma;tau;upsi;phi;chi;psi;omega;7thetasym;Upsi;2phiv;piv;5Gammad;digamma;18kappav;rhov;3epsiv;backepsilon;10IOcy;DJcy;GJcy;Jukcy;DScy;Iukcy;YIcy;Jsercy;LJcy;NJcy;TSHcy;KJcy;1Ubrcy;DZcy;Acy;Bcy;Vcy;Gcy;Dcy;IEcy;ZHcy;Zcy;Icy;Jcy;Kcy;Lcy;Mcy;Ncy;Ocy;Pcy;Rcy;Scy;Tcy;Ucy;Fcy;KHcy;TScy;CHcy;SHcy;SHCHcy;HARDcy;Ycy;SOFTcy;Ecy;YUcy;YAcy;acy;bcy;vcy;gcy;dcy;iecy;zhcy;zcy;icy;jcy;kcy;lcy;mcy;ncy;ocy;pcy;rcy;scy;tcy;ucy;fcy;khcy;tscy;chcy;shcy;shchcy;hardcy;ycy;softcy;ecy;yucy;yacy;1iocy;djcy;gjcy;jukcy;dscy;iukcy;yicy;jsercy;ljcy;njcy;tshcy;kjcy;1ubrcy;dzcy;7074ensp;emsp;emsp13;emsp14;1numsp;puncsp;ThinSpace;hairsp;NegativeMediumSpace;zwnj;zwj;lrm;rlm;dash;2ndash;mdash;horbar;Verbar;1lsquo;CloseCurlyQuote;lsquor;1ldquo;CloseCurlyDoubleQuote;bdquo;1dagger;Dagger;bull;2nldr;hellip;9permil;pertenk;prime;Prime;tprime;backprime;3lsaquo;rsaquo;3oline;2caret;1hybull;frasl;10bsemi;7qprime;7MediumSpace;{8202ThickSpace;}NoBreak;af;InvisibleTimes;ic;72euro;46tdot;DotDot;37complexes;2incare;4gscr;hamilt;Hfr;Hopf;planckh;hbar;imagline;Ifr;lagran;ell;1naturals;numero;copysr;weierp;Popf;Qopf;realine;real;reals;rx;3trade;1integers;2mho;zeetrf;iiota;2bernou;Cayleys;1escr;Escr;Fouriertrf;1Mellintrf;order;alefsym;beth;gimel;daleth;12CapitalDifferentialD;dd;ee;ii;10frac13;frac23;frac15;frac25;frac35;frac45;frac16;frac56;frac18;frac38;frac58;frac78;49larr;ShortUpArrow;rarr;darr;harr;updownarrow;nwarr;nearr;LowerRightArrow;LowerLeftArrow;nlarr;nrarr;1rarrw;{824nrarrw;}Larr;Uarr;Rarr;Darr;larrtl;rarrtl;LeftTeeArrow;mapstoup;map;DownTeeArrow;1hookleftarrow;hookrightarrow;larrlp;looparrowright;harrw;nharr;1lsh;rsh;ldsh;rdsh;1crarr;cularr;curarr;2circlearrowleft;circlearrowright;leftharpoonup;DownLeftVector;RightUpVector;LeftUpVector;rharu;DownRightVector;dharr;dharl;RightArrowLeftArrow;udarr;LeftArrowRightArrow;leftleftarrows;upuparrows;rightrightarrows;ddarr;leftrightharpoons;Equilibrium;nlArr;nhArr;nrArr;DoubleLeftArrow;DoubleUpArrow;DoubleRightArrow;dArr;DoubleLeftRightArrow;DoubleUpDownArrow;nwArr;neArr;seArr;swArr;lAarr;rAarr;1zigrarr;6larrb;rarrb;15DownArrowUpArrow;7loarr;roarr;hoarr;forall;comp;part;{824npart;}exist;nexist;empty;1Del;Element;NotElement;1ni;notni;2prod;coprod;sum;minus;MinusPlus;dotplus;1Backslash;lowast;compfn;1radic;2prop;infin;angrt;ang;{8402nang;}angmsd;angsph;mid;nmid;DoubleVerticalBar;NotDoubleVerticalBar;and;or;cap;{65024caps;}cup;{65024cups;}int;Int;iiint;conint;Conint;Cconint;cwint;ClockwiseContourIntegral;awconint;there4;becaus;ratio;Colon;dotminus;1mDDot;homtht;sim;{8402nvsim;}backsim;{817race;}ac;{819acE;}acd;VerticalTilde;NotTilde;eqsim;{824nesim;}sime;NotTildeEqual;cong;simne;ncong;ap;nap;ape;apid;{824napid;}backcong;asympeq;{8402nvap;}bump;{824nbump;}bumpe;{824nbumpe;}doteq;{824nedot;}doteqdot;efDot;erDot;Assign;ecolon;ecir;circeq;1wedgeq;veeeq;1triangleq;2equest;ne;Congruent;{8421bnequiv;}nequiv;1le;{8402nvle;}ge;{8402nvge;}lE;{824nlE;}gE;{824ngE;}lnE;{65024lvertneqq;}gnE;{65024gvertneqq;}ll;{824nLtv;7577nLt;}gg;{824nGtv;7577nGt;}between;NotCupCap;nless;ngt;nle;nge;lesssim;GreaterTilde;nlsim;ngsim;LessGreater;gl;NotLessGreater;NotGreaterLess;pr;sc;prcue;sccue;PrecedesTilde;scsim;{824NotSucceedsTilde;}NotPrecedes;NotSucceeds;sub;{8402NotSubset;}sup;{8402NotSuperset;}nsub;nsup;sube;supe;NotSubsetEqual;NotSupersetEqual;subne;{65024varsubsetneq;}supne;{65024varsupsetneq;}1cupdot;UnionPlus;sqsub;{824NotSquareSubset;}sqsup;{824NotSquareSuperset;}sqsube;sqsupe;sqcap;{65024sqcaps;}sqcup;{65024sqcups;}CirclePlus;CircleMinus;CircleTimes;osol;CircleDot;circledcirc;circledast;1circleddash;boxplus;boxminus;boxtimes;dotsquare;RightTee;dashv;DownTee;bot;1models;DoubleRightTee;Vdash;Vvdash;VDash;nvdash;nvDash;nVdash;nVDash;prurel;1LeftTriangle;RightTriangle;LeftTriangleEqual;{8402nvltrie;}RightTriangleEqual;{8402nvrtrie;}origof;imof;multimap;hercon;intcal;veebar;1barvee;angrtvb;lrtri;bigwedge;bigvee;bigcap;bigcup;diam;sdot;sstarf;divideontimes;bowtie;ltimes;rtimes;leftthreetimes;rightthreetimes;backsimeq;curlyvee;curlywedge;Sub;Sup;Cap;Cup;fork;epar;lessdot;gtdot;Ll;{824nLl;}Gg;{824nGg;}leg;{65024lesg;}gel;{65024gesl;}2cuepr;cuesc;NotPrecedesSlantEqual;NotSucceedsSlantEqual;NotSquareSubsetEqual;NotSquareSupersetEqual;2lnsim;gnsim;precnsim;scnsim;nltri;NotRightTriangle;nltrie;NotRightTriangleEqual;vellip;ctdot;utdot;dtdot;disin;isinsv;isins;isindot;{824notindot;}notinvc;notinvb;1isinE;{824notinE;}nisd;xnis;nis;notnivc;notnivb;6barwed;Barwed;1lceil;rceil;LeftFloor;rfloor;drcrop;dlcrop;urcrop;ulcrop;bnot;1profline;profsurf;1telrec;target;5ulcorn;urcorn;dlcorn;drcorn;2frown;smile;9cylcty;profalar;7topbot;6ovbar;1solbar;60angzarr;51lmoustache;rmoustache;2OverBracket;bbrk;bbrktbrk;37OverParenthesis;UnderParenthesis;OverBrace;UnderBrace;2trpezium;4elinters;59blank;164circledS;55boxh;1boxv;9boxdr;3boxdl;3boxur;3boxul;3boxvr;7boxvl;7boxhd;7boxhu;7boxvh;19boxH;boxV;boxdR;boxDr;boxDR;boxdL;boxDl;boxDL;boxuR;boxUr;boxUR;boxuL;boxUl;boxUL;boxvR;boxVr;boxVR;boxvL;boxVl;boxVL;boxHd;boxhD;boxHD;boxHu;boxhU;boxHU;boxvH;boxVh;boxVH;19uhblk;3lhblk;3block;8blk14;blk12;blk34;13square;8blacksquare;EmptyVerySmallSquare;1rect;marker;2fltns;1bigtriangleup;blacktriangle;triangle;2blacktriangleright;rtri;3bigtriangledown;blacktriangledown;dtri;2blacktriangleleft;ltri;6loz;cir;32tridot;2bigcirc;8ultri;urtri;lltri;EmptySmallSquare;FilledSmallSquare;8bigstar;star;7phone;49female;1male;29spades;2clubs;1hearts;diamondsuit;3sung;2flat;natural;sharp;163check;3cross;8malt;21sext;33VerticalSeparator;25lbbrk;rbbrk;84bsolhsub;suphsol;28LeftDoubleBracket;RightDoubleBracket;lang;rang;Lang;Rang;loang;roang;7longleftarrow;longrightarrow;longleftrightarrow;DoubleLongLeftArrow;DoubleLongRightArrow;DoubleLongLeftRightArrow;1longmapsto;2dzigrarr;258nvlArr;nvrArr;nvHarr;Map;6lbarr;bkarow;lBarr;dbkarow;drbkarow;DDotrahd;UpArrowBar;DownArrowBar;2Rarrtl;2latail;ratail;lAtail;rAtail;larrfs;rarrfs;larrbfs;rarrbfs;2nwarhk;nearhk;hksearow;hkswarow;nwnear;nesear;seswar;swnwar;8rarrc;{824nrarrc;}1cudarrr;ldca;rdca;cudarrl;larrpl;2curarrm;cularrp;7rarrpl;2harrcir;Uarrocir;lurdshar;ldrushar;2LeftRightVector;RightUpDownVector;DownLeftRightVector;LeftUpDownVector;LeftVectorBar;RightVectorBar;RightUpVectorBar;RightDownVectorBar;DownLeftVectorBar;DownRightVectorBar;LeftUpVectorBar;LeftDownVectorBar;LeftTeeVector;RightTeeVector;RightUpTeeVector;RightDownTeeVector;DownLeftTeeVector;DownRightTeeVector;LeftUpTeeVector;LeftDownTeeVector;lHar;uHar;rHar;dHar;luruhar;ldrdhar;ruluhar;rdldhar;lharul;llhard;rharul;lrhard;udhar;duhar;RoundImplies;erarr;simrarr;larrsim;rarrsim;rarrap;ltlarr;1gtrarr;subrarr;1suplarr;lfisht;rfisht;ufisht;dfisht;5lopar;ropar;4lbrke;rbrke;lbrkslu;rbrksld;lbrksld;rbrkslu;langd;rangd;lparlt;rpargt;gtlPar;ltrPar;3vzigzag;1vangrt;angrtvbd;6ange;range;dwangle;uwangle;angmsdaa;angmsdab;angmsdac;angmsdad;angmsdae;angmsdaf;angmsdag;angmsdah;bemptyv;demptyv;cemptyv;raemptyv;laemptyv;ohbar;omid;opar;1operp;1olcross;odsold;1olcir;ofcir;olt;ogt;cirscir;cirE;solb;bsolb;3boxbox;3trisb;rtriltri;LeftTriangleBar;{824NotLeftTriangleBar;}RightTriangleBar;{824NotRightTriangleBar;}11iinfin;infintie;nvinfin;4eparsl;smeparsl;eqvparsl;5blacklozenge;8RuleDelayed;1dsol;9bigodot;bigoplus;bigotimes;1biguplus;1bigsqcup;5iiiint;fpartint;2cirfnint;awint;rppolint;scpolint;npolint;pointint;quatint;intlarhk;10pluscir;plusacir;simplus;plusdu;plussim;plustwo;1mcomma;minusdu;2loplus;roplus;Cross;timesd;timesbar;1smashp;lotimes;rotimes;otimesas;Otimes;odiv;triplus;triminus;tritime;intprod;2amalg;capdot;1ncup;ncap;capand;cupor;cupcap;capcup;cupbrcap;capbrcup;cupcup;capcap;ccups;ccaps;2ccupssm;2And;Or;andand;oror;orslope;andslope;1andv;orv;andd;ord;1wedbar;6sdote;3simdot;2congdot;{824ncongdot;}easter;apacir;apE;{824napE;}eplus;pluse;Esim;Colone;Equal;1ddotseq;equivDD;ltcir;gtcir;ltquest;gtquest;leqslant;{824nleqslant;}geqslant;{824ngeqslant;}lesdot;gesdot;lesdoto;gesdoto;lesdotor;gesdotol;lap;gap;lne;gne;lnap;gnap;lEg;gEl;lsime;gsime;lsimg;gsiml;lgE;glE;lesges;gesles;els;egs;elsdot;egsdot;el;eg;2siml;simg;simlE;simgE;LessLess;{824NotNestedLessLess;}GreaterGreater;{824NotNestedGreaterGreater;}1glj;gla;ltcc;gtcc;lescc;gescc;smt;lat;smte;{65024smtes;}late;{65024lates;}bumpE;PrecedesEqual;{824NotPrecedesEqual;}sce;{824NotSucceedsEqual;}2prE;scE;precneqq;scnE;prap;scap;precnapprox;scnap;Pr;Sc;subdot;supdot;subplus;supplus;submult;supmult;subedot;supedot;subE;{824nsubE;}supE;{824nsupE;}subsim;supsim;2subnE;{65024varsubsetneqq;}supnE;{65024varsupsetneqq;}2csub;csup;csube;csupe;subsup;supsub;subsub;supsup;suphsub;supdsub;forkv;topfork;mlcp;8Dashv;1Vdashl;Barv;vBar;vBarv;1Vbar;Not;bNot;rnmid;cirmid;midcir;topcir;nhpar;parsim;9parsl;{8421nparsl;}53250fflig;filig;fllig;ffilig;ffllig;55703Ascr;1Cscr;Dscr;2Gscr;2Jscr;Kscr;2Nscr;Oscr;Pscr;Qscr;1Sscr;Tscr;Uscr;Vscr;Wscr;Xscr;Yscr;Zscr;ascr;bscr;cscr;dscr;1fscr;1hscr;iscr;jscr;kscr;lscr;mscr;nscr;1pscr;qscr;rscr;sscr;tscr;uscr;vscr;wscr;xscr;yscr;zscr;52Afr;Bfr;1Dfr;Efr;Ffr;Gfr;2Jfr;Kfr;Lfr;Mfr;Nfr;Ofr;Pfr;Qfr;1Sfr;Tfr;Ufr;Vfr;Wfr;Xfr;Yfr;1afr;bfr;cfr;dfr;efr;ffr;gfr;hfr;ifr;jfr;kfr;lfr;mfr;nfr;ofr;pfr;qfr;rfr;sfr;tfr;ufr;vfr;wfr;xfr;yfr;zfr;Aopf;Bopf;1Dopf;Eopf;Fopf;Gopf;1Iopf;Jopf;Kopf;Lopf;Mopf;1Oopf;3Sopf;Topf;Uopf;Vopf;Wopf;Xopf;Yopf;1aopf;bopf;copf;dopf;eopf;fopf;gopf;hopf;iopf;jopf;kopf;lopf;mopf;nopf;oopf;popf;qopf;ropf;sopf;topf;uopf;vopf;wopf;xopf;yopf;zopf;";
  }
});

// node_modules/entities/dist/encode.js
function encodeHTML(input) {
  return encodeHTMLTrieRe(HTML_BITSET, HTML_ENCODE_RE, input);
}
function encodeNonAsciiHTML(input) {
  return encodeHTMLTrieRe(XML_BITSET, xmlEncodeRegex, input);
}
function isEncodable(bitset, code) {
  return code >= 128 || (bitset[code >>> 5] >>> code & 1) === 1;
}
function encodeHTMLTrieRe(bitset, re, input) {
  const { length } = input;
  let out;
  let last = 0;
  let index = 0;
  let wasLongGap = false;
  while (index < length) {
    let char = input.charCodeAt(index);
    if (!isEncodable(bitset, char)) {
      const gapStart = index;
      let next = index + 1;
      let wasFound = false;
      if (!wasLongGap) {
        const bound = Math.min(index + INLINE_SCAN_WINDOW, length);
        while (next < bound && !isEncodable(bitset, char = input.charCodeAt(next))) {
          next++;
        }
        if (next < bound) {
          index = next;
          wasFound = true;
        } else if (next >= length) {
          break;
        }
      }
      if (!wasFound) {
        re.lastIndex = next;
        if (!re.test(input))
          break;
        index = re.lastIndex - 1;
        wasLongGap = !wasLongGap || index - gapStart >= LONG_GAP_THRESHOLD;
        char = input.charCodeAt(index);
      }
    }
    if (out == null)
      out = input.substring(0, index);
    else if (last !== index)
      out += input.substring(last, index);
    if (char < 128) {
      const node = asciiEntities[char];
      if (typeof node === "object" && node !== null) {
        if (index + 1 < length) {
          const value = node.next.get(input.charCodeAt(index + 1));
          if (value != null) {
            out += value;
            last = index += 2;
            continue;
          }
        }
        out += node.value ?? numericReference(char);
      } else {
        out += node ?? numericReference(char);
      }
    } else {
      let node = htmlTrie.get(char);
      if (typeof node === "object") {
        if (index + 1 < length) {
          const value = node.next.get(input.charCodeAt(index + 1));
          if (value != null) {
            out += value;
            last = index += 2;
            continue;
          }
        }
        node = node.value;
      }
      if (node == null) {
        const cp = input.codePointAt(index);
        out += numericReference(cp);
        if (cp !== char)
          index++;
      } else {
        out += node;
      }
    }
    last = index += 1;
  }
  if (out == null)
    return input;
  if (last < length)
    out += input.substr(last);
  return out;
}
var asciiEntities, htmlTrie, HTML_BITSET, XML_BITSET, HTML_ENCODE_RE, numericReference, INLINE_SCAN_WINDOW, LONG_GAP_THRESHOLD;
var init_encode = __esm({
  "node_modules/entities/dist/encode.js"() {
    init_escape();
    init_encode_html();
    asciiEntities = /* @__PURE__ */ Array.from({ length: 128 }, () => null);
    htmlTrie = (() => {
      const trie = /* @__PURE__ */ new Map();
      const data = encode_html_default;
      let cursor = 0;
      let lastKey = -1;
      function readGap() {
        let value = 0;
        let ch;
        while ((ch = data.charCodeAt(cursor)) >= 48 && ch <= 57) {
          value = value * 10 + ch - 48;
          cursor++;
        }
        return value;
      }
      function readEntity() {
        const semi = data.indexOf(";", cursor);
        const entity = `&${data.substring(cursor, semi)};`;
        cursor = semi + 1;
        return entity;
      }
      const astralEntries = [];
      while (cursor < data.length) {
        lastKey += readGap() + 1;
        const entityValue = data.charCodeAt(cursor) === 123 ? null : readEntity();
        if (data.charCodeAt(cursor) === 123) {
          cursor++;
          const next = /* @__PURE__ */ new Map();
          let childKey = -1;
          while (data.charCodeAt(cursor) !== 125) {
            childKey += readGap() + 1;
            next.set(childKey, readEntity());
          }
          const branch = { value: entityValue, next };
          trie.set(lastKey, branch);
          cursor++;
          if (lastKey < 128) {
            asciiEntities[lastKey] = branch;
          }
        } else if (lastKey < 128) {
          asciiEntities[lastKey] = entityValue;
        } else if (lastKey > 65535) {
          astralEntries.push([lastKey, entityValue]);
        } else {
          trie.set(lastKey, entityValue);
        }
      }
      let astralIndex = 0;
      while (astralIndex < astralEntries.length) {
        const hi = 55296 | astralEntries[astralIndex][0] - 65536 >> 10;
        const children = [];
        while (astralIndex < astralEntries.length && (55296 | astralEntries[astralIndex][0] - 65536 >> 10) === hi) {
          const lo = 56320 | astralEntries[astralIndex][0] - 65536 & 1023;
          children.push([lo, astralEntries[astralIndex][1]]);
          astralIndex++;
        }
        trie.set(hi, { value: null, next: new Map(children) });
      }
      return trie;
    })();
    HTML_BITSET = /* @__PURE__ */ new Uint32Array([
      5632,
      // 09 (\t), 0A (\n), 0C (\f)
      4227923966,
      // 21-2D (!-.), 2E (.), 2F (/), 3A-3F (:;<=>?)
      4160749569,
      // 40 (@), 5B-5F ([\]^_)
      939524097
      // 60 (`), 7B-7D ({|})
    ]);
    XML_BITSET = /* @__PURE__ */ new Uint32Array([0, XML_BITSET_VALUE, 0, 0]);
    HTML_ENCODE_RE = /[\t\n\f!-/:-@[-`{-}\u0080-\uFFFF]/g;
    numericReference = (cp) => `&#x${cp.toString(16)};`;
    INLINE_SCAN_WINDOW = 16;
    LONG_GAP_THRESHOLD = 8;
  }
});

// node_modules/entities/dist/index.js
var dist_exports = {};
__export(dist_exports, {
  DecodingMode: () => DecodingMode,
  EncodingMode: () => EncodingMode,
  EntityDecoder: () => EntityDecoder,
  EntityLevel: () => EntityLevel,
  decode: () => decode,
  decodeHTML: () => decodeHTML,
  decodeHTMLAttribute: () => decodeHTMLAttribute,
  decodeHTMLStrict: () => decodeHTMLStrict,
  decodeXML: () => decodeXML,
  decodeXMLStrict: () => decodeXML,
  encode: () => encode,
  encodeHTML: () => encodeHTML,
  encodeNonAsciiHTML: () => encodeNonAsciiHTML,
  encodeXML: () => encodeXML,
  escape: () => escape,
  escapeAttribute: () => escapeAttribute,
  escapeText: () => escapeText,
  escapeUTF8: () => escapeUTF8
});
function decode(input, options = EntityLevel.XML) {
  const level = typeof options === "number" ? options : options.level;
  if (level === EntityLevel.HTML) {
    const mode = typeof options === "object" ? options.mode : void 0;
    return decodeHTML(input, mode);
  }
  return decodeXML(input);
}
function encode(input, options = EntityLevel.XML) {
  const { mode = EncodingMode.Extensive, level = EntityLevel.XML } = typeof options === "number" ? { level: options } : options;
  switch (mode) {
    case EncodingMode.UTF8: {
      return escapeUTF8(input);
    }
    case EncodingMode.Attribute: {
      return escapeAttribute(input);
    }
    case EncodingMode.Text: {
      return escapeText(input);
    }
    case EncodingMode.ASCII: {
      return (level === EntityLevel.HTML ? encodeNonAsciiHTML : encodeXML)(input);
    }
    // biome-ignore lint/complexity/noUselessSwitchCase: we get an error for the switch not being exhaustive
    case EncodingMode.Extensive:
    default: {
      return (level === EntityLevel.HTML ? encodeHTML : encodeXML)(input);
    }
  }
}
var EntityLevel, EncodingMode;
var init_dist = __esm({
  "node_modules/entities/dist/index.js"() {
    init_decode();
    init_encode();
    init_escape();
    init_decode();
    init_encode();
    init_escape();
    (function(EntityLevel2) {
      EntityLevel2[EntityLevel2["XML"] = 0] = "XML";
      EntityLevel2[EntityLevel2["HTML"] = 1] = "HTML";
    })(EntityLevel || (EntityLevel = {}));
    (function(EncodingMode2) {
      EncodingMode2[EncodingMode2["UTF8"] = 0] = "UTF8";
      EncodingMode2[EncodingMode2["ASCII"] = 1] = "ASCII";
      EncodingMode2[EncodingMode2["Extensive"] = 2] = "Extensive";
      EncodingMode2[EncodingMode2["Attribute"] = 3] = "Attribute";
      EncodingMode2[EncodingMode2["Text"] = 4] = "Text";
    })(EncodingMode || (EncodingMode = {}));
  }
});

// entry.js
exports.cssTree = require_cjs();
exports.propertyData = require_properties();
exports.decodeHTMLAttribute = (init_dist(), __toCommonJS(dist_exports)).decodeHTMLAttribute;
exports.escapeAttribute = (init_dist(), __toCommonJS(dist_exports)).escapeAttribute;
