// 메시지의 주소를 사람이 읽는 이름으로 푼다.
export type Names = {
  byPid: Map<string, string> // pid → sessionId (~/.claude/sessions/<pid>.json)
  bySid: Map<string, string> // sessionId → 세션 이름
  aliases: Record<string, string> // aliases.json: sessionId 앞부분 또는 pid → 역할 이름
}

export function aliasOf(n: Names, sid: string, pid?: string): string | undefined {
  for (const [key, value] of Object.entries(n.aliases)) {
    if (pid !== undefined && key === pid) return value
    if (key.length >= 4 && sid.toLowerCase().startsWith(key.toLowerCase())) return value
  }
  return undefined
}

// 받는 주소는 여러 꼴로 온다.
// - 'me' → 나
// - 'session:<sessionId>' → 별칭 또는 [앞 6자] 이름
// - 'uds:/tmp/cc-socks/<pid>.sock' → 그 pid 의 세션
// - ListAgents 가 보여 준 이름 통째('<cross-session-message from="uds:/tmp/cc-socks/584 [ed7ffa]'):
//   잘린 소켓 pid 앞자리가 한 세션에만 맞으면 그 세션, 아니면 '[ref]'
export function labelOf(n: Names, address: string): string {
  if (address === 'me') return '나'
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
  if (sid) return aliasOf(n, sid, pid) ?? `[${sid.slice(0, 6)}] ${n.bySid.get(sid) ?? ''}`.trim()
  const ref = /\[([0-9a-f]{6})\]\s*$/.exec(address)?.[1]
  if (ref) return `[${ref}]`
  if (pid) return `pid ${pid}`
  return address.length > 40 ? address.slice(0, 39) + '…' : address
}
