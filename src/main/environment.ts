import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'

export function localEnvironment(workspace: string): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {}
  for (const name of ['.env', '.env.local']) {
    const path = join(workspace, name)
    if (existsSync(path)) Object.assign(values, parseEnv(readFileSync(path, 'utf8')))
  }
  return { ...values, ...process.env }
}
export function environmentKey(name: string, workspace: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Enter an environment variable name, such as OPENROUTER_API_KEY')
  return localEnvironment(workspace)[name] ?? ''
}
export function availableEnvironmentKeys(workspace: string): string[] {
  return Object.entries(localEnvironment(workspace)).filter(([name, value]) => /(?:API_KEY|API_TOKEN)$/.test(name) && Boolean(value)).map(([name]) => name).sort()
}
