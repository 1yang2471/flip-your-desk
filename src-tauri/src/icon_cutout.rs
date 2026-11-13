//! 从桌面截图里把图标抠出来。
//!
//! 背景：Explorer 把桌面图标以 `observed = icon·α + bg·(1-α)` 合成到壁纸���。
//! 我们只有合成结果 `observed` 与纯壁纸 `bg` 两个观测，未知量是图标原色与 α，
//! 单靠一个方程解不出来（之前用"反预乘"硬解，把图标内部的立体渐变误当成
//! 透明度证据，颜色被整体推�� 0/255，发白发灰）。
//!
//! 正确做法是区分图标的**内部**与**边缘**：
//! - 内部像素：α≈1，此时 observed 就是图标原色，直接用，颜色分毫不差。
//! - 边缘像素：抗锯齿过渡带，才需要解 α。
//!
//! 内部用拓扑判定而不是阈值：从"实心种子"（与壁纸差异大的像素）在"图标影响区"
//! 内做洪水填充，能覆盖到图标内部。半透明设计的图标（如渐变 logo）其内部
//! 差异并不一定大，但只要与实心部分连通，仍会被判定为内部，颜色得以保留。

use image::{Rgba, RgbaImage};

/// 判定"图标影响区"的最小差异：低于此值视为壁纸。行带检测也用同一个值。
pub const INFLUENCE_THRESHOLD: i32 = 8;
/// 低于此最大差异认为格内没有图标。
const MIN_MAX_DIFF: i32 = 24;
/// bbox 在内部像素范围外扩的像素数：保留抗锯齿边缘，避免图标被裁小一圈。
const EDGE_PAD: usize = 2;

/// 单格抠图结果。
pub struct Cutout {
    /// 抠出的图标（RGBA，含 alpha）。
    pub image: RgbaImage,
    /// image 左上角在输入图中的坐标（bbox 外扩后）。
    pub origin_x: u32,
    pub origin_y: u32,
}

/// 抠一个图标。`with_icons` 是带图标的画面，`clean` 是同位置无图标的画面。
///
/// 两个图像必须是同尺寸同原点（同一块屏幕区域的两次截图）。
pub fn cutout(with_icons: &RgbaImage, clean: &RgbaImage) -> Option<Cutout> {
    let (w, h) = (with_icons.width() as usize, with_icons.height() as usize);
    if w == 0 || h == 0 || clean.width() as usize != w || clean.height() as usize != h {
        return None;
    }

    // 1) 逐像素差异：图标有多大影响。
    let mut diff = vec![0i32; w * h];
    let mut max_diff = 0i32;
    for y in 0..h {
        for x in 0..w {
            let o = with_icons.get_pixel(x as u32, y as u32);
            let b = clean.get_pixel(x as u32, y as u32);
            let d = (o[0] as i32 - b[0] as i32)
                .abs()
                .max((o[1] as i32 - b[1] as i32).abs())
                .max((o[2] as i32 - b[2] as i32).abs())
                .min(255) as i32;
            diff[y * w + x] = d;
            max_diff = max_diff.max(d);
        }
    }
    if max_diff < MIN_MAX_DIFF {
        return None;
    }

    // 2) 图标影响区的连通分量：图标内部的深色像素可能与暗壁纸几乎同色，
    //    会把影响区切成好几块（localsend_app 的青色环、FlClash 的描边都是）。
    //    因此保留所有足够大的块，而不是只取最大块；小于 16px 的碎点视为噪声。
    let mut is_influence = vec![false; w * h];
    for (i, &d) in diff.iter().enumerate() {
        if d > INFLUENCE_THRESHOLD {
            is_influence[i] = true;
        }
    }
    let mut component = vec![-1i32; w * h];
    let mut sizes: Vec<usize> = Vec::new();
    let mut queue: Vec<usize> = Vec::new();
    for start in 0..w * h {
        if !is_influence[start] || component[start] >= 0 {
            continue;
        }
        let id = sizes.len() as i32;
        let mut size = 0usize;
        component[start] = id;
        queue.push(start);
        while let Some(i) = queue.pop() {
            size += 1;
            let (x, y) = (i % w, i / w);
            for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1)] {
                let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                    continue;
                }
                let ni = ny as usize * w + nx as usize;
                if is_influence[ni] && component[ni] < 0 {
                    component[ni] = id;
                    queue.push(ni);
                }
            }
        }
        sizes.push(size);
    }
    if !sizes.iter().any(|&size| size >= 16) {
        return None;
    }

    // 3) 所有足够大的连通块内的影响像素都是图标本体：
    //    桌面图标整局隐藏、壁纸静止，直接把观测到的合成色作为不透明像素输出，
    //    贴回干净壁纸即可逐像素复现真实桌面。不再试图从单次观测里同时解
    //    α 与图标原色（那本来就是欠定问题，任何阈值都会误伤渐变/半透明设计）。
    let mut interior = vec![false; w * h];
    for (i, &d) in diff.iter().enumerate() {
        let id = component[i];
        if id >= 0 && sizes[id as usize] >= 16 && d > INFLUENCE_THRESHOLD {
            interior[i] = true;
        }
    }

    // 4) 求 bbox（只含内部像素，避免把抗锯齿碎点算进来把框撑大）。
    let mut min_x = usize::MAX;
    let mut min_y = usize::MAX;
    let mut max_x = 0usize;
    let mut max_y = 0usize;
    let mut has_interior = false;
    for y in 0..h {
        for x in 0..w {
            if !interior[y * w + x] {
                continue;
            }
            has_interior = true;
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
    }
    if !has_interior || max_x < min_x || max_y < min_y {
        return None;
    }
    // 外扩 EDGE_PAD 像素，把最外圈抗锯齿过渡带也纳入输出（超界则裁到图内）。
    let min_x = min_x.saturating_sub(EDGE_PAD);
    let min_y = min_y.saturating_sub(EDGE_PAD);
    let max_x = (max_x + EDGE_PAD).min(w - 1);
    let max_y = (max_y + EDGE_PAD).min(h - 1);
    let icon_w = max_x - min_x + 1;
    let icon_h = max_y - min_y + 1;
    if icon_w < 4 || icon_h < 4 {
        return None;
    }

    // 5) 生成图像：内部取原色（observed 就是原色）；边缘解出 α 与原色。
    let mut image = RgbaImage::new(icon_w as u32, icon_h as u32);
    for y in 0..icon_h {
        for x in 0..icon_w {
            let src = (min_y + y) * w + (min_x + x);
            let observed = *with_icons.get_pixel((min_x + x) as u32, (min_y + y) as u32);
            let background = *clean.get_pixel((min_x + x) as u32, (min_y + y) as u32);
            let pixel = if interior[src] {
                // 不透明像素：observed 即原色。
                observed
            } else {
                // 边缘像素：拿邻近实心像素的原色当参考，解 observed = icon·α + bg·(1-α)。
                // 逐通道求 α（取差异最大通道的解），再反解出该像素的原色，
                // 这样半透明图标也能还原出正确颜色，而不是抄邻居色。
                match nearest_solid(&interior, w, h, min_x + x, min_y + y) {
                    Some((sx, sy)) => {
                        let solid = *with_icons.get_pixel(sx as u32, sy as u32);
                        let solid_bg = *clean.get_pixel(sx as u32, sy as u32);
                        let mut alpha = 0.0f64;
                        let mut best = 0i32;
                        for c in 0..3 {
                            let denom = solid[c] as i32 - solid_bg[c] as i32;
                            if denom.abs() < 24 {
                                continue;
                            }
                            let numer = observed[c] as i32 - background[c] as i32;
                            let a = (numer as f64 / denom as f64).clamp(0.0, 1.0);
                            if numer.abs() > best {
                                best = numer.abs();
                                alpha = a;
                            }
                        }
                        let alpha = (alpha * 255.0).round().clamp(0.0, 255.0) as u8;
                        // 反解原色：icon = (observed - bg·(1-α)) / α
                        let recover = |c: usize| -> u8 {
                            if alpha == 0 {
                                return solid[c];
                            }
                            let a = alpha as f64 / 255.0;
                            let value = (observed[c] as f64 - background[c] as f64 * (1.0 - a)) / a;
                            value.clamp(0.0, 255.0).round() as u8
                        };
                        Rgba([recover(0), recover(1), recover(2), alpha])
                    }
                    None => Rgba([observed[0], observed[1], observed[2], 0]),
                }
            };
            image.put_pixel(x as u32, y as u32, pixel);
        }
    }
    Some(Cutout {
        image,
        origin_x: min_x as u32,
        origin_y: min_y as u32,
    })
}

/// 找最近的实心像素（BFS 距离）。
fn nearest_solid(
    interior: &[bool],
    w: usize,
    h: usize,
    x: usize,
    y: usize,
) -> Option<(usize, usize)> {
    if x >= w || y >= h {
        return None;
    }
    if interior[y * w + x] {
        return Some((x, y));
    }
    let mut seen = vec![false; w * h];
    let mut queue: std::collections::VecDeque<(usize, usize)> = std::collections::VecDeque::new();
    queue.push_back((x, y));
    seen[y * w + x] = true;
    while let Some((cx, cy)) = queue.pop_front() {
        for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1)] {
            let (nx, ny) = (cx as i32 + dx, cy as i32 + dy);
            if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                continue;
            }
            let (nx, ny) = (nx as usize, ny as usize);
            let ni = ny * w + nx;
            if seen[ni] {
                continue;
            }
            seen[ni] = true;
            if interior[ni] {
                return Some((nx, ny));
            }
            queue.push_back((nx, ny));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一张图：壁纸全黑，图标是一个纯色方块。
    fn scene(bg: [u8; 3], icon: [u8; 3], alpha: u8) -> (RgbaImage, RgbaImage) {
        let (w, h) = (20u32, 20u32);
        let mut clean = RgbaImage::new(w, h);
        let mut with = RgbaImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                clean.put_pixel(x, y, Rgba([bg[0], bg[1], bg[2], 255]));
                let inside = x >= 6 && x < 14 && y >= 6 && y < 14;
                if inside {
                    // 合成：icon·α + bg·(1-α)
                    let a = alpha as u32;
                    let mix = |i: u8, b: u8| ((i as u32 * a + b as u32 * (255 - a)) / 255) as u8;
                    with.put_pixel(
                        x,
                        y,
                        Rgba([
                            mix(icon[0], bg[0]),
                            mix(icon[1], bg[1]),
                            mix(icon[2], bg[2]),
                            255,
                        ]),
                    );
                } else {
                    with.put_pixel(x, y, Rgba([bg[0], bg[1], bg[2], 255]));
                }
            }
        }
        (with, clean)
    }

    #[test]
    fn opaque_icon_keeps_exact_color() {
        // 不透明图标：抠出来的颜色必须与原色分毫不差。
        let (with, clean) = scene([10, 12, 14], [51, 204, 223], 255);
        let cut = cutout(&with, &clean).expect("cutout");
        let px = cut.image.get_pixel(4, 4);
        assert_eq!(
            [px[0], px[1], px[2]],
            [51, 204, 223],
            "icon color must be preserved"
        );
        assert_eq!(px[3], 255);
    }

    #[test]
    fn semi_transparent_icon_keeps_its_desktop_appearance() {
        // 半透明图标：单次观测无法同时恢复原色与 alpha（不可解），
        // 因此保留它在桌面上的实际观感（合成结果），而不是猜一个原色。
        let (with, clean) = scene([10, 12, 14], [200, 200, 200], 128);
        let cut = cutout(&with, &clean).expect("cutout");
        let px = cut.image.get_pixel(4, 4);
        let expected = with.get_pixel(10, 10);
        assert_eq!(
            [px[0], px[1], px[2]],
            [expected[0], expected[1], expected[2]]
        );
        assert_eq!(px[3], 255);
    }

    #[test]
    fn bbox_covers_icon_without_wallpaper() {
        let (with, clean) = scene([0, 0, 0], [255, 255, 255], 255);
        let cut = cutout(&with, &clean).expect("cutout");
        // 内部 8×8，外扩 EDGE_PAD(2) 后为 12×12，原点在 (4,4)。
        assert_eq!(cut.image.width(), 12);
        assert_eq!(cut.image.height(), 12);
        assert_eq!((cut.origin_x, cut.origin_y), (4, 4));
    }

    #[test]
    fn empty_cell_has_no_cutout() {
        let clean = RgbaImage::new(20, 20);
        let with = clean.clone();
        assert!(cutout(&with, &clean).is_none());
    }

    #[test]
    fn edge_pixels_keep_alpha() {
        // 外扩的边缘像素必须带 alpha 过渡（而不是被裁掉）：图标左缘 x=6 的
        // 半透明像素在输出中应保留（alpha < 255）。
        let (with, clean) = scene([0, 0, 0], [255, 255, 255], 255);
        let cut = cutout(&with, &clean).expect("cutout");
        // 输出 (2,2) → 源 (6,6) 是内部；输出 (0,0) → 源 (4,4) 是纯背景。
        assert_eq!(cut.image.get_pixel(0, 0)[3], 0);
        assert_eq!(cut.image.get_pixel(2, 2)[3], 255);
    }

    #[test]
    fn bright_badge_does_not_turn_medium_tone_logo_transparent() {
        // 反例（真机 localsend_app）：壁纸近黑，青色 logo 差异 128，
        // 左下角白色快捷方式箭头差异 255。若按格内最大差异取实心比例，
        // 整个 logo 会被判为半透明边缘、只抠出箭头。
        let mut clean = RgbaImage::new(32, 32);
        let mut with = clean.clone();
        for y in 0..32 {
            for x in 0..32 {
                clean.put_pixel(x, y, Rgba([0, 0, 0, 255]));
            }
        }
        for y in 4..22 {
            for x in 4..22 {
                with.put_pixel(x, y, Rgba([0, 128, 128, 255]));
            }
        }
        for y in 16..22 {
            for x in 2..8 {
                with.put_pixel(x, y, Rgba([255, 255, 255, 255]));
            }
        }
        let cut = cutout(&with, &clean).expect("cutout");
        // logo 中心必须不透明且保持原色。
        let cx = 12 - cut.origin_x;
        let cy = 12 - cut.origin_y;
        let px = cut.image.get_pixel(cx, cy);
        assert_eq!(px[3], 255, "logo body must be opaque");
        assert_eq!([px[0], px[1], px[2]], [0, 128, 128]);
    }

    #[test]
    fn gradient_icon_is_not_treated_as_transparency() {
        // 图标自身带立体渐变（中心亮、边缘暗）：不应被当成半透明而压暗。
        let (mut with, mut clean) = scene([0, 0, 0], [255, 255, 255], 255);
        for y in 6..14u32 {
            for x in 6..14u32 {
                let v = 120 + (x as u32 - 6) * 18;
                let v = v.min(255) as u8;
                with.put_pixel(x, y, Rgba([v, v, v, 255]));
            }
        }
        clean.put_pixel(7, 7, Rgba([0, 0, 0, 255]));
        let cut = cutout(&with, &clean).expect("cutout");
        let px = cut.image.get_pixel(1, 1);
        assert!(px[0] >= 120, "gradient got washed out: {:?}", px);
    }
}
