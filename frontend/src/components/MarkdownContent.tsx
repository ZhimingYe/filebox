import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { remarkMathCompat } from '../lib/remarkMathCompat';
import { c } from '../theme';
import { styles } from './previewShared';

export function MarkdownContent({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMathCompat]}
      rehypePlugins={[[rehypeKatex, { trust: false, maxExpand: 1000, maxSize: 20, errorColor: c.danger }]]}
      components={{
        table: props => <div style={styles.tableWrap}><table>{props.children}</table></div>,
        span: ({ node, ...props }) => (
          <span {...props} style={node?.properties.className instanceof Array && node.properties.className.includes('katex-display')
            ? { ...props.style, display: 'block', overflowX: 'auto', overflowY: 'hidden', maxWidth: '100%', padding: '2px 0' }
            : props.style} />
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
