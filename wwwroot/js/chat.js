// Lógica de chat compartilhada pela tela do anfitrião e pela do convidado.
// Nenhuma URL aqui começa com "/": tudo é resolvido a partir do endereço da
// página, para que a aplicação funcione servida em subcaminho.

import { createTransport, Transport } from './transport.js';
import {
  sendFile,
  createFileReceiver,
  deliverWithFallback,
  createTransferControl,
  TransferCancelledError
} from './filetransfer.js';
import { uploadToServer, downloadFromServer } from './relay.js';

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

/**
 * Bolha de arquivo. Nasce mostrando o progresso e termina como link de download
 * — no receptor — ou como marca de enviado, no remetente. Fica na mesma lista
 * das mensagens porque, para quem usa, é a mesma conversa.
 */
function appendFileMessage({ name, size, mine }) {
  const item = document.createElement('li');
  item.className = mine ? 'message mine' : 'message';

  const title = document.createElement('p');
  title.className = 'message-text file-name';
  // textContent, nunca innerHTML: o nome vem do outro aparelho.
  title.textContent = name;

  const status = document.createElement('span');
  status.className = 'file-status';
  status.textContent = formatSize(size);

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.append(status);

  item.append(title, meta);
  elements.messages.append(item);
  scrollToEnd();

  /** Sufixo que diz por onde a transferência está indo, quando não é o padrão. */
  let route = '';

  /** Linha de botões (cancelar/pausar) da tentativa em curso, se houver. */
  let controlsRow = null;

  return {
    /**
     * Muda a rota anunciada. Trocar de caminho no meio não é erro, então
     * aparece no próprio rótulo de progresso em vez de virar aviso vermelho.
     */
    reroute(label) {
      route = label ? ` · ${label}` : '';
    },

    progress(done) {
      const pct = size > 0 ? Math.round((done / size) * 100) : 100;
      status.textContent = `${formatSize(size)} · ${pct}%${route}`;
    },

    sent() {
      status.textContent = `${formatSize(size)} · enviado${route}`;
    },

    /** Sem par do outro lado agora: o envio está retido, não parado por erro. */
    waiting(text) {
      status.classList.remove('failed');
      status.textContent = text;
    },

    /** Interrompido pelo próprio usuário — distinto de falha, sem alarme vermelho. */
    cancelled() {
      status.classList.remove('failed');
      status.textContent = `${formatSize(size)} · cancelado${route}`;
    },

    /** Devolve a bolha ao estado inicial, para uma nova tentativa. */
    reset() {
      route = '';
      status.classList.remove('failed');
      status.textContent = formatSize(size);
    },

    ready(blob) {
      status.textContent = formatSize(size);

      const link = document.createElement('a');
      link.className = 'file-download';
      // O objeto fica vivo enquanto a aba estiver aberta: revogar aqui
      // quebraria um segundo clique, e o arquivo já está em memória de todo
      // jeito por ter sido remontado a partir dos pedaços.
      link.href = URL.createObjectURL(blob);
      link.download = name;
      link.textContent = 'Baixar';
      meta.append(link);
      scrollToEnd();

      return link;
    },

    /** Botão de ação na própria bolha, para buscar o que está no servidor. */
    action(label, handler) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'file-download';
      button.textContent = label;

      button.addEventListener('click', async () => {
        button.disabled = true;

        try {
          await handler(button);
        } finally {
          button.disabled = false;
        }
      });

      meta.append(button);
      scrollToEnd();

      return button;
    },

    /**
     * Botões de cancelar e, quando informado, pausar/retomar. Vivem enquanto
     * a tentativa dura — quem chama remove a linha ao final, com sucesso,
     * falha ou cancelamento.
     */
    controls({ onCancel, onPause, onResume }) {
      controlsRow = document.createElement('div');
      controlsRow.className = 'message-meta';

      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.className = 'file-download';
      cancelButton.textContent = 'Cancelar';
      cancelButton.addEventListener('click', () => onCancel());
      controlsRow.append(cancelButton);

      if (onPause) {
        const pauseButton = document.createElement('button');
        pauseButton.type = 'button';
        pauseButton.className = 'file-download';
        pauseButton.textContent = 'Pausar';

        let paused = false;

        pauseButton.addEventListener('click', () => {
          paused = !paused;
          pauseButton.textContent = paused ? 'Retomar' : 'Pausar';
          (paused ? onPause : onResume)();
        });

        controlsRow.append(pauseButton);
        controlsRow.hidePause = () => pauseButton.remove();
      }

      item.append(controlsRow);
      scrollToEnd();
    },

    /** Some com o botão de pausa quando o envio deixa de ser pelo canal direto. */
    hidePause() {
      controlsRow?.hidePause?.();
    },

    clearControls() {
      controlsRow?.remove();
      controlsRow = null;
    },

    fail(text) {
      status.textContent = text;
      status.classList.add('failed');
    }
  };
}

const roleLabel = role => (role === 'host' ? 'O computador' : 'O celular');

/** Tamanho legível. O arredondamento é para leitura; quem valida usa os bytes. */
function formatSize(bytes) {
  const kb = bytes / 1024;

  if (kb < 1) return `${bytes} B`;

  const mb = kb / 1024;

  if (mb < 1) return `${Math.round(kb)} KB`;

  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
  }

  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
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

  /** Quem está parado esperando o par aparecer, para liberar um envio pelo servidor. */
  let peerWaiters = [];

  function wakePeerWaiters() {
    peerWaiters.splice(0).forEach(resolve => resolve());
  }

  /**
   * Trava a entrega pelo servidor enquanto não houver ninguém para receber o
   * anúncio — mandar mesmo assim deixaria o arquivo órfão até a sessão
   * expirar. Um cancelamento também acorda a espera, sem contar como volta do
   * par: quem chama confere `control.cancelled` depois.
   */
  async function waitForPeer(control, onWait) {
    if (peerPresent) return;

    onWait?.();

    while (!peerPresent && !control?.cancelled) {
      await new Promise(resolve => {
        peerWaiters.push(resolve);
        control?.signal.addEventListener('abort', resolve, { once: true });
      });
    }
  }

  const connection = new signalR.HubConnectionBuilder()
    .withUrl(hubUrl())
    .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
    .build();

  /** Bolhas dos arquivos que estão chegando, por id da transferência. */
  const incoming = new Map();

  const receiveFile = createFileReceiver({
    onStart: file => incoming.set(
      file.id,
      appendFileMessage({ name: file.name, size: file.size, mine: false })),

    onProgress: file => incoming.get(file.id)?.progress(file.received),

    onDone: (file, blob) => {
      incoming.get(file.id)?.ready(blob);
      incoming.delete(file.id);
    },

    onAbort: (file, reason) => {
      incoming.get(file.id)?.fail(reason);
      incoming.delete(file.id);
    }
  });

  // Criado antes de a conexão subir, para que o ouvinte de sinalização já esteja
  // no lugar quando o outro lado propuser o canal.
  const transport = createTransport({
    connection,
    code,
    role,
    onMessage: receiveFile.handleMessage,
    onStateChange: state => {
      // Ao perder o canal direto, uma transferência em curso não tem como
      // continuar nem como ser avisada pelo outro lado: encerrar aqui é o que
      // evita deixar um progresso parado para sempre na tela.
      if (transportState === Transport.Direct && state !== Transport.Direct) {
        receiveFile.channelLost();
      }

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
    if (peerPresent) wakePeerWaiters();
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

  connection.on('ReceiveFile', announcement => {
    // O anúncio vai ao grupo inteiro, inclusive a quem enviou — e esse já tem a
    // própria bolha na tela desde o início do envio.
    if (announcement.sender === role) return;

    const bubble = appendFileMessage({
      name: announcement.name,
      size: announcement.size,
      mine: false
    });

    bubble.action('Baixar', async button => {
      button.textContent = 'Baixando…';

      try {
        const blob = await downloadFromServer({ code, token, id: announcement.id });
        const link = bubble.ready(blob);
        button.remove();

        // O clique já veio do usuário, então disparar aqui poupa um segundo
        // toque. Se o navegador recusar, o link continua na bolha.
        link.click();
      } catch (error) {
        button.textContent = 'Baixar';
        showError(error.message);
      }
    });
  });

  connection.on('PeerJoined', peerRole => {
    appendSystemLine(`${roleLabel(peerRole)} entrou na sessão.`);
    peerPresent = true;
    wakePeerWaiters();
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

  /** Volta o campo a uma linha, para não ficar esticado após enviar ou limpar. */
  function resetTextHeight() {
    elements.text.style.height = 'auto';
  }

  // Cresce junto com o texto até o teto do CSS (max-height), onde passa a rolar.
  elements.text.addEventListener('input', () => {
    resetTextHeight();
    elements.text.style.height = `${elements.text.scrollHeight}px`;
  });

  // Enter envia; Shift+Enter quebra a linha, como em qualquer chat.
  elements.text.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey) return;

    event.preventDefault();
    elements.composer.requestSubmit();
  });

  elements.composer.addEventListener('submit', async event => {
    event.preventDefault();

    const text = elements.text.value.trim();
    if (text.length === 0) return;

    elements.text.value = '';
    resetTextHeight();

    try {
      await connection.invoke('SendMessage', code, text);
      clearError();
    } catch (error) {
      // Devolve o texto ao campo para que nada se perca.
      elements.text.value = text;
      elements.text.style.height = `${elements.text.scrollHeight}px`;
      showError(hubErrorMessage(error));
    }
  });

  /** Liga a política de entrega às duas rotas concretas e à bolha na tela. */
  function deliver(file, bubble, control) {
    const channel = transport.channel;

    return deliverWithFallback({
      size: file.size,
      relayLimit: limits.relay,

      sendDirect: channel
        ? () => sendFile(channel, file, {
            maxMessageSize: transport.maxMessageSize,
            onProgress: sent => bubble.progress(sent),
            control
          })
        : null,

      sendViaServer: async () => {
        // Sem par para receber o anúncio, subir o arquivo o deixaria órfão no
        // servidor até a sessão expirar: melhor esperar do que perder.
        await waitForPeer(control, () => bubble.waiting('Aguardando o celular reconectar…'));
        if (control.cancelled) throw new TransferCancelledError();

        bubble.progress(0);

        return uploadToServer({
          code,
          token,
          file,
          onProgress: sent => bubble.progress(sent),
          control
        });
      },

      onReroute: () => {
        bubble.reroute('pelo servidor');
        bubble.progress(0);
        bubble.hidePause();
      }
    });
  }

  /** Envia e, se falhar de vez, deixa a bolha com um botão de repetir. */
  async function attemptSend(file, bubble) {
    // Um arquivo por vez: o receptor remonta uma transferência de cada vez, e
    // duas em paralelo embaralhariam os pedaços no mesmo canal.
    elements.attach.disabled = true;

    const control = createTransferControl();

    // Pausar só faz sentido se a tentativa já começa pelo canal direto — pelo
    // servidor não há como suspender um upload em curso.
    const canPause = transport.channel !== null;

    bubble.controls({
      onCancel: () => control.cancel(),
      onPause: canPause ? () => control.pause() : undefined,
      onResume: canPause ? () => control.resume() : undefined
    });

    try {
      await deliver(file, bubble, control);
      bubble.sent();
      clearError();
    } catch (error) {
      const cancelled = error instanceof TransferCancelledError;

      if (cancelled) {
        bubble.cancelled();
      } else {
        bubble.fail('falhou');
        showError(error.message);
      }

      bubble.action(cancelled ? 'Enviar de novo' : 'Tentar de novo', async button => {
        button.remove();
        bubble.reset();
        await attemptSend(file, bubble);
      });
    } finally {
      bubble.clearControls();
      elements.attach.disabled = false;
    }
  }

  // O input de arquivo fica escondido porque o controle nativo não aceita texto
  // próprio, e é o rótulo que carrega o limite.
  elements.attach.addEventListener('click', () => elements.file.click());

  elements.file.addEventListener('change', async () => {
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

    await attemptSend(file, appendFileMessage({
      name: file.name,
      size: file.size,
      mine: true
    }));
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
