// 노션 이슈 한 건을 표에 그릴 만큼만 줄인 값.
export type Issue = {
  pageId: string
  id: string // "ATL-129" 처럼 화면에 보일 번호. 번호 칸이 없으면 페이지 id 앞 6자
  num: number // 정렬용 번호(없으면 0)
  title: string
  status: string
  statusColor: string // 노션 색 이름(red, green …)
  customer: string
  priority: string
  owners: string[] // 담당자 이름(이름을 못 받으면 id 앞 6자)
  ownerIds: string[]
  due: string // YYYY-MM-DD, 없으면 ''
  flag: boolean // "수요일까지" 같은 체크 칸
  edited: string // 마지막 수정 ISO 시각
  url: string
}

// 지난 동기화 이후 바뀐 것. new: 새 이슈, status: 상태 변경.
export type Change = { pageId: string; kind: 'new' | 'status'; from?: string; at: number }

// 사용자가 고른 거르기. 비어 있으면 설정 파일의 defaultFilter 를 따른다.
export type Filter = { me: boolean; flag: boolean; all: boolean; customer: string; status: string }

export type Sync = {
  at: number // 마지막으로 성공한 동기화(ms), 0 이면 아직 없음
  tried: number // 마지막 시도(ms)
  error: string // 마지막 시도가 실패했으면 그 이유(토큰 값은 담지 않는다)
  intervalSec: number
  title: string // 보드 머리에 쓸 DB 이름
  meName: string
}

// band: 프롬프트 위 표(기본). pane: 오른쪽(또는 inline) 패널 상세. off: 안 보임.
export type BoardMode = 'band' | 'pane' | 'off'

declare module 'claude-code' {
  interface PluginState {
    'notion-board': {
      issues: Shaped<Issue[]>
      changes: Shaped<Change[]>
      filter: Shaped<Filter>
      sync: Shaped<Sync>
      mode: Shaped<BoardMode>
    }
  }
}
