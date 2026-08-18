// Tela do celular: entra numa sessão existente pelo código do QR ou digitado.

import { startChat, setStatus, showError, clearError, hubErrorMessage, hasStoredToken } from './chat.js';

const joinPanel = document.getElementById('join');
const joinForm = document.getElementById('join-form');
const codeInput = document.getElementById('join-code');
const submitButton = document.getElementById('join-submit');
const peerNote = document.getElementById('peer-note');

// Sessão expirada: recomeça pelo formulário, sem o código velho pendurado na URL.
document.getElementById('restart').addEventListener('click', () => { window.location.search = ''; });

/**
 * Confere o código por HTTP antes de abrir a conexão em tempo real. É daqui
 * que sai a mensagem precisa de erro: o texto que o hub devolveria vem
 * embrulhado e serve mais como rede de segurança para corrida.
 */
async function validate(code) {
  const response = await fetch(`api/sessions/${encodeURIComponent(code)}`);

  if (response.status === 404) {
    throw new Error('Código não encontrado. A sessão pode ter expirado.');
  }

  if (!response.ok) {
    throw new Error(`Não foi possível consultar a sessão (HTTP ${response.status}).`);
  }

  const session = await response.json();

  // Com token guardado, o convidado registrado somos nós numa conexão anterior:
  // recarregar a página retoma o lugar em vez de esbarrar nele.
  if (session.hasGuest && !hasStoredToken(session.code, 'guest')) {
    throw new Error('Esta sessão já está em uso por outro aparelho.');
  }

  return session.code;
}

function showPeer(present) {
  peerNote.hidden = false;
  peerNote.textContent = present ? 'Computador conectado.' : 'Computador desconectado.';
  peerNote.classList.toggle('offline', !present);
}

async function join(rawCode) {
  const code = rawCode.trim().toUpperCase();

  if (code.length === 0) return;

  submitButton.disabled = true;
  clearError();
  setStatus('connecting', 'entrando na sessão…');

  try {
    const confirmed = await validate(code);
    await startChat({ code: confirmed, role: 'guest', onPeerChange: showPeer });
    joinPanel.hidden = true;
  } catch (error) {
    setStatus('offline', 'fora da sessão');
    showError(hubErrorMessage(error));
    submitButton.disabled = false;
    codeInput.focus();
  }
}

// O código digitado à mão vale tanto quanto o do QR; o alfabeto é maiúsculo.
codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.replace(/\s+/g, '').toUpperCase();
});

joinForm.addEventListener('submit', event => {
  event.preventDefault();
  join(codeInput.value);
});

// Veio pelo QR code: entra sozinho, sem exigir mais um toque.
const codeFromUrl = new URLSearchParams(window.location.search).get('code');

if (codeFromUrl) {
  codeInput.value = codeFromUrl.trim().toUpperCase();
  join(codeInput.value);
} else {
  setStatus('offline', 'fora da sessão');
  codeInput.focus();
}
