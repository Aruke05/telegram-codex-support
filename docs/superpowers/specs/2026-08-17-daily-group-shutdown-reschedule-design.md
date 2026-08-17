# 每日群关闭改时重排设计

## 目标

管理员修改每日关闭时间后，新时间在当天仍可触发，不再被旧时间当天已经执行的记录拦截。

## 设计

- `ModelConfigService.updateSettings()` 比较保存前后的 `dailyGroupShutdownTime`。
- 时间实际变化时，把 `last_run_local_date` 清空；保留 `last_run_at` 和 `last_disabled_count` 作为最近一次执行审计。
- 时间未变化时不清空，避免保存开关或其他运行配置导致同一计划重复执行。
- worker 的原子关闭、上海时区、停机补执行和同一计划同日幂等逻辑保持不变。

## 验证

- 回归测试证明改时会清空当天执行日期。
- 回归测试证明保存相同时间不会清空当天执行日期。
- 运行相关测试、全量测试、类型检查和生产构建后部署 Linux systemd 服务。
