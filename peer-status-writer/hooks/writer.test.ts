import { expect, test } from 'claude-code/testing'

test('a TodoWrite is written to the peer-status file', async ($, on) => {
  const written: { path: string; text: string }[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/x', stderr: '' } }))
  on('fs.list', () => ({ value: [] }))
  on('fs.write', (_, e) => {
    written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: '첫 묶음', status: 'completed', activeForm: '첫 묶음 채점' },
      { content: '둘째 묶음', status: 'in_progress', activeForm: '둘째 묶음 채점 중' },
    ],
  })

  // flush 는 기다리지 않는 뒷일이라 잠깐 둔다.
  await new Promise(resolve => setTimeout(resolve, 100))

  const last = written.at(-1)
  expect(last?.path).toBe('/home/x/.claude/peer-status/sess-1.json')
  const record = JSON.parse(last?.text ?? '{}')
  expect(record.doing).toBe('둘째 묶음 채점 중')
  expect(record.todos.length).toBe(2)
  expect(record.todos[0].status).toBe('completed')
})
