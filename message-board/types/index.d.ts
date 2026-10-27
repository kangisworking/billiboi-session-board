// 메시지 한 건. 각 세션의 모드가 ~/.claude/peer-status/messages/<YYYY-MM-DD>/<ts>-<sid6>-<dir>.json 으로 남긴다.
export type Msg = {
  id: string // 파일 이름(중복 제거 키)
  ts: number // epoch ms
  dir: 'out' | 'in' | 'user' // out: 이 세션이 보냄, in: 이 세션이 받음, user: 사용자가 이 세션에 입력
  from: string // 'me' | 'session:<sessionId>' | 받은 메시지의 from 주소(uds:... 등) | 이름
  to: string // 'session:<sessionId>' | 보낼 때 적은 주소·이름
  text: string // 앞 500자
}
export type Filter = { kind: 'all' | 'me' | 'from' | 'to'; name?: string }
export type BoardMode = 'pane' | 'band' | 'off'

declare module 'claude-code' {
  interface PluginState {
    'message-board': {
      msgs: Shaped<Msg[]>
      filter: Shaped<Filter>
      expanded: Shaped<boolean>
      mode: Shaped<BoardMode>
    }
  }
}
