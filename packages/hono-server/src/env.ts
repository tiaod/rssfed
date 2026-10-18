/**
 * 环境变量数值解析的统一入口。
 *
 * 直接写 `parseInt(process.env.X ?? "默认")` 的坑：`X=`（空串）会 parse 出 `NaN`，
 * 而 `??` 只挡 undefined —— 空串会让调度间隔变成 `NaN`（`setInterval(NaN)` 等价 1ms 空转、
 * `isFeedDue` 永远 false 之类），且不报任何错。这里统一兜底并留一个可测的入口。
 */

/**
 * 读整数环境变量：空串 / 非法值 / 越界一律回退 `fallback`。
 *
 * @param min 允许的最小值（默认 1：0 通常不是合法值；确实需要 0 的传 `{ min: 0 }`）
 */
export function envInt(
  name: string,
  fallback: number,
  options: { min?: number, max?: number } = {},
): number {
  const min = options.min ?? 1
  const max = options.max ?? Number.MAX_SAFE_INTEGER
  // 严格整串校验：`parseInt("15m")` 会安静地得到 15 —— 一个「15 分钟」的笔误会被当成
  // 15 毫秒的间隔跑成空转。带单位的写法一律视为非法、回退默认。
  const raw = (process.env[name] ?? "").trim()
  if (!/^[+-]?\d+$/.test(raw)) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback
  return parsed
}

/** 把毫秒数格式化成紧凑可读形式（启动日志用） */
export function formatDuration(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}
