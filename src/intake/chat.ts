import type { IncomingMessage } from "../types.ts";

export interface GateAction {
  gateId: string;
  approve: boolean;
  user: string;
  note: string | null;
}

export interface ChatHandlers {
  onMessage(msg: IncomingMessage): Promise<void> | void;
  onGateAction(action: GateAction): Promise<void> | void;
  /** `@gaffer kill`, `@gaffer budget`, ... in a thread or channel. */
  onCommand(cmd: { name: string; args: string[]; channel: string; thread: string; user: string }): Promise<void> | void;
}

export interface PostOptions {
  /** Render approve / reject buttons for this gate. */
  gateId?: string;
  /** Rich layout (Slack Block Kit). `text` stays the notification and fallback. */
  blocks?: unknown[];
}

/** A chat surface. Slack is the real one; the simulator implements the same contract. */
export interface Chat {
  start(handlers: ChatHandlers): Promise<void>;
  /** Post into a thread; returns an id usable with `update`. */
  post(channel: string, thread: string, text: string, opts?: PostOptions): Promise<string>;
  update(channel: string, messageId: string, text: string, opts?: PostOptions): Promise<void>;
  stop(): Promise<void>;
}

const COMMANDS = new Set(["kill", "budget", "status", "approve", "reject"]);

/** Parse "@gaffer kill" / "!gaffer budget" style commands. Returns null for ordinary text. */
export function parseCommand(text: string): { name: string; args: string[] } | null {
  const m = text.trim().match(/^(?:<@[A-Z0-9]+>|[@!]gaffer)\s+(\w+)(.*)$/i);
  if (!m || !COMMANDS.has(m[1].toLowerCase())) return null;
  return { name: m[1].toLowerCase(), args: m[2].trim().split(/\s+/).filter(Boolean) };
}

/**
 * Escape text that came from a requester or an agent before it goes into a
 * Slack message, so it can't add mentions, links or formatting controls.
 * Slack's mrkdwn treats only &, < and > as control characters.
 */
export function slackText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Defuse broadcast mentions (<!channel>, <!here>, <!everyone>, <!subteam^…>). Gaffer never sends them itself. */
export function noBroadcast(s: string): string {
  return s.replace(/<!/g, "&lt;!");
}
