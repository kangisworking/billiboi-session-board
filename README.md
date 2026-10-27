# billiboi-session-board

세 모드: [session-board](session-board/README.md) (세션 현황판) · [peer-status-writer](peer-status-writer/README.md) (내 todo 올리기) · [message-board](message-board/README.md) (세션 간 메시지 타임라인) · [notion-board](notion-board/README.md) (노션 DB 현황표)

> **English summary.** Four small Claude Code *mods* (hook plugins). `session-board` shows every Claude Code session running on this machine, with its status, what it is doing and its todo progress, as a fixed-width table in the band above the prompt (default) or in a side pane. `peer-status-writer` makes a session publish its own todo list so the board can show it. `message-board` logs each session's cross-session messages (and the user's own prompts) and shows them all as one timeline. `notion-board` shows a Notion database (an issue tracker, say) as a table above the prompt, refreshed periodically, read-only. Both are read/display only: they read JSON files under `~/.claude`, never a conversation transcript. Requires Claude Code 2.1.287 or later (the mods API). Install: `/plugin install session-board --marketplace kangisworking/billiboi-session-board`. MIT.

한 PC에서 Claude Code 세션을 여러 개 띄워 두고 일할 때, 다른 세션들이 지금 무엇을 하고 있는지 한눈에 보려고 만든 모드입니다.

```
세션 4 · 작업 중 2 · 대기 2 · 완료 todo 7/11 · +1개 숨김(/session-board all)
────────────────────────────────────────────────────────────────────────────────
상태    세션             갱신      진행        하는 일
⠹ busy  A · 조율         방금      ▰▰▰▱▱ 3/5   B·C 결과 취합
                                               ▶ 회의록 초안 합치기
- idle  B · 리뷰어       3분 전    ▰▰▰▰▰ 4/4   PR #12 리뷰 끝
$ shell C · 테스트       방금      ▰▱▱▱▱ 1/4   통합 테스트 돌리는 중
                                               ▶ 실패한 케이스 다시 돌리기
- idle  [a1b2c3] 새 세션 41분 전
```

(스크린샷 대신 실제 띠 모양을 글자로 옮긴 것입니다. 터미널에서는 상태별로 색이 들어갑니다.)

## 요구 사항

- Claude Code **2.1.287 이상** (모드 API `claude-code` 훅 모듈). 2.1.310 에서 만들고 시험했습니다.
- macOS, Linux (세션 생존 확인에 `ps -o pid= -p` 를 씁니다).

## 설치

세 가지 중 하나를 고릅니다.

**1) 마켓플레이스로 설치** (추천). 터미널 세션의 프롬프트에서:

```
/plugin install session-board --marketplace kangisworking/billiboi-session-board
```

마켓플레이스를 추가하겠느냐고 물으면 `y`, 이어서 적용 범위(user / project)를 고릅니다. 셸에서는 `claude plugin install session-board --marketplace kangisworking/billiboi-session-board`. 다른 세션이 자기 todo 를 올리게 하려면 `peer-status-writer` 도 같은 방법으로 설치합니다.

**2) 폴더를 직접 지정** (한 세션만, 개발용):

```
git clone https://github.com/kangisworking/billiboi-session-board.git
claude --plugin-dir ./billiboi-session-board/session-board --plugin-dir ./billiboi-session-board/peer-status-writer
```

이 방식은 폴더를 고치면 다음 턴 끝에 다시 읽힙니다(핫 리로드).

**3) 모든 세션에 항상 켜기**: `~/.claude/settings.json` 의 `env` 에 `CLAUDE_CODE_PLUGIN_DIRS` 로 두 폴더의 절대 경로를 적습니다(구분자는 macOS/Linux `:`).

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/src/billiboi-session-board/session-board:~/src/billiboi-session-board/peer-status-writer" } }
```

## 명령

| 명령 | 동작 |
|---|---|
| `/session-board` | 프롬프트 바로 위 띠에 표로 보이기(기본) |
| `/session-board right` (`pane`, `dock` 도 됨) | 패널로 보기. 전체화면(터미널 110열 이상)이면 오른쪽에 붙고, 아니면 프롬프트 위 inline. 띠는 꺼짐 |
| `/session-board all` | 오래 멈춘 이름 없는 세션까지 보이기(토글) |
| `/session-board off` | 숨기기 |

고른 모드는 세션 상태에 남아 모드를 다시 읽어도 유지됩니다. 띠는 `ctrl+x ctrl+a` 로 접을 수 있고, AskUserQuestion 같은 설문이 그 자리를 쓰는 동안은 비켜 줍니다.

## 표 읽는 법

| 열 | 뜻 |
|---|---|
| 상태 | 아이콘 + `busy` / `idle` / `shell`. 아이콘: 점자 스피너(busy, 400ms 마다 돌아감) · `$`(shell 실행 중) · `-`(idle) · `x`(1시간 넘게 갱신 없음 또는 error) |
| 세션 | `aliases.json` 의 역할 이름(강조색·굵게), 없으면 `[세션 id 앞 6자] 세션 이름`. 백그라운드 세션은 ` (bg)` |
| 갱신 | 마지막 활동 상대 시각. 5분 안은 밝게, 1시간 안은 옅게, 그 뒤는 흐리게 |
| 진행 | todo 막대 `▰▰▱▱ 2/4`. 전부 끝나면 초록 |
| 하는 일 | 세션이 남긴 한 줄(`doing`), 백그라운드 작업이면 그 요약 |

행 아래 들여 쓴 줄은 **진행 중(in_progress) todo** 입니다. 없으면 다음 대기 항목 하나를 `·` 로 보이고, 완료 항목은 띠에서 숨깁니다. 패널(`right`)에서는 전부 보입니다(`✓` 완료 흐리게, `▶` 진행 중 초록, `·` 대기).

열 폭은 고정이고(100열 미만이면 좁은 배치), 한글·한자·이모지는 2칸으로 세어 행이 화면 폭을 넘지 않습니다. 넘치는 글은 `…` 로 자릅니다.

머리줄은 `세션 n · 작업 중 n · 대기 n · 완료 todo n/전체` 이고, 별칭도 상태 파일도 없이 1시간 넘게 멈춘 세션은 기본으로 숨기고 `+N개 숨김` 으로만 셉니다.

## 어디서 읽나 (모두 읽기 전용)

| 파일 | 쓰임 |
|---|---|
| `~/.claude/sessions/<pid>.json` | 세션 이름, 상태(idle/busy/shell), 종류(interactive/bg), 마지막 갱신 시각. pid 가 살아 있는 세션만 보입니다 |
| `~/.claude/jobs/<jobId>/state.json` | 백그라운드 세션의 "하는 일" 한 줄(`detail`) |
| `~/.claude/tasks/session-<sessionId 앞 8자>/*.json` | TaskCreate 가 남긴 항목(`subject`, `status`) |
| `~/.claude/peer-status/<sessionId>.json` | 세션이 스스로 남긴 상태. 있으면 위 둘보다 먼저 씁니다 |
| `~/.claude/peer-status/aliases.json` | 세션 id(앞 4자 이상) 또는 pid → 역할 이름 |

`peer-status/<sessionId>.json` 의 형식:

```json
{
  "doing": "통합 테스트 돌리는 중",
  "todos": [
    { "text": "단위 테스트", "status": "completed" },
    { "text": "통합 테스트", "status": "in_progress" },
    { "text": "결과 보고", "status": "pending" }
  ]
}
```

`status` 는 `pending` / `in_progress` / `completed` 중 하나이고, 대신 `done: true` 도 됩니다. `todos` 항목이 문자열이면 대기 항목으로 봅니다.

`aliases.json` 예:

```json
{ "a1b2c3": "A · 조율", "d4e5f6": "B · 리뷰어", "48213": "C · 테스트" }
```

키는 세션 id 의 앞부분(4자 이상, 대소문자 무시)이거나 pid 입니다. 세션 id 는 띠의 대괄호 안 6자, 또는 `~/.claude/sessions/<pid>.json` 의 `sessionId` 입니다.

## 다른 세션이 자기 상태를 올리게 하기

**방법 1 · `peer-status-writer` 모드.** 그 세션에 설치해 두면 TodoWrite / TaskCreate / TaskUpdate 를 할 때마다 자동으로 파일을 씁니다. 대화 내용은 쓰지 않고, 할 일 제목과 진행 중 항목의 `activeForm` 만 남깁니다.

**방법 2 · 모드 없이 셸로.** 어떤 세션이든 Bash 로 자기 파일을 쓰면 5초 안에 띠에 보입니다.

```bash
printf '%s' '{"doing":"통합 테스트 돌리는 중","todos":[{"text":"단위 테스트","status":"completed"},{"text":"통합 테스트","status":"in_progress"}]}' \
  > ~/.claude/peer-status/<sessionId>.json
```

**팁 · 다른 세션에 지시하기.** 세션 간 메시지(SendMessage)나 프롬프트로 이렇게 적어 두면 됩니다.

> 작업 단계가 바뀔 때마다 `~/.claude/peer-status/<너의 sessionId>.json` 에 `{"doing": "...", "todos": [...]}` 를 다시 써 줘. 비밀값·실명은 넣지 말 것.

## message-board: 세션 간 메시지 타임라인

세션끼리 SendMessage 로 주고받은 메시지와 사용자가 각 세션에 입력한 프롬프트를 날짜별 한 타임라인으로 보여 줍니다(최신이 아래). 메시지를 주고받는 **세션마다** 이 모드를 켜 두면 각 세션이 `~/.claude/peer-status/messages/<날짜>/` 에 한 건씩 남기고, 보드가 5초마다 읽습니다. 본문은 앞 500자, 보관 7일. 명령: `/message-board`(패널) · `band` · `off` · `from <이름>` · `to <이름>` · `me` · `all` · `expand`. 자세한 것은 [message-board/README.md](message-board/README.md).

```
/plugin install message-board --marketplace kangisworking/billiboi-session-board
```

## notion-board: 노션 DB 현황표

노션 데이터베이스(이슈 DB 등)를 프롬프트 위 표나 패널로 보여 주고 몇 분마다 다시 읽습니다. 노션 공식 API 의 조회만 부르는 읽기 전용이고, 토큰과 DB id 는 저장소 밖 `~/.claude/notion-board.json` 에 둡니다. 자세한 것은 [notion-board/README.md](notion-board/README.md).

```
/plugin install notion-board --marketplace kangisworking/billiboi-session-board
```

## 한계

- **대화 영역 위쪽에는 둘 수 없습니다.** 모드 API 가 플러그인에 주는 자리는 프롬프트 위 띠(AbovePrompt), 패널(Pane: 자리는 엔진이 정함), 프롬프트 아래 상태 줄뿐입니다.
- 띠 높이는 터미널의 절반까지입니다. 세션이 많으면 띠 안에서 스크롤되니 그때는 `right` 가 편합니다.
- todo 에 완료 시각이 없어 "오늘 완료" 같은 집계는 못 하고 누적 완료/전체만 보입니다.
- 스피너는 엔진의 Spinner 요소가 플러그인에 열려 있지 않아 글자를 바꿔 가며 그립니다. busy 세션이 있을 때만 400ms 마다 갱신합니다.

## 보안

- `session-board` 는 위 표의 JSON 파일을 읽고 `ps` 로 pid 생존만 확인합니다. 아무것도 쓰지 않습니다.
- `peer-status-writer` 는 `~/.claude/peer-status/` 아래 자기 세션 파일 하나만 씁니다.
- 둘 다 세션 대화 기록(jsonl)은 읽지 않습니다. 화면에는 세션 이름, "하는 일" 한 줄, todo 제목만 나오니 거기에 비밀값이나 실명을 적지 않도록 합니다.
- 켜기 전에 `claude plugin validate <폴더>` 로 무엇을 읽고 부르는지 확인할 수 있습니다.

## 개발

```
claude plugin validate session-board && claude plugin test session-board
claude plugin validate peer-status-writer && claude plugin test peer-status-writer
claude plugin validate message-board && claude plugin test message-board
claude plugin validate notion-board && claude plugin test notion-board
```

각 폴더의 `tsconfig.json` 은 모드가 한 번 로드될 때 Claude Code 가 `.claude-plugin/types/` 에 써 주는 타입 선언을 확장합니다(이 폴더는 생성물이라 저장소에 넣지 않습니다). 그 뒤 `tsc -p session-board` 로 타입 검사를 할 수 있습니다.

## 라이선스

MIT © kangisworking
