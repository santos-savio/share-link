// Lógica de chat compartilhada pela tela do anfitrião e pela do convidado.
// Nenhuma URL aqui começa com "/": tudo é resolvido a partir do endereço da
// página, para que a aplicação funcione servida em subcaminho.

const elements = {
  status: document.getElementById('status'),
  reconnect: document.getElementById('reconnect'),
  restart: document.getElementById('restart'),
  chat: document.getElementById('chat'),
  messages: document.getElementById('messages'),
  composer: document.getElementById('composer'),
  text: document.getElementById('text'),
  error: document.getElementById('error')
};

/** Ids já desenhados na tela: o histórico volta inteiro a cada rejunção. */
const renderedMessageIds = new Set();

/** Endereço do hub relativo a esta página. */
export function hubUrl() {
  return new URL('hub/session', document.baseURI).href;
}

/**
 * O SignalR entrega o texto do HubException embrulhado num prefixo genérico
 * ("An unexpected error occurred invoking..."). Aqui sobra só o motivo.
 */
export function hubErrorMessage(error) {
  const raw = error?.message ?? String(error);
  const marker = 'HubException: ';
  const at = raw.indexOf(marker);
  return at >= 0 ? raw.slice(at + marker.length) : raw;
}

export function setStatus(state, label) {
  elements.status.dataset.state = state;
  elements.status.textContent = label;
}

export function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = false;
}

export function clearError() {
  elements.error.hidden = true;
  elements.error.textContent = '';
}

// O token identifica o participante entre conexões. Fica em sessionStorage
// (escopo da aba) para que recarregar a página também retome o mesmo lugar.
const tokenKey = (code, role) => `sharelink:${code}:${role}`;

function rememberToken(code, role, token) {
  try { sessionStorage.setItem(tokenKey(code, role), token); } catch { /* navegação privada */ }
}

function recallToken(code, role) {
  try { return sessionStorage.getItem(tokenKey(code, role)); } catch { return null; }
}

function forgetToken(code, role) {
  try { sessionStorage.removeItem(tokenKey(code, role)); } catch { /* navegação privada */ }
}

function scrollToEnd() {
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function appendSystemLine(text) {
  const item = document.createElement('li');
  item.className = 'message system';
  item.textContent = text;
  elements.messages.append(item);
  scrollToEnd();
}

function appendMessage(message, myRole) {
  // Conciliação por id: o que já está na tela não entra de novo.
  if (renderedMessageIds.has(message.id)) return;
  renderedMessageIds.add(message.id);

  const item = document.createElement('li');
  item.className = message.sender === myRole ? 'message mine' : 'message';

  const body = document.createElement('p');
  body.className = 'message-text';
  // textContent, nunca innerHTML: o texto vem do outro dispositivo.
  body.textContent = message.text;

  const time = document.createElement('time');
  time.dateTime = message.sentAt;
  time.textContent = new Date(message.sentAt)
    .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  item.append(body, time);
  elements.messages.append(item);
  scrollToEnd();
}

const roleLabel = role => (role === 'host' ? 'O computador' : 'O celular');

/**
 * Conecta ao hub, entra na sessão e liga a interface de chat.
 * @param {{code: string, role: 'host'|'guest', onPeerChange?: (present: boolean) => void}} params
 */
export async function startChat({ code, role, onPeerChange }) {
  // As bibliotecas vêm de CDN: sem internet ou com o CDN fora, o erro nativo
  // seria "signalR is not defined", que não diz nada a quem está usando.
  if (typeof signalR === 'undefined') {
    throw new Error('A biblioteca de tempo real não carregou. Verifique a conexão com a internet e recarregue a página.');
  }

  let token = recallToken(code, role);
  let joined = false;

  const connection = new signalR.HubConnectionBuilder()
    .withUrl(hubUrl())
    .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
    .build();

  async function joinAndRender() {
    const result = await connection.invoke('JoinSession', code, role, token);

    token = result.token;
    rememberToken(code, role, token);

    result.messages.forEach(message => appendMessage(message, role));
    onPeerChange?.(result.peerConnected);

    joined = true;
    elements.reconnect.hidden = true;
    setStatus('online', 'conectado');
    clearError();

    return result;
  }

  connection.on('ReceiveMessage', message => appendMessage(message, role));

  connection.on('PeerJoined', peerRole => {
    appendSystemLine(`${roleLabel(peerRole)} entrou na sessão.`);
    onPeerChange?.(true);
  });

  connection.on('PeerLeft', peerRole => {
    appendSystemLine(`${roleLabel(peerRole)} saiu da sessão.`);
    onPeerChange?.(false);
  });

  connection.on('SessionEnded', reason => {
    appendSystemLine(`Sessão encerrada: ${reason}`);
    setStatus('offline', 'sessão encerrada');
    elements.composer.hidden = true;
    elements.reconnect.hidden = true;
    elements.restart.hidden = false;
    forgetToken(code, role);
    joined = false;
  });

  connection.onreconnecting(() => setStatus('connecting', 'reconectando…'));

  // A reconexão traz um ConnectionId novo, que não pertence a grupo nenhum.
  // Sem entrar outra vez, a conexão volta "viva" e o chat morre em silêncio.
  connection.onreconnected(async () => {
    try {
      await joinAndRender();
    } catch (error) {
      showError(hubErrorMessage(error));
      setStatus('offline', 'desconectado');
      await connection.stop();
    }
  });

  connection.onclose(() => {
    setStatus('offline', 'desconectado');
    if (joined) elements.reconnect.hidden = false;
  });

  setStatus('connecting', 'conectando…');
  await connection.start();

  try {
    await joinAndRender();
  } catch (error) {
    // Sem isto, cada tentativa recusada deixaria uma conexão pendurada.
    await connection.stop();
    throw error;
  }

  elements.chat.hidden = false;

  // Registrados só depois da entrada bem-sucedida: uma tentativa recusada pode
  // ser repetida, e listeners acumulados disparariam a ação mais de uma vez.
  elements.reconnect.addEventListener('click', async () => {
    elements.reconnect.disabled = true;
    setStatus('connecting', 'reconectando…');

    try {
      await connection.start();
      await joinAndRender();
    } catch (error) {
      setStatus('offline', 'desconectado');
      showError(hubErrorMessage(error));
    } finally {
      elements.reconnect.disabled = false;
    }
  });

  elements.composer.addEventListener('submit', async event => {
    event.preventDefault();

    const text = elements.text.value.trim();
    if (text.length === 0) return;

    elements.text.value = '';

    try {
      await connection.invoke('SendMessage', code, text);
      clearError();
    } catch (error) {
      // Devolve o texto ao campo para que nada se perca.
      elements.text.value = text;
      showError(hubErrorMessage(error));
    }
  });

  elements.text.focus();
  return connection;
}

/** Há token guardado para este papel nesta sessão? Indica retomada, não entrada nova. */
export function hasStoredToken(code, role) {
  return recallToken(code, role) !== null;
}
