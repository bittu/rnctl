import type { EventBus, EventListener } from '@rnctl/sdk';

export class TypedEventBus implements EventBus {
  private readonly listeners = new Map<string, Set<EventListener>>();

  on<T>(topic: string, listener: EventListener<T>): () => void {
    const set = this.listeners.get(topic) ?? new Set<EventListener>();
    set.add(listener as EventListener);
    this.listeners.set(topic, set);
    return () => this.off(topic, listener);
  }

  off<T>(topic: string, listener: EventListener<T>): void {
    this.listeners.get(topic)?.delete(listener as EventListener);
  }

  async emit<T>(topic: string, payload: T): Promise<void> {
    const set = this.listeners.get(topic);
    if (!set) return;
    for (const listener of [...set]) {
      (listener as EventListener<T>)(payload);
    }
  }
}
