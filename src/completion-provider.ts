/**
 * completion-provider.ts
 *
 * 为 .effect / .chunk 文件提供三类补全：
 *  1. GLSL 符号补全：来自 engine cache（parsed-effect-info.json）的函数/宏/变量/关键字
 *  2. #include 路径补全：触发字符 < / " 时，列出引擎 chunks 目录下的 .chunk 文件
 *  3. CCEffect YAML 补全：在 YAML 块内提供字段名 + 枚举值补全
 */

import {
    CompletionItem,
    CompletionItemKind,
    CompletionParams,
    InsertTextFormat,
    TextEdit,
    Range,
    Position,
} from 'vscode-languageserver/node';

import * as fs from 'fs';
import * as path from 'path';

import { documentCaches, engineCaches } from './cc-utils';
import { documents } from './server';
import { getEngineChuinksDir as getEngineChunksDir } from './include-resolver';

// ---------------------------------------------------------------------------
// 常量：CCEffect YAML 字段补全数据
// ---------------------------------------------------------------------------

const TECHNIQUE_FIELDS: CompletionItem[] = [
    { label: 'name', kind: CompletionItemKind.Field, detail: 'technique 名称（如 opaque, transparent）' },
    { label: 'passes', kind: CompletionItemKind.Field, detail: 'pass 列表' },
];

const PASS_FIELDS: CompletionItem[] = ((): CompletionItem[] => {
    const defs: Array<[string, string]> = [
        ['vert', 'vertex shader：programName 或 programName:entryFn'],
        ['frag', 'fragment shader：programName 或 programName:entryFn'],
        ['phase', 'pass phase 标记（如 forward-add, shadow-caster）'],
        ['pass', 'pass 标识符'],
        ['propertyIndex', '引用第 N 个 pass 的 properties（0-based）'],
        ['priority', '渲染优先级（整数）'],
        ['primitive', '图元类型'],
        ['stage', '渲染阶段'],
        ['embeddedMacros', '内联宏定义（key: value map）'],
        ['rasterizerState', '光栅化状态'],
        ['depthStencilState', '深度/模板状态'],
        ['blendState', '混合状态'],
        ['properties', 'Material 属性定义'],
        ['migrations', '属性迁移规则'],
        ['dynamics', '动态状态标志'],
    ];
    return defs.map(([label, detail]) => ({ label, kind: CompletionItemKind.Field, detail }));
})();

const RASTERIZER_FIELDS: CompletionItem[] = [
    { label: 'cullMode', kind: CompletionItemKind.Field, detail: 'none | front | back' },
    { label: 'isDiscard', kind: CompletionItemKind.Field, detail: 'true | false' },
    { label: 'polygonMode', kind: CompletionItemKind.Field, detail: 'fill | line | point' },
    { label: 'shadeModel', kind: CompletionItemKind.Field, detail: 'gourand | flat' },
    { label: 'isFrontFaceCCW', kind: CompletionItemKind.Field, detail: 'true | false' },
    { label: 'depthBiasEnabled', kind: CompletionItemKind.Field, detail: 'true | false' },
    { label: 'depthBias', kind: CompletionItemKind.Field, detail: 'float' },
    { label: 'depthBiasSlop', kind: CompletionItemKind.Field, detail: 'float' },
    { label: 'isDepthClip', kind: CompletionItemKind.Field, detail: 'true | false' },
    { label: 'isMultisample', kind: CompletionItemKind.Field, detail: 'true | false' },
    { label: 'lineWidth', kind: CompletionItemKind.Field, detail: 'float' },
];

const DEPTH_STENCIL_FIELDS: CompletionItem[] = [
    { label: 'depthTest', kind: CompletionItemKind.Field, detail: 'true | false' },
    { label: 'depthWrite', kind: CompletionItemKind.Field, detail: 'true | false' },
    { label: 'depthFunc', kind: CompletionItemKind.Field, detail: 'never|less|equal|less_equal|greater|not_equal|greater_equal|always' },
    { label: 'stencilTestFront', kind: CompletionItemKind.Field, detail: 'true | false' },
    { label: 'stencilFuncFront', kind: CompletionItemKind.Field, detail: 'ComparisonFunc' },
    { label: 'stencilReadMaskFront', kind: CompletionItemKind.Field, detail: 'int (hex ok)' },
    { label: 'stencilWriteMaskFront', kind: CompletionItemKind.Field, detail: 'int (hex ok)' },
    { label: 'stencilFailOpFront', kind: CompletionItemKind.Field, detail: 'StencilOp' },
    { label: 'stencilZFailOpFront', kind: CompletionItemKind.Field, detail: 'StencilOp' },
    { label: 'stencilPassOpFront', kind: CompletionItemKind.Field, detail: 'StencilOp' },
    { label: 'stencilRefFront', kind: CompletionItemKind.Field, detail: 'int (hex ok)' },
    { label: 'stencilTestBack', kind: CompletionItemKind.Field, detail: 'true | false' },
    { label: 'stencilFuncBack', kind: CompletionItemKind.Field, detail: 'ComparisonFunc' },
    { label: 'stencilReadMaskBack', kind: CompletionItemKind.Field, detail: 'int (hex ok)' },
    { label: 'stencilWriteMaskBack', kind: CompletionItemKind.Field, detail: 'int (hex ok)' },
    { label: 'stencilFailOpBack', kind: CompletionItemKind.Field, detail: 'StencilOp' },
    { label: 'stencilZFailOpBack', kind: CompletionItemKind.Field, detail: 'StencilOp' },
    { label: 'stencilPassOpBack', kind: CompletionItemKind.Field, detail: 'StencilOp' },
    { label: 'stencilRefBack', kind: CompletionItemKind.Field, detail: 'int (hex ok)' },
    // 简写别名
    { label: 'stencilRef', kind: CompletionItemKind.Field, detail: 'int (hex ok) — 同时设置 front/back' },
    { label: 'stencilReadMask', kind: CompletionItemKind.Field, detail: 'int (hex ok) — 同时设置 front/back' },
    { label: 'stencilWriteMask', kind: CompletionItemKind.Field, detail: 'int (hex ok) — 同时设置 front/back' },
];

const BLEND_STATE_FIELDS: CompletionItem[] = [
    { label: 'isA2C', kind: CompletionItemKind.Field, detail: 'true | false' },
    { label: 'isIndepend', kind: CompletionItemKind.Field, detail: 'true | false' },
    { label: 'blendColor', kind: CompletionItemKind.Field, detail: 'int' },
    { label: 'targets', kind: CompletionItemKind.Field, detail: 'blend target 列表' },
];

const BLEND_TARGET_FIELDS: CompletionItem[] = [
    { label: 'blend', kind: CompletionItemKind.Field, detail: 'true | false' },
    { label: 'blendSrc', kind: CompletionItemKind.Field, detail: 'BlendFactor' },
    { label: 'blendDst', kind: CompletionItemKind.Field, detail: 'BlendFactor' },
    { label: 'blendSrcAlpha', kind: CompletionItemKind.Field, detail: 'BlendFactor' },
    { label: 'blendDstAlpha', kind: CompletionItemKind.Field, detail: 'BlendFactor' },
    { label: 'blendEq', kind: CompletionItemKind.Field, detail: 'BlendOp: add|sub|rev_sub|min|max' },
    { label: 'blendAlphaEq', kind: CompletionItemKind.Field, detail: 'BlendOp: add|sub|rev_sub|min|max' },
    { label: 'blendColorMask', kind: CompletionItemKind.Field, detail: 'ColorMask: none|r|g|b|a|rg|rgb|all …' },
];

const PROPERTY_FIELDS: CompletionItem[] = [
    { label: 'value', kind: CompletionItemKind.Field, detail: '默认值（数组或内置纹理名）' },
    { label: 'target', kind: CompletionItemKind.Field, detail: '映射到 uniform：uniformName 或 uniformName.xyzw' },
    { label: 'linear', kind: CompletionItemKind.Field, detail: 'true | false — 是否 linear 颜色空间' },
    { label: 'editor', kind: CompletionItemKind.Field, detail: '编辑器显示设置' },
];

const EDITOR_FIELDS: CompletionItem[] = [
    { label: 'displayName', kind: CompletionItemKind.Field, detail: '在 Inspector 中显示的名字' },
    { label: 'type', kind: CompletionItemKind.Field, detail: 'color | gradient | …' },
    { label: 'parent', kind: CompletionItemKind.Field, detail: '依赖的宏名（宏关闭时隐藏）' },
    { label: 'visible', kind: CompletionItemKind.Field, detail: 'true | false' },
    { label: 'slide', kind: CompletionItemKind.Field, detail: 'true | false — 是否显示为滑条' },
    { label: 'range', kind: CompletionItemKind.Field, detail: '[min, max]' },
    { label: 'step', kind: CompletionItemKind.Field, detail: '步进值' },
    { label: 'tooltip', kind: CompletionItemKind.Field, detail: '鼠标悬停提示' },
];

/** 枚举值补全（key = 字段名，value = 可选值列表） */
const ENUM_VALUES: Record<string, string[]> = {
    cullMode:             ['none', 'front', 'back'],
    polygonMode:          ['fill', 'line', 'point'],
    shadeModel:           ['gourand', 'flat'],
    depthFunc:            ['never', 'less', 'equal', 'less_equal', 'greater', 'not_equal', 'greater_equal', 'always'],
    stencilFuncFront:     ['never', 'less', 'equal', 'less_equal', 'greater', 'not_equal', 'greater_equal', 'always'],
    stencilFuncBack:      ['never', 'less', 'equal', 'less_equal', 'greater', 'not_equal', 'greater_equal', 'always'],
    stencilFailOpFront:   ['zero', 'keep', 'replace', 'incr', 'decr', 'invert', 'incr_wrap', 'decr_wrap'],
    stencilZFailOpFront:  ['zero', 'keep', 'replace', 'incr', 'decr', 'invert', 'incr_wrap', 'decr_wrap'],
    stencilPassOpFront:   ['zero', 'keep', 'replace', 'incr', 'decr', 'invert', 'incr_wrap', 'decr_wrap'],
    stencilFailOpBack:    ['zero', 'keep', 'replace', 'incr', 'decr', 'invert', 'incr_wrap', 'decr_wrap'],
    stencilZFailOpBack:   ['zero', 'keep', 'replace', 'incr', 'decr', 'invert', 'incr_wrap', 'decr_wrap'],
    stencilPassOpBack:    ['zero', 'keep', 'replace', 'incr', 'decr', 'invert', 'incr_wrap', 'decr_wrap'],
    blendSrc:             ['zero', 'one', 'src_alpha', 'dst_alpha', 'one_minus_src_alpha', 'one_minus_dst_alpha', 'src_color', 'dst_color', 'one_minus_src_color', 'one_minus_dst_color', 'src_alpha_saturate', 'constant_color', 'one_minus_constant_color', 'constant_alpha', 'one_minus_constant_alpha'],
    blendDst:             ['zero', 'one', 'src_alpha', 'dst_alpha', 'one_minus_src_alpha', 'one_minus_dst_alpha', 'src_color', 'dst_color', 'one_minus_src_color', 'one_minus_dst_color', 'src_alpha_saturate', 'constant_color', 'one_minus_constant_color', 'constant_alpha', 'one_minus_constant_alpha'],
    blendSrcAlpha:        ['zero', 'one', 'src_alpha', 'dst_alpha', 'one_minus_src_alpha', 'one_minus_dst_alpha', 'src_color', 'dst_color', 'one_minus_src_color', 'one_minus_dst_color', 'src_alpha_saturate'],
    blendDstAlpha:        ['zero', 'one', 'src_alpha', 'dst_alpha', 'one_minus_src_alpha', 'one_minus_dst_alpha', 'src_color', 'dst_color', 'one_minus_src_color', 'one_minus_dst_color', 'src_alpha_saturate'],
    blendEq:              ['add', 'sub', 'rev_sub', 'min', 'max'],
    blendAlphaEq:         ['add', 'sub', 'rev_sub', 'min', 'max'],
    blendColorMask:       ['none', 'r', 'g', 'b', 'a', 'rg', 'rb', 'ra', 'gb', 'ga', 'ba', 'rgb', 'rga', 'rba', 'gba', 'all'],
};

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 判断给定位置是否在 CCEffect %{...}% YAML 块内 */
function isInYamlBlock(text: string, offset: number): boolean {
    const yamlStart = /^CCEffect\s+%\{/m.exec(text);
    if (!yamlStart) return false;
    const blockOpen = yamlStart.index + yamlStart[0].length;

    // 找到 }% 结束位置
    const closeMatch = /\}%/.exec(text.slice(blockOpen));
    if (!closeMatch) return false;
    const blockClose = blockOpen + closeMatch.index;

    return offset > blockOpen && offset < blockClose;
}

/** 判断是否在 CCProgram 块的某一行（GLSL 区域） */
function isInGlslBlock(text: string, offset: number): boolean {
    return !isInYamlBlock(text, offset);
}

/** 获取光标所在行的行文本 */
function getLineText(text: string, offset: number): string {
    const start = text.lastIndexOf('\n', offset - 1) + 1;
    const end = text.indexOf('\n', offset);
    return text.slice(start, end === -1 ? undefined : end);
}

/**
 * 检测光标是否在 `#include <...>` 或 `#include "..."` 的路径部分，
 * 返回已输入的路径前缀（如 "builtin/uniforms/cc-"），否则返回 null。
 */
function getIncludePrefix(lineText: string, character: number): string | null {
    const includeRe = /^[ \t]*#include\s+[<"]([^>"]*)/;
    const m = includeRe.exec(lineText);
    if (!m) return null;
    // 检查光标是否在路径部分内
    const pathStart = lineText.indexOf(m[1]) ;
    if (character < pathStart) return null;
    return m[1].slice(0, character - pathStart);
}

/** 获取光标所在行的 YAML key（冒号前的词），用于枚举值补全 */
function getYamlKey(lineText: string): string | null {
    const m = /^[ \t]*-?\s*([\w]+)\s*:/.exec(lineText);
    return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// #include 路径补全：遍历引擎 chunks 目录
// ---------------------------------------------------------------------------

const chunkCache = new Map<string, CompletionItem[]>(); // key = engineDir

function buildChunkCompletions(engineDir: string): CompletionItem[] {
    if (chunkCache.has(engineDir)) return chunkCache.get(engineDir)!;

    const chunksDir = getEngineChunksDir(engineDir);
    if (!fs.existsSync(chunksDir)) return [];

    const items: CompletionItem[] = [];
    walkDir(chunksDir, chunksDir, items);
    chunkCache.set(engineDir, items);
    return items;
}

function walkDir(baseDir: string, currentDir: string, items: CompletionItem[]): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
            walkDir(baseDir, fullPath, items);
        } else if (entry.name.endsWith('.chunk')) {
            // 计算相对路径并去掉 .chunk 后缀（effect 中 #include 不需要写后缀）
            let rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
            const withoutExt = rel.replace(/\.chunk$/, '');
            items.push({
                label: withoutExt,
                kind: CompletionItemKind.File,
                detail: 'engine chunk: ' + rel,
                sortText: withoutExt,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// 主补全提供器
// ---------------------------------------------------------------------------

export function enhancedCompletionProvider(params: CompletionParams): CompletionItem[] {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

    const text = doc.getText();
    const offset = doc.offsetAt(params.position);
    const lineText = getLineText(text, offset);
    const character = params.position.character;

    const cache = documentCaches.get(doc.uri);
    const engineDir = cache?.enginePath ?? '';

    // ── 1. #include 路径补全（GLSL 区域）──────────────────────────────────
    const includePrefix = getIncludePrefix(lineText, character);
    if (includePrefix !== null && engineDir) {
        const allChunks = buildChunkCompletions(engineDir);
        // 过滤前缀匹配
        return allChunks.filter(item =>
            item.label.startsWith(includePrefix) || includePrefix === '',
        );
    }

    // ── 2. CCEffect YAML 区域补全 ──────────────────────────────────────────
    if (isInYamlBlock(text, offset)) {
        return getYamlCompletions(lineText, character, text, offset);
    }

    // ── 3. GLSL 符号补全（函数/宏/变量/关键字）────────────────────────────
    const engineCache = engineDir ? engineCaches.get(engineDir) : undefined;
    const docItems = cache?.CompletionItems ?? [];
    const engineItems = engineCache?.CompletionItems ?? [];
    return [...docItems, ...engineItems];
}

// ---------------------------------------------------------------------------
// YAML 区域补全
// ---------------------------------------------------------------------------

function getYamlCompletions(
    lineText: string,
    character: number,
    fullText: string,
    offset: number,
): CompletionItem[] {
    const trimmed = lineText.trimStart();
    const indent = lineText.length - lineText.trimStart().length;

    // ── 枚举值补全：光标在冒号后（`key: <cursor>`） ──────────────────────
    const afterColonRe = /^[ \t]*-?\s*([\w]+)\s*:\s*/;
    const afterColonMatch = afterColonRe.exec(lineText);
    if (afterColonMatch && character >= afterColonMatch[0].length) {
        const key = afterColonMatch[1];
        if (ENUM_VALUES[key]) {
            return ENUM_VALUES[key].map(val => ({
                label: val,
                kind: CompletionItemKind.EnumMember,
                detail: `${key} 枚举值`,
            }));
        }
        // bool 字段
        const boolKeys = new Set([
            'blend', 'depthTest', 'depthWrite',
            'stencilTestFront', 'stencilTestBack',
            'isDiscard', 'isFrontFaceCCW', 'depthBiasEnabled',
            'isDepthClip', 'isMultisample', 'isA2C', 'isIndepend',
            'linear', 'visible', 'slide',
        ]);
        if (boolKeys.has(key)) {
            return [
                { label: 'true', kind: CompletionItemKind.Keyword },
                { label: 'false', kind: CompletionItemKind.Keyword },
            ];
        }
        return [];
    }

    // ── 字段名补全（光标在行首缩进后，还没有冒号）─────────────────────────
    // 根据上下文缩进层级判断返回哪组字段
    const ctx = detectYamlContext(fullText, offset, indent);
    switch (ctx) {
        case 'technique':       return TECHNIQUE_FIELDS;
        case 'pass':            return PASS_FIELDS;
        case 'rasterizerState': return RASTERIZER_FIELDS;
        case 'depthStencil':    return DEPTH_STENCIL_FIELDS;
        case 'blendState':      return BLEND_STATE_FIELDS;
        case 'blendTarget':     return BLEND_TARGET_FIELDS;
        case 'property':        return PROPERTY_FIELDS;
        case 'editor':          return EDITOR_FIELDS;
        default:                return [...TECHNIQUE_FIELDS, ...PASS_FIELDS];
    }
}

/**
 * 向上扫描已解析的 YAML 行，推断光标处的上下文层级。
 * 返回上下文名称，用于选择合适的字段补全列表。
 */
function detectYamlContext(
    text: string,
    offset: number,
    curIndent: number,
): string {
    // 取光标所在行号（0-based）
    const lines = text.slice(0, offset).split(/\r?\n/);
    const curLine = lines.length - 1;

    // 向上逐行扫描，找到 curIndent 更小的父节点
    const allLines = text.split(/\r?\n/);

    for (let i = curLine - 1; i >= 0; i--) {
        const raw = allLines[i];
        if (!raw.trim() || raw.trim().startsWith('#')) continue;
        const lineIndent = raw.search(/\S/);
        if (lineIndent >= curIndent) continue;

        // 父节点 key
        const keyMatch = /^[ \t]*-?\s*([\w]+)\s*:/.exec(raw);
        const key = keyMatch ? keyMatch[1] : '';

        // 列表项（`- ` 且无 key）
        const isList = /^[ \t]*-\s*$/.exec(raw) !== null || raw.trimStart().startsWith('- ');

        if (key === 'techniques')      return 'technique';
        if (key === 'passes')          return 'pass';
        if (key === 'rasterizerState') return 'rasterizerState';
        if (key === 'depthStencilState') return 'depthStencil';
        if (key === 'blendState')      return 'blendState';
        if (key === 'targets')         return 'blendTarget';
        if (key === 'properties')      return 'property';
        if (key === 'editor')          return 'editor';

        // 找到 passes 列表项 → pass
        if (isList && lineIndent < curIndent) {
            // 继续向上查 passes
            for (let j = i - 1; j >= 0; j--) {
                const upper = allLines[j];
                if (/passes\s*:/.test(upper)) return 'pass';
                if (/techniques\s*:/.test(upper)) return 'technique';
                if (upper.trim() && upper.search(/\S/) < lineIndent) break;
            }
        }

        if (lineIndent < curIndent) break;
    }

    return 'unknown';
}

export function completionResolver(item: CompletionItem): CompletionItem {
    return item;
}
