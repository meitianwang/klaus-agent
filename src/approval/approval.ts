// Queue-based approval system

import { generateId } from "../utils/id.js";
import type { Approval, ApprovalConfig, ApprovalRequest, ApprovalResponse } from "./types.js";

interface PendingRequest {
  request: ApprovalRequest;
  resolve: (approved: boolean) => void;
}

interface SharedApprovalState {
  yolo: boolean;
  autoApproveActions: Set<string>;
}

export class ApprovalImpl implements Approval {
  private _shared: SharedApprovalState;
  private _pending = new Map<string, PendingRequest>();
  private _queue: ApprovalRequest[] = [];
  private _waiters: ((req: ApprovalRequest) => void)[] = [];

  constructor(config?: ApprovalConfig, sharedState?: SharedApprovalState) {
    this._shared = sharedState ?? {
      yolo: config?.yolo ?? false,
      autoApproveActions: new Set(config?.autoApproveActions ?? []),
    };
  }

  async request(sender: string, action: string, description: string, toolCallId: string): Promise<boolean> {
    if (this._shared.yolo) return true;
    if (this._shared.autoApproveActions.has(action)) return true;

    const req: ApprovalRequest = {
      id: generateId(),
      toolCallId,
      sender,
      action,
      description,
    };

    return new Promise<boolean>((resolve) => {
      this._pending.set(req.id, { request: req, resolve });

      // Deliver to waiter or queue
      const waiter = this._waiters.shift();
      if (waiter) {
        waiter(req);
      } else {
        this._queue.push(req);
      }
    });
  }

  async fetchRequest(): Promise<ApprovalRequest> {
    const queued = this._queue.shift();
    if (queued) return queued;

    return new Promise<ApprovalRequest>((resolve, reject) => {
      const waiter = (req: ApprovalRequest) => resolve(req);
      (waiter as any)._reject = reject;
      this._waiters.push(waiter);
    });
  }

  /** Cancel all pending waiters (e.g., on agent dispose) */
  cancelPendingWaiters(): void {
    for (const waiter of this._waiters) {
      const reject = (waiter as any)._reject;
      if (reject) reject(new Error("Approval cancelled"));
    }
    this._waiters = [];
  }

  resolve(requestId: string, response: ApprovalResponse): void {
    const pending = this._pending.get(requestId);
    if (!pending) return;

    this._pending.delete(requestId);

    if (response === "approve_for_session") {
      this._shared.autoApproveActions.add(pending.request.action);
      pending.resolve(true);
    } else {
      pending.resolve(response === "approve");
    }
  }

  setYolo(yolo: boolean): void {
    this._shared.yolo = yolo;
  }

  isYolo(): boolean {
    return this._shared.yolo;
  }

  get autoApproveActions(): Set<string> {
    return this._shared.autoApproveActions;
  }

  share(): Approval {
    // Shared state (yolo, autoApproveActions) via same reference, independent queue
    return new ApprovalImpl(undefined, this._shared);
  }

  dispose(): void {
    this.cancelPendingWaiters();
    // Reject all pending approval requests so blocked tools don't hang forever
    for (const [id, pending] of this._pending) {
      pending.resolve(false);
    }
    this._pending.clear();
    this._queue = [];
  }
}
