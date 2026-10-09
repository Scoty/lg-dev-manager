import type { RpcErrorBody } from '@lgdm/protocol';

export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }

  toBody(): RpcErrorBody {
    return { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) };
  }
}
