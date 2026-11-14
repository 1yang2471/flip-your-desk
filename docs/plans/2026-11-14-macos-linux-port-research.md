# macOS / Linux 移植调研计划 · 2026-11-14

状态：调研计划（Phase 0 已于 2026-11-14 实施，落地形态见 [Phase 0 实施记录](2026-11-14-phase0-implementation.md)）· 前置：v0.1.1 已发布 · 范围：`src-tauri/src/platform/` 平台适配层
来源标注：`[S#]` 对应文末来源列表；查不到可靠来源的结论一律标注"未核实/需实测"。
实测更正：本文初稿的 Phase 0 有两处落地假设被后续实测否证（trait 收敛、windows CI 跑 Linux cross check），已在正文标注并以文末实施记录为准。

---

## 背景与目标

### Windows 现状（v0.1.1 实测机制）

- **读/写图标位置**：Explorer 桌面 `SHELLDLL_DefView` → `SysListView32`，跨进程 `LVM_*`（RemoteBuffer + SendMessage）读写槽位坐标、自动排列开关、图标可见性；写回以名字为身份解析、逐项名字+位置双重校验、失败可整体回滚（`rollback_ok`）
- **卡片像素**：开局隐藏图标 → PrintWindow 全屏截图 ×2（有图标/无图标）→ 差分抠出每格像素与标签（`capture`，已并行化）
- **标签字体**：`SPI_GETICONMETRICS`
- **盖桌层级**：`SetWindowPos` 把覆盖窗钉在 Progman 上方（桌面之上、普通窗口之下）
- **风险探测**：工具帮助快照枚举进程探测 Fences/Desktops（非阻塞提示）
- **强杀残留防护**：局中在 `app_config_dir/icons-hidden.flag` 写标记文件，启动时发现残留即恢复图标

> 两处与最初任务描述的出入，以代码为准：① 防残留是**标记文件**（`icons-hidden.flag`，lib.rs:195），不是注册表；② 当前代码只用 `SPI_GETICONMETRICS`，**没有** `SPI_GETDESKWALLPAPER`（壁纸从未被读取或改动）。

### 接缝面：到底有多大

平台分支已全部收敛在 `platform/mod.rs` 的 `cfg` 导出，`lib.rs` 侧无平台 if。接缝面就是 **7 个自由函数 + 4 个数据结构**：

| 函数 | 语义 | Windows 实现 | 移植难点 |
|---|---|---|---|
| `probe()` | 桌面存在性、图标数、自动排列、可见性、权限 | LVM 读 | 每平台来源不同 |
| `capture(monitors, progress)` | 读位置 + 抠卡面像素 + 标签字体 | LVM + 截图差分 | 截图差分在 Wayland 不可用 |
| `apply_positions(&[IconWrite])` | 按名字写回坐标，三态报告（moved/skipped_missing/failed_write） | LVM 写 + 逐项校验 | 各平台写回通道不同，语义必须对齐 |
| `monitor_work_area(x,y,w,h)` | 刨掉任务栏的工作区 | GetMonitorInfo | X11 可查 EWMH；Wayland 无全局坐标 |
| `set_icons_visible(bool)` | 整局隐藏/恢复真实图标 | LVM 开关 | macOS/Linux 无等价 API（见 Q5） |
| `pin_window_over_desktop(hwnd)` | 覆盖窗 z 序钉到桌面之上 | SetWindowPos 对 Progman | macOS 需 NSPanel；Wayland 受限 |
| `detect_desktop_organizers()` | Fences 类探测（非阻塞） | 进程快照 | 各平台可留 false |

数据结构：`ProbeData` / `Captured{icons,label_font}` / `ApplyReport`，输入输出均为纯数据（`IconRecord`/`IconWrite`/`MonitorInfo`），不含任何 Win32 类型——**移植量集中在 7 个函数的平台实现**。

> 实测更正（2026-11-14）：接缝面有两处不干净——`pin_window_over_desktop(hwnd: isize)` 的句柄类型泄漏、`lib.rs` 的 `window.hwnd()` 是 Windows-only API 导致非 Windows 无法编译。详见 [Phase 0 实施记录](2026-11-14-phase0-implementation.md)。

### 目标

1. 核实 macOS / Linux 桌面图标"读位置、写位置、拿像素"的可行边界（带来源，不编造）
2. 确定 Tauri 2 覆盖窗在两平台的可行性边界（层级、多窗、全屏）
3. 产出分阶段落地建议（Phase 0/1/2）、不做清单与各阶段验证标准

---

## 调研问题与结论

### macOS

**Q1：Finder 桌面图标位置可否读写？** —— **可以，走 AppleScript**。
`tell application "Finder"` 支持 `get {position, name} of every item of desktop` 读、`set position of (item N of desktop) to {x, y}` 写 [S1]；近代 macOS 上 `get/set desktop position of <item>` 语法有 2023 年的实测确认（桌面项与 Finder 窗口项均可用）[S2]。风险点：
- 需 TCC **自动化授权**（应用需声明 `NSAppleEventsUsageDescription`，首次向 Finder 发 Apple Events 会弹授权框）[S8]
- 桌面视图开"保持整理方式/按格对齐"时自由摆放被限制 [S12]；此时 AppleScript `set position` 具体表现**未核实，需真机实测**（probe 应检测并提示，类似 Windows 的 auto_arrange）
- AppleScript 依赖 Finder 字典长期稳定，macOS 大版本有收紧权限的历史趋势（风险，无单一来源）

**Q2：.DS_Store 是否存图标排列？** —— **存**（视图选项与逐项位置），但格式无官方文档，社区有 Python 库 [S3] 与 Rust crate `ds_store` [S4] 可读写。**结论：不采用**——Finder 运行中直接改 .DS_Store 会与其内存态互相覆盖（库文档自述 flush 语义不可靠）[S3]；AppleScript 通道已覆盖需求（见"不做清单"）。

**Q3：没有公开 API 的风险点？** —— 图标位置**没有公开 C API**，可选通道就三条：AppleScript（Q1）、AXUIElement Accessibility、.DS_Store（Q2，排除）。AX 路线（Finder 桌面窗口上 `AXPosition` 的可读写性）**未核实**——本次检索未找到可靠来源，列为 Phase 1 备选实测项：若 AppleScript 在未来 macOS 失效，AX 是唯一退路。

**Q4：卡片像素怎么拿？** —— 两条路：
- **(a) `NSWorkspace.icon(forFile:)` 直接拿文件图标** [S9]：不需要任何屏幕录制权限，是推荐首选。需实测的点：与桌面真实渲染（含小徽标）的视觉一致性——Windows 版卡面是像素级截图，macOS 版如果用图标库渲染，观感会有差异
- **(b) 截屏**：`CGWindowListCreateImage` 已在 macOS 14 弃用，替代为 ScreenCaptureKit 的 `SCScreenshotManager` [S5]；首次使用需**屏幕录制 TCC 授权并重启应用** [S6]，macOS 15/26 上仍有第三方兼容问题实例 [S7]。结论：(b) 仅在 (a) 视觉不达标时作为增强，不进最小可行

**Q5：Tauri 2 在 macOS 的覆盖窗与"隐藏真实图标"可行性？**
- 多窗/置顶：Tauri 2 原生支持；但标准 NSWindow **盖不住全屏窗口**，需 NSPanel 子类（Tauri #11488，社区方案 tauri-nspanel）[S10][S11]
- 钉到"桌面层级"（图标之上、普通窗口之下，对应 Windows 的 Progman 锚点）：Tauri 无现成 API，需 objc shim（tauri-nspanel 方向），**可行性需真机实测**
- **隐藏真实图标没有受支持的官方机制**（未找到官方 API）：`defaults write com.apple.finder CreateDesktop -false` + 重启 Finder 会破坏 Finder 会话，评估为不可接受。可行替代：不隐藏，靠覆盖窗（桌面层级窗/NSPanel）盖住图标区域——答案泄漏风险与层级实现绑定，**列为 Phase 1 首要实测项**

### Linux

**Q6：GNOME？** —— vanilla GNOME 自 3.28 起没有桌面图标，桌面图标来自 **Desktop Icons NG (DING) 扩展** [S13][S14]。ding 把每个文件的位置存在 **GVFS metadata 属性 `metadata::nautilus-icon-position`**（源码：fileItem.js:51 读、:970 写）[S15]——即外部可用 `gio info -a` / `gio set` 直接读写。ding 自身 D-Bus 接口面向文件操作（复制/移动/回收站等），**没有暴露图标坐标查询接口**（dbusInterfaces.js 全文核对）[S16]。风险：ding 非默认必装（发行版差异）；`gio set` 写入后 ding 是否即时跟随**需实测**。

**Q7：KDE Plasma？** —— 桌面默认 Folder View 部件；逐项位置存在 `~/.config/plasma-org.kde.plasma.desktop-appletsrc` 的 `positions=` 键 [S17]。KDE 开发自认"图标位置周边的基础设施老旧且脆弱、难以维护"（2024，Plasma 6.0），且 6.1/6.2 仍有人报告丢位置 [S17]。无文档化 API；直接改文件后是否需要重启 plasma-shell 才生效**未核实**。→ 优先级最低。

**Q8：Cinnamon（Nemo desktop）？** —— `nemo-desktop` 管理桌面，逐项位置存 **GVFS metadata `metadata::nemo-icon-position`**，命令行可直接写：`gio set ~/Desktop/xxx metadata::nemo-icon-position "91,91"` [S18][S19]；Nemo 另有自有 metadata 层处理多显示器等场景 [S20]。机制与 ding 同族，验证成本最低。

**Q9：X11 下截屏/定位/输入？** —— 截屏（XShm/XGetImage）、窗口定位与 z 序（EWMH 规范：`_NET_WORKAREA`、置顶/置底状态）[S21]、必要时 XTest 注入，全部可行——Windows 式玩法在 X11 可整体复刻。且本游戏**不需要**全局输入注入（覆盖窗自己接收点击/拖拽，与 Windows 相同）。

**Q10：Wayland 限制？** —— 安全模型禁止客户端任意截屏与跨屏定位：
- 截屏只能走 xdg-desktop-portal（用户确认/授权流，非静默）[S22][S23][S24]
- 窗口定位：GNOME Wayland 上 Tauri `set_position` 不工作（Tauri #14913，2026-02 仍开放）[S25]；wry 在 Wayland 需要特定构造路径 [S26]，已知还有启动崩溃 [S27]、resize-drag 失效等实战坑 [S28]
- 输入注入仅剩 RemoteDesktop portal/libei 一条路 [S29]——本游戏不需要，且要求用户授权远程桌面级权限，收益为零
- **结论：Wayland 会话不进任何阶段的范围**，启动器检测到 Wayland 时显示"建议切换 X11 会话"

---

## 分阶段计划

### Phase 0：打通跨编译门（只动 Windows 能跑的部分，0 新功能）

> 实施更正（2026-11-14）：初稿的「收敛为 trait」与「windows CI 跑 Linux cross check」两处假设均被实测否证——前者撞 object-safety，后者撞 `libdbus-sys`/pkg-config；改为保留 cfg 模块 + `ubuntu-latest` host check。详见 [Phase 0 实施记录](2026-11-14-phase0-implementation.md)。

1. 修 `lib.rs` 的 `pin_overlays`：`window.hwnd()` 段用 `#[cfg(windows)]` 隔离，非 Windows 分支仍调用 `platform::pin_window_over_desktop`（保持 7 函数接缝面对称，`unsupported.rs` 返回 `unsupported_platform` 被忽略）
2. CI 新增 `linux-check` job（`ubuntu-latest`）：装 Tauri v2 官方 Linux 系统依赖 → `cargo check --manifest-path src-tauri/Cargo.toml`，让**非 Windows 分支（unsupported 与未来平台代码）持续过编译**
3. `unsupported.rs` 保留现语义（probe 返回 "supports Windows only"，其余返回 `unsupported_platform`）

验收：现有测试不改断言全过；Linux host `cargo check` 绿；`npm test` 不回归。

### Phase 1：macOS 最小可行（推荐"读 + 还原"，暂不做"保存新布局"）

**推荐理由**：还原（写回原位）是数据安全底线，没有还原就不该上真机；它和"写回新位置"是**同一机制**（AppleScript `set desktop position`），在最坏路径（恢复）上先验证写回可靠性，"保存新布局"只是后续放开的前端开关。

范围：
1. `probe`：AppleScript 枚举桌面项（名称/位置/排列状态）+ 自动化授权状态探测
2. `capture`：位置走 AppleScript；卡面走 `NSWorkspace.icon(forFile:)` [S9]（截屏方案留作后续增强）
3. 覆盖窗：Tauri 多窗 + NSPanel/桌面层级实测（Q5，首要技术风险项）
4. `apply_positions`：`set desktop position` 写回 + **完整复刻 Windows 三态语义**（名字解析、逐项读回校验、`skipped_missing`/`failed_write`、回滚）
5. 权限流：首启引导 Automation 授权；被拒时 probe 走 `permission_denied` 文案
6. 局中行为与 Windows 对齐：真实图标原样不动、被覆盖窗遮住；`set_icons_visible` **建议返回明确"不支持"而非成功空操作**——项目 AGENTS.md 反复强调"能跑≠跑对"，假装成功的隐藏调用正是会埋雷的那种（前端当前用 `let _ =` 忽略返回值，返回错误码不会崩）

显式降级：不做截屏差分卡面、不做 Fences 等价物探测、不做"保存新布局"。

### Phase 2：Linux（按 DE 优先级；X11 会话 only）

**推荐顺序：Cinnamon/Nemo → GNOME(ding) → KDE Plasma**。理由：Nemo 与 ding 同用 GVFS metadata，`gio` 一条通道覆盖两个 DE、无私有格式、无重启生效问题，单位成本覆盖面最大；KDE 的 `positions=` 在 appletsrc 私有键里、官方自认脆弱 [S17]、生效条件未核实，投入产出最差。

- **2a Cinnamon/Nemo on X11**：`probe`（gio 枚举 ~/Desktop + nemo-desktop 进程检测）→ `capture`（gio 读 `metadata::nemo-icon-position` + 按文件名取图标）→ `apply_positions`（`gio set` 写回 + 读回校验）→ X11 EWMH 定位/置顶覆盖窗
  - 卡面更正：初稿写"截图差分抠卡面"，但 Windows 的差分依赖 `PrintWindow` + 整局隐藏真实图标，X11 无 `PrintWindow`、且 Nemo/ding 没有整局隐藏图标的等价开关，无法照搬。**降级为按文件名取图标**（freedesktop icon theme / gio 缩略图），与 macOS 的 `icon(forFile:)` 同思路，截图差分仅留作视觉不达标时的增强。
- **2b GNOME on X11**：同 2a，属性名换 `metadata::nautilus-icon-position`；probe 增加"DING 扩展是否启用"检查，未启用则提示（不代装）
- **2c KDE Plasma**：先立专项实测（appletsrc `positions=` 读写、生效条件、Plasma 5/6 差异），有结论再评估是否值得做
- **Wayland**：所有子阶段仅支持 X11；Wayland 会话 → 启动器明示不支持并建议切换（Q10）

---

## 不做清单

- **Wayland 下的全局输入注入**（libei/RemoteDesktop portal）：游戏不需要（覆盖窗自收输入），权限代价却最大 [S29]
- **逆向/直写 .DS_Store**（macOS）：Finder 内存态互覆盖风险 [S3]，且 AppleScript 已覆盖需求
- **`killall Finder` / `CreateDesktop=false` 隐藏图标**：破坏 Finder 会话，不可接受
- **直接写 KDE appletsrc 的 `positions=`**：官方自认脆弱 [S17]、生效条件未核实；除非 2c 专项实测推翻
- **逆向 Finder/Plasma 私有框架与 AX 私有键**：随时随大版本更新碎掉
- **自写 GNOME Shell 扩展（fork ding）**：超出游戏边界，且 GNOME 扩展审核/更新是另一条维护线
- **macOS/Linux 的 Fences 等价物探测**：`detect_desktop_organizers` 两平台先返回 false，等有真实整理工具生态再说
- **macOS 截屏差分卡面（ScreenCaptureKit）**：权限重、兼容性问题多 [S5][S6][S7]，仅在 icon(forFile:) 视觉不达标时重新评估

---

## 验证标准

- **Phase 0 跑通 =** Windows 侧 `cargo test` / `cargo fmt --check` / `cargo clippy --all-targets -- -D warnings` 全绿（不改任何断言）+ Linux runner 上 `cargo check`（host target）通过 + `npm run check && npm test` 不回归
- **Phase 1 跑通 =** 一台真 Mac（Sonoma 或更新）上：
  1. 首启完成 Automation 授权，probe 读出 ≥2 个桌面图标并渲染牌桌（卡面与真实图标人工比对可接受）
  2. 完整一局 → Esc 恢复：AppleScript 读回逐项比对坐标，图标全部回到原位；`rollback_ok` 等价的回滚路径可用
  3. 强杀进程后重启：无"图标消失/错位"残留（macOS 无隐藏机制，此项预期天然满足，验证覆盖窗不残留）
  4. 授权被拒路径：probe 报 `permission_denied`，启动器出对应文案
- **Phase 2a 跑通 =** 一台 Cinnamon + X11 真机或虚拟机：同 Phase 1 的 (1)(2)，坐标用 `gio info` 读回比对；同一台机器切 Wayland 会话，启动器正确显示"不支持/建议 X11"
- **通用红线**：任何平台的 `apply_positions` 必须保留 Windows 版三态 `ApplyReport` 语义（moved/skipped_missing/failed_write）与逐项校验回滚；做不到逐项校验的实现不允许合并

---

## 来源

| # | 链接 | 用途 |
|---|---|---|
| S1 | https://www.macscripter.net/t/read-and-write-position-of-item-on-desktop-folder/14347 | AppleScript 读/写桌面项 position |
| S2 | https://forum.keyboardmaestro.com/t/arranging-icons-in-finder-icon-view/33258 | 近代 macOS `desktop position` get/set 实测（2023） |
| S3 | https://ds-store.readthedocs.io/ | .DS_Store 存排列、写回 flush 语义不可靠 |
| S4 | https://crates.io/crates/ds_store | .DS_Store Rust 读写库存在 |
| S5 | https://nonstrict.eu/blog/2023/a-look-at-screencapturekit-on-macos-sonoma | SCScreenshotManager 替代已弃用的 CGWindowListCreateImage |
| S6 | https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos | 屏幕录制 TCC 授权、重启生效（Apple 官方） |
| S7 | https://github.com/trycua/cua/issues/870 | macOS 15+/26 截屏兼容问题实例 |
| S8 | https://developer.apple.com/documentation/bundleresources/information_property_list/nsappleeventsusagedescription | Apple Events 自动化授权声明（Apple 官方） |
| S9 | https://developer.apple.com/documentation/appkit/nsworkspace/icon(forfile:) | 无权限拿文件图标（Apple 官方） |
| S10 | https://github.com/tauri-apps/tauri/issues/11488 | NSWindow 盖不住全屏窗口，需 NSPanel |
| S11 | https://github.com/ahkohd/tauri-nspanel | Tauri macOS NSPanel 社区方案 |
| S12 | https://support.apple.com/guide/mac-help/sort-and-arrange-items-in-the-finder-on-mac-mchlp11495/mac | 排序/整理模式下不能自由摆放（Apple 支持） |
| S13 | https://www.rastersoft.com/programas/ding.html | DING 扩展主页 |
| S14 | https://extensions.gnome.org/extension/2087/desktop-icons-ng-ding/ | GNOME 桌面图标来自扩展 |
| S15 | https://gitlab.com/rastersoft/desktop-icons-ng/-/raw/master/app/fileItem.js | ding 读/写 `metadata::nautilus-icon-position`（:51/:970） |
| S16 | https://gitlab.com/rastersoft/desktop-icons-ng/-/raw/master/app/dbusInterfaces.js | ding 的 D-Bus 仅文件操作，无坐标接口 |
| S17 | https://discuss.kde.org/t/plasma-forgets-the-positions-of-the-desktop-icons/12923 | KDE 位置存 appletsrc `positions=`、官方承认脆弱 |
| S18 | https://forums.linuxmint.com/viewtopic.php?t=305276 | `gio set ... metadata::nemo-icon-position` |
| S19 | https://unix.stackexchange.com/questions/172343/positionioning-items-on-the-desktop | gvfs 工具读/设桌面项位置 |
| S20 | https://github.com/linuxmint/nemo/issues/2596 | nemo 自有 metadata 层 |
| S21 | https://specifications.freedesktop.org/wm-spec/latest/ | EWMH：工作区/窗口状态（X11） |
| S22 | https://superuser.com/questions/1861408/how-do-screenshot-permissions-work-in-wayland | Wayland 截屏权限模型 |
| S23 | https://discourse.gnome.org/t/sample-code-to-capture-screen-to-memory-raw-image-in-wayland/31283 | portal 截屏 API 样例 |
| S24 | https://github.com/flatpak/xdg-desktop-portal/issues/1093 | portal 截屏授权交互问题 |
| S25 | https://github.com/tauri-apps/tauri/issues/14913 | GNOME Wayland set_position 不工作 |
| S26 | https://github.com/tauri-apps/wry/issues/1314 | wry Wayland 需特定构造路径 |
| S27 | https://github.com/tauri-apps/tauri/issues/5425 | Tauri Wayland 启动问题实例 |
| S28 | https://www.reddit.com/r/tauri/comments/1x1ugmd/shipping_a_tauri_2_app_to_windows_and_linux_7/ | Tauri 2 Linux 实战坑（resize-drag 等） |
| S29 | http://who-t.blogspot.com/2022/12/libei-opening-portal-doors.html | Wayland 输入注入仅 RemoteDesktop/libei |
| S30 | https://v2.tauri.app/start/prerequisites/ | Tauri v2 Linux 系统依赖官方清单（CI job 的 apt 来源） |

---

## Phase 0 实施记录

Phase 0 的实测结论、两处否证、本机验证输出与未验证项，另见 [2026-11-14-phase0-implementation.md](2026-11-14-phase0-implementation.md)（按 pre-commit 文件大小约束拆出）。
