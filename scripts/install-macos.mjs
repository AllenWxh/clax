import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, cp, lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') throw new Error('此安装入口仅支持 macOS。')
const run = promisify(execFile), require = createRequire(import.meta.url)
const project = fileURLToPath(new URL('..', import.meta.url)), home = homedir()
const app = join(home, 'Applications/Clax.app'), desktop = join(home, 'Desktop/Clax.app')
const label = 'com.clax.agent', domain = `gui/${process.getuid()}`, target = `${domain}/${label}`
const agent = join(home, `Library/LaunchAgents/${label}.plist`), logs = join(home, '.clax/logs')
const exists = path => access(path).then(() => true, () => false)
async function plist(path, value) {
  await writeFile(path, JSON.stringify(value), { mode: 0o600 })
  await run('/usr/bin/plutil', ['-convert', 'xml1', path])
}
async function field(path, key) { return (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path])).stdout.trim() }
async function unload() {
  const loaded = await run('/bin/launchctl', ['print', target]).then(() => true, () => false)
  if (loaded) await run('/bin/launchctl', ['bootout', target])
}
async function autostart(enabled) {
  if (await exists(agent) && await field(agent, 'Label') !== label) throw new Error(`启动项不是 Clax 创建的，未覆盖：${agent}`)
  if (!enabled) {
    await unload()
    await rm(agent, { force: true })
    console.log('Clax 登录自启动已关闭。桌面图标仍可使用。')
    return
  }
  if (!await exists(app)) throw new Error('请先运行 pnpm desktop:install。')
  await mkdir(logs, { recursive: true, mode: 0o700 })
  await mkdir(join(home, 'Library/LaunchAgents'), { recursive: true })
  // Launch once per login: quitting Clax must not cause a restart loop.
  await unload()
  await plist(agent, {
    Label: label, ProgramArguments: ['/usr/bin/open', '-g', app, '--args', '--background'],
    RunAtLoad: true, LimitLoadToSessionType: 'Aqua', Umask: 0o077,
    StandardOutPath: join(logs, 'login.log'), StandardErrorPath: join(logs, 'login.log'),
  })
  await run('/bin/launchctl', ['enable', target])
  await run('/bin/launchctl', ['bootstrap', domain, agent])
  console.log(`Clax 登录自启动已开启：${agent}`)
}

if (process.argv.includes('--disable-autostart')) await autostart(false)
else if (process.argv.includes('--enable-autostart')) await autostart(true)
else {
  const info = join(app, 'Contents/Info.plist')
  if (await exists(app) && await field(info, 'CFBundleIdentifier') !== 'com.clax.launcher') throw new Error(`已有其他应用，未覆盖：${app}`)
  const entry = await lstat(desktop).catch(() => null)
  if (entry && (!entry.isSymbolicLink() || resolve(join(desktop, '..'), await readlink(desktop)) !== app)) throw new Error(`已有其他桌面项目，未覆盖：${desktop}`)
  await access(join(project, 'out/main/index.js'))
  await access(join(project, 'out/native/clax-activity'))
  const stage = await mkdtemp(join(tmpdir(), 'clax-launcher-'))
  try {
    const bundle = join(stage, 'Clax.app'), contents = join(bundle, 'Contents'), resources = join(contents, 'Resources')
    await mkdir(resources, { recursive: true }); await mkdir(join(contents, 'MacOS'))
    await run('/usr/bin/xcrun', ['swiftc', '-O', join(project, 'native/launcher.swift'), '-o', join(contents, 'MacOS/Clax')], { timeout: 120000 })
    await plist(join(contents, 'Info.plist'), {
      CFBundleIdentifier: 'com.clax.launcher', CFBundleName: 'Clax', CFBundleDisplayName: 'Clax',
      CFBundleExecutable: 'Clax', CFBundlePackageType: 'APPL', CFBundleVersion: '1', CFBundleShortVersionString: '0.1.0',
      CFBundleIconFile: 'Clax.icns', LSUIElement: true, NSHighResolutionCapable: true,
    })
    await writeFile(join(resources, 'launcher.json'), JSON.stringify({ project, executable: require('electron'), home: join(home, '.clax'), log: join(logs, 'desktop.log') }), { mode: 0o600 })
    const icon = join(stage, 'Clax.png'), iconset = join(stage, 'Clax.iconset')
    await mkdir(iconset)
    await run(join(contents, 'MacOS/Clax'), ['--make-icon', icon])
    for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
      await run('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), icon, '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)])
    }
    await run('/usr/bin/iconutil', ['-c', 'icns', '-o', join(resources, 'Clax.icns'), iconset])
    await run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.clax.launcher', bundle])
    await mkdir(join(home, 'Applications'), { recursive: true })
    await cp(bundle, app, { recursive: true })
    if (!entry) await symlink(app, desktop)
    await run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', app])
    await autostart(true)
    console.log(`双击打开：${desktop}`)
  } finally { await rm(stage, { recursive: true, force: true }) }
}
