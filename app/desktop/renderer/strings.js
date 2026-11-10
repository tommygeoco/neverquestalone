// NeverQuestAlone desktop app: the window's player-facing strings (the renderer's table).
//
// Source: the redesign's build spec (redesign v1, "the companion panel", 2026-09-30), §5 and §6,
// cleaned against docs/STYLE.md. English only (v1). The bar: brevity beats completeness. A screen
// has a title of a few words, at most one short line under it, and one primary button; anything
// that explains goes behind Show details (the sheet), scoped to the AI picked.
// index.html loads this before app.js; app.js reads window.BonesStrings by id and never builds a
// sentence from pieces (STYLE §12). Where these words and the spec's differ, these win: docs/STYLE.md
// governs the words (the key belongs to the AI company, never "your Claude key"; no "budget").
//
// Key kinds: title = a heading; headline = the first sentence of a result or card; lead, body, hint,
// detail = descriptions (whole sentences, ending with a period); line = other text; btn, *Btn = button
// labels (a STYLE §2.3 verb first); stillWaitingLink = a help link that is its question (STYLE §3);
// label, legend = a toggle's, switch's or field's name (a noun phrase); placeholder; chip = a status;
// alt = an image's text; aria* = accessible names; code = a command shown exactly as typed.
// Plurals are { one, other } objects, picked with Intl.PluralRules('en').
//
// Placeholders (filled with F.fill):
//   {name}       companion(), the companion's name ("NeverQuestAlone" unless renamed; STYLE §11)
//   {ai}         the AI's name: Claude, ChatGPT, Grok, Gemini; Other's service by its host
//   {co}         the AI company: Anthropic, OpenAI, xAI, Google; Other's service by its host
//   {host}       Other's service, by the host of its address (openrouter.ai, localhost:11434)
//   {model}      a model's display name; {app} a server on this computer, by its host
//   {masked}     a masked key, e.g. sk-ant-…A1b2; {prefix} the manifest's keyPrefix
//   {store}      F.storeText(): "your macOS Keychain" or "Windows Credential Manager"
//   {dayCost}    F.dayRange(priceHint.dayUsd), e.g. "$0.17–0.37" (information only)
//   {amount}, {limit}  dollar amounts through F.usdMicros; {count}, {pct} numbers
//   {time}, {date}  Intl.DateTimeFormat, local time; {pane} the Screen Recording pane's name
//   {loginPane}  the Login Items pane's name; {version} the app's version; {key} ⌘ or Ctrl
// {co} and {ai} never fill on the local path (Other at a server on this computer): its lines use {app}.
// No string starts with a ✓: the renderer draws the mark (an icon, aria-hidden) before a done line.
// Tokens: {os:…} and {game:…} are labels as the OS or the game shows them. The text in the braces is
// the English macOS or game label and is what shows in v1; common.osTokens gives the ones that differ
// on Windows. A …Win sibling holds a sentence that differs on Windows.

window.BonesStrings = {
  // The quest tracker in Bones's panel, during setup (spec §4.9). STYLE §1: the three steps by
  // name, in order; never "Step N of M". The diamonds are decoration, drawn by the renderer.
  stage: {
    downloadLine: 'Download',
    connectLine: 'Connect your AI',
    sayHiLine: 'Set up WoW', // the owner, 2026-10-05: "Say hi in game" wasn't clear and saying hi was a needless task
    ariaLabel: 'Setup progress',
    ariaDone: '{step}, done',
    ariaSkipped: '{step}, skipped', // Screen Recording when screen reading is off (APP-D-51)
    ariaNeedsCredit: '{step}, needs credit',
    ariaKeyRejected: '{step}, key rejected',
    finishLaterBtn: 'Finish later',
    backBtn: 'Back', // drawn with a decorative "‹"
  },

  // Bones's panel (spec §5): his portrait, whose dot and eyes show his state; the state in a word
  // (spec §4.11) shows beside him on hover and is the portrait's name for a screen reader.
  bones: {
    pill: {
      inGameChip: 'In game',
      connectingChip: 'Joining game',
      wowClosedChip: 'WoW closed',
      pausedChip: 'Paused',
      needsYouChip: 'Needs you',
      notRunningChip: 'Not running',
    },
    // The portrait is a button (it opens Home); its name says the state, which shows beside it on hover,
    // and a change of state is said once in the live region (off Home, where the card says it).
    statusAria: '{name}: {status}. Open Home.',
    statusLive: '{name}: {status}.',
  },

  // The nav's Home while a card waits there: its name says so (the dot is the eye's version).
  nav: {
    homeNeedsAria: 'Home: {status}',
  },

  // The panel's foot: the version, and the one update action its state offers.
  foot: {
    versionLine: 'v{version}',
    checkBtn: 'Check for updates',
    checkingChip: 'Checking…',
    latestChip: 'Up to date',
    availableBtn: 'Download v{version}',
    downloadingChip: 'Downloading {pct}%',
    downloadingNoPctChip: 'Downloading…',
    readyBtn: 'Restart to update',
    readyChip: 'Update ready',
    retryBtn: 'Check again',
  },

  // The first screen of a first setup (the positioning: what Bones does for your questing, then the
  // AI as a supporting fact). One still in-game frame, one primary.
  welcome: {
    title: 'Meet {name}',
    lead: 'Picks your next quests, draws the route and tracks things down.', // no name: the title has it
    aiLine: 'Runs on the AI you pick.',
    mapAlt: '{name}’s route on your map: your next quests, in order.',
    startBtn: 'Set up {name}',
  },

  // Above step 2 only while it's true (spec §6.1): the app runs outside Applications (macOS).
  // The failure line is main's: STRINGS.moveToApplications in strings.mjs.
  move: {
    headline: 'Move to {os:Applications}.',
    moveBtn: 'Move',
  },

  // Step 2, "Connect your AI" (spec §6.1): five rows (a name and a day's cost), Paste {co} key, the AI
  // company's own key page, Show details. Paste detects: a key from another AI picks its row.
  ai: {
    title: 'Connect your AI',
    creditLead: '{ai} needs an API key and credit at {co}.', // the picked AI's: what a first key needs (CL-player-29); shown only before a result and until its key passes (CL-words-65, CL-player-49)
    legend: 'AI',
    dayCostLine: '{dayCost} a day', // a row's cost
    otherCostLine: 'Cost varies', // Other's row
    hiddenLine: '{ai} isn’t available right now. Pick another.',
    pasteBtn: 'Paste {co} key',
    noKeyLink: 'No key yet?', // a help link that is its question (STYLE §3): the numbered key steps behind it (onboarding critic ON-01)
    keyStepSignIn: 'Click Open {co}’s key page, then sign in or make an account.',
    keyStepBack: 'Come back to this window and click Paste {co} key.',
    getKeyBtn: 'Open {co}’s key page', // where a first-timer makes a key (STYLE §2.3: a web page's link starts with Open)
    setUpOtherBtn: 'Connect another AI',
    continueBtn: 'Continue',
    useSavedBtn: 'Use saved key',
    pasteNewBtn: 'Paste new key',
    testAgainBtn: 'Test again',
    saveAgainBtn: 'Save again',
    connectBtn: 'Connect',
    addCreditBtn: 'Add credit at {co}',
    continueAnywayBtn: 'Continue anyway',
    detailsBtn: 'Show details', // the info icon's name on every page (CL-words-85); the heading beside it names the subject
    checkingBtn: 'Checking with {co}…', // Paste at work; the same words go to the live region
    keySavedChip: 'Key saved',
    keyRejectedChip: 'Key rejected',
    noCreditChip: 'No credit',
    connectedChip: 'Connected',
    // A plan that signs in (ChatGPT plan): no key, no price per reply. The button's own words are the
    // provider's (providers.<id>.signInBtn); this is the fallback.
    signInBtn: 'Sign in to {co}',
    signingInBtn: 'Waiting for your browser…', // the browser is open at the sign-in page
    cancelSignInBtn: 'Cancel sign-in',
    useSignInBtn: 'Use saved sign-in',
    signInAgainBtn: 'Sign in again',
    signedInChip: 'Signed in',
    planCostLine: 'Included in your plan',
    plansBtn: 'Open {co}’s plans',
    // One line under the actions for each result (spec §6.1's table): what's true now. The row's
    // chip or the relabelled primary is the next step.
    result: {
      okLine: '{ai} is connected.',
      notAKeyLine: '{co} keys start with {prefix}. Copy the whole key.', // a player's clipboard held something else (2026-10-05)
      notAKeyAnyLine: 'That isn’t a key from {companies}.',
      clipboardEmptyLine: 'Your clipboard is empty. Copy your key first.',
      cancelledLine: 'Not connected. Click Paste {co} key to try again.',
      cancelledPageLine: 'Not replaced. Click Paste key to try again.', // Your AI's key page: its button is Paste key // a player closed the box and was stuck (2026-10-05)
      subscriptionTokenLine: 'That’s a {ai} sign-in token, not an API key.',
      adminKeyLine: 'That key is for account admins.',
      authInvalidLine: '{co} didn’t accept that key.',
      replaceKeptLine: '{co} didn’t accept that key. Your saved key is unchanged.',
      noCreditLine: 'Key saved. Your account has no credit.',
      noCreditHeldLine: 'Your account at {co} has no credit.',
      stillNoCreditLine: 'Still no credit at {co}.',
      overloadedLine: '{co} is busy. Test again soon.',
      rateLimitedLine: '{co} is limiting this key. Test again in a minute.',
      networkLine: 'Can’t reach {co}. Check your internet, then click Test again.',
      restartLine: 'NeverQuestAlone needs a restart before it can reach {co}.', // the app's own connections stopped (fix-102), never the internet
      keystoreErrorLine: 'The key works but wasn’t saved.',
      readFailedLine: 'Your saved key couldn’t be read.',
      termsRequiredLine: 'Agree to {co}’s terms again.',
      needsConfirmLine: 'Paste the key again.',
      spendLimitLine: 'This key hit its spend limit.',
      spendLimitTierLine: '{co}’s monthly limit is reached.',
      workspaceLine: 'Make a new key on {co}’s key page.',
      modelAccessLine: 'This key can’t use that model.',
      keyRestrictedLine: 'This key can’t send messages.',
      orgVerificationLine: '{co} needs to verify your account first.',
      regionBlockedLine: '{co} isn’t available where you are. Pick another AI.', // the rows are the next step: no Paste, no key page
      stageExpiredLine: 'The pasted key expired.',
      busyLine: 'Finish the open dialog first.',
      failedLine: 'Something went wrong with {co}.',
      openRouterLine: 'That’s a key from OpenRouter.',
      signInCancelledLine: 'Not signed in. Click Sign in to try again.',
      portBusyLine: 'Another sign-in is open. Close it, then try again.', // the redirect's port is taken (Codex's own sign-in uses it too)
      browserFailedLine: 'Your browser didn’t open. Try again.',
      signInTimeoutLine: 'The sign-in took too long. Try again.',
      signInFailedLine: '{co} didn’t finish the sign-in. Try again.',
      signInEndedLine: 'Your {ai} sign-in ended. Sign in again.',
      notSignedInLine: 'You’re not signed in yet.',
    },
  },

  // The Details sheet (spec §4.6), scoped to the AI picked: the only place long text lives in setup.
  details: {
    title: '{ai}, in detail',
    titleOther: 'Other, in detail',
    titleUsage: 'Spending, in detail',
    titleSayHi: 'Setting up WoW, in detail',
    titleData: 'Your data, in detail',
    closeAria: 'Close',
    costLabel: 'Cost',
    keyLabel: 'Your key',
    leavesLabel: 'Where it goes',
    keptLabel: 'At {co}',
    termsLabel: 'Terms',
    worksLabel: 'What works',
    costBody: 'Priced for about 40 replies a day, thinking at Low. You pay {co} as you go.',
    keyBody: 'In {store}. Never in the game; sent only to {co}.',
    keyBodyWin: 'In Windows Credential Manager. Never in the game; sent only to {co}. Programs you run can read it, like any saved password.',
    workPcBodyWin: 'On a work PC, your key may follow your Windows account to other PCs.',
    termsLink: 'Open {co}’s terms',
    fineBody: 'Unofficial. Not made or reviewed by Blizzard. It never plays for you.',
    otherWorksBody: 'OpenRouter, Groq, Together, Ollama, LM Studio, and any service that speaks the OpenAI chat format. A server on this {os:Mac} needs no key.',
    otherKeyBody: 'In {store}. It goes only to the service you connect.',
    otherKeyBodyWin: 'In Windows Credential Manager. It goes only to the service you connect.',
    otherLeavesBody: 'Your messages and game data go to the service you connect. A server on this {os:Mac} keeps them here.',
    // Step 3's sheet: what the addon does, what Screen Recording is for, and without it.
    addonLabel: 'The addon',
    addonBody: 'The app installs the addon in WoW. The addon shows your route, pins and replies in game.',
    screenLabel: 'Screen Recording',
    screenBody: 'Reads only the top of WoW’s window, so your messages go at once. Never keeps or sends pictures.',
    // Off a Mac the app reads that strip of the screen, so a window over it is read too (the landing's FAQ; ON-23).
    screenBodyWin: 'Reads the top of WoW’s window and anything over it. Never keeps or sends pictures.',
    noReadingLabel: 'Without it',
    noReadingBody: 'Your messages then wait for a /reload. Replies still come in.',
    // The spending sheet (Your AI).
    countedLabel: 'How it’s counted',
    countedBody: 'Estimated from list prices.',
    countedExactBody: 'Exact, as {co} reported it.',
    limitLabel: 'Your daily limit',
    limitBody: '{name} stops at your limit and starts again at midnight.',
    atCoBody: 'Set a spend limit at {co} too: your backstop if a key ever leaks.',
    // Connections' sheet.
    // Your data's sheet.
  },

  // The picture of where your data goes (step 2's sheet, Your data): your computer, straight to the
  // AI company; NeverQuestAlone struck out; what's in a message. Short labels; the words are its alt.
  flow: {
    youLine: 'Your {os:Mac}',
    usLine: 'NeverQuestAlone',
    usSubLine: 'Gets nothing: no account, no tracking',
    inMessageLine: 'In each message: your question, level, zone, quests and gear.',
    aria: 'Your messages and game data go from your {os:Mac} straight to {co}. Nothing goes to NeverQuestAlone.',
    ariaOther: 'Your messages and game data go from your {os:Mac} to the service you connect. Nothing goes to NeverQuestAlone.',
  },

  // The per-AI extras for the sheet, by manifest id (spec §6.1): one line each. What each AI company
  // keeps is the manifest's own short line (privacyCard.short), never a second account of it here.
  providers: {
    anthropic: {
      subscription: 'A Claude Pro or Max subscription isn’t an API key.',
      creditStep: 'Add $5 of credit.',
      createStep: 'Click Create key, then Copy.',
    },
    openai: {
      subscription: 'A ChatGPT Plus or Pro subscription isn’t an API key. Add $5 of credit at OpenAI first, or pick ChatGPT plan to sign in with your plan.',
      creditStep: 'Add $5 of credit, OpenAI’s minimum.',
      createStep: 'Click Create new secret key, then Copy.',
    },
    xai: {
      subscription: 'A Grok subscription isn’t an API key.',
      creditStep: 'Add $5 of credit.',
      createStep: 'Click Create API key, then Copy.',
      extraLine: 'xAI charges $0.05 for each request it refuses under its usage rules.',
    },
    google: {
      subscription: 'A Google AI Pro or Ultra subscription isn’t an API key. Set up billing so Google doesn’t use your messages.',
      creditStep: 'Click Set up billing, so Google doesn’t use your messages.',
      createStep: 'Click Create API key, then Copy.',
      creditLead: '{ai} needs an API key and billing set up at {co}.',
      extraLine: 'Google’s terms for its API say you must be 18 or older.',
    },
    chatgpt: {
      signInBtn: 'Sign in with ChatGPT',
      subscription: 'Uses your ChatGPT plan (Plus, Pro, Business and others) instead of an API key. Replies count toward your plan’s usage limits.',
    },
    custom: {},
  },

  // 6.1.2 Other: any OpenAI-compatible service at its own address, its key optional, its model.
  custom: {
    title: 'Connect another AI',
    lead: 'Any OpenAI-compatible service works.',
    baseUrlLabel: 'Base URL',
    baseUrlPlaceholder: 'https://openrouter.ai/api/v1',
    keyLabel: 'API key',
    keyPlaceholder: 'Optional for a local server',
    keyStagedPlaceholder: 'Pasted: {masked}',
    modelLabel: 'Model',
    // The model hint matches the address: OpenRouter's (the address placeholder), Groq's, Ollama's.
    modelPlaceholder: 'meta-llama/llama-3.3-70b-instruct',
    modelPlaceholderGroq: 'llama-3.3-70b-versatile',
    modelPlaceholderOllama: 'llama3.2',
    connectBtn: 'Connect',
    checkingBtn: 'Checking…',
    ok: {
      headline: 'Connected to {host}.',
      localLine: '{host} is running with {model}.',
    },
    badUrl: { headline: 'That isn’t a web address.' },
    httpsRequired: { headline: 'Use https, or an address on your home network.' },
    credentials: { headline: 'Leave the password out.' },
    query: { headline: 'End the address before any ?.' },
    badModel: { headline: 'Type the model’s exact name.' },
    notAKey: { headline: 'That doesn’t look like a key.' },
    keyExpired: { headline: 'Paste the key into API key.' },
    authInvalid: { headline: '{host} didn’t accept that key.' },
    modelAccess: { headline: '{host} doesn’t offer that model.' },
    network: { headline: 'Can’t reach {host}.' },
    outOfCredit: { headline: 'No credit at {host}.' },
    busy: { headline: '{host} is busy right now.' },
    restart: { headline: 'NeverQuestAlone needs a restart before it can reach {host}.' }, // the app's own connections stopped (fix-102)
    keystoreError: { headline: 'The key couldn’t be saved.' },
    cancelled: { headline: 'Nothing was sent or saved.' },
    failed: { headline: '{host} didn’t answer the test.' },
  },

  // A model on this computer (Other at localhost): what a check that finds it says.
  local: {
    ready: {
      line: '{app} is running with {model}.',
    },
  },

  // Step 3, "Say hi in game" (spec §6.1): the objectives, ticked off on real events only. Only the
  // current row has a line and an action.
  sayHi: {
    title: 'Set up WoW',
    reading: {
      title: 'Screen reading', // Windows: nothing to allow, but the player sees it's on (the owner, 2026-10-05)
      onLine: 'On. Reads the top of WoW’s window. Never keeps or sends pictures.', // Windows only: the strip of the screen (ON-23)
      offLine: 'Off. Your messages wait for a /reload.',
    },
    detailsBtn: 'Show details',
    loginPaneName: {
      mac15: 'Login Items & Extensions',
      mac14: 'Login Items',
    },
    install: {
      title: 'Install the addon',
      lookingLine: 'Looking for WoW…',
      foundLine: 'Found World of Warcraft: Forever.',
      installBtn: 'Install',
      chooseFolderBtn: 'Choose folder…',
      runningLine: 'WoW is open.',
      installWhenClosedBtn: 'Install when WoW closes',
      armedLine: 'Installs when you quit WoW.',
      cancelBtn: 'Cancel',
      installingLine: 'Installing…',
      severalLine: {
        one: '{count} copy of WoW: Forever found.',
        other: '{count} copies of WoW: Forever found.',
      },
      folderLabel: 'Game folder',
      notFoundLine: 'Couldn’t find World of Warcraft: Forever.',
      chooseWowFolderBtn: 'Choose WoW folder…',
      checkAgainBtn: 'Check again',
      badFolderLine: 'That folder isn’t WoW: Forever.',
      raceLine: 'WoW started mid-install. It didn’t load.',
      installAgainBtn: 'Install again',
      olderLine: 'The addon needs an update.',
      updateBtn: 'Update',
      updateWhenClosedBtn: 'Update when WoW closes',
      updateAgainBtn: 'Update again',
      epermLine: 'NeverQuestAlone can’t write to AddOns.',
      chooseAnotherBtn: 'Choose another folder…',
      copyCommandBtn: 'Copy the command',
      epermAskBody: 'Ask an administrator to give your account permission to change WoW’s AddOns folder.',
      copiedBody: 'Copied. An administrator can paste it into Terminal.',
      copiedBodyWin: 'Copied. An administrator can paste it into Command Prompt, opened with {os:Run as administrator}.',
      diskFullLine: 'No free space for the addon.',
      failedLine: 'The addon didn’t install.',
      failedUpdateLine: 'The addon didn’t update.',
      copyDiagnosticsBtn: 'Copy diagnostics',
      copiedDiagnosticsLine: 'Diagnostics copied.',
      othersCanWriteLine: 'Other accounts can change WoW’s addons.',
      openDiagnosticsBtn: 'Open Diagnostics',
    },
    permission: {
      title: 'Allow Screen Recording',
      notAskedLine: 'Reads only the top of WoW’s window, so your messages go at once. Never keeps or sends pictures.', // the sheet's words; pictures, never "nothing": your messages still go to your AI (CL-words-63, CL-player-48)
      allowBtn: 'Allow',
      askedLine: 'Click {os:Open System Settings}, then turn on NeverQuestAlone.',
      deniedLine: 'Screen Recording is off.',
      paneLine: 'Turn it on in {os:System Settings} > {os:Privacy & Security} > {pane}.',
      openSettingsBtn: 'Open {os:System Settings}',
      paneName: {
        mac15: 'Screen & System Audio Recording',
        mac14: 'Screen Recording',
      },
      offLine: 'Screen reading off.',
      noReadingAsk: 'Skip screen reading?', // a help link that is its question (STYLE §3)
      noReadingLine: 'Your messages then wait for a /reload. Replies still come in.',
      noReadingBtn: 'Turn off screen reading', // the app's switch (Your data), one click (the orchestrator's trust plan, 2026-10-03)
    },
    startWow: {
      title: 'Turn on the addon',
      startStep: 'Start WoW.',
      addonsStep: 'At character select, click {game:AddOns} and make sure NeverQuestAlone is checked.',
      loginStep: 'Log in. {name} shows up beside your quest tracker.',
      typeLine: 'In chat, type:',
      code: '/nqa hi',
      copyBtn: 'Copy',
      copiedState: 'Copied',
      openBattleNetBtn: 'Open Battle.net',
      openBattleNetHintWin: 'Tucks this window into the tray.',
      afterCloseLine: 'Start WoW again once it closes.',
      waitingLine: 'Waiting for WoW…',
      listeningLine: 'Waiting for the addon…',
      stillWaitingLink: 'Still waiting?',
      helloLine: '{name} is in your game. Say hi in chat:',
      gotMessageLine: 'Waiting for {ai}…',
      gotMessageLineLocal: 'Waiting for {model}…',
      afterReplyLine: 'Ask anything. The reply finishes setup.',
      aiNotReadyLine: 'Connect your AI first.',
      errorLine: 'Once it’s fixed, say hi again.',
      ifaceMismatchLine: 'The addon’s out of date.', // what's true (the game's own words); its button is the fix (CL-words-81)
      checkUpdatesBtn: 'Check for updates',
      damagedLine: 'NeverQuestAlone is damaged.',
      openDownloadBtn: 'Open download page',
      cornerLineWin: 'Keep the top of WoW’s window on screen.',
      checkAgainBtn: 'Check again',
      // Still waiting?: the first cause that holds, worked out when it's clicked (never by a timer).
      why: {
        readingOff: 'Screen reading is off, so the app finds the addon at your next /reload. In chat, type /reload.',
        noPermission: 'Allow Screen Recording above first.',
        noDecode: 'The addon starts once you’re in the world. If you are, open {game:AddOns} or switch WoW to {game:Windowed} mode.',
        noDecodeWin: 'The addon starts once you’re in the world. If you are, open {game:AddOns} and move anything off WoW’s window.',
        minimized: 'WoW is minimized. Click it in the taskbar.',
        blocked: 'Another program blocks screen reading. Close it.',
        noWindow: 'The app can’t find WoW’s window yet. Click Check again in a moment.',
        nothingSeen: 'If WoW was open during the install, restart it. If {game:AddOns} marks NeverQuestAlone out of date, check {game:Load out of date AddOns}.',
      },
    },
    // A card over the list while the AI isn't ready (the no-credit words; the rest are homeCard.*).
    stateCard: {
      noCreditHeadline: 'No credit at {co}.',
      addCreditBtn: 'Add credit', // the banner's line names the company
    },
    passedLine: '{ai} is connected.',
  },

  // You're set (spec §6.1): the title, one line, where he stays, Open Home.
  done: {
    title: 'You’re set',
    mapLine: 'In game, click {game:Say Hi}, then ask for a route.',
    mapLineReplied: 'In game, ask {name} for a route.', // after a first reply Say Hi is gone from the HUD (ON-26)
    liveLine: '{name} is in your game. You’re set.', // said once in #live; the addon's hello finishes setup (2026-10-05)
    menuBarLine: 'NeverQuestAlone stays in your menu bar.',
    menuBarLineWin: 'NeverQuestAlone stays in your system tray.',
    noLoginLine: 'Start NeverQuestAlone yourself when you play.',
    homeBtn: 'Open Home',
  },

  // What a failing screen reading says (status-view.mjs words otherwise).
  health: {
    blindHeadline: '{name} can’t see the game.',
  },

  // Setup left with Finish later: Home says the first missing piece (spec §6.2).
  finishLater: {
    title: 'Almost set up',
    noAiLine: '{name} can’t answer yet.',
    noAddonLine: 'The addon isn’t in WoW yet.',
    noScreenRecordingLine: '{name} can’t see the game yet.', // macOS
    finishSetupBtn: 'Finish setup',
  },

  // Home (spec §6.2): Bones's condition as the title; the one card when something needs the player;
  // the route card (what Bones does in game); one compact row for the AI and today's spend.
  home: {
    inGameTitle: '{name} is in game',
    connectingTitle: '{name} is joining the game',
    wowClosedTitle: 'WoW is closed',
    noAiTitle: '{name} has no AI yet',
    needsTitle: 'One thing needs you',
    pausedTitle: '{name} is paused',
    openBattleNetBtn: 'Open Battle.net',
    pickAiBtn: 'Pick an AI',
    pauseBtn: 'Pause',
    resumeBtn: 'Resume',
    routeTitle: 'Your route',
    nextStopLabel: 'Next stop',
    stopsLine: { one: '{count} stop on your map', other: '{count} stops on your map' },
    aiRowAria: 'Your AI and today’s spend',
    todayLine: '{amount} today',
    todayOfLimitLine: '{amount} of {limit} today',
    todayUnknownLine: 'Today’s spend unknown', // couldn't be read (code health BR-09): never the limit as if spent, no meter (bones-ux-writer UX-W01)
    noAiValue: 'No AI yet',
    ariaMeter: 'Spent today',
    meterText: '{amount} of {limit}',
  },

  // The state card: the alert on Home, the banner elsewhere (spec §4.12, §4.13). A title (one
  // sentence), one line, and its fix. It stays while the state holds, with no Okay.
  homeCard: {
    lastErrorHeadline: 'The last message failed.',
    noAi: {
      headline: '{name} has no AI yet.',
      detail: 'Pick one so {name} can answer.',
      pickAiBtn: 'Pick an AI',
      inUseLine: 'No AI yet.',
    },
    noKey: {
      headline: 'No key from {co} yet.',
      detail: 'Add one so {name} can answer.',
      addKeyBtn: 'Add key',
    },
    keyUnreadable: {
      headline: 'Your {co} key couldn’t be read.',
      detail: 'Unlock your login keychain, then test it.',
      detailWin: 'Test it again, or restart Windows.',
      stillLine: 'Still can’t read your {co} key.',
    },
    keyInvalid: {
      headline: '{co} rejected your key.',
      detail: 'Paste a new one to keep playing.',
      replaceKeyBtn: 'Replace key',
      stillLine: '{co} still rejects this key.',
    },
    outOfCredit: {
      headline: 'Your {co} account is out of credit.',
      detail: 'Add credit, then test.',
      stillLine: 'Still no credit.',
    },
    providerDown: {
      headline: '{co} isn’t answering.',
      detail: '{name} tries again with your next message.',
      stillLine: '{co} still isn’t answering.',
    },
    localDown: {
      headline: 'Can’t reach {app}.',
      detail: 'Start your model app.',
      stillLine: 'Still can’t reach {app}.',
    },
    slowed: {
      headline: '{co} asked {name} to slow down.',
      detail: {
        one: 'Trying again in {count} second.',
        other: 'Trying again in {count} seconds.',
      },
      detailSoon: 'Trying again soon.',
      stillLine: '{co} still asks {name} to slow down.',
    },
    modelRetired: {
      headline: 'Your model was retired.',
      detail: 'Pick another to keep playing.',
      pickModelBtn: 'Pick another model',
      stillLine: '{model} is still retired.',
    },
    spendLimit: {
      stillLine: 'Still at the spend limit you set at {co}.',
    },
    regionBlocked: {
      stillLine: '{co} still isn’t available where you are.',
    },
    identifierBlocked: {
      stillLine: '{co} still blocks this install.',
    },
    nearCap: {
      headline: 'Today’s spend is near your limit.',
      detail: '{name} stops at {limit}, back at midnight.',
      liveLine: 'Today’s spend is near your limit.',
    },
    cap: {
      headline: 'You’ve reached your daily spend limit.',
      detail: '{name} rests until midnight.',
      raiseLimitBtn: 'Raise limit',
      stillLine: 'Still at your daily spend limit.',
    },
    // The limit holds as reached because today's spend couldn't be read (code health BR-09); setting it
    // again on Your AI counts today's spend from then. Set limit opens it there.
    capUnread: {
      headline: 'Today’s spend couldn’t be read, so {name} rests.',
      detail: 'Set your limit again to count from now.',
      setLimitBtn: 'Set limit',
    },
    repeatedHeadline: '{co} turned down that message twice.',
    repeatedDetail: 'Try asking another way.',
    openLastRequestBtn: 'Open Last request',
    resumeSendingBtn: 'Resume sending',
    testKeyBtn: 'Test key',
    answeredLine: '{co} answered.',
    localCheckedLine: '{app} is running.',
  },

  // Formatting lines format.js reads (bar.*: usage lines and a status's words before any).
  bar: {
    usageLocal: 'On this computer · {app} · {model}',
    usageFree: '{used} of {limit} requests today',
    usageSpent: '{amount} today',
    usageOfLimit: '{amount} of {limit} today',
    startingLine: 'Starting',
    workingLine: 'Working',
    thinkingLevel: {
      off: 'Off',
      minimal: 'Minimal',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      xhigh: 'Extra high',
      max: 'Max',
    },
  },

  // Your AI (spec §6.3): the AI, its key, every model by name with its cost a day, thinking, and
  // what it costs you (the spending group, with the daily spend limit). Settings save on change.
  yourAi: {
    title: 'Your AI',
    aiLabel: 'AI',
    keyLabel: 'Key',
    modelLabel: 'Model',
    thinkingLabel: 'Thinking',
    changeBtn: 'Switch',
    testKeyBtn: 'Test key',
    checkAgainBtn: 'Check again',
    replaceKeyBtn: 'Replace key',
    connectBtn: 'Pick an AI',
    detailsBtn: 'Show details',
    backBtn: 'Back', // ‹ Back to Your AI, from the picker and saved keys
    emptyLine: 'No AI yet.',
    recommendedChip: 'Recommended',
    olderChip: 'Older',
    retiredChip: 'Retired', // the model in use that its AI company retired: no price, never Older (CL-words-61)
    cheapestChip: 'Cheapest',
    smartestChip: 'Smartest',
    pickModelBtn: 'Pick a model', // opens the models and Thinking, in the Model card (the app trim)
    hideModelBtn: 'Hide models',
    allModelsBtn: 'Show all models',
    hideModelsBtn: 'Show fewer models',
    dayCostLine: '{dayCost} a day',
    // The Model row, one whole string each (CL-words-78): with levels and a price, a price alone, a
    // level alone (a model on this computer). A retired model is its name and the Retired chip.
    modelSumLine: '{model} · Thinking: {level} · {dayCost} a day',
    modelSumCostLine: '{model} · {dayCost} a day',
    modelSumLevelLine: '{model} · Thinking: {level}',
    rejectedChip: 'Rejected',
    noCreditChip: 'No credit',
    missingChip: 'Missing',
    localValue: 'Runs on this computer',
    testOkLine: 'Works. That test cost {amount}.',
    localOkLine: '{app} is running.',
    keyUnreadableLine: 'Unlock your login keychain, then test again.',
    checkingLine: 'Checking with {co}…',
    replaceTitle: 'Replace your {co} key',
    fieldLabel: 'Or type the key',
    pasteKeyBtn: 'Paste key',
    useKeyBtn: 'Save key',
    chosenLine: '{name} now uses {model}.',
    thinkingDayLine: '{level}: {dayCost} a day.', // the level's cost, under the track
    sessionOnlyLine: 'Your key is kept until you quit.',
    deleteKeyBtn: 'Delete key',
    signInLabel: 'Sign-in',
    signedInLine: 'Signed in with your {ai}',
    testSignInBtn: 'Test sign-in',
    signInAgainBtn: 'Sign in again',
    signOutBtn: 'Sign out',
    safetyIdLabel: 'OpenAI safety ID',
    replaceIdBtn: 'Replace ID',
    safetyIdDoneLine: 'OpenAI gets the new ID now.',
  },

  // Your AI's spending group and the daily spend limit (spec §6.4).
  usage: {
    todayLabel: 'Today',
    todayValue: '{amount}',
    todayOfLimitValue: '{amount} of {limit}',
    todayUnknownValue: 'Unknown', // today's spend couldn't be read (code health BR-09; bones-ux-writer UX-W01)
    limitLabel: 'Daily limit',
    limitLine: '{name} stops here, back at midnight.',
    setLimitBtn: 'Set a limit',
    saveLimitBtn: 'Save limit',
    cancelBtn: 'Cancel',
    turnOffBtn: 'Turn off limit',
    amountAria: 'Daily limit in dollars',
    amountPlaceholder: '2.00',
    savedLine: 'Saved.',
    offLine: 'Your daily limit is off.',
    badAmountLine: 'Type an amount from $0.01 to $100.',
    localLine: 'A model on this computer costs nothing.',
    backToSetupBtn: 'Back to setup',
  },

  // Connections (spec §6.5), under Your data.
  connections: {
    title: 'Connections',
    lead: 'Every address this app talked to. Other programs aren’t listed.',
    emptyLine: 'Nothing yet.',
    refusedChip: 'Blocked', // what the app did to it, so it never reads as the app phoning home (CL-player-65)
    listAria: 'Addresses',
    countLine: { one: '{count} time', other: '{count} times' },
    lastLine: 'last {time}',
    feature: {
      provider: 'Your AI company', // the fallback when the host's AI is unknown
      providerAi: 'Messages to {ai}', // what the AI's address is for (CL-words-58)
      keyTest: 'Key test',
      keyTestCo: '{co} key test',
      local: 'Model on this computer',
      signIn: 'Sign-in',
      update: 'Update check',
      app: 'Other',
    },
  },

  // Last request (spec §6.6), under Your data: what went, readable first; the exact request one
  // click away.
  lastRequest: {
    title: 'Last request',
    emptyLine: 'Nothing sent yet.',
    chatLabel: 'Chat',
    chatAsk: 'Your question',
    chatRoute: 'Route update',
    jsonAria: 'The last request',
    askedLabel: 'You asked',
    checkInValue: 'Nothing: a check-in',
    gameLabel: 'Game data',
    noGameValue: 'None',
    levelChip: 'Level {level}',
    questsChip: { one: '{count} quest', other: '{count} quests' },
    gearChip: 'Gear',
    memoryChip: 'Memory',
    sentToLabel: 'Sent to',
    sentToValue: '{co} · {model} · {time}',
    showRawBtn: 'Show raw request',
    hideRawBtn: 'Hide raw request',
  },

  // Settings (spec §6.7, trimmed): three switches and Show more; every control saves on change.
  // Sub-pages open with ‹ Settings.
  settings: {
    title: 'Settings',
    backBtn: 'Back', // ‹ Back to Settings, from its pages
    loginLabel: 'Start at login',
    loginDevLine: 'Works in the installed app.',
    loginHeldLine: 'macOS held it. Allow it in {loginPane}.',
    notificationsLabel: 'Notifications',
    autoUpdateLabel: 'Automatic updates',
    autoUpdateLine: 'New versions install themselves while WoW is closed.',
    checkInsLabel: 'Check-ins',
    checkInsLine: 'Quest and level-up tips, billed as replies.', // the quest work first (CL-words-60), and that each is billed (CL-words-66, CL-player-51)
    moreBtn: 'Show more', // the one disclosure: what protects you and the pages behind it (the app trim)
    lessBtn: 'Show less',
    runSetupBtn: 'Run setup again', // the row is this button (CL-words-76)
    historyLabel: 'Chat history',
    historyOption: { one: '{count} day', other: '{count} days' },
    memoryLabel: 'Memory',
    deleteChatsBtn: 'Delete all', // on Chat history's row; main's "Delete all chat history?" asks first
    deleteChatsAria: 'Delete all chat history',
    forgetAllBtn: 'Forget all', // on Memory's row: every character's notes, one confirm in main
    echoLabel: 'Replies in chat frame', // the in-game echo, which the desktop gates (off by default); the addon's lines name it
    deletedLine: 'Deleted.',
    forgotLine: 'Forgotten.',
    diagnosticsLabel: 'Diagnostics',
    aboutLabel: 'About',
    uninstallBtn: 'Uninstall',
    savedLine: 'Saved.',
    notSavedLine: 'That didn’t save.',
    saveAgainBtn: 'Save again',
  },

  // Settings' sub-pages and Your data, each a title and one line, then groups (spec §6.7).
  pages: {
    privacy: {
      title: 'Your data',
      sentTitle: 'Sent with your messages', // no AI yet, or a model on this computer
      sentToTitle: 'Sent to {co} with your messages', // {co}: the AI company, or Other's service by its host (CL-words-75)
      gameDataLabel: 'Game data',
      gameDataHint: 'Level, zone, quests and gear.',
      gameDataOffLine: 'Off: no route or quest picks.',
      identityLabel: 'Character name',
      identityHint: 'Your name, realm and guild.',
      otherNamesLabel: 'Other players’ names',
      otherNamesHint: 'Players you target or link.',
      // Screen reading, the app's switch (the orchestrator's trust plan, 2026-10-03): on by default; off
      // wins over the addon's own Screen Reading, which the addon keeps. The page's line is short (its 45
      // words, the app trim); the whole of it is in Show details (screenSheet*).
      screenLabel: 'Screen reading',
      screenOnLine: 'Reads only the top of WoW’s window.',
      screenOnLineWin: 'Reads the top of WoW’s window and anything over it.', // off a Mac: the strip of the screen (ON-23)
      screenOffLine: 'Off: your messages wait for a /reload.',
      screenAddonOffLine: 'Off in the addon’s Settings, under What {name} Knows.', // on here, off in game: a warning line (APP-D-48, SRS-W-05)
      screenSheetLabel: 'On your screen',
      screenSheetBody: 'Reads only the top of WoW’s window. Never keeps or sends pictures.',
      screenSheetBodyWin: 'Reads the top of WoW’s window and anything over it. Never keeps or sends pictures.',
      screenSheetOffBody: 'When it’s off, your messages wait for a /reload. Replies still come in.',
      connectionsLabel: 'Connections',
      lastRequestLabel: 'Last request',
      keepsLabel: 'Keeps your messages',
      trainsLabel: 'Trains on them',
      localLine: 'Your messages stay on this {os:Mac}.',
      dataPolicyLink: 'Open {co}’s data policy',
      safetyIdBody: 'OpenAI gets a random ID for this install, so a block stops this install, not your key.',
    },
    diagnostics: {
      title: 'Diagnostics',
      bundleBody: 'Leaves out keys and chats. Nothing is uploaded.',
      copiedLine: 'Copied: {size}, {n} lines. Paste it into your bug report.',
      showCopiedBtn: 'Show what was copied',
      hideCopiedBtn: 'Hide what was copied',
      permissions: {
        title: 'Addon folder permissions',
        optionalLine: 'Other accounts can change your addons. {name} works either way.',
        copiedLine: 'Copied. Give it to an administrator.',
        adminDetailWin: 'An administrator of this PC has to fix it.',
        adminDetail: 'An administrator of this {os:Mac} has to fix it.',
        detailsBtn: 'Show details',
        hideDetailsBtn: 'Hide details',
        fixBtn: 'Fix permissions',
        copyCommandBtn: 'Copy the command',
        nothingToCopyLine: 'Nothing to copy: the folder is fine now.',
        partLine: 'Some of these folders belong to another account, so an administrator has to fix those.',
        doneLine: 'Only your account can change the addon folder now.',
      },
    },
    updates: {
      notSetUpLine: 'Updates aren’t set up in this version yet.',
      installedOnlyLine: 'Updates work in the installed app.',
      state: {
        idle: 'Not checked yet.',
        checking: 'Checking…',
        none: 'NeverQuestAlone is up to date.',
        available: 'A new version is available.',
        availableVersion: 'Version {version} is available.',
        downloading: 'Downloading…',
        downloadingPct: 'Downloading {pct}%',
        ready: 'Ready. It installs when you quit NeverQuestAlone.',
        readyAuto: 'Ready. It installs by itself while WoW is closed.', // Automatic updates (Settings)
        error: 'The last check didn’t finish.',
        off: 'Updates work in the installed app.',
        checksOff: 'Update checks are off.', // the switch below is off: the download page is the way (CL-words-79)
      },
      problem: {
        refused: 'The download was refused: it wasn’t newer than this version.',
        network: 'Couldn’t reach GitHub.',
        failed: 'The update didn’t finish.',
        notPackaged: 'Updates work in the installed app.',
      },
      notifyName: 'Update checks', // off means no checks at all, a click's too (APP-W-13); a screen reader hears it with no heading (CL-words-79)
      checkBtn: 'Check for updates',
      downloadBtn: 'Download',
      quitInstallBtn: 'Restart to update',
      openDownloadBtn: 'Open download page',
    },
    about: {
      title: 'About',
      lead: 'NeverQuestAlone {version}.',
      legalBtn: 'Show legal and credits',
      hideLegalBtn: 'Hide legal and credits',
      unofficialBody: 'NeverQuestAlone is not affiliated with or endorsed by Blizzard Entertainment, Anthropic, OpenAI, Google, xAI or OpenRouter.',
      trademarkBody: 'World of Warcraft and Blizzard Entertainment are trademarks or registered trademarks of Blizzard Entertainment, Inc., in the U.S. and/or other countries.',
      trademarksLink: 'Open Blizzard’s trademark guidelines',
      creditsTitle: 'Credits',
      upstreamBody: 'Built on chelinho139/wow-ai (MIT): the addon and the way it talks to the app.',
      upstreamLink: 'Open wow-ai on GitHub',
      codexBody: '0xInuarashi’s wow-forever-codex, for how WoW loads addons.',
      codexLink: 'Open wow-forever-codex on GitHub',
      licenseTitle: 'License',
      licenseNote: 'The license covers NeverQuestAlone’s code, not its name or its artwork: the skull logo, the icons and the pictures.',
      noticesTitle: 'Third-party notices',
      noticesBody: 'Electron and Chromium’s notices ship beside the app as LICENSE.electron.txt and LICENSES.chromium.html.',
      packageCol: 'Package',
      licenseCol: 'License',
      showNoticeBtn: 'Show notice',
      hideNoticeBtn: 'Hide notice',
      noPackagesLine: 'No bundled packages.',
      fontsBody: 'Inter and JetBrains Mono, under the SIL Open Font License.',
    },
    uninstall: {
      title: 'Uninstall',
      lead: 'Removes NeverQuestAlone from this {os:Mac}.',
      appItem: 'The app and its data',
      keysItem: 'Your saved keys',
      loginItem: 'Start at login and Screen Recording',
      loginItemWin: 'Start at login',
      addonLabel: 'The addon in WoW',
      uninstallBtn: 'Uninstall',
      doneLine: 'Uninstalled. NeverQuestAlone is quitting.',
    },
  },

  // The window's notices (spec §4.14): one line with Okay, which puts it away for good.
  notices: {
    sample: {
      headline: 'Sample data. Nothing is saved or sent.',
    },
    modelSwitched: {
      line: 'Switched to {model}. Same price or less.',
      fromLine: '{from} was retired. Switched to {model}: same price or less.',
      pickModelBtn: 'Pick another model',
    },
    // A model its AI company will retire (SY-102-5): the earliest day ("not sooner than"), the
    // model offered in its place and its cost a day (Your AI's figure); Use picks it there.
    modelRetiring: {
      line: '{model} may retire after {date}. {to} costs about {dayCost}.', // dayCost: Your AI's row cost, yourAi.dayCostLine
      noCostLine: '{model} may retire after {date}.',
      useBtn: 'Use {model}',
    },
    fuseLine: 'Too many check-ins at once. They’re paused until your next message.',
  },

  // Your AI's cost lines (format.js costPreview).
  cost: {
    replyLine: 'about {cents}¢ a reply',
    dayLine: 'about ${range} a day at {n} replies',
    free: 'No charge · up to {n} requests a day (the service’s limit)',
    local: 'Free · runs on this computer',
    plan: 'Included in your plan · counts toward its usage limits',
  },

  // A call's failure where no result of its own says it, by the call's error code.
  errors: {
    cancelled: 'Canceled. Nothing changed.',
    busy: 'Finish the open dialog first.',
    bad_input: 'That value isn’t accepted.',
    unknown_provider: 'That AI isn’t available.',
    unknown_model: 'That model isn’t available for this AI.',
    no_models: 'No models are listed yet. Check the key, or start the app that runs your model, then try again.',
    unsupported: 'This version of NeverQuestAlone can’t do that yet.',
    bridge_unavailable: 'NeverQuestAlone couldn’t start. Quit and reopen it.',
    dev_build: 'This works in the installed app, not in a development run.',
    wow_running: 'Quit World of Warcraft first. The game loads new addons only when it starts.',
    wow_not_found: 'NeverQuestAlone couldn’t find World of Warcraft: Forever.',
    install_failed: 'The addon didn’t install. Check again, or copy diagnostics if it keeps happening.',
    restart_failed: 'The addon is installed, but NeverQuestAlone couldn’t start with it. Quit and reopen it.',
    no_update_ready: 'No update is ready yet.',
    not_configured: 'Updates aren’t set up in this version.',
    not_packaged: 'Updates work in the installed app.',
    checks_off: 'Update checks are off.',
    notify_only: 'Get new versions from the download page.',
    nothing_to_download: 'There’s nothing to download.',
    no_key_needed: 'A model on your computer doesn’t need a key.',
    not_found: 'Nothing found.',
    forbidden: 'That request wasn’t allowed.',
    no_link: 'That page isn’t available.',
    not_needed: 'NeverQuestAlone is running.',
    failed: 'That didn’t work. If it keeps happening, copy diagnostics and report a bug.',
    windowFailed: 'NeverQuestAlone couldn’t start this window.',
  },

  // Shared buttons and lines.
  common: {
    continueBtn: 'Continue',
    backBtn: 'Back',
    cancelBtn: 'Cancel',
    okayBtn: 'Okay',
    closeBtn: 'Close',
    checkAgainBtn: 'Check again',
    checkingBtn: 'Checking…',
    copyBtn: 'Copy',
    copiedState: 'Copied',
    copyDiagnosticsBtn: 'Copy diagnostics',
    copiedDiagnosticsLine: 'Copied. Paste it into your bug report on GitHub.',
    keyStore: {
      saveLine: 'Couldn’t save your key to your macOS Keychain. Unlock it, then try again.',
      saveLineWin: 'Couldn’t save your key to Windows Credential Manager. Try again, or restart Windows if it keeps happening.',
      saveLineLinux: 'Couldn’t save your key to the Secret Service. Unlock your keyring, then try again.',
      readLine: 'Couldn’t read your key from your macOS Keychain. Unlock it, then try again.',
      readLineWin: 'Couldn’t read your key from Windows Credential Manager. Try again, or restart Windows if it keeps happening.',
      readLineLinux: 'Couldn’t read your key from the Secret Service. Unlock your keyring, then try again.',
    },
    testAgainBtn: 'Test again',
    openKeysBtn: 'Open {co}’s key page',
    addCreditBtn: 'Add credit at {co}',
    openLimitsBtn: 'Open {co}’s limits page',
    openCoSettingsBtn: 'Open {co}’s settings page',
    pickAnotherAiBtn: 'Pick another AI',
    openYourAiBtn: 'Open Your AI',
    openDiagnosticsBtn: 'Open Diagnostics',
    failedLine: 'That didn’t work. If it keeps happening, copy diagnostics and report a bug.',
    pageFailed: {
      title: 'This page couldn’t load',
      body: 'Open it again. If it keeps happening, copy diagnostics and report a bug.',
    },
    notRunning: {
      headline: 'NeverQuestAlone couldn’t start.',
      detail: 'Quit and reopen it.',
      detailAlreadyRunning: 'Another copy’s open.',
      detailMissingPart: 'A file is missing. Download NeverQuestAlone again.',
      detailChanged: 'This copy was changed. Download NeverQuestAlone again.',
      quitReopenBtn: 'Quit and reopen',
      quitCopyBtn: 'Quit this copy',
      // The engine started and then stopped while the window stayed (fix-102): not a failed start.
      stoppedHeadline: 'NeverQuestAlone needs a restart.',
      detailStopped: 'Your keys and settings are kept.',
    },
    osTokens: {
      'Mac': { darwin: 'Mac', win32: 'PC' },
      '⌘V': { darwin: '⌘V', win32: 'Ctrl+V' },
    },
  },
};
