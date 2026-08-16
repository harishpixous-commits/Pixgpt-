// Ships with this lazily-loaded module rather than the entry bundle: only a
// conversation containing maths ever needs KaTeX's stylesheet.
import 'katex/dist/katex.min.css'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import markdownLang from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Check, Copy } from 'lucide-react'
import { useToast } from '../ui/toast-context'
import { copyToClipboard } from '../../lib/utils'
import { useState } from 'react'

SyntaxHighlighter.registerLanguage('tsx', tsx)
SyntaxHighlighter.registerLanguage('typescript', typescript)
SyntaxHighlighter.registerLanguage('ts', typescript)
SyntaxHighlighter.registerLanguage('jsx', jsx)
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('js', javascript)
SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('py', python)
SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('shell', bash)
SyntaxHighlighter.registerLanguage('sh', bash)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('css', css)
SyntaxHighlighter.registerLanguage('html', markup)
SyntaxHighlighter.registerLanguage('xml', markup)
SyntaxHighlighter.registerLanguage('sql', sql)
SyntaxHighlighter.registerLanguage('markdown', markdownLang)
SyntaxHighlighter.registerLanguage('md', markdownLang)

/** react-markdown passes a `node` prop that React must not see on a DOM element. */
function withoutNode<T extends { node?: unknown }>(props: T): Omit<T, 'node'> {
  const copy = { ...props }
  delete copy.node
  return copy
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const { push } = useToast()
  const [copied, setCopied] = useState(false)

  const onCopy = async () => {
    const ok = await copyToClipboard(code)
    if (ok) {
      setCopied(true)
      push({ title: 'Code copied to clipboard', tone: 'success' })
      setTimeout(() => setCopied(false), 1600)
    }
  }

  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-block-lang">{language}</span>
        <button type="button" className="code-block-copy" onClick={onCopy} aria-label="Copy code">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {/*
        Scrollable regions need keyboard access (WCAG 2.1.1) — without a tab
        stop, a keyboard-only user cannot scroll a wide code sample sideways.
      */}
      <div className="code-block-scroll" tabIndex={0} role="group" aria-label={`${language} code sample`}>
        <SyntaxHighlighter
          language={language}
          style={oneDark}
          PreTag="div"
          // `overflow: visible` hands scrolling to the focusable wrapper above;
          // the theme would otherwise make this inner div the scroller, leaving
          // it unreachable by keyboard.
          customStyle={{
            margin: 0,
            padding: '12px 14px',
            background: 'transparent',
            fontSize: 13,
            lineHeight: 1.6,
            overflow: 'visible',
          }}
          codeTagProps={{ style: { fontFamily: 'var(--font-mono)' } }}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  )
}

export function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a: (props) => (
            <a href={props.href} target="_blank" rel="noreferrer noopener">
              {props.children}
            </a>
          ),
          // Wide tables scroll too, so they need the same keyboard affordance
          table: (props) => (
            <div className="table-scroll" tabIndex={0} role="group" aria-label="Table">
              <table>{props.children}</table>
            </div>
          ),
          // CodeBlock supplies its own container; a <div> inside <pre> is
          // invalid nesting, so drop the wrapper react-markdown adds.
          pre: (props) => <>{props.children}</>,
          // Display maths scrolls horizontally when it overflows, so it needs a
          // tab stop like the other scrollable regions. Every other prop is
          // passed through untouched — KaTeX lays itself out with inline styles.
          span: (props) => {
            const rest = withoutNode(props)
            return props.className?.includes('katex-display') ? (
              <span {...rest} tabIndex={0} role="group" aria-label="Mathematical formula" />
            ) : (
              <span {...rest} />
            )
          },
          code: (props) => {
            const { className, children } = props
            const match = /language-(\w+)/.exec(className ?? '')
            if (match) {
              return <CodeBlock language={match[1]} code={String(children).replace(/\n$/, '')} />
            }
            return <code className="inline-code">{children}</code>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
