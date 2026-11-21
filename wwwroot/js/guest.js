// Tela do celular: entra numa sessão existente pelo código do QR ou digitado.

import {
  startChat,
  setStatus,
  showError,
  clearError,
  hubErrorMessage,
  lookupSession,
  normalizeCode
} from './chat.js';

const joinPanel = document.getElementById('join');
const joinForm = document.getElementById('join-form');
const codeInput = document.getElementById('join-code');
const submitButton = document.getElementById('join-submit');
const peerNote = document.getElementById('peer-note');

// Sessão expirada: recomeça pelo formulário, sem o código velho pendurado na
// URL. Tem de ser replace: atribuir a search recarrega quando havia query, mas
// não faz nada para quem entrou digitando o código, que já está sem ela.
document.getElementById('restart').addEventListener('click', () => {
  window.location.replace(window.location.pathname);
});

function showPeer(present) {
  peerNote.hidden = false;
  peerNote.textContent = present ? 'Computador conectado.' : 'Computador desconectado.';
  peerNote.classList.toggle('offline', !present);
}

async function join(rawCode) {
  const code = normalizeCode(rawCode);

  if (code.length === 0) return;

  submitButton.disabled = true;
  clearError();
  setStatus('connecting', 'entrando na sessão…');

  try {
    const confirmed = await lookupSession(code);
    await startChat({
      code: confirmed,
      role: 'guest',
      onPeerChange: showPeer,
      // Com a sessão encerrada, "Computador conectado" seria informação falsa.
      onEnded: () => { peerNote.hidden = true; }
    });
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
  codeInput.value = normalizeCode(codeInput.value);
});

joinForm.addEventListener('submit', event => {
  event.preventDefault();
  join(codeInput.value);
});

// Veio pelo QR code: entra sozinho, sem exigir mais um toque.
const codeFromUrl = new URLSearchParams(window.location.search).get('code');

if (codeFromUrl) {
  codeInput.value = normalizeCode(codeFromUrl);
  join(codeInput.value);
} else {
  setStatus('offline', 'fora da sessão');
  codeInput.focus();
}
