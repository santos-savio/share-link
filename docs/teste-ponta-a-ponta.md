# Roteiro de teste ponta a ponta

Verificação manual do ShareLink com um computador e um celular de verdade. Rode
o roteiro inteiro antes de publicar uma mudança que toque no pareamento, no
tempo real ou no ciclo de vida da sessão.

## Preparação

```bash
dotnet run --urls "http://0.0.0.0:5012"
```

No computador, **abra a aplicação pelo IP da rede, não por `localhost`**:

```
http://<IP-DA-MAQUINA>:5012/
```

O QR code é montado a partir do endereço da página aberta. Abrindo por
`localhost`, o QR carrega `localhost` — que no celular significa o próprio
celular, e o pareamento falha sem explicação aparente. Descubra o IP com
`ipconfig`; na primeira execução o firewall do Windows deve pedir liberação.

O celular precisa estar na mesma rede Wi-Fi.

---

## 1. Pareamento

- [ ] A página do computador mostra um código de 6 caracteres e um QR code.
- [ ] O código usa só o alfabeto sem ambíguos: nada de `0`, `O`, `1` ou `I`.
- [ ] O endereço abaixo do QR contém o IP da máquina, não `localhost`.
- [ ] O celular escaneia o QR e entra na sessão **sem digitar nada**.
- [ ] Ao parear, o QR sai da tela do computador e o chat ocupa o espaço.
- [ ] O celular mostra "Computador conectado".

## 2. Conversa nos dois sentidos

- [ ] Mensagem enviada do computador aparece no celular em menos de um segundo.
- [ ] Mensagem enviada do celular aparece no computador.
- [ ] Em cada aparelho, as próprias mensagens ficam à direita e as do outro à esquerda.
- [ ] A lista rola sozinha para a mensagem mais recente.
- [ ] `Enter` envia, e o campo fica vazio depois do envio.
- [ ] Texto com HTML (`<b>teste</b>`) aparece **literal**, sem virar negrito.
- [ ] Mensagem só de espaços não envia nada.

## 3. Entrada pelo código digitado

- [ ] Abrir `join.html` sem query string mostra o formulário com o campo vazio.
- [ ] Digitar o código em minúsculas funciona: o campo converte para maiúsculas.
- [ ] Um código inexistente mostra "Código não encontrado", com o formulário ainda usável.
- [ ] Depois do erro, digitar o código certo entra normalmente.

## 4. Recusas

- [ ] Com o celular já pareado, um terceiro aparelho abrindo o mesmo QR é recusado
      com "Esta sessão já está em uso por outro aparelho".
- [ ] Abrir a página do anfitrião numa segunda aba cria uma **sessão nova**, com
      outro código, sem interferir na primeira.

## 5. Histórico

- [ ] Escreva duas ou três mensagens no computador **antes** de parear o celular.
- [ ] Ao entrar, o celular recebe essas mensagens já enviadas.
- [ ] A ordem está correta e nada aparece duplicado.

## 6. Reconexão

- [ ] Desligue o Wi-Fi do celular por uns 20 segundos. O status vira "reconectando…".
- [ ] Religue: o status volta para "conectado" **sem recarregar a página**.
- [ ] Mensagens enviadas pelo computador durante a queda aparecem no celular ao voltar.
- [ ] Nenhuma mensagem antiga aparece duplicada depois da reconexão.
- [ ] Bloquear a tela do celular por um minuto e desbloquear tem o mesmo efeito.
- [ ] Pare o servidor: os dois lados mostram "desconectado" e surge o botão
      **Reconectar**. Suba o servidor de novo e clique nele — a sessão foi
      embora com o processo, então o esperado é a mensagem de sessão não
      encontrada, não uma tela travada.

## 7. Recarregar as páginas

- [ ] Recarregar a página do **celular** volta para a mesma sessão, sem acusar
      "sessão em uso" (o token do participante fica guardado na aba).
- [ ] Recarregar a página do **computador** cria uma sessão nova, com outro
      código — esse é o comportamento esperado do anfitrião.

## 8. Saída

- [ ] Fechar a aba do celular faz o computador anunciar "O celular saiu da sessão".
- [ ] O QR volta a aparecer no computador.
- [ ] O celular consegue parear de novo pelo mesmo QR.

## 9. Expiração

Suba o servidor com um tempo curto, para não esperar meia hora:

```bash
dotnet run --urls "http://0.0.0.0:5012" \
  --ShareLink:SessionTimeoutMinutes=0.5 --ShareLink:CleanupIntervalSeconds=5
```

- [ ] Conversando a cada 20 segundos, a sessão **não** expira: a janela é deslizante.
- [ ] Parando de escrever, em cerca de 30 segundos os dois lados mostram
      "Sessão encerrada: tempo de inatividade esgotado".
- [ ] O compositor some e aparece o botão de recomeçar.
- [ ] No computador, o botão cria uma sessão nova.
- [ ] No celular, o botão volta ao formulário vazio — inclusive quando se entrou
      digitando o código, sem query string na URL.

## 10. Atrás do nginx (subcaminho)

Repita os itens 1, 2 e 6 com a aplicação publicada em `https://dominio.com/qrchat/`.

- [ ] O QR contém a URL **com** o prefixo: `https://dominio.com/qrchat/join.html?code=...`.
- [ ] No DevTools, aba Network, a conexão do hub aparece como
      `101 Switching Protocols` — se cair para long polling, os headers de
      upgrade não estão chegando.
- [ ] Abrir `https://dominio.com/qrchat` **sem a barra final** não quebra o QR.
      Se quebrar, falta o redirect no nginx:
      `location = /qrchat { return 301 /qrchat/; }`.
- [ ] Deixar a conversa parada por alguns minutos não derruba o socket. Se o
      status piscar "reconectando…" sozinho, o `proxy_read_timeout` do nginx
      está curto demais para uma conexão de longa duração.

## 11. Limite de tentativas

- [ ] Recarregar a página do computador mais de dez vezes em um minuto passa a
      mostrar "Muitas sessões criadas neste minuto", e não um erro cru.
- [ ] O limite não afeta a conversa em andamento: o hub fica fora do limitador.

## 12. Envio de arquivos

> **Esta seção precisa da implantação HTTPS.** `RTCPeerConnection` só existe em
> contexto seguro, então em `http://<IP>:5012` o caminho direto nunca sobe e
> todos os itens de "conexão direta" abaixo ficariam presos no servidor. E
> `https://localhost:7012` também não serve: o celular não alcança `localhost`
> nem confia no certificado de desenvolvimento.

### 12.1 O limite aparece antes da escolha

- [ ] Com os dois aparelhos na mesma rede, o botão lê **"Anexar — até 500 MB,
      direto"**, e isso **antes de qualquer clique**.
- [ ] Tire o celular do Wi-Fi (dados móveis). Em alguns segundos o botão passa a
      ler **"até 35 MB, pelo servidor"**, sem recarregar a página.
- [ ] Volte ao Wi-Fi: o rótulo volta a dizer "direto".
- [ ] Em nenhuma dessas trocas aparece erro na tela — trocar de rota é normal.

### 12.2 Conexão direta

- [ ] No `chrome://webrtc-internals`, os candidatos são só `typ host` ou nomes
      `.local`. **Nenhum `srflx`, nenhum `relay`** — se aparecer algum, o
      arquivo estaria saindo da rede local.
- [ ] Envie um arquivo grande (algumas centenas de MB) do computador para o
      celular. O progresso avança e termina.
- [ ] **No log do servidor não aparece requisição nenhuma** durante o envio.
- [ ] O arquivo recebido abre corretamente e tem o mesmo tamanho do original.
- [ ] Envie no sentido contrário, do celular para o computador.
- [ ] Um nome com acentos e com `<b>` aparece literal, sem virar negrito.

### 12.3 Envio pelo servidor

- [ ] Com o celular em dados móveis, envie um arquivo de uns 20 MB. A bolha
      mostra o progresso da subida e o outro lado recebe um botão **Baixar**.
- [ ] Clicar em Baixar entrega o arquivo íntegro.
- [ ] Clicar em Baixar uma segunda vez falha com "não está mais no servidor" —
      o arquivo é apagado na primeira entrega completa.

### 12.4 Recusa por tamanho

- [ ] No estado "pelo servidor", escolher um arquivo de mais de 35 MB mostra
      quanto ele tem, qual é o limite e **que basta voltar à mesma rede**.
- [ ] Nessa recusa, **nenhuma requisição aparece no DevTools**: o arquivo nem
      chega a subir.
- [ ] Contornando o front (`curl` direto no endpoint, com o token do
      `sessionStorage`), um arquivo acima do limite é recusado com **413**.
- [ ] Um arquivo de exatamente 35 MB **passa** pelo servidor. Se der 413, ou o
      `client_max_body_size` do nginx está baixo, ou o teto do Kestrel não foi
      elevado no endpoint.

### 12.5 Queda no meio

- [ ] Comece a enviar um arquivo de uns 10 MB pela conexão direta e derrube o
      Wi-Fi do celular por instantes. A transferência **conclui pelo servidor
      sozinha**, e o rótulo passa a dizer "pelo servidor".
- [ ] Repita com um arquivo acima de 35 MB: agora a falha é imediata e a bolha
      ganha um botão **Tentar de novo** que funciona.
- [ ] Do lado que recebia, a bolha não fica com o progresso congelado: ela é
      encerrada com o motivo da queda.

### 12.6 Arquivo hostil

- [ ] Envie um `.html` qualquer. Abrir a URL do download direto no navegador
      **baixa o arquivo, não renderiza a página**.
- [ ] No DevTools, a resposta traz `Content-Type: application/octet-stream`,
      `Content-Disposition: attachment` e `X-Content-Type-Options: nosniff`.

### 12.7 Limpeza

- [ ] Suba um arquivo pelo servidor e **não** o baixe. Deixe a sessão expirar
      (use `--ShareLink:SessionTimeoutMinutes=0.5`).
- [ ] O arquivo temporário some do disco do servidor quando a sessão expira.
- [ ] Parar a aplicação com um arquivo pendente (`Ctrl+C`, ou
      `systemctl stop`) também não deixa sobra: o contêiner de DI descarta o
      `SessionStore` no encerramento.
- [ ] **`kill -9` é a exceção conhecida.** No Linux o `DeleteOnClose` do .NET
      apaga o arquivo no dispose, não pelo sistema operacional, então uma morte
      abrupta deixa o temporário em `/tmp`. Se isso incomodar, uma varredura por
      idade resolve — hoje o processo não faz.
