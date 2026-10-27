# notion-board

노션 데이터베이스(이슈 DB 등)를 Claude Code 프롬프트 바로 위에 표로 보여 주고, 몇 분마다 다시 읽어 현황을 갱신하는 모드입니다.
**읽기 전용**입니다. 노션 공식 API의 조회(`POST /v1/data_sources/{id}/query`)만 부르고 쓰기 요청은 보내지 않습니다.
모양과 색, 한글 폭 계산은 같은 저장소의 `session-board`와 같습니다.

## 설치

```
/plugin install notion-board --marketplace kangisworking/billiboi-session-board
```

또는 `claude --plugin-dir <이 폴더>` / `CLAUDE_CODE_PLUGIN_DIRS`.

## 화면

```
이슈 DB · 접수 4 · 진행중 3 · 재확인 1 · 조치완료 6 · 해결 40
열린 이슈 전체 14건 · 동기화 2분 전(3분마다)
────────────────────────────────────────────────────────────────────────────
  ID       고객사       상태     중요 담당     목표  제목
↻ ATL-315  고객사A      재확인   높음 담당자A  10/20 로그인 화면이 안 열림 (조치완료→재확인)
● ATL-320  고객사B      접수     중간 담당자B        새로 들어온 문의
  ATL-129  고객사A      진행중   높음 담당자A  10/29 일정 참석자 표시
```

- 머리줄: 상태별 개수(설정의 `statusOrder` 순서, 없으면 많은 순). 상태 색은 노션 색을 따릅니다.
- 행: ID, 고객사, 상태, 중요도, 담당, 목표일(지나면 빨강), 제목(폭에 맞춰 말줄임).
- `●` 새 이슈, `↻` 상태 변경. 지난 동기화(이전 세션 포함) 뒤 바뀐 것을 맨 위에 굵게 보이고, 하루가 지나면 표시를 지웁니다.
- 띠에 다 안 들어가면 `+N건 더`가 붙습니다. 전부는 패널(`right`)에서 봅니다. 패널에는 「최근 변경」 목록이 따로 있습니다.

## 명령

| 명령 | 하는 일 |
|---|---|
| `/notion-board` | 프롬프트 위 표(기본) |
| `/notion-board right` | 패널(전체 화면이면 오른쪽) |
| `/notion-board off` | 숨김 |
| `/notion-board me` | 내 담당만(켜기·끄기) |
| `/notion-board customer <이름>` | 고객사 이름에 그 글자가 든 것만. 이름 없이 쓰면 해제 |
| `/notion-board status <상태>` | 그 상태만(끝난 상태도 볼 수 있음). 이름 없이 쓰면 해제 |
| `/notion-board wed` | 설정의 `flag` 칸(체크박스)이 켜진 것만(켜기·끄기) |
| `/notion-board all` | 끝난 상태(`doneStatuses`)도 보이기(켜기·끄기) |
| `/notion-board clear` | 거르기를 설정의 `defaultFilter`로 되돌림 |
| `/notion-board sync` | 지금 다시 읽기 |

거르기는 저장되어 다음 세션에도 이어집니다.

## 설정

1. **이 보드 전용 노션 통합(integration)**을 이슈 DB가 있는 워크스페이스에서 만들고(읽기 권한만), 그 토큰을 환경변수 `NOTION_BOARD_TOKEN`에 둡니다.
   `~/.claude/settings.json`의 `env`에 넣으면 됩니다. 다른 용도로 쓰는 `NOTION_API_KEY`는 그대로 둬도 됩니다.
   토큰은 설정의 `tokenEnv`(기본 `NOTION_BOARD_TOKEN`) → `NOTION_API_KEY` → `NOTION_TOKEN` 순으로 찾습니다.
   `tokenEnv`는 이 셋 중 하나만 고를 수 있습니다(모드는 환경변수 이름을 코드에 글자 그대로 적어야 읽을 수 있습니다).
   토큰 값은 화면·로그·저장소 어디에도 남지 않습니다.
2. **DB를 그 통합에 공유**합니다. 노션에서 DB 페이지 오른쪽 위 `⋯` > `연결` > 통합 추가.
   토큰이 없거나, 거부되거나, 그 통합이 DB를 볼 수 없으면 표 위에 빨간 줄로 할 일을 알려 줍니다.
3. `~/.claude/notion-board.json`을 만듭니다(아래는 예시).

```json
{
  "dataSourceId": "<collection:// 뒤의 id 또는 data source id>",
  "tokenEnv": "NOTION_BOARD_TOKEN",
  "title": "이슈 DB",
  "intervalSec": 180,
  "me": { "userId": "<내 노션 user id>", "name": "<노션에 보이는 내 이름>" },
  "doneStatuses": ["해결", "미반영"],
  "statusOrder": ["접수", "협의필요", "진행중", "재확인", "조치완료", "차기반영", "해결", "미반영"],
  "defaultFilter": { "me": false, "flag": false, "all": false, "customer": "", "status": "" },
  "props": { "customer": "고객사", "priority": "중요도", "owner": "담당 개발자", "due": "목표일", "flag": "수요일까지" }
}
```

- 제목·상태·번호(`unique_id`)·마지막 수정은 칸 종류로 찾습니다. 이름이 다른 칸은 `props`로 알려 줍니다(`id`, `title`, `status`도 지정 가능).
- `intervalSec`는 60초 아래로 내려가지 않습니다. `maxPages`(기본 10, 한 쪽에 100건)로 읽는 양을 제한합니다.
- data source id는 노션 MCP의 fetch 결과나 DB 링크에서 얻습니다. `Notion-Version`은 기본 `2025-09-03`(`notionVersion`으로 바꿈)입니다.

## 켜기

```sh
claude --plugin-dir ./notion-board
```

늘 켜려면 `~/.claude/settings.json`의 `env.CLAUDE_CODE_PLUGIN_DIRS`에 `:`로 이어 붙입니다. 폴더를 고치면 다음 턴 끝에 다시 불러옵니다.

## 개발

```sh
claude plugin validate ./notion-board
claude plugin test ./notion-board
```

시험은 가짜 데이터만 씁니다(`hooks/board.test.tsx`).
