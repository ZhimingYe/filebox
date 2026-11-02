import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from './MarkdownContent';

function render(text: string) {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(<MarkdownContent text={text} />);
  return container;
}

describe('Markdown math compatibility', () => {
  it.each([
    '$x^2 + y_1$',
    String.raw`\(x^2 + y_1\)`,
    '$`x^2 + y_1`$',
    String.raw`\begin{math}x^2 + y_1\end{math}`,
  ])('renders inline notation: %s', source => {
    const result = render(`Before ${source} after.`);
    expect(result.querySelectorAll('.katex')).toHaveLength(1);
    expect(result.querySelector('.katex-display')).toBeNull();
    expect(result.querySelector('annotation')?.textContent).toBe('x^2 + y_1');
    expect(result.textContent).toContain('Before');
    expect(result.textContent).toContain('after.');
  });

  it.each([
    '$$x^2 + y_1$$',
    '$$\nx^2 + y_1\n$$',
    String.raw`\[x^2 + y_1\]`,
    String.raw`\[
x^2 + y_1
\]`,
    String.raw`\begin{displaymath}x^2 + y_1\end{displaymath}`,
    ...['math', 'latex', 'tex', 'katex', 'Math'].map(lang => `\`\`\`${lang}\nx^2 + y_1\n\`\`\``),
    '~~~math\nx^2 + y_1\n~~~',
  ])('renders display notation: %s', source => {
    const result = render(source);
    expect(result.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(result.querySelector('.katex-error')).toBeNull();
    expect(result.querySelector('annotation')?.textContent?.trim()).toBe('x^2 + y_1');
    expect(result.querySelector<HTMLElement>('.katex-display')?.style.overflowX).toBe('auto');
  });

  it.each([
    String.raw`\begin{equation}E=mc^2\end{equation}`,
    String.raw`\begin{equation*}E=mc^2\end{equation*}`,
    String.raw`\begin{align}a&=b+c\\d&=e\end{align}`,
    String.raw`\begin{align*}a&=b+c\\d&=e\end{align*}`,
    String.raw`\begin{gather}a=b\\c=d\end{gather}`,
    String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`,
    String.raw`\begin{alignat}{2}a&=b & c&=d\end{alignat}`,
    String.raw`$$\begin{pmatrix}a&b\\c&d\end{pmatrix}$$`,
    String.raw`$$f(x)=\begin{cases}x^2&x>0\\0&x\leq0\end{cases}$$`,
  ])('renders LaTeX environments: %s', source => {
    const result = render(source);
    expect(result.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(result.querySelector('.katex-error')).toBeNull();
  });

  it.each([
    String.raw`\begin{equation}
E=mc^2
\end{equation}`,
    String.raw`\begin{align}
a&=b+c\\
d&=e
\end{align}`,
  ])('renders multiline display environments: %s', source => {
    const result = render(source);
    expect(result.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(result.querySelector('.katex-error')).toBeNull();
    expect(result.querySelector('annotation')?.textContent).toBe(source);
  });

  it.each([
    {
      source: String.raw`> \[
> x^2 + y_1
> \]`,
      selector: 'blockquote',
    },
    {
      source: String.raw`- \[
  x^2 + y_1
  \]`,
      selector: 'li',
    },
  ])('excludes container prefixes from multiline display math', ({ source, selector }) => {
    const result = render(source);
    expect(result.querySelector(`${selector} .katex-display`)).not.toBeNull();
    expect(result.querySelector(`${selector} annotation`)?.textContent).toBe('x^2 + y_1');
  });

  it('keeps same-line prose in inline parsing after display notation', () => {
    const result = render(String.raw`\[x^2\] trailing prose`);
    expect(result.querySelector('p .katex-display')).not.toBeNull();
    expect(result.querySelector('p')?.textContent).toContain('trailing prose');
    expect(result.querySelector('annotation')?.textContent).toBe('x^2');
  });

  it('preserves formulas in headings, lists, quotes and GFM tables', () => {
    const result = render('# Title $x$\n\n- Item \\(y\\)\n\n> $$z$$\n\n| Formula |\n| --- |\n| $a_b$ |');
    for (const tag of ['h1', 'li', 'blockquote', 'td']) {
      expect(result.querySelector(`${tag} .katex`)).not.toBeNull();
    }
    expect(result.querySelectorAll('.katex')).toHaveLength(4);
  });

  it.each([
    '`$x$ \\(y\\)`',
    '```js\n$x$\n\\[y\\]\n```',
    '    $x$\n    \\(y\\)',
    String.raw`\$5 and \$10`,
    '$5 and $10; US$20; $ 30; $40 USD',
    String.raw`\\(x\\)`,
    'Unclosed $x and \\(y',
    '[price](https://example.com/$x$)',
  ])('does not reinterpret ordinary text/code: %s', source => {
    expect(render(source).querySelector('.katex')).toBeNull();
  });

  it('preserves TeX escapes, underscores and ampersands', () => {
    const source = String.raw`\frac{a_b}{c_d}+\text{cost: \$5}+\alpha`;
    expect(render(`$${source}$`).querySelector('annotation')?.textContent).toBe(source);
  });

  it('keeps malformed formulas readable without losing the rest of the document', () => {
    const result = render('Before \\[\\frac{\\] after.\n\n$x+1$');
    expect(result.querySelector('.katex-error')?.textContent).toBe('\\frac{');
    expect(result.textContent).toContain('after.');
    expect(result.querySelectorAll('.katex')).toHaveLength(1);
  });

  it('does not enable raw HTML or trusted TeX commands', () => {
    const result = render(String.raw`<script>alert(1)</script>

$\href{javascript:alert(1)}{click}$

$\includegraphics{https://example.com/image.png}$`);
    expect(result.querySelector('script, img, a')).toBeNull();
  });

  it('bounds recursive macro expansion and isolates macros to each formula', () => {
    const result = render(String.raw`$\def\loop{\loop}\loop$ then $x$ and $\gdef\foo{x}\foo$ then $\foo$`);
    expect(result.querySelector('.katex-error')).not.toBeNull();
    expect(result.textContent).toContain('then');
    expect(result.querySelectorAll('.katex')).toHaveLength(3);
  });

  it('bails out on nested openers and preserves following Markdown', () => {
    const source = String.raw`\[
outer
\[
inner
\]

# Following`;
    const result = render(source);
    expect(result.querySelector('h1')?.textContent).toBe('Following');
    expect(result.querySelectorAll('.katex')).toHaveLength(1);
    expect(result.querySelector('annotation')?.textContent).toBe('inner');
  });

  it.each([
    String.raw`\[
unclosed

# Following`,
    `\\[\n${'x'.repeat(32769)}\n\\]\n\n# Following`,
  ])('bounds malformed or unclosed display lookahead: %s', source => {
    const started = performance.now();
    const result = render(source);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(result.querySelector('h1')?.textContent).toBe('Following');
    expect(result.querySelector('.katex')).toBeNull();
  });
});
