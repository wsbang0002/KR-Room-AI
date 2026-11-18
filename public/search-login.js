function startSearchLogin(onChange, onMessage) {
  const byId = id => document.getElementById(id);
  const signIn = byId('login-button'), signOut = byId('logout-button');
  const dialog = byId('login-dialog'), form = byId('login-form');
  const key = byId('login-key'), error = byId('login-error'), submit = byId('login-submit'), close = byId('login-close');
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('knu-search-session') : null;
  let authenticated = false;
  let timeout, version = 0, mutating = false;

  function apply(session, reason) {
    clearTimeout(timeout);
    const signedIn = session.authenticated === true && session.expiresAt > Date.now();
    if (signedIn) timeout = setTimeout(expire, session.expiresAt - Date.now());
    signIn.hidden = signedIn;
    signOut.hidden = !signedIn;
    if (signedIn === authenticated) return;
    authenticated = signedIn;
    onChange(signedIn, reason);
  }

  function expire() {
    ++version;
    apply({}, 'expired');
  }

  async function sessionRequest(method, headers = {}) {
    const response = await fetch('/api/session', {
      method, headers, credentials:'same-origin', cache:'no-store', redirect:'error', signal:AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      const failure = new Error('로그인 상태를 확인할 수 없어요. 잠시 후 다시 시도해 주세요.');
      failure.status = response.status;
      throw failure;
    }
    return response.json();
  }

  async function refresh() {
    if (mutating) return;
    const current = ++version;
    try {
      const session = await sessionRequest('GET');
      if (current === version) apply(session, 'refresh');
    } catch {
      if (current === version) apply({}, 'refresh');
    }
  }

  signIn.addEventListener('click', () => {
    error.textContent = '';
    dialog.showModal();
    key.focus();
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (mutating) event.preventDefault(); });
  dialog.addEventListener('close', () => { form.reset(); error.textContent = ''; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (mutating) return;
    if (!/^[!-~]{24,512}$/.test(key.value)) {
      error.textContent = '로그인 키를 확인해 주세요. 공백 없이 입력해 주세요.';
      key.focus();
      return;
    }
    ++version;
    mutating = true;
    close.disabled = true;
    submit.disabled = true;
    error.textContent = '';
    try {
      const reply = sessionRequest('POST', {Authorization:'Bearer ' + key.value});
      key.value = '';
      const session = await reply;
      if (!session.authenticated || !(session.expiresAt > Date.now())) throw Error();
      dialog.close();
      apply(session, 'login');
      channel?.postMessage('changed');
      byId('query').focus({preventScroll:true});
    } catch (failure) {
      error.textContent = failure.status === 401 ? '로그인 키가 일치하지 않아요. 다시 입력해 주세요.' :
        failure.status === 429 ? '로그인 시도가 많아요. 잠시 후 다시 시도해 주세요.' :
        '로그인하지 못했어요. 잠시 후 다시 시도해 주세요.';
      key.focus();
    } finally { mutating = false; submit.disabled = false; close.disabled = false; }
  });

  signOut.addEventListener('click', async () => {
    if (mutating) return;
    ++version;
    mutating = true;
    signOut.disabled = true;
    apply({}, 'logout');
    signIn.hidden = true;
    signOut.hidden = false;
    try {
      await sessionRequest('DELETE');
      signOut.hidden = true;
      signIn.hidden = false;
      channel?.postMessage('changed');
      signIn.focus({preventScroll:true});
    } catch { onMessage('로그아웃을 완료하지 못했어요. 로그아웃을 다시 눌러 주세요.'); }
    finally { mutating = false; signOut.disabled = false; }
  });
  channel?.addEventListener('message', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('pagehide', event => { if (event.persisted) expire(); });
  window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
  return {initial:refresh(), expire};
}
