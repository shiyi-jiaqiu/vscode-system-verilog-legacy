// SPDX-License-Identifier: MIT
import * as vscode from 'vscode'
import { ext } from './extension'
import { ExtensionComponent } from './lib/libconfig'
import { isAnyVerilog } from './utils'

// computeInactivePreprocessorRanges and its helpers are from vscode-verilog-hdl-support
// (src/providers/InactivePreprocessorDecorationProvider.ts at 674bb01),
// Copyright (c) 2016-2022 Masahiro H, MIT License.

interface InactivePreprocessorRange {
  startLine: number
  endLine: number
}

interface ConditionalFrame {
  parentActive: boolean
  branchActive: boolean
  branchSelected: boolean
}

interface Directive {
  keyword: 'define' | 'undef' | 'ifdef' | 'ifndef' | 'elsif' | 'else' | 'endif'
  macro?: string
}

const MACRO_PATTERN = '[A-Za-z_][A-Za-z0-9_$]*'
const DIRECTIVE_PATTERN = new RegExp(
  `^\\s*\`(define|undef|ifdef|ifndef|elsif|else|endif)(?:\\s+(${MACRO_PATTERN}))?\\b`
)

function getEffectiveActive(stack: readonly ConditionalFrame[]): boolean {
  const top = stack.at(-1)
  return top === undefined || (top.parentActive && top.branchActive)
}

function getDirectiveLineActive(
  directive: Directive | undefined,
  stack: readonly ConditionalFrame[]
): boolean {
  if (directive === undefined) {
    return getEffectiveActive(stack)
  }

  if (
    directive.keyword === 'elsif' ||
    directive.keyword === 'else' ||
    directive.keyword === 'endif'
  ) {
    const top = stack.at(-1)
    return top === undefined || top.parentActive
  }

  return getEffectiveActive(stack)
}

function mergeInactiveLine(ranges: InactivePreprocessorRange[], line: number): void {
  const previous = ranges.at(-1)
  if (previous !== undefined && previous.endLine + 1 === line) {
    previous.endLine = line
    return
  }
  ranges.push({ startLine: line, endLine: line })
}

function removeComments(line: string, inBlockComment: boolean): [string, boolean] {
  let result = ''
  let index = 0
  let blockComment = inBlockComment

  while (index < line.length) {
    if (blockComment) {
      const endIndex = line.indexOf('*/', index)
      if (endIndex === -1) {
        return [result, true]
      }
      index = endIndex + 2
      blockComment = false
      continue
    }

    const lineCommentIndex = line.indexOf('//', index)
    const blockCommentIndex = line.indexOf('/*', index)

    if (lineCommentIndex === -1 && blockCommentIndex === -1) {
      result += line.slice(index)
      break
    }

    if (
      lineCommentIndex !== -1 &&
      (blockCommentIndex === -1 || lineCommentIndex < blockCommentIndex)
    ) {
      result += line.slice(index, lineCommentIndex)
      break
    }

    result += line.slice(index, blockCommentIndex)
    index = blockCommentIndex + 2
    blockComment = true
  }

  return [result, blockComment]
}

function parseDirective(line: string): Directive | undefined {
  const match = DIRECTIVE_PATTERN.exec(line)
  if (match === null) {
    return undefined
  }

  return {
    keyword: match[1] as Directive['keyword'],
    macro: match[2],
  }
}

export function computeInactivePreprocessorRanges(
  text: string,
  initialDefines: readonly string[]
): InactivePreprocessorRange[] {
  const defines = new Set(initialDefines)
  const stack: ConditionalFrame[] = []
  const ranges: InactivePreprocessorRange[] = []
  const lines = text.split(/\r\n|\r|\n/)
  let inBlockComment = false

  for (const [lineNumber, line] of lines.entries()) {
    const [code, nextInBlockComment] = removeComments(line, inBlockComment)
    const directive = parseDirective(code)

    if (!getDirectiveLineActive(directive, stack)) {
      mergeInactiveLine(ranges, lineNumber)
    }

    switch (directive?.keyword) {
      case 'define':
        if (directive.macro !== undefined && getEffectiveActive(stack)) {
          defines.add(directive.macro)
        }
        break

      case 'undef':
        if (directive.macro !== undefined && getEffectiveActive(stack)) {
          defines.delete(directive.macro)
        }
        break

      case 'ifdef': {
        const parentActive = getEffectiveActive(stack)
        const condition = directive.macro !== undefined && defines.has(directive.macro)
        stack.push({
          parentActive,
          branchActive: condition,
          branchSelected: parentActive && condition,
        })
        break
      }

      case 'ifndef': {
        const parentActive = getEffectiveActive(stack)
        const condition = directive.macro === undefined || !defines.has(directive.macro)
        stack.push({
          parentActive,
          branchActive: condition,
          branchSelected: parentActive && condition,
        })
        break
      }

      case 'elsif': {
        const top = stack.at(-1)
        if (top !== undefined) {
          const condition = directive.macro !== undefined && defines.has(directive.macro)
          top.branchActive = !top.branchSelected && condition
          top.branchSelected = top.branchSelected || (top.parentActive && condition)
        }
        break
      }

      case 'else': {
        const top = stack.at(-1)
        if (top !== undefined) {
          top.branchActive = !top.branchSelected
          top.branchSelected = true
        }
        break
      }

      case 'endif':
        stack.pop()
        break
    }

    inBlockComment = nextInBlockComment
  }

  return ranges
}

/// Dims `ifdef branches that are inactive for the +define+ macros of `verilog.filelist`
/// (plus the `define/`undef lines of the file itself).
export class InactiveRegionsComponent extends ExtensionComponent {
  private decorationType = vscode.window.createTextEditorDecorationType({ opacity: '0.5' })
  private enabled = false
  private pending = new Map<vscode.TextDocument, NodeJS.Timeout>()

  async activate(context: vscode.ExtensionContext): Promise<void> {
    if (ext.slangExtensionActive()) {
      // vscode-slang marks inactive regions itself
      return
    }
    this.enabled = true
    context.subscriptions.push(
      this.decorationType,
      vscode.window.onDidChangeVisibleTextEditors(() => this.update()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        // the whole document is read again, so once typing pauses
        clearTimeout(this.pending.get(e.document))
        this.pending.set(
          e.document,
          setTimeout(() => {
            this.pending.delete(e.document)
            vscode.window.visibleTextEditors
              .filter((editor) => editor.document === e.document)
              .forEach((editor) => this.updateEditor(editor))
          }, 300)
        )
      })
    )
    this.update()
  }

  update() {
    if (this.enabled) {
      vscode.window.visibleTextEditors.forEach((editor) => this.updateEditor(editor))
    }
  }

  private updateEditor(editor: vscode.TextEditor) {
    const filelist = ext.projectFilelist
    if (filelist === undefined || !isAnyVerilog(editor.document.languageId)) {
      editor.setDecorations(this.decorationType, [])
      return
    }
    const ranges = computeInactivePreprocessorRanges(
      editor.document.getText(),
      Array.from(filelist.defines.keys())
    ).map(
      (range) =>
        new vscode.Range(
          range.startLine,
          0,
          range.endLine,
          editor.document.lineAt(range.endLine).text.length
        )
    )
    editor.setDecorations(this.decorationType, ranges)
  }
}
