// 터미널 칸 수 계산. 동아시아 넓은 글자(한글·한자·가나·전각·이모지)는 2칸, 결합 문자는 0칸.
export function charWidth(cp: number): number {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2
  return 1
}

export function stringWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0)
  return w
}

// 폭 `w` 안에 들어가게 자르고('…' 1칸) 남는 칸은 공백으로 채운다. 넓은 글자가 반으로 걸리면 그 앞에서 자른다.
export function fit(s: string, w: number, align: 'left' | 'right' = 'left'): string {
  if (w <= 0) return ''
  const clean = s.replace(/[\r\n\t]+/g, ' ')
  let out = ''
  let used = 0
  if (stringWidth(clean) > w) {
    const limit = w - 1
    for (const ch of clean) {
      const cw = charWidth(ch.codePointAt(0) ?? 0)
      if (used + cw > limit) break
      out += ch
      used += cw
    }
    out += '…'
    used += 1
  } else {
    out = clean
    used = stringWidth(clean)
  }
  const pad = ' '.repeat(Math.max(0, w - used))
  return align === 'right' ? pad + out : out + pad
}
