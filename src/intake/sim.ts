import type { Chat, ChatHandlers, PostOptions } from "./chat.ts";

export interface SimPost {
  id: string;
  channel: string;
  thread: string;
  text: string;
  gateId?: string;
  blocks?: unknown[];
}

/**
 * An in-memory Slack stand-in. Tests drive it with `send`; the CLI simulator
 * wires it to a terminal. Thread ids are small integers so they're easy to type.
 */
export class SimChat implements Chat {
  readonly posts: SimPost[] = [];
  private handlers: ChatHandlers | null = null;
  private seq = 0;
  private postSeq = 0;
  onPost: (p: SimPost, updated: boolean) => void = () => {};

  async start(h: ChatHandlers): Promise<void> {
    this.handlers = h;
  }

  /** A human posts. Omit `thread` for a new top-level message. Returns the thread id. */
  async send(user: string, text: string, opts: { channel?: string; thread?: string } = {}): Promise<string> {
    const ts = String(++this.seq);
    const thread = opts.thread ?? ts;
    await this.handlers!.onMessage({ channel: opts.channel ?? "eng", thread, ts, user, text, isReply: Boolean(opts.thread) });
    return thread;
  }

  async click(gateId: string, user: string, approve: boolean): Promise<void> {
    await this.handlers!.onGateAction({ gateId, user, approve, note: null });
  }

  async post(channel: string, thread: string, text: string, opts: PostOptions = {}): Promise<string> {
    const p: SimPost = { id: `m${++this.postSeq}`, channel, thread, text, gateId: opts.gateId, blocks: opts.blocks };
    this.posts.push(p);
    this.onPost(p, false);
    return p.id;
  }

  async update(_channel: string, messageId: string, text: string, opts: PostOptions = {}): Promise<void> {
    const p = this.posts.find((x) => x.id === messageId);
    if (!p || p.text === text) return;
    p.text = text;
    p.blocks = opts.blocks;
    this.onPost(p, true);
  }

  async stop(): Promise<void> {}

  /** Wait until a post matching `pred` exists. */
  async waitFor(pred: (p: SimPost) => boolean, timeoutMs = 5000): Promise<SimPost> {
    const start = Date.now();
    for (;;) {
      const hit = this.posts.find(pred);
      if (hit) return hit;
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for post; last posts:\n${this.posts.slice(-5).map((p) => p.text).join("\n")}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}
