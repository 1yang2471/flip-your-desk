# Flip Your Desk · 项目守则

- 提交被 `.githooks/pre-commit` 拒绝（文件 >20KB）→ 照报错按功能拆文件后再提交
- 写新函数、新规则前先搜项目里有没有现成的（`src/` 组件、`src/locales/` 文案、测试助手）
- 构建与测试门：`npm run check` + `npm test`；正式包走 `npm run exe`；发布走 tag → CI 草稿
