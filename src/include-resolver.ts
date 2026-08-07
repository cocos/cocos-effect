/**
 * include-resolver.ts
 * 
 * 解析 .effect / .chunk 文件中的 #include 语句，
 * 将 include 路径映射到引擎 chunks 目录下的实际文件路径。
 * 
 * Cocos Effect 的 #include 规则：
 *   #include <foo/bar>   → <engineRoot>/editor/assets/chunks/foo/bar.chunk
 *   #include "foo/bar"   → 相对于当前文件目录的 foo/bar.chunk（fallback 到引擎 chunks）
 */

import * as fs from 'fs';
import * as path from 'path';

/** 引擎 chunks 子目录（相对引擎根目录） */
export const CHUNKS_SUB_PATH = 'editor/assets/chunks';

/** 匹配 #include <...> 或 #include "..." 的正则 */
export const INCLUDE_RE = /^[ \t]*#include\s+[<"]([^>"]+)[>"]/;

/** 全文匹配所有 #include（gm 模式） */
export const INCLUDE_RE_GLOBAL = /^[ \t]*#include\s+[<"]([^>"]+)[>"]/gm;

export interface IncludeInfo {
    /** 尖括号/引号内的原始路径，如 "legacy/input" */
    includePath: string;
    /** 在文档中的字符偏移起点（整行起点） */
    lineStart: number;
    /** 行号（0-based） */
    line: number;
    /** include 路径在行内的起始列（0-based） */
    pathColStart: number;
    /** include 路径在行内的结束列（0-based，exclusive） */
    pathColEnd: number;
}

/**
 * 扫描文本内所有 #include，返回每个 include 的位置信息
 */
export function findAllIncludes(text: string): IncludeInfo[] {
    const result: IncludeInfo[] = [];
    const lines = text.split('\n');

    let lineStart = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const lineText = lines[lineIndex];
        const m = INCLUDE_RE.exec(lineText);
        if (m) {
            const includePath = m[1];
            // 找到尖括号或引号内路径的列位置
            const bracketIdx = lineText.indexOf('<');
            const quoteIdx = lineText.indexOf('"');
            let openIdx = -1;
            if (bracketIdx >= 0 && (quoteIdx < 0 || bracketIdx < quoteIdx)) {
                openIdx = bracketIdx;
            } else {
                openIdx = quoteIdx;
            }
            const pathColStart = openIdx + 1; // 跳过 < 或 "
            const pathColEnd = pathColStart + includePath.length;

            result.push({
                includePath,
                lineStart,
                line: lineIndex,
                pathColStart,
                pathColEnd,
            });
        }
        // +1 for the \n character
        lineStart += lineText.length + 1;
    }
    return result;
}

/**
 * 将 include 路径解析为文件系统的绝对路径。
 * 
 * 解析顺序：
 * 1. 相对当前文件目录 + .chunk 扩展名
 * 2. 相对当前文件目录（无扩展）
 * 3. engineChunksDir/<includePath>.chunk
 * 4. engineChunksDir/<includePath>（无扩展）
 * 
 * @param includePath  #include 中的路径字符串，如 "legacy/input"
 * @param currentFilePath  当前正在编辑的文件的绝对路径
 * @param engineChunksDir  引擎 chunks 目录的绝对路径，如 "D:/cocos4/editor/assets/chunks"
 * @returns 解析到的绝对文件路径，若未找到则返回 undefined
 */
export function resolveIncludePath(
    includePath: string,
    currentFilePath: string,
    engineChunksDir: string,
): string | undefined {
    const currentDir = path.dirname(currentFilePath);

    const candidates: string[] = [
        // 相对当前目录（带 .chunk 后缀）
        path.join(currentDir, includePath + '.chunk'),
        // 相对当前目录（不加后缀，已带后缀的情况）
        path.join(currentDir, includePath),
        // 引擎 chunks 目录（带 .chunk 后缀）
        path.join(engineChunksDir, includePath + '.chunk'),
        // 引擎 chunks 目录（不加后缀）
        path.join(engineChunksDir, includePath),
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }
    return undefined;
}

/**
 * 根据引擎根目录构建 chunks 目录路径
 */
export function getEngineChuinksDir(engineRootDir: string): string {
    return path.join(engineRootDir, CHUNKS_SUB_PATH);
}

/**
 * 检测光标位置是否在某个 #include 的路径上
 * 
 * @param text  文档全文
 * @param line  光标行（0-based）
 * @param character  光标列（0-based）
 * @returns  命中的 IncludeInfo，否则 undefined
 */
export function getIncludeAtPosition(
    text: string,
    line: number,
    character: number,
): IncludeInfo | undefined {
    const includes = findAllIncludes(text);
    return includes.find(
        (inc) =>
            inc.line === line &&
            character >= inc.pathColStart &&
            character <= inc.pathColEnd,
    );
}
