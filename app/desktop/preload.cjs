// NeverQuestAlone's preload (BYOK PRD §11.2, SC-3): the only door between the
// settings page and the main process. It runs sandboxed, so it can require
// nothing but Electron's renderer modules, and it exposes one frozen object,
// window.nqa, with one async function per call in ipc.mjs (the CALLS list
// below is checked against ipc.mjs by tests/byok/app_ipc_test.mjs) and four
// subscriptions. No ipcRenderer, no event objects and no Node reach the page.
// The calls' shapes are the bridge's app API (bridge/byok/app-api.mjs) behind
// ipc.mjs's schemas: the one definition (no .d.ts copy; systems plan SY-15).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const PREFIX = 'nqa:';
const CALLS = [
  'status', 'dismissNotice', 'providers', 'appInfo', 'notices', 'appState', 'setAppState', 'setLoginItem',
  'stageKey', 'dropStagedKey', 'testKey', 'deleteKey', 'connectCustom', 'choose',
  'caps', 'setCaps', 'privacy', 'setPrivacy',
  'usage', 'connections', 'lastRequest',
  'memory', 'forgetMemory', 'transcripts', 'setRetention', 'regenerateSafetyId',
  'findWow', 'chooseWowFolder', 'installAddon', 'addonPermissions', 'tightenAddonPermissions', 'copyPermissionsCommand',
  'copyDiagnostics', 'copyCommand', 'openLink',
  'relaunch', 'quitApp', 'resumeSending', 'setPaused',
  'updates', 'setUpdateMode', 'setUpdateAuto', 'checkForUpdates', 'downloadUpdate', 'installUpdateNow',
  'uninstall',
  // Setup (onboarding spec §3): Paste key and its dialog, the saved key, Continue on the defaults,
  // the install, Screen Recording, the launcher, the move.
  'pasteKey', 'connectKey', 'retryConnect', 'useSavedKey', 'signIn', 'cancelSignIn', 'finishDefaults', 'cancelInstall', 'requestScreenRecording',
  'openGame', 'moveToApplications',
];

const api = {};
for (const name of CALLS) {
  api[name] = payload => ipcRenderer.invoke(PREFIX + name, payload);
}

function subscribe(channel) {
  return callback => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}
api.onStatus = subscribe('nqa:status');
api.onNavigate = subscribe('nqa:navigate');
api.onUpdates = subscribe('nqa:updates');
// A key's test starts: the player agreed in the native dialog ({call, provider}: the
// call's name and its AI's id, nothing of the key).
api.onAgreed = subscribe('nqa:agreed');

contextBridge.exposeInMainWorld('nqa', Object.freeze(api));
