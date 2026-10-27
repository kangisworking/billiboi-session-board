// 메시지·세션의 주소를 사람이 읽는 이름과 고정 색으로 푼다. session-board 와 message-board 가 같은 파일을 쓴다.
export type Names = {
  byPid: Map<string, string> // pid → sessionId (~/.claude/sessions/<pid>.json)
  bySid: Map<string, string> // sessionId → 세션 이름
  aliases: Record<string, string> // aliases.json: sessionId 앞부분 또는 pid → 역할 이름
  colors: Record<string, string> // colors.json(또는 aliases.json 의 "colors"): sessionId 앞부분·pid·이름 → 색
}

// 세션 자동 색. 어두운·밝은 배경에서 다 읽히는 중간 밝기, 상태색(초록·노랑·빨강)과 겹치지 않게.
export const PALETTE = ['#5fafff', '#d787ff', '#ff87af', '#5fd7d7', '#ffaf5f', '#87afff', '#af87ff', '#ff87d7', '#5fd7af', '#d7af87']
export const ME_COLOR = 'claude' // "나"(사용자)는 고정

export const hashOf = (s: string) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}

export function aliasOf(n: Names, sid: string, pid?: string): string | undefined {
  for (const [key, value] of Object.entries(n.aliases)) {
    if (pid !== undefined && key === pid) return value
    if (key.length >= 4 && sid.toLowerCase().startsWith(key.toLowerCase())) return value
  }
  return undefined
}

export type Resolved = { label: string; sid?: string; pid?: string }

// 주소는 여러 꼴로 온다.
// - 'me' → 나
// - 'session:<sessionId>' → 별칭 또는 [앞 6자] 이름
// - 'uds:/tmp/cc-socks/<pid>.sock' → 그 pid 의 세션
// - ListAgents 가 보여 준 이름 통째('<cross-session-message from="uds:/tmp/cc-socks/11 [abc123]'):
//   잘린 소켓 pid 앞자리가 한 세션에만 맞으면 그 세션, 아니면 '[ref]'
export function resolve(n: Names, address: string): Resolved {
  if (address === 'me') return { label: '나' }
  let sid = ''
  let pid: string | undefined
  if (address.startsWith('session:')) sid = address.slice(8)
  const sock = /cc-socks\/(\d+)\.sock/.exec(address)
  if (sock) {
    pid = sock[1]
    sid = n.byPid.get(pid ?? '') ?? ''
  } else {
    const partial = /cc-socks\/(\d+)/.exec(address)?.[1]
    if (partial) {
      const hits = [...n.byPid.keys()].filter(p => p.startsWith(partial))
      if (hits.length === 1) {
        pid = hits[0]
        sid = n.byPid.get(pid ?? '') ?? ''
      }
    }
  }
  if (sid) return { label: aliasOf(n, sid, pid) ?? `[${sid.slice(0, 6)}] ${n.bySid.get(sid) ?? ''}`.trim(), sid, pid }
  const ref = /\[([0-9a-f]{6})\]\s*$/.exec(address)?.[1]
  if (ref) return { label: `[${ref}]` }
  if (pid) return { label: `pid ${pid}`, pid }
  return { label: address.length > 40 ? address.slice(0, 39) + '…' : address }
}

export const labelOf = (n: Names, address: string) => resolve(n, address).label

// 세션(또는 이름)의 고정 색. colors 설정이 sessionId 앞부분·pid·이름과 맞으면 그 색, 아니면 sessionId(없으면 이름) 해시로 팔레트에서.
export function colorOf(n: Names, r: Resolved): string {
  if (r.label === '나') return ME_COLOR
  for (const [key, value] of Object.entries(n.colors)) {
    if (!value) continue
    if (r.pid !== undefined && key === r.pid) return value
    if (r.sid && key.length >= 4 && r.sid.toLowerCase().startsWith(key.toLowerCase())) return value
    if (key === r.label) return value
  }
  return PALETTE[hashOf(r.sid || r.label) % PALETTE.length] ?? PALETTE[0]!
}
export const colorFor = (n: Names, address: string) => colorOf(n, resolve(n, address))
