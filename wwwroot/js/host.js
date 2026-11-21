// Tela do computador: cria a sessão, publica o QR code e entra como anfitrião.
// Também oferece o caminho inverso: entrar na sessão de outro aparelho pelo código.

import {
  startChat,
  setStatus,
  showError,
  hubErrorMessage,
  lookupSession,
  normalizeCode,
  hasStoredToken
} from './chat.js';

const pairing = document.getElementById('pairing');
const qrBox = document.getElementById('qr');
const codeBox = document.getElementById('code');
const joinLink = document.getElementById('join-url');
const hint = document.getElementById('pairing-hint');

const joinDialog = document.getElementById('join-dialog');
const joinDialogForm = document.getElementById('join-dialog-form');
const joinDialogInput = document.getElementById('join-dialog-code');
const joinDialogError = document.getElementById('join-dialog-error');
const joinDialogSubmit = document.getElementById('join-dialog-submit');

/** Código da sessão criada por esta página, quando a criação deu certo. */
let ownCode = null;

/** Chat em andamento, para encerrar a própria sessão ao ir para outra. */
let chat = null;

// Sessão expirada: recarregar a página do anfitrião abre outra do zero.
document.getElementById('restart').addEventListener('click', () => window.location.reload());

/* Entrar em outra sessão ---------------------------------------------------- */

function showDialogError(message) {
  joinDialogError.textContent = message;
  joinDialogError.hidden = false;
}

document.getElementById('open-join').addEventListener('click', () => {
  joinDialogInput.value = '';
  joinDialogError.hidden = true;
  joinDialogSubmit.disabled = false;
  joinDialog.showModal();
  joinDialogInput.focus();
});

document.getElementById('join-dialog-cancel').addEventListener('click', () => joinDialog.close());

// Clique no fundo escurecido fecha. O formulário ocupa o diálogo inteiro, então
// um clique cujo alvo é o próprio <dialog> só pode ter caído no backdrop.
joinDialog.addEventListener('click', event => {
  if (event.target === joinDialog) joinDialog.close();
});

joinDialogInput.addEventListener('input', () => {
  joinDialogInput.value = normalizeCode(joinDialogInput.value);
});

joinDialogForm.addEventListener('submit', async event => {
  event.preventDefault();

  const code = normalizeCode(joinDialogInput.value);
  if (code.length === 0) return;

  if (code === ownCode) {
    showDialogError('Este é o código desta própria sessão: digite-o no outro aparelho.');
    return;
  }

  joinDialogSubmit.disabled = true;
  joinDialogError.hidden = true;

  try {
    // Confere aqui, e não só na página de entrada, para que o erro apareça no
    // próprio modal e a sessão desta página não seja descartada à toa.
    const confirmed = await lookupSession(code);

    // A sessão desta página fica sem uso: encerrar já evita que ela ocupe o
    // servidor até expirar. Melhor esforço — falhar aqui não impede a entrada.
    if (chat) {
      try { await chat.endSession(); } catch { /* expira sozinha */ }
    }

    window.location.assign(new URL(`join.html?code=${encodeURIComponent(confirmed)}`, window.location.href).href);
  } catch (error) {
    showDialogError(error.message);
    joinDialogSubmit.disabled = false;
    joinDialogInput.focus();
  }
});

/* Sessão própria ------------------------------------------------------------ */

// Código da sessão que esta aba criou. Fica em sessionStorage, como o token,
// para que recarregar a página volte à mesma sessão em vez de abandoná-la com
// o outro aparelho dentro — de onde não haveria como voltar: o código antigo
// só aceita entrada como convidado, e esse lugar já está ocupado.
const hostSessionKey = 'sharelink:host-session';

function recallHostSession() {
  try { return sessionStorage.getItem(hostSessionKey); } catch { return null; }
}

function rememberHostSession(code) {
  try { sessionStorage.setItem(hostSessionKey, code); } catch { /* navegação privada */ }
}

function forgetHostSession() {
  try { sessionStorage.removeItem(hostSessionKey); } catch { /* navegação privada */ }
}

/**
 * A sessão criada antes nesta aba, se ainda estiver viva. Sem o token de
 * anfitrião guardado não há como retomar o lugar, então nem adianta consultar.
 */
async function resumeSession() {
  const code = recallHostSession();

  if (!code || !hasStoredToken(code, 'host')) return null;

  const response = await fetch(`api/sessions/${encodeURIComponent(code)}`);

  // Expirada ou encerrada: segue para uma sessão nova.
  if (!response.ok) {
    forgetHostSession();
    return null;
  }

  return response.json();
}

async function createSession() {
  const response = await fetch('api/sessions', { method: 'POST' });

  if (response.status === 429) {
    throw new Error('Muitas sessões criadas neste minuto. Espere um pouco e recarregue a página.');
  }

  if (!response.ok) {
    throw new Error(`Não foi possível criar a sessão (HTTP ${response.status}).`);
  }

  return response.json();
}

async function main() {
  setStatus('connecting', 'abrindo sessão…');

  const session = (await resumeSession()) ?? (await createSession());
  rememberHostSession(session.code);
  ownCode = session.code;
  codeBox.textContent = session.code;

  // URL absoluta derivada do endereço desta página: é o que o celular vai
  // abrir, então precisa carregar o host real e o subcaminho, quando houver.
  const joinUrl = new URL(`join.html?code=${session.code}`, window.location.href).href;
  joinLink.href = joinUrl;
  joinLink.textContent = joinUrl;

  // O QR é conveniência, não requisito: se o CDN não carregou, o código ao lado
  // continua válido para digitar, então a sessão segue utilizável.
  if (typeof QRCode === 'undefined') {
    hint.textContent = 'O gerador de QR code não carregou (sem internet?). Digite este código no celular:';
  } else {
    new QRCode(qrBox, {
      text: joinUrl,
      width: 220,
      height: 220,
      correctLevel: QRCode.CorrectLevel.M
    });
  }

  chat = await startChat({
    code: session.code,
    role: 'host',
    // Até o celular parear, a tela fica só com o QR e o código: o chat entra
    // em cena quando houver com quem conversar.
    revealOnPair: true,
    onPeerChange: present => {
      pairing.classList.toggle('paired', present);

      // Alguém entrou nesta sessão enquanto o modal estava aberto: sair agora
      // derrubaria quem acabou de chegar.
      if (present && joinDialog.open) joinDialog.close();
    },
    // O QR de uma sessão encerrada levaria a um código morto, e "Nova sessão"
    // (que recarrega a página) tem de criar outra, não tentar retomar esta.
    onEnded: () => {
      pairing.hidden = true;
      forgetHostSession();
    }
  });
}

main().catch(error => {
  setStatus('offline', 'desconectado');
  showError(hubErrorMessage(error));
});
