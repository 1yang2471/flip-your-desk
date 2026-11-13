use std::ffi::c_void;
use std::io::Cursor;
use std::time::{Duration, Instant};

use base64::Engine;
use image::RgbaImage;
use windows::core::w;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    ClientToScreen, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
    GetDIBits, GetMonitorInfoW, MonitorFromPoint, ReleaseDC, ScreenToClient, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HGDIOBJ, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};

use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::System::Diagnostics::Debug::{ReadProcessMemory, WriteProcessMemory};
use windows::Win32::System::Memory::{
    VirtualAllocEx, VirtualFreeEx, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_OPERATION, PROCESS_VM_READ, PROCESS_VM_WRITE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, FindWindowW, GetSystemMetrics, GetWindowLongW, GetWindowRect,
    GetWindowThreadProcessId, IsWindowVisible, SendMessageTimeoutW, SetWindowPos,
    SystemParametersInfoW, GWL_STYLE, ICONMETRICSW, SMTO_ABORTIFHUNG, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SPI_GETICONMETRICS, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
};

use crate::error::{AppError, AppResult};
use crate::geometry;
use crate::icon_cutout;
use crate::model::{IconRecord, IconWrite, LabelBox, LabelFont, MonitorInfo, RectI, Tone};

use super::{ApplyReport, Captured, ProbeData};

const WM_COMMAND: u32 = 0x0111;
const TOGGLE_DESKTOP_ICONS: usize = 0x7402;

const LVM_GETITEMCOUNT: u32 = 0x1004;
const LVM_GETITEMPOSITION: u32 = 0x1010;
const LVM_SETITEMPOSITION32: u32 = 0x1049;
const LVM_GETITEMTEXTW: u32 = 0x1073;
const LVM_GETITEMSPACING: u32 = 0x1033;
const LVM_SETITEMSTATE: u32 = 0x102B;
const LVM_GETITEMRECT: u32 = 0x100E;

const LVIR_ICON: i32 = 1;
const LVIR_LABEL: i32 = 2;

const LVS_AUTOARRANGE: u32 = 0x0100;
const LVIF_TEXT: u32 = 0x0001;
const LVIF_STATE: u32 = 0x0008;
const LVIS_FOCUSED: u32 = 0x0001;
const LVIS_SELECTED: u32 = 0x0002;

const REMOTE_SIZE: usize = 65536;
const TEXT_OFFSET: usize = 4096;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct LvItemW {
    mask: u32,
    i_item: i32,
    i_sub_item: i32,
    state: u32,
    state_mask: u32,
    psz_text: *mut u16,
    cch_text_max: i32,
    i_image: i32,
    l_param: isize,
    i_indent: i32,
    i_group_id: i32,
    c_columns: u32,
    pu_columns: *mut u32,
    pi_col_fmt: *mut i32,
    i_group: i32,
}

struct ProcessHandle(HANDLE);

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        if !self.0 .0.is_null() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

struct RemoteBuffer {
    process: HANDLE,
    ptr: *mut c_void,
}

impl RemoteBuffer {
    fn new(process: HANDLE, size: usize) -> AppResult<Self> {
        let ptr = unsafe {
            VirtualAllocEx(
                process,
                None,
                size,
                MEM_COMMIT | MEM_RESERVE,
                PAGE_READWRITE,
            )
        };
        if ptr.is_null() {
            return Err(AppError::with_detail(
                "remote_memory",
                "VirtualAllocEx failed",
            ));
        }
        Ok(Self { process, ptr })
    }

    fn write<T>(&self, offset: usize, value: &T) -> AppResult<()> {
        unsafe {
            WriteProcessMemory(
                self.process,
                self.ptr.cast::<u8>().add(offset).cast(),
                value as *const T as *const c_void,
                std::mem::size_of::<T>(),
                None,
            )
        }
        .map_err(|err| AppError::with_detail("remote_write", err.to_string()))
    }

    fn read<T: Copy>(&self, offset: usize) -> AppResult<T> {
        let mut value: T = unsafe { std::mem::zeroed() };
        unsafe {
            ReadProcessMemory(
                self.process,
                self.ptr.cast::<u8>().add(offset).cast(),
                &mut value as *mut T as *mut c_void,
                std::mem::size_of::<T>(),
                None,
            )
        }
        .map_err(|err| AppError::with_detail("remote_read", err.to_string()))?;
        Ok(value)
    }

    fn ptr_at(&self, offset: usize) -> *mut c_void {
        unsafe { self.ptr.cast::<u8>().add(offset).cast() }
    }
}

impl Drop for RemoteBuffer {
    fn drop(&mut self) {
        unsafe {
            let _ = VirtualFreeEx(self.process, self.ptr, 0, MEM_RELEASE);
        }
    }
}

struct Desktop {
    progman: HWND,
    defview: HWND,
    listview: HWND,
    _process: ProcessHandle,
    process_handle: HANDLE,
    remote: RemoteBuffer,
}

impl Desktop {
    fn open() -> AppResult<Self> {
        let (progman, defview, listview) = find_desktop_windows().ok_or_else(|| {
            AppError::with_detail("desktop_not_found", "SHELLDLL_DefView not found")
        })?;
        let mut pid = 0u32;
        unsafe {
            GetWindowThreadProcessId(listview, Some(&mut pid));
        }
        if pid == 0 {
            return Err(AppError::with_detail(
                "desktop_not_found",
                "explorer pid unavailable",
            ));
        }
        let handle = unsafe {
            OpenProcess(
                PROCESS_VM_OPERATION
                    | PROCESS_VM_READ
                    | PROCESS_VM_WRITE
                    | PROCESS_QUERY_INFORMATION,
                false,
                pid,
            )
        }
        .map_err(|err| {
            AppError::with_detail(
                "permission_denied",
                format!("OpenProcess({pid}) failed: {err}"),
            )
        })?;
        let process = ProcessHandle(handle);
        let remote = RemoteBuffer::new(handle, REMOTE_SIZE)?;
        Ok(Self {
            progman,
            defview,
            listview,
            _process: process,
            process_handle: handle,
            remote,
        })
    }

    fn count(&self) -> AppResult<usize> {
        let value = self.send(listview_msg(LVM_GETITEMCOUNT, 0, 0))?;
        Ok(value.max(0) as usize)
    }

    fn spacing(&self) -> AppResult<(i32, i32)> {
        // wParam = FALSE 返回图标视图的单元格间距（物理像素）。
        let raw = self.send(listview_msg(LVM_GETITEMSPACING, 0, 0))? as u32;
        let cx = (raw & 0xFFFF) as i32;
        let cy = ((raw >> 16) & 0xFFFF) as i32;
        if cx <= 0 || cy <= 0 {
            return Ok((76, 100));
        }
        Ok((cx, cy))
    }

    fn style(&self) -> u32 {
        unsafe { GetWindowLongW(self.listview, GWL_STYLE) as u32 }
    }

    fn auto_arrange(&self) -> bool {
        self.style() & LVS_AUTOARRANGE != 0
    }

    fn icons_visible(&self) -> bool {
        unsafe { IsWindowVisible(self.listview).as_bool() }
    }

    fn item_position(&self, index: usize) -> AppResult<POINT> {
        let point = POINT { x: 0, y: 0 };
        self.remote.write(0, &point)?;
        self.send(listview_msg(
            LVM_GETITEMPOSITION,
            index,
            self.remote.ptr_at(0) as isize,
        ))?;
        let mut point: POINT = self.remote.read(0)?;
        if !unsafe { ClientToScreen(self.listview, &mut point) }.as_bool() {
            return Err(AppError::with_detail(
                "desktop_read",
                "ClientToScreen failed",
            ));
        }
        Ok(point)
    }

    /// 读取 item 的图标矩形或标签矩形（屏幕坐标）。
    /// `kind` 取 LVIR_ICON / LVIR_LABEL（LVM_GETITEMRECT 约定先写入 RECT.left）。
    fn item_rect(&self, index: usize, kind: i32) -> AppResult<Option<RECT>> {
        let rect = RECT {
            left: kind,
            ..Default::default()
        };
        self.remote.write(0, &rect)?;
        let ok = self.send(listview_msg(
            LVM_GETITEMRECT,
            index,
            self.remote.ptr_at(0) as isize,
        ))?;
        if ok == 0 {
            return Ok(None);
        }
        let rect: RECT = self.remote.read(0)?;
        let mut top_left = POINT {
            x: rect.left,
            y: rect.top,
        };
        let mut bottom_right = POINT {
            x: rect.right,
            y: rect.bottom,
        };
        if !unsafe { ClientToScreen(self.listview, &mut top_left) }.as_bool()
            || !unsafe { ClientToScreen(self.listview, &mut bottom_right) }.as_bool()
        {
            return Err(AppError::with_detail(
                "desktop_read",
                "ClientToScreen failed",
            ));
        }
        Ok(Some(RECT {
            left: top_left.x,
            top: top_left.y,
            right: bottom_right.x,
            bottom: bottom_right.y,
        }))
    }

    fn item_text(&self, index: usize) -> AppResult<String> {
        let item = LvItemW {
            mask: LVIF_TEXT,
            i_item: index as i32,
            psz_text: self.remote.ptr_at(TEXT_OFFSET).cast::<u16>(),
            cch_text_max: 512,
            ..Default::default()
        };
        self.remote.write(0, &item)?;
        self.send(listview_msg(
            LVM_GETITEMTEXTW,
            index,
            self.remote.ptr_at(0) as isize,
        ))?;
        let mut buffer = [0u16; 512];
        unsafe {
            ReadProcessMemory(
                self.process_handle,
                self.remote.ptr_at(TEXT_OFFSET),
                buffer.as_mut_ptr().cast(),
                buffer.len() * 2,
                None,
            )
        }
        .map_err(|err| AppError::with_detail("desktop_read", err.to_string()))?;
        let len = buffer
            .iter()
            .position(|ch| *ch == 0)
            .unwrap_or(buffer.len());
        Ok(String::from_utf16_lossy(&buffer[..len]))
    }

    fn clear_selection(&self) -> AppResult<()> {
        let count = self.count()?;
        let item = LvItemW {
            mask: LVIF_STATE,
            state: 0,
            state_mask: LVIS_SELECTED | LVIS_FOCUSED,
            ..Default::default()
        };
        for index in 0..count {
            let mut item = item;
            item.i_item = index as i32;
            self.remote.write(0, &item)?;
            let _ = self.send(listview_msg(
                LVM_SETITEMSTATE,
                index,
                self.remote.ptr_at(0) as isize,
            ));
        }
        Ok(())
    }

    fn read_items(&self) -> AppResult<(usize, Vec<PointItem>, (i32, i32))> {
        let count = self.count()?;
        let spacing = self.spacing()?;
        let mut items = Vec::with_capacity(count);
        for index in 0..count {
            let position = self.item_position(index)?;
            let name = self.item_text(index)?;
            items.push(PointItem {
                name,
                x: position.x,
                y: position.y,
            });
        }
        Ok((count, items, spacing))
    }

    fn toggle_icons(&self) -> AppResult<()> {
        self.send_timeout(
            self.defview,
            listview_msg(WM_COMMAND, TOGGLE_DESKTOP_ICONS, 0),
            1000,
        )?;
        Ok(())
    }

    fn wait_visible(&self, visible: bool, timeout: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < timeout {
            if self.icons_visible() == visible {
                return true;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        self.icons_visible() == visible
    }

    fn send(&self, (msg, wparam, lparam): (u32, usize, isize)) -> AppResult<isize> {
        self.send_timeout(self.listview, (msg, wparam, lparam), 1500)
    }

    fn send_timeout(
        &self,
        hwnd: HWND,
        (msg, wparam, lparam): (u32, usize, isize),
        timeout_ms: u32,
    ) -> AppResult<isize> {
        let mut result: usize = 0;
        let ret = unsafe {
            SendMessageTimeoutW(
                hwnd,
                msg,
                WPARAM(wparam),
                LPARAM(lparam),
                SMTO_ABORTIFHUNG,
                timeout_ms,
                Some(&mut result),
            )
        };
        if ret.0 == 0 {
            return Err(AppError::with_detail(
                "explorer_timeout",
                format!("SendMessageTimeoutW(0x{msg:04x}) failed"),
            ));
        }
        Ok(result as isize)
    }

    fn set_item_position(
        &self,
        index: usize,
        screen_x: i32,
        screen_y: i32,
        expected_name: &str,
    ) -> AppResult<()> {
        let mut point = POINT {
            x: screen_x,
            y: screen_y,
        };
        if !unsafe { ScreenToClient(self.listview, &mut point) }.as_bool() {
            return Err(AppError::with_detail(
                "desktop_write",
                "ScreenToClient failed",
            ));
        }
        // 这台系统的桌面 listview 对写消息可能返回 0（即便写入已生效），
        // 不能信任返回值：以读回的坐标与名字双重校验为准。只发 32 位变体，
        // 0x100F 打包 16 位坐标在负值（副屏在主屏左侧）下写的是垃圾位置。
        let _ = self.raw_set_item_position(index, point.x, point.y)?;
        let current = self.item_position(index)?;
        if (current.x - screen_x).abs() > 2 || (current.y - screen_y).abs() > 2 {
            return Err(AppError::with_detail(
                "desktop_write",
                format!(
                    "item {index} did not land at ({screen_x},{screen_y}), read back ({},{})",
                    current.x, current.y
                ),
            ));
        }
        // 读回名字，确认这个索引仍是我们要写的那一个：游戏期间桌面图标集合
        // 可能变化（新建/删除快捷方式），索引整体位移时绝不能写错对象。
        let name = self.item_text(index)?;
        if name != expected_name {
            return Err(AppError::with_detail(
                "desktop_changed",
                format!("item {index} now holds \"{name}\", expected \"{expected_name}\""),
            ));
        }
        Ok(())
    }

    /// 直接以 listview 客户端坐标发送写入，返回 LRESULT 便于诊断。
    fn raw_set_item_position(
        &self,
        index: usize,
        client_x: i32,
        client_y: i32,
    ) -> AppResult<isize> {
        let point = POINT {
            x: client_x,
            y: client_y,
        };
        self.remote.write(0, &point)?;
        self.send(listview_msg(
            LVM_SETITEMPOSITION32,
            index,
            self.remote.ptr_at(0) as isize,
        ))
    }
}

struct PointItem {
    name: String,
    x: i32,
    y: i32,
}

fn listview_msg(msg: u32, wparam: usize, lparam: isize) -> (u32, usize, isize) {
    (msg, wparam, lparam)
}

fn find_desktop_windows() -> Option<(HWND, HWND, HWND)> {
    let progman = unsafe { FindWindowW(w!("Progman"), None) }
        .ok()
        .unwrap_or_default();
    if !progman.0.is_null() {
        if let Ok(defview) =
            unsafe { FindWindowExW(Some(progman), None, w!("SHELLDLL_DefView"), None) }
        {
            if let Ok(listview) =
                unsafe { FindWindowExW(Some(defview), None, w!("SysListView32"), None) }
            {
                if !listview.0.is_null() {
                    return Some((progman, defview, listview));
                }
            }
        }
    }

    // 部分 Windows 版本把桌面视图挂在顶层 WorkerW 下。
    let mut worker = HWND::default();
    loop {
        let after = if worker.0.is_null() {
            None
        } else {
            Some(worker)
        };
        let Ok(next) = (unsafe { FindWindowExW(None, after, w!("WorkerW"), None) }) else {
            break;
        };
        if next.0.is_null() {
            break;
        }
        worker = next;
        if let Ok(defview) =
            unsafe { FindWindowExW(Some(worker), None, w!("SHELLDLL_DefView"), None) }
        {
            if let Ok(listview) =
                unsafe { FindWindowExW(Some(defview), None, w!("SysListView32"), None) }
            {
                if !listview.0.is_null() {
                    return Some((worker, defview, listview));
                }
            }
        }
    }
    None
}

struct VisibilityGuard<'a> {
    desktop: &'a Desktop,
    hidden_by_us: bool,
}

impl<'a> VisibilityGuard<'a> {
    fn hide(desktop: &'a Desktop) -> AppResult<Self> {
        if !desktop.icons_visible() {
            return Err(AppError::new("icons_hidden"));
        }
        desktop.toggle_icons()?;
        if !desktop.wait_visible(false, Duration::from_millis(1200)) {
            // 尝试恢复；恢复后返回错误，避免在用户桌面留下隐藏状态。
            let _ = desktop.toggle_icons();
            let _ = desktop.wait_visible(true, Duration::from_millis(1200));
            return Err(AppError::with_detail(
                "icon_visibility_toggle_failed",
                "desktop icons did not hide",
            ));
        }
        Ok(Self {
            desktop,
            hidden_by_us: true,
        })
    }
}

impl Drop for VisibilityGuard<'_> {
    fn drop(&mut self) {
        if self.hidden_by_us {
            let desktop = self.desktop;
            let _ = desktop.toggle_icons();
            let _ = desktop.wait_visible(true, Duration::from_millis(1200));
        }
    }
}

impl VisibilityGuard<'_> {
    /// 交棒：本次隐藏由调用方接管（例如整局都想保持图标隐藏），
    /// Drop 不再自动恢复。
    fn commit(&mut self) {
        self.hidden_by_us = false;
    }
}

fn capture_window(hwnd: HWND) -> AppResult<(RgbaImage, RECT)> {
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }
        .map_err(|err| AppError::with_detail("screen_capture_failed", err.to_string()))?;
    let width = (rect.right - rect.left).max(1);
    let height = (rect.bottom - rect.top).max(1);

    let screen_dc = unsafe { GetDC(None) };
    if screen_dc.0.is_null() {
        return Err(AppError::with_detail(
            "screen_capture_failed",
            "GetDC failed",
        ));
    }
    let mem_dc = unsafe { CreateCompatibleDC(Some(screen_dc)) };
    if mem_dc.0.is_null() {
        unsafe {
            let _ = ReleaseDC(None, screen_dc);
        }
        return Err(AppError::with_detail(
            "screen_capture_failed",
            "CreateCompatibleDC failed",
        ));
    }
    let bitmap = unsafe { CreateCompatibleBitmap(screen_dc, width, height) };
    if bitmap.0.is_null() {
        unsafe {
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(None, screen_dc);
        }
        return Err(AppError::with_detail(
            "screen_capture_failed",
            "CreateCompatibleBitmap failed",
        ));
    }
    let old = unsafe { SelectObject(mem_dc, HGDIOBJ(bitmap.0)) };

    let ok = unsafe { PrintWindow(hwnd, mem_dc, PRINT_WINDOW_FLAGS(2)) };
    if !ok.as_bool() {
        unsafe {
            let _ = SelectObject(mem_dc, old);
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(None, screen_dc);
        }
        return Err(AppError::with_detail(
            "screen_capture_failed",
            "PrintWindow failed",
        ));
    }

    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = width;
    bmi.bmiHeader.biHeight = -height;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = 0;

    let mut buffer = vec![0u8; width as usize * height as usize * 4];
    let got = unsafe {
        GetDIBits(
            mem_dc,
            bitmap,
            0,
            height as u32,
            Some(buffer.as_mut_ptr().cast()),
            &mut bmi,
            DIB_RGB_COLORS,
        )
    };
    unsafe {
        let _ = SelectObject(mem_dc, old);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(None, screen_dc);
    }
    if got == 0 {
        return Err(AppError::with_detail(
            "screen_capture_failed",
            "GetDIBits failed",
        ));
    }

    // BGRA -> RGBA; PrintWindow 的 alpha 通常为 0，统一补成不透明。
    for pixel in buffer.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        pixel[3] = 255;
    }
    let image = RgbaImage::from_raw(width as u32, height as u32, buffer)
        .ok_or_else(|| AppError::with_detail("screen_capture_failed", "image buffer mismatch"))?;
    Ok((image, rect))
}

fn capture_bounds(desktop: &Desktop) -> AppResult<(HWND, RECT)> {
    let mut lv_rect = RECT::default();
    unsafe { GetWindowRect(desktop.listview, &mut lv_rect) }
        .map_err(|err| AppError::with_detail("screen_capture_failed", err.to_string()))?;
    let vx = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let vy = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let vw = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let vh = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    let covers_virtual = lv_rect.left <= vx
        && lv_rect.top <= vy
        && lv_rect.right >= vx + vw
        && lv_rect.bottom >= vy + vh;
    if covers_virtual {
        return Ok((desktop.listview, lv_rect));
    }

    let mut prog_rect = RECT::default();
    unsafe { GetWindowRect(desktop.progman, &mut prog_rect) }
        .map_err(|err| AppError::with_detail("screen_capture_failed", err.to_string()))?;
    let prog_covers = prog_rect.left <= vx
        && prog_rect.top <= vy
        && prog_rect.right >= vx + vw
        && prog_rect.bottom >= vy + vh;
    if prog_covers {
        return Ok((desktop.progman, prog_rect));
    }

    // 当前实现无法可靠覆盖非主屏；宁可报错，也不生成错位牌面。
    Err(AppError::with_detail(
        "multi_monitor_capture_failed",
        "desktop view does not cover the virtual screen",
    ))
}

fn encode_png_data_url(image: &RgbaImage) -> AppResult<String> {
    let mut cursor = Cursor::new(Vec::new());
    image
        .write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|err| AppError::with_detail("encode_icon", err.to_string()))?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
    ))
}

/// 桌面图标标签的字体信息（SPI_GETICONMETRICS）。
pub struct LabelFontInfo {
    pub family: String,
    /// 逻辑像素字号（取 |lfHeight|，96 DPI 单位）。
    pub size_px: f64,
    pub weight: i32,
}

fn icon_metrics() -> Option<LabelFontInfo> {
    let mut metrics = ICONMETRICSW {
        cbSize: std::mem::size_of::<ICONMETRICSW>() as u32,
        ..Default::default()
    };
    unsafe {
        SystemParametersInfoW(
            SPI_GETICONMETRICS,
            metrics.cbSize,
            Some(&mut metrics as *mut _ as *mut core::ffi::c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    }
    .ok()?;
    let face = &metrics.lfFont.lfFaceName;
    let len = face.iter().position(|ch| *ch == 0).unwrap_or(face.len());
    let family = String::from_utf16_lossy(&face[..len]);
    Some(LabelFontInfo {
        family: if family.is_empty() {
            "Segoe UI".to_string()
        } else {
            family
        },
        size_px: metrics.lfFont.lfHeight.unsigned_abs() as f64,
        weight: metrics.lfFont.lfWeight,
    })
}

fn tone_for_cell(clean: &RgbaImage, origin: RECT, cell: RectI) -> Tone {
    let x = cell.x - origin.left;
    let y = cell.y - origin.top;
    let w = cell.w;
    let h = cell.h;
    let left = x.max(0) as u32;
    let top = y.max(0) as u32;
    let right = (x + w).min(clean.width() as i32).max(0) as u32;
    let bottom = (y + h).min(clean.height() as i32).max(0) as u32;
    if right <= left || bottom <= top {
        return Tone::Light;
    }
    let mut sum = 0.0f64;
    let mut count = 0u64;
    let step_x = ((right - left) / 8).max(1);
    let step_y = ((bottom - top) / 8).max(1);
    let mut yy = top;
    while yy < bottom {
        let mut xx = left;
        while xx < right {
            let p = clean.get_pixel(xx, yy);
            let lum = 0.2126 * p[0] as f64 + 0.7152 * p[1] as f64 + 0.0722 * p[2] as f64;
            sum += lum;
            count += 1;
            xx += step_x;
        }
        yy += step_y;
    }
    if count == 0 {
        return Tone::Light;
    }
    if sum / count as f64 > 150.0 {
        Tone::Dark
    } else {
        Tone::Light
    }
}

/// 单格提取结果：全格画布 + 桌面标签几何。
struct CellExtract {
    /// 单元格尺寸的 RGBA 画布；None = 没提取到图标（前端画字母占位）。
    image: Option<RgbaImage>,
    label: Option<LabelBox>,
}

/// 桌面标签行带的最大高度占比（单行文字远小于图标本体）。
const LABEL_BAND_MAX_RATIO: f32 = 0.25;
/// 桌面标签行带的最小起始占比（标签位于图标下方）。
const LABEL_BAND_MIN_TOP_RATIO: f32 = 0.45;

/// 把行带切成「图标区域」与「尾部文字区域」。
/// 文字行带判定：高度 ≤ 25% 格高且从 45% 格高以下开始；从底部往上连续剔除，
/// 至少保留一个图标带（两行标签会产出两个文字带，必须全部剔除）。
fn split_bands(
    bands: &[(usize, usize)],
    cell_h: usize,
) -> (Option<(usize, usize)>, Option<(usize, usize)>) {
    let max_label_h = ((cell_h as f32) * LABEL_BAND_MAX_RATIO).max(6.0) as usize;
    let min_label_top = ((cell_h as f32) * LABEL_BAND_MIN_TOP_RATIO) as usize;
    let mut remaining = bands;
    let mut label_start: Option<usize> = None;
    let mut label_end: Option<usize> = None;
    while remaining.len() > 1 {
        let (start, end) = remaining[remaining.len() - 1];
        if end - start + 1 <= max_label_h && start >= min_label_top {
            // 从下往上剥：bottom 记第一次（最下面一行），top 记最后一次（最上面一行）。
            if label_end.is_none() {
                label_end = Some(end);
            }
            label_start = Some(start);
            remaining = &remaining[..remaining.len() - 1];
        } else {
            break;
        }
    }
    let icon = remaining
        .first()
        .map(|first| (first.0, remaining[remaining.len() - 1].1));
    let label = label_start.zip(label_end);
    (icon, label)
}

fn extract_cell(
    with_icons: &RgbaImage,
    clean: &RgbaImage,
    origin: RECT,
    cell: RectI,
    label_width: i32,
    label_center_x: Option<i32>,
) -> CellExtract {
    let mut result = CellExtract {
        image: None,
        label: None,
    };
    let x = cell.x - origin.left;
    let y = cell.y - origin.top;
    if cell.w < 8 || cell.h < 8 {
        return result;
    }
    let left = x.max(0) as u32;
    let top = y.max(0) as u32;
    let right = (x + cell.w).min(with_icons.width() as i32).max(0) as u32;
    let bottom = (y + cell.h).min(with_icons.height() as i32).max(0) as u32;
    if right <= left || bottom <= top {
        return result;
    }

    let cell_w = (right - left) as usize;
    let cell_h = (bottom - top) as usize;
    let mut row_has = vec![false; cell_h];
    for yy in 0..cell_h {
        for xx in 0..cell_w {
            if diff_at(with_icons, clean, left + xx as u32, top + yy as u32)
                > icon_cutout::INFLUENCE_THRESHOLD
            {
                row_has[yy] = true;
                break;
            }
        }
    }

    let mut bands: Vec<(usize, usize)> = Vec::new();
    let mut start: Option<usize> = None;
    for (row, has) in row_has.iter().enumerate() {
        if *has && start.is_none() {
            start = Some(row);
        } else if !*has {
            if let Some(s) = start.take() {
                bands.push((s, row - 1));
            }
        }
    }
    if let Some(s) = start {
        bands.push((s, cell_h - 1));
    }
    if bands.is_empty() {
        return result;
    }

    // 尾部短带是桌面标签（一行文字一个带，最多两行）；全部剔除，只留图标带。
    let (icon_area, label_area) = split_bands(&bands, cell_h);
    if let Some((label_start, label_end)) = label_area {
        let (mut min_x, mut max_x) = (usize::MAX, 0usize);
        for yy in label_start..=label_end {
            for xx in 0..cell_w {
                if diff_at(with_icons, clean, left + xx as u32, top + yy as u32)
                    > icon_cutout::INFLUENCE_THRESHOLD
                {
                    min_x = min_x.min(xx);
                    max_x = max_x.max(xx);
                }
            }
        }
        let center_x = label_center_x.unwrap_or_else(|| {
            if min_x == usize::MAX {
                (cell_w / 2) as i32
            } else {
                ((min_x + max_x) / 2) as i32
            }
        });
        result.label = Some(LabelBox {
            top: label_start as i32,
            center_x,
            width: label_width.max(cell.w),
        });
    }

    let Some((icon_top, icon_bottom)) = icon_area else {
        return result;
    };

    // 只对图标带区域做 alpha 提取；画布仍是整个单元格，保证位置/尺寸 1:1。
    let area_top = top + icon_top as u32;
    let area_bottom = (top + icon_bottom as u32 + 1).min(with_icons.height());
    if area_bottom <= area_top {
        return result;
    }
    let area_h = area_bottom - area_top;
    let crop_with =
        image::imageops::crop_imm(with_icons, left, area_top, cell_w as u32, area_h).to_image();
    let crop_clean =
        image::imageops::crop_imm(clean, left, area_top, cell_w as u32, area_h).to_image();
    let Some(cut) = icon_cutout::cutout(&crop_with, &crop_clean) else {
        return result;
    };

    let mut canvas = RgbaImage::new(cell_w as u32, cell_h as u32);
    for (px, py, pixel) in cut.image.enumerate_pixels() {
        let dx = cut.origin_x + px;
        let dy = icon_top as u32 + cut.origin_y + py;
        if (dx as usize) < cell_w && (dy as usize) < cell_h {
            canvas.put_pixel(dx, dy, *pixel);
        }
    }
    result.image = Some(canvas);
    result
}

fn diff_at(with_icons: &RgbaImage, clean: &RgbaImage, x: u32, y: u32) -> i32 {
    let a = with_icons.get_pixel(x, y);
    let b = clean.get_pixel(x, y);
    (a[0] as i32 - b[0] as i32)
        .abs()
        .max((a[1] as i32 - b[1] as i32).abs())
        .max((a[2] as i32 - b[2] as i32).abs())
}

pub fn probe() -> ProbeData {
    let Some((_, _, listview)) = find_desktop_windows() else {
        return ProbeData {
            icon_count: 0,
            auto_arrange: false,
            icons_visible: false,
            desktop_found: false,
            permission_denied: false,
            error_code: None,
            detail: Some("SHELLDLL_DefView not found".into()),
        };
    };
    match Desktop::open() {
        Ok(desktop) => ProbeData {
            icon_count: desktop.count().unwrap_or(0),
            auto_arrange: desktop.auto_arrange(),
            icons_visible: desktop.icons_visible(),
            desktop_found: true,
            permission_denied: false,
            error_code: None,
            detail: None,
        },
        Err(err) => {
            let permission = err.code == "permission_denied";
            ProbeData {
                icon_count: 0,
                auto_arrange: false,
                icons_visible: unsafe { IsWindowVisible(listview).as_bool() },
                desktop_found: true,
                // 权限问题走启动器的 issue 卡片；其余探测失败透传原始错误码。
                permission_denied: permission,
                error_code: if permission {
                    None
                } else {
                    Some(err.code.clone())
                },
                detail: Some(err.to_string()),
            }
        }
    }
}

/// 指定显示器的工作区（刨掉该屏自己的任务栏后的矩形）。
pub fn monitor_work_area(x: i32, y: i32, w: u32, h: u32) -> Option<(i32, i32, u32, u32)> {
    let center = POINT {
        x: x + w as i32 / 2,
        y: y + h as i32 / 2,
    };
    let monitor = unsafe { MonitorFromPoint(center, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_invalid() {
        return None;
    }
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let ok = unsafe { GetMonitorInfoW(monitor, &mut info) };
    if !ok.as_bool() {
        return None;
    }
    Some((
        info.rcWork.left,
        info.rcWork.top,
        (info.rcWork.right - info.rcWork.left) as u32,
        (info.rcWork.bottom - info.rcWork.top) as u32,
    ))
}

/// 显示/隐藏桌面图标。整局游戏期间保持隐藏，否则卡牌缝隙与拖动后的
/// 空位会漏出真实图标（既穿帮又等于给出答案）。
pub fn set_icons_visible(visible: bool) -> AppResult<()> {
    let desktop = Desktop::open()?;
    if desktop.icons_visible() == visible {
        return Ok(());
    }
    desktop.toggle_icons()?;
    if desktop.wait_visible(visible, Duration::from_millis(1500)) {
        Ok(())
    } else {
        Err(AppError::with_detail(
            "icon_visibility_toggle_failed",
            format!("desktop icons did not become visible={visible}"),
        ))
    }
}

/// 把窗口钉在桌面层：z 序紧贴 Progman 上方，于是桌面之上、所有普通窗口之下。
/// 普通窗口因此可以随时盖住卡牌并正常接收点击。
pub fn pin_window_over_desktop(hwnd: isize) -> AppResult<()> {
    let Some(anchor) = find_desktop_windows().map(|(progman, _, _)| progman) else {
        return Ok(());
    };
    let window = HWND(hwnd as *mut core::ffi::c_void);
    unsafe {
        SetWindowPos(
            window,
            Some(anchor),
            0,
            0,
            0,
            0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE,
        )
    }
    .map_err(|err| AppError::with_detail("pin_over_desktop", err.to_string()))
}

pub fn capture(monitors: &[MonitorInfo]) -> AppResult<Captured> {
    let desktop = Desktop::open()?;
    if !desktop.icons_visible() {
        return Err(AppError::new("icons_hidden"));
    }
    if desktop.auto_arrange() {
        return Err(AppError::new("auto_arrange_on"));
    }
    let (count, mut items, spacing) = desktop.read_items()?;
    if count < 2 {
        return Err(AppError::new("too_few_icons"));
    }
    // 桌面图标太多会滚动、图标也可能被拖进任务栏条后面：这些格子做不成
    // 可点击的牌（卡在覆盖层外），直接不进本局，真身留在原处不被写回触碰。
    let covered: Vec<RectI> = monitors.iter().map(|monitor| monitor.rect()).collect();
    items.retain(|item| {
        let cx = item.x + spacing.0 / 2;
        let cy = item.y + spacing.1 / 2;
        covered.iter().any(|rect| rect.contains(cx, cy))
    });
    desktop.clear_selection()?;

    let (capture_hwnd, origin) = capture_bounds(&desktop)?;
    let (with_icons, _) = capture_window(capture_hwnd)?;

    // 隐藏真实图标拍“干净”背景。成功后保持隐藏（整局都用它盖住答案，
    // 否则卡牌缝隙与拖动后的空位会漏出真实图标）；失败则由 Guard 的
    // Drop 自动恢复，绝不把桌面停在隐藏态。
    let mut guard = VisibilityGuard::hide(&desktop)?;
    let (clean, _) = capture_window(capture_hwnd)?;
    guard.commit();

    // id 必须是 0..len 连续：它同时是游戏槽位号（placements 按此索引），
    // 过滤掉屏外图标后不能再沿用原始 listview 索引。
    let label_font = match icon_metrics() {
        Some(font) => LabelFont {
            family: font.family,
            size_px: font.size_px,
            weight: font.weight,
        },
        None => LabelFont::default(),
    };
    let icons = items
        .iter()
        .enumerate()
        .map(|(slot, item)| {
            let cell = RectI {
                x: item.x,
                y: item.y,
                w: spacing.0,
                h: spacing.1,
            };
            let monitor = geometry::monitor_for_cell(cell, monitors);
            // Explorer 的标签矩形是逻辑网格坐标，与自定义图标位置不一定同原点；
            // 取它的宽度和中心相对 cell 的偏移，文字才会按桌面的方式居中/溢出。
            let label_rect = desktop.item_rect(slot, LVIR_LABEL).ok().flatten();
            let label_width = label_rect
                .map(|rect| rect.right - rect.left)
                .unwrap_or(cell.w);
            let label_center_x = label_rect.map(|rect| (rect.left + rect.right) / 2 - cell.x);
            let extract = extract_cell(
                &with_icons,
                &clean,
                origin,
                cell,
                label_width,
                label_center_x,
            );
            IconRecord {
                id: slot as u32,
                name: item.name.clone(),
                image: extract
                    .image
                    .as_ref()
                    .and_then(|image| encode_png_data_url(image).ok())
                    .unwrap_or_default(),
                cell,
                monitor,
                tone: tone_for_cell(&clean, origin, cell),
                label: extract.label,
            }
        })
        .collect::<Vec<_>>();

    Ok(Captured { icons, label_font })
}

pub fn apply_positions(positions: &[IconWrite]) -> AppResult<ApplyReport> {
    let desktop = Desktop::open()?;
    if !desktop.icons_visible() {
        return Err(AppError::new("icons_hidden"));
    }
    if desktop.auto_arrange() {
        return Err(AppError::new("auto_arrange_on"));
    }
    let (_, items, _) = desktop.read_items()?;
    // 以名字为身份把目标配到当前桌面项上；同名图标取离目标位置最近的一个。
    let (resolved, missing) = resolve_targets(positions, &items);
    let mut failed_write: Vec<String> = Vec::new();
    for target in &resolved {
        // explorer 瞬时忙碌会让单条 LVM 写入被拒：重试几次再放弃。
        let mut ok = false;
        for attempt in 0..3 {
            match desktop.set_item_position(target.index, target.x, target.y, &target.name) {
                Ok(()) => {
                    ok = true;
                    break;
                }
                Err(err) => {
                    // 集合在写回途中变化（索引位移）必须立刻中止：已写成的
                    // 每一项都经过名字+位置双重校验，属于安全状态，重试会
                    // 重新解析一遍，不会写错对象。
                    if err.code == "desktop_changed" {
                        return Err(err);
                    }
                    if attempt < 2 {
                        std::thread::sleep(Duration::from_millis(120));
                    }
                }
            }
        }
        if !ok {
            failed_write.push(target.name.clone());
        }
    }
    std::thread::sleep(Duration::from_millis(160));
    Ok(ApplyReport {
        moved: resolved.len() - failed_write.len(),
        skipped_missing: missing,
        failed_write,
    })
}

/// 目标与当前桌面项的配对：同名取离目标位置最近的一个，已配对的不复用。
fn resolve_targets(
    targets: &[IconWrite],
    items: &[PointItem],
) -> (Vec<ResolvedTarget>, Vec<String>) {
    let mut used = vec![false; items.len()];
    let mut resolved = Vec::with_capacity(targets.len());
    let mut missing = Vec::new();
    for target in targets {
        let mut best: Option<(usize, i64)> = None;
        for (index, item) in items.iter().enumerate() {
            if used[index] || item.name != target.name {
                continue;
            }
            let distance = (item.x - target.x).abs() as i64 + (item.y - target.y).abs() as i64;
            if best.is_none() || distance < best.unwrap().1 {
                best = Some((index, distance));
            }
        }
        match best {
            Some((index, _)) => {
                used[index] = true;
                resolved.push(ResolvedTarget {
                    index,
                    name: target.name.clone(),
                    x: target.x,
                    y: target.y,
                });
            }
            None => missing.push(target.name.clone()),
        }
    }
    (resolved, missing)
}

struct ResolvedTarget {
    index: usize,
    name: String,
    x: i32,
    y: i32,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(name: &str, x: i32, y: i32) -> PointItem {
        PointItem {
            name: name.into(),
            x,
            y,
        }
    }

    fn target(name: &str, x: i32, y: i32) -> IconWrite {
        IconWrite {
            name: name.into(),
            x,
            y,
        }
    }

    #[test]
    fn resolves_by_name() {
        let items = vec![item("A", 10, 10), item("B", 100, 10)];
        let targets = vec![target("B", 100, 10)];
        let (resolved, missing) = resolve_targets(&targets, &items);
        assert_eq!(missing, Vec::<String>::new());
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].index, 1);
        assert_eq!((resolved[0].x, resolved[0].y), (100, 10));
    }

    #[test]
    fn same_name_resolved_by_nearest_position() {
        let items = vec![item("A", 10, 10), item("A", 500, 500)];
        let targets = vec![target("A", 490, 510), target("A", 20, 20)];
        let (resolved, missing) = resolve_targets(&targets, &items);
        assert!(missing.is_empty());
        // 两个同名目标各配到不同项上，互不占用。
        assert_eq!(resolved[0].index, 1);
        assert_eq!(resolved[1].index, 0);
    }

    #[test]
    fn missing_name_is_reported_not_fatal() {
        let items = vec![item("A", 10, 10)];
        let targets = vec![target("gone", 10, 10), target("A", 10, 10)];
        let (resolved, missing) = resolve_targets(&targets, &items);
        assert_eq!(missing, vec!["gone".to_string()]);
        assert_eq!(resolved.len(), 1);
    }

    #[test]
    fn offscreen_items_are_dropped_before_ids_are_assigned() {
        // 模拟 capture 的过滤 + 重新编号：屏外图标被剔除后，id 仍须 0..len 连续，
        // 否则 placements 按 len 索引会越界（invalid_slot）。
        let monitors = [MonitorInfo {
            index: 0,
            name: "test".into(),
            x: 0,
            y: 0,
            width: 1920,
            height: 1032,
            scale: 1.0,
            primary: true,
        }];
        let spacing = (76, 100);
        let items = vec![
            item("onscreen-a", 10, 10),
            item("offscreen", 2000, 10),
            item("onscreen-b", 200, 10),
        ];
        let covered: Vec<RectI> = monitors.iter().map(|m| m.rect()).collect();
        let kept: Vec<&PointItem> = items
            .iter()
            .filter(|i| {
                let cx = i.x + spacing.0 / 2;
                let cy = i.y + spacing.1 / 2;
                covered.iter().any(|r| r.contains(cx, cy))
            })
            .collect();
        assert_eq!(kept.len(), 2);
        let ids: Vec<u32> = (0..kept.len()).map(|slot| slot as u32).collect();
        assert_eq!(ids, vec![0, 1]);
        assert!(ids.iter().all(|id| (*id as usize) < kept.len()));
    }

    fn rect_text(rect: Option<RECT>) -> String {
        match rect {
            Some(r) => format!("({},{})-({},{})", r.left, r.top, r.right, r.bottom),
            None => "-".to_string(),
        }
    }

    #[test]
    fn split_bands_strips_two_line_label() {
        // 图标 0..47，两行标签 50..63 / 65..78：两行都必须剔除。
        let (icon, label) = split_bands(&[(0, 47), (50, 63), (65, 78)], 100);
        assert_eq!(icon, Some((0, 47)));
        assert_eq!(label, Some((50, 78)));
    }

    #[test]
    fn split_bands_keeps_lone_icon_band() {
        let (icon, label) = split_bands(&[(0, 47)], 100);
        assert_eq!(icon, Some((0, 47)));
        assert_eq!(label, None);
    }

    #[test]
    fn split_bands_does_not_eat_tall_lower_band() {
        // 高度超过 25% 格高的下带不是文字，仍属图标。
        let (icon, label) = split_bands(&[(0, 47), (52, 90)], 100);
        assert_eq!(icon, Some((0, 90)));
        assert_eq!(label, None);
    }

    #[test]
    fn split_bands_requires_label_below_icon_area() {
        // 起始位置低于 45% 才可能是标签。
        let (icon, label) = split_bands(&[(0, 20), (30, 40)], 100);
        assert_eq!(icon, Some((0, 40)));
        assert_eq!(label, None);
    }

    fn crop_cell(image: &RgbaImage, origin: RECT, cell: RectI) -> Option<RgbaImage> {
        let x = cell.x - origin.left;
        let y = cell.y - origin.top;
        let left = x.max(0) as u32;
        let top = y.max(0) as u32;
        let right = (x + cell.w).min(image.width() as i32).max(0) as u32;
        let bottom = (y + cell.h).min(image.height() as i32).max(0) as u32;
        if right <= left || bottom <= top {
            return None;
        }
        Some(image::imageops::crop_imm(image, left, top, right - left, bottom - top).to_image())
    }

    /// 真机诊断：dump 真实桌面的几何与标签数据，供人工核对。
    /// 运行：cargo test dump_desktop_cells -- --ignored --nocapture
    #[test]
    #[ignore = "读取真实桌面并短暂隐藏图标，仅手动运行"]
    fn dump_desktop_cells() {
        let Ok(desktop) = Desktop::open() else {
            eprintln!("desktop not available");
            return;
        };
        if !desktop.icons_visible() || desktop.auto_arrange() {
            eprintln!("icons hidden or auto-arrange on; abort");
            return;
        }
        let (count, items, spacing) = desktop.read_items().expect("read items");
        eprintln!("count={count} spacing=({}, {})", spacing.0, spacing.1);
        match icon_metrics() {
            Some(font) => eprintln!(
                "label font: family={:?} size={}px weight={}",
                font.family, font.size_px, font.weight
            ),
            None => eprintln!("label font: unavailable"),
        }
        for (index, item) in items.iter().enumerate() {
            let icon = desktop.item_rect(index, LVIR_ICON).ok().flatten();
            let label = desktop.item_rect(index, LVIR_LABEL).ok().flatten();
            eprintln!(
                "item {index}: {:?} pos=({},{}) icon_rect={} label_rect={}",
                item.name,
                item.x,
                item.y,
                rect_text(icon),
                rect_text(label),
            );
        }

        let (hwnd, origin) = capture_bounds(&desktop).expect("capture bounds");
        let (with_icons, _) = capture_window(hwnd).expect("capture with icons");
        let guard = VisibilityGuard::hide(&desktop).expect("hide icons");
        let (clean, _) = capture_window(hwnd).expect("capture clean");
        drop(guard);

        let dir =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/desktop-dump");
        std::fs::create_dir_all(&dir).expect("create dump dir");
        with_icons.save(dir.join("with.png")).expect("save with");
        clean.save(dir.join("clean.png")).expect("save clean");

        let font = icon_metrics();
        let (font_family, font_size, font_weight) = match &font {
            Some(f) => (f.family.clone(), f.size_px, f.weight),
            None => ("Segoe UI".to_string(), 12.0, 400),
        };
        let scale = unsafe { windows::Win32::UI::HiDpi::GetDpiForSystem() } as f64 / 96.0;
        let mut metrics = String::new();

        for (index, item) in items.iter().enumerate() {
            let cell = RectI {
                x: item.x,
                y: item.y,
                w: spacing.0,
                h: spacing.1,
            };
            let (Some(cell_with), Some(cell_clean)) = (
                crop_cell(&with_icons, origin, cell),
                crop_cell(&clean, origin, cell),
            ) else {
                continue;
            };
            if index < 8 {
                let _ = cell_with.save(dir.join(format!("cell-{index:02}-with.png")));
                let _ = cell_clean.save(dir.join(format!("cell-{index:02}-clean.png")));
            }
            let label_rect = desktop.item_rect(index, LVIR_LABEL).ok().flatten();
            let label_width = label_rect
                .map(|rect| rect.right - rect.left)
                .unwrap_or(cell.w);
            let label_center_x = label_rect.map(|rect| (rect.left + rect.right) / 2 - cell.x);
            let extract = extract_cell(
                &with_icons,
                &clean,
                origin,
                cell,
                label_width,
                label_center_x,
            );
            if let Some(image) = &extract.image {
                let _ = image.save(dir.join(format!("extract-{index:02}.png")));
            }
            let (label_top, label_center, label_width) = match extract.label {
                Some(label) => (label.top, label.center_x, label.width),
                None => (-1, -1, -1),
            };
            metrics.push_str(&format!(
                "{index}\t{}\t{}\t{}\t{}\t{}\t{label_top}\t{label_center}\t{label_width}\t{font_family}\t{font_size}\t{font_weight}\t{scale}\n",
                item.name.replace('\t', " "),
                cell.x,
                cell.y,
                cell.w,
                cell.h,
            ));
        }
        std::fs::write(dir.join("metrics.txt"), metrics).expect("write metrics");
        eprintln!("dump written to {}", dir.display());
    }
}
