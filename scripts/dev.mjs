import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { buildNative } from './build-native.mjs'

const require = createRequire(import.meta.url)
const env = { ...process.env }
// Some host applications set this; Electron must start in desktop mode.
delete env.ELECTRON_RUN_AS_NODE
const production = process.argv.includes('--production')
await buildNative()
const child = production
  ? spawn(require('electron'), ['.'], { stdio: 'inherit', env })
  : spawn(process.execPath, ['node_modules/electron-vite/bin/electron-vite.js', 'dev'], { stdio: 'inherit', env })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => process.exit(code ?? 0))
