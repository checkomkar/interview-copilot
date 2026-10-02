import type { NavigateTarget } from '@shared/ipc'
import { useApp } from './store'
import { SessionTab } from './tabs/SessionTab'
import { SettingsTab } from './tabs/SettingsTab'
import { ProfileTab } from './tabs/ProfileTab'
import { ComingSoon } from './tabs/ComingSoon'
import { StatusPill } from './components/StatusPill'

const TABS: { id: NavigateTarget; label: string; icon: string }[] = [
  { id: 'session', label: 'Session', icon: '●' },
  { id: 'profile', label: 'Profile', icon: '◐' },
  { id: 'history', label: 'History', icon: '☰' },
  { id: 'practice', label: 'Practice', icon: '◆' },
  { id: 'settings', label: 'Settings', icon: '⚙' }
]

export function App() {
  const tab = useApp((s) => s.tab)
  const setTab = useApp((s) => s.setTab)
  const banner = useApp((s) => s.banner)
  const setBanner = useApp((s) => s.setBanner)

  return (
    <div className="flex h-full">
      <nav className="flex w-52 shrink-0 flex-col border-r border-line bg-panel">
        <div className="px-5 pt-5 pb-6">
          <div className="text-[15px] font-semibold tracking-tight">Interview Copilot</div>
          <div className="mt-2">
            <StatusPill />
          </div>
        </div>
        <ul className="flex flex-col gap-0.5 px-2">
          {TABS.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => setTab(t.id)}
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  tab === t.id ? 'bg-raised text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg'
                }`}
              >
                <span className="w-4 text-center text-xs opacity-70">{t.icon}</span>
                {t.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-auto px-5 py-4 text-xs text-muted">v0.2 · Phase 2</div>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col">
        {banner && (
          <div className="flex items-center gap-3 border-b border-bad/30 bg-bad/10 px-6 py-2.5 text-sm text-bad">
            <span className="flex-1">{banner}</span>
            <button className="text-bad/70 hover:text-bad" onClick={() => setBanner(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {tab === 'session' && <SessionTab />}
          {tab === 'settings' && <SettingsTab />}
          {tab === 'profile' && <ProfileTab />}
          {tab === 'history' && <ComingSoon title="History" phase={3} text="Review past sessions, transcripts and answers, and export them as Markdown." />}
          {tab === 'practice' && <ComingSoon title="Practice" phase={4} text="Mock interviews with spoken questions and feedback on your answers." />}
        </div>
      </main>
    </div>
  )
}
