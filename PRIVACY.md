# Privacy in NeverQuestAlone

NeverQuestAlone runs on your computer and talks to the AI company you choose. There’s no NeverQuestAlone server, so we never receive your messages, your game data or your key.

## The short version

- **We get nothing from the app.** No account, no server, no analytics, no crash reports. The website (neverquestalone.com) counts visits with Vercel Web Analytics: no cookies, and nothing that identifies you.
- **Your messages go only to the AI you pick**, with your own character’s game data (on by default).
- **Your name, realm and guild stay out** unless you turn them on. Other players’ names from the game are swapped for stand-ins.
- **Other players’ chat is never read.**
- **Your key and your chat history stay on your computer.** The key goes only to its own AI company. With a ChatGPT plan, your sign-in is kept the same way and goes only to OpenAI.
- **You can see exactly what was sent:** the app’s Last request page shows the whole last request for each chat, with your key hidden.

## Everything that leaves your computer

“Your AI company” means the company behind the AI you picked: Anthropic, OpenAI, xAI or Google, or the service you connected with Other (such as OpenRouter, Groq or Together). A model on your own computer (Other at a `localhost` address, such as Ollama or LM Studio) keeps what you ask on your computer, unless you pick one of Ollama’s cloud models.

| What | Default | Where you change it |
|---|---|---|
| **What you type** | Sent to your AI company | — |
| **Your character’s name, realm and guild** | **Not sent.** The AI sees “your character” instead | Your data page: “Character name” (off) |
| **Your character’s game data:** level, class, race, zone and position, money, experience, talents, professions, and your quest log (each quest’s ID and title, and which are ready to turn in) | **Sent** with each message (game data is on by default) | Your data page: “Game data”; or for one message, the Game Data box above the window’s message box |
| **Check-in data:** quest objectives and levels, where your quests’ chains lead and the chains you could start next, gear and item levels, nearby points of interest | Sent only if you turn check-ins on (they’re **off** by default) | Settings page: “Check-ins” (off) |
| **Items you link** | The item’s tooltip text and, for gear, the matching piece you wear: its name, item level and tooltip. For now, that can include a line another addon adds to the tooltip, such as a bag addon naming your other characters | — |
| **Other players’ names from the game:** your target, players you shift-click, “Made by” lines on items | **Swapped** for stand-ins like “Player A” before sending. The stand-in stays the same until you quit, and is swapped back in the reply on your computer | Your data page: “Other players’ names” (off) |
| **Names you type yourself** | Sent as you typed them (the app can’t tell a name from any other word) | — |
| **Other players’ chat** | **Never read.** The addon doesn’t listen to chat at all | — |
| **Memory:** short notes the app keeps about your character’s progress | Sent as a labeled summary with each message | Settings > Show more > Memory: Forget all (Last request’s raw request shows them) |
| **Your chat history** | **Stays on your computer.** The app deletes its copy after 30 days. The addon keeps each chat’s last 200 replies and messages in WoW’s saved files until you delete the chat in game or uninstall with the addon. | Settings > Show more > Chat history (days kept, Delete all); in game, right-click the chat in the window’s list, then Delete |
| **A random install ID**, only if you use OpenAI | Sent to OpenAI as its “safety identifier”, so abuse is handled per install rather than per key. It’s random, not based on your hardware | Your data > Show details > Replace ID |
| **Anything to us** | **Nothing.** No telemetry, analytics or crash reports | — |
| **Update checks** | GitHub sees your IP address and the app’s version, as with any download | Settings > Show more > About: “Update checks” |
| **Spell-check dictionaries** | Never downloaded: spell check is off in every window | — |

**On your computer,** the app keeps your chat history, memory notes, usage totals and logs in a folder only your user account can read. On a work PC with a roaming profile, Windows also copies your chat history, memory notes and usage totals to your organization’s server with the rest of your profile, as it does your saved keys. Logs never contain your key, and the diagnostics you copy for a bug report hold no messages, replies or error text from your AI company.

**Uninstalling** removes all of it, your saved keys too. If you choose, it also removes the addon from WoW, with its folders and the chat history it keeps there. To remove a key without uninstalling, click Delete key on the app’s Your AI page. On Windows, removing the app in Settings > Apps removes the addon and its chat history in WoW too.

**On your screen,** the app reads only the top of WoW’s window, where the addon draws, so your messages go at once. It doesn’t look at the rest of your screen and keeps no pictures; on Windows, a window over that spot is read too. Turn off **Screen reading** on the app’s Your data page, or **Screen Reading** in the addon’s Settings (under What NeverQuestAlone Knows), and it reads nothing on screen; off in either place wins. Your messages then wait for a reload, and replies still come in. [How it works](HOW-IT-WORKS.md#no-screen-reading) has the details.

## Why these defaults

- Character names can identify real people, so many places count them as personal data. A stand-in name the AI company can’t link back to anyone lowers that risk. It doesn’t make the data anonymous, and it can’t cover names you type.
- When you use NeverQuestAlone for yourself, you choose to send your own messages. The defaults decide how much of *other* players’ information goes along, so they send as little as possible: no chat, no names from game data, nothing to us.
- This is how we read the rules, not legal advice.

## Your AI company’s rules

With your own key, **you are your AI company’s customer**, under its terms and privacy policy. When you connect an AI, the app shows its company’s card and asks you to confirm you meet its age and use rules. You only need to read the card for the AI you use.

These cards sum up each AI company’s own pages as read on **Sep 26, 2026**. AI companies change their terms; the linked pages are what counts.

### Anthropic (Claude)

- **Kept:** API data is deleted within 30 days by default. For the models Anthropic calls “Covered Models” (Fable 5 and 5.1, Mythos 5 and 5.1), messages and replies are kept **at least** 30 days, and longer during a safety investigation or where the law requires. Content flagged for policy violations can be kept up to 2 years.
- **Used for training:** no, unless you send Anthropic feedback.
- **Nothing kept at all (zero retention):** by arrangement with Anthropic’s sales team, per organization; not available for the Covered Models without Anthropic’s authorization.
- **What NeverQuestAlone sets:** nothing extra. It sends only the request.
- **Age:** Anthropic expects products that minors use to have extra safeguards.
- **Sources:** [API data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention) · [How long do you store my organization’s data?](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data) · [Covered Models retention](https://support.claude.com/en/articles/15425695) · [Guidelines for organizations serving minors](https://support.claude.com/en/articles/9307344-responsible-use-of-anthropic-s-models-guidelines-for-organizations-serving-minors)

### OpenAI

- **Kept:** abuse-monitoring logs up to 30 days (longer if the law requires or to prevent harm). Responses are stored for 30 days **unless** the request says not to, and NeverQuestAlone always does (`store: false`).
- **Used for training:** no, unless your OpenAI organization has opted in to data sharing. NeverQuestAlone can’t see that setting; check it in your OpenAI account.
- **Nothing kept at all (zero retention):** with OpenAI’s approval.
- **What NeverQuestAlone sets:** `store: false` on every request, and a random install ID as the safety identifier (see the table above).
- **Age:** OpenAI publishes guidance for apps that under-18s may use.
- **Sources:** [Your data](https://developers.openai.com/api/docs/guides/your-data) · [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state) · [Under-18 guidance](https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance)

### ChatGPT plan (signed in)

With a ChatGPT plan, you sign in with your ChatGPT account instead of using an API key, and your messages go to OpenAI under your ChatGPT account, the way its Codex app’s do. The ChatGPT Terms of Use and your account’s data controls apply.

- **Kept, and used for training:** what ChatGPT does for your account. Training follows your ChatGPT setting (Settings > Data controls > Improve the model for everyone).
- **What NeverQuestAlone keeps:** your ChatGPT account’s ID and a sign-in token (the refresh token) in your macOS Keychain or Windows Credential Manager. The short-lived access token stays in the app’s memory. Signing out (Your AI > Sign out) deletes the saved sign-in.
- **What NeverQuestAlone sets:** `store: false` on every request, and it names itself (`originator: neverquestalone`). It asks only for your basic profile when you sign in (`openid profile email offline_access`), never for access to your connectors.
- **Where it connects:** `auth.openai.com` to sign in and renew the sign-in, and `chatgpt.com` for replies.
- **Sources:** [Using your ChatGPT plan in other apps](https://help.openai.com/en/articles/11369540) · [Terms of Use](https://openai.com/policies/terms-of-use/) · [Privacy policy](https://openai.com/policies/privacy-policy/)

### xAI (Grok)

- **Kept:** requests and replies are stored for 30 days, encrypted, to check for abuse, then deleted.
- **Used for training:** no, without your permission.
- **Nothing kept at all (zero retention):** a team-wide switch in the xAI console (xAI says it doesn’t recommend it for most customers).
- **What NeverQuestAlone sets:** `store: false`.
- **Source:** [xAI security FAQ](https://docs.x.ai/developers/faq/security)

### Google (Gemini)

Google’s Gemini API terms require users to be 18 or older, say the Gemini API is for professional or business use, and allow it in the EEA, Switzerland and the UK only on paid plans. When you connect Gemini, the app asks you to confirm you meet Google’s rules. As read on Sep 29, 2026:

- **Kept:** messages and replies are logged for 55 days to check for abuse. The Gemini API offers no guaranteed zero retention (Google points to Vertex AI for that).
- **Used for training:** on the paid tier, no. On the free tier, **yes, and people may read it**, except for users in the EEA, Switzerland and the UK, who get the paid-tier terms.
- **Paid tier:** set up billing on your Google AI Studio project.
- **What NeverQuestAlone sets:** nothing extra. It sends only your message, to Google’s OpenAI-compatible address (`generativelanguage.googleapis.com`).
- **Sources:** [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms) · [Usage policies](https://ai.google.dev/gemini-api/docs/usage-policies) · [Zero data retention](https://ai.google.dev/gemini-api/docs/zdr) · [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)

### Other (any OpenAI-compatible service)

Other connects any service that speaks the OpenAI chat format, at the address you give it: OpenRouter, Groq, Together, or a model on your computer with Ollama or LM Studio.

- **Kept, and used for training:** whatever that service’s own rules say. Read its privacy policy before you connect it. OpenRouter, for example, doesn’t store messages by default, and routes to AI companies with rules of their own.
- **On your computer:** an address on `localhost` (`127.0.0.1`) keeps your messages on your computer. Keep your model server listening only on this computer, as Ollama and LM Studio do unless you change it. Ollama’s “cloud” models (their names end in “cloud”) run on Ollama’s servers, so your messages leave your computer.
- **What NeverQuestAlone sets:** nothing extra. It sends only your message, with your key if you gave one, and connects only to the one host of the address you gave it: https for a service, http only for your own computer.
- **Sources:** [OpenRouter data collection](https://openrouter.ai/docs/guides/privacy/data-collection) · [Ollama privacy](https://ollama.com/privacy) · [LM Studio privacy](https://lmstudio.ai/app-privacy)

## Age

World of Warcraft is rated T, and each AI company sets its own age and use rules for the people using its service. When you connect an AI, the app asks you to confirm you meet its company’s rules. If you’re under an AI company’s minimum age, don’t use its AI.

## Questions

[Open an issue](https://github.com/tommygeoco/neverquestalone/issues). Leave out your key, the code that links the addon to the app, and anything from Last request you’d rather keep private.

A security problem? Report it privately on the Security tab (Report a vulnerability), never in a public issue.

---

World of Warcraft, Warcraft and Blizzard Entertainment are trademarks or registered trademarks of Blizzard Entertainment, Inc. in the U.S. and/or other countries. NeverQuestAlone is unofficial and is not affiliated with or endorsed by Blizzard Entertainment, Anthropic, OpenAI, Google, xAI or OpenRouter. Other names are the trademarks of their owners and are used only to say which service you can connect.
