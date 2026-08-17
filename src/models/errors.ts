export type ModelExecutionErrorCode =
  | "model_disabled"
  | "credentials_missing"
  | "authentication_failed"
  | "quota_exhausted"
  | "rate_limited"
  | "model_not_found"
  | "parameter_unsupported"
  | "structured_output_invalid"
  | "tool_loop_exhausted"
  | "provider_timeout"
  | "provider_unavailable"

export class ModelExecutionError extends Error {
  constructor(
    readonly code: ModelExecutionErrorCode,
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message)
    this.name = "ModelExecutionError"
  }
}

export function providerHttpError(status: number): ModelExecutionError {
  if (status === 401 || status === 403) return new ModelExecutionError("authentication_failed", "模型厂商鉴权失败", status)
  if (status === 404) return new ModelExecutionError("model_not_found", "模型不存在或不可用", status)
  if (status === 429) return new ModelExecutionError("rate_limited", "模型厂商请求过于频繁", status)
  if (status === 402) return new ModelExecutionError("quota_exhausted", "模型厂商额度不足", status)
  if (status === 400 || status === 422) return new ModelExecutionError("parameter_unsupported", "模型参数不被厂商支持", status)
  if (status === 408 || status === 504) return new ModelExecutionError("provider_timeout", "模型厂商请求超时", status)
  return new ModelExecutionError("provider_unavailable", "模型厂商暂时不可用", status)
}
