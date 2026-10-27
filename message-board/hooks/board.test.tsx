import { expect, test } from 'claude-code/testing'

import { stringWidth } from './width'

const PANE = {
  plugin: 'message-board',
  component: 'Pane',
  requestId: 'message-board',
  props: { title: '메시지', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const BAND = {
  plugin: 'message-board',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 80, scroll: { offset: 0, bodyRows: 11 }, view: {} },
} as const

const T0 = new Date('2026-01-02T09:05:00').getTime()
const MSGS = [
  { id: 'a', ts: T0, dir: 'user', from: '나', to: 'A · 조율', text: '리뷰 끝나면 알려 줘' },
  { id: 'b', ts: T0 + 60_000, dir: 'out', from: 'A · 조율', to: 'B · 리뷰어', text: '리뷰 부탁. ' + '아주 긴 본문이 이어집니다. '.repeat(12) },
  { id: 'c', ts: T0 + 86_400_000, dir: 'in', from: 'B · 리뷰어', to: 'A · 조율', text: '리뷰 끝. 두 군데 고칠 곳 있음' },
]

const state = (values: Record<string, unknown>) => (_$: unknown, e: unknown) => {
  const key = (e as { key: string }).key
  const shapes: Record<string, string> = { msgs: 'msgs-1', filter: 'filter-1', expanded: 'expanded-1', mode: 'mode-1' }
  const fallback: Record<string, unknown> = { msgs: [], filter: { kind: 'all' }, expanded: false, mode: 'pane' }
  return { value: { value: { shape: shapes[key], value: key in values ? values[key] : fallback[key] }, version: 1 } }
}

test('the pane draws date separators, sender → receiver and a 2-line body', async ($, on) => {
  on('state.get', state({ msgs: MSGS }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /메시지 3\/3/ }))?.text).toContain('전체')
  expect((await ui.find({ type: 'Text', text: /2026-01-02/ }))?.text).toContain('──')
  expect((await ui.find({ type: 'Text', text: /2026-01-03/ }))?.text).toContain('──')
  expect((await ui.find({ type: 'Text', text: /^09:05/ }))?.text).toContain('09:05')
  expect((await ui.find({ type: 'Text', text: /^나$/ }))?.text).toBe('나')
  expect((await ui.find({ type: 'Text', text: /\(입력\)/ }))?.text).toContain('입력')
  // 긴 본문은 두 줄로 접히고 마지막 줄 끝에 … 가 붙는다. 줄마다 폭을 넘지 않는다.
  const long = (await ui.find({ type: 'Text', text: /…$/ }))?.text ?? ''
  expect(long).toContain('…')
  expect(stringWidth(long)).toBeLessThanOrEqual(59)
  await ui.unmount()
})

test('expand shows the whole body', async ($, on) => {
  on('state.get', state({ msgs: MSGS, expanded: true }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /펼침/ }))?.text).toContain('펼침')
  expect(await ui.find({ type: 'Text', text: /…$/ })).toBeUndefined()
  await ui.unmount()
})

test('filter me keeps only what I typed', async ($, on) => {
  on('state.get', state({ msgs: MSGS, filter: { kind: 'me' } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /메시지 1\/3/ }))?.text).toContain('내가 보낸 것')
  expect(await ui.find({ type: 'Text', text: /두 군데/ })).toBeUndefined()
  await ui.unmount()
})

test('filter from matches the sender label', async ($, on) => {
  on('state.get', state({ msgs: MSGS, filter: { kind: 'from', name: '리뷰어' } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /메시지 1\/3/ }))?.text).toContain('보낸이: 리뷰어')
  expect((await ui.find({ type: 'Text', text: /두 군데/ }))?.text).toContain('두 군데')
  await ui.unmount()
})

test('filter to matches the receiver label', async ($, on) => {
  on('state.get', state({ msgs: MSGS, filter: { kind: 'to', name: '조율' } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /메시지 2\/3/ }))?.text).toContain('받는이: 조율')
  await ui.unmount()
})

test('an empty pane says so', async ($, on) => {
  on('state.get', state({}))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /아직/ }))?.text).toContain('기록된 메시지가 없습니다')
  await ui.unmount()
})

test('the band shows the last items only in band mode', async ($, on) => {
  on('state.get', state({ msgs: MSGS, mode: 'band' }))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /두 군데/ }))?.text).toContain('두 군데')
  await ui.unmount()
})

test('the band yields in pane mode', async ($, on) => {
  on('state.get', state({ msgs: MSGS, mode: 'pane' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /두 군데/ })).toBeUndefined()
  await ui.unmount()
})

test('a sent message, a received one and a typed prompt are recorded as files', async ($, on) => {
  const written: { path: string; text: string }[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-abcdef-1' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/x', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.list', () => ({ value: [] }))
  on('fs.write', (_, e) => {
    written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.send', () => ({ isDelivered: true }))
  on('session.receive', (_, e) => ({ text: e.text }))
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.send({ to: 'uds:/tmp/cc-socks/4242.sock', text: '리뷰 부탁', origin: { kind: 'model' } })
  await $.session.receive({ origin: { kind: 'peer' }, text: '<cross-session-message from="uds:/tmp/cc-socks/4242.sock" from-name="x" from-mode="prompting">리뷰 끝</cross-session-message>' })
  await $.prompt.submit({ text: '알려 줘', origin: { kind: 'composer' }, wait: false })
  await $.prompt.submit({ text: '/message-board', origin: { kind: 'composer' }, wait: false })
  // record 는 기다리지 않는 뒷일이라 잠깐 둔다.
  await new Promise<void>(resolve => { const t = Date.now(); const spin = () => (Date.now() - t > 150 ? resolve() : void Promise.resolve().then(spin)); spin() })

  const files = written.map(w => ({ path: w.path, msg: JSON.parse(w.text) }))
  expect(files.length).toBe(3)
  for (const f of files) expect(f.path.startsWith('/home/x/.claude/peer-status/messages/')).toBe(true)
  const out = files.find(f => f.msg.dir === 'out')?.msg
  expect(out?.from).toBe('session:sess-abcdef-1')
  expect(out?.to).toBe('uds:/tmp/cc-socks/4242.sock')
  expect(out?.text).toBe('리뷰 부탁')
  const inn = files.find(f => f.msg.dir === 'in')?.msg
  expect(inn?.from).toBe('uds:/tmp/cc-socks/4242.sock')
  expect(inn?.text).toBe('리뷰 끝')
  const user = files.find(f => f.msg.dir === 'user')?.msg
  expect(user?.from).toBe('me')
  expect(user?.text).toBe('알려 줘')
})
