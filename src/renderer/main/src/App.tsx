import { useEffect, useState } from 'react'
import type { NavigateTarget } from '@shared/ipc'
import { useApp } from './store'
import { keys } from '../../shared/keys'
import { SessionTab } from './tabs/SessionTab'
import { SettingsTab } from './tabs/SettingsTab'
import { ProfileTab } from './tabs/ProfileTab'
import { HistoryTab } from './tabs/HistoryTab'
import { PracticeTab } from './tabs/PracticeTab'
import { ProjectsTab } from './tabs/ProjectsTab'
import { StatusPill } from './components/StatusPill'

const TABS: { id: NavigateTarget; label: string; icon: string }[] = [
  { id: 'session', label: 'Session', icon: '●' },
  { id: 'profile', label: 'Profile', icon: '◐' },
  { id: 'projects', label: 'Projects', icon: '▤' },
  { id: 'history', label: 'History', icon: '☰' },
  { id: 'practice', label: 'Practice', icon: '◆' },
  { id: 'settings', label: 'Settings', icon: '⚙' }
]

export function App() {
  const tab = useApp((s) => s.tab)
  const setTab = useApp((s) => s.setTab)
  const banner = useApp((s) => s.banner)
  const pendingUpdates = useApp((s) => s.pendingUpdates)
  const setBanner = useApp((s) => s.setBanner)
  const [version, setVersion] = useState('')
  useEffect(() => {
    void window.api.app.info().then((i) => setVersion(i.version))
  }, [])

  return (
    <div className="flex h-full">
      <nav className="flex w-52 shrink-0 flex-col border-r border-line bg-panel">
        <div className="px-5 pt-5 pb-6">
          <div className="text-[15px] font-semibold tracking-tight">Cue</div>
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
                {t.id === 'projects' && pendingUpdates > 0 && (
                  <span className="ml-auto rounded-full bg-accent px-1.5 font-mono text-[11px] font-semibold text-bg tabular-nums" title="Teams updates to review">
                    {pendingUpdates}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-auto flex items-center justify-between px-5 py-4 text-xs text-muted">
          <span>{version ? `v${version}` : ''}</span>
          <button
            onClick={() => void window.api.ui.quit()}
            className="cursor-pointer text-[11px] text-muted hover:text-bad transition-colors"
            title={keys("Quit Cue completely (Ctrl+Shift+Q)")}
          >
            Quit
          </button>
        </div>
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
          {tab === 'projects' && <ProjectsTab />}
          {tab === 'history' && <HistoryTab />}
          {tab === 'practice' && <PracticeTab />}
        </div>
      </main>
    </div>
  )
}
