import {
    SemanticTokensLegend,
    DocumentSemanticTokensProvider,
    TextDocument,
    ProviderResult,
    CancellationToken,
    SemanticTokens,
    SemanticTokensBuilder,
    Range,
} from 'vscode';

const tokenTypes = ['macro', 'keyword', 'enum', 'function', 'variable', 'namespace'];
const tokenModifiers = ['declaration', 'documentation'];
export const legend = new SemanticTokensLegend(tokenTypes, tokenModifiers);
export const selector = { language: 'cocos-program', scheme: 'file' };

const intrinsic_keywords = [
    "attribute",
    "const",
    "uniform",
    "varying",
    "in",
    "out",
    "inout",
    "float",
    "double",
    "int",
    "void",
    "bool",
    "true",
    "false",
    "if",
    "else",
    "switch",
    "case",
    "default",
    "while",
    "do",
    "for",
    "continue",
    "break",
    "return",
    "discard",
    "mat2",
    "mat3",
    "mat4",
    "vec2",
    "vec3",
    "vec4",
    "ivec2",
    "ivec3",
    "ivec4",
    "bvec2",
    "bvec3",
    "bvec4",
    "sampler1D",
    "sampler2D",
    "sampler3D",
    "samplerCube",
    "sampler1DShadow",
    "sampler2DShadow",
    "struct",
    "invariant",
    "precise",
    "highp",
    "mediump",
    "lowp",
    "precision",
    "asm",
    "class",
    "union",
    "enum",
    "typedef",
    "template",
    "this",
    "packed",
    "goto",
    "inline",
    "noinline",
    "volatile",
    "public",
    "static",
    "extern",
    "external",
    "interface",
    "long",
    "short",
    "half",
    "fixed",
    "unsigned",
    "superp",
    "input",
    "output",
    "hvec2",
    "hvec3",
    "hvec4",
    "fvec2",
    "fvec3",
    "fvec4",
    "sampler2DRect",
    "sampler3DRect",
    "sampler2DRectShadow",
    "sizeof",
    "cast",
    "namespace",
    "using",
];

const extra_keywords = [
    "define",
    "ifndef",
    "ifdef",
    "endif",
    "elif",
    "include",
    "pragma",
    "define-meta",
];

interface IParsedToken {
    line: number;
    startCharacter: number;
    length: number;
    tokenType: number;
    tokenModifiers: string[];
}

export class CocosSemanticTokensProvider implements DocumentSemanticTokensProvider {
    provideDocumentSemanticTokens(
        document: TextDocument,
        token: CancellationToken
    ): ProviderResult<SemanticTokens> {
        const allTokens = this.parse(document);
        const tokensBuilder = new SemanticTokensBuilder(legend);
        allTokens.forEach((token) => {
            tokensBuilder.push(
                token.line,
                token.startCharacter,
                token.length,
                token.tokenType,
            );
        });

        return tokensBuilder.build();
    }

    private parse(document: TextDocument): IParsedToken[] {
        const program_ranges = this.parsePrograms(document);
        const allTokens: IParsedToken[] = [];
        program_ranges.forEach((range) => {
            allTokens.push(...this.parseTokens(document, range));
        });
        return allTokens;
    }

    private extractMacros(precompile: string): { word: string, index: number }[] {
        const wordRegex = /(\w+)/g;
        const res = [];
        let match;
        while ((match = wordRegex.exec(precompile)) !== null) {
            res.push({ word: match[1], index: match.index });
        }
        return res;
    }

    private parsePrograms(document: TextDocument): Range[] {
        const text = document.getText();
        // if the document contains `CCEffect` then it is a effect file, otherwise it is a chunk file
        const isEffect = text.indexOf('CCEffect') !== -1;
        if (isEffect) {
            // 匹配 CCProgram xxx %{ ... }%，精确定位 %{ 之后的换行作为块内容起点
            const programRegex = /CCProgram\s+[\w-]+\s+%\{([^]*?)\}%/g;
            const res = [];
            let match: RegExpExecArray | null;
            while ((match = programRegex.exec(text)) !== null) {
                // 找到 %{ 在整个匹配中的位置，块内容从 %{ 后的第一个换行开始
                const headerEnd = match[0].indexOf('%{') + 2; // %{ 之后的字符位置（相对 match 起点）
                const blockStart = match.index + headerEnd;   // 绝对偏移：紧跟在 %{ 后
                // 块结束：}% 前，即 match.index + match[0].length - 2
                const blockEnd = match.index + match[0].length - 2;
                res.push(
                    new Range(
                        document.positionAt(blockStart),
                        document.positionAt(blockEnd),
                    )
                );
            }
            return res;
        } else {
            return [
                new Range(document.positionAt(0), document.positionAt(text.length))
            ];
        }
    }

    private parseTokens(document: TextDocument, range: Range): IParsedToken[] {
        const start = document.offsetAt(range.start);
        const text = document.getText(range);
        const res = [];
        const functionRegex = /(\w+)\s*\(([^)]*)\)/g;
        const precompileRegex = /^([ \t]*)#(.*)$/gm;

        let match: RegExpExecArray | null;
        while ((match = functionRegex.exec(text)) !== null) {
            if (intrinsic_keywords.includes(match[1])) {
                continue;
            }
            let tokenType = 3;
            if (extra_keywords.includes(match[1])) {
                tokenType = 1;
            }
            // TODO: should skip the comment
            res.push({
                line: document.positionAt(start + match.index).line,
                startCharacter: document.positionAt(start + match.index).character,
                length: match[1].length,
                tokenType: tokenType,
                tokenModifiers: [],
            });
        }
        /** 匹配 #include 行中尖括号或引号内的完整路径（支持缩进） */
        const includePathRE = /^[ \t]*#include\s+[<"]([^>"]+)[>"]/;
        /** namespace token 类型的 index（tokenTypes 数组第 5 位） */
        const STRING_TOKEN = 5;

        while ((match = precompileRegex.exec(text)) !== null) {
            const indent = match[1];   // 缩进部分（可能为空）
            const rawLine = match[0]; // 整行（含缩进和 #）

            // --- 特殊处理 #include：路径作为单一 namespace token ---
            const includeMatch = includePathRE.exec(rawLine);
            if (includeMatch) {
                // 找到路径在行内的起始位置（跳过缩进、#include、空白、< 或 "）
                const openBracket = rawLine.indexOf('<');
                const openQuote = rawLine.indexOf('"');
                const openIdx = openBracket >= 0 && (openQuote < 0 || openBracket < openQuote)
                    ? openBracket
                    : openQuote;
                if (openIdx >= 0) {
                    const pathStart = openIdx + 1; // 跳过 < 或 "
                    const absOffset = start + match.index + pathStart;
                    const pos = document.positionAt(absOffset);
                    res.push({
                        line: pos.line,
                        startCharacter: pos.character,
                        length: includeMatch[1].length,
                        tokenType: STRING_TOKEN,
                        tokenModifiers: [],
                    });
                }
                continue; // 不再对 #include 行做逐词处理
            }

            // --- 其他预编译行：逐词处理（原有逻辑）---
            // match[2] 是 # 之后的内容，match[1] 是缩进
            const afterHash = match[2];
            const hashOffset = indent.length + 1; // # 在行内的偏移
            const macros = this.extractMacros(afterHash);
            macros.forEach((macro) => {
                if (intrinsic_keywords.includes(macro.word)) {
                    return;
                }
                if (!isNaN(Number(macro.word))) {
                    return;
                }
                let tokenType = 0;
                if (extra_keywords.includes(macro.word)) {
                    tokenType = 1;
                    return;
                }
                res.push({
                    line: document.positionAt(start + match!.index).line,
                    startCharacter: document.positionAt(start + match!.index + hashOffset + macro.index).character,
                    length: macro.word.length,
                    tokenType: tokenType,
                    tokenModifiers: [],
                });
            });
        }
        return res;
    }
}
