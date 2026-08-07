/**
 * yaml-validator.ts
 *
 * 对 .effect 文件中的 CCEffect %{...}% YAML 块进行静态校验，
 * 生成 LSP Diagnostic（不依赖 effect-checker.exe，纯文本分析）。
 *
 * 校验内容：
 *  1. 顶层必须有 `techniques` 字段
 *  2. technique 必须有 `passes` 字段（而不是其他拼写）
 *  3. pass 必须包含 `vert` 和 `frag` 字段（或 propertyIndex 引用）
 *  4. pass.vert / pass.frag 格式应为 `programName` 或 `programName:entry`
 *  5. blendState.targets[].blendSrc/blendDst 等字段值必须是合法枚举
 *  6. rasterizerState.cullMode 必须是合法枚举
 *  7. depthStencilState.depthFunc / stencilFunc* 必须是合法枚举
 *  8. property value 的 target 字段必须是 `uniformName.swizzle` 格式
 *  9. 未知的 pass 顶层字段给 Warning
 */

import {
    Diagnostic,
    DiagnosticSeverity,
    Range,
    Position,
} from 'vscode-languageserver/node';

// ---------------------------------------------------------------------------
// 合法枚举值（从引擎 offline-mappings.ts 的 passParams 提取，全部小写）
// ---------------------------------------------------------------------------

const BLEND_FACTOR = new Set([
    'zero', 'one',
    'src_alpha', 'dst_alpha', 'one_minus_src_alpha', 'one_minus_dst_alpha',
    'src_color', 'dst_color', 'one_minus_src_color', 'one_minus_dst_color',
    'src_alpha_saturate',
    'constant_color', 'one_minus_constant_color',
    'constant_alpha', 'one_minus_constant_alpha',
]);

const BLEND_OP = new Set(['add', 'sub', 'rev_sub', 'min', 'max']);

const COLOR_MASK = new Set([
    'none', 'r', 'g', 'b', 'a',
    'rg', 'rb', 'ra', 'gb', 'ga', 'ba',
    'rgb', 'rga', 'rba', 'gba', 'all',
]);

const COMPARISON_FUNC = new Set([
    'never', 'less', 'equal', 'less_equal',
    'greater', 'not_equal', 'greater_equal', 'always',
]);

const STENCIL_OP = new Set([
    'zero', 'keep', 'replace', 'incr', 'decr', 'invert', 'incr_wrap', 'decr_wrap',
]);

const CULL_MODE = new Set(['none', 'front', 'back']);

const PRIMITIVE_MODE = new Set([
    'point_list', 'line_list', 'line_strip', 'line_loop',
    'triangle_list', 'triangle_strip', 'triangle_fan',
    'line_list_adjacency', 'line_strip_adjacency',
    'triangle_list_adjacency', 'triangle_strip_adjacency',
    'triangle_patch_adjacency', 'quad_patch_list', 'iso_line_list',
]);

const SHADE_MODEL = new Set(['gourand', 'flat']);
const POLYGON_MODE = new Set(['fill', 'line', 'point']);

/** pass 顶层允许的字段 */
const PASS_KNOWN_KEYS = new Set([
    'vert', 'frag', 'phase', 'pass', 'propertyIndex', 'priority',
    'primitive', 'stage', 'embeddedMacros',
    'rasterizerState', 'depthStencilState', 'blendState',
    'properties', 'migrations', 'dynamics', 'shader', 'device',
]);

/** technique 顶层允许的字段 */
const TECHNIQUE_KNOWN_KEYS = new Set(['name', 'passes']);

// ---------------------------------------------------------------------------
// 简单的 YAML 行解析工具（不依赖第三方 YAML 库）
// ---------------------------------------------------------------------------

interface YamlLine {
    /** 0-based 行号（在整个文档中） */
    lineNo: number;
    /** 该行的缩进空格数 */
    indent: number;
    /** key（不含冒号）*/
    key: string;
    /** 冒号后面的值字符串（可能为空） */
    value: string;
    /** 是否是列表项（以 `- ` 开头） */
    isList: boolean;
    /** 是否是 YAML 锚点引用行（以 `*` 或 `&` 开头的值） */
    isAnchorRef: boolean;
}

/** 解析 YAML 块（已去掉 CCEffect %{...}% 包裹后的纯 YAML 文本）为行列表。 */
function parseYamlLines(yamlText: string, blockStartLine: number): YamlLine[] {
    const result: YamlLine[] = [];
    const lines = yamlText.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trimEnd();
        if (!trimmed || trimmed.trimStart().startsWith('#')) continue;

        // 去掉行内注释
        const commentIdx = trimmed.indexOf(' #');
        const line = commentIdx !== -1 ? trimmed.slice(0, commentIdx).trimEnd() : trimmed;

        const indent = line.search(/\S/);
        let content = line.trimStart();

        let isList = false;
        if (content.startsWith('- ')) {
            isList = true;
            content = content.slice(2).trimStart();
        } else if (content === '-') {
            isList = true;
            content = '';
        }

        // 解析 key: value（可能有 YAML flow style {k:v}，这里只做简单解析）
        const colonIdx = content.indexOf(':');
        let key = '';
        let value = '';
        if (colonIdx !== -1) {
            key = content.slice(0, colonIdx).trim();
            value = content.slice(colonIdx + 1).trim();
        } else {
            key = content;
            value = '';
        }

        const isAnchorRef = value.startsWith('*') || value.startsWith('&');

        result.push({
            lineNo: blockStartLine + i,
            indent,
            key,
            value,
            isList,
            isAnchorRef,
        });
    }

    return result;
}

// ---------------------------------------------------------------------------
// 诊断构建帮助函数
// ---------------------------------------------------------------------------

function makeDiag(
    lineNo: number,
    colStart: number,
    colEnd: number,
    message: string,
    severity: DiagnosticSeverity = DiagnosticSeverity.Error,
    source = 'cceffect-yaml',
): Diagnostic {
    // 若标记范围只有 1 个字符或更少，扩展到行尾，让波浪线更醒目
    // 2147483647 是 LSP uinteger 最大値，VSCode 自动裁剪到实际行长度
    const endCol = colEnd > colStart + 1 ? colEnd : 2147483647;
    return {
        range: Range.create(
            Position.create(lineNo, colStart),
            Position.create(lineNo, endCol),
        ),
        severity,
        source,
        message,
    };
}

/** 在原始行中找到 value 字符串的列偏移 */
function findValueCol(rawLine: string, value: string): { start: number; end: number } {
    const idx = rawLine.indexOf(value);
    if (idx === -1) return { start: 0, end: Math.max(1, rawLine.length) };
    return { start: idx, end: idx + value.length };
}

/** 在原始行中找到 key 字符串的列偏移 */
function findKeyCol(rawLine: string, key: string): { start: number; end: number } {
    const idx = rawLine.indexOf(key);
    if (idx === -1) return { start: 0, end: Math.max(1, rawLine.length) };
    return { start: idx, end: idx + key.length };
}

// ---------------------------------------------------------------------------
// 主校验逻辑
// ---------------------------------------------------------------------------

/**
 * 解析并校验 .effect 文件中的 CCEffect YAML 块。
 *
 * @param text  整个 .effect 文件文本
 * @returns     诊断数组（空数组 = 无问题）
 */
export function validateCCEffectYaml(text: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    // 找到 CCEffect %{ ... }% 块
    const blockMatch = /^CCEffect\s+%\{([^]*?)\}%/m.exec(text);
    if (!blockMatch) return diagnostics; // 没有 CCEffect 块，不校验

    const blockContent = blockMatch[1];
    // CCEffect 块在文件中的起始行号（0-based）
    const blockStart = text.slice(0, blockMatch.index).split(/\r?\n/).length; // CCEffect 行
    // blockContent 从下一行开始
    const yamlStartLine = blockStart + 1;

    const rawLines = (blockMatch[1]).split(/\r?\n/);
    const yamlLines = parseYamlLines(blockContent, yamlStartLine);

    // 使用原始行做列查找
    const getRawLine = (lineNo: number): string => {
        const offset = lineNo - yamlStartLine;
        return offset >= 0 && offset < rawLines.length ? rawLines[offset] : '';
    };

    // -----------------------------------------------------------------------
    // 校验 1：顶层必须有 techniques
    // -----------------------------------------------------------------------
    const topLevelKeys = yamlLines.filter(l => l.indent === 0 && l.key && !l.isList);
    const hasTechniques = topLevelKeys.some(l => l.key === 'techniques');
    if (!hasTechniques && topLevelKeys.length > 0) {
        const first = topLevelKeys[0];
        diagnostics.push(makeDiag(
            first.lineNo, 0, 1,
            'CCEffect YAML 缺少顶层 `techniques` 字段',
        ));
    }

    // -----------------------------------------------------------------------
    // 逐行分析，定位 technique / pass 结构
    // -----------------------------------------------------------------------

    // 找 technique 列表项（indent=2，isList=true，无 key 或 key="name"/"passes"）
    // 找 pass 列表项（在 passes 下面，indent更深的 isList=true）
    // 这里采用简单状态机：找到 techniques -> 找每个 technique -> 找每个 pass

    let inTechniques = false;
    let techniqueIndent = -1;
    let inPasses = false;
    let passIndent = -1;

    // 用于跟踪 pass 内字段
    let currentPassKeys: Set<string> = new Set();
    let currentPassListLine: YamlLine | null = null;
    let passHasVert = false;
    let passHasFrag = false;
    let passHasPropertyIndex = false;

    // blendState target 状态
    let inBlendTargets = false;
    let blendTargetIndent = -1;

    // depthStencilState / rasterizerState 状态
    let inDepthStencil = false;
    let depthStencilIndent = -1;
    let inRasterizer = false;
    let rasterizerIndent = -1;

    // properties 状态
    let inProperties = false;
    let propertiesIndent = -1;
    let inPropertyDef = false;
    let propertyDefIndent = -1;

    const flushPass = () => {
        if (currentPassListLine && !passHasPropertyIndex && (!passHasVert || !passHasFrag)) {
            // 只在没有锚点引用的 pass 上报错（*anchor 的 pass 不需要重复声明）
            if (!currentPassListLine.isAnchorRef && currentPassListLine.value && !currentPassListLine.value.startsWith('*')) {
                // pass 值是锚点引用，跳过
            } else if (!currentPassListLine.value?.startsWith('*')) {
                const missing: string[] = [];
                if (!passHasVert) missing.push('vert');
                if (!passHasFrag) missing.push('frag');
                if (missing.length > 0) {
                    diagnostics.push(makeDiag(
                        currentPassListLine.lineNo, currentPassListLine.indent, currentPassListLine.indent + 1,
                        `pass 缺少必填字段: ${missing.map(m => `\`${m}\``).join(', ')}`,
                        DiagnosticSeverity.Warning,
                    ));
                }
            }
        }
        currentPassKeys = new Set();
        passHasVert = false;
        passHasFrag = false;
        passHasPropertyIndex = false;
        currentPassListLine = null;
    };

    for (let i = 0; i < yamlLines.length; i++) {
        const yl = yamlLines[i];
        const rawLine = getRawLine(yl.lineNo);

        // ── 检测进入 techniques ──────────────────────────────────────────────
        if (!inTechniques && yl.key === 'techniques' && yl.indent === 0) {
            inTechniques = true;
            techniqueIndent = -1; // 下一行的 list 项决定
            inPasses = false;
            continue;
        }

        // ── 检测 technique 列表项 ────────────────────────────────────────────
        if (inTechniques) {
            if (techniqueIndent === -1 && yl.isList) {
                techniqueIndent = yl.indent;
            }

            if (techniqueIndent !== -1 && yl.isList && yl.indent === techniqueIndent) {
                // 新的 technique 开始
                inPasses = false;
                passIndent = -1;
                flushPass();
                continue;
            }

            // technique 内的字段
            if (techniqueIndent !== -1 && !yl.isList && yl.indent > techniqueIndent) {
                // 检测 passes
                if (yl.key === 'passes' && yl.indent === techniqueIndent + 2) {
                    inPasses = true;
                    passIndent = -1;
                    flushPass();
                    continue;
                }

                // technique 未知字段警告
                if (yl.indent === techniqueIndent + 2 && yl.key && !TECHNIQUE_KNOWN_KEYS.has(yl.key)) {
                    const { start, end } = findKeyCol(rawLine, yl.key);
                    diagnostics.push(makeDiag(
                        yl.lineNo, start, end,
                        `technique 中未知字段 \`${yl.key}\`，有效字段: ${[...TECHNIQUE_KNOWN_KEYS].join(', ')}`,
                        DiagnosticSeverity.Warning,
                    ));
                }
            }
        }

        // ── 检测 pass 列表项 ─────────────────────────────────────────────────
        if (inPasses) {
            if (passIndent === -1 && yl.isList) {
                passIndent = yl.indent;
            }

            if (passIndent !== -1 && yl.isList && yl.indent === passIndent) {
                // 新 pass 开始
                flushPass();
                currentPassListLine = yl;

                // 检测行内 YAML 锚点引用（如 `- *planar-shadow`）
                if (yl.value.startsWith('*')) {
                    // 锚点引用 pass，无需校验内容
                    currentPassListLine = null;
                }

                // 重置子状态
                inBlendTargets = false;
                inDepthStencil = false;
                inRasterizer = false;
                inProperties = false;
                inPropertyDef = false;
                continue;
            }

            // pass 内字段
            if (passIndent !== -1 && yl.indent > passIndent && currentPassListLine !== null) {
                const passFieldIndent = passIndent + 2;

                // ── pass 顶层字段 ──────────────────────────────────────────
                if (yl.indent === passFieldIndent && yl.key) {
                    currentPassKeys.add(yl.key);

                    // 未知字段警告
                    if (!PASS_KNOWN_KEYS.has(yl.key)) {
                        const { start, end } = findKeyCol(rawLine, yl.key);
                        diagnostics.push(makeDiag(
                            yl.lineNo, start, end,
                            `pass 中未知字段 \`${yl.key}\``,
                            DiagnosticSeverity.Warning,
                        ));
                    }

                    if (yl.key === 'vert') {
                        passHasVert = true;
                        validateVertFrag(yl, rawLine, 'vert', diagnostics);
                    } else if (yl.key === 'frag') {
                        passHasFrag = true;
                        validateVertFrag(yl, rawLine, 'frag', diagnostics);
                    } else if (yl.key === 'propertyIndex') {
                        passHasPropertyIndex = true;
                    } else if (yl.key === 'blendState') {
                        inBlendTargets = false;
                        inDepthStencil = false;
                        inRasterizer = false;
                        inProperties = false;
                    } else if (yl.key === 'depthStencilState') {
                        inDepthStencil = true;
                        depthStencilIndent = passFieldIndent;
                        inBlendTargets = false;
                        inRasterizer = false;
                        inProperties = false;
                    } else if (yl.key === 'rasterizerState') {
                        inRasterizer = true;
                        rasterizerIndent = passFieldIndent;
                        inBlendTargets = false;
                        inDepthStencil = false;
                        inProperties = false;
                    } else if (yl.key === 'properties') {
                        inProperties = true;
                        propertiesIndent = passFieldIndent;
                        inBlendTargets = false;
                        inDepthStencil = false;
                        inRasterizer = false;
                    } else {
                        inBlendTargets = false;
                        inDepthStencil = false;
                        inRasterizer = false;
                        inProperties = false;
                    }
                    continue;
                }

                // ── blendState 内部 ────────────────────────────────────────
                if (yl.indent > passFieldIndent) {
                    // targets 列表检测
                    if (yl.key === 'targets') {
                        inBlendTargets = true;
                        blendTargetIndent = -1;
                        continue;
                    }
                    if (inBlendTargets) {
                        if (blendTargetIndent === -1 && yl.isList) {
                            blendTargetIndent = yl.indent;
                        }
                        // blend target 字段
                        if (yl.key) {
                            validateBlendTargetField(yl, rawLine, diagnostics);
                        }
                    }

                    // depthStencilState 内部
                    if (inDepthStencil && yl.indent > depthStencilIndent && yl.key) {
                        validateDepthStencilField(yl, rawLine, diagnostics);
                    }

                    // rasterizerState 内部
                    if (inRasterizer && yl.indent > rasterizerIndent && yl.key) {
                        validateRasterizerField(yl, rawLine, diagnostics);
                    }

                    // properties 内部
                    if (inProperties && yl.key) {
                        // properties > propertyName（缩进 propertiesIndent+2）
                        if (yl.indent === propertiesIndent + 2 && !yl.isList) {
                            inPropertyDef = true;
                            propertyDefIndent = yl.indent;
                        }
                        // properties > propertyName > target
                        if (inPropertyDef && yl.indent > propertyDefIndent && yl.key === 'target') {
                            validateTargetField(yl, rawLine, diagnostics);
                        }
                    }
                }
            }
        }
    }

    // flush 最后一个 pass
    flushPass();

    return diagnostics;
}

// ---------------------------------------------------------------------------
// 子校验函数
// ---------------------------------------------------------------------------

/** 校验 vert/frag 值格式：`programName` 或 `programName:entryName` */
function validateVertFrag(
    yl: YamlLine,
    rawLine: string,
    field: 'vert' | 'frag',
    diags: Diagnostic[],
): void {
    const val = yl.value.trim();
    if (!val || val.startsWith('*') || val.startsWith('&')) return;

    // 合法格式：word 或 word:word（word 可含连字符/下划线）
    const valid = /^[\w-]+(:\s*[\w-]+)?$/.test(val);
    if (!valid) {
        const { start, end } = findValueCol(rawLine, val);
        diags.push(makeDiag(
            yl.lineNo, start, end,
            `\`${field}\` 值格式无效："${val}"。应为 \`programName\` 或 \`programName:entryName\``,
            DiagnosticSeverity.Warning,
        ));
    }
}

/** 校验 blendState.targets 内的字段 */
function validateBlendTargetField(yl: YamlLine, rawLine: string, diags: Diagnostic[]): void {
    const key = yl.key;
    const val = yl.value.trim().toLowerCase();
    if (!val || yl.isAnchorRef) return;

    if (key === 'blendSrc' || key === 'blendDst' || key === 'blendSrcAlpha' || key === 'blendDstAlpha') {
        if (!BLEND_FACTOR.has(val)) {
            const { start, end } = findValueCol(rawLine, yl.value.trim());
            diags.push(makeDiag(
                yl.lineNo, start, end,
                `\`${key}\` 值 "${yl.value.trim()}" 不是合法的 BlendFactor。\n合法值: ${[...BLEND_FACTOR].join(', ')}`,
            ));
        }
    } else if (key === 'blendEq' || key === 'blendAlphaEq') {
        if (!BLEND_OP.has(val)) {
            const { start, end } = findValueCol(rawLine, yl.value.trim());
            diags.push(makeDiag(
                yl.lineNo, start, end,
                `\`${key}\` 值 "${yl.value.trim()}" 不是合法的 BlendOp。合法值: ${[...BLEND_OP].join(', ')}`,
            ));
        }
    } else if (key === 'colorMask') {
        if (!COLOR_MASK.has(val)) {
            const { start, end } = findValueCol(rawLine, yl.value.trim());
            diags.push(makeDiag(
                yl.lineNo, start, end,
                `\`colorMask\` 值 "${yl.value.trim()}" 不是合法的 ColorMask。合法值: ${[...COLOR_MASK].join(', ')}`,
            ));
        }
    }
}

/** 校验 depthStencilState 内的字段 */
function validateDepthStencilField(yl: YamlLine, rawLine: string, diags: Diagnostic[]): void {
    const key = yl.key;
    const val = yl.value.trim().toLowerCase();
    if (!val || yl.isAnchorRef) return;

    const compFuncKeys = new Set([
        'depthFunc',
        'stencilFuncFront', 'stencilFuncBack',
    ]);
    const stencilOpKeys = new Set([
        'stencilFailOpFront', 'stencilZFailOpFront', 'stencilPassOpFront',
        'stencilFailOpBack', 'stencilZFailOpBack', 'stencilPassOpBack',
    ]);

    if (compFuncKeys.has(key)) {
        if (!COMPARISON_FUNC.has(val)) {
            const { start, end } = findValueCol(rawLine, yl.value.trim());
            diags.push(makeDiag(
                yl.lineNo, start, end,
                `\`${key}\` 值 "${yl.value.trim()}" 不是合法的 ComparisonFunc。\n合法值: ${[...COMPARISON_FUNC].join(', ')}`,
            ));
        }
    } else if (stencilOpKeys.has(key)) {
        if (!STENCIL_OP.has(val)) {
            const { start, end } = findValueCol(rawLine, yl.value.trim());
            diags.push(makeDiag(
                yl.lineNo, start, end,
                `\`${key}\` 值 "${yl.value.trim()}" 不是合法的 StencilOp。\n合法值: ${[...STENCIL_OP].join(', ')}`,
            ));
        }
    }
}

/** 校验 rasterizerState 内的字段 */
function validateRasterizerField(yl: YamlLine, rawLine: string, diags: Diagnostic[]): void {
    const key = yl.key;
    const val = yl.value.trim().toLowerCase();
    if (!val || yl.isAnchorRef) return;

    if (key === 'cullMode') {
        if (!CULL_MODE.has(val)) {
            const { start, end } = findValueCol(rawLine, yl.value.trim());
            diags.push(makeDiag(
                yl.lineNo, start, end,
                `\`cullMode\` 值 "${yl.value.trim()}" 不是合法的 CullMode。合法值: ${[...CULL_MODE].join(', ')}`,
            ));
        }
    } else if (key === 'polygonMode') {
        if (!POLYGON_MODE.has(val)) {
            const { start, end } = findValueCol(rawLine, yl.value.trim());
            diags.push(makeDiag(
                yl.lineNo, start, end,
                `\`polygonMode\` 值 "${yl.value.trim()}" 不是合法的 PolygonMode。合法值: ${[...POLYGON_MODE].join(', ')}`,
            ));
        }
    }
}

/** 校验 property 的 target 字段格式应为 `uniformName.swizzle` */
function validateTargetField(yl: YamlLine, rawLine: string, diags: Diagnostic[]): void {
    const val = yl.value.trim();
    if (!val || val.startsWith('*') || val.startsWith('&')) return;

    // 合法格式：word 或 word.swizzle（swizzle 可以是 xyz xyzw w 等）
    // 也允许 word （仅引用另一个 property 名字）
    const valid = /^[\w-]+(\.[xyzwrgba]+)?$/.test(val);
    if (!valid) {
        const { start, end } = findValueCol(rawLine, val);
        diags.push(makeDiag(
            yl.lineNo, start, end,
            `property \`target\` 格式无效："${val}"。应为 \`uniformName\` 或 \`uniformName.swizzle\`（如 \`pbrParams.x\`）`,
            DiagnosticSeverity.Warning,
        ));
    }
}
