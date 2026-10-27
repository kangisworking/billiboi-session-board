import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Task } from '../types'

// 이 세션의 TodoWrite / TaskCreate / TaskUpdate 를 받아
// ~/.claude/peer-status/<sessionId>.json 에 { name, doing, todos[] } 로 남긴다.
// session-board 모드가 그 파일을 읽어 패널에 그린다. 대화 내용은 쓰지 않는다.

const tasks = atom({ plugin: 'peer-status-writer', key: 'tasks' } as const, [], {
  shape: 'tasks-1',
})

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

async function home($: any): Promise<string> {
  const { stdout } = await $.process.run(['sh', '-c', 'printf %s "$HOME"'], { timeoutMs: 5000 })
  return String(stdout).trim()
}

async function sessionName($: any, base: string, sessionId: string): Promise<string> {
  try {
    for (const entry of (await $.fs.list(`${base}/sessions`)) as { name: string; kind: string }[]) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      try {
        const meta = JSON.parse(await $.fs.read(`${base}/sessions/${entry.name}`))
        if (meta && meta.sessionId === sessionId) return str(meta.name)
      } catch {
        // 깨진 파일은 건너뛴다
      }
    }
  } catch {
    // sessions 폴더가 없으면 이름 없이 쓴다
  }
  return ''
}

async function flush($: any) {
  try {
    const list = (await read($, tasks)).filter(t => t.status !== 'deleted')
    const sessionId = await $.session.id()
    const base = `${await home($)}/.claude`
    const active = list.find(t => t.status === 'in_progress')
    const record = {
      sessionId,
      name: await sessionName($, base, sessionId),
      doing: active ? str(active.active, active.text) : '',
      todos: list.map(t => ({ text: t.text, status: t.status })),
      updatedAt: Date.now(),
    }
    await $.fs.write(`${base}/peer-status/${sessionId}.json`, JSON.stringify(record, null, 2) + '\n')
  } catch (error) {
    $.ui.log(`peer-status-writer: ${String(error).slice(0, 120)}`, { to: 'debug' })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void flush($)
    return started
  })

  // TodoWrite 는 목록 전체를 보내므로 그대로 바꿔 끼운다.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const next_: Task[] = (e.todos ?? []).map((t, i) => ({
        id: `todo-${i}`,
        text: str(t.content),
        status: t.status,
        active: str(t.activeForm) || undefined,
      }))
      await update($, tasks, () => next_)
      void flush($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const id = ran.deny === undefined && ran.isError !== true ? ran.result?.task?.id : undefined
    if (typeof id === 'string') {
      const task: Task = { id, text: str(e.subject), status: 'pending', active: str(e.activeForm) || undefined }
      await update($, tasks, list => [...list.filter(t => t.id !== id), task].slice(-50))
      void flush($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await update($, tasks, list =>
        list.map(t =>
          t.id === e.taskId
            ? {
                ...t,
                text: e.subject ?? t.text,
                status: e.status ?? t.status,
                active: e.activeForm ?? t.active,
              }
            : t,
        ),
      )
      void flush($)
    }
    return ran
  }).catch(($, e, next) => next(e))
}
