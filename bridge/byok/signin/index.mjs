// The sign-ins (a plan in place of an API key): one per manifest whose auth names a flow
// (auth.signIn, providers/index.mjs SIGN_INS), made on first use and shared by the backend (each
// request's token) and the app API (the browser flow, a key test, sign-out), so a refresh one of
// them does is the other's too.
//
//   createSignIns({ keystore, fetch, log, now }) → { for(manifest) → session | null }
import { createChatgptSignIn } from './chatgpt.mjs';

const FLOWS = Object.freeze({ chatgpt: createChatgptSignIn });

export function createSignIns({ keystore, fetch, log = () => {}, now = Date.now, flows = FLOWS } = {}) {
  const sessions = new Map();
  return Object.freeze({
    for(manifest) {
      const flow = manifest?.auth?.signIn;
      if (typeof flow !== 'string' || !Object.hasOwn(flows, flow) || !keystore) return null;
      let s = sessions.get(manifest.id);
      if (!s) {
        s = flows[flow]({ id: manifest.id, keystore, fetch, log, now });
        sessions.set(manifest.id, s);
      }
      return s;
    },
  });
}
