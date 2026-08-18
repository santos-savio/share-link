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
