/** IPC channel names (PRD §7). Dependency-free so the sandboxed preload can bundle it. */
export const IPC = {
  // capture window -> main
  audioChunk: 'audio:chunk',
  audioLevel: 'audio:level',
  captureStatus: 'capture:status',
  // main -> capture window
  captureStart: 'capture:start',
  captureStop: 'capture:stop',
  captureMic: 'capture:mic',
  // main -> windows
  transcriptUpdate: 'transcript:update',
  sessionState: 'session:state',
  debugLatency: 'debug:latency',
  uiNavigate: 'ui:navigate',
  settingsChanged: 'settings:changed',
  // main -> overlay (answers)
  questionDetected: 'question:detected',
  answerToken: 'answer:token',
  answerDone: 'answer:done',
  answerError: 'answer:error',
  qaReset: 'qa:reset',
  overlayNav: 'overlay:nav',
  overlayFocusAsk: 'overlay:focusAsk',
  // main window -> main (invoke)
  sessionStart: 'session:start',
  sessionStop: 'session:stop',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  apiKeySet: 'settings:setApiKey',
  apiKeyStatus: 'settings:apiKeyStatus',
  overlayToggle: 'overlay:toggle',
  // any window -> main (invoke)
  answerNow: 'answer:now',
  answerRegenerate: 'answer:regenerate',
  answerShorter: 'answer:shorter',
  answerAsk: 'answer:ask',
  voiceAskSet: 'voice:set',
  qaList: 'qa:list',
  profileGet: 'profile:get',
  profileSave: 'profile:save',
  profileImportResume: 'profile:importResume'
} as const
