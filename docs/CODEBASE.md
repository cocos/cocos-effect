# Cocos Effect 插件 — AI 开发文档

> **工作流约定**：每次修改前先阅读本文件，修改完成后更新受影响的章节。  
> 最后更新：2026-08-07 | 版本：0.5.0

---

## 目录

1. [项目概览](#1-项目概览)
2. [目录结构](#2-目录结构)
3. [架构图](#3-架构图)
4. [模块详解](#4-模块详解)
5. [关键路径与常量](#5-关键路径与常量)
6. [数据流](#6-数据流)
7. [已知陷阱与约定](#7-已知陷阱与约定)
8. [构建与调试](#8-构建与调试)
9. [待办与扩展点](#9-待办与扩展点)

---

## 1. 项目概览

| 属性 | 值 |
|---|---|
| 插件名 | Cocos Effect |
| Publisher | Yaji |
| 版本 | 0.5.0 |  <!-- 与 package.json 保持一致 -->
| 入口文件 | `out/extension.js`（webpack 构建产物） |
| 语言服务器 | `out/server.js` |
| 工作目录 | `D:\Work\cocos-effect` |
| 引擎参考 | `D:\Work\cocos\cocos4` |
| 测试部署 | Junction：`C:\Users\Administrator\.vscode\extensions\cocos-effect-dev` → `D:\Work\cocos-effect` |

支持的文件类型：
- `.effect`：Cocos Creator shader effect 文件（language id = `cocos-effect`）
- `.chunk`：GLSL 片段 include 文件（language id = `cocos-program`）

`.effect` 文件结构：
```
CCEffect %{                   ← YAML 块（技术 / pass 定义）
  techniques:
    - passes:
        - vert: foo-vs:vert
          frag: foo-fs:frag
}%

CCProgram foo-vs %{           ← GLSL 块（顶点着色器）
  ...
}%

CCProgram foo-fs %{           ← GLSL 块（片元着色器）
  ...
}%
```

---

## 2. 目录结构

```
cocos-effect/
├── src/                          ← TypeScript 源码
│   ├── extension.ts              ← VSCode 扩展入口（Client 端）
│   ├── server.ts                 ← LSP Server 入口
│   ├── context.ts                ← LanguageClient 封装（生命周期管理）
│   ├── cc-utils.ts               ← 引擎缓存、补全/悬停/签名帮助工具
│   ├── file-utils.ts             ← 文件系统工具（引擎路径识别、常量）
│   ├── include-resolver.ts       ← #include 路径解析
│   ├── definition-provider.ts    ← 跳转定义（F12）
│   ├── semantic.ts               ← 语义高亮（Client 端 Provider）
│   ├── completion-provider.ts    ← 增强补全（#include / YAML / GLSL）
│   └── diagnostics/
│       ├── effect-checker-runner.ts  ← 调用 effect-checker.exe
│       └── yaml-validator.ts         ← CCEffect YAML 静态校验
├── syntaxes/                     ← TextMate Grammar（生成自 .yaml 源文件）
│   ├── cocos-effect.tmLanguage.json
│   └── cocos-program.tmLanguage.json
├── cocos-effect.tmLanguage.yaml  ← Grammar 源文件（.effect 语法）
├── cocos-program.tmLanguage.yaml ← Grammar 源文件（.chunk / GLSL 语法）
├── effect-configuration.json     ← 语言配置（括号、注释等）
├── program-configuration.json    ← 语言配置（.chunk 文件）
├── package.json                  ← 扩展 manifest
├── webpack.config.js             ← 构建配置（client + server 双入口）
├── tsconfig.json
├── out/                          ← webpack 产物（勿手动编辑）
│   ├── extension.js
│   └── server.js
└── CODEBASE.md                   ← 本文档
```

---

## 3. 架构图

```
┌─────────────────────────────────────────────┐
│                  VSCode 主进程               │
│                                             │
│  extension.ts (Client)                      │
│  ├── 读取 cocos-effect.enginePath 配置       │
│  ├── 注册 SemanticTokensProvider (semantic.ts)│
│  ├── 注册命令 (activateLSP / restartLSP /   │
│  │            compileEffect)                │
│  └── 启动 CocosEffectContext                │
│       └── LanguageClient → IPC → server.js  │
└─────────────────────────────────────────────┘
                      ↕ IPC (LSP 协议)
┌─────────────────────────────────────────────┐
│                LSP Server 进程               │
│                                             │
│  server.ts                                  │
│  ├── onInitialize：声明 capabilities         │
│  ├── onDidOpen / onDidSave                  │
│  │   └── validateDocument()                 │
│  │       ├── runEffectChecker()  (Win64)    │
│  │       └── validateCCEffectYaml()         │
│  ├── onDefinition → definitionProvider()    │
│  ├── onCompletion → enhancedCompletionProvider()
│  ├── onCompletionResolve → completionResolver()
│  ├── onHover → hoverProvider()              │
│  └── onSignatureHelp → signatureHelpProvider()
└─────────────────────────────────────────────┘
```

---

## 4. 模块详解

### 4.1 `extension.ts` — Client 入口

**职责**：
- 读取用户配置 `cocos-effect.enginePath`，设置 `DefaultEngineDirectory`
- 注册两种语言的 `SemanticTokensProvider`（Client 端直接处理，不走 LSP）
- 注册命令：`CocosEffect.restartLSP`、`CocosEffect.compileEffect`
- 通过 `CocosEffectContext` 启动 Server- 监听 Server 发出的 `cocos-effect/diagnosticsReady` 通知，在 OutputChannel 输出可点击错误链接
**关键配置读取**：
```typescript
const config = workspace.getConfiguration('cocos-effect');
const pth = config.get<string>('enginePath') || '';
const enginePath = is_engine_path(pth) ? pth : undefined;
```

**注意**：`compileEffect` 命令仅做一次性手动编译，实时诊断在 Server 端完成。

---

### 4.2 `server.ts` — LSP Server 入口

**职责**：所有 LSP 请求的入口分发。

**核心导出**：
- `DefaultEngineDirectory: string` — 由 extension.ts 通过自定义通知设置
- `documents: TextDocuments<TextDocument>` — 所有打开文档的管理器

**已注册的 LSP Capabilities**：
```
textDocumentSync:    Incremental
completionProvider:  { resolveProvider: true, triggerCharacters: ['<', '"', '/', ':', ' '] }
hoverProvider:       true
signatureHelpProvider: { triggerCharacters: ['('] }
definitionProvider:  true
```

**诊断触发时机**：
- `documents.onDidOpen` → `validateDocument()`
- `documents.onDidSave` → `validateDocument()`
- `documents.onDidClose` → 清空诊断（避免 Problems 面板残留）

**自定义通知**：
- 常量 `DIAG_NOTIFICATION = 'cocos-effect/diagnosticsReady'`
- `validateDocument` 完成后，若有诊断，发送此通知给 Client
- 通知 payload：`{ uri, fsPath, diagnostics: [{ line, character, severity, message }] }`

**诊断缓存**：
- `diagnosticCache: Map<string, Diagnostic[]>` — 每次诊断后更新，供 `onHover` 查询
- 文件关闭时不清除缓存（文件关闭就不会触发 hover，无副作用）

**`validateDocument()` 逻辑**：
```typescript
// 只处理 .effect 文件
if (!uri.endsWith('.effect')) return;

const checkerResult = await runEffectChecker(fsPath, engineDir);
const yamlDiags = validateCCEffectYaml(document.getText());
const allDiags = [...checkerResult.diagnostics, ...yamlDiags];

connection.sendDiagnostics({ uri, diagnostics: allDiags });
diagnosticCache.set(uri, allDiags);  // 供 hover 使用

// 有诊断时发自定义通知给 Client
if (allDiags.length > 0) {
    connection.sendNotification(DIAG_NOTIFICATION, { uri, fsPath, diagnostics: ... });
}
```

**`onHover` 逻辑（诊断优先）**：
```typescript
// 1. 查诊断缓存，按行号匹配
// 2. 命中 → 返回 Markdown hover（Error/Warning 加粗标签 + 错误信息）
// 3. 未命中 → fallback 到 hoverProvider(params)（引擎符号悬停）
```

---

### 4.3 `file-utils.ts` — 路径工具与常量

**常量**（其他模块均从此处 import）：

| 常量 | 值 | 用途 |
|---|---|---|
| `chunkSubPath` | `/editor/assets/chunks` | chunks 目录子路径 |
| `chunkCachePath` | `/editor/assets/tools/parsed-effect-info.json` | 引擎符号缓存 JSON |
| `compilerExecPath` | `/native/external/win64/bin/effect-checker/effect-checker.exe` | 编译器路径 |

**引擎路径识别优先级**（`get_environment_path` 函数，位于 `cc-utils.ts`）：
1. `DefaultEngineDirectory`（用户配置 `cocos-effect.enginePath`）
2. 从文档路径向上找 `is_engine_path()`（`package.json` 中 `name === 'cocos-creator'`）
3. 从文档路径向上找 `is_project_path()`（含 `temp/declarations/cc.d.ts`），再通过 `get_project_engine_dir()` 获取引擎路径

**导出函数**：

| 函数 | 签名 | 说明 |
|---|---|---|
| `find_if_upwards` | `(pth, operation)` | 递归向上搜索 |
| `is_engine_path` | `(pth)` | 检查 package.json 中 name === 'cocos-creator' |
| `is_cocos_creator_path` | `(pth)` | 检查 Cocos Creator 应用路径 |
| `is_project_path` | `(pth)` | 检查 temp/declarations/cc.d.ts |
| `get_project_engine_dir` | `(projectRoot)` | 读 cc.d.ts 中的 reference path |
| `get_creator_engine_path` | `(creatorPath)` | 从 Creator 安装目录获取引擎路径 |

**支持的引擎路径格式**：
- 引擎源码根目录（`package.json.name === 'cocos-creator'`）
- Cocos Creator 安装目录（子路径 `resources/resources/3d/engine` 或 macOS 的 `Contents/Resources/...`）

---

### 4.4 `include-resolver.ts` — #include 解析

**导出函数**：

| 函数 | 签名 | 说明 |
|---|---|---|
| `findAllIncludes` | `(text: string) → IncludeInfo[]` | 扫描文本所有 #include，返回位置信息 |
| `resolveIncludePath` | `(includePath, currentFile, engineChunksDir) → string \| undefined` | include 路径 → 绝对文件路径 |
| `getIncludeAtPosition` | `(text, line, character) → IncludeInfo \| null` | 光标位置 → 当前行的 include 信息 |
| `getEngineChuinksDir` | `(engineDir) → string` | 返回 `<engineDir>/editor/assets/chunks` |

> ⚠️ **拼写陷阱**：函数名为 `getEngineChuinksDir`（含 typo "Chuinks"）。  
> 其他模块 import 时用别名修正：`import { getEngineChuinksDir as getEngineChunksDir }`

**解析顺序**（4 个候选路径，先到先得）：
1. 当前文件目录 + `includePath` + `.chunk`
2. 当前文件目录 + `includePath`（无后缀，适用于路径已含后缀的情况）
3. `<engineDir>/editor/assets/chunks/` + `includePath` + `.chunk`
4. `<engineDir>/editor/assets/chunks/` + `includePath`（无后缀）

---

### 4.5 `definition-provider.ts` — 跳转定义

**支持两种跳转**：
1. `#include <foo/bar>` → `<engineDir>/editor/assets/chunks/foo/bar.chunk`
2. YAML 中 `vert: programName:entryFn` → 同文件 `CCProgram programName` 声明行

---

### 4.6 `semantic.ts` — 语义高亮（Client 端）

**Token 类型数组**（index 对应语义颜色）：

| Index | 类型 | 颜色语义 |
|---|---|---|
| 0 | `macro` | 橙/黄色（`#define`、`#ifdef` 等） |
| 1 | `keyword` | 紫色（`uniform`、`attribute` 等 GLSL 关键字） |
| 2 | `enum` | 绿色 |
| 3 | `function` | 浅蓝色 |
| 4 | `variable` | 默认 |
| 5 | `namespace` | 蓝色（`#include` 路径高亮用此类型） |

**注意**：`SemanticTokensProvider` 在 Client 端注册，不走 LSP Server，直接在 `extension.ts` 调用。

---

### 4.7 `cc-utils.ts` — 引擎符号缓存

**核心数据结构**：
```typescript
class EngineCache {
    enginePath: string;
    CompletionItems: CompletionItem[];   // 来自 parsed-effect-info.json
    SignatureHelps: Map<string, SignatureHelp>;
    Hovers: Map<string, Hover>;
}

class ProgramRelations {
    dependsOn: string[];       // 当前文件依赖的文件路径
    dependOnBy: string[];      // 依赖当前文件的文件路径
}

const engineCaches: Map<string, EngineCache> = new Map();      // key = enginePath
const documentCaches: Map<string, DocumentCache> = new Map();   // key = document URI
const programs: Map<string, ProgramRelations> = new Map();      // 文件间依赖关系
const unwindedPrograms: Map<string, string> = new Map();        // 缓存的展开程序文本
```

**`update_engine_cache(enginePath)`**：解析 `<engineDir>/editor/assets/tools/parsed-effect-info.json`，填充 `CompletionItems` / `SignatureHelps` / `Hovers`。

---

### 4.8 `completion-provider.ts` — 增强补全

**四类补全**（按优先级）：

| 触发条件 | 返回内容 | 数据来源 |
|---|---|---|
| `#include <` 或 `#include "` | `.chunk` 文件路径列表（去后缀） | 遍历引擎 chunks 目录，结果缓存在 `chunkCache: Map<string, CompletionItem[]>` |
| YAML 块内字段名位置 | 当前上下文合法字段 | 硬编码常量（`PASS_FIELDS`、`RASTERIZER_FIELDS` 等） |
| YAML 块内冒号后值位置 | 枚举值列表 | 硬编码 `ENUM_VALUES` 字典 |
| CCProgram GLSL 块内 | 引擎内置符号 | `engineCaches` → `EngineCache.CompletionItems` |

**YAML 上下文检测**（`detectYamlContext(lines, lineIndex)`）：
- 扫描光标所在行向上找最近的缩进层级关键词
- 层级：`techniques` → `passes` → `pass` → `rasterizerState`/`depthStencilState`/`blendState`/`blendTargets`/`properties`/`editor`

**`chunkCache` 缓存策略**：
- Key = engineDir 路径
- 首次访问时同步遍历文件系统，后续复用
- 进程重启时自动清空（无持久化）

---

### 4.9 `diagnostics/effect-checker-runner.ts`

**调用方式**：
```bash
effect-checker.exe 0 <effectFilePath> <engineRootDir>
```

**输出解析正则**：
```
首行错误：/\((\d+),(\d+)\):\s*--(\S+)\s+(ERROR|WARNING):\s*\d+:(\d+):\s*(.*)/
后续关联：/^(ERROR|WARNING):\s*\d+:(\d+):\s*(.*)/
汇总行：  /ERROR:\s*\d+\s*compilation error/  → 忽略
成功标志：输出以 'Compilation Succeeded' 开头
```

**限制**：仅支持 Windows（Win64 可执行文件），其他平台直接返回空结果。

---

### 4.10 `diagnostics/yaml-validator.ts`

**校验的字段与枚举**：

| 字段 | 枚举集 |
|---|---|
| `blendSrc`, `blendDst` | `BLEND_FACTOR`（15 项） |
| `blendEq`, `blendAlphaEq` | `BLEND_OP`（5 项） |
| `colorMask` | `COLOR_MASK`（15 项） |
| `depthFunc`, `stencilFunc*` | `COMPARISON_FUNC`（8 项） |
| `stencilFailOp*` 等 | `STENCIL_OP`（8 项） |
| `cullMode` | `CULL_MODE`（3 项） |
| `polygonMode` | `POLYGON_MODE`（3 项） |
| `primitive` | `PRIMITIVE_MODE`（13 项） |
| `shadeModel` | `SHADE_MODEL`（2 项：`gourand`, `flat`） |

**pass 必填字段**：`vert`、`frag`（或有 `propertyIndex` 则豁免）

**pass 合法字段集 `PASS_KNOWN_KEYS`**（17 项）：
`vert, frag, phase, pass, propertyIndex, priority, primitive, stage, embeddedMacros, rasterizerState, depthStencilState, blendState, properties, migrations, dynamics, shader, device`

**technique 合法字段集 `TECHNIQUE_KNOWN_KEYS`**（2 项）：
`name, passes`

---

## 5. 关键路径与常量

```typescript
// file-utils.ts
chunkSubPath    = '/editor/assets/chunks'
chunkCachePath  = '/editor/assets/tools/parsed-effect-info.json'
compilerExecPath = '/native/external/win64/bin/effect-checker/effect-checker.exe'

// include-resolver.ts
CHUNKS_SUB_PATH = 'editor/assets/chunks'  // 注意无前导斜杠（与 chunkSubPath 不同！）

// 引擎 chunks 完整路径示例
// D:\Work\cocos\cocos4\editor\assets\chunks\

// effect-checker 完整路径示例
// D:\Work\cocos\cocos4\native\external\win64\bin\effect-checker\effect-checker.exe
```

> ⚠️ `chunkSubPath`（`file-utils.ts`）有前导斜杠；`CHUNKS_SUB_PATH`（`include-resolver.ts`）无前导斜杠。两者语义相同，但拼接时需注意。

---

## 6. 数据流

### 6.1 打开 / 保存 .effect 文件时

```
VSCode 打开或保存文件
  → documents.onDidOpen / onDidSave (server.ts)
  → validateDocument(document)
    ├── get_environment_path(document)     → engineDir
    ├── runEffectChecker(path, engineDir)  → Diagnostic[]
    ├── validateCCEffectYaml(text)         → Diagnostic[]
    ├── connection.sendDiagnostics(merged) → Problems 面板更新
    ├── diagnosticCache.set(uri, merged)   → 供 hover 查询
    └── [若有诊断] connection.sendNotification('cocos-effect/diagnosticsReady', payload)
          → Client: outputChannel.appendLine('path:line:col: error: msg')
          → Client: [有 error 时] outputChannel.show(preserveFocus=true)
```

### 6.1b 悬停报错行时

```
鼠标悬停在报错行
  → connection.onHover (server.ts)
  → 查 diagnosticCache.get(uri)
    ├── [命中] 过滤当前行的诊断 → 返回 Markdown Hover（Error/Warning + 错误信息）
    └── [未命中] fallback → hoverProvider(params)（引擎符号 hover）
```

### 6.2 触发补全时

```
用户输入触发字符 < " / : 空格
  → connection.onCompletion (server.ts)
  → enhancedCompletionProvider(params) (completion-provider.ts)
    ├── [优先] 检测 #include 上下文 → 返回 chunk 路径列表
    ├── [次之] 检测 YAML 块上下文  → 返回字段名或枚举值
    └── [默认] GLSL 块内           → 返回 engineCache.CompletionItems
```

### 6.3 跳转定义时

```
F12 / Ctrl+Click
  → connection.onDefinition (server.ts)
  → definitionProvider(params) (definition-provider.ts)
    ├── getIncludeAtPosition() → 有 include → resolveIncludePath() → Location
    └── getProgramNameAtPosition() → 有 programName → findCCProgramDeclarations() → Location
```

---

## 7. 已知陷阱与约定

### 7.1 拼写 Typo（重要！）

`include-resolver.ts` 中导出函数名有 typo：
```typescript
// 实际导出名（有 typo）
export function getEngineChuinksDir(engineDir: string): string { ... }

// 其他模块 import 时必须用别名！
import { getEngineChuinksDir as getEngineChunksDir } from './include-resolver';
```
**不要直接修改 `include-resolver.ts` 中的函数名**，可能影响已有引用。若要修复，需同时更新所有 import 处。

### 7.2 两个 `chunkSubPath` 常量

`file-utils.ts` 的 `chunkSubPath` 有前导 `/`，`include-resolver.ts` 的 `CHUNKS_SUB_PATH` 无前导 `/`。拼接时：
```typescript
// file-utils.ts 风格
path.join(engineDir, chunkSubPath)       // → engineDir\editor\assets\chunks （path.join 自动处理）

// include-resolver.ts 风格
path.join(engineDir, CHUNKS_SUB_PATH)   // → engineDir\editor\assets\chunks
```

### 7.3 两套补全提供器共存

`cc-utils.ts` 导出了旧的 `completionProvider` 和 `completionResolver`，`completion-provider.ts` 导出了新的增强版。在 `server.ts` 中：
```typescript
// 注意别名区分
import { completionResolver as enhancedCompletionResolver } from './completion-provider';
// onCompletion → enhancedCompletionProvider（新）
// onCompletionResolve → enhancedCompletionResolver（新）
// 旧的 completionProvider / completionResolver 已不在 onCompletion 注册
```

### 7.4 语义高亮在 Client 端

`SemanticTokensProvider` 是在 `extension.ts`（Client 进程）里注册的，**不经过 LSP Server**。修改语义高亮逻辑改 `semantic.ts`，不影响 `server.ts`。

### 7.5 诊断只处理 .effect 文件

```typescript
// server.ts validateDocument() 开头
if (!uri.endsWith('.effect')) return;
```
`.chunk` 文件不单独诊断。

### 7.6 Windows 平台限制

`runEffectChecker()` 检查 `checkerPath` 是否存在，不存在则静默返回空结果，所以 macOS / Linux 不会报错，只是没有 effect-checker 诊断。

---

## 8. 构建与调试

### 构建命令

```powershell
cd D:\Work\cocos-effect
npm run compile
# webpack compiled successfully in ~1500ms
# 产物：out/extension.js + out/server.js
```

### 实时开发（watch 模式）

```powershell
npm run watch
```

### 测试部署

插件目录通过 Junction 链接到 VSCode extensions 目录，无需 vsix 安装：
```
C:\Users\Administrator\.vscode\extensions\cocos-effect-dev  →  D:\Work\cocos-effect
```

修改后构建，然后在 VSCode 中 `Ctrl+Shift+P` → **Developer: Reload Window**。

### 调试 Server 端

Server 进程独立运行，调试时在 `.vscode/launch.json` 中附加调试器到 Server 进程（IPC 模式）。

---

## 9. 待办与扩展点

### 计划中的功能

| ID | 功能 | 入口文件 | 优先级 |
|---|---|---|---|
| F-01 | macOS / Linux effect-checker 支持 | `effect-checker-runner.ts` | 中 |
| F-02 | `.chunk` 文件的诊断（以 include 为入口展开） | `server.ts` + `effect-checker-runner.ts` | 低 |
| F-03 | YAML `properties` 块字段校验（type 枚举等） | `yaml-validator.ts` | 中 |
| F-04 | CCProgram 块内宏定义补全（`#define`、`#ifdef`） | `completion-provider.ts` | 中 |
| F-05 | 悬停提示枚举文档（鼠标悬停显示枚举说明） | `cc-utils.ts` | 低 |
| F-06 | 重命名 `getEngineChuinksDir` typo | `include-resolver.ts` + 所有引用处 | 低 |

### 扩展 YAML 校验

在 `yaml-validator.ts` 中新增枚举字段：
1. 在文件顶部 `const XXXX = new Set([...])` 添加枚举集
2. 在 `validatePass()` 或对应函数中添加检测逻辑
3. 在 `PASS_KNOWN_KEYS` 中添加新字段名（否则会产生 "unknown field" warning）

### 扩展 YAML 补全字段

在 `completion-provider.ts` 中：
1. 在对应 `_FIELDS` 数组（如 `PASS_FIELDS`）添加新字段 `CompletionItem`
2. 如需枚举值补全，在 `ENUM_VALUES` 字典添加 `{ fieldName: string[] }` 条目
3. 如需新的上下文层级，在 `detectYamlContext()` 函数中添加判断逻辑
