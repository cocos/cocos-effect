/**
 * effect-checker-runner.ts
 *
 * 调用引擎内置 effect-checker.exe 对 .effect 文件进行编译检查，
 * 将输出解析为 LSP Diagnostic 数组后通过 connection.sendDiagnostics() 推送。
 *
 * effect-checker.exe 用法：
 *   effect-checker.exe 0 <effectFilePath> <engineRootDir>
 *
 * 输出格式（有错时）：
 *   filename.effect(line,col): --programName ERROR: 0:glslLine: 'symbol' : message
 *   ERROR: 0:glslLine: 'symbol' : message   ← 后续关联错误，无 effect 文件位置
 *   ERROR: N compilation errors.  No code generated.
 *
 * 输出格式（无错时）：
 *   Compilation Succeeded!  --filename.effect
 */

import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

import {
    Diagnostic,
    DiagnosticSeverity,
    Range,
    Position,
} from 'vscode-languageserver/node';

import { URI } from 'vscode-uri';
import { compilerExecPath } from '../file-utils';

/** 
 * 匹配首行错误：
 *   filename.effect(189,0): --unlit-fs ERROR: 0:353: 'mainColor1' : undeclared identifier
 * 捕获组：(1)=effectLine (2)=effectCol (3)=programName (4)=severity (5)=glslLine (6)=message
 */
const FIRST_ERROR_RE = /\((\d+),(\d+)\):\s*--(\S+)\s+(ERROR|WARNING):\s*\d+:(\d+):\s*(.*)/;

/**
 * 匹配后续关联错误（无 effect 文件位置）：
 *   ERROR: 0:353: 'symbol' : message
 * 捕获组：(1)=severity (2)=glslLine (3)=message
 */
const FOLLOW_ERROR_RE = /^(ERROR|WARNING):\s*\d+:(\d+):\s*(.*)/;

/** 匹配汇总行，忽略 */
const SUMMARY_RE = /ERROR:\s*\d+\s*compilation error/;

export interface CheckResult {
    /** 解析出的 Diagnostic 列表（已可直接 sendDiagnostics） */
    diagnostics: Diagnostic[];
    /** effect-checker 的原始输出（用于调试） */
    raw: string;
    /** 是否成功编译（无错误） */
    success: boolean;
}

/**
 * 运行 effect-checker.exe 并返回解析结果。
 *
 * @param effectFilePath  .effect 文件的绝对路径
 * @param engineRootDir   引擎根目录的绝对路径
 * @returns CheckResult，若 checker 不存在则返回空结果
 */
export async function runEffectChecker(
    effectFilePath: string,
    engineRootDir: string,
): Promise<CheckResult> {
    const checkerPath = path.join(engineRootDir, compilerExecPath);

    if (!fs.existsSync(checkerPath)) {
        return { diagnostics: [], raw: '', success: true };
    }

    const raw = await execChecker(checkerPath, effectFilePath, engineRootDir);
    const diagnostics = parseOutput(raw, effectFilePath);
    const success = raw.startsWith('Compilation Succeeded');

    return { diagnostics, raw, success };
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

function execChecker(
    checkerPath: string,
    effectFilePath: string,
    engineRootDir: string,
): Promise<string> {
    return new Promise((resolve) => {
        const args = ['0', effectFilePath, engineRootDir];
        let output = '';
        const proc = cp.spawn(checkerPath, args, { windowsHide: true });
        proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        proc.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        proc.on('close', () => resolve(output.trim()));
        proc.on('error', () => resolve(''));
    });
}

/**
 * 解析 effect-checker 的文本输出，提取 Diagnostic。
 *
 * 策略：
 * - 首行错误带有 effect 文件的 (line, col) → 可精确定位
 * - 后续关联错误只有 GLSL 行号，无法映射回 effect 文件
 *   → 附加到最近一条有位置的诊断的 relatedInformation（若支持），
 *     或作为独立 Diagnostic 附在同一行（降级处理）
 */
function parseOutput(raw: string, effectFilePath: string): Diagnostic[] {
    if (!raw || raw.startsWith('Compilation Succeeded')) {
        return [];
    }

    const diagnostics: Diagnostic[] = [];
    const lines = raw.split(/\r?\n/);

    // 记录最近一条"有 effect 位置"的诊断，用于把后续关联错误挂到同一位置
    let lastDiagnostic: Diagnostic | undefined;

    for (const line of lines) {
        if (!line.trim()) continue;
        if (SUMMARY_RE.test(line)) continue; // 跳过汇总行

        // --- 尝试匹配首行错误（含 effect 文件位置）---
        const firstMatch = FIRST_ERROR_RE.exec(line);
        if (firstMatch) {
            const effectLine = Math.max(0, parseInt(firstMatch[1], 10) - 1); // 转 0-based
            const effectCol  = Math.max(0, parseInt(firstMatch[2], 10));
            const programName = firstMatch[3];
            const severity = firstMatch[4] === 'WARNING'
                ? DiagnosticSeverity.Warning
                : DiagnosticSeverity.Error;
            const glslLine  = firstMatch[5];
            const message   = firstMatch[6].trim();

            const range = Range.create(
                Position.create(effectLine, effectCol),
                Position.create(effectLine, effectCol + 1),
            );

            const diag: Diagnostic = {
                range,
                severity,
                source: `effect-checker [${programName}]`,
                message: `(glsl:${glslLine}) ${message}`,
            };

            diagnostics.push(diag);
            lastDiagnostic = diag;
            continue;
        }

        // --- 尝试匹配后续关联错误（无 effect 文件位置）---
        const followMatch = FOLLOW_ERROR_RE.exec(line);
        if (followMatch) {
            const severity = followMatch[1] === 'WARNING'
                ? DiagnosticSeverity.Warning
                : DiagnosticSeverity.Error;
            const glslLine = followMatch[2];
            const message  = followMatch[3].trim();

            if (lastDiagnostic) {
                // 追加到上一条诊断的消息里，作为补充信息
                lastDiagnostic.message += `\n↳ (glsl:${glslLine}) ${message}`;
            } else {
                // 没有上下文时，放在文件顶部
                const diag: Diagnostic = {
                    range: Range.create(Position.create(0, 0), Position.create(0, 1)),
                    severity,
                    source: 'effect-checker',
                    message: `(glsl:${glslLine}) ${message}`,
                };
                diagnostics.push(diag);
            }
        }
    }

    return diagnostics;
}
