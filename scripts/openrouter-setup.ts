import { _electron as electron, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// Explicit opt-in: this action creates a real account credential, never a test fixture.
if (process.env.CLAX_CREATE_OPENROUTER_KEY !== '1') throw new Error('Set CLAX_CREATE_OPENROUTER_KEY=1 only after authorizing creation of a $15 Clax key')
if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not exported')
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), CLAX_HOME: join(homedir(), '.clax'), CLAX_TEST: '1', CLAX_SHOW: '0' }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const desktop = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: ['.'], env, cwd: resolve('.') })
try {
  const page = await desktop.firstWindow()
  await page.waitForFunction(() => Boolean(window.clax))
  await page.evaluate(() => window.clax.importOpenRouter())
  let state = await page.evaluate(() => window.clax.bootstrap())
  const provider = state.providers.find(p => p.kind === 'openrouter')!
  await page.evaluate(id => window.clax.provisionOpenRouter(id), provider.id)
  state = await page.evaluate(() => window.clax.bootstrap())
  const current = state.providers.find(p => p.id === provider.id)!, credits = await page.evaluate(id => window.clax.providerCredits(id), provider.id)
  expect(credits?.managementKey).toBe(false); expect(credits?.keyLimit).toBe(15)
  expect(current.apiKeyEnv).toBeUndefined(); expect(current.creditsKeyEnv).toBe('OPENROUTER_API_KEY')
  expect(current.hasKey).toBe(true)
  const report = { date: new Date().toISOString(), productionHome: state.storagePath, provider: current.name, models: current.models.length, encryptedInferenceKey: true, managementKeyForCreditsOnly: true, credits }
  await writeFile('test-results/openrouter-setup-validation.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally { await desktop.close() }
