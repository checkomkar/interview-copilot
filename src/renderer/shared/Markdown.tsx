import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'

const rehypePlugins = [[rehypeHighlight, { detect: true }]] as Parameters<typeof ReactMarkdown>[0]['rehypePlugins']

/** Streamed answer Markdown with syntax-highlighted code blocks (FR-G4). */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        rehypePlugins={rehypePlugins}
        components={{
          // Answers never navigate the overlay; show links as plain text.
          a: ({ children }) => <span className="underline">{children}</span>
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
