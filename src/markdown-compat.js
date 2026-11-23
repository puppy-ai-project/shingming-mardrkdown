function isEscaped(source, index) {
  let slashCount = 0
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor--) slashCount++
  return slashCount % 2 === 1
}

function findClosingBackticks(source, start, length) {
  for (let cursor = start; cursor < source.length;) {
    const next = source.indexOf('`', cursor)
    if (next < 0) return -1
    let runLength = 1
    while (source[next + runLength] === '`') runLength++
    if (runLength === length) return next + runLength
    cursor = next + runLength
  }
  return -1
}

function findClosingStrong(source, start) {
  for (let cursor = start; cursor < source.length && source[cursor] !== '\n';) {
    if (source[cursor] === '`') {
      let runLength = 1
      while (source[cursor + runLength] === '`') runLength++
      const codeEnd = findClosingBackticks(source, cursor + runLength, runLength)
      if (codeEnd >= 0) {
        cursor = codeEnd
        continue
      }
    }
    if (source.startsWith('**', cursor) && !isEscaped(source, cursor)) return cursor
    cursor++
  }
  return -1
}

function normalizeAdjacentStrongLabels(source) {
  let result = ''
  let cursor = 0

  while (cursor < source.length) {
    if (source[cursor] === '`') {
      let runLength = 1
      while (source[cursor + runLength] === '`') runLength++
      const codeEnd = findClosingBackticks(source, cursor + runLength, runLength)
      if (codeEnd >= 0) {
        result += source.slice(cursor, codeEnd)
        cursor = codeEnd
        continue
      }
    }

    if (source.startsWith('**', cursor) && !isEscaped(source, cursor)) {
      const closing = findClosingStrong(source, cursor + 2)
      if (closing > cursor + 2) {
        const label = source.slice(cursor + 2, closing)
        const nextCharacter = source[closing + 2]
        if (label.endsWith(':') && nextCharacter && !/\s/.test(nextCharacter)) {
          result += `${source.slice(cursor, closing + 2)} `
          cursor = closing + 2
          continue
        }
      }
    }

    result += source[cursor]
    cursor++
  }

  return result
}

function escapeTemplatePlaceholderDollars(source) {
  let result = ''
  let cursor = 0

  while (cursor < source.length) {
    if (source[cursor] === '`') {
      let runLength = 1
      while (source[cursor + runLength] === '`') runLength++
      const codeEnd = findClosingBackticks(source, cursor + runLength, runLength)
      if (codeEnd >= 0) {
        result += source.slice(cursor, codeEnd)
        cursor = codeEnd
        continue
      }
    }

    if (source.startsWith('${', cursor) && !isEscaped(source, cursor)) {
      result += '\\$'
      cursor++
    } else {
      result += source[cursor]
    }
    cursor++
  }

  return result
}

function normalizeEscapedFileLinkOpeners(source) {
  const lines = source.split(/\r\n|\r|\n/)
  let inFence = false
  let fenceMarker = ''
  let fenceLength = 0

  return lines.map(line => {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const marker = fence[1][0]
      if (!inFence) {
        inFence = true
        fenceMarker = marker
        fenceLength = fence[1].length
      } else if (marker === fenceMarker && fence[1].length >= fenceLength && /^\s*$/.test(line.slice(fence[0].length))) {
        inFence = false
        fenceMarker = ''
        fenceLength = 0
      }
      return line
    }
    if (inFence) return line

    let result = ''
    for (let cursor = 0; cursor < line.length;) {
      if (line[cursor] === '`') {
        let runLength = 1
        while (line[cursor + runLength] === '`') runLength++
        const codeEnd = findClosingBackticks(line, cursor + runLength, runLength)
        if (codeEnd >= 0) {
          result += line.slice(cursor, codeEnd)
          cursor = codeEnd
          continue
        }
      }

      const escapedFileLinkStart = line.slice(cursor, cursor + 8).toLowerCase() === ']\\(file:'
      if (escapedFileLinkStart && !isEscaped(line, cursor) && line.indexOf(')', cursor + 8) >= 0) {
        result += ']('
        cursor += 3
        continue
      }

      result += line[cursor]
      cursor++
    }
    return result
  }).join('\n')
}

function splitUnescapedTableCells(value) {
  const cells = []
  let cell = ''
  let escaped = false
  for (const character of value) {
    if (character === '|' && !escaped) {
      cells.push(cell)
      cell = ''
    } else {
      cell += character
    }
    if (character === '\\') escaped = !escaped
    else escaped = false
  }
  cells.push(cell)
  return cells
}

function normalizeBlankHeaderPipeRows(lines, startIndex) {
  const rows = []
  let index = startIndex + 1

  while (index < lines.length) {
    const line = lines[index].trim()
    if (!line || !line.startsWith('|') || !line.endsWith('|') || line.endsWith('\\|')) break

    const cells = splitUnescapedTableCells(line.slice(1, -1)).map(cell => cell.trim())
    if (cells.length !== 2) break
    rows.push(lines[index])
    index++
  }

  if (!rows.length) return null
  return {
    endIndex: index,
    markdown: ['|  |  |', '| --- | --- |', ...rows].join('\n')
  }
}

function normalizeBlankHeaderCardTable(lines, startIndex) {
  let endIndex = startIndex + 1
  while (endIndex < lines.length && !/^\s{0,3}#{1,6}\s/.test(lines[endIndex])) endIndex++

  const cells = [[]]
  for (let index = startIndex + 1; index < endIndex; index++) {
    const originalLine = lines[index]
    const trimmed = originalLine.trim()
    if (!trimmed) {
      cells.at(-1).push('')
      continue
    }

    let content = trimmed
    const beginsWithPipe = content.startsWith('|')
    if (beginsWithPipe) content = content.slice(1)
    if (content.endsWith('|') && !content.endsWith('\\|')) content = content.slice(0, -1)

    const segments = splitUnescapedTableCells(content)
    if (beginsWithPipe && cells.at(-1).some(part => part.trim())) cells.push([])
    segments.forEach((segment, segmentIndex) => {
      if (segmentIndex > 0) cells.push([])
      cells.at(-1).push(segment)
    })
  }

  while (cells.length && !cells.at(-1).some(part => part.trim())) cells.pop()
  if (cells.length < 2) return null

  const titles = []
  const descriptions = []
  for (const parts of cells) {
    const paragraphs = parts.join('\n').trim().split(/\n\s*\n/)
    titles.push((paragraphs.shift() || '').replace(/\s*\n\s*/g, ' ').trim())
    descriptions.push(paragraphs.join(' ').replace(/\s*\n\s*/g, ' ').trim())
  }
  const escapeCellPipes = value => value.replace(/(?<!\\)\|/g, '\\|')
  const row = values => `| ${values.map(escapeCellPipes).join(' | ')} |`
  const separator = row(titles.map(() => '---'))
  return {endIndex, markdown: `${row(titles)}\n${separator}\n${row(descriptions)}`}
}

function normalizeBlankHeaderCardTables(source) {
  const lines = source.split(/\r\n|\r|\n/)
  let inFence = false
  let fenceMarker = ''
  const output = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const marker = fence[1][0]
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (marker === fenceMarker) {
        inFence = false
        fenceMarker = ''
      }
      output.push(line)
      continue
    }

    if (!inFence && /^\s*\|\s*\|\s*$/.test(line)) {
      const normalized = normalizeBlankHeaderPipeRows(lines, index) || normalizeBlankHeaderCardTable(lines, index)
      if (normalized) {
        output.push(normalized.markdown)
        index = normalized.endIndex - 1
        continue
      }
    }
    output.push(line)
  }

  return output.join('\n')
}

function isGfmTableSeparator(line) {
  const cells = splitUnescapedTableCells(line.trim().replace(/^\|/, '').replace(/\|$/, ''))
  return cells.length > 1 && cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell))
}

function hasTrailingTablePipe(line) {
  const trimmed = line.trimEnd()
  return trimmed.endsWith('|') && !trimmed.endsWith('\\|')
}

function hasShortPipeStartedTableRow(lines, startIndex, columnCount) {
  for (let index = startIndex; index < lines.length && !/^\s{0,3}#{1,6}\s/.test(lines[index]); index++) {
    const line = lines[index].trim()
    if (!line.startsWith('|')) continue
    const cells = splitTableRowLine(line)
    if (cells.length < columnCount) return true
  }
  return false
}

function splitTableRowLine(line, {leadingPipeStartsCell = false} = {}) {
  let value = line.trim()
  const startsWithPipe = value.startsWith('|')
  if (startsWithPipe) value = value.slice(1)
  if (hasTrailingTablePipe(line)) value = value.trimEnd().slice(0, -1)

  const segments = splitUnescapedTableCells(value)
  if (!startsWithPipe || !leadingPipeStartsCell) return segments
  return segments.map(segment => segment.trim())
}

function normalizeMultilineTableRows(source) {
  const lines = source.split(/\r\n|\r|\n/)
  const output = []

  for (let index = 0; index < lines.length;) {
    const header = lines[index]
    const separator = lines[index + 1]
    if (!header?.includes('|') || !separator || !isGfmTableSeparator(separator)) {
      output.push(header)
      index++
      continue
    }

    const columnCount = splitUnescapedTableCells(header.trim().replace(/^\|/, '').replace(/\|$/, '')).length
    output.push(header, separator)
    index += 2
    if (!hasShortPipeStartedTableRow(lines, index, columnCount)) continue

    while (index < lines.length) {
      const blankStart = index
      while (index < lines.length && !lines[index].trim()) index++
      if (index >= lines.length || !lines[index].trim().startsWith('|')) {
        output.push(...lines.slice(blankStart, index))
        break
      }

      const rowStart = index
      const cells = splitTableRowLine(lines[index]).map(cell => cell.trim())
      const initialRowWasComplete = cells.length >= columnCount && hasTrailingTablePipe(lines[index])
      index++
      let rowClosed = hasTrailingTablePipe(lines[rowStart])

      while (!rowClosed && index < lines.length && !/^\s{0,3}#{1,6}\s/.test(lines[index])) {
        const continuation = lines[index]
        const startsNextRow = continuation.trim().startsWith('|')
        if (startsNextRow) break

        if (!continuation.trim()) {
          if (cells.length) cells[cells.length - 1] = `${cells[cells.length - 1]} `
          index++
          continue
        }

        const pieces = splitTableRowLine(continuation, {leadingPipeStartsCell: true})
        const startsWithPipe = continuation.trim().startsWith('|')
        if (startsWithPipe) {
          for (const piece of pieces) {
            if (piece.trim()) cells.push(piece.trim())
          }
        } else {
          if (pieces[0]?.trim()) {
            const lastIndex = Math.max(0, cells.length - 1)
            cells[lastIndex] = `${cells[lastIndex] || ''} ${pieces[0].trim()}`.trim()
          }
          for (const piece of pieces.slice(1)) cells.push(piece.trim())
        }

        rowClosed = hasTrailingTablePipe(continuation)
        index++
      }

      if (initialRowWasComplete) {
        // Already well-formed single-line rows are preserved byte-for-byte.
        output.push(lines[rowStart])
      } else {
        while (cells.length < columnCount) cells.push('')
        const normalizedCells = cells.slice(0, columnCount).map(cell => cell.replace(/\s+/g, ' ').trim())
        output.push(`| ${normalizedCells.join(' | ')} |`)
      }
    }
  }

  return output.join('\n')
}

export function enableBlankHeaderCardTableCompatibility(markdown) {
  markdown.core.ruler.before('block', 'blank_header_multiline_card_table', state => {
    state.src = normalizeMultilineTableRows(normalizeBlankHeaderCardTables(state.src))
  })
}

export function enableEscapedFileLinkCompatibility(markdown) {
  markdown.core.ruler.before('block', 'escaped_file_link_opener', state => {
    state.src = normalizeEscapedFileLinkOpeners(state.src)
  })
}

export function enableAdjacentStrongLabelCompatibility(markdown) {
  markdown.core.ruler.before('inline', 'adjacent_strong_label_spacing', state => {
    for (const token of state.tokens) {
      if (token.type === 'inline') {
        token.content = escapeTemplatePlaceholderDollars(normalizeAdjacentStrongLabels(token.content))
      }
    }
  })
}

export function enableExplicitAnchorCompatibility(markdown) {
  markdown.block.ruler.before('paragraph', 'explicit_empty_anchor', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false
    const line = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine])
    const match = /^<a\s+id\s*=\s*(["'])([^"'\s<>]+)\1\s*>\s*<\/a\s*>\s*$/i.exec(line)
    if (!match) return false
    if (silent) return true
    const token = state.push('explicit_empty_anchor', 'span', 0)
    token.attrSet('id', match[2])
    token.map = [startLine, startLine + 1]
    token.block = true
    state.line = startLine + 1
    return true
  }, {alt: ['paragraph', 'reference', 'blockquote', 'list']})
  markdown.renderer.rules.explicit_empty_anchor = (tokens, index) =>
    `<span id="${markdown.utils.escapeHtml(tokens[index].attrGet('id'))}"></span>\n`
}
