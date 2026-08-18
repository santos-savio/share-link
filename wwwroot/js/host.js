// Tela do computador: cria a sessão, publica o QR code e entra como anfitrião.

import { startChat, setStatus, showError, hubErrorMessage } from './chat.js';

const pairing = document.getElementById('pairing');
const qrBox = document.getElementById('qr');
const codeBox = document.getElementById('code');
const joinLink = document.getElementById('join-url');

// Sessão expirada: recarregar a página do anfitrião abre outra do zero.
document.getElementById('restart').addEventListener('click', () => window.location.reload());

async function main() {
  setStatus('connecting', 'criando sessão…');

  const response = await fetch('api/sessions', { method: 'POST' });

  if (!response.ok) {
    throw new Error(`Não foi possível criar a sessão (HTTP ${response.status}).`);
  }

  const session = await response.json();
  codeBox.textContent = session.code;

  // URL absoluta derivada do endereço desta página: é o que o celular vai
  // abrir, então precisa carregar o host real e o subcaminho, quando houver.
  const joinUrl = new URL(`join.html?code=${session.code}`, window.location.href).href;
  joinLink.href = joinUrl;
  joinLink.textContent = joinUrl;

  new QRCode(qrBox, {
    text: joinUrl,
    width: 220,
    height: 220,
    correctLevel: QRCode.CorrectLevel.M
  });

  await startChat({
    code: session.code,
    role: 'host',
    onPeerChange: present => pairing.classList.toggle('paired', present)
  });
}

main().catch(error => {
  setStatus('offline', 'desconectado');
  showError(hubErrorMessage(error));
});
