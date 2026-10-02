/** Types for the local Teams / Microsoft Graph mock (scripts/mock-teams.mjs). */
export interface MockTeams {
  url: string
  post(message: { chatId: string; author?: string; text: string; replyTo?: string }): { id: string; createdDateTime: string } | null
  data: {
    chats: { id: string; topic: string | null; messages: { id: string }[] }[]
    teams: { id: string; channels: { id: string; messages: { id: string }[] }[] }[]
  }
  approveAll(): void
  failNext(status: number, count?: number): void
  close(): Promise<void>
}

export function startMockTeams(opts?: { port?: number; autoApprove?: boolean; now?: () => number }): Promise<MockTeams>
