import { expect, test } from 'claude-code/testing'

import { fit, stringWidth } from './width'

const PANE = {
  plugin: 'session-board',
  component: 'Pane',
  requestId: 'session-board',
  props: { title: '세션 현황', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const band = (bodyColumns: number) => ({
  plugin: 'session-board',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const)

const LONG = '문서를 고치고 테스트 결과를 모아서 다른 세션에 보고할 표를 만드는 중입니다 (아주 긴 설명 예시)'
const ROW = {
  id: 'abc', name: 'B · 리뷰어', alias: true, hasPeer: true, status: 'busy', kind: 'interactive', updatedAt: Date.now(), doing: LONG,
  todos: [{ text: '첫 묶음', done: true }, { text: '둘째 묶음', done: false, active: true }, { text: '셋째 묶음', done: false }],
}
const OLD = { id: 'old', name: '[old123] 옛 세션', alias: false, hasPeer: false, status: 'idle', kind: 'interactive', updatedAt: Date.now() - 3 * 3600_000, todos: [] }

// 값마다 shape 를 붙여 state.get 에 답한다.
const state = (values: Record<string, unknown>) => (_$: unknown, e: unknown) => {
  const key = (e as { key: string }).key
  const shapes: Record<string, string> = { rows: 'rows-1', mode: 'mode-1', frame: 'frame-1', showAll: 'showAll-1' }
  const fallback: Record<string, unknown> = { rows: [], mode: 'band', frame: 0, showAll: false }
  return { value: { value: { shape: shapes[key], value: key in values ? values[key] : fallback[key] }, version: 1 } }
}

test('width: 한글은 2칸, fit 은 자르고 채운다', async () => {
  expect(stringWidth('채점')).toBe(4)
  expect(stringWidth('abc')).toBe(3)
  expect(stringWidth(fit('채점 세션 이름', 7))).toBe(7)
  expect(fit('채점 세션 이름', 7)).toBe('채점 … ')
  expect(fit('ab', 5, 'right')).toBe('   ab')
  expect(stringWidth(fit('한', 4))).toBe(4)
})

test('the pane draws a table row with its todos and progress bar', async ($, on) => {
  on('state.get', state({ rows: [ROW] }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /세션 +갱신 +진행 +하는 일/ }))?.text).toContain('상태')
    expect((await ui.find({ type: 'Text', text: /B · 리뷰어/ }))?.text).toContain('B · 리뷰어')
    expect((await ui.find({ type: 'Text', text: /busy/ }))?.text).toContain('busy')
    expect((await ui.find({ type: 'Text', text: /▰/ }))?.text).toContain('1/3')
    expect((await ui.find({ type: 'Text', text: /첫 묶음/ }))?.text).toContain('✓')
    expect((await ui.find({ type: 'Text', text: /둘째 묶음/ }))?.text).toContain('▶')
    expect((await ui.find({ type: 'Text', text: /셋째 묶음/ }))?.text).toContain('·')
    await ui.unmount()
  }
})

test('an empty board says so', async ($, on) => {
  on('state.get', state({}))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toContain('세션이 없거나')
  await ui.unmount()
})

for (const cols of [80, 160]) {
  test(`the band at ${cols} columns keeps every cell inside its column`, async ($, on) => {
    on('state.get', state({ rows: [ROW] }))

    const ui = await $.ui.mount({ ...band(cols), surface: 'terminal' })
    // 머리줄과 구분선은 폭을 넘지 않는다.
    expect(stringWidth((await ui.find({ type: 'Text', text: /작업 중 1/ }))?.text ?? '')).toBeLessThanOrEqual(cols)
    expect(stringWidth((await ui.find({ type: 'Text', text: /^─+$/ }))?.text ?? '')).toBe(cols)
    // 이름 칸은 고정 폭(좁으면 16, 넓으면 22)이고 상태 칸은 5.
    const name = (await ui.find({ type: 'Text', text: /B · 리뷰어/ }))?.text ?? ''
    expect(stringWidth(name)).toBe((cols < 100 ? 16 : 22) + 1)
    const status = (await ui.find({ type: 'Text', text: /busy/ }))?.text ?? ''
    expect(stringWidth(status)).toBe(1 + 1 + 5 + 1)
    // 하는 일은 남은 폭에서 한 줄로 자른다. 160열이면 다 들어간다.
    const doing = (await ui.find({ type: 'Text', text: /문서를 고치고/ }))?.text ?? ''
    if (cols < 100) expect(doing).toContain('…')
    else expect(doing).toContain('긴 설명 예시')
    // 진행 중 todo 줄은 "하는 일" 열 위치에 맞춰 들여 쓰고 폭을 넘지 않는다.
    const todo = (await ui.find({ type: 'Text', text: /둘째 묶음/ }))?.text ?? ''
    expect(todo.startsWith(' '.repeat(cols < 100 ? 1 + 1 + 5 + 1 + 16 + 1 + 9 + 1 + 11 + 1 : 1 + 1 + 5 + 1 + 22 + 1 + 9 + 1 + 16 + 1))).toBe(true)
    expect(stringWidth(todo)).toBeLessThanOrEqual(cols)
    expect(await ui.find({ type: 'Text', text: /첫 묶음/ })).toBeUndefined()
    await ui.unmount()
  })
}

test('the band hides a stale unnamed session and counts it', async ($, on) => {
  on('state.get', state({ rows: [ROW, OLD] }))

  const ui = await $.ui.mount({ ...band(80), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /옛 세션/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /숨김/ }))?.text).toContain('+1개 숨김')
  await ui.unmount()
})

test('the band shows the stale session when showAll is on', async ($, on) => {
  on('state.get', state({ rows: [ROW, OLD], showAll: true }))

  const ui = await $.ui.mount({ ...band(80), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /옛 세션/ }))?.text).toContain('옛 세션')
  await ui.unmount()
})

test('the band yields when the mode is pane', async ($, on) => {
  on('state.get', state({ rows: [ROW], mode: 'pane' }))
  // 띠가 비켜 주면 엔진 몫이 그려진다. 여기서는 짧은 글로 대신한다.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const ui = await $.ui.mount({ ...band(80), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /B · 리뷰어/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toContain('engine')
  await ui.unmount()
})
