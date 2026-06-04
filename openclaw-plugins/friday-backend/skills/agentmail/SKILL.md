# AgentMail

Use this skill when the user wants the agent to work with its own email inbox inside Friday.

## What it is for

- Creating or linking the agent mailbox
- Reading incoming letters
- Sending outgoing email
- Receiving legitimate verification emails for flows the user controls

## Safety boundary

- Do not help bypass protections, anti-bot systems, account security, or site verification rules
- It is okay to read a verification email that arrived in the agent inbox and relay its code to the user for a legitimate flow

## Friday workflow

1. Open the **Mail** tab in Friday.
2. Check whether the agent email address and `Inbox ID` are already configured.
3. If the inbox is not configured yet, ask the user for the real AgentMail inbox ID or explain how to finish setup.
4. Use the mailbox shown in Friday as the source of truth for the agent address.

## Live AgentMail setup

Install the official AgentMail skill with:

```bash
npx clawhub@latest install agentmail
```

Then add the AgentMail API key to the OpenClaw environment and paste the real inbox identifier into Friday's **Mail** tab.

## Response style

- Keep mail actions explicit: who sends, who receives, subject, and what happened
- When summarizing incoming mail, include the sender, subject, and the key action item
- When a verification letter is found, provide only the code or link the user needs, not extra speculation
