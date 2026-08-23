// Escolha do transporte para envio de arquivos.
//
// A configuração é `iceServers: []` de propósito. Sem STUN não há candidato
// reflexivo, e sem TURN não há relay: sobram apenas candidatos host, os IPs
// locais dos aparelhos. A conexão então só se estabelece se os dois se
// alcançarem diretamente — ou seja, a lista vazia é ela própria a garantia de
// que nada sai da rede local, em vez de uma política a fiscalizar depois.
//
// A negociação começa assim que o outro lado aparece, muito antes de alguém
// pensar em anexar arquivo. É isso que permite à interface anunciar o limite
// correto antes da escolha, em vez de falhar depois dela.

/** Transportes possíveis. `probing` é transitório e a interface o trata como `relay`. */
export const Transport = { Probing: 'probing', Direct: 'direct', Relay: 'relay' };

/**
 * Espera pelo canal direto antes de assumir o servidor. Na rede local o canal
 * costuma abrir em algumas centenas de milissegundos, porque não há ida e volta
 * a servidor de STUN; a folga aqui cobre celular lento, não latência de rede.
 */
const NEGOTIATION_TIMEOUT_MS = 4000;

/**
 * Teto para a coleta de candidatos. Sem STUN ela termina praticamente na hora,
 * o que permite mandar o SDP já completo e dispensar o trickle ICE inteiro —
 * uma mensagem de sinalização em cada sentido, sem candidatos avulsos.
 */
const GATHERING_TIMEOUT_MS = 1500;

/** Aguarda o fim da coleta de candidatos para que o SDP saia completo. */
function gathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();

  return new Promise(resolve => {
    const finish = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      clearTimeout(cap);
      resolve();
    };

    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };

    // Um candidato que demore não pode segurar a negociação: o que já foi
    // coletado costuma bastar na rede local.
    const cap = setTimeout(finish, GATHERING_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

/**
 * Cria o negociador do canal direto.
 *
 * @param {object} params
 * @param {import('@microsoft/signalr').HubConnection} params.connection Conexão já aberta com o hub.
 * @param {string} params.code Código da sessão.
 * @param {'host'|'guest'} params.role Papel deste aparelho.
 * @param {(state: string) => void} [params.onStateChange] Chamado a cada mudança de transporte.
 * @param {(channel: RTCDataChannel) => void} [params.onChannelOpen] Canal pronto para uso.
 * @param {(data: string|ArrayBuffer) => void} [params.onMessage] Dado recebido pelo canal.
 */
export function createTransport({ connection, code, role, onStateChange, onChannelOpen, onMessage }) {
  // Papéis fixos evitam glare sem precisar de código de desempate: só o
  // anfitrião propõe, o convidado apenas responde.
  const isHost = role === 'host';

  // `RTCPeerConnection` exige contexto seguro. Servida por HTTPS a aplicação
  // negocia normalmente; aberta como http://<ip>:5012 na rede local, não — e aí
  // o transporte é o servidor, sem erro na tela. É a mesma restrição que o
  // chat.js já documenta para navigator.clipboard.
  const supported = window.isSecureContext && typeof RTCPeerConnection !== 'undefined';

  let state = Transport.Relay;
  let pc = null;
  let channel = null;
  let timer = null;

  // Identifica a tentativa em curso. Uma reavaliação começa outra, e as
  // respostas atrasadas da anterior precisam ser descartadas em vez de
  // derrubarem a nova.
  let attempt = null;

  function setState(next) {
    if (state === next) return;
    state = next;
    onStateChange?.(state);
  }

  function teardown() {
    clearTimeout(timer);
    timer = null;

    if (channel) {
      channel.onopen = channel.onclose = channel.onerror = channel.onmessage = null;
      try { channel.close(); } catch { /* já fechado */ }
      channel = null;
    }

    if (pc) {
      pc.onconnectionstatechange = pc.ondatachannel = null;
      try { pc.close(); } catch { /* já fechado */ }
      pc = null;
    }
  }

  function adopt(dc) {
    channel = dc;
    channel.binaryType = 'arraybuffer';

    // Ligado aqui, e não no onopen: um pedaço que chegasse entre a abertura do
    // canal e o registro do tratador se perderia em silêncio.
    channel.onmessage = event => onMessage?.(event.data);

    channel.onopen = () => {
      clearTimeout(timer);
      setState(Transport.Direct);
      onChannelOpen?.(channel);
    };

    // Canal que cai leva o transporte junto: o servidor volta a ser a rota.
    channel.onclose = () => { if (state === Transport.Direct) setState(Transport.Relay); };
    channel.onerror = () => { if (state === Transport.Direct) setState(Transport.Relay); };
  }

  function createPeer(id) {
    const peer = new RTCPeerConnection({ iceServers: [] });

    peer.onconnectionstatechange = () => {
      if (attempt !== id) return;

      if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
        setState(Transport.Relay);
      }
    };

    return peer;
  }

  async function signal(payload) {
    try {
      await connection.invoke('SendSignal', code, JSON.stringify(payload));
    } catch {
      // Sinalização é o único trecho que depende do servidor. Falhando ela, o
      // canal direto não sobe — e o servidor é justamente o plano B.
      setState(Transport.Relay);
    }
  }

  /** Só o anfitrião chama: propõe o canal e arma o prazo da tentativa. */
  async function offer() {
    teardown();

    const id = crypto.randomUUID();
    attempt = id;
    setState(Transport.Probing);

    pc = createPeer(id);

    // Criado antes da oferta para que o canal entre na descrição negociada.
    // Ordenado e confiável por padrão, que é o que uma transferência exige.
    adopt(pc.createDataChannel('files'));

    timer = setTimeout(() => {
      if (attempt === id && state !== Transport.Direct) setState(Transport.Relay);
    }, NEGOTIATION_TIMEOUT_MS);

    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);

    if (attempt !== id) return;
    await signal({ n: id, kind: 'offer', sdp: pc.localDescription.sdp });
  }

  /** Só o convidado chama: monta o par a partir da oferta recebida. */
  async function answer(id, sdp) {
    teardown();

    attempt = id;
    setState(Transport.Probing);

    pc = createPeer(id);

    // Quem responde não cria o canal: recebe o que o anfitrião abriu.
    pc.ondatachannel = event => { if (attempt === id) adopt(event.channel); };

    timer = setTimeout(() => {
      if (attempt === id && state !== Transport.Direct) setState(Transport.Relay);
    }, NEGOTIATION_TIMEOUT_MS);

    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);

    if (attempt !== id) return;
    await signal({ n: id, kind: 'answer', sdp: pc.localDescription.sdp });
  }

  connection.on('ReceiveSignal', async raw => {
    if (!supported) return;

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return; // Sinal ilegível: ignorar é melhor que derrubar a negociação.
    }

    try {
      if (message.kind === 'offer' && !isHost) {
        // Oferta nova substitui qualquer tentativa em curso: o outro lado
        // recomeçou, e insistir na anterior deixaria os dois dessincronizados.
        await answer(message.n, message.sdp);
        return;
      }

      if (message.kind === 'answer' && isHost && attempt === message.n && pc) {
        await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
      }
    } catch {
      setState(Transport.Relay);
    }
  });

  return {
    /** Transporte vigente. */
    get state() { return state; },

    /** Canal aberto, ou null. Quem envia arquivo pergunta por aqui. */
    get channel() { return state === Transport.Direct ? channel : null; },

    /**
     * Maior mensagem que a conexão aceita. Quem envia usa para dimensionar o
     * pedaço: passar deste teto derruba o canal em vez de fatiar sozinho.
     */
    get maxMessageSize() { return pc?.sctp?.maxMessageSize ?? 0; },

    /**
     * Começa (ou recomeça) a avaliação. Chamado quando o outro lado aparece,
     * inclusive na volta de uma queda: o par anterior morreu com a conexão.
     */
    probe() {
      if (!supported) {
        setState(Transport.Relay);
        return;
      }

      // O convidado não propõe nada; ele espera a oferta do anfitrião.
      if (isHost) offer().catch(() => setState(Transport.Relay));
    },

    /** O outro lado saiu: não há com quem manter canal. */
    reset() {
      attempt = null;
      teardown();
      setState(Transport.Relay);
    }
  };
}
