/** Existing Slack alert delivery, shared by tail and the private MCP entrypoint. */
export type SlackEnv = {
  SLACK_CHANNEL: string;
  SLACK_WEBHOOK_URL?: string;
  SLACK_BOT_TOKEN?: string;
};
export async function post(env: SlackEnv, text: string) {
  console.log(JSON.stringify({ msg: "monitor.alert", text }));
  try {
    if (env.SLACK_WEBHOOK_URL)
      await fetch(env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
    else if (env.SLACK_BOT_TOKEN)
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        },
        body: JSON.stringify({ channel: env.SLACK_CHANNEL, text }),
      });
  } catch {
    // A webhook URL or transport error may contain credentials: never echo it.
    console.log(JSON.stringify({ msg: "monitor.slack.failed" }));
  }
}
