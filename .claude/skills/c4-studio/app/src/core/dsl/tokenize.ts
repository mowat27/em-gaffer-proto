// Line-oriented tokeniser for Structurizr DSL.
// One pass over the text, no regular expressions. Produces one Line per logical statement line
// (physical lines joined by a trailing backslash form one logical line).

export type TokKind = 'word' | 'str' | 'arrow' | 'eq' | 'lbrace' | 'rbrace';

export interface Tok {
  k: TokKind;
  /** Word text, or unescaped string content */
  v: string;
  /** 1-based physical line the token starts on */
  ln: number;
  /** 0-based column of the token start on that line */
  col: number;
  /** 0-based column just after the token on its last line */
  end: number;
}

export interface Line {
  /** First physical line (1-based) */
  no: number;
  /** Last physical line (1-based) */
  endNo: number;
  toks: Tok[];
  /** Column of a trailing `//` or `#` comment on the last physical line, or -1 */
  commentCol: number;
}

export interface TokenizeError {
  line: number;
  column: number;
  message: string;
}

export interface Tokenized {
  lines: Line[];
  /** Number of physical lines in the text */
  lineCount: number;
  /** content[n] === 1 when physical line n (1-based) carries at least one token */
  content: Uint8Array;
  error?: TokenizeError;
}

export function tokenize(text: string): Tokenized {
  const n = text.length;
  let lineCount = 1;
  for (let p = text.indexOf('\n'); p !== -1; p = text.indexOf('\n', p + 1)) lineCount++;
  const content = new Uint8Array(lineCount + 2);
  const lines: Line[] = [];

  let i = 0;
  let lineNo = 1;
  let lineStart = 0;
  let toks: Tok[] = [];
  let startNo = 1;
  let commentCol = -1;
  let continuing = false;

  const flush = (): void => {
    if (toks.length > 0) {
      lines.push({ no: startNo, endNo: lineNo, toks, commentCol });
      for (let l = startNo; l <= lineNo; l++) content[l] = 1;
    }
    toks = [];
    commentCol = -1;
  };

  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      if (!continuing) flush();
      continuing = false;
      lineNo++;
      i++;
      lineStart = i;
      continue;
    }
    if (c === 32 || c === 9 || c === 13) {
      i++;
      continue;
    }
    // token start
    const col = i - lineStart;
    if (c === 47 /* / */ && text.charCodeAt(i + 1) === 47) {
      // line comment
      commentCol = col;
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === 35 /* # */) {
      commentCol = col;
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === 47 && text.charCodeAt(i + 1) === 42 /* /* */) {
      const close = text.indexOf('*/', i + 2);
      const stop = close === -1 ? n : close + 2;
      if (close === -1) {
        return { lines, lineCount, content, error: { line: lineNo, column: col, message: 'Unterminated block comment' } };
      }
      for (let p = text.indexOf('\n', i); p !== -1 && p < stop; p = text.indexOf('\n', p + 1)) {
        lineNo++;
        lineStart = p + 1;
      }
      i = stop;
      continue;
    }
    if (toks.length === 0) startNo = lineNo;
    if (c === 123 /* { */) {
      toks.push({ k: 'lbrace', v: '{', ln: lineNo, col, end: col + 1 });
      i++;
      continue;
    }
    if (c === 125 /* } */) {
      toks.push({ k: 'rbrace', v: '}', ln: lineNo, col, end: col + 1 });
      i++;
      continue;
    }
    if (c === 34 /* " */) {
      const startLn = lineNo;
      if (text.charCodeAt(i + 1) === 34 && text.charCodeAt(i + 2) === 34) {
        // text block """ ... """
        const close = text.indexOf('"""', i + 3);
        if (close === -1) {
          return { lines, lineCount, content, error: { line: lineNo, column: col, message: 'Unterminated text block' } };
        }
        const raw = text.slice(i + 3, close);
        let endCol = 0;
        for (let p = text.indexOf('\n', i); p !== -1 && p < close; p = text.indexOf('\n', p + 1)) {
          lineNo++;
          lineStart = p + 1;
        }
        endCol = close + 3 - lineStart;
        toks.push({ k: 'str', v: raw.trim(), ln: startLn, col, end: endCol });
        i = close + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      let segStart = j;
      let closed = false;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === 34) {
          closed = true;
          break;
        }
        if (d === 10) break;
        if (d === 92 /* \ */ && text.charCodeAt(j + 1) === 34) {
          out += text.slice(segStart, j) + '"';
          j += 2;
          segStart = j;
          continue;
        }
        j++;
      }
      if (!closed) {
        return { lines, lineCount, content, error: { line: lineNo, column: col, message: 'Unterminated string' } };
      }
      out += text.slice(segStart, j);
      toks.push({ k: 'str', v: out, ln: lineNo, col, end: j + 1 - lineStart });
      i = j + 1;
      continue;
    }
    // bare word
    let j = i;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (d === 32 || d === 9 || d === 13 || d === 10 || d === 34 || d === 123 || d === 125) break;
      j++;
    }
    let word = text.slice(i, j);
    // trailing backslash before the end of the line continues the statement
    if (word.charCodeAt(word.length - 1) === 92) {
      let q = j;
      while (q < n && (text.charCodeAt(q) === 32 || text.charCodeAt(q) === 9 || text.charCodeAt(q) === 13)) q++;
      if (q >= n || text.charCodeAt(q) === 10) {
        continuing = true;
        word = word.slice(0, -1);
        if (word.length === 0) {
          i = j;
          continue;
        }
      }
    }
    const endCol = i + word.length - lineStart;
    if (word === '->') toks.push({ k: 'arrow', v: word, ln: lineNo, col, end: endCol });
    else if (word === '=') toks.push({ k: 'eq', v: word, ln: lineNo, col, end: endCol });
    else toks.push({ k: 'word', v: word, ln: lineNo, col, end: endCol });
    i = j;
  }
  flush();
  return { lines, lineCount, content };
}
