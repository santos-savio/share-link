// Lógica de chat compartilhada pela tela do anfitrião e pela do convidado.
// Nenhuma URL aqui começa com "/": tudo é resolvido a partir do endereço da
// página, para que a aplicação funcione servida em subcaminho.

const elements = {
  status: document.getElementById('status'),
  chat: document.getElementById('chat'),
  messages: document.getElementById('messages'),
  composer: document.getElementById('composer'),
  text: document.getElementById('text'),
  error: document.getElementById('error')
};

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
  const connection = new signalR.HubConnectionBuilder()
    .withUrl(hubUrl())
    .build();

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
  });

  connection.onclose(() => setStatus('offline', 'desconectado'));

  setStatus('connecting', 'conectando…');
  await connection.start();

  const result = await connection.invoke('JoinSession', code, role);

  result.messages.forEach(message => appendMessage(message, role));
  onPeerChange?.(result.peerConnected);

  elements.chat.hidden = false;
  setStatus('online', 'conectado');
  clearError();

  elements.composer.addEventListener('submit', async event => {
    event.preventDefault();

    const text = elements.text.value.trim();
    if (text.length === 0) return;

    elements.text.value = '';

    try {
      await connection.invoke('SendMessage', result.code, text);
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
