# Flip Your Desk · 项目守则

- 提交被 `.githooks/pre-commit` 拒绝（文件 >20KB）→ 照报错按功能拆文件后再提交
- 写新函数、新规则前先搜项目里有没有现成的（`src/` 组件、`src/locales/` 文案、测试助手）
- 构建与测试门：`npm run check` + `npm test`；正式包走 `npm run exe`；发布走 tag → CI 草稿
- 发版前必 bump 六处版本号：package.json / tauri.conf.json / Cargo.toml / `APP_VERSION`（i18n.ts）/ README.md 安装节 / README.en.md 安装节。少一处启动窗就还显示旧版；README 两处由 pre-commit 钩子硬拦（v0.1.1 曾漏改 README 防复发）。
- 桌面写回路径改动必须真机验证：cargo test 绿 ≠ 真机绿（2026-11-14 故障注入实证）。
- 调 Win32 消息/常量前先对 `commctrl.h` 核偏移并加守护测试（`LVM_FIRST + n`）。写入后读回值不变时，**第一反应是验证消息本身是否有效**（返回值 + 换已知可用消息对照），不要先假设时序/竞态——2026-11-14 因 `LVM_SETITEMPOSITION32` 写成 `0x1049`（实为 GET 消息），保存静默失效，且被误判为"异步写/标签瞬态"，白写两轮过度设计。
