# session-board

이 PC에서 돌고 있는 다른 Claude Code 세션들의 상태·하는 일·todo 진행을 프롬프트 위 띠(기본) 또는 패널에 고정 폭 표로 보여 주는 모드입니다. 읽기·표시만 합니다.

설치, 명령, 표 읽는 법, 데이터 형식은 저장소 루트의 [README](../README.md) 를 보세요.

```
/plugin install session-board --marketplace kangisworking/billiboi-session-board
```

- `/session-board` 띠 · `/session-board right` 패널 · `/session-board all` 숨긴 세션 토글 · `/session-board msgs on|off` 최근 메시지 칸 · `/session-board off` 숨김
- 읽는 곳: `~/.claude/sessions`, `~/.claude/jobs`, `~/.claude/tasks`, `~/.claude/peer-status`
