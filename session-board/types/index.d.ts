export type Todo = { text: string; done: boolean; active?: boolean }
export type Row = {
  id: string
  name: string
  alias: boolean // aliases.json 에 역할 이름이 있는 세션
  hasPeer: boolean // peer-status 파일을 스스로 쓰는 세션
  status: string
  kind: string
  updatedAt: number
  doing?: string
  todos: Todo[]
}
// band: 프롬프트 위 띠에 세션당 한 줄(기본). pane: 오른쪽(또는 inline) 패널 상세 보기. off: 안 보임.
export type BoardMode = 'band' | 'pane' | 'off'
// 띠·패널 맨 위에 보일 최근 메시지(message-board 파일에서 읽음)
export type RecentMsg = { ts: number; from: string; to: string; text: string; isUser: boolean }

declare module 'claude-code' {
  interface PluginState {
    'session-board': {
      rows: Shaped<Row[]>
      mode: Shaped<BoardMode>
      frame: Shaped<number> // 스피너 프레임 번호
      showAll: Shaped<boolean> // 오래 멈춘 이름 없는 세션까지 보이기
      msgsOn: Shaped<boolean> // 최근 메시지 칸 켜기
      recent: Shaped<RecentMsg[]>
    }
  }
}
