import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { buildActivity } from './build-activity.mjs'

export async function buildNative() {
  await buildActivity()
  if (process.platform !== 'darwin') return
  const source = resolve('native/window.mm'), target = resolve('out/native/clax-window.node')
  const built = await stat(target).catch(() => null)
  if (built && built.mtimeMs >= (await stat(source)).mtimeMs) return
  await mkdir(resolve('out/native'), { recursive: true })
  const headers = createRequire(import.meta.url)('node-api-headers').include_dir
  try {
    await promisify(execFile)('/usr/bin/xcrun', ['clang++', '-std=c++17', '-O2', '-bundle', '-undefined', 'dynamic_lookup', '-DNAPI_VERSION=8', '-I', headers, '-framework', 'AppKit', source, '-o', target], { timeout: 60000 })
    await promisify(execFile)('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.clax.window', target])
  } catch (error) { throw new Error(`macOS 窗口模块编译失败，需要 Xcode Command Line Tools。\n${error.message}`) }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await buildNative()
