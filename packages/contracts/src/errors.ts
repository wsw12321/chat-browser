const definitions = {
  invalid_request: [400, '请求格式不正确，请检查输入。', false],
  invalid_gateway_url: [
    400,
    '请输入有效的公网 HTTPS Gateway 地址，不含账号密码、查询参数或片段。本机开发可使用本机 HTTP 地址。',
    false,
  ],
  invalid_json: [400, '请求必须是有效且无重复字段的 JSON。', false],
  invalid_image: [400, '图片格式或尺寸不符合发送要求。', false],
  invalid_utf8: [400, '文字必须使用有效的 UTF-8 编码。', false],
  unauthorized: [401, 'Key 无效、已过期或已撤销，请重新输入。', false],
  forbidden: [403, '当前 Key 没有执行此操作的权限。', false],
  model_not_allowed: [403, '当前 Key 或网站尚未开放这个模型。', false],
  origin_denied: [403, '请求来源不被允许。', false],
  policy_outdated: [409, '网站策略已更新，请刷新并重新检查附件后再次发送。', false],
  request_too_large: [413, '本轮内容超过限制，请减少附件或上下文。', false],
  rate_limited: [429, '请求过于频繁，请稍后手动重试。', true],
  insufficient_quota: [429, '当前 Key 额度不足，请检查网关额度。', false],
  upstream_error: [502, '上游服务异常，已保留已有内容，可手动重试。', true],
  unsupported_response_item: [502, '模型返回了网站不支持的工具或生成产物，回复已停止。', false],
  stream_invalid: [502, '上游回复格式异常，已有内容已保留。', true],
  response_too_large: [502, '回复超过网站限制，已保留的内容可能不完整。', false],
  interrupted: [502, '连接在回复完成前中断，已有内容已保留。', true],
  response_incomplete: [502, '模型回复未完整结束，已有内容已保留。', true],
  edge_busy: [503, '网站当前繁忙，请稍后手动重试。', true],
  request_spool_busy: [503, '网关当前繁忙，请稍后手动重试。', true],
  upstream_reauthentication_required: [503, '上游账号需要管理员重新登录。', false],
  configuration_error: [503, '服务尚未配置完成，请联系部署人员。', false],
  upstream_timeout: [504, '上游响应超时，已有内容已保留，可手动重试。', true],
  upload_timeout: [408, '发送内容读取超时，请检查连接后手动重试。', true],
  cancelled: [499, '已停止生成。', false],
  not_found: [404, '接口不存在。', false],
  method_not_allowed: [405, '该接口不支持此请求方法。', false],
} as const;
export type ErrorCode = keyof typeof definitions;
export interface SafeError {
  code: ErrorCode;
  message: string;
  requestId: string;
  gatewayRequestId: string | null;
  retryable: boolean;
}
export interface ErrorEnvelope {
  error: SafeError;
}
export class ContractError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(definitions[code][1]);
    this.name = 'ContractError';
  }
}
export function errorStatus(code: ErrorCode): number {
  return definitions[code][0];
}
export function safeError(
  code: ErrorCode,
  requestId = '',
  gatewayRequestId: string | null = null,
): ErrorEnvelope {
  return {
    error: {
      code,
      message: definitions[code][1],
      requestId,
      gatewayRequestId,
      retryable: definitions[code][2],
    },
  };
}
export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && Object.hasOwn(definitions, code);
}
export function mappedGatewayError(status: number, value?: unknown): ErrorCode {
  const code =
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null &&
    'code' in value.error
      ? value.error.code
      : undefined;
  const allowed: readonly unknown[] = [
    'insufficient_quota',
    'model_not_allowed',
    'request_spool_busy',
    'upstream_reauthentication_required',
  ];
  if (allowed.includes(code)) return code as ErrorCode;
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'request_spool_busy';
  if (status === 504) return 'upstream_timeout';
  return 'upstream_error';
}
export function normalizeError(error: unknown): ErrorCode {
  return error instanceof ContractError ? error.code : 'upstream_error';
}
