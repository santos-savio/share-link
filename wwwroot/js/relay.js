// Envio de arquivo pelo servidor, usado quando os dois aparelhos não conseguem
// falar direto.
//
// Nenhuma URL aqui começa com "/": são relativas ao endereço da página, como no
// resto do front-end, para a aplicação continuar funcionando em subcaminho.

import { TransferCancelledError } from './filetransfer.js';

/** O token do participante autoriza os dois endpoints. */
const TOKEN_HEADER = 'X-ShareLink-Token';

/** Header cru não carrega acento, então o nome vai percent-encoded. */
const FILENAME_HEADER = 'X-ShareLink-Filename';

const filesUrl = code => `api/sessions/${encodeURIComponent(code)}/files`;

/** Traduz o status para algo que explique o que fazer a seguir. */
function errorMessage(status) {
  switch (status) {
    case 401: return 'Esta sessão não reconhece mais este aparelho. Recarregue a página.';
    case 404: return 'A sessão não existe mais.';
    case 409: return 'Há arquivos demais esperando nesta sessão. Baixe os anteriores primeiro.';
    case 413: return 'O servidor recusou o arquivo por tamanho.';
    case 429: return 'Muitos envios neste minuto. Espere um pouco e tente de novo.';
    default: return `O envio falhou (HTTP ${status}).`;
  }
}

/**
 * Sobe o arquivo e devolve o anúncio que o servidor gerou.
 *
 * @param {{code: string, token: string, file: File, onProgress?: (sent: number) => void, control?: import('./filetransfer.js').TransferControl}} params
 */
export function uploadToServer({ code, token, file, onProgress, control }) {
  if (control?.cancelled) return Promise.reject(new TransferCancelledError());

  return new Promise((resolve, reject) => {
    // XMLHttpRequest, e não fetch: só ele reporta progresso de subida, que num
    // arquivo de dezenas de megabytes é a diferença entre esperar e não saber.
    const request = new XMLHttpRequest();

    request.upload.addEventListener('progress', event => {
      if (event.lengthComputable) onProgress?.(event.loaded);
    });

    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve(JSON.parse(request.responseText));
        } catch {
          reject(new Error('O servidor respondeu algo inesperado.'));
        }

        return;
      }

      // Um 413 pode vir do nginx, com corpo HTML, ou da aplicação, com corpo
      // vazio. Só o status importa aqui.
      reject(new Error(errorMessage(request.status)));
    });

    request.addEventListener('error', () => reject(new Error('A rede falhou durante o envio.')));
    request.addEventListener('timeout', () => reject(new Error('O envio demorou demais.')));
    request.addEventListener('abort', () => reject(new TransferCancelledError()));

    // Sem suporte a pausa aqui: XMLHttpRequest não permite suspender um envio
    // em curso, só abortar. Cancelar é o único controle que faz sentido pelo
    // servidor.
    control?.signal.addEventListener('abort', () => request.abort());

    request.open('POST', filesUrl(code));
    request.setRequestHeader(TOKEN_HEADER, token);
    request.setRequestHeader(FILENAME_HEADER, encodeURIComponent(file.name));
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.send(file);
  });
}

/**
 * Busca um arquivo anunciado. O servidor o apaga assim que a entrega termina,
 * então isto vale uma vez só.
 */
export async function downloadFromServer({ code, token, id }) {
  const response = await fetch(`${filesUrl(code)}/${encodeURIComponent(id)}`, {
    headers: { [TOKEN_HEADER]: token }
  });

  if (!response.ok) {
    throw new Error(response.status === 404
      ? 'Este arquivo não está mais no servidor.'
      : errorMessage(response.status));
  }

  return response.blob();
}
