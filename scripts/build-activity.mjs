import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function buildActivity() {
  if (process.platform !== 'darwin') return
  const source = resolve('native/activity.swift'), target = resolve('out/native/clax-activity')
  const built = await stat(target).catch(() => null)
  if (built && built.mtimeMs >= (await stat(source)).mtimeMs) return
  await mkdir(resolve('out/native'), { recursive: true })
  try {
    await promisify(execFile)('/usr/bin/xcrun', ['swiftc', '-O', source, '-o', target])
    await promisify(execFile)('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.clax.activity', target])
  } catch (error) { throw new Error(`macOS 活动记录器编译失败，需要 Xcode Command Line Tools。\n${error.message}`) }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await buildActivity()
