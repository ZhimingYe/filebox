import type { Root, RootContent } from 'mdast';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import { mathFromMarkdown } from 'mdast-util-math';
import { math } from 'micromark-extension-math';
import type { Code, State, Tokenizer } from 'micromark-util-types';
import type { Plugin } from 'unified';
import type {} from 'remark-parse';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    fileboxMath: 'fileboxMath';
    fileboxMathValue: 'fileboxMathValue';
    fileboxMathSpace: 'fileboxMathSpace';
  }
}

const environments = [
  'math', 'displaymath', 'equation', 'equation*', 'align', 'align*',
  'alignat', 'alignat*', 'gather', 'gather*', 'aligned', 'gathered',
];

interface Delimiter {
  open: string;
  close: string;
  display: boolean;
}

const delimiters: Delimiter[] = [
  { open: '$$', close: '$$', display: true },
  { open: '$', close: '$', display: false },
  { open: '\\(', close: '\\)', display: false },
  { open: '\\[', close: '\\]', display: true },
  ...environments.map(name => ({
    open: `\\begin{${name}}`, close: `\\end{${name}}`, display: name !== 'math',
  })),
];
// Multiline forms need the block parser; inline forms stay in the text parser.
const flowDelimiters = delimiters.filter(item => item.display && item.open.startsWith('\\'));
// A formula longer than this is almost certainly unclosed punctuation.
const limit = 32768;

function character(code: Code) {
  return code === null ? '' : code < -2 ? '\n' : code < 0 ? '\t' : String.fromCharCode(code);
}

function lineEnding(code: Code) {
  return code !== null && code < -2;
}

function space(code: Code) {
  return code === -2 || code === -1 || code === 32;
}

/**
 * Shared delimiter scanner. The text variant stops right after the closing
 * delimiter so surrounding prose keeps its own inline parsing; the flow variant
 * additionally requires the line to end there, and bails out of lazy
 * continuation lines. Both bound their lookahead and give up when the opening
 * delimiter reappears, so an unclosed opener cannot scan the whole document.
 */
function createTokenizer(candidates: Delimiter[], flow: boolean): Tokenizer {
  return function (effects, ok, nok) {
    let matching = candidates;
    let opening = '';
    let delimiter: Delimiter;
    let content = '';
    let slashes = 0;
    let closingEscaped = false;
    let length = 0;
    let valueOpen = false;

    // Value tokens carry the formula source without container prefixes, so the
    // mdast value can be buffered from them instead of the raw token slice.
    function enterValue() {
      if (!valueOpen) {
        effects.enter('fileboxMathValue');
        valueOpen = true;
      }
    }

    function exitValue() {
      if (valueOpen) {
        effects.exit('fileboxMathValue');
        valueOpen = false;
      }
    }

    const body: State = code => {
      if (code === null || ++length > limit) return nok(code);
      const char = character(code);
      if (delimiter.open === '$' && (!content && /\s/.test(char) || char === '\n')) return nok(code);
      if (char === delimiter.close[0]) closingEscaped = slashes % 2 === 1;
      content += char;
      slashes = char === '\\' ? slashes + 1 : 0;
      if (lineEnding(code)) {
        if (!flow && !content.trim()) return nok(code);
        exitValue();
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
        if (flow && this.parser.lazy[this.now().line]) return nok(code);
      } else {
        enterValue();
        effects.consume(code);
      }
      if (delimiter.open !== delimiter.close && !closingEscaped && content.endsWith(delimiter.open)) return nok(code);
      if (!closingEscaped && content.endsWith(delimiter.close)) {
        const value = content.slice(0, -delimiter.close.length);
        if (!value.trim()) return nok(code);
        if (delimiter.open === '$' && /\s$/.test(value)) return nok(code);
        exitValue();
        return after;
      }
      return body;
    };

    const after: State = code => {
      if (flow) {
        // Trailing prose belongs to inline parsing, not to a block formula.
        if (space(code)) {
          effects.enter('fileboxMathSpace');
          effects.consume(code);
          effects.exit('fileboxMathSpace');
          return after;
        }
        if (code !== null && !lineEnding(code)) return nok(code);
      } else if (delimiter.open === '$' && code !== null && code >= 48 && code <= 57) {
        // Pandoc-style dollar rules avoid interpreting "$5 and $10" as math.
        return nok(code);
      }
      effects.exit('fileboxMath');
      return ok(code);
    };

    const open: State = code => {
      const next = opening + character(code);
      const candidate = matching.filter(item => item.open.startsWith(next));
      if (!candidate.length || code === null) {
        const complete = matching.find(item => item.open === opening);
        if (!complete) return nok(code);
        delimiter = complete;
        return body(code);
      }
      opening = next;
      matching = candidate;
      enterValue();
      effects.consume(code);
      if (candidate.length === 1 && candidate[0].open === opening) {
        delimiter = candidate[0];
        return body;
      }
      return open;
    };

    // Parse before Markdown escapes/emphasis, but never inside ordinary code or HTML.
    return code => {
      effects.enter('fileboxMath');
      return open(code);
    };
  };
}

const tokenizeMathText = createTokenizer(delimiters, false);
const tokenizeMathFlow = createTokenizer(flowDelimiters, true);

function unwrap(source: string) {
  const delimiter = delimiters.find(item => source.startsWith(item.open) && source.endsWith(item.close));
  if (!delimiter) return { value: source, display: true };
  let value = source.slice(delimiter.open.length, -delimiter.close.length);
  if (delimiter.open.startsWith('\\begin') && !['\\begin{math}', '\\begin{displaymath}'].includes(delimiter.open)) {
    value = source;
  }
  if (delimiter.display && !delimiter.open.startsWith('\\begin')) {
    value = value.replace(/^(?:\r\n|\r|\n)/, '').replace(/(?:\r\n|\r|\n)$/, '');
  }
  // GitHub's $`...`$ syntax protects Markdown punctuation inside inline math.
  if (delimiter.open === '$' && value.startsWith('`') && value.endsWith('`')) value = value.slice(1, -1);
  return { value, display: delimiter.display };
}

function mathData(value: string, display: boolean) {
  return {
    hName: 'code',
    hProperties: { className: [display ? 'math-display' : 'math-inline'] },
    hChildren: [{ type: 'text' as const, value }],
  };
}

const fromMarkdown: FromMarkdownExtension = {
  enter: {
    fileboxMath(token) {
      this.enter({ type: 'inlineMath', value: '', data: mathData('', false) }, token);
      this.buffer();
    },
  },
  exit: {
    fileboxMath(token) {
      const source = this.resume();
      const node = this.stack[this.stack.length - 1];
      this.exit(token);
      if (node.type !== 'inlineMath') return;
      const { value, display } = unwrap(source);
      node.value = value;
      node.data = mathData(value, display);
    },
    fileboxMathValue(token) {
      this.config.enter.data.call(this, token);
      this.config.exit.data.call(this, token);
    },
  },
};

function convertMathCode(node: Root | RootContent) {
  if (node.type === 'code' && /^(math|latex|tex|katex)$/i.test(node.lang ?? '')) {
    const { value } = unwrap(node.value.trim());
    node.data = mathData(value, true);
  }
  if ('children' in node) node.children.forEach(convertMathCode);
}

export const remarkMathCompat: Plugin<[], Root> = function () {
  const data = this.data();
  const extensions = data.micromarkExtensions ?? (data.micromarkExtensions = []);
  const fromExtensions = data.fromMarkdownExtensions ?? (data.fromMarkdownExtensions = []);
  // Keep the standard block parser (including nested lists/quotes), with our
  // inline parser handling alternate delimiters and conservative dollar rules.
  extensions.push({ flow: math().flow, text: { 36: { tokenize: tokenizeMathText }, 92: { tokenize: tokenizeMathText } } });
  extensions.push({ flow: { 92: { tokenize: tokenizeMathFlow, concrete: true } } });
  fromExtensions.push(mathFromMarkdown(), fromMarkdown);
  return convertMathCode;
};
