// Lógica de chat compartilhada pela tela do anfitrião e pela do convidado.
// Nenhuma URL aqui começa com "/": tudo é resolvido a partir do endereço da
// página, para que a aplicação funcione servida em subcaminho.

import { createTransport, Transport } from './transport.js';

const elements = {
  status: document.getElementById('status'),
  reconnect: document.getElementById('reconnect'),
  restart: document.getElementById('restart'),
  chat: document.getElementById('chat'),
  messages: document.getElementById('messages'),
  composer: document.getElementById('composer'),
  text: document.getElementById('text'),
  file: document.getElementById('file'),
  attach: document.getElementById('attach'),
  error: document.getElementById('error')
};

/** Ids já desenhados na tela: o histórico volta inteiro a cada rejunção. */
const renderedMessageIds = new Set();

/** Tetos de arquivo, ditados pelo servidor na entrada — nunca fixos aqui. */
const limits = { direct: 0, relay: 0 };

/** Transporte vigente, que diz qual dos dois tetos vale neste momento. */
let transportState = Transport.Relay;

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

  if (at >= 0) return raw.slice(at + marker.length);

  // Esta frase é a falha de vinculação de argumentos do SignalR, e na prática
  // significa uma coisa só: a página em cache está chamando o hub com a
  // assinatura de outra versão.
  if (raw.includes('due to an error on the server')) {
    return 'Esta página está desatualizada em relação ao servidor. '
      + 'Recarregue forçando a atualização (Ctrl+Shift+R no computador; '
      + 'no celular, feche a aba e abra de novo).';
  }

  return raw;
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

/** Traz o bloco de chat para a tela. Idempotente: repetir não rouba o foco. */
function revealChat() {
  if (!elements.chat.hidden) return;

  elements.chat.hidden = false;
  elements.text.focus();
}

/**
 * Copia texto para a área de transferência.
 *
 * `navigator.clipboard` só existe em contexto seguro — HTTPS ou localhost. Na
 * rede local o endereço é `http://<ip>`, que não qualifica, e é justamente o
 * uso principal desta aplicação. Daí o caminho antigo com `execCommand`, que
 * continua funcionando em todos os navegadores e não exige contexto seguro.
 */
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.setAttribute('aria-hidden', 'true');
  scratch.style.position = 'fixed';
  scratch.style.top = '0';
  scratch.style.opacity = '0';
  document.body.append(scratch);

  try {
    scratch.focus();
    scratch.setSelectionRange(0, scratch.value.length);

    if (!document.execCommand('copy')) {
      throw new Error('cópia recusada pelo navegador');
    }
  } finally {
    scratch.remove();
  }
}

function createCopyButton(text) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy';
  button.textContent = 'Copiar';
  button.setAttribute('aria-label', 'Copiar mensagem');

  button.addEventListener('click', async () => {
    try {
      await copyText(text);
      button.textContent = 'Copiado';
      button.classList.add('copied');
    } catch {
      button.textContent = 'Falhou';
    }

    setTimeout(() => {
      button.textContent = 'Copiar';
      button.classList.remove('copied');
    }, 1500);
  });

  return button;
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

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  // Copia do dado recebido, não do que está na tela: o texto vai íntegro,
  // sem depender de como foi renderizado.
  meta.append(time, createCopyButton(message.text));

  item.append(body, meta);
  elements.messages.append(item);
  scrollToEnd();
}

const roleLabel = role => (role === 'host' ? 'O computador' : 'O celular');

/** Tamanho legível. O arredondamento é para leitura; quem valida usa os bytes. */
function formatSize(bytes) {
  const mb = bytes / (1024 * 1024);

  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
  }

  return `${Math.round(mb)} MB`;
}

/**
 * Teto que vale agora. Enquanto a avaliação do canal direto não termina, vale o
 * menor dos dois: prometer o maior e não cumprir seria pior que prometer pouco.
 */
function currentLimit() {
  return transportState === Transport.Direct ? limits.direct : limits.relay;
}

/**
 * Escreve o limite vigente no próprio botão. É o que evita a pior experiência
 * possível aqui: escolher um arquivo e só então descobrir que ele não passa.
 */
function refreshAttachLabel() {
  if (transportState === Transport.Probing) {
    elements.attach.textContent = 'Verificando conexão direta…';
    return;
  }

  const rota = transportState === Transport.Direct ? 'direto' : 'pelo servidor';
  elements.attach.textContent = `Anexar — até ${formatSize(currentLimit())}, ${rota}`;
}

/**
 * Conecta ao hub, entra na sessão e liga a interface de chat.
 * @param {{
 *   code: string,
 *   role: 'host'|'guest',
 *   onPeerChange?: (present: boolean) => void,
 *   onTransportChange?: (state: string) => void,
 *   revealOnPair?: boolean
 * }} params
 */
export async function startChat({ code, role, onPeerChange, onTransportChange, revealOnPair = false }) {
  // As bibliotecas vêm de CDN: sem internet ou com o CDN fora, o erro nativo
  // seria "signalR is not defined", que não diz nada a quem está usando.
  if (typeof signalR === 'undefined') {
    throw new Error('A biblioteca de tempo real não carregou. Verifique a conexão com a internet e recarregue a página.');
  }

  let token = recallToken(code, role);
  let joined = false;
  let peerPresent = false;

  const connection = new signalR.HubConnectionBuilder()
    .withUrl(hubUrl())
    .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
    .build();

  // Criado antes de a conexão subir, para que o ouvinte de sinalização já esteja
  // no lugar quando o outro lado propuser o canal.
  const transport = createTransport({
    connection,
    code,
    role,
    onStateChange: state => {
      transportState = state;
      refreshAttachLabel();
      onTransportChange?.(state);
    }
  });

  async function joinAndRender() {
    const result = await connection.invoke('JoinSession', code, role, token);

    token = result.token;
    rememberToken(code, role, token);

    // Os tetos vêm do servidor, não de constante no cliente: assim o número
    // exibido antes da escolha é sempre o mesmo que será aplicado depois.
    limits.direct = result.maxDirectFileBytes;
    limits.relay = result.maxRelayFileBytes;
    refreshAttachLabel();

    result.messages.forEach(message => appendMessage(message, role));
    peerPresent = result.peerConnected;
    onPeerChange?.(result.peerConnected);

    // Vale tanto para a entrada quanto para a volta de uma queda: reconectar
    // traz conexão nova, e o par negociado antes morreu junto com a antiga.
    if (result.peerConnected) transport.probe();

    joined = true;
    elements.reconnect.hidden = true;
    setStatus('online', 'conectado');
    clearError();

    return result;
  }

  connection.on('ReceiveMessage', message => appendMessage(message, role));

  connection.on('PeerJoined', peerRole => {
    appendSystemLine(`${roleLabel(peerRole)} entrou na sessão.`);
    peerPresent = true;
    // Seguro chamar daqui: um evento do servidor só é entregue depois que o
    // bloco síncrono da entrada terminou, ou seja, com os listeners já ligados.
    revealChat();
    onPeerChange?.(true);
    transport.probe();
  });

  connection.on('PeerLeft', peerRole => {
    appendSystemLine(`${roleLabel(peerRole)} saiu da sessão.`);
    peerPresent = false;
    // O chat permanece à vista: esconder a conversa a cada oscilação de rede
    // seria pior que a tela ficar mais alta.
    onPeerChange?.(false);
    transport.reset();
  });

  connection.on('SessionEnded', reason => {
    appendSystemLine(`Sessão encerrada: ${reason}`);
    setStatus('offline', 'sessão encerrada');
    elements.composer.hidden = true;
    elements.reconnect.hidden = true;
    elements.restart.hidden = false;
    forgetToken(code, role);
    transport.reset();
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

  // O input de arquivo fica escondido porque o controle nativo não aceita texto
  // próprio, e é o rótulo que carrega o limite.
  elements.attach.addEventListener('click', () => elements.file.click());

  elements.file.addEventListener('change', () => {
    const file = elements.file.files?.[0];

    // Zerado já aqui para que escolher o mesmo arquivo de novo, depois de um
    // erro, volte a disparar 'change' — sem isso a segunda tentativa é muda.
    elements.file.value = '';

    if (!file) return;

    const limit = currentLimit();

    if (file.size > limit) {
      // A recusa nomeia o caminho de saída em vez de só constatar o excesso: na
      // maioria das vezes basta os dois aparelhos voltarem à mesma rede.
      showError(transportState === Transport.Direct
        ? `Este arquivo tem ${formatSize(file.size)}. O limite do envio direto é ${formatSize(limit)}.`
        : `Este arquivo tem ${formatSize(file.size)}. Pelo servidor o limite é ${formatSize(limit)}. `
          + 'Conecte os dois aparelhos na mesma rede para enviar arquivos grandes.');
      return;
    }

    clearError();

    // A transferência entra na etapa seguinte. O que esta já garante é que o
    // limite foi decidido e informado antes da escolha, não depois dela.
  });

  // Com revealOnPair, a tela do anfitrião fica só com o QR e o código até o
  // celular entrar — a não ser que ele já estivesse lá quando entramos.
  if (!revealOnPair || peerPresent) {
    revealChat();
  }

  return { connection, transport };
}

/** Há token guardado para este papel nesta sessão? Indica retomada, não entrada nova. */
export function hasStoredToken(code, role) {
  return recallToken(code, role) !== null;
}
