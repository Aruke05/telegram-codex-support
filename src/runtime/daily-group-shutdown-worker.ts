import type { RuntimeDatabase } from "./database.js"

type ScheduleRow = {
  enabled: number
  local_time: string
  timezone: "Asia/Shanghai"
  last_run_local_date: string | null
}

export type DailyGroupShutdownResult = {
  executed: boolean
  disabledCount: number
}

const shanghaiFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

function shanghaiDateTime(now: Date): { localDate: string; localTime: string } {
  const parts = Object.fromEntries(
    shanghaiFormatter.formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  )
  return {
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}`,
  }
}

function due(schedule: ScheduleRow, localDate: string, localTime: string): boolean {
  return schedule.enabled === 1
    && schedule.last_run_local_date !== localDate
    && localTime >= schedule.local_time
}

export class DailyGroupShutdownWorker {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly database: RuntimeDatabase,
    private readonly intervalMs = 60_000,
  ) {}

  runDue(now = new Date()): DailyGroupShutdownResult {
    const { localDate, localTime } = shanghaiDateTime(now)
    const schedule = this.readSchedule()
    if (!due(schedule, localDate, localTime)) return { executed: false, disabledCount: 0 }

    return this.database.transaction(() => {
      const current = this.readSchedule()
      if (!due(current, localDate, localTime)) return { executed: false, disabledCount: 0 }
      const timestamp = now.toISOString()
      const disabled = this.database.prepare(
        "UPDATE telegram_groups SET enabled=0,updated_at=? WHERE enabled=1",
      ).run(timestamp)
      const disabledCount = Number(disabled.changes)
      this.database.prepare(`UPDATE daily_group_shutdown_schedule SET
        last_run_local_date=?,last_run_at=?,last_disabled_count=?,updated_at=? WHERE id=1`).run(
        localDate,
        timestamp,
        disabledCount,
        timestamp,
      )
      return { executed: true, disabledCount }
    })
  }

  start(): void {
    if (this.timer) return
    this.tick()
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private readSchedule(): ScheduleRow {
    const schedule = this.database.prepare(`SELECT enabled,local_time,timezone,last_run_local_date
      FROM daily_group_shutdown_schedule WHERE id=1`).get() as ScheduleRow | undefined
    if (!schedule) throw new Error("每日全群关闭计划不存在")
    return schedule
  }

  private tick(): void {
    try {
      this.runDue()
    } catch {
      process.stderr.write(`${JSON.stringify({
        time: new Date().toISOString(),
        level: "warn",
        component: "daily_group_shutdown",
        message: "每日全群关闭任务执行失败",
      })}\n`)
    }
  }
}
