import type { Chat, ChatHandlers, PostOptions } from "./chat.ts";

/**
 * Slack via Socket Mode (no public URL needed). Requires SLACK_BOT_TOKEN
 * (xoxb-, scopes: channels:history, groups:history, chat:write) and
 * SLACK_APP_TOKEN (xapp-, connections:write). Invite the bot to each watched channel.
 */
export class SlackChat implements Chat {
  private app: any;

  async start(h: ChatHandlers): Promise<void> {
    const { App } = await import("@slack/bolt").catch(() => {
      throw new Error("Slack support needs @slack/bolt: npm install @slack/bolt");
    });
    const token = process.env.SLACK_BOT_TOKEN;
    const appToken = process.env.SLACK_APP_TOKEN;
    if (!token || !appToken) throw new Error("Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN");
    this.app = new App({ token, appToken, socketMode: true });

    this.app.message(async ({ message }: any) => {
      // Ignore edits, joins, and every bot, including ourselves.
      if (message.subtype || message.bot_id || !message.user) return;
      const thread = message.thread_ts ?? message.ts;
      await h.onMessage({
        channel: message.channel,
        thread,
        ts: message.ts,
        user: message.user,
        text: message.text ?? "",
        isReply: Boolean(message.thread_ts && message.thread_ts !== message.ts),
      });
    });

    this.app.action(/^gate_(approve|reject)$/, async ({ ack, body, action }: any) => {
      await ack();
      await h.onGateAction({ gateId: action.value, approve: action.action_id === "gate_approve", user: body.user.id, note: null });
    });

    await this.app.start();
  }

  async post(channel: string, thread: string, text: string, opts: PostOptions = {}): Promise<string> {
    const res = await this.app.client.chat.postMessage({ channel, thread_ts: thread || undefined, text, blocks: slackBlocks(text, opts) });
    return res.ts;
  }

  async update(channel: string, messageId: string, text: string, opts: PostOptions = {}): Promise<void> {
    await this.app.client.chat.update({ channel, ts: messageId, text, blocks: slackBlocks(text, opts) });
  }

  async stop(): Promise<void> {
    await this.app?.stop();
  }
}

/** Block Kit for a message: the caller's layout (or the text as a section), plus approve/reject for a gate. */
export function slackBlocks(text: string, opts: PostOptions): unknown[] | undefined {
  if (!opts.blocks && !opts.gateId) return undefined;
  const blocks: unknown[] = [...(opts.blocks ?? [{ type: "section", text: { type: "mrkdwn", text } }])];
  if (opts.gateId) {
    blocks.push(
      {
        type: "actions",
        elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: "gate_approve", value: opts.gateId },
          { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: "gate_reject", value: opts.gateId },
        ],
      },
      { type: "context", elements: [{ type: "mrkdwn", text: `Gate \`${opts.gateId}\` · to approve with a note for the agent, reply \`@gaffer approve ${opts.gateId} <note>\`` }] },
    );
  }
  return blocks;
}
