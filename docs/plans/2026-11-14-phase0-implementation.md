# Phase 0 实施记录 · 2026-11-14

配套文档：[macOS / Linux 移植调研计划](2026-11-14-macos-linux-port-research.md)。
本文件记录 Phase 0「打通跨编译门」的实测结论与改动，按 pre-commit 钩子的文件大小约束从调研文档拆出。

## 已改动（同一轮提交）

- `src-tauri/src/lib.rs` 的 `pin_overlays`：`hwnd()` 段加 `#[cfg(windows)]`，非 Windows 分支仍调用 `platform::pin_window_over_desktop(0)` 保持接缝面对称（消除 `unused import` 孤儿）。
- `.github/workflows/ci.yml`：新增 `linux-check` job（`ubuntu-latest` + Tauri v2 官方 apt 依赖 [S30] + host `cargo check`）。
- 调研文档：状态、接缝面、Phase 0、验证标准四处按实测更正。

## 接缝面两处"不干净"（核对代码所得）

- `pin_window_over_desktop(hwnd: isize)` 的参数是 Win32 `HWND` 伪装成的整数，句柄类型从平台层漏到了 `lib.rs`；macOS 需 `NSWindow*`、Linux X11 需 `Window`。彻底做法是把"按窗口 label 取原生句柄"下沉进平台层，让 `lib.rs` 不再传句柄（Phase 0 未做，留待后续平台实现时一并处理）。
- `lib.rs` 的 `pin_overlays` 无条件调用 `window.hwnd()`，而 tauri 的 `WebviewWindow::hwnd()` 是 `#[cfg(windows)]`（macOS `ns_window()`、Linux `gtk_window()`）。**这行代码本身就不能跨平台编译**——是跨编译 check 撞到的第一道代码层墙，调研文档初稿漏记。

## 实测否证了初稿的两处假设

1. **trait 收敛不可行**：`unsupported.rs:18` 的 `capture(..., _progress: impl Fn(usize,usize) + Send + Sync)` 带 `impl Trait` 参数，`Box<dyn DesktopPlatform>` 分发不是 object-safe，编译不过。且 cfg 模块导出已足够，收敛属投机重构 → 砍掉。
2. **Windows CI 跑不了 Linux cross check**：本机 `cargo check --target x86_64-unknown-linux-gnu` 先撞 `libdbus-sys` build script「pkg-config has not been configured to support cross-compilation」（tauri → tao → dbus → libdbus-sys 链）。`cargo check` 会跑依赖 build script，"纯 check 不链接"的假设不成立；windows-latest 同样缺 Linux sysroot → 改走 `ubuntu-latest` host check。

## 本机验证（贴原样结论）

- 基线：Windows `cargo test` = `38 passed; 0 failed; 1 ignored`；`cargo fmt --check` / `cargo clippy --all-targets -- -D warnings` / `npm run check` / `npm test`(38 PASS) 全绿。
- 改动后：上述 Windows 门全部仍绿。
- 非 Windows 分支：本机用「临时改 rustup manifest 的 `xz_url` 走官方源装 Linux target（装完还原，checksum 一致）+ 临时 pkg-config shim 骗过 build script」跑通 `cargo check --target x86_64-unknown-linux-gnu`，`EXIT=0`。环境变量/shim 均为本机一次性验证手段，**未进仓库、未进 CI**。剩余 9 个 warning 均为 `icon_cutout.rs`/`geometry.rs` 里原本就存在的 Windows-only 代码在非 Windows 下未引用，非本次引入，不主动清理。
- tauri 源码核对：`WebviewWindow::hwnd()` 确为 `#[cfg(windows)]`（macOS `ns_window()`、Linux `gtk_window()`），坐实 `lib.rs:173` 是跨平台编译缺陷。

## 未验证项（不宣称已绿）

- **`linux-check` job 未在真实 ubuntu-latest 上跑过**：本机是 Windows，无法复现 GitHub runner 的 apt 依赖组合。job 按官方 prerequisites [S30] 写，但首次 push 后需看 `gh run list` / CI 日志确认绿；若 `webkit2gtk-4.1`/`gtk+-3.0`/`libsoup-3.0` 的 `.pc` 有缺，按报错补 apt 包。
- 本次未做：macOS/Linux 任何平台实现、trait、句柄参数下沉、真机写回验证（Phase 1/2 范围）。

## 来源

| # | 链接 | 用途 |
|---|---|---|
| S30 | https://v2.tauri.app/start/prerequisites/ | Tauri v2 Linux 系统依赖官方清单（CI job 的 apt 来源） |
