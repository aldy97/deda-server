/** Prisma 错误码：串行化冲突或死锁导致事务被中止（Postgres 40001/40P01） */
const SERIALIZABLE_CONFLICT_CODE = "P2034";

export interface SerializableRetryOptions {
  /** 总尝试次数（含首次），默认 3 */
  maxAttempts?: number;
  /** 退避基数毫秒，实际等待为 baseDelayMs * attempt + 随机抖动，默认 50 */
  baseDelayMs?: number;
}

function isSerializableConflict(error: unknown): boolean {
  return (
    (error as { code?: string } | null | undefined)?.code ===
    SERIALIZABLE_CONFLICT_CODE
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializable 事务自动重试。
 *
 * Postgres 在 Serializable 隔离下遇并发写冲突会主动 abort 事务（P2034），
 * 这是协议内的预期行为，调用方必须重试而非向上抛 500。
 * 仅重试 P2034；业务异常与其他 Prisma 错误原样抛出。
 *
 * 被包裹的闭包必须幂等（重试会整体重跑事务体）。
 */
export async function withSerializableRetry<T>(
  fn: () => Promise<T>,
  options?: SerializableRetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 50;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isSerializableConflict(error) || attempt === maxAttempts) {
        throw error;
      }
      await sleep(
        baseDelayMs * attempt + Math.floor(Math.random() * baseDelayMs),
      );
    }
  }
  throw lastError;
}
