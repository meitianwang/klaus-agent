// Wire — typed async event channel with optional replay buffer

import { generateId } from "../utils/id.js";
import type { WireMessage, WireSubscriber, WireSubscription } from "./types.js";

export interface WireOptions {
  /** Max messages to buffer for replay to late subscribers. 0 = no buffering. */
  bufferSize?: number;
}

export class Wire {
  private _subscribers = new Set<WireSubscriber>();
  private _buffer: WireMessage[] = [];
  private _bufferSize: number;

  constructor(options?: WireOptions) {
    this._bufferSize = options?.bufferSize ?? 0;
  }

  publish<T>(type: string, payload: T): WireMessage<T> {
    const message: WireMessage<T> = {
      id: generateId(),
      timestamp: Date.now(),
      type,
      payload,
    };

    if (this._bufferSize > 0) {
      this._buffer.push(message);
      if (this._buffer.length > this._bufferSize) {
        this._buffer.shift();
      }
    }

    for (const fn of this._subscribers) {
      try {
        fn(message);
      } catch {
        // Subscriber errors should not break the publisher
      }
    }

    return message;
  }

  subscribe(fn: WireSubscriber, options?: { replay?: boolean }): WireSubscription {
    if (options?.replay) {
      for (const msg of this._buffer) {
        try { fn(msg); } catch {}
      }
    }
    this._subscribers.add(fn);
    return { unsubscribe: () => this._subscribers.delete(fn) };
  }

  on<T>(type: string, fn: (message: WireMessage<T>) => void, options?: { replay?: boolean }): WireSubscription {
    const filtered: WireSubscriber = (msg) => {
      if (msg.type === type) fn(msg as WireMessage<T>);
    };
    if (options?.replay) {
      for (const msg of this._buffer) {
        if (msg.type === type) {
          try { fn(msg as WireMessage<T>); } catch {}
        }
      }
    }
    this._subscribers.add(filtered);
    return { unsubscribe: () => this._subscribers.delete(filtered) };
  }

  getBuffer(): readonly WireMessage[] {
    return this._buffer;
  }

  dispose(): void {
    this._subscribers.clear();
    this._buffer = [];
  }
}
