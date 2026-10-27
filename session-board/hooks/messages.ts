// message-board 가 남긴 메시지 파일(~/.claude/peer-status/messages/<YYYY-MM-DD>/*.json)을 읽어 최근 몇 건만 돌려준다. 읽기 전용.
import { colorOf, resolve, type Names } from './label'

export type Recent = { ts: number; from: string; to: string; fromColor: string; toColor: string; text: string; isUser: boolean }

type Json = Record<string, unknown>
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : 0)

async function readJson($: any, path: string): Promise<Json | undefined> {
  try {
    const value = JSON.parse(await $.fs.read(path))
    return value && typeof value === 'object' ? (value as Json) : undefined
  } catch {
    return undefined
  }
}
async function listDir($: any, path: string) {
  try {
    return (await $.fs.list(path)) as { name: string; kind: string }[]
  } catch {
    return []
  }
}

export async function loadNames($: any, base: string): Promise<Names> {
  const byPid = new Map<string, string>()
  const bySid = new Map<string, string>()
  for (const entry of await listDir($, `${base}/sessions`)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const meta = await readJson($, `${base}/sessions/${entry.name}`)
    if (!meta) continue
    const sid = str(meta.sessionId)
    if (!sid) continue
    byPid.set(String(num(meta.pid)), sid)
    bySid.set(sid, str(meta.name, sid.slice(0, 8)))
  }
  const raw = (await readJson($, `${base}/peer-status/aliases.json`)) ?? {}
  const aliases: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v) aliases[k] = v
  // 색: colors.json 이 우선, aliases.json 의 "colors" 칸도 받는다.
  const colors: Record<string, string> = {}
  const inAliases = raw.colors
  if (inAliases && typeof inAliases === 'object') for (const [k, v] of Object.entries(inAliases as Json)) if (typeof v === 'string' && v) colors[k] = v
  const own = (await readJson($, `${base}/peer-status/colors.json`)) ?? {}
  for (const [k, v] of Object.entries(own)) if (typeof v === 'string' && v) colors[k] = v
  return { byPid, bySid, aliases, colors }
}

// 최근 2일 폴더에서 파일 이름(앞의 ts)으로 최신 `limit` 건만 읽는다. 보낸 쪽·받은 쪽이 둘 다 남긴 같은 메시지는 하나로.
export async function readRecent($: any, base: string, names: Names, limit: number): Promise<Recent[]> {
  const root = `${base}/peer-status/messages`
  const days = (await listDir($, root))
    .filter(e => e.kind === 'dir' && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort()
    .slice(-2)
  const files: { day: string; name: string; ts: number }[] = []
  for (const day of days) {
    for (const entry of await listDir($, `${root}/${day}`)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      files.push({ day, name: entry.name, ts: Number(entry.name.split('-')[0]) || 0 })
    }
  }
  files.sort((a, b) => b.ts - a.ts)
  const out: Recent[] = []
  const seen: { key: string; ts: number }[] = []
  for (const f of files) {
    if (out.length >= limit) break
    const v = await readJson($, `${root}/${f.day}/${f.name}`)
    if (!v || typeof v.text !== 'string') continue
    const rf = resolve(names, str(v.from))
    const rt = resolve(names, str(v.to))
    const item: Recent = { ts: num(v.ts), from: rf.label, to: rt.label, fromColor: colorOf(names, rf), toColor: colorOf(names, rt), text: str(v.text), isUser: v.dir === 'user' }
    const key = `${item.from}>${item.to}>${item.text.slice(0, 200)}`
    if (seen.some(s => s.key === key && Math.abs(s.ts - item.ts) < 10 * 60000)) continue
    seen.push({ key, ts: item.ts })
    out.push(item)
  }
  return out.reverse() // 오래된 것 위, 최신 아래
}
