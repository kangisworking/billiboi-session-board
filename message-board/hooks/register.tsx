import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BoardMode, Filter, Msg } from '../types'
import { labelOf, type Names } from './label'
import { fit, stringWidth } from './width'

// 두 가지 일을 한다.
// 1) 기록: 이 세션이 보내는 메시지(session.send), 받는 메시지(session.receive), 사용자가 입력한 프롬프트(prompt.submit)를
//    ~/.claude/peer-status/messages/<YYYY-MM-DD>/<ts>-<sid6>-<dir>.json 에 한 건씩 남긴다. 본문은 앞 500자만.
// 2) 표시: 그 폴더를 5초마다 읽어 모든 세션의 메시지를 시간순(최신이 아래)으로 그린다. 세션 대화 기록(jsonl)은 읽지 않는다.
const PANE = 'message-board'
const TITLE = '메시지'
const PERIOD_MS = 5000
const KEEP_DAYS = 7
const MAX_SHOWN = 200
const TEXT_MAX = 500
const BAND_ITEMS = 5
const PALETTE = ['claude', 'success', 'warning', 'suggestion', 'remember', 'planMode', 'autoAccept', 'ide', 'merged', 'permission']

const msgs = atom({ plugin: 'message-board', key: 'msgs' } as const, [], { shape: 'msgs-1' })
const filter = atom({ plugin: 'message-board', key: 'filter' } as const, { kind: 'all' }, { shape: 'filter-1' })
const expanded = atom({ plugin: 'message-board', key: 'expanded' } as const, false, { shape: 'expanded-1' })
const mode = atom({ plugin: 'message-board', key: 'mode' } as const, 'pane', { shape: 'mode-1' })

type Json = Record<string, unknown>
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : 0)

async function home($: any): Promise<string> {
  const { stdout } = await $.process.run(['sh', '-c', 'printf %s "$HOME"'], { timeoutMs: 5000 })
  return String(stdout).trim()
}
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
const dayOf = (ts: number) => {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const hhmm = (ts: number) => {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}
const hash = (s: string) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}

// ---- 기록 ----
let myId = ''
async function record($: any, dir: Msg['dir'], from: string, to: string, text: string) {
  try {
    if (!myId) myId = await $.session.id()
    const ts = Date.now()
    const body = text.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX)
    if (body === '') return
    const id = `${ts}-${myId.slice(0, 6)}-${dir}`
    const msg: Msg = { id, ts, dir, from, to, text: body }
    await $.fs.write(`${await home($)}/.claude/peer-status/messages/${dayOf(ts)}/${id}.json`, JSON.stringify(msg) + '\n')
  } catch (error) {
    $.ui.log(`message-board: ${String(error).slice(0, 120)}`, { to: 'debug' })
  }
}
// 받은 메시지의 엔진 봉투를 벗긴다: <cross-session-message from="..." ...>본문</cross-session-message>
function unwrap(text: string): { from?: string; body: string } {
  const m = /<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/.exec(text)
  if (!m) return { body: text }
  const from = /\bfrom="([^"]*)"/.exec(m[1] ?? '')?.[1]
  return { from, body: (m[2] ?? '').trim() }
}
// 7일 넘은 날짜 폴더를 지운다(이 모드가 만든 messages/ 아래 날짜 폴더만).
async function cleanup($: any, base: string) {
  const limit = Date.now() - KEEP_DAYS * 86400_000
  for (const entry of await listDir($, `${base}/peer-status/messages`)) {
    if (entry.kind !== 'dir' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue
    if (new Date(entry.name + 'T00:00:00').getTime() >= limit) continue
    try {
      await $.process.run(['rm', '-rf', '--', `${base}/peer-status/messages/${entry.name}`], { timeoutMs: 5000 })
    } catch {
      // 못 지우면 다음에
    }
  }
}

// ---- 읽기 ----
async function names($: any, base: string): Promise<Names> {
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
  return { byPid, bySid, aliases }
}
const colorOf = (label: string) => (label === '나' ? 'text' : PALETTE[hash(label) % PALETTE.length])

async function collect($: any): Promise<Msg[]> {
  const base = `${await home($)}/.claude`
  const n = await names($, base)
  const out: Msg[] = []
  const days = (await listDir($, `${base}/peer-status/messages`))
    .filter(e => e.kind === 'dir' && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort()
    .slice(-KEEP_DAYS)
  for (const day of days) {
    for (const entry of await listDir($, `${base}/peer-status/messages/${day}`)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      const v = await readJson($, `${base}/peer-status/messages/${day}/${entry.name}`)
      if (!v || typeof v.text !== 'string') continue
      out.push({
        id: str(v.id, entry.name),
        ts: num(v.ts),
        dir: v.dir === 'out' || v.dir === 'in' || v.dir === 'user' ? v.dir : 'in',
        from: labelOf(n, str(v.from)),
        to: labelOf(n, str(v.to)),
        text: str(v.text),
      })
    }
  }
  out.sort((a, b) => a.ts - b.ts)
  // 같은 메시지를 보낸 쪽(out)과 받은 쪽(in)이 둘 다 남기면 하나로: 보낸이·받는이·본문 앞 200자가 같고 10분 안이면 중복
  const seen: { key: string; ts: number }[] = []
  const dedup: Msg[] = []
  for (const m of out) {
    const key = `${m.from}>${m.to}>${m.text.slice(0, 200)}`
    const dup = seen.find(s => s.key === key && Math.abs(s.ts - m.ts) < 10 * 60000)
    if (dup) continue
    seen.push({ key, ts: m.ts })
    dedup.push(m)
  }
  return dedup.slice(-MAX_SHOWN)
}

async function refresh($: any) {
  try {
    const next = await collect($)
    await update($, msgs, () => next)
  } catch (error) {
    $.ui.log(`message-board: ${String(error).slice(0, 120)}`, { to: 'debug' })
  }
}

function applyFilter(list: Msg[], f: Filter): Msg[] {
  const q = (f.name ?? '').toLowerCase()
  const has = (label: string) => label.toLowerCase().includes(q)
  if (f.kind === 'me') return list.filter(m => m.from === '나')
  if (f.kind === 'from') return list.filter(m => has(m.from))
  if (f.kind === 'to') return list.filter(m => has(m.to))
  return list
}
const filterLabel = (f: Filter) => (f.kind === 'all' ? '전체' : f.kind === 'me' ? '내가 보낸 것' : `${f.kind === 'from' ? '보낸이' : '받는이'}: ${f.name}`)

// 본문을 폭에 맞춰 줄로 나눈다(넓은 글자 2칸). 줄 수 제한을 넘으면 마지막 줄 끝에 …
function wrapText(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = []
  let cur = ''
  let used = 0
  for (const ch of text) {
    const w = stringWidth(ch)
    if (used + w > width) {
      lines.push(cur)
      cur = ''
      used = 0
      if (lines.length === maxLines) break
    }
    cur += ch
    used += w
  }
  if (lines.length < maxLines && cur) lines.push(cur)
  const cutOff = stringWidth(text) > lines.reduce((n, l) => n + stringWidth(l), 0)
  if (cutOff && lines.length > 0) lines[lines.length - 1] = fit(lines[lines.length - 1]! + '…', width).trimEnd()
  return lines
}

function drawList($: any, e: any, list: Msg[], width: number, isExpanded: boolean, f: Filter, total: number) {
  const { Box, Text } = $.ui.resolve(e)
  const sep = (label: string) => {
    const rest = Math.max(0, width - stringWidth(label) - 4)
    return `── ${label} ${'─'.repeat(rest)}`
  }
  const items: any[] = []
  let day = ''
  for (const m of list) {
    const d = dayOf(m.ts)
    if (d !== day) {
      day = d
      items.push(<Text dimColor wrap="truncate">{sep(d)}</Text>)
    }
    const body = wrapText(m.text, Math.max(10, width - 2), isExpanded ? 50 : 2)
    items.push(
      <Box flexDirection="column">
        <Box>
          <Text dimColor wrap="truncate">{hhmm(m.ts)} </Text>
          <Text color={colorOf(m.from)} wrap="truncate">● </Text>
          <Text bold={m.from === '나'} color={colorOf(m.from)} wrap="truncate">{fit(m.from, Math.min(stringWidth(m.from), Math.max(4, Math.floor((width - 12) / 2))))}</Text>
          <Text dimColor wrap="truncate"> → </Text>
          <Text color={colorOf(m.to)} wrap="truncate">● </Text>
          <Text color={colorOf(m.to)} wrap="truncate">{fit(m.to, Math.min(stringWidth(m.to), Math.max(4, Math.floor((width - 12) / 2))))}</Text>
          {m.dir === 'user' ? <Text dimColor wrap="truncate"> (입력)</Text> : null}
        </Box>
        {body.map(line => (
          <Text wrap="truncate">{'  '}{line}</Text>
        ))}
      </Box>,
    )
  }
  const head = `메시지 ${list.length}/${total} · ${filterLabel(f)}${isExpanded ? ' · 펼침' : ''}`
  return { Box, Text, head, items }
}

async function setMode($: any, next: BoardMode) {
  await update($, mode, () => next)
  if (next === 'pane') await $.ui.open({ id: PANE, title: TITLE })
  else await $.ui.close({ id: PANE })
  await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'message-board',
      description: '세션 간 메시지 타임라인: /message-board (패널), band, off, from <이름>, to <이름>, me, all, expand',
    })
    try {
      myId = await $.session.id()
      await cleanup($, `${await home($)}/.claude`)
    } catch {
      // 기록 전용 준비라 실패해도 표시는 한다
    }
    const kept = await read($, mode)
    if (kept === 'pane') void $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    $.clock.every(PERIOD_MS, () => void refresh($))
    return next(e)
  })

  // 보낸 메시지: SendMessage 도구나 다른 플러그인의 $.session.send
  on('session.send', async ($, e, next) => {
    const sent = await next(e)
    if (!myId) myId = await $.session.id()
    void record($, 'out', `session:${myId}`, e.to, e.text)
    return sent
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  // 받은 메시지: 다른 세션의 SendMessage. 봉투의 from 주소를 보낸이로 쓴다.
  on('session.receive', async ($, e, next) => {
    const kind = e.origin.kind
    if (kind === 'peer' || kind === 'peer-send-message') {
      if (!myId) myId = await $.session.id()
      const { from, body } = unwrap(e.text)
      void record($, 'in', from ?? 'peer', `session:${myId}`, body)
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  // 사용자가 이 세션에 직접 입력한 프롬프트(슬래시 명령·메타 제외)
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' && e.isMeta !== true && !e.text.trimStart().startsWith('/')) {
      if (!myId) myId = await $.session.id()
      void record($, 'user', 'me', `session:${myId}`, e.text)
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  on('command.run', { command: 'message-board' }, async ($, e) => {
    const [word = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = word.toLowerCase()
    const name = rest.join(' ')
    if (arg === 'band') {
      await setMode($, 'band')
      return { text: `메시지 보드를 프롬프트 위 띠에 보입니다(최근 ${BAND_ITEMS}건).` }
    }
    if (arg === 'off' || arg === 'hide' || arg === 'close') {
      await setMode($, 'off')
      return { text: '메시지 보드를 숨겼습니다. /message-board 로 다시 엽니다.' }
    }
    if (arg === 'expand' || arg === 'collapse') {
      const now = arg === 'expand' ? !(await read($, expanded)) : false
      await update($, expanded, () => now)
      return { text: now ? '본문을 전부 펼쳐 보입니다. 다시 /message-board expand 로 접습니다.' : '본문을 2줄로 접습니다.' }
    }
    if (arg === 'from' || arg === 'to') {
      if (!name) return { text: `이름을 적어 주세요. 예: /message-board ${arg} 조율` }
      const kind: Filter['kind'] = arg === 'from' ? 'from' : 'to'
      await update($, filter, () => ({ kind, name }))
      return { text: `${arg === 'from' ? '보낸이' : '받는이'}에 "${name}"이 들어간 메시지만 보입니다. /message-board all 로 풉니다.` }
    }
    if (arg === 'me') {
      await update($, filter, () => ({ kind: 'me' }))
      return { text: '내가 입력한 메시지만 보입니다. /message-board all 로 풉니다.' }
    }
    if (arg === 'all') {
      await update($, filter, () => ({ kind: 'all' }))
      await setMode($, 'pane')
      return { text: '필터를 풀고 패널로 보입니다.' }
    }
    await setMode($, 'pane')
    return { text: '메시지 보드를 패널로 엽니다. band / off / from <이름> / to <이름> / me / all / expand.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, mode)) !== 'band') return next(e)
    const all = await read($, msgs)
    const f = await read($, filter)
    const list = applyFilter(all, f).slice(-BAND_ITEMS)
    if (list.length === 0) return next(e)
    const width = Math.max(40, e.props.bodyColumns ?? 80)
    const { Box, Text, head, items } = drawList($, e, list, width, await read($, expanded), f, all.length)
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate">{fit(head, width)}</Text>
        {items}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const all = await read($, msgs)
    const f = await read($, filter)
    const list = applyFilter(all, f)
    const width = Math.max(30, (e.props?.bodyColumns ?? 60) - 1)
    const { Box, Text, head, items } = drawList($, e, list, width, await read($, expanded), f, all.length)
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate">{fit(head, width)}</Text>
        {list.length === 0 && <Text dimColor>아직 기록된 메시지가 없습니다. 이 모드를 켠 세션이 메시지를 주고받으면 여기에 쌓입니다.</Text>}
        {items}
      </Box>
    )
  })
}
