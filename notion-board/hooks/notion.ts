import type { Change, Filter, Issue } from '../types'

// 설정 파일(~/.claude/notion-board.json)의 모양. 코드에는 개인 정보·DB id·토큰을 두지 않는다.
export type Props = { id: string; title: string; status: string; customer: string; priority: string; owner: string; due: string; flag: string }
export type Config = {
  dataSourceId: string
  title: string
  notionVersion: string
  intervalSec: number
  maxPages: number
  me: { userId: string; name: string }
  doneStatuses: string[] // 기본으로 숨길 끝난 상태
  statusOrder: string[] // 머리줄 개수와 정렬 순서. 비면 많은 순
  defaultFilter: Partial<Filter>
  props: Props
}

type Json = Record<string, unknown>
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string')

// 열 이름 기본값은 비워 둔다. 제목·상태·번호·수정 시각은 칸의 종류로 찾고, 나머지는 설정에서 이름을 준다.
const EMPTY_PROPS: Props = { id: '', title: '', status: '', customer: '', priority: '', owner: '', due: '', flag: '' }

export function readConfig(raw: unknown): Config | undefined {
  const o = obj(raw)
  const dataSourceId = str(o.dataSourceId).replace(/^collection:\/\//, '').trim()
  if (!dataSourceId) return undefined
  const me = obj(o.me)
  const props = obj(o.props)
  const filter = obj(o.defaultFilter)
  return {
    dataSourceId,
    title: str(o.title, '노션 이슈'),
    notionVersion: str(o.notionVersion, '2025-09-03'),
    intervalSec: Math.max(60, Number(o.intervalSec) || 180),
    maxPages: Math.min(50, Math.max(1, Number(o.maxPages) || 10)),
    me: { userId: str(me.userId), name: str(me.name) },
    doneStatuses: strs(o.doneStatuses),
    statusOrder: strs(o.statusOrder),
    defaultFilter: {
      me: filter.me === true,
      flag: filter.flag === true,
      all: filter.all === true,
      customer: str(filter.customer),
      status: str(filter.status),
    },
    props: { ...EMPTY_PROPS, ...Object.fromEntries(Object.entries(props).filter(([, v]) => typeof v === 'string')) } as Props,
  }
}

const plain = (rich: unknown) => arr(rich).map(r => str(obj(r).plain_text)).join('')

// 이름이 주어지면 그 칸, 아니면 종류가 맞는 첫 칸.
function pick(properties: Json, name: string, type: string): Json | undefined {
  if (name && properties[name]) return obj(properties[name])
  if (name) return undefined
  for (const value of Object.values(properties)) if (obj(value).type === type) return obj(value)
  return undefined
}

function textOf(p: Json | undefined): string {
  if (!p) return ''
  switch (p.type) {
    case 'title': return plain(p.title)
    case 'rich_text': return plain(p.rich_text)
    case 'select': return str(obj(p.select).name)
    case 'status': return str(obj(p.status).name)
    case 'multi_select': return arr(p.multi_select).map(x => str(obj(x).name)).join(', ')
    case 'formula': return str(obj(p.formula).string)
    default: return ''
  }
}

export function toIssue(page: unknown, props: Props): Issue | undefined {
  const pg = obj(page)
  const pageId = str(pg.id)
  if (!pageId || pg.in_trash === true || pg.archived === true) return undefined
  const properties = obj(pg.properties)
  const idProp = pick(properties, props.id, 'unique_id')
  const uid = obj(idProp?.unique_id)
  const num = typeof uid.number === 'number' ? uid.number : typeof idProp?.number === 'number' ? (idProp.number as number) : 0
  const prefix = str(uid.prefix)
  const statusProp = pick(properties, props.status, 'status')
  const statusValue = obj(statusProp?.status ?? statusProp?.select)
  const people = arr(pick(properties, props.owner, 'people')?.people).map(obj)
  const due = str(obj(pick(properties, props.due, '__none__')?.date).start).slice(0, 10)
  const flagProp = props.flag ? pick(properties, props.flag, 'checkbox') : undefined
  return {
    pageId,
    id: num ? (prefix ? `${prefix}-${num}` : String(num)) : pageId.replace(/-/g, '').slice(0, 6),
    num,
    title: textOf(pick(properties, props.title, 'title')).replace(/\s+/g, ' ').trim(),
    status: str(statusValue.name),
    statusColor: str(statusValue.color, 'default'),
    customer: textOf(props.customer ? pick(properties, props.customer, '__none__') : undefined),
    priority: textOf(props.priority ? pick(properties, props.priority, '__none__') : undefined),
    owners: people.map(p => str(p.name) || str(p.id).replace(/-/g, '').slice(0, 6)),
    ownerIds: people.map(p => str(p.id)),
    due,
    flag: obj(flagProp).checkbox === true,
    edited: str(pg.last_edited_time),
    url: str(pg.url),
  }
}

// 지난 동기화의 { pageId: 상태 } 와 새 목록을 견주어 새 이슈·상태 변경을 찾는다. 처음(이전이 없을 때)은 표시하지 않는다.
export function diff(prev: Record<string, string> | undefined, next: Issue[], now: number): Change[] {
  if (!prev || Object.keys(prev).length === 0) return []
  const out: Change[] = []
  for (const issue of next) {
    const old = prev[issue.pageId]
    if (old === undefined) out.push({ pageId: issue.pageId, kind: 'new', at: now })
    else if (old !== issue.status) out.push({ pageId: issue.pageId, kind: 'status', from: old, at: now })
  }
  return out
}

export const statusMap = (list: Issue[]): Record<string, string> => Object.fromEntries(list.map(i => [i.pageId, i.status]))

// 새로 찾은 변경을 앞에 두고, 같은 이슈의 옛 표시는 지우고, 하루 지난 것은 버린다.
export function mergeChanges(kept: Change[], fresh: Change[], now: number, keepMs = 24 * 3600_000): Change[] {
  const ids = new Set(fresh.map(c => c.pageId))
  return [...fresh, ...kept.filter(c => !ids.has(c.pageId) && now - c.at < keepMs)].slice(0, 50)
}

export const todayKst = (now: number) => new Date(now + 9 * 3600_000).toISOString().slice(0, 10)
export const isOverdue = (issue: Issue, today: string, done: string[]) => issue.due !== '' && issue.due < today && !done.includes(issue.status)

export function applyFilter(list: Issue[], f: Filter, cfg: Pick<Config, 'doneStatuses' | 'me'>): Issue[] {
  const customer = f.customer.toLowerCase()
  return list.filter(i => {
    if (!f.all && !f.status && cfg.doneStatuses.includes(i.status)) return false
    if (f.status && i.status !== f.status) return false
    if (customer && !i.customer.toLowerCase().includes(customer)) return false
    if (f.flag && !i.flag) return false
    if (f.me) {
      const byId = cfg.me.userId !== '' && i.ownerIds.includes(cfg.me.userId)
      const byName = cfg.me.name !== '' && i.owners.includes(cfg.me.name)
      if (!byId && !byName) return false
    }
    return true
  })
}

// 정렬: 최근 변경 → 목표일 지남 → 상태 순서 → 목표일 이른 순 → 번호 큰 순.
export function sortIssues(list: Issue[], changed: Set<string>, today: string, cfg: Pick<Config, 'doneStatuses' | 'statusOrder'>): Issue[] {
  const rank = (s: string) => {
    const i = cfg.statusOrder.indexOf(s)
    return i < 0 ? cfg.statusOrder.length : i
  }
  return [...list].sort((a, b) =>
    Number(changed.has(b.pageId)) - Number(changed.has(a.pageId)) ||
    Number(isOverdue(b, today, cfg.doneStatuses)) - Number(isOverdue(a, today, cfg.doneStatuses)) ||
    rank(a.status) - rank(b.status) ||
    (a.due || '9999').localeCompare(b.due || '9999') ||
    b.num - a.num,
  )
}

export function countByStatus(list: Issue[], order: string[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const i of list) counts.set(i.status || '-', (counts.get(i.status || '-') ?? 0) + 1)
  const known = order.filter(s => counts.has(s)).map(s => [s, counts.get(s)!] as [string, number])
  const rest = [...counts.entries()].filter(([s]) => !order.includes(s)).sort((a, b) => b[1] - a[1])
  return [...known, ...rest]
}

// 노션 색 → 터미널 테마 색
export function themeOf(notionColor: string): string {
  switch (notionColor) {
    case 'red': return 'error'
    case 'orange': return 'claude'
    case 'yellow': return 'warning'
    case 'green': return 'success'
    case 'blue': return 'suggestion'
    case 'purple': return 'merged'
    case 'pink': return 'remember'
    case 'brown': return 'subtle'
    default: return 'inactive'
  }
}

export function describeFilter(f: Filter, meName: string): string {
  const parts: string[] = []
  if (f.me) parts.push(`담당 ${meName || '나'}`)
  if (f.customer) parts.push(`고객사 ${f.customer}`)
  if (f.status) parts.push(`상태 ${f.status}`)
  if (f.flag) parts.push('표시한 것만')
  if (f.all) parts.push('끝난 것 포함')
  return parts.length ? parts.join(', ') : '열린 이슈 전체'
}
