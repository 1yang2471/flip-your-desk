use std::ffi::c_void;
use std::io::Cursor;
use std::time::{Duration, Instant};

use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::{ImageEncoder, RgbImage, RgbaImage};
use windows::core::w;
use windows::Win32::Foundation::{
    CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
};
use windows::Win32::System::Diagnostics::Debug::{ReadProcessMemory, WriteProcessMemory};
use windows::Win32::System::Memory::{
    VirtualAllocEx, VirtualFreeEx, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_OPERATION, PROCESS_VM_READ, PROCESS_VM_WRITE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    ClientToScreen, FindWindowExW, FindWindowW, GetSystemMetrics, GetWindowLongW, GetWindowRect,
    GetWindowThreadProcessId, IsWindowVisible, PrintWindow, ScreenToClient, SendMessageTimeoutW,
    GWL_STYLE, SMTO_ABORTIFHUNG,
};

use crate::error::{AppError, AppResult};
use crate::geometry;
use crate::model::{IconRecord, MonitorInfo, RectI, Tone};

use super::{Captured, LayoutPositions, ProbeData};

const WM_COMMAND: u32 = 0x0111;
const TOGGLE_DESKTOP_ICONS: usize = 0x7402;

const LVM_GETITEMCOUNT: u32 = 0x1004;
const LVM_GETITEMPOSITION: u32 = 0x1010;
const LVM_SETITEMPOSITION32: u32 = 0x1049;
const LVM_GETITEMTEXTW: u32 = 0x1073;
const LVM_GETITEMSPACING: u32 = 0x1033;
const LVM_SETITEMSTATE: u32 = 0x102B;

const LVS_AUTOARRANGE: u32 = 0x0100;
const LVIF_TEXT: u32 = 0x0001;
const LVIF_STATE: u32 = 0x0008;
const LVIS_FOCUSED: u32 = 0x0001;
const LVIS_SELECTED: u32 = 0x0002;

const SM_XVIRTUALSCREEN: i32 = 76;
const SM_YVIRTUALSCREEN: i32 = 77;
const SM_CXVIRTUALSCREEN: i32 = 78;
const SM_CYVIRTUALSCREEN: i32 = 79;

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
            return Err(AppError::with_detail("desktop_not_found", "explorer pid unavailable"));
        }
        let handle = unsafe {
            OpenProcess(
                PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_QUERY_INFORMATION,
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
        let len = buffer.iter().position(|ch| *ch == 0).unwrap_or(buffer.len());
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
                index: index as u32,
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

    fn set_item_position(&self, index: usize, screen_x: i32, screen_y: i32) -> AppResult<()> {
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
        self.remote.write(0, &point)?;
        let result = self.send(listview_msg(
            LVM_SETITEMPOSITION32,
            index,
            self.remote.ptr_at(0) as isize,
        ))?;
        if result == 0 {
            return Err(AppError::with_detail(
                "desktop_write",
                format!("LVM_SETITEMPOSITION32 rejected item {index}"),
            ));
        }
        Ok(())
    }

    fn fingerprint(&self) -> AppResult<String> {
        let (_, items, _) = self.read_items()?;
        Ok(fingerprint_of(&items))
    }
}

struct PointItem {
    index: u32,
    name: String,
    x: i32,
    y: i32,
}

fn fingerprint_of(items: &[PointItem]) -> String {
    let mut out = String::new();
    for item in items {
        out.push_str(&format!(
            "{}:{}:{}:{};",
            item.index, item.name, item.x, item.y
        ));
    }
    out
}

fn listview_msg(msg: u32, wparam: usize, lparam: isize) -> (u32, usize, isize) {
    (msg, wparam, lparam)
}

fn find_desktop_windows() -> Option<(HWND, HWND, HWND)> {
    let progman = unsafe { FindWindowW(w!("Progman"), None) };
    if !progman.0.is_null() {
        let defview = unsafe { FindWindowExW(progman, None, w!("SHELLDLL_DefView"), None) };
        if !defview.0.is_null() {
            let listview = unsafe { FindWindowExW(defview, None, w!("SysListView32"), None) };
            if !listview.0.is_null() {
                return Some((progman, defview, listview));
            }
        }
    }

    // 部分 Windows 版本把桌面视图挂在顶层 WorkerW 下。
    let mut worker = HWND::default();
    loop {
        worker = unsafe { FindWindowExW(None, worker, w!("WorkerW"), None) };
        if worker.0.is_null() {
            break;
        }
        let defview = unsafe { FindWindowExW(worker, None, w!("SHELLDLL_DefView"), None) };
        if !defview.0.is_null() {
            let listview = unsafe { FindWindowExW(defview, None, w!("SysListView32"), None) };
            if !listview.0.is_null() {
                return Some((worker, defview, listview));
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

    fn restore(&mut self) -> AppResult<()> {
        if !self.hidden_by_us {
            return Ok(());
        }
        let desktop = self.desktop;
        desktop.toggle_icons()?;
        if desktop.wait_visible(true, Duration::from_millis(1200)) {
            self.hidden_by_us = false;
            Ok(())
        } else {
            // 再试一次，仍失败则把状态留给 Drop。
            let _ = desktop.toggle_icons();
            if desktop.wait_visible(true, Duration::from_millis(1200)) {
                self.hidden_by_us = false;
                return Ok(());
            }
            Err(AppError::with_detail(
                "icon_visibility_toggle_failed",
                "desktop icons did not come back",
            ))
        }
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

fn capture_window(hwnd: HWND) -> AppResult<(RgbaImage, RECT)> {
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }
        .map_err(|err| AppError::with_detail("screen_capture_failed", err.to_string()))?;
    let width = (rect.right - rect.left).max(1) as i32;
    let height = (rect.bottom - rect.top).max(1) as i32;

    let screen_dc = unsafe { GetDC(None) };
    if screen_dc.0.is_null() {
        return Err(AppError::with_detail(
            "screen_capture_failed",
            "GetDC failed",
        ));
    }
    let mem_dc = unsafe { CreateCompatibleDC(screen_dc) };
    if mem_dc.0.is_null() {
        unsafe {
            ReleaseDC(None, screen_dc);
        }
        return Err(AppError::with_detail(
            "screen_capture_failed",
            "CreateCompatibleDC failed",
        ));
    }
    let bitmap = unsafe { CreateCompatibleBitmap(screen_dc, width, height) };
    if bitmap.0.is_null() {
        unsafe {
            DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
        }
        return Err(AppError::with_detail(
            "screen_capture_failed",
            "CreateCompatibleBitmap failed",
        ));
    }
    let old = unsafe { SelectObject(mem_dc, bitmap) };

    let ok = unsafe { PrintWindow(hwnd, mem_dc, 2) };
    if !ok.as_bool() {
        unsafe {
            SelectObject(mem_dc, old);
            DeleteObject(bitmap);
            DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
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
        SelectObject(mem_dc, old);
        DeleteObject(bitmap);
        DeleteDC(mem_dc);
        ReleaseDC(None, screen_dc);
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

fn crop_rgba(source: &RgbaImage, rect: RectI) -> Option<RgbaImage> {
    if rect.w <= 0 || rect.h <= 0 {
        return None;
    }
    let x = rect.x.max(0) as u32;
    let y = rect.y.max(0) as u32;
    let right = (rect.x + rect.w).min(source.width() as i32).max(0) as u32;
    let bottom = (rect.y + rect.h).min(source.height() as i32).max(0) as u32;
    if right <= x || bottom <= y {
        return None;
    }
    Some(image::imageops::crop_imm(source, x, y, right - x, bottom - y).to_image())
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

fn encode_jpeg_data_url(image: &RgbImage) -> AppResult<String> {
    let mut cursor = Cursor::new(Vec::new());
    let encoder = JpegEncoder::new_with_quality(&mut cursor, 82);
    encoder
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|err| AppError::with_detail("encode_wallpaper", err.to_string()))?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
    ))
}

fn wallpaper_for_monitor(clean: &RgbaImage, origin: RECT, monitor: &MonitorInfo) -> Option<String> {
    let rect = RectI {
        x: monitor.x - origin.left,
        y: monitor.y - origin.top,
        w: monitor.width as i32,
        h: monitor.height as i32,
    };
    let cropped = crop_rgba(clean, rect)?;
    if cropped.width() as i32 != monitor.width as i32
        || cropped.height() as i32 != monitor.height as i32
    {
        return None;
    }
    let rgb = RgbImage::from_fn(cropped.width(), cropped.height(), |x, y| {
        let p = cropped.get_pixel(x, y);
        image::Rgb([p[0], p[1], p[2]])
    });
    encode_jpeg_data_url(&rgb).ok()
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

fn extract_icon(with_icons: &RgbaImage, clean: &RgbaImage, origin: RECT, cell: RectI) -> Option<String> {
    let x = cell.x - origin.left;
    let y = cell.y - origin.top;
    let w = cell.w;
    let h = cell.h;
    if w < 8 || h < 8 {
        return None;
    }
    let left = x.max(0) as u32;
    let top = y.max(0) as u32;
    let right = (x + w).min(with_icons.width() as i32).max(0) as u32;
    let bottom = (y + h).min(with_icons.height() as i32).max(0) as u32;
    if right <= left || bottom <= top {
        return None;
    }

    let cell_w = (right - left) as usize;
    let cell_h = (bottom - top) as usize;
    let mut row_counts = vec![0u32; cell_h];
    let mut diff = vec![0u8; cell_w * cell_h];
    for yy in 0..cell_h {
        for xx in 0..cell_w {
            let a = with_icons.get_pixel(left + xx as u32, top + yy as u32);
            let b = clean.get_pixel(left + xx as u32, top + yy as u32);
            let d = (a[0] as i32 - b[0] as i32)
                .abs()
                .max((a[1] as i32 - b[1] as i32).abs())
                .max((a[2] as i32 - b[2] as i32).abs());
            let d = d.min(255) as u8;
            diff[yy * cell_w + xx] = d;
            if d > 8 {
                row_counts[yy] += 1;
            }
        }
    }

    let mut bands: Vec<(usize, usize)> = Vec::new();
    let mut start: Option<usize> = None;
    for (row, count) in row_counts.iter().enumerate() {
        if *count > 0 && start.is_none() {
            start = Some(row);
        } else if *count == 0 {
            if let Some(s) = start.take() {
                bands.push((s, row.saturating_sub(1)));
            }
        }
    }
    if let Some(s) = start {
        bands.push((s, cell_h.saturating_sub(1)));
    }
    if bands.is_empty() {
        return None;
    }

    // 桌面图标标签是最后一个独立的行带；把它从前面的图标本体中排除。
    let mut icon_bands = bands.clone();
    if icon_bands.len() > 1 {
        if let Some((last_start, last_end)) = icon_bands.last().copied() {
            let last_h = last_end - last_start + 1;
            if last_h <= ((cell_h as f32) * 0.28).max(6.0) as usize
                && last_start as f32 > cell_h as f32 * 0.45
            {
                icon_bands.pop();
            }
        }
    }
    if icon_bands.is_empty() {
        return None;
    }

    let mut min_y = usize::MAX;
    let mut max_y = 0usize;
    let mut min_x = usize::MAX;
    let mut max_x = 0usize;
    for (band_start, band_end) in &icon_bands {
        for yy in *band_start..=*band_end {
            for xx in 0..cell_w {
                if diff[yy * cell_w + xx] > 8 {
                    min_x = min_x.min(xx);
                    max_x = max_x.max(xx);
                    min_y = min_y.min(yy);
                    max_y = max_y.max(yy);
                }
            }
        }
    }
    if min_x == usize::MAX || max_x < min_x || max_y < min_y {
        return None;
    }
    let icon_w = max_x - min_x + 1;
    let icon_h = max_y - min_y + 1;
    if icon_w < 4 || icon_h < 4 || (icon_w * icon_h) as f32 > (cell_w * cell_h) as f32 * 0.9 {
        return None;
    }

    let mut icon = RgbaImage::new(icon_w as u32, icon_h as u32);
    for yy in 0..icon_h {
        for xx in 0..icon_w {
            let src_x = left + (min_x + xx) as u32;
            let src_y = top + (min_y + yy) as u32;
            let a = with_icons.get_pixel(src_x, src_y);
            let d = diff[(min_y + yy) * cell_w + min_x + xx];
            let alpha = if d <= 3 {
                0
            } else {
                ((d as u32 * 8).min(255)) as u8
            };
            icon.put_pixel(xx as u32, yy as u32, image::Rgba([a[0], a[1], a[2], alpha]));
        }
    }
    encode_png_data_url(&icon).ok()
}

pub fn probe() -> ProbeData {
    let Some((_, _, listview)) = find_desktop_windows() else {
        return ProbeData {
            icon_count: 0,
            auto_arrange: false,
            icons_visible: false,
            desktop_found: false,
            permission_denied: false,
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
            detail: None,
        },
        Err(err) => ProbeData {
            icon_count: 0,
            auto_arrange: false,
            icons_visible: unsafe { IsWindowVisible(listview).as_bool() },
            desktop_found: true,
            permission_denied: err.code == "permission_denied",
            detail: Some(err.to_string()),
        },
    }
}

pub fn fingerprint() -> AppResult<String> {
    let desktop = Desktop::open()?;
    desktop.fingerprint()
}

pub fn capture(monitors: &[MonitorInfo]) -> AppResult<Captured> {
    let mut desktop = Desktop::open()?;
    if !desktop.icons_visible() {
        return Err(AppError::new("icons_hidden"));
    }
    if desktop.auto_arrange() {
        return Err(AppError::new("auto_arrange_on"));
    }
    let (count, items, spacing) = desktop.read_items()?;
    if count < 2 {
        return Err(AppError::new("too_few_icons"));
    }
    desktop.clear_selection()?;

    let (capture_hwnd, origin) = capture_bounds(&desktop)?;
    let (with_icons, _) = capture_window(capture_hwnd)?;

    let mut guard = VisibilityGuard::hide(&desktop)?;
    let clean_result = capture_window(capture_hwnd);
    let restore_result = guard.restore();
    let (clean, _) = clean_result?;
    restore_result?;

    let wallpaper = monitors
        .iter()
        .map(|monitor| wallpaper_for_monitor(&clean, origin, monitor))
        .collect::<Vec<_>>();

    let icons = items
        .iter()
        .map(|item| {
            let cell = RectI {
                x: item.x,
                y: item.y,
                w: spacing.0,
                h: spacing.1,
            };
            let monitor = geometry::monitor_for_cell(cell, monitors);
            let image = extract_icon(&with_icons, &clean, origin, cell).unwrap_or_default();
            IconRecord {
                id: item.index,
                name: item.name.clone(),
                image,
                cell,
                monitor,
                tone: tone_for_cell(&clean, origin, cell),
            }
        })
        .collect::<Vec<_>>();

    let fingerprint = fingerprint_of(&items);
    Ok(Captured {
        icons,
        wallpaper,
        fingerprint,
    })
}

pub fn apply_positions(positions: &LayoutPositions) -> AppResult<()> {
    let desktop = Desktop::open()?;
    if !desktop.icons_visible() {
        return Err(AppError::new("icons_hidden"));
    }
    if desktop.auto_arrange() {
        return Err(AppError::new("auto_arrange_on"));
    }
    let count = desktop.count()?;
    for (index, x, y) in positions {
        if (*index as usize) >= count {
            return Err(AppError::with_detail(
                "desktop_changed",
                format!("item {index} no longer exists"),
            ));
        }
        desktop.set_item_position(*index as usize, *x, *y)?;
    }
    std::thread::sleep(Duration::from_millis(160));
    Ok(())
}

pub fn verify_positions(expected: &LayoutPositions) -> AppResult<()> {
    let desktop = Desktop::open()?;
    for (index, x, y) in expected {
        let point = desktop.item_position(*index as usize)?;
        if (point.x - x).abs() > 2 || (point.y - y).abs() > 2 {
            return Err(AppError::with_detail(
                "write_verification_failed",
                format!(
                    "item {index}: expected ({x},{y}), got ({},{})",
                    point.x, point.y
                ),
            ));
        }
    }
    Ok(())
}