import type { QaSnapshot } from '@shared/ipc'
import type { Project } from '@shared/work'
import type { DirectQuestion } from '../answer/CopilotService'
import { confidentTarget, rankProjects } from './projectMatch'
import { hasStatusCue } from './WorkDetector'

/**
 * A typed or voice question in Work Mode (FR-W6): a status cue about a known project or item gets
 * the spoken status answer; a status cue about an unclear one, the quick-pick (no projectId);
 * anything else a general work answer.
 */
export function resolveWorkQuestion(text: string, projects: Project[]): DirectQuestion {
  if (!hasStatusCue(text) || projects.length === 0) return { type: 'work' }
  const target = confidentTarget(text, projects)
  if (target) return { type: 'status', projectId: target.project.id, ...(target.task ? { taskId: target.task.id } : {}) }
  if (projects.length === 1) return { type: 'status', projectId: projects[0].id }
  return { type: 'status', suggestedId: rankProjects(text, projects)[0]?.project.id ?? null }
}

/**
 * `text` names a different project or item than `prev` was about, so it is a new question rather
 * than the rest or a follow-up of `prev` (FR-W10): another project, another item, or the whole
 * project after a question about one of its items. Text naming nothing can still continue it.
 */
export function isDifferentTopic(prev: Pick<QaSnapshot, 'projectId' | 'taskId'>, text: string, projects: Project[]): boolean {
  const target = confidentTarget(text, projects)
  if (!target) return false
  if (target.project.id !== prev.projectId) return true
  // Another item, or the whole project after a question about one item ("…and which bugs are open on the app?").
  if (prev.taskId) return !target.task || target.task.id !== prev.taskId
  return false
}
