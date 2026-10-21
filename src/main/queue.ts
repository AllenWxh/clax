/** A small push-to-AsyncIterable bridge for tool stdout and runtime events. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private wake: (() => void) | undefined
  private done = false
  push(item: T) { if (!this.done) { this.items.push(item); this.wake?.() } }
  end() { this.done = true; this.wake?.() }
  async *[Symbol.asyncIterator]() {
    while (!this.done || this.items.length) {
      if (this.items.length) yield this.items.shift()!
      else await new Promise<void>(resolve => { this.wake = resolve })
    }
  }
}
