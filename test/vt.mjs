/**
 * A minimal VT100-style terminal emulator, faithful enough to audit the
 * dsh-tui-app screen manager: printable text with East-Asian widths, pending
 * wrap, CR/LF (ONLCR semantics), CUU/CUD/CHA, EL(2K), ED(0J/2J), CUP(H), SGR
 * (ignored), whole-screen scrolling, and iTerm2-style reflow on resize.
 *
 * The buffer model is one growable list of logical rows; the screen is always
 * the last `rows` rows, everything above is scrollback. Each row carries a
 * `wrapped` flag meaning "the next row is a continuation of this one".
 */

/** Approximate terminal display width of one code point (East Asian = 2). */
export function charWidth(ch) {
  const code = ch.codePointAt(0)
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  ) return 2
  return 1
}

const blankRow = () => ({ cells: [], wrapped: false })

const BASIC_FG = {
  30: [0, 0, 0], 31: [205, 49, 49], 32: [13, 161, 13], 33: [189, 153, 0],
  34: [13, 104, 219], 35: [188, 63, 188], 36: [11, 168, 158], 37: [229, 229, 229]
}

/** xterm-256 palette index to rgb (approximate, fine for snapshots). */
function palette256(n) {
  if (n < 16) return null
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return [v, v, v]
  }
  const idx = n - 16
  const level = (i) => [0, 95, 135, 175, 215, 255][i]
  return [level(Math.floor(idx / 36)), level(Math.floor(idx / 6) % 6), level(idx % 6)]
}

export class Term {
  constructor(cols = 100, rows = 30) {
    this.cols = cols
    this.rows = rows
    this.lines = []
    for (let i = 0; i < rows; i++) this.lines.push(blankRow())
    this.x = 0
    this.y = rows - 1 // cursor starts on the last screen row, like a fresh shell at the bottom
    this.pending = false // wrap-pending flag
    this.leftover = '' // incomplete escape sequence carried across writes
    this.style = { fg: null, bold: false, dim: false, italic: false }
  }

  screenTop() {
    return Math.max(0, this.lines.length - this.rows)
  }

  newline() {
    if (this.y === this.lines.length - 1) this.lines.push(blankRow())
    this.y += 1
    this.pending = false
  }

  putChar(ch, w) {
    if (this.pending || (w === 2 && this.x === this.cols - 1)) {
      this.lines[this.y].wrapped = true
      this.newline()
      this.x = 0
    }
    const cells = this.lines[this.y].cells
    cells[this.x] = { ch, style: { ...this.style } }
    if (w === 2) cells[this.x + 1] = null
    this.x += w
    if (this.x >= this.cols) {
      this.x = this.cols - 1
      this.pending = true
    }
  }

  clearRow(index) {
    this.lines[index] = blankRow()
  }

  /** Feed raw bytes (string) exactly as the terminal would. */
  write(str) {
    str = (this.leftover ?? '') + str
    this.leftover = ''
    let i = 0
    while (i < str.length) {
      const ch = str[i]
      if (ch === '\x1b') {
        const match = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(str.slice(i))
        if (!match) {
          // a CSI can straddle a pty read boundary — stash and continue later
          if (/^\x1b(\[[0-9;]*)?$/.test(str.slice(i))) {
            this.leftover = str.slice(i)
            break
          }
          i += 1
          continue
        }
        const params = match[1].split(';').map((v) => (v === '' ? 0 : Number(v)))
        const n = params[0] === 0 ? 1 : params[0]
        const letter = match[2]
        if (letter === 'A') {
          this.y = Math.max(this.screenTop(), this.y - n)
          this.pending = false
        } else if (letter === 'B') {
          this.y = Math.min(this.lines.length - 1, this.y + n)
          this.pending = false
        } else if (letter === 'G') {
          this.x = Math.max(0, Math.min(this.cols - 1, n - 1))
          this.pending = false
        } else if (letter === 'H') {
          this.y = this.screenTop()
          this.x = 0
          this.pending = false
        } else if (letter === 'K') {
          if (params[0] === 2) this.clearRow(this.y)
        } else if (letter === 'J') {
          if (params[0] === 2) {
            for (let r = this.screenTop(); r < this.lines.length; r++) this.clearRow(r)
          } else if (params[0] === 0) {
            const row = this.lines[this.y]
            row.cells = row.cells.slice(0, this.x)
            row.wrapped = false
            for (let r = this.y + 1; r < this.lines.length; r++) this.clearRow(r)
          }
        } else if (letter === 'm') {
          const codes = match[1] === '' ? [0] : match[1].split(';').map(Number)
          for (let k = 0; k < codes.length; k++) {
            const code = codes[k]
            if (code === 0) this.style = { fg: null, bold: false, dim: false, italic: false }
            else if (code === 1) this.style.bold = true
            else if (code === 2) this.style.dim = true
            else if (code === 3) this.style.italic = true
            else if (code >= 30 && code <= 37) this.style.fg = BASIC_FG[code]
            else if (code === 38 && codes[k + 1] === 2) {
              this.style.fg = [codes[k + 2], codes[k + 3], codes[k + 4]]
              k += 4
            } else if (code === 38 && codes[k + 1] === 5) {
              this.style.fg = palette256(codes[k + 2])
              k += 2
            }
          }
        }
        i += match[0].length
        continue
      }
      if (ch === '\r') {
        this.x = 0
        this.pending = false
        i += 1
        continue
      }
      if (ch === '\n') {
        this.x = 0 // ONLCR: LF implies CR (verified on this host's pty)
        this.newline()
        i += 1
        continue
      }
      const code = str.codePointAt(i)
      const full = String.fromCodePoint(code)
      this.putChar(full, charWidth(full))
      i += full.length
    }
  }

  renderRow(row) {
    let out = ''
    for (const cell of row.cells) {
      if (cell === null) continue // wide-char continuation cell
      out += cell === undefined ? ' ' : cell.ch
    }
    // trailing blanks are padding; strip for readable dumps
    return out.replace(/\s+$/g, '')
  }

  /**
   * Styled snapshot of the visible screen: per row, a list of spans
   * [{ text, fg, bold, dim, italic }] where fg is an [r,g,b] triple or null.
   * Used to render preview images of the bar.
   */
  snapshot() {
    return this.lines.slice(this.screenTop()).map((row) => {
      const spans = []
      for (const cell of row.cells) {
        if (cell === null) continue
        const ch = cell === undefined ? ' ' : cell.ch
        const style = cell === undefined ? { fg: null, bold: false, dim: false, italic: false } : cell.style
        const last = spans[spans.length - 1]
        if (last !== undefined && JSON.stringify(last.style) === JSON.stringify(style)) last.text += ch
        else spans.push({ text: ch, ...style })
      }
      while (spans.length > 0 && spans[spans.length - 1].text.trim() === '') spans.pop()
      return spans
    })
  }

  /** Visible screen contents, top to bottom, as trimmed strings. */
  screen() {
    return this.lines.slice(this.screenTop()).map((row) => this.renderRow(row))
  }

  /** Scrollback contents above the screen. */
  scrollback() {
    return this.lines.slice(0, this.screenTop()).map((row) => this.renderRow(row))
  }

  /** Everything ever on screen that has not been erased, for assertions. */
  all() {
    return [...this.scrollback(), ...this.screen()]
  }

  /** Logical lines (wrapped rows rejoined) across scrollback + screen. */
  logical() {
    const out = []
    let current = ''
    for (const row of this.lines) {
      current += this.renderRow(row)
      if (!row.wrapped) {
        out.push(current)
        current = ''
      }
    }
    if (current !== '') out.push(current)
    return out
  }

  /**
   * Resize with reflow, iTerm2/macOS-Terminal style: logical lines (rows
   * chained by `wrapped`) are unwrapped, trailing blanks trimmed, then
   * re-wrapped to the new width. The cursor follows its logical position.
   */
  resize(cols, rows) {
    // locate the cursor's logical line and cell offset before reflow
    let logicalStart = this.y
    while (logicalStart > 0 && this.lines[logicalStart - 1].wrapped) logicalStart -= 1
    let cursorCell = this.x
    for (let r = logicalStart; r < this.y; r++) cursorCell += this.cols
    const cursorLogical = logicalStart

    // split the buffer into logical lines
    const logicals = []
    let current = []
    for (const row of this.lines) {
      current.push(row)
      if (!row.wrapped) {
        logicals.push(current)
        current = []
      }
    }
    if (current.length > 0) logicals.push(current)

    const reflowed = []
    const logicalRowStart = [] // logical index -> first physical row index after reflow
    for (const group of logicals) {
      logicalRowStart.push(reflowed.length)
      const cells = group.flatMap((row) => row.cells)
      // terminals drop trailing padding on reflow
      const blank = (cell) => cell === undefined || (cell !== null && cell.ch === ' ')
      while (cells.length > 0 && (cells[cells.length - 1] === null || blank(cells[cells.length - 1]))) cells.pop()
      if (cells.length === 0) {
        reflowed.push(blankRow())
        continue
      }
      let x = 0
      let row = blankRow()
      reflowed.push(row)
      for (const cell of cells) {
        if (cell === undefined || cell === null) continue // holes / wide-char continuation
        const w = charWidth(cell.ch)
        if (w === 0) continue
        if (x + w > cols) {
          row.wrapped = true
          row = blankRow()
          reflowed.push(row)
          x = 0
        }
        row.cells[x] = cell
        if (w === 2) row.cells[x + 1] = null
        x += w
      }
    }

    this.lines = reflowed.length > 0 ? reflowed : [blankRow()]
    while (this.lines.length < rows) this.lines.push(blankRow())
    this.cols = cols
    this.rows = rows
    this.y = Math.min(this.lines.length - 1, (logicalRowStart[cursorLogical] ?? 0) + Math.floor(cursorCell / cols))
    this.x = Math.min(cols - 1, cursorCell % cols)
    this.pending = false
  }
}
