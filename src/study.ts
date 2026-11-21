/**
 * 开局记忆阶段的倒计时纯函数：UI 只负责把 remaining/fraction 画成圆环和秒数，
 * 并按 flipDelayMs/settleDelayMs 用一次性定时器对齐后端锚点。
 *
 * startedAtMs 是后端给出的“正式开局”时刻；记忆阶段期间它在未来，所以同一
 * 时刻所有窗口算出的剩余量一致。纯函数便于用假时钟测“晚加载窗口”和“跳过”。
 */
export interface StudyTick {
  remainingMs: number;
  /** 0..1，用于 SVG 圆环的 strokeDashoffset。 */
  fraction: number;
  /** 显示用整秒，向上取整。 */
  seconds: number;
  done: boolean;
  /** 距开始翻下的毫秒数；0 = 已在翻下窗口内，应立即起翻。 */
  flipDelayMs: number;
  /** 距移除预览、正式计时的毫秒数；0 = 立即收尾。 */
  settleDelayMs: number;
}

export function studyTick(
  startedAtMs: number,
  studyMs: number,
  flipMs: number,
  now = Date.now(),
): StudyTick {
  const total = Math.max(1, studyMs);
  const remainingMs = Math.max(0, startedAtMs - now);
  const flip = Math.max(0, flipMs);
  return {
    remainingMs,
    fraction: Math.min(1, remainingMs / total),
    seconds: Math.ceil(remainingMs / 1000),
    done: remainingMs <= 0,
    // 起翻与收尾都由锚点反推：不依赖 100ms 心跳的相位，跳过时重新排期即可。
    flipDelayMs: Math.max(0, remainingMs - flip),
    settleDelayMs: remainingMs,
  };
}
