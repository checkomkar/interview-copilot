import { useEffect, useRef, useState } from 'react'

type MermaidApi = typeof import('mermaid').default

/** Loaded on first use: Mermaid is large and most answers have no diagram. */
let loading: Promise<MermaidApi> | null = null
let configuredTheme: string | null = null
let nextId = 0

function loadMermaid(): Promise<MermaidApi> {
  loading ??= import('mermaid').then((m) => m.default)
  return loading
}

async function renderSvg(code: string, theme: 'dark' | 'default'): Promise<string> {
  const mermaid = await loadMermaid()
  if (configuredTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      // Strict: no click handlers or HTML labels; output is sanitized.
      securityLevel: 'strict',
      theme,
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      flowchart: { htmlLabels: false },
      sequence: { useMaxWidth: true }
    })
    configuredTheme = theme
  }
  nextId += 1
  const id = `cue-mermaid-${nextId}`
  try {
    const { svg } = await mermaid.render(id, code)
    return svg
  } finally {
    // Mermaid can leave its scratch element behind when the code is invalid.
    document.getElementById(`d${id}`)?.remove()
  }
}

/**
 * A ```mermaid block drawn as a diagram (system design, sequence flows). While the answer is
 * still streaming the code is incomplete, so a placeholder shows; if the model's Mermaid is
 * invalid, the code is shown instead so it can still be read.
 */
export function MermaidDiagram({ code, streaming }: { code: string; streaming?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [showCode, setShowCode] = useState(false)

  useEffect(() => {
    if (streaming) return
    let cancelled = false
    const light = ref.current?.closest("[data-theme='light']") !== null
    renderSvg(code, light ? 'default' : 'dark').then(
      (out) => {
        if (cancelled) return
        setSvg(out)
        setFailed(false)
      },
      () => {
        if (!cancelled) setFailed(true)
      }
    )
    return () => {
      cancelled = true
    }
  }, [code, streaming])

  if (streaming && !svg) {
    return (
      <div ref={ref} className="md-diagram md-diagram-pending">
        Drawing diagram…
      </div>
    )
  }
  if (failed || showCode) {
    return (
      <div ref={ref} className="md-diagram-code">
        <pre>
          <code>{code}</code>
        </pre>
        {failed ? (
          <span className="md-diagram-note">Couldn't draw this diagram; Mermaid code shown.</span>
        ) : (
          <button className="md-diagram-toggle" onClick={() => setShowCode(false)}>
            Show diagram
          </button>
        )}
      </div>
    )
  }
  return (
    <div ref={ref} className="md-diagram">
      {svg ? <div className="md-diagram-svg" dangerouslySetInnerHTML={{ __html: svg }} /> : <span className="md-diagram-pending">Drawing diagram…</span>}
      {svg && (
        <button className="md-diagram-toggle" onClick={() => setShowCode(true)}>
          Code
        </button>
      )}
    </div>
  )
}
