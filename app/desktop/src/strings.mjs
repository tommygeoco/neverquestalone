// NeverQuestAlone desktop app: the main process's player-facing strings on the setup path
// (native dialogs, the tray, desktop notifications). Becomes app/desktop/src/strings.mjs.
//
// Source: the onboarding build spec (revision 2.11) §3.2, §3.4.3, §3.5, §3.7, §3.11, §3.12, §4 and
// §9.2, cleaned against docs/STYLE.md; where these words and the spec's differ, these win. English only (v1). Every
// dialog's text is built here from checked input and fixed tables (TH21), never from the page.
//
// Key kinds: message = a dialog's question (its title); detail, body = descriptions; okLabel,
// cancelLabel, *Label = button labels; title = a notification's or card's first sentence;
// headline = a result's first sentence; line, *State = a tray line or status.
// Placeholders are filled in main (template literals or a fill helper), with the same names as the
// renderer's table: {name} companion(), {ai}, {co}, {fromCo}, {model}, {masked}, {before} (today's
// limit, as {amount}), {store}
// (storeName(): "your macOS Keychain" or "Windows Credential Manager"), {testCost} (the key test's
// cost, "under $0.0001"), {amount} (a dollar amount, $2.00). A …Win sibling is the Windows sentence.
//
// A connect dialog's detail is three paragraphs joined by a blank line: {masked}, one of the body
// variants, then the terms paragraph (left out when the terms are recorded at the current version).
// The body variants are whole paragraphs, so no clause is spliced in (STYLE §12):
//   clipboard*   the key came from the clipboard, so it's cleared from there on success (T3)
//   *NoCredit    Anthropic and OpenAI, first key only, while SAVE_FIRST_KEY_WITHOUT_CREDIT (T1)

export const STRINGS = {
  // §3.4.3 the native dialog after Paste key or the field (confirmNative, a sheet on the window).
  pasteDialog: {
    connect: {
      message: 'Connect {ai} with this key?',
      body: {
        clipboardNoCredit: 'Connecting sends one tiny test request to {co} ({testCost}). If {co} accepts the key, it’s saved in {store} and cleared from your clipboard.',
        clipboard: 'Connecting sends one tiny test request to {co} ({testCost}). If it works, the key is saved in {store} and cleared from your clipboard.',
        fieldNoCredit: 'Connecting sends one tiny test request to {co} ({testCost}). If {co} accepts the key, it’s saved in {store}.',
        field: 'Connecting sends one tiny test request to {co} ({testCost}). If it works, the key is saved in {store}.',
      },
      terms: 'Agreeing confirms you meet {co}’s age requirement and accept its terms.',
      okLabel: 'Agree and connect', // the default button
    },
    // A key for this AI company is already saved (rotation; never saves an unproven key, D-03).
    replace: {
      message: 'Replace your {co} key?',
      body: 'Replacing sends one tiny test request to {co} ({testCost}). If it works, the new key replaces the saved one.',
      bodyClipboard: 'Replacing sends one tiny test request to {co} ({testCost}). If it works, the new key replaces the saved one and is cleared from your clipboard.', // T3: the clearing is said in the dialog
      okLabel: 'Test and replace',
    },
    // Another AI is in use: the connect body, then one of these lines, then the terms.
    switch: {
      message: 'Switch {name} to {ai} with this key?',
      toCoLine: 'Your messages go to {co} instead of {fromCo}.',
      fromLocalLine: 'This sends your messages off this Mac, to {co}.',
      fromLocalLineWin: 'This sends your messages off this PC, to {co}.',
      okLabel: 'Agree and switch',
      okLabelTermsRecorded: 'Switch',
    },
    // useSavedKey with no terms recorded, and [Connect] on terms_required; then the terms paragraph.
    useSaved: {
      message: 'Use your saved {co} key?',
      body: 'Connecting sends one tiny test request to {co} ({testCost}) with your saved key ({masked}).',
      okLabel: 'Agree and connect',
    },
    cancelLabel: 'Cancel',
  },

  // Sign in with a plan (ChatGPT): the confirm before the browser opens. {ai} the card (ChatGPT plan),
  // {co} its company (OpenAI), {name} the companion. The detail is the body, then the terms.
  signInDialog: {
    message: 'Sign in with your {ai}?',
    body: 'Your browser opens {co}’s sign-in page. After you sign in, {name} sends one tiny test request and uses your plan for your messages, with no charge per reply. Replies count toward your plan’s usage limits.',
    switchLine: 'Your messages go to {co} instead of {fromCo}.',
    terms: 'Agreeing confirms you accept {co}’s terms of use.',
    okLabel: 'Agree and sign in',
    okLabelTermsRecorded: 'Sign in',
  },

  // Other (custom): the confirm before the one test request to the player's own service. {host}
  // the service's address as the form gave it (openrouter.ai, localhost:11434), {url} its base URL,
  // {model} the model typed. The detail is the body, then (a service off this computer) the terms.
  customDialog: {
    message: 'Connect {name} to {host}?',
    keyBody: 'Connecting sends one tiny test request for {model} to {url}. If it answers, your key is saved in {store} and {name} sends your messages there.',
    noKeyBody: 'Connecting sends one tiny test request for {model} to {url}, with no key. If it answers, {name} sends your messages there.',
    localBody: 'Connecting sends one tiny test request for {model} to {url}. Your messages stay on this {os:Mac}.',
    terms: 'You’ll use this service under its own terms.',
    okLabel: 'Connect',
  },

  // §3.2 M1: moveToApplications threw (app.moveToApplicationsFolder). Shown in S1's move card.
  moveToApplications: {
    failed: {
      headline: 'NeverQuestAlone couldn’t move to {os:Applications}.',
      detail: 'Drag it into {os:Applications} yourself, then open it from there.',
    },
  },

  // §3.11, §9.2 the tray's first item, and the tray's word for a reached limit.
  tray: {
    finishSetupLabel: 'Finish setup', // until onboarded; opens the window at the saved screen
    openAppLabel: 'Open NeverQuestAlone', // after onboarded (today's, main.mjs:360)
    capState: 'Daily spend limit reached', // the tray line's state word (status-text.mjs STATE_WORDS.cap)
    // Until onboarded, the tray's line while nothing needs fixing: the window bar's word (bones-ux-writer r3, UX-W25).
    setupLine: 'Setting up',
    tooltip: 'NeverQuestAlone · {line}', // {line}: the tray's line
    pauseLabel: 'Pause NeverQuestAlone', // a checkbox item
    quitLabel: 'Quit NeverQuestAlone',
  },

  // §3.7, §9.2 desktop notifications (ER-5; only while appState.alerts is true).
  notifications: {
    // Posted once at Continue (S3), macOS only, silent, so macOS asks once.
    alertsOn: {
      title: 'Notifications are on.',
      body: 'This is where NeverQuestAlone tells you when something needs you.',
    },
    // Only with a daily spend limit the player set (§3.12).
    cap: {
      title: 'You’ve reached your daily spend limit ({amount}).',
      titleNoAmount: 'You’ve reached your daily spend limit.', // not in the spec: the limit's amount unknown
      body: 'Raise it or turn it off in NeverQuestAlone, or it resets at midnight.',
    },
    // The limit held because today's spend couldn't be read (code health BR-09): Home's card's words
    // (renderer/strings.js homeCard.capUnread; bones-ux-writer UX-W02).
    capUnread: {
      title: 'Today’s spend couldn’t be read, so {name} rests.',
      body: 'Set your limit again in NeverQuestAlone.',
    },
    // The other states that need the player (status-text.mjs): bones-ux-writer onboarding r1's words
    // (UX-W12; no table had them). {co} is the AI company, {app} the app that runs a local model. The
    // …NoCo titles are for a status that carries no company name; {co} in a body then reads
    // someCompany, and {app} someApp.
    keyInvalid: {
      title: 'Your {co} key was rejected.',
      titleNoCo: 'Your key was rejected.',
      body: 'Replace it in NeverQuestAlone.',
    },
    signedOut: {
      title: 'Your {co} sign-in ended.',
      titleNoCo: 'Your sign-in ended.',
      body: 'Sign in again in NeverQuestAlone.',
    },
    outOfCredit: {
      title: 'Your {co} account is out of credit.',
      titleNoCo: 'Your account at your AI company is out of credit.',
      body: 'Add credit at {co}, then test your key in NeverQuestAlone.',
    },
    localDown: {
      title: '{name} can’t reach {app}.',
      body: 'Start {app}, then click Retry in game.',
    },
    lastError: {
      title: 'The last message failed.', // when the bridge's own headline is missing
      body: 'Open NeverQuestAlone for the fix.',
    },
    sendingPaused: {
      title: 'Sending is paused.', // when the bridge's own headline is missing; the detail is the bridge's
    },
    someCompany: 'your AI company',
    someApp: 'the app that runs your model',
  },

  // §3.12, §9.2 setCaps's native confirm: only to raise the player's limit or turn it off.
  // Setting a first limit, or lowering one, asks nothing.
  limitConfirm: {
    raise: {
      message: 'Raise your daily spend limit to {amount}?',
      detail: 'It’s {before} now. NeverQuestAlone keeps sending until today’s spend reaches {amount}.', // {before}: today's limit
      okLabel: 'Raise limit',
    },
    // Not in the spec: a limit that can't be read now, so every change asks and nothing says how it
    // compares (bones-ux-writer onboarding r1, UX-W11).
    set: {
      message: 'Set your daily spend limit to {amount}?',
      detail: 'NeverQuestAlone couldn’t read the limit you have now. With this one, it stops sending when today’s spend reaches {amount}.',
      okLabel: 'Set limit',
    },
    off: { // today's ipc.mjs capsConfirm words
      message: 'Turn off your daily spend limit?',
      detail: 'It’s {before} a day now. Without it, {name} keeps answering whatever today costs. Your AI company’s own limits still apply.',
      detailNoLimit: 'Without it, {name} keeps answering whatever today costs. Your AI company’s own limits still apply.',
      okLabel: 'Turn off limit',
    },
    cancelLabel: 'Cancel',
  },
  // A switch to another AI company (TH21, D-12): the reply line, then where messages go. One whole
  // sentence per thinking level, as the model runs it (bridge EFFORT_LEVELS), so no "with {level}
  // thinking" is spliced (STYLE §12); reply is a model with no levels.
  switchConfirm: {
    message: 'Switch to {model} at {ai}?',
    reply: '{name}’s next reply comes from {model}.',
    replyAt: {
      off: '{name}’s next reply comes from {model}, with thinking off.',
      minimal: '{name}’s next reply comes from {model}, with minimal thinking.',
      low: '{name}’s next reply comes from {model}, with low thinking.',
      medium: '{name}’s next reply comes from {model}, with medium thinking.',
      high: '{name}’s next reply comes from {model}, with high thinking.',
      xhigh: '{name}’s next reply comes from {model}, with extra high thinking.',
      max: '{name}’s next reply comes from {model}, with max thinking.',
    },
    toLocal: 'Your messages stay on this computer.',
    fromLocal: 'This sends your messages off this computer, to {ai}.',
    move: 'Your messages go to {ai} instead of {fromCo}.',
    okLabel: 'Switch',
  },
};
