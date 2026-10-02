// Runs electron-vite with ELECTRON_RUN_AS_NODE removed. VS Code sets that variable
// in its integrated terminal, which makes Electron start as plain Node and crash.
import { spawn } from 'node:child_process'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn('electron-vite', process.argv.slice(2), { stdio: 'inherit', env, shell: true })
child.on('exit', (code) => process.exit(code ?? 1))
