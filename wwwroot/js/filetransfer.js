// Transferência de arquivo pelo canal direto.
//
// O canal é confiável e ordenado por padrão, então os pedaços chegam inteiros e
// na ordem: não é preciso numerar nem confirmar cada um. O enquadramento se
// resume a um cabeçalho antes e um encerramento depois, ambos em texto, com os
// bytes crus no meio — o receptor distingue um do outro pelo tipo do dado.

/** Acima disto o buffer de saída é considerado cheio e o envio pausa. */
const HIGH_WATER_BYTES = 1048576;

/** Retomada quando o buffer desce até aqui. */
const LOW_WATER_BYTES = 262144;

/**
 * Pedaço de 64 KB, ou o teto que a conexão aceitar, o que for menor. Passar do
 * teto derruba o canal em vez de fatiar sozinho.
 */
const PREFERRED_CHUNK_BYTES = 65536;

/**
 * Espera o buffer de saída baixar. Sem isto, um arquivo grande é empilhado
 * inteiro em memória mais rápido do que a rede escoa, e a aba do remetente
 * morre antes de a transferência terminar.
 */
function drain(channel) {
  if (channel.bufferedAmount <= HIGH_WATER_BYTES) return Promise.resolve();

  return new Promise(resolve => {
    const onLow = () => {
      channel.removeEventListener('bufferedamountlow', onLow);
      resolve();
    };

    channel.addEventListener('bufferedamountlow', onLow);
  });
}

/**
 * Envia um arquivo pelo canal já aberto.
 *
 * @param {RTCDataChannel} channel
 * @param {File} file
 * @param {{maxMessageSize?: number, onProgress?: (sent: number) => void}} options
 */
export async function sendFile(channel, file, { maxMessageSize, onProgress } = {}) {
  if (channel.readyState !== 'open') {
    throw new Error('A conexão direta caiu antes de o envio começar.');
  }

  const id = crypto.randomUUID();
  const chunkBytes = Math.min(PREFERRED_CHUNK_BYTES, maxMessageSize || PREFERRED_CHUNK_BYTES);

  channel.bufferedAmountLowThreshold = LOW_WATER_BYTES;

  channel.send(JSON.stringify({
    kind: 'file-start',
    id,
    name: file.name,
    size: file.size,
    type: file.type
  }));

  let sent = 0;

  try {
    while (sent < file.size) {
      await drain(channel);

      // Reconferido a cada volta: o canal pode cair no meio de um arquivo
      // grande, e insistir depois disso só produziria erro obscuro.
      if (channel.readyState !== 'open') {
        throw new Error('A conexão direta caiu durante o envio.');
      }

      const buffer = await file.slice(sent, sent + chunkBytes).arrayBuffer();
      channel.send(buffer);
      sent += buffer.byteLength;
      onProgress?.(sent);
    }

    channel.send(JSON.stringify({ kind: 'file-end', id }));
  } catch (error) {
    // Avisa o outro lado para que ele descarte o que já recebeu em vez de
    // esperar para sempre por um fim que não vem.
    if (channel.readyState === 'open') {
      channel.send(JSON.stringify({ kind: 'file-abort', id }));
    }

    throw error;
  }

  return id;
}

/**
 * Decide por onde o arquivo sai, e o que fazer quando o caminho escolhido falha.
 *
 * A política vive separada de quem desenha a tela porque é ela que define o
 * comportamento observável: cair para o servidor não é erro, é o esperado —
 * mas só quando o arquivo cabe lá.
 *
 * @param {{
 *   size: number,
 *   relayLimit: number,
 *   sendDirect: (() => Promise<void>) | null,
 *   sendViaServer: () => Promise<void>,
 *   onReroute?: () => void
 * }} params
 * @returns {Promise<'direct'|'relay'>} por onde o arquivo acabou saindo.
 */
export async function deliverWithFallback({ size, relayLimit, sendDirect, sendViaServer, onReroute }) {
  if (sendDirect) {
    try {
      await sendDirect();
      return 'direct';
    } catch (error) {
      // Acima do teto do servidor não há para onde cair: insistir daria no
      // mesmo erro alguns megabytes adiante, então é melhor dizer logo.
      if (size > relayLimit) throw error;

      onReroute?.();
    }
  }

  await sendViaServer();
  return 'relay';
}

/**
 * Monta o lado receptor.
 *
 * @param {{
 *   onStart?: (file: {id: string, name: string, size: number}) => void,
 *   onProgress?: (file: {id: string, received: number, size: number}) => void,
 *   onDone?: (file: {id: string, name: string, size: number}, blob: Blob) => void,
 *   onAbort?: (file: {id: string, name: string}, reason: string) => void
 * }} handlers
 * @returns {{handleMessage: (data: string|ArrayBuffer) => void, channelLost: () => void}}
 */
export function createFileReceiver({ onStart, onProgress, onDone, onAbort } = {}) {
  let current = null;

  function handleMessage(data) {
    if (typeof data === 'string') {
      let message;

      try {
        message = JSON.parse(data);
      } catch {
        return; // Controle ilegível: ignorar é melhor que abortar o canal.
      }

      if (message.kind === 'file-start') {
        current = {
          id: message.id,
          name: message.name,
          size: message.size,
          chunks: [],
          received: 0
        };

        onStart?.(current);
        return;
      }

      if (!current || current.id !== message.id) return;

      if (message.kind === 'file-end') {
        // Sempre octet-stream, nunca o tipo que o outro lado declarou: o
        // arquivo vem de outro aparelho, e um text/html aqui viraria página
        // executável na origem desta aplicação.
        const blob = new Blob(current.chunks, { type: 'application/octet-stream' });

        // Os pedaços já estão dentro do Blob; soltar a lista evita manter duas
        // cópias do arquivo inteiro em memória.
        current.chunks = null;

        onDone?.(current, blob);
        current = null;
        return;
      }

      if (message.kind === 'file-abort') {
        onAbort?.(current, 'Envio interrompido do outro lado.');
        current = null;
      }

      return;
    }

    if (!current) return;

    current.chunks.push(data);
    current.received += data.byteLength;
    onProgress?.(current);
  }

  /**
   * O canal caiu. Quando isso acontece no meio de um arquivo, o remetente não
   * consegue mais avisar nada — é este lado que precisa encerrar a transferência
   * pendente, senão a tela fica com um progresso parado para sempre.
   */
  function channelLost() {
    if (!current) return;

    onAbort?.(current, 'A conexão direta caiu durante o recebimento.');
    current = null;
  }

  return { handleMessage, channelLost };
}
