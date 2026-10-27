import { expect, test } from 'claude-code/testing'

import { applyFilter, countByStatus, diff, isOverdue, mergeChanges, readConfig, sortIssues, statusMap, toIssue, tokenOrder } from './notion'
import { stringWidth } from './width'

// 가짜 데이터만 쓴다(실제 이슈·사람 이름 없음).
const CFG = readConfig({
  dataSourceId: 'collection://00000000-0000-0000-0000-000000000000',
  me: { userId: 'u-me', name: '담당자A' },
  doneStatuses: ['해결', '미반영'],
  statusOrder: ['접수', '진행중', '재확인', '조치완료', '해결'],
  props: { customer: '고객사', priority: '중요도', owner: '담당 개발자', due: '목표일', flag: '수요일까지' },
})!

const page = (n: number, status: string, color: string, extra: Record<string, unknown> = {}) => ({
  object: 'page',
  id: `p-${n}`,
  url: `https://example.invalid/p-${n}`,
  last_edited_time: '2026-10-27T01:00:00.000Z',
  properties: {
    '이슈 ID': { type: 'unique_id', unique_id: { prefix: 'ATL', number: n } },
    이슈사항: { type: 'title', title: [{ plain_text: `가짜 이슈 ${n} 화면이 안 열림` }] },
    상태: { type: 'status', status: { name: status, color } },
    고객사: { type: 'select', select: { name: '가짜고객' } },
    중요도: { type: 'select', select: { name: '높음' } },
    '담당 개발자': { type: 'people', people: [{ id: 'u-me', name: '담당자A' }] },
    목표일: { type: 'date', date: { start: '2026-10-20' } },
    수요일까지: { type: 'checkbox', checkbox: n % 2 === 0 },
    ...extra,
  },
})

test('config: 경로 접두어를 떼고 기본값을 채운다, dataSourceId 없으면 undefined', async () => {
  expect(CFG.dataSourceId).toBe('00000000-0000-0000-0000-000000000000')
  expect(CFG.intervalSec).toBe(180)
  expect(CFG.tokenEnv).toBe('NOTION_BOARD_TOKEN')
  expect(tokenOrder(CFG.tokenEnv)).toEqual(['NOTION_BOARD_TOKEN', 'NOTION_API_KEY', 'NOTION_TOKEN'])
  expect(tokenOrder('NOTION_TOKEN')).toEqual(['NOTION_TOKEN', 'NOTION_BOARD_TOKEN', 'NOTION_API_KEY'])
  expect(readConfig({ dataSourceId: 'x', tokenEnv: 'NOTION_API_KEY' })!.tokenEnv).toBe('NOTION_API_KEY')
  expect(readConfig({})).toBe(undefined)
  expect(readConfig({ dataSourceId: 'x', intervalSec: 5 })!.intervalSec).toBe(60)
})

test('toIssue: 노션 칸을 표 한 줄로 줄인다', async () => {
  const i = toIssue(page(129, '진행중', 'blue'), CFG.props)!
  expect(i.id).toBe('ATL-129')
  expect(i.title).toBe('가짜 이슈 129 화면이 안 열림')
  expect(i.status).toBe('진행중')
  expect(i.statusColor).toBe('blue')
  expect(i.customer).toBe('가짜고객')
  expect(i.owners).toEqual(['담당자A'])
  expect(i.due).toBe('2026-10-20')
  expect(i.flag).toBe(false)
  expect(toIssue({ ...page(1, '접수', 'gray'), in_trash: true }, CFG.props)).toBe(undefined)
})

test('diff: 처음엔 표시 없음, 다음 동기화에서 새 이슈와 상태 변경을 찾는다', async () => {
  const a = [toIssue(page(1, '접수', 'gray'), CFG.props)!, toIssue(page(2, '진행중', 'blue'), CFG.props)!]
  expect(diff(undefined, a, 1)).toEqual([])
  const b = [toIssue(page(1, '조치완료', 'orange'), CFG.props)!, a[1]!, toIssue(page(3, '접수', 'gray'), CFG.props)!]
  const found = diff(statusMap(a), b, 2)
  expect(found).toEqual([
    { pageId: 'p-1', kind: 'status', from: '접수', at: 2 },
    { pageId: 'p-3', kind: 'new', at: 2 },
  ])
  // 하루 지난 표시는 버리고 같은 이슈는 새 것으로 바꾼다.
  const merged = mergeChanges([{ pageId: 'p-1', kind: 'new', at: 0 }, { pageId: 'p-9', kind: 'new', at: 0 }], found, 100, 50)
  expect(merged.map(c => c.pageId)).toEqual(['p-1', 'p-3'])
})

test('filter·sort: 끝난 상태 숨김, me·flag·고객사, 변경·지남 먼저', async () => {
  const list = [
    toIssue(page(1, '해결', 'green'), CFG.props)!,
    toIssue(page(2, '접수', 'gray', { 목표일: { type: 'date', date: null } }), CFG.props)!,
    toIssue(page(3, '진행중', 'blue', { '담당 개발자': { type: 'people', people: [{ id: 'u-x', name: '담당자B' }] } }), CFG.props)!,
  ]
  const base = { me: false, flag: false, all: false, customer: '', status: '' }
  expect(applyFilter(list, base, CFG).map(i => i.id)).toEqual(['ATL-2', 'ATL-3'])
  expect(applyFilter(list, { ...base, all: true }, CFG).length).toBe(3)
  expect(applyFilter(list, { ...base, me: true }, CFG).map(i => i.id)).toEqual(['ATL-2'])
  expect(applyFilter(list, { ...base, flag: true }, CFG).map(i => i.id)).toEqual(['ATL-2'])
  expect(applyFilter(list, { ...base, customer: '가짜' }, CFG).length).toBe(2)
  expect(isOverdue(list[2]!, '2026-10-27', CFG.doneStatuses)).toBe(true)
  expect(isOverdue(list[0]!, '2026-10-27', CFG.doneStatuses)).toBe(false)
  const sorted = sortIssues(list, new Set(['p-2']), '2026-10-27', CFG)
  expect(sorted.map(i => i.id)).toEqual(['ATL-2', 'ATL-3', 'ATL-1'])
  expect(countByStatus(list, CFG.statusOrder)).toEqual([['접수', 1], ['진행중', 1], ['해결', 1]])
})

// ---- 화면 ----
const ISSUES = [
  toIssue(page(315, '재확인', 'red'), CFG.props)!,
  toIssue(page(129, '진행중', 'blue', { 목표일: { type: 'date', date: { start: '2099-01-01' } } }), CFG.props)!,
]
const SYNC = { at: Date.now() - 120_000, tried: Date.now(), error: '', intervalSec: 180, title: '이슈 DB', meName: '담당자A' }
const state = (values: Record<string, unknown>) => (_$: unknown, e: unknown) => {
  const key = (e as { key: string }).key
  const shapes: Record<string, string> = { issues: 'issues-1', changes: 'changes-1', filter: 'filter-1', sync: 'sync-1', mode: 'mode-1' }
  const fallback: Record<string, unknown> = {
    issues: [], changes: [], filter: { me: false, flag: false, all: false, customer: '', status: '' }, sync: SYNC, mode: 'band',
  }
  return { value: { value: { shape: shapes[key], value: key in values ? values[key] : fallback[key] }, version: 1 } }
}
const band = (bodyColumns: number) => ({
  plugin: 'notion-board',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns, scroll: { offset: 0, bodyRows: 11 }, view: {} },
} as const)
const PANE = {
  plugin: 'notion-board',
  component: 'Pane',
  requestId: 'notion-board',
  props: { title: '노션 이슈', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

for (const cols of [80, 160]) {
  test(`band ${cols}칸: 머리줄 개수, 표 행, 변경 표시, 모든 줄이 폭 안`, async ($, on) => {
    on('state.get', state({ issues: ISSUES, changes: [{ pageId: 'p-315', kind: 'status', from: '조치완료', at: Date.now() }] }))
    const ui = await $.ui.mount({ ...band(cols), surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /재확인 1/ }))?.text).toContain('진행중 1')
    expect((await ui.find({ type: 'Text', text: /동기화 2분 전/ }))?.text).toContain('3분마다')
    const row = await ui.findAll({ type: 'Text', text: /ATL-315/ })
    expect(row.length > 0).toBe(true)
    expect((await ui.find({ type: 'Text', text: /↻/ }))?.text).toContain('↻')
    for (const t of await ui.findAll({ type: 'Text' })) expect(stringWidth(t.text ?? '') <= cols).toBe(true)
    await ui.unmount()
  })
}

test('band: 데이터도 오류도 없으면 아무것도 그리지 않는다', async ($, on) => {
  on('state.get', state({ sync: { ...SYNC, at: 0 } }))
  let passed = false
  on('ui.render', ($, e) => {
    passed = true
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const ui = await $.ui.mount({ ...band(100), surface: 'terminal' })
  expect(passed).toBe(true)
  expect(await ui.find({ type: 'Text', text: /동기화/ })).toBe(undefined)
  await ui.unmount()
})

test('pane: 최근 변경 목록과 동기화 실패 사유를 보인다', async ($, on) => {
  on('state.get', state({ issues: ISSUES, changes: [{ pageId: 'p-129', kind: 'new', at: Date.now() }], sync: { ...SYNC, error: '이 DB 가 통합에 공유되지 않았습니다' } }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /최근 변경/ }))?.text).toContain('최근 변경')
    expect((await ui.find({ type: 'Text', text: /● ATL-129 새 이슈/ }))?.text).toContain('진행중')
    expect((await ui.find({ type: 'Text', text: /동기화 실패/ }))?.text).toContain('공유되지 않았습니다')
    await ui.unmount()
  }
})
