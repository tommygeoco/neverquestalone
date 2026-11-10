// The voice page (odd/tasks/nqa-voice.md T3): WebRTC to the OpenAI Realtime API with a short-lived
// client secret from our own server (/session), the model's tool calls relayed to /tool, each finished
// exchange sent to /exchange (the app shows it in the addon's Companion chat), and usage to /usage.
'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const ui = { connect: $('connect'), mute: $('mute'), status: $('status'), log: $('log'), level: $('level'), cost: $('cost'), game: $('game') };
  let pc = null, dc = null, mic = null, audioEl = null, meterStop = null, muted = false;
  // Talk mode (odd/tasks/nqa-voice-controls.md T9): one question with the microphone open.
  let talkOnce = false, heardSince = false;
  // Opened by the launcher (?auto=1): it connects by itself with the microphone closed. No location
  // (the tests' sandbox): a page opened by hand.
  const startClosed = typeof location !== 'undefined' && new URLSearchParams(location.search || '').get('auto') === '1';
  let botLine = null, botText = '', stoppedAt = 0, latencies = [];
  // Your words and its answers are paired by the conversation's item ids, never by order: a
  // transcription can arrive after the answer it belongs to (Realtime server events docs).
  let lastCommitted = null;
  const userLines = new Map();   // item_id → your caption line
  const transcripts = new Map(); // item_id → what you said
  const answerOf = new Map();    // response id → the item_id it answers
  const waitingWords = new Map(); // item_id → an answer waiting for your words
  const handled = new Set();
  // Replies read aloud (T16): their response ids, and whether any response is on its way now.
  const sayIds = new Set();
  let responding = false;
  const isSay = ev => (ev.response && ev.response.metadata && ev.response.metadata.nqa === 'say') || sayIds.has(ev.response_id || (ev.response && ev.response.id));

  function status(text, cls) { ui.status.textContent = text; ui.status.className = cls || ''; }
  function line(cls, who, text) {
    const p = document.createElement('p');
    p.className = 'line ' + cls;
    if (who) { const b = document.createElement('b'); b.textContent = who + ': '; p.appendChild(b); }
    p.appendChild(document.createTextNode(text));
    ui.log.appendChild(p);
    ui.log.scrollTop = ui.log.scrollHeight;
    return p;
  }
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }
  function send(ev) { if (dc && dc.readyState === 'open') dc.send(JSON.stringify(ev)); }

  function startMeter(stream) {
    try {
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      let on = true;
      const tick = () => {
        if (!on) return;
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        ui.level.style.width = (muted ? 0 : Math.min(100, peak * 1.6)) + '%';
        requestAnimationFrame(tick);
      };
      tick();
      return () => { on = false; ctx.close(); ui.level.style.width = '0'; };
    } catch { return () => {}; }
  }

  async function runTools(calls, item = lastCommitted) {
    for (const c of calls) {
      let args = {};
      try { args = JSON.parse(c.arguments || '{}'); } catch { args = {}; }
      line('sys', '', c.name === 'get_game_state' ? 'Consultando tus datos del juego…' : c.name === 'place_map_pins' ? 'Poniendo pines en tu mapa…' : 'Consultando Wowhead…');
      let out;
      // The brain also gets what the transcription heard: the voice's own wording can mishear a game
      // name ("The Hive" for Deviate Hides). Its words may come a moment after the call: wait up to 0.8 s.
      // The words of the turn this call answers (fixed when its response started), never a newer one.
      if (c.name === 'ask_brain' && item) {
        const until = performance.now() + 800;
        while (!transcripts.has(item) && performance.now() < until) await new Promise(r => setTimeout(r, 50));
        const heard = transcripts.get(item);
        if (heard) args = { ...args, heard };
      }
      try { out = await post('/tool', { name: c.name, args }); } catch (e) { out = { error: String(e.message || e) }; }
      if (c.name === 'get_game_state') ui.game.textContent = out.available ? ('Datos del juego: hace ' + (out.ageSeconds ?? '?') + ' s') : 'Datos del juego: no disponibles';
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(out) } });
    }
    send({ type: 'response.create' });
  }

  function sendExchange(user, said) { post('/exchange', { user, assistant: said }).catch(() => {}); }

  function onEvent(ev) {
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        heardSince = true;
        status('Te escucho…', 'live');
        // Your line goes in now, in order; its words come when the transcription does.
        if (ev.item_id && !userLines.has(ev.item_id)) userLines.set(ev.item_id, line('you', 'Tú', '…'));
        break;
      case 'input_audio_buffer.committed':
        lastCommitted = ev.item_id || lastCommitted;
        break;
      case 'response.created':
        responding = true;
        if (isSay(ev)) { if (ev.response && ev.response.id) sayIds.add(ev.response.id); break; }
        if (ev.response && ev.response.id) answerOf.set(ev.response.id, lastCommitted);
        break;
      case 'input_audio_buffer.speech_stopped':
        stoppedAt = performance.now();
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const words = (ev.transcript || '').trim();
        const el = userLines.get(ev.item_id);
        if (words) { if (el) el.lastChild.textContent = words; else line('you', 'Tú', words); }
        else if (el) el.remove();
        userLines.delete(ev.item_id);
        transcripts.set(ev.item_id, words);
        if (waitingWords.has(ev.item_id)) { sendExchange(words, waitingWords.get(ev.item_id)); waitingWords.delete(ev.item_id); }
        break;
      }
      case 'response.output_audio_transcript.delta':
        if (isSay(ev)) { status('Leyendo la respuesta…', 'live'); break; }
        if (stoppedAt) {
          // How long from the end of your words to its first words (the "fluid" number, odd T8).
          latencies.push(Math.round(performance.now() - stoppedAt));
          stoppedAt = 0;
          ui.game.dataset.latency = String(latencies.at(-1));
          ui.cost.title = 'Respuesta en ' + latencies.at(-1) + ' ms';
        }
        if (!botLine) { botText = ''; botLine = line('bot', 'NeverQuestAlone', ''); }
        botText += ev.delta || '';
        botLine.lastChild.textContent = botText;
        ui.log.scrollTop = ui.log.scrollHeight;
        status('Hablando… (interrúmpelo cuando quieras)', 'live');
        break;
      case 'response.done': {
        const r = ev.response || {};
        responding = false;
        if (r.id && handled.has(r.id)) break;
        if (r.id) handled.add(r.id);
        if (r.usage) post('/usage', { usage: r.usage }).then(u => { ui.cost.textContent = 'Gasto de hoy: $' + u.todayUsd.toFixed(3) + ' (' + u.responses + ' respuestas)'; }).catch(() => {});
        if (isSay(ev)) { sayIds.delete(r.id); status(muted ? 'Micrófono silenciado' : 'Escuchando', muted ? '' : 'live'); break; }
        const calls = (r.output || []).filter(o => o.type === 'function_call');
        if (calls.length) {
          // What it said before looking ("let me check") and the answer after share one line, spaced.
          if (botText.trim()) botText += ' ';
          runTools(calls, answerOf.get(r.id) || lastCommitted);
          break;
        }
        const said = botText.trim();
        if (said) {
          const item = answerOf.get(r.id) || null;
          if (!item || transcripts.has(item)) sendExchange(item ? transcripts.get(item) : '', said);
          else {
            // Its answer came before your words: it waits for them, a few seconds at most.
            waitingWords.set(item, said);
            setTimeout(() => { if (waitingWords.has(item)) { sendExchange('', waitingWords.get(item)); waitingWords.delete(item); } }, 6000);
          }
        }
        answerOf.delete(r.id);
        if (r.status === 'cancelled' && said && botLine) botLine.lastChild.textContent = said + ' …';
        botLine = null; botText = '';
        status('Escuchando', 'live');
        // A Talk question was answered: the microphone closes until the next Talk.
        // Not on a cancelled one: that is you talking over it (barge-in), and its next answer ends it.
        if (talkOnce && r.status !== 'cancelled') endTalk();
        break;
      }
      case 'error':
        line('sys', '', 'Error: ' + ((ev.error && ev.error.message) || 'desconocido'));
        endTalk();
        break;
    }
  }

  // Each connect gets a number; a pause (or a new connect) while one is on its way makes its number old,
  // and it stops at its next step instead of going on (Astra review 1). The microphone track is disabled
  // before it joins the call when it should start closed, so not a moment of sound leaves before that.
  let gen = 0, connecting = false;
  let persona = null, keepMuted = null; // the game's pick (S4), and the mic state a persona switch keeps
  async function connect() {
    const my = ++gen;
    connecting = true;
    ui.connect.disabled = true;
    status('Conectando…');
    const live = () => my === gen;
    try {
      const s = await post('/session', persona ? { persona } : {});
      if (s.persona) persona = s.persona;
      if (!live()) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!live()) { stream.getTracks().forEach(t => t.stop()); return; }
      mic = stream;
      muted = keepMuted !== null ? keepMuted : (startClosed && !talkOnce);
      keepMuted = null;
      mic.getTracks().forEach(t => { t.enabled = !muted; });
      ui.mute.firstChild.textContent = muted ? 'Activar mic (' : 'Silenciar mic (';
      pc = new RTCPeerConnection();
      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      pc.ontrack = e => { audioEl.srcObject = e.streams[0]; };
      pc.addTrack(mic.getTracks()[0], mic);
      dc = pc.createDataChannel('oai-events');
      dc.onmessage = e => { try { onEvent(JSON.parse(e.data)); } catch { /* not ours */ } };
      dc.onopen = () => { if (pendingTip) setTimeout(askTips, 300); status(muted ? 'Micrófono silenciado' : 'Escuchando', muted ? '' : 'live'); line('sys', '', 'Conectado (' + s.model + ').' + (muted ? ' Pulsa Hablar en el juego.' : ' Háblale.')); };
      pc.onconnectionstatechange = () => { if (['failed', 'disconnected', 'closed'].includes(pc && pc.connectionState)) hangup('Se cortó la conexión'); };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!live()) return;
      const r = await fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST', body: offer.sdp, headers: { authorization: 'Bearer ' + s.value, 'content-type': 'application/sdp' } });
      if (!live()) return;
      if (!r.ok) throw new Error('OpenAI respondió ' + r.status + ': ' + (await r.text()).slice(0, 200));
      await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() });
      if (!live()) return;
      meterStop = startMeter(mic);
      ui.connect.textContent = 'Colgar';
      ui.mute.disabled = false;
    } catch (e) {
      if (live()) { hangup(); status('No se pudo conectar: ' + (e.message || e), 'err'); }
    } finally {
      if (live()) { connecting = false; ui.connect.disabled = false; }
    }
  }

  function hangup(why) {
    gen += 1; // a connect still on its way stops
    connecting = false;
    try { dc && dc.close(); } catch {}
    try { pc && pc.close(); } catch {}
    if (mic) mic.getTracks().forEach(t => t.stop());
    if (meterStop) meterStop();
    pc = dc = mic = null; meterStop = null; muted = false;
    endTalk(); // Talk never outlives the call
    ui.connect.textContent = 'Conectar';
    ui.connect.disabled = false;
    ui.mute.disabled = true;
    ui.mute.firstChild.textContent = 'Silenciar mic (';
    status(why || 'Desconectado', why ? 'err' : '');
  }

  function toggleMute() {
    if (!mic) return;
    muted = !muted;
    mic.getTracks().forEach(t => { t.enabled = !muted; });
    ui.mute.firstChild.textContent = muted ? 'Activar mic (' : 'Silenciar mic (';
    status(muted ? 'Micrófono silenciado' : 'Escuchando', muted ? '' : 'live');
  }

  ui.connect.addEventListener('click', () => (pc || connecting ? hangup() : connect()));
  ui.mute.addEventListener('click', toggleMute);
  document.addEventListener('keydown', e => { if ((e.key === 'm' || e.key === 'M') && !e.repeat) toggleMute(); });

  // Driven from the game (odd/tasks/nqa-voice-controls.md T3, T11): the addon's buttons and keys reach the
  // server through the app. Mute turns the microphone off; pause hangs up (nothing is spent) and resume
  // starts a new conversation. A command already there when the page opens is not applied again; only a
  // newer one (a growing n), and only while fresh (CONTROL_FRESH_MS), is applied.
  const TALK_IDLE_MS = 20000, TALK_MAX_MS = 60000, CONTROL_FRESH_MS = 15000;
  let seenCmd = null, reported = '', reportedAt = 0, talkIdle = null, talkMax = null, polling = false;
  const voiceState = () => (connecting ? 'connecting' : !pc ? 'paused' : (muted ? 'muted' : 'listening'));
  // Talk (S3): the microphone opens for one question and closes when its answer ends, after 20 s of
  // nothing said, after 60 s whatever happens, and on an error or a hang-up (Astra review 2).
  function endTalk() {
    clearTimeout(talkIdle); clearTimeout(talkMax); talkIdle = talkMax = null;
    if (talkOnce) { talkOnce = false; if (mic && !muted) toggleMute(); }
  }
  function talk() {
    talkOnce = true;
    heardSince = false;
    clearTimeout(talkIdle); clearTimeout(talkMax);
    talkIdle = setTimeout(() => { if (!heardSince) endTalk(); }, TALK_IDLE_MS);
    talkMax = setTimeout(endTalk, TALK_MAX_MS);
    if (!pc) { if (!connecting) connect(); return; }
    if (muted) toggleMute();
  }
  // A new persona needs a new session (a Realtime session keeps its voice once it has spoken): it
  // reconnects with the mic as it was; paused, it is used at the next resume.
  function pickPersona(name) {
    if (!name || name === persona) return;
    persona = name;
    if (pc || connecting) { keepMuted = talkOnce ? true : muted; hangup(); status('Cambiando de voz…'); connect(); }
  }
  // A written reply read aloud in the voice's own persona: an out-of-band response (conversation none),
  // so it doesn't become part of the talk; its words are the companion chat's, not the player's.
  function readAloud(text) {
    responding = true;
    send({ type: 'response.create', response: { conversation: 'none', metadata: { nqa: 'say' }, output_modalities: ['audio'], input: [],
      instructions: 'Read this short reply from the player\'s companion chat aloud to them now, in your own voice and character, in its language, without adding anything: ' + String(text).slice(0, 600) } });
  }
  // Tips (S9, T21): the game's Tips button asks the voice for the best things to do now; it looks at the
  // game data with its tools and answers out loud. Paused, it connects first and asks once connected.
  let pendingTip = false;
  function askTips() {
    pendingTip = false;
    send({ type: 'response.create', response: { instructions: 'The player pressed Tips in the game. Say two or three words, then call the tool you have to ask the brain (ask_brain, or get_game_state without the brain) for the two or three most useful things to do right now (the closest quest steps, a turn-in, repairs or selling, training or an upgrade), and say its answer: short and spoken, in their language, in your character.' } });
  }
  function apply(cmd, c) {
    if (cmd === 'tip') { if (pc && dc && dc.readyState === 'open') askTips(); else { pendingTip = true; if (!pc && !connecting) connect(); } return; }
    if (cmd === 'persona') return pickPersona(c && c.persona);
    if (cmd === 'talk') talk();
    else if (cmd === 'mute') { endTalk(); if (mic && !muted) toggleMute(); }
    else if (cmd === 'unmute') { talkOnce = false; endTalk(); if (mic && muted) toggleMute(); }
    else if (cmd === 'pause') { if (pc || connecting) hangup('En pausa desde el juego'); }
    else if (cmd === 'resume') { if (!pc && !connecting) connect(); }
  }
  async function follow() {
    if (polling) return; // one question to the server at a time (Astra review 3)
    polling = true;
    try {
      const c = await post('/control');
      if (Number.isInteger(c.n)) {
        if (seenCmd === null) seenCmd = c.n; // the page just opened: that one is old news
        else if (c.n > seenCmd) {
          seenCmd = c.n;
          if (!(Number(c.at) > 0) || Date.now() - Number(c.at) <= CONTROL_FRESH_MS) apply(c.cmd, c);
        }
      } else if (seenCmd === null) seenCmd = 0;
    } catch { /* the server restarts now and then */ }
    finally { polling = false; }
    if (pc && dc && dc.readyState === 'open' && !responding && !talkOnce) {
      try {
        const say = await post('/say');
        if (say && say.text) readAloud(say.text);
      } catch { /* next time */ }
    }
    const st = voiceState();
    if (st + persona !== reported || Date.now() - reportedAt > 5000) {
      reported = st + persona; reportedAt = Date.now();
      post('/status', persona ? { state: st, persona } : { state: st }).catch(() => {});
    }
  }
  // Only in a real page (the tests' sandbox has no fetch to follow with).
  if (typeof fetch === 'function' && typeof setInterval === 'function') { setInterval(follow, 500); follow(); }
  if (startClosed) connect();
  window.NQAVoice = { onEvent, apply, voiceState, follow, readAloud, talking: () => talkOnce, status: () => ({ connected: !!pc, muted, latencies: latencies.slice() }) }; // for the tests
})();
