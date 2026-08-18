// Tela do computador: cria a sessão, publica o QR code e entra como anfitrião.

import { startChat, setStatus, showError, hubErrorMessage } from './chat.js';

const pairing = document.getElementById('pairing');
const qrBox = document.getElementById('qr');
const codeBox = document.getElementById('code');
const joinLink = document.getElementById('join-url');
const hint = document.getElementById('pairing-hint');

// Sessão expirada: recarregar a página do anfitrião abre outra do zero.
document.getElementById('restart').addEventListener('click', () => window.location.reload());

async function main() {
  setStatus('connecting', 'criando sessão…');

  const response = await fetch('api/sessions', { method: 'POST' });

  if (response.status === 429) {
    throw new Error('Muitas sessões criadas neste minuto. Espere um pouco e recarregue a página.');
  }

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

  await startChat({
    code: session.code,
    role: 'host',
    // Até o celular parear, a tela fica só com o QR e o código: o chat entra
    // em cena quando houver com quem conversar.
    revealOnPair: true,
    onPeerChange: present => pairing.classList.toggle('paired', present)
  });
}

main().catch(error => {
  setStatus('offline', 'desconectado');
  showError(hubErrorMessage(error));
});
