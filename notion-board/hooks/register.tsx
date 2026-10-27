import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BoardMode, Change, Filter, Issue, Sync } from '../types'
import {
  applyFilter, countByStatus, describeFilter, diff, isOverdue, mergeChanges, readConfig, sortIssues, statusMap, themeOf, toIssue, todayKst,
  tokenOrder, TOKEN_ENVS,
} from './notion'
import type { Config } from './notion'
import { fit } from './width'

// 읽기 전용. 노션 공식 API 의 조회(query)만 부른다. 쓰기 요청은 보내지 않는다.
// 설정: ~/.claude/notion-board.json, 토큰: 설정의 tokenEnv(기본 NOTION_BOARD_TOKEN) → NOTION_API_KEY → NOTION_TOKEN 순.
// 토큰 값은 화면·로그·저장소 어디에도 남기지 않는다.
const PANE = 'notion-board'
const TICK_MS = 30_000
const API = 'https://api.notion.com/v1'

const EMPTY_FILTER: Filter = { me: false, flag: false, all: false, customer: '', status: '' }
const EMPTY_SYNC: Sync = { at: 0, tried: 0, error: '', intervalSec: 180, title: '노션 이슈', meName: '' }

const issues = atom({ plugin: 'notion-board', key: 'issues' } as const, [], { shape: 'issues-1' })
const changes = atom({ plugin: 'notion-board', key: 'changes' } as const, [], { shape: 'changes-1' })
const filter = atom({ plugin: 'notion-board', key: 'filter' } as const, EMPTY_FILTER, { shape: 'filter-1' })
const sync = atom({ plugin: 'notion-board', key: 'sync' } as const, EMPTY_SYNC, { shape: 'sync-1' })
const mode = atom({ plugin: 'notion-board', key: 'mode' } as const, 'band', { shape: 'mode-1' })

// 모듈 변수: 다시 불러오면(핫 리로드) 처음부터 다시 읽는다.
let config: Config | undefined
let busy = false

async function loadConfig($: any): Promise<{ cfg?: Config; error: string }> {
  const home = (await $.env.get('HOME')) ?? ''
  const path = `${home}/.claude/notion-board.json`
  try {
    const cfg = readConfig(JSON.parse(await $.fs.read(path)))
    return cfg ? { cfg, error: '' } : { error: `${path} 에 dataSourceId 가 없습니다` }
  } catch {
    return { error: `설정 파일이 없거나 JSON 이 아닙니다: ${path} (README 의 예시를 복사)` }
  }
}

// $.env.get 은 이름이 글자 그대로여야 해서 이름마다 따로 부른다.
async function readEnv($: any, name: string): Promise<string> {
  if (name === 'NOTION_BOARD_TOKEN') return (await $.env.get('NOTION_BOARD_TOKEN')) ?? ''
  if (name === 'NOTION_API_KEY') return (await $.env.get('NOTION_API_KEY')) ?? ''
  if (name === 'NOTION_TOKEN') return (await $.env.get('NOTION_TOKEN')) ?? ''
  return ''
}

async function token($: any, cfg: Config): Promise<{ key: string; name: string }> {
  for (const name of tokenOrder(cfg.tokenEnv)) {
    const key = await readEnv($, name)
    if (key) return { key, name }
  }
  return { key: '', name: '' }
}

const TOKEN_TODO = '노션 이슈 DB 가 있는 워크스페이스에서 통합을 만들고, 그 토큰을 NOTION_BOARD_TOKEN 에 넣은 뒤 이슈 DB 를 그 통합에 공유하세요'

// 실패 사유를 사람이 할 일로 바꾼다. 응답 본문의 message 는 토큰을 담지 않지만 길이를 자른다.
function reason(status: number, text: string, tokenName: string): string {
  let message = ''
  try {
    message = String(JSON.parse(text).message ?? '')
  } catch {
    message = ''
  }
  if (status === 401) return `${tokenName} 토큰이 거부되었습니다. ${TOKEN_TODO}`
  if (status === 404) return `${tokenName} 의 통합이 이 DB 를 볼 수 없습니다. ${TOKEN_TODO}(DB 페이지 ⋯ > 연결)`
  if (status === 429) return '노션 요청 한도에 걸렸습니다. 다음 주기에 다시 시도합니다'
  return `노션 응답 ${status}${message ? `: ${message.slice(0, 100)}` : ''}`
}

async function fetchAll($: any, cfg: Config, key: string, tokenName: string): Promise<Issue[]> {
  const out: Issue[] = []
  let cursor: string | undefined
  for (let page = 0; page < cfg.maxPages; page++) {
    const body: Record<string, unknown> = { page_size: 100, sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }] }
    if (cursor) body.start_cursor = cursor
    const res = await $.http.fetch(`${API}/data_sources/${cfg.dataSourceId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Notion-Version': cfg.notionVersion, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(reason(res.status, res.text, tokenName))
    const data = JSON.parse(res.text)
    for (const result of Array.isArray(data.results) ? data.results : []) {
      const issue = toIssue(result, cfg.props)
      if (issue) out.push(issue)
    }
    if (!data.has_more || !data.next_cursor) break
    cursor = String(data.next_cursor)
  }
  return out
}

async function refresh($: any, force = false) {
  if (busy) return
  const now = Date.now()
  const before = await read($, sync)
  if (!force && config && now - before.tried < config.intervalSec * 1000) return
  busy = true
  try {
    const loaded = await loadConfig($)
    config = loaded.cfg
    const cfg = config
    const base = { ...before, tried: now, intervalSec: cfg?.intervalSec ?? before.intervalSec, title: cfg?.title ?? before.title, meName: cfg?.me.name ?? '' }
    if (!cfg) {
      await update($, sync, () => ({ ...base, error: loaded.error }))
      return
    }
    if (!(TOKEN_ENVS as readonly string[]).includes(cfg.tokenEnv)) {
      await update($, sync, () => ({ ...base, error: `tokenEnv 는 ${TOKEN_ENVS.join(', ')} 중 하나여야 합니다` }))
      return
    }
    const { key, name } = await token($, cfg)
    if (!key) {
      await update($, sync, () => ({ ...base, error: `토큰이 없습니다. ${TOKEN_TODO}` }))
      return
    }
    let list: Issue[]
    try {
      list = await fetchAll($, cfg, key, name)
    } catch (error) {
      await update($, sync, () => ({ ...base, error: String((error as Error)?.message ?? error).slice(0, 160) }))
      return
    }
    // 지난 동기화(이전 세션 포함)의 상태 지도와 견준다.
    const prev = ((await $.store.get('snapshot')) ?? undefined) as Record<string, string> | undefined
    const kept = ((await $.store.get('changes')) ?? []) as Change[]
    const merged = mergeChanges(kept, diff(prev, list, now), now)
    await $.store.set('snapshot', statusMap(list))
    await $.store.set('changes', merged)
    await update($, issues, () => list)
    await update($, changes, () => merged)
    await update($, sync, () => ({ ...base, at: now, error: '' }))
  } catch (error) {
    $.ui.log(`notion-board: ${String(error).slice(0, 120)}`, { to: 'debug' })
  } finally {
    busy = false
  }
}

// ---- 그리기 도우미 ----
const ago = (ms: number) => {
  if (!ms) return '아직'
  const m = Math.round((Date.now() - ms) / 60000)
  return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`
}
const shortDate = (d: string) => (d ? `${d.slice(5, 7)}/${d.slice(8, 10)}` : '')
const priorityColor = (p: string) => (/높|high|urgent/i.test(p) ? 'error' : /중|med/i.test(p) ? 'warning' : 'inactive')

type View = { list: Issue[]; all: Issue[]; changed: Map<string, Change>; f: Filter; s: Sync; today: string; done: string[] }

async function view($: any): Promise<View> {
  const all = await read($, issues)
  const f = await read($, filter)
  const s = await read($, sync)
  const changed = new Map((await read($, changes)).map(c => [c.pageId, c]))
  const cfg = config ?? { doneStatuses: [], statusOrder: [], me: { userId: '', name: '' } }
  const today = todayKst(Date.now())
  const list = sortIssues(applyFilter(all, f, cfg), new Set(changed.keys()), today, cfg)
  return { list, all, changed, f, s, today, done: cfg.doneStatuses }
}

function headline(v: View, order: string[]): string {
  const counts = countByStatus(v.all, order).map(([s, n]) => `${s} ${n}`).join(' · ')
  return `${v.s.title} · ${counts || '0건'}`
}

function syncLine(v: View): string {
  const when = `동기화 ${ago(v.s.at)}(${Math.round(v.s.intervalSec / 60)}분마다)`
  return `${describeFilter(v.f, v.s.meName)} ${v.list.length}건 · ${when}`
}

// 고정 폭 열: 표시(1) ID(8) 고객사 상태 중요도 담당 목표일 제목(남은 폭). 열 사이 한 칸.
type Cols = { mark: number; id: number; customer: number; status: number; priority: number; owner: number; due: number; title: number }
function columns(width: number): Cols {
  const narrow = width < 100
  const c = { mark: 1, id: 8, customer: narrow ? 8 : 12, status: 8, priority: 4, owner: narrow ? 6 : 8, due: 5, title: 0 }
  const used = c.mark + c.id + c.customer + c.status + c.priority + c.owner + c.due + 7
  return { ...c, title: Math.max(8, width - used) }
}

function drawTable($: any, e: any, v: View, rows: Issue[], width: number) {
  const { Box, Text } = $.ui.resolve(e)
  const c = columns(width)
  const header = (
    <Text dimColor wrap="truncate">
      {fit('', c.mark)} {fit('ID', c.id)} {fit('고객사', c.customer)} {fit('상태', c.status)} {fit('중요', c.priority)} {fit('담당', c.owner)} {fit('목표', c.due)} {fit('제목', c.title)}
    </Text>
  )
  const body = rows.map(i => {
    const ch = v.changed.get(i.pageId)
    const late = isOverdue(i, v.today, v.done)
    const mark = ch ? (ch.kind === 'new' ? '●' : '↻') : ' '
    const title = ch?.kind === 'status' && ch.from ? `${i.title} (${ch.from}→${i.status})` : i.title
    return (
      <Box>
        <Text color="claude" wrap="truncate">{fit(mark, c.mark)} </Text>
        <Text bold={ch !== undefined} wrap="truncate">{fit(i.id, c.id)} </Text>
        <Text color="subtle" wrap="truncate">{fit(i.customer, c.customer)} </Text>
        <Text color={themeOf(i.statusColor)} wrap="truncate">{fit(i.status, c.status)} </Text>
        <Text color={priorityColor(i.priority)} wrap="truncate">{fit(i.priority, c.priority)} </Text>
        <Text wrap="truncate">{fit(i.owners.join(','), c.owner)} </Text>
        <Text color={late ? 'error' : undefined} bold={late} wrap="truncate">{fit(shortDate(i.due), c.due)} </Text>
        <Text bold={ch !== undefined} wrap="truncate">{fit(title, c.title)}</Text>
      </Box>
    )
  })
  return { Box, Text, header, body }
}

async function setMode($: any, next: BoardMode) {
  await update($, mode, () => next)
  if (next === 'pane') await $.ui.open({ id: PANE, title: '노션 이슈' })
  else await $.ui.close({ id: PANE })
}

async function setFilter($: any, fn: (f: Filter) => Filter): Promise<Filter> {
  const next = fn(await read($, filter))
  await update($, filter, () => next)
  await $.store.set('filter', next)
  return next
}

const HELP =
  '/notion-board: 프롬프트 위 표 · right: 패널 · off: 숨김 · me: 내 담당 · customer <이름> · status <상태> · wed: 표시 칸(수요일까지 등) · all: 끝난 것 포함 · clear: 거르기 초기화 · sync: 지금 갱신'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'notion-board', description: `노션 이슈 현황(읽기 전용). ${HELP}` })
    const loaded = await loadConfig($)
    config = loaded.cfg
    const saved = (await $.store.get('filter')) as Filter | undefined
    if (saved && typeof saved === 'object') await update($, filter, () => ({ ...EMPTY_FILTER, ...saved }))
    else if (config) await update($, filter, () => ({ ...EMPTY_FILTER, ...config!.defaultFilter }))
    const keptChanges = ((await $.store.get('changes')) ?? []) as Change[]
    await update($, changes, () => keptChanges)
    if ((await read($, mode)) === 'pane') void $.ui.open({ id: PANE, title: '노션 이슈' })
    void refresh($, true)
    $.clock.every(TICK_MS, () => void refresh($))
    return next(e)
  })

  on('command.run', { command: 'notion-board' }, async ($, e) => {
    const [word = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = word.toLowerCase()
    const value = rest.join(' ').trim()
    const meName = (await read($, sync)).meName
    const said = (f: Filter) => ({ text: `거르기: ${describeFilter(f, meName)}` })
    switch (arg) {
      case 'right':
      case 'pane':
        await setMode($, 'pane')
        return { text: '노션 이슈를 패널로 엽니다. /notion-board 로 프롬프트 위 표로 돌아갑니다.' }
      case 'off':
      case 'hide':
        await setMode($, 'off')
        return { text: '노션 이슈 표를 숨겼습니다. /notion-board 로 다시 켭니다.' }
      case 'me':
        return said(await setFilter($, f => ({ ...f, me: !f.me })))
      case 'wed':
      case 'flag':
        return said(await setFilter($, f => ({ ...f, flag: !f.flag })))
      case 'all':
        return said(await setFilter($, f => ({ ...f, all: !f.all })))
      case 'customer':
        return said(await setFilter($, f => ({ ...f, customer: value })))
      case 'status':
        return said(await setFilter($, f => ({ ...f, status: value })))
      case 'clear':
      case 'reset':
        return said(await setFilter($, () => ({ ...EMPTY_FILTER, ...(config?.defaultFilter ?? {}) })))
      case 'sync':
      case 'refresh':
        await refresh($, true)
        return { text: (await read($, sync)).error || '노션에서 다시 읽었습니다.' }
      case 'help':
        return { text: HELP }
      default:
        await setMode($, 'band')
        return { text: `노션 이슈를 프롬프트 위 표에 보입니다. ${HELP}` }
    }
  })

  // 프롬프트 바로 위: 머리줄(상태별 개수), 거르기·동기화 줄, 열 제목, 행. 줄 수는 띠가 허락하는 만큼.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, mode)) !== 'band') return next(e)
    const v = await view($)
    if (v.all.length === 0 && !v.s.error) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(40, e.props.bodyColumns ?? 80)
    const room = Math.max(1, (e.props.maxRows ?? 12) - 5)
    const shown = v.list.slice(0, room)
    const { header, body } = drawTable($, e, v, shown, width)
    const more = v.list.length - shown.length
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate">{fit(headline(v, config?.statusOrder ?? []), width)}</Text>
        <Text dimColor wrap="truncate">{fit(syncLine(v), width)}</Text>
        {v.s.error !== '' && <Text color="error" wrap="truncate">{fit(`동기화 실패: ${v.s.error}`, width)}</Text>}
        <Text dimColor wrap="truncate">{'─'.repeat(width)}</Text>
        {shown.length > 0 && header}
        {body}
        {more > 0 && <Text dimColor wrap="truncate">{fit(`+${more}건 더 (/notion-board right)`, width)}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await view($)
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(40, (e.props?.bodyColumns ?? 60) - 1)
    const { header, body } = drawTable($, e, v, v.list, width)
    const byId = new Map(v.all.map(i => [i.pageId, i]))
    const recent = [...v.changed.values()].filter(c => byId.has(c.pageId)).slice(0, 10)
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate">{fit(headline(v, config?.statusOrder ?? []), width)}</Text>
        <Text dimColor wrap="truncate">{fit(syncLine(v), width)}</Text>
        {v.s.error !== '' && <Text color="error" wrap="truncate">{fit(`동기화 실패: ${v.s.error}`, width)}</Text>}
        {recent.length > 0 && <Text bold wrap="truncate">{fit('최근 변경', width)}</Text>}
        {recent.map(c => {
          const i = byId.get(c.pageId)!
          const what = c.kind === 'new' ? `새 이슈 ${i.status}` : `${c.from ?? ''} → ${i.status}`
          return <Text color="claude" wrap="truncate">{fit(`${c.kind === 'new' ? '●' : '↻'} ${i.id} ${what} · ${i.title}`, width)}</Text>
        })}
        <Text dimColor wrap="truncate">{'─'.repeat(width)}</Text>
        {v.all.length === 0 && v.s.error === '' && <Text dimColor>노션에서 읽는 중입니다.</Text>}
        {v.list.length > 0 && header}
        {body}
      </Box>
    )
  })
}
