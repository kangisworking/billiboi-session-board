import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BoardMode, RecentMsg, Row, Todo } from '../types'
import { loadNames, readRecent } from './messages'
import { fit, stringWidth } from './width'

// 읽기 전용. ~/.claude 아래 파일만 읽어 그린다. 세션 대화(jsonl)는 읽지 않는다.
const PANE = 'session-board'
const TITLE = '세션 현황'
const PERIOD_MS = 5000
const SPIN_MS = 400
const MAX_TODOS = 12
const STALE_MS = 60 * 60 * 1000 // 1시간 넘게 멈춘 세션
const SPIN: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const rows = atom({ plugin: 'session-board', key: 'rows' } as const, [], { shape: 'rows-1' })
// 어디에 그릴지. 기본은 프롬프트 위 띠(band). 'pane' 은 패널(전체화면이면 오른쪽 dock, 아니면 프롬프트 위 inline).
const mode = atom({ plugin: 'session-board', key: 'mode' } as const, 'band', { shape: 'mode-1' })
const frame = atom({ plugin: 'session-board', key: 'frame' } as const, 0, { shape: 'frame-1' })
const showAll = atom({ plugin: 'session-board', key: 'showAll' } as const, false, { shape: 'showAll-1' })
// 최근 메시지 칸: message-board 가 남긴 파일을 읽어 띠·패널 맨 위에 몇 건 보인다. /session-board msgs on|off
const msgsOn = atom({ plugin: 'session-board', key: 'msgsOn' } as const, true, { shape: 'msgsOn-1' })
const recent = atom({ plugin: 'session-board', key: 'recent' } as const, [], { shape: 'recent-1' })
const RECENT_DEFAULT = 10
const RECENT_MAX = 30
const msgsN = atom({ plugin: 'session-board', key: 'msgsN' } as const, RECENT_DEFAULT, { shape: 'msgsN-1' })
const MSG_PALETTE = ['claude', 'success', 'warning', 'suggestion', 'remember', 'planMode', 'autoAccept', 'ide', 'merged', 'permission']

type Json = Record<string, unknown>
type Session = { file: string; pid: number; sessionId: string; name: string; status: string; kind: string; updatedAt: number; jobId?: string }

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : 0)

async function readJson($: any, path: string): Promise<Json | undefined> {
  try {
    const text = await $.fs.read(path)
    const value = JSON.parse(text)
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

async function alivePids($: any, pids: number[]): Promise<Set<number>> {
  if (pids.length === 0) return new Set()
  try {
    const { stdout } = await $.process.run(['ps', '-o', 'pid=', '-p', pids.join(',')], { timeoutMs: 5000 })
    return new Set(String(stdout).split('\n').map(line => Number(line.trim())).filter(n => n > 0))
  } catch {
    return new Set(pids)
  }
}

function todosOfTaskDir(files: Json[]): Todo[] {
  // TaskCreate 가 남긴 파일: subject/status 를 가진 JSON 이면 그대로 쓴다.
  return files
    .filter(f => typeof f.subject === 'string' && f.status !== 'deleted')
    .map(f => ({ text: str(f.subject), done: f.status === 'completed', active: f.status === 'in_progress' }))
}

function todosOfPeerStatus(value: unknown): Todo[] {
  if (!Array.isArray(value)) return []
  return value
    .map(item => {
      if (typeof item === 'string') return { text: item, done: false }
      if (item && typeof item === 'object') {
        const o = item as Json
        return { text: str(o.text, str(o.content)), done: o.done === true || o.status === 'completed', active: o.active === true || o.status === 'in_progress' }
      }
      return undefined
    })
    .filter((t): t is Todo => t !== undefined && t.text !== '')
}

async function collect($: any): Promise<Row[]> {
  const { stdout } = await $.process.run(['sh', '-c', 'printf %s "$HOME"'], { timeoutMs: 5000 })
  const home = String(stdout).trim()
  const base = `${home}/.claude`

  const sessions: Session[] = []
  for (const entry of await listDir($, `${base}/sessions`)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const meta = await readJson($, `${base}/sessions/${entry.name}`)
    if (!meta) continue
    const pid = num(meta.pid)
    const sessionId = str(meta.sessionId)
    if (pid === 0 || sessionId === '') continue
    sessions.push({
      file: entry.name,
      pid,
      sessionId,
      name: str(meta.name, sessionId.slice(0, 8)),
      status: str(meta.status, '?'),
      kind: str(meta.kind, ''),
      updatedAt: num(meta.updatedAt),
      jobId: str(meta.jobId) || undefined,
    })
  }

  // 별칭: peer-status/aliases.json 의 { "<sessionId 앞 6자 이상 또는 pid>": "역할 이름" }
  const aliases = (await readJson($, `${base}/peer-status/aliases.json`)) ?? {}
  const aliasOf = (s: Session): string | undefined => {
    for (const [key, value] of Object.entries(aliases)) {
      if (typeof value !== 'string' || value === '') continue
      if (key === String(s.pid)) return value
      if (key.length >= 4 && s.sessionId.toLowerCase().startsWith(key.toLowerCase())) return value
    }
    return undefined
  }

  const alive = await alivePids($, sessions.map(s => s.pid))
  const out: Row[] = []
  for (const s of sessions) {
    if (!alive.has(s.pid)) continue
    const alias = aliasOf(s)
    const shown = alias ?? `[${s.sessionId.slice(0, 6)}] ${s.name}`
    let doing: string | undefined
    let todos: Todo[] = []

    // 1) 세션이 스스로 남긴 상태(peer-status-writer 또는 Bash 로 직접)
    const peer = await readJson($, `${base}/peer-status/${s.sessionId}.json`)
    if (peer) {
      doing = str(peer.doing) || undefined
      todos = todosOfPeerStatus(peer.todos)
    }

    // 2) 백그라운드 작업의 요약 한 줄
    if (!doing && s.jobId) {
      const job = await readJson($, `${base}/jobs/${s.jobId}/state.json`)
      if (job) doing = str(job.detail) || undefined
    }

    // 3) TaskCreate 가 남긴 항목
    if (todos.length === 0) {
      const dir = `${base}/tasks/session-${s.sessionId.slice(0, 8)}`
      const files: Json[] = []
      for (const entry of await listDir($, dir)) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
        const value = await readJson($, `${dir}/${entry.name}`)
        if (value) files.push(value)
      }
      todos = todosOfTaskDir(files)
    }

    out.push({
      id: s.sessionId,
      name: shown.replace(/\s+/g, ' ').slice(0, 60),
      alias: alias !== undefined,
      hasPeer: peer !== undefined,
      status: s.status,
      kind: s.kind,
      updatedAt: s.updatedAt,
      doing: doing?.replace(/\s+/g, ' ').slice(0, 80),
      todos: todos.slice(0, MAX_TODOS),
    })
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

async function refresh($: any) {
  try {
    const next = await collect($)
    await update($, rows, () => next)
    if (await read($, msgsOn)) {
      const { stdout } = await $.process.run(['sh', '-c', 'printf %s "$HOME"'], { timeoutMs: 5000 })
      const base = `${String(stdout).trim()}/.claude`
      const n = Math.min(RECENT_MAX, Math.max(1, (await read($, msgsN)) || RECENT_DEFAULT))
      const list: RecentMsg[] = await readRecent($, base, await loadNames($, base), n)
      await update($, recent, () => list)
    }
  } catch (error) {
    $.ui.log(`session-board: ${String(error).slice(0, 120)}`, { to: 'debug' })
  }
}

// ---- 그리기 도우미 ----
const ago = (ms: number) => {
  if (!ms) return ''
  const m = Math.round((Date.now() - ms) / 60000)
  return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`
}
const isStale = (row: Row) => row.updatedAt > 0 && Date.now() - row.updatedAt > STALE_MS
// 상태별 색: busy 초록, shell 노랑, idle 회색, 오래 멈춤·오류 빨강
const statusColor = (row: Row): string => {
  if (isStale(row) || row.status === 'error') return 'error'
  if (row.status === 'busy') return 'success'
  if (row.status === 'shell') return 'warning'
  return 'inactive'
}
// 갱신 시각 색 단계: 5분 안 밝게, 1시간 안 subtle, 그 뒤 흐리게
const ageColor = (row: Row): { color?: string; dim: boolean } => {
  const age = Date.now() - row.updatedAt
  if (age < 5 * 60000) return { color: 'text', dim: false }
  if (age < STALE_MS) return { color: 'subtle', dim: false }
  return { dim: true }
}
// 띠에 보일 todo 한 줄: 진행 중 하나, 없으면 다음 pending 하나
const nextTodo = (row: Row): Todo | undefined => row.todos.find(t => t.active) ?? row.todos.find(t => !t.done)
// 별칭도 peer-status 도 없고 1시간 넘게 멈춘 세션은 기본 숨김
const isHidden = (row: Row) => !row.alias && !row.hasPeer && isStale(row)

function summary(list: Row[]) {
  const busy = list.filter(r => r.status === 'busy' || r.status === 'shell').length
  const idle = list.length - busy
  const done = list.reduce((n, r) => n + r.todos.filter(t => t.done).length, 0)
  const total = list.reduce((n, r) => n + r.todos.length, 0)
  return `세션 ${list.length} · 작업 중 ${busy} · 대기 ${idle} · 완료 todo ${done}/${total}`
}

// 고정 폭 열. 아이콘(1) 상태(5) 세션 갱신(9, 오른쪽) 진행(막대+n/m) 하는 일(남은 폭). 열 사이 한 칸.
type Cols = { icon: number; status: number; name: number; age: number; bar: number; barCells: number; doing: number; doingAt: number }
function columns(width: number): Cols {
  const narrow = width < 100
  const icon = 1
  const status = 5
  const name = narrow ? 16 : 22
  const age = 9
  const barCells = narrow ? 5 : 10
  const bar = barCells + 1 + 5 // "▰▰▱▱▱ 12/12"
  const doingAt = icon + 1 + status + 1 + name + 1 + age + 1 + bar + 1
  const doing = Math.max(6, width - doingAt)
  return { icon, status, name, age, bar, barCells, doing, doingAt }
}
const barText = (done: number, total: number, cells: number) => {
  if (total === 0) return ''
  const filled = Math.round((done / total) * cells)
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled) + ` ${done}/${total}`
}
const markOf = (row: Row, spin: string) => (row.status === 'busy' ? spin : isStale(row) ? 'x' : row.status === 'shell' ? '$' : '-')

// 한 세션의 표 행(한 줄)과 그 아래 todo 줄들. todo 는 "하는 일" 열 자리에 맞춰 들여 쓴다.
function drawRows($: any, e: any, list: Row[], width: number, spin: string, todosOf: (row: Row) => Todo[]) {
  const { Box, Text } = $.ui.resolve(e)
  const c = columns(width)
  const line = '─'.repeat(width)
  const header = (
    <Text dimColor wrap="truncate">
      {fit('상태', c.icon + 1 + c.status)} {fit('세션', c.name)} {fit('갱신', c.age, 'right')} {fit('진행', c.bar)} {fit('하는 일', c.doing)}
    </Text>
  )
  const body = list.map(row => {
    const color = statusColor(row)
    const age = ageColor(row)
    const done = row.todos.filter(t => t.done).length
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={color} wrap="truncate">{fit(markOf(row, spin), c.icon)} {fit(row.status, c.status)} </Text>
          <Text bold color={row.alias ? 'claude' : 'text'} wrap="truncate">{fit(row.name + (row.kind === 'bg' ? ' (bg)' : ''), c.name)} </Text>
          <Text color={age.color} dimColor={age.dim} wrap="truncate">{fit(ago(row.updatedAt), c.age, 'right')} </Text>
          <Text color={done === row.todos.length && row.todos.length > 0 ? 'success' : 'subtle'} wrap="truncate">{fit(barText(done, row.todos.length, c.barCells), c.bar)} </Text>
          <Text wrap="truncate">{fit(row.doing ?? '', c.doing)}</Text>
        </Box>
        {todosOf(row).map(todo => (
          <Text color={todo.active ? 'success' : undefined} dimColor={todo.done || (!todo.active && !todo.done)} wrap="truncate">
            {' '.repeat(c.doingAt)}{fit(`${todo.active ? '▶' : todo.done ? '✓' : '·'} ${todo.text}`, c.doing)}
          </Text>
        ))}
      </Box>
    )
  })
  return { Box, Text, line, header, body }
}

const hashOf = (s: string) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}
const msgColor = (label: string) => (label === '나' ? 'text' : MSG_PALETTE[hashOf(label) % MSG_PALETTE.length])
const hhmm = (ts: number) => {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}
// 최근 메시지 칸: "HH:MM ●보낸이 → ●받는이  본문 한 줄". 없으면 빈 배열.
function drawRecent($: any, e: any, list: RecentMsg[], width: number) {
  const { Box, Text } = $.ui.resolve(e)
  if (list.length === 0) return []
  const items = list.map(m => {
    const head = `${hhmm(m.ts)} ● ${m.from} → ● ${m.to}${m.isUser ? ' (입력)' : ''} `
    const rest = Math.max(8, width - stringWidth(head))
    return (
      <Box>
        <Text dimColor wrap="truncate">{hhmm(m.ts)} </Text>
        <Text color={msgColor(m.from)} wrap="truncate">● {m.from}</Text>
        <Text dimColor wrap="truncate"> → </Text>
        <Text color={msgColor(m.to)} wrap="truncate">● {m.to}</Text>
        {m.isUser ? <Text dimColor wrap="truncate"> (입력)</Text> : null}
        <Text wrap="truncate"> {fit(m.text, rest)}</Text>
      </Box>
    )
  })
  return [<Text dimColor wrap="truncate">{fit(`최근 메시지 ${list.length}건 (/message-board 로 전체, /session-board msgs <n>|off)`, width)}</Text>, ...items, <Text dimColor wrap="truncate">{'─'.repeat(width)}</Text>]
}

async function setMode($: any, next: BoardMode) {
  await update($, mode, () => next)
  if (next === 'pane') {
    await $.ui.open({ id: PANE, title: TITLE })
  } else {
    await $.ui.close({ id: PANE })
  }
  await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-board',
      description: '세션 현황: /session-board (프롬프트 위 띠), right (오른쪽 패널), all (숨긴 세션까지), msgs on|off|<n> (최근 메시지 칸, 기본 10건), off (숨김)',
    })
    // 기본은 띠(band). 전에 패널 모드로 두었으면 그대로 다시 연다.
    const kept = await read($, mode)
    if (kept === 'pane') void $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    $.clock.every(PERIOD_MS, () => void refresh($))
    // 스피너: busy 세션이 있을 때만 프레임을 올려 다시 그린다(아니면 상태를 안 건드려 CPU 를 아낀다).
    $.clock.every(SPIN_MS, async () => {
      try {
        if ((await read($, mode)) === 'off') return
        const list = await read($, rows)
        if (!list.some(r => r.status === 'busy')) return
        await update($, frame, f => (f + 1) % SPIN.length)
      } catch {
        // 그리기용 타이머라 실패해도 무시
      }
    })

    return next(e)
  })

  on('command.run', { command: 'session-board' }, async ($, e) => {
    const rest0 = (a: string) => a.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    const arg = rest0(e.args)
    if (arg === 'right' || arg === 'pane' || arg === 'dock') {
      await setMode($, 'pane')
      return { text: '세션 현황을 패널(전체화면이면 오른쪽)로 엽니다. /session-board 로 프롬프트 위 띠로 돌아갑니다.' }
    }
    if (arg === 'off' || arg === 'hide' || arg === 'close') {
      await setMode($, 'off')
      return { text: '세션 현황을 숨겼습니다. /session-board 로 다시 켭니다.' }
    }
    if (arg === 'msgs' || rest0(e.args) === 'msgs') {
      const count = /\b(\d{1,2})\b/.exec(e.args)?.[1]
      if (count !== undefined) {
        const n = Math.min(RECENT_MAX, Math.max(1, Number(count)))
        await update($, msgsN, () => n)
        await update($, msgsOn, () => true)
        await refresh($)
        return { text: `최근 메시지를 ${n}건까지 보입니다(1~${RECENT_MAX}).` }
      }
      const want = /\boff\b/.test(e.args) ? false : /\bon\b/.test(e.args) ? true : !(await read($, msgsOn))
      await update($, msgsOn, () => want)
      if (!want) await update($, recent, () => [])
      await refresh($)
      return { text: want ? '띠·패널 맨 위에 최근 메시지를 보입니다.' : '최근 메시지 칸을 숨깁니다. /session-board msgs on 으로 다시 켭니다.' }
    }
    if (arg === 'all') {
      const now = !(await read($, showAll))
      await update($, showAll, () => now)
      return { text: now ? '오래 멈춘 이름 없는 세션까지 모두 보입니다. 다시 /session-board all 로 숨깁니다.' : '오래 멈춘 이름 없는 세션은 다시 숨깁니다.' }
    }
    await setMode($, 'band')
    return { text: '세션 현황을 프롬프트 위 띠에 보입니다. 상세는 /session-board right, 숨긴 세션은 all, 숨기기는 off.' }
  })

  // 프롬프트 바로 위 띠: 머리줄, 구분선, 열 제목, 세션당 한 행 + 진행 중 todo 한 줄. 설문이 띠를 쓰는 동안은 비켜 준다.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, mode)) !== 'band') return next(e)
    const all = await read($, rows)
    if (all.length === 0) return next(e)
    const spin = SPIN[(await read($, frame)) % SPIN.length] ?? SPIN[0]!
    const every = await read($, showAll)
    const list = every ? all : all.filter(r => !isHidden(r))
    const hidden = all.length - list.length
    const width = Math.max(40, e.props.bodyColumns ?? 80)
    const { Box, Text, line, header, body } = drawRows($, e, list, width, spin, row => {
      const t = nextTodo(row)
      return t ? [t] : []
    })
    // 띠 높이(maxRows)가 모자라면 메시지 칸부터 줄인다: 머리줄 > 세션 표 > 메시지.
    // 세션 표 = 구분선 1 + 열 제목 1 + 세션마다 1 + 진행 중 todo 줄. 메시지 칸 = 제목 1 + 건수 + 구분선 1.
    const tableRows = 2 + list.reduce((n, row) => n + 1 + (nextTodo(row) ? 1 : 0), 0)
    const room = (e.props.maxRows ?? 20) - 1 - tableRows - 2
    const wanted = (await read($, msgsOn)) ? await read($, recent) : []
    const shown = room >= 1 ? wanted.slice(-Math.min(wanted.length, room)) : []
    const top = drawRecent($, e, shown, width)

    return (
      <Box flexDirection="column">
        {top}
        <Text dimColor wrap="truncate">{fit(summary(all) + (hidden > 0 ? ` · +${hidden}개 숨김(/session-board all)` : ''), width)}</Text>
        <Text dimColor wrap="truncate">{line}</Text>
        {header}
        {body}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const all = await read($, rows)
    const spin = SPIN[(await read($, frame)) % SPIN.length] ?? SPIN[0]!
    const every = await read($, showAll)
    const list = every ? all : all.filter(r => !isHidden(r))
    const hidden = all.length - list.length
    const width = Math.max(40, (e.props?.bodyColumns ?? 60) - 1)
    const { Box, Text, line, header, body } = drawRows($, e, list, width, spin, row => row.todos)
    const top = (await read($, msgsOn)) ? drawRecent($, e, await read($, recent), width) : []

    return (
      <Box flexDirection="column">
        {top}
        {all.length === 0 && <Text dimColor>살아 있는 세션이 없거나 아직 읽는 중입니다.</Text>}
        {all.length > 0 && <Text dimColor wrap="truncate">{fit(summary(all), width)}</Text>}
        {all.length > 0 && <Text dimColor wrap="truncate">{line}</Text>}
        {all.length > 0 && header}
        {body}
        {hidden > 0 && <Text dimColor wrap="truncate">+{hidden}개 숨김 (/session-board all)</Text>}
      </Box>
    )
  })
}
