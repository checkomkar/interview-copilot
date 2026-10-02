interface Props {
  title: string
  phase: number
  text: string
}

export function ComingSoon({ title, phase, text }: Props) {
  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-2 max-w-md text-sm text-muted">{text}</p>
      <p className="mt-4 inline-block rounded-md border border-line px-2.5 py-1 text-xs text-muted">Arrives in Phase {phase}</p>
    </div>
  )
}
