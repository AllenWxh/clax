import { resolve, relative, isAbsolute, parse } from 'node:path'

export class PermissionDenied extends Error { name = 'PermissionDenied' }
export function inside(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))
}
export function commandRisk(command: string): { blocked: boolean; automatic: boolean; reason: string } {
  const normalized = command.replace(/["']/g, '').trim()
  // Always reject direct disk/root destruction, including in Full Access.
  const catastrophic = /\b(?:mkfs(?:\.\w+)?|diskpart)\b|\bformat\s+[a-z]:/i.test(normalized)
    || /\brm\s+(?:-[\w-]+\s+)*(?:\/\*?|~\/?|\$\{?HOME\}?\/?|[a-z]:[\\/]\*?)(?=\s|$|[;&|])/i.test(normalized)
    || /\b(?:rmdir|rd|del)\s+(?:\/[qs]\s+)*[a-z]:[\\/]\*?(?=\s|$)/i.test(normalized)
    || /:\(\)\s*\{\s*:\|:/.test(normalized)
  if (catastrophic) return { blocked: true, automatic: false, reason: 'Root/disk destruction is blocked in every permission mode.' }
  const complex = /[;&|><`\n\r]|\$\(/.test(command)
  const risky = /\b(?:rm|del|erase|rmdir|rd|sudo|su|chmod|chown|kill|killall|pkill|shutdown|reboot|reg|sc|powershell|pwsh|curl|wget|brew|apt|apt-get|winget|choco)\b|--global|\s-g(?:\s|$)|(?:^|\s)\/(?:etc|System|usr|Users|home)\//i.test(normalized)
  const safe = /^(?:pwd|ls|dir|rg|cat|type|head|tail)(?:\s|$)/.test(normalized)
    || /^git\s+(?:status|diff|log|show|ls-files)(?:\s|$)/.test(normalized)
    || /^(?:node|npm|pnpm|yarn)\s+--version$/.test(normalized)
    || /^(?:npm|pnpm|yarn)\s+(?:(?:run\s+)?(?:test|lint|typecheck|build|dev|start)|install|ci)(?:\s|$)/.test(normalized)
  return { blocked: false, automatic: safe && !complex && !risky, reason: risky ? 'Command may delete files, change the system or affect other processes.' : 'Command executes code on your computer.' }
}
export function isRoot(path: string) { return resolve(path) === parse(resolve(path)).root }
