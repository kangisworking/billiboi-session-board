# peer-status-writer

이 세션이 TodoWrite, TaskCreate, TaskUpdate 로 바꾼 할 일 목록을 `~/.claude/peer-status/<sessionId>.json` 에 `{ name, doing, todos[] }` 로 남기는 작은 모드입니다. `session-board` 가 그 파일을 읽어 "하는 일"과 진행 중 todo 로 보여 줍니다. 쓰는 것은 이 파일 하나이며, 프롬프트나 답변 같은 대화 내용은 넣지 않습니다. `doing` 은 진행 중(in_progress) 항목의 `activeForm` 입니다.

```
/plugin install peer-status-writer --marketplace kangisworking/billiboi-session-board
```

현황판에 올라오고 싶은 세션마다 설치하거나 `--plugin-dir` 로 함께 줍니다. 모드 없이 셸로 같은 파일을 직접 써도 됩니다(루트 [README](../README.md) 참고).

## 승인과 위험

- 모드는 세션과 같은 권한으로 돕니다. 이 모드는 `~/.claude/sessions` 를 읽어 이름을 찾고 `~/.claude/peer-status/` 아래 자기 세션 파일 하나만 씁니다.
- 할 일 제목이 파일에 평문으로 남습니다. 비밀값이나 실명을 todo 제목에 쓰지 않도록 합니다.
