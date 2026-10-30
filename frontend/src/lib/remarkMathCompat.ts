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
  }
}

const environments = [
  'math', 'displaymath', 'equation', 'equation*', 'align', 'align*',
  'alignat', 'alignat*', 'gather', 'gather*', 'aligned', 'gathered',
];
const delimiters = [
  { open: '$$', close: '$$', display: true },
  { open: '$', close: '$', display: false },
  { open: '\\(', close: '\\)', display: false },
  { open: '\\[', close: '\\]', display: true },
  ...environments.map(name => ({
    open: `\\begin{${name}}`, close: `\\end{${name}}`, display: name !== 'math',
  })),
];

function character(code: Code) {
  return code === null ? '' : code < -2 ? '\n' : code < 0 ? '\t' : String.fromCharCode(code);
}

const tokenizeDisplayMath: Tokenizer = function (effects, ok, nok) {
  let opening = '';
  let content = '';
  let valueOpen = false;

  const body: State = code => {
    if (code === null) return nok(code);
    const char = character(code);
    content += char;
    if (code < -2) {
      if (valueOpen) {
        effects.exit('fileboxMathValue');
        valueOpen = false;
      }
      effects.enter('lineEnding');
      effects.consume(code);
      effects.exit('lineEnding');
    } else {
      if (!valueOpen) {
        effects.enter('fileboxMathValue');
        valueOpen = true;
      }
      effects.consume(code);
    }
    const closeStart = content.length - 2;
    if (content.endsWith('\\]')) {
      let precedingBackslashes = 0;
      for (let index = closeStart - 1; index >= 0 && content[index] === '\\'; index--) {
        precedingBackslashes++;
      }
      if (precedingBackslashes % 2 === 0) {
        if (valueOpen) effects.exit('fileboxMathValue');
        return after;
      }
    }
    return body;
  };

  const after: State = code => {
    effects.exit('fileboxMath');
    return ok(code);
  };

  const open: State = code => {
    const next = opening + character(code);
    if (code === null || !'\\['.startsWith(next)) return nok(code);
    opening = next;
    effects.consume(code);
    if (opening === '\\[') {
      return body;
    }
    return open;
  };

  return code => {
    effects.enter('fileboxMath');
    return open(code);
  };
};

// Parse before Markdown escapes/emphasis, but never inside ordinary code or HTML.
const tokenizeMath: Tokenizer = function (effects, ok, nok) {
  let candidates = delimiters;
  let opening = '';
  let delimiter: typeof delimiters[number];
  let content = '';
  let slashes = 0;
  let closingEscaped = false;
  let length = 0;

  const body: State = code => {
    if (code === null || ++length > 32768) return nok(code);
    const char = character(code);
    if (delimiter.open === '$' && (!content && /\s/.test(char) || char === '\n')) return nok(code);
    if (char === delimiter.close[0]) closingEscaped = slashes % 2 === 1;
    content += char;
    slashes = char === '\\' ? slashes + 1 : 0;
    effects.consume(code);
    if (delimiter.open.startsWith('\\') && !closingEscaped && content.endsWith(delimiter.open)) return nok;
    if (!closingEscaped && content.endsWith(delimiter.close)) {
      const value = content.slice(0, -delimiter.close.length);
      if (!value.trim()) return nok;
      if (delimiter.open === '$' && /\s$/.test(value)) return nok;
      return after;
    }
    return body;
  };

  const after: State = code => {
    // Pandoc-style dollar rules avoid interpreting "$5 and $10" as math.
    if (delimiter.open === '$' && code !== null && code >= 48 && code <= 57) return nok(code);
    effects.exit('fileboxMath');
    return ok(code);
  };

  const open: State = code => {
    const next = opening + character(code);
    const matching = candidates.filter(item => item.open.startsWith(next));
    if (!matching.length || code === null) {
      const complete = candidates.find(item => item.open === opening);
      if (!complete) return nok(code);
      delimiter = complete;
      return body(code);
    }
    opening = next;
    candidates = matching;
    effects.consume(code);
    if (matching.length === 1 && matching[0].open === opening) {
      delimiter = matching[0];
      return body;
    }
    return open;
  };

  return code => {
    effects.enter('fileboxMath');
    return open(code);
  };
};

function unwrap(source: string) {
  const delimiter = delimiters.find(item => source.startsWith(item.open) && source.endsWith(item.close));
  if (!delimiter) return { value: source, display: true };
  let value = source.slice(delimiter.open.length, -delimiter.close.length);
  if (delimiter.open.startsWith('\\begin') && !['\\begin{math}', '\\begin{displaymath}'].includes(delimiter.open)) {
    value = source;
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
      const { value, display } = unwrap(this.sliceSerialize(token));
      this.enter({ type: 'inlineMath', value, data: mathData(value, display) }, token);
    },
  },
  exit: {
    fileboxMath(token) { this.exit(token); },
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
  extensions.push({ flow: math().flow, text: { 36: { tokenize: tokenizeMath }, 92: { tokenize: tokenizeMath } } });
  extensions.push({ flow: { 92: { tokenize: tokenizeDisplayMath, concrete: true } } });
  fromExtensions.push(mathFromMarkdown(), fromMarkdown);
  return convertMathCode;
};
