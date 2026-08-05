/**
 * definition-provider.ts
 * 
 * 实现 LSP textDocument/definition 请求处理器。
 * 
 * 支持以下跳转场景：
 * 1. #include <foo/bar>  →  引擎 chunks 目录下的 foo/bar.chunk
 * 2. #include "foo/bar"  →  相对当前文件目录的 foo/bar.chunk
 * 3. （.effect 文件内）CCProgram blockName  →  同文件内 CCProgram 块的起始位置
 *    用于 vert/frag 字段里的  "programName:entryFunction"  跳转
 */

import {
    TextDocumentPositionParams,
    Location,
    Range,
    Position,
} from 'vscode-languageserver/node';

import { URI } from 'vscode-uri';

import { documents, DefaultEngineDirectory } from './server';
import { get_environment_path } from './cc-utils';
import {
    getIncludeAtPosition,
    resolveIncludePath,
    getEngineChuinksDir,
} from './include-resolver';

import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// CCProgram 跳转（.effect 文件内部）
// ---------------------------------------------------------------------------

/** 匹配 CCProgram 块声明，如  CCProgram unlit-vs %{ */
const CC_PROGRAM_DECL_RE = /^CCProgram\s+(\S+)\s*%\{/m;
const CC_PROGRAM_DECL_RE_G = /^CCProgram\s+(\S+)\s*%\{/gm;

/** 匹配 vert/frag 字段的值，如 "unlit-vs:vert" 或 unlit-vs:vert */
const VERT_FRAG_VALUE_RE = /^\s*(?:vert|frag)\s*:\s*(\S+)/;

/**
 * 在文档文本中找到所有 CCProgram 块声明的位置
 */
function findCCProgramDeclarations(text: string): Map<string, Position> {
    const result = new Map<string, Position>();
    const lines = text.split('\n');
    let charOffset = 0;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const lineText = lines[lineIndex];
        const m = CC_PROGRAM_DECL_RE.exec(lineText);
        if (m) {
            result.set(m[1], { line: lineIndex, character: 0 });
        }
        charOffset += lineText.length + 1;
    }
    return result;
}

/**
 * 检查光标位置是否在 vert/frag 值的 programName 部分上
 * 返回 program 名称（冒号前的部分），否则 undefined
 */
function getProgramNameAtPosition(text: string, line: number, character: number): string | undefined {
    const lines = text.split('\n');
    if (line >= lines.length) return undefined;
    const lineText = lines[line];

    const m = VERT_FRAG_VALUE_RE.exec(lineText);
    if (!m) return undefined;

    const valueStr = m[1]; // e.g. "unlit-vs:vert"
    const colonIdx = valueStr.indexOf(':');
    const programName = colonIdx >= 0 ? valueStr.slice(0, colonIdx) : valueStr;

    // 计算 programName 在行内的列范围
    const valueStart = lineText.indexOf(valueStr);
    const programNameStart = valueStart;
    const programNameEnd = valueStart + programName.length;

    if (character >= programNameStart && character <= programNameEnd) {
        return programName;
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function definitionProvider(
    params: TextDocumentPositionParams,
): Location | Location[] | null {
    const textDocument = documents.get(params.textDocument.uri);
    if (!textDocument) return null;

    const text = textDocument.getText();
    const { line, character } = params.position;

    // -----------------------------------------------------------------------
    // 场景 1：光标在 #include 路径上
    // -----------------------------------------------------------------------
    const includeInfo = getIncludeAtPosition(text, line, character);
    if (includeInfo) {
        const fileFsPath = URI.parse(textDocument.uri).fsPath;
        const engineDir = get_environment_path(textDocument);
        const engineChunksDir = getEngineChuinksDir(engineDir || DefaultEngineDirectory);

        const resolved = resolveIncludePath(
            includeInfo.includePath,
            fileFsPath,
            engineChunksDir,
        );

        if (resolved) {
            const targetUri = URI.file(resolved).toString();
            return {
                uri: targetUri,
                range: Range.create(Position.create(0, 0), Position.create(0, 0)),
            };
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // 场景 2：光标在 vert/frag 值的 program 名称上（仅 .effect 文件）
    // -----------------------------------------------------------------------
    const fileFsPath = URI.parse(textDocument.uri).fsPath;
    if (fileFsPath.endsWith('.effect')) {
        const programName = getProgramNameAtPosition(text, line, character);
        if (programName) {
            const declarations = findCCProgramDeclarations(text);
            const declPos = declarations.get(programName);
            if (declPos) {
                return {
                    uri: textDocument.uri,
                    range: Range.create(declPos, declPos),
                };
            }
        }
    }

    return null;
}
