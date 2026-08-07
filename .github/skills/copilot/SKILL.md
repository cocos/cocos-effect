---
name: copilot
description: 'Cocos-Effect 仓库开发工作流。Use when modifying cocos-effect code, fixing bugs, adding features, or refactoring. Enforces read-before-edit, minimal changes, and mandatory doc updates.'
---

# Cocos-Effect 仓库开发指令

处理本仓库时，先执行以下流程，再开始任何代码修改：

1. 先阅读 `../../../docs/CODEBASE.md`
2. 再读取将要修改的目标文件和相邻方法
3. 修改时保持最小变更，优先修根因，不扩散到无关区域
4. 完成修改后，更新 `../../../docs/CODEBASE.md` 中的当前状态、待办、验证记录和决策记录
5. copilot 上下文限制128K,若工作量过大，分批处理，先做最小实现，再做针对性验证

## 额外要求

- 不依赖旧会话中的近似行号，按当前文件内容重新定位
- 若用户刚修改过文件，先读取当前文件，再决定如何改
- 优先先做最小实现，再做针对性验证
- 回答和文档默认使用简体中文
- 关键思考内容和决策记录在 `../../../docs/CODEBASE.md` 中，必要时可在代码中添加注释