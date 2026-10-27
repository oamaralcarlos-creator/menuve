(() => {
  'use strict';

  // ---------- Constantes ----------
  const INACTIVITY_MS = 15000;   // sem fala após ativar -> volta ao modo de espera
  const SILENCE_MS = 1800;       // pausa após o comando -> envia ao backend
  const REQUEST_TIMEOUT_MS = 40000;
  // Aceita variações comuns de transcrição: "menuve", "menu ve", "menuvi", "menuv"...
  const WAKE_RE = /\bmenu\s?v[ei]?e?\b/;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const $ = (id) => document.getElementById(id);
  const el = {
    mic: $('micBtn'), status: $('statusText'), live: $('liveText'),
    timeout: $('timeoutWrap'), toggle: $('keywordToggle'), log: $('log'),
    form: $('textForm'), input: $('textInput'), support: $('supportMsg'),
    dialog: $('settingsDialog'), cfgUrl: $('cfgUrl'), cfgToken: $('cfgToken'),
    settingsBtn: $('settingsBtn'), cfgCancel: $('cfgCancel'), settingsForm: $('settingsForm'),
  };

  const STATUS_TEXT = {
    off: 'Inativo',
    waiting: "Aguardando 'Menuve'...",
    active: 'Ouvindo...',
    processing: 'Processando...',
    speaking: 'Falando...',
  };

  // ---------- Estado ----------
  let rec = null;
  let running = false;          // o reconhecimento está rodando agora
  let wantListening = false;    // queremos que fique rodando (reinicia sozinho)
  let keywordEnabled = false;   // interruptor da palavra-chave
  let listenMode = 'waiting';   // 'waiting' (procura "Menuve") | 'active' (captura comando)
  let manualActivation = false; // ativado pelo botão (sem palavra-chave no texto)
  let wakeIndex = 0;            // índice do resultado onde a ativação começou
  let busy = false;             // processando ou falando
  let inactivityTimer = null;
  let silenceTimer = null;
  let pendingCommand = '';

  // ---------- Utilidades ----------
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

  function getCfg() {
    return {
      url: localStorage.getItem('menuve_url') || '',
      token: localStorage.getItem('menuve_token') || '',
    };
  }

  function setStatus(s) {
    el.status.textContent = STATUS_TEXT[s];
    el.mic.dataset.state = s;
    if (s !== 'active') el.live.textContent = '';
  }

  function addMessage(kind, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + kind;
    div.textContent = text;
    el.log.appendChild(div);
    el.log.scrollTop = el.log.scrollHeight;
  }

  function startTimeoutBar() {
    el.timeout.classList.remove('run');
    void el.timeout.offsetWidth; // reinicia a animação
    el.timeout.classList.add('run');
  }
  function stopTimeoutBar() { el.timeout.classList.remove('run'); }

  function clearTimers() {
    clearTimeout(inactivityTimer);
    clearTimeout(silenceTimer);
    inactivityTimer = silenceTimer = null;
    stopTimeoutBar();
  }

  // ---------- Reconhecimento de voz ----------
  function setupRecognition() {
    rec = new SR();
    rec.lang = 'pt-BR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => { running = true; };

    rec.onend = () => {
      running = false;
      // O Chrome encerra a escuta contínua de tempos em tempos: reinicia.
      if (wantListening && !busy) setTimeout(startRec, 250);
    };

    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        wantListening = false;
        clearTimers();
        setStatus('off');
        el.toggle.checked = keywordEnabled = false;
        addMessage('error', 'Permissão do microfone negada. Libere o microfone nas configurações do navegador.');
      } else if (e.error === 'network') {
        addMessage('error', 'Erro de rede no reconhecimento de voz.');
      }
      // 'no-speech' e 'aborted' são normais: onend reinicia.
    };

    rec.onresult = onResult;
  }

  function startRec() {
    if (!wantListening || busy || running) return;
    try { rec.start(); } catch (_) { /* já iniciado */ }
  }

  function restartRec() {
    if (running) { try { rec.abort(); } catch (_) {} } // onend reinicia
    else startRec();
  }

  function stopRec() {
    wantListening = false;
    try { rec.abort(); } catch (_) {}
  }

  function onResult(e) {
    if (busy) return;

    if (listenMode === 'waiting') {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (WAKE_RE.test(norm(e.results[i][0].transcript))) {
          activate(false, i);
          handleActive(e);
          return;
        }
      }
      return;
    }
    handleActive(e);
  }

  function activate(manual, index) {
    listenMode = 'active';
    manualActivation = manual;
    wakeIndex = index;
    pendingCommand = '';
    setStatus('active');
    clearTimers();
    inactivityTimer = setTimeout(() => deactivate('Nenhum comando detectado. Voltando ao modo de espera.'), INACTIVITY_MS);
    startTimeoutBar();
  }

  function handleActive(e) {
    let raw = '';
    for (let i = wakeIndex; i < e.results.length; i++) raw += e.results[i][0].transcript + ' ';

    let cmd = raw;
    if (!manualActivation) {
      const m = WAKE_RE.exec(norm(raw));
      if (m) cmd = raw.slice(m.index + m[0].length);
    }
    cmd = cmd.replace(/^[\s,.:;!?\-]+/, '').trim();

    if (!cmd) return; // só disse "Menuve" por enquanto; o timer de 15s continua valendo

    // Há fala: cancela o timeout de inatividade e usa a pausa de silêncio para enviar.
    clearTimeout(inactivityTimer);
    stopTimeoutBar();
    pendingCommand = cmd;
    el.live.textContent = cmd;
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => send(pendingCommand), SILENCE_MS);
  }

  function deactivate(message) {
    clearTimers();
    pendingCommand = '';
    if (message) addMessage('bot', message);
    if (keywordEnabled) {
      listenMode = 'waiting';
      wantListening = true;
      setStatus('waiting');
      restartRec(); // sessão nova: zera a lista de resultados
    } else {
      stopRec();
      setStatus('off');
    }
  }

  // ---------- Envio ao backend ----------
  async function send(command) {
    command = (command || '').trim();
    if (!command || busy) return;

    busy = true;
    clearTimers();
    try { rec.abort(); } catch (_) {}
    setStatus('processing');
    addMessage('user', command);

    let reply = '';
    let isError = false;
    try {
      const { url, token } = getCfg();
      if (!url) throw new Error('Configure a URL do Web App (⚙).');

      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      // text/plain evita o preflight de CORS, que o Apps Script não suporta.
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ command, token }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const data = await res.json();
      reply = data.responseMessage || 'Pronto.';
      isError = data.status !== 'success';
    } catch (err) {
      isError = true;
      reply = err.name === 'AbortError'
        ? 'A requisição demorou demais. Tente de novo.'
        : (err.message || 'Não consegui falar com o servidor.');
    }

    addMessage(isError ? 'error' : 'bot', reply);
    speak(reply, finish);
  }

  function finish() {
    busy = false;
    if (keywordEnabled) {
      listenMode = 'waiting';
      wantListening = true;
      setStatus('waiting');
      startRec();
    } else {
      wantListening = false;
      setStatus('off');
    }
  }

  // ---------- Síntese de voz ----------
  function speak(text, done) {
    if (!('speechSynthesis' in window)) { done(); return; }
    setStatus('speaking');
    window.speechSynthesis.cancel();

    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'pt-BR';
    const voice = speechSynthesis.getVoices().find((v) => v.lang === 'pt-BR')
      || speechSynthesis.getVoices().find((v) => v.lang.startsWith('pt'));
    if (voice) u.voice = voice;

    let called = false;
    const end = () => { if (!called) { called = true; clearTimeout(guard); done(); } };
    u.onend = end;
    u.onerror = end;
    // Proteção: alguns navegadores não disparam onend em falas longas.
    const guard = setTimeout(end, Math.max(6000, text.length * 120));
    window.speechSynthesis.speak(u);
  }

  // ---------- Controles ----------
  el.mic.addEventListener('click', () => {
    if (!SR) return;
    if (busy) return;
    if (listenMode === 'active' && wantListening) {
      deactivate(); // clique de novo desativa a escuta ativa
      return;
    }
    wantListening = true;
    activate(true, 0);
    restartRec();
  });

  el.toggle.addEventListener('change', () => {
    if (!SR) { el.toggle.checked = false; return; }
    keywordEnabled = el.toggle.checked;
    if (busy) return;
    if (keywordEnabled) {
      if (listenMode !== 'active' || !wantListening) {
        listenMode = 'waiting';
        wantListening = true;
        setStatus('waiting');
        restartRec();
      }
    } else if (listenMode === 'waiting') {
      stopRec();
      setStatus('off');
    }
  });

  el.form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = el.input.value.trim();
    el.input.value = '';
    send(v);
  });

  // Configurações
  el.settingsBtn.addEventListener('click', openSettings);
  el.cfgCancel.addEventListener('click', () => el.dialog.close());
  el.settingsForm.addEventListener('submit', () => {
    localStorage.setItem('menuve_url', el.cfgUrl.value.trim());
    localStorage.setItem('menuve_token', el.cfgToken.value.trim());
  });
  function openSettings() {
    const c = getCfg();
    el.cfgUrl.value = c.url;
    el.cfgToken.value = c.token;
    el.dialog.showModal();
  }

  // ---------- Inicialização ----------
  if (!SR) {
    el.support.hidden = false;
    el.mic.disabled = true;
    el.toggle.disabled = true;
  } else {
    setupRecognition();
  }
  if ('speechSynthesis' in window) speechSynthesis.getVoices(); // pré-carrega vozes
  setStatus('off');
  if (!getCfg().url) openSettings();
})();
