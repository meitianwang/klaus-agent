// Wire — typed async event channel types

export interface WireMessage<T = unknown> {
  id: string;
  timestamp: number;
  type: string;
  payload: T;
}

export type WireSubscriber<T = unknown> = (message: WireMessage<T>) => void;

export interface WireSubscription {
  unsubscribe(): void;
}
