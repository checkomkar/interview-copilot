import { memo, useMemo } from 'react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import { MermaidDiagram } from './MermaidDiagram'

const rehypePlugins = [[rehypeHighlight, { detect: true }]] as Parameters<typeof ReactMarkdown>[0]['rehypePlugins']

interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

function hastText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(hastText).join('')
}

/** The code of a ```mermaid fenced block, or null for any other block. */
function mermaidCode(pre: HastNode | undefined): string | null {
  const code = pre?.children?.find((c) => c.type === 'element' && c.tagName === 'code')
  const cls = code?.properties?.className
  const classes = Array.isArray(cls) ? cls.map(String) : typeof cls === 'string' ? cls.split(' ') : []
  return code && classes.includes('language-mermaid') ? hastText(code).trim() : null
}

/**
 * Streamed answer Markdown with syntax-highlighted code blocks (FR-G4) and ```mermaid blocks
 * drawn as diagrams (FR-G12). `streaming`: the answer is still arriving.
 */
export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  // Stable per `streaming`, so a diagram isn't remounted on every streamed token.
  const components = useMemo<Components>(
    () => ({
      // Answers never navigate the overlay; show links as plain text.
      a: ({ children }) => <span className="underline">{children}</span>,
      pre: ({ node, children }) => {
        const code = mermaidCode(node as HastNode | undefined)
        return code !== null ? <MermaidDiagram code={code} streaming={streaming} /> : <pre>{children}</pre>
      }
    }),
    [streaming]
  )
  return (
    <div className="md">
      <ReactMarkdown rehypePlugins={rehypePlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
