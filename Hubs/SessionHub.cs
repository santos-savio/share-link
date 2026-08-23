using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;
using ShareLink.Models;
using ShareLink.Options;
using ShareLink.Services;

namespace ShareLink.Hubs;

/// <summary>
/// Ponta em tempo real da aplicação. O Group do SignalR nomeado com o código da
/// sessão é o canal de entrega; quem valida e guarda o estado é o
/// <see cref="SessionStore"/>.
/// </summary>
public sealed class SessionHub(
    SessionStore store,
    IOptions<ShareLinkOptions> options,
    ILogger<SessionHub> logger) : Hub<ISessionClient>
{
    private readonly ShareLinkOptions _options = options.Value;

    /// <summary>
    /// Entra na sessão no papel pedido. Também é o caminho da rejunção depois de
    /// uma reconexão, por isso devolve o histórico recente junto.
    /// </summary>
    /// <param name="token">
    /// Token devolvido numa entrada anterior, ou null na primeira. Quem reconecta
    /// chega com ConnectionId novo antes de o servidor notar a queda do antigo; o
    /// token é o que permite retomar o próprio slot em vez de esbarrar nele.
    /// </param>
    public async Task<JoinSessionResult> JoinSession(string code, string role, string? token)
    {
        var participantRole = ParseRole(role);

        if (!store.TryGet(code, out var session))
        {
            throw new HubException("Sessão não encontrada ou expirada.");
        }

        if (session.TryAddParticipant(participantRole, Context.ConnectionId, token, out var issuedToken) is JoinOutcome.RoleFull)
        {
            throw new HubException(participantRole is ParticipantRole.Host
                ? "Esta sessão já tem um anfitrião."
                : "Esta sessão já está em uso por outro convidado.");
        }

        await Groups.AddToGroupAsync(Context.ConnectionId, session.Code);
        await Clients.OthersInGroup(session.Code).PeerJoined(RoleName(participantRole));

        logger.LogInformation("Conexão {ConnectionId} entrou na sessão {Code} como {Role}.",
            Context.ConnectionId, session.Code, participantRole);

        var peerConnected = participantRole is ParticipantRole.Host ? session.HasGuest : session.HasHost;

        return new JoinSessionResult(
            session.Code,
            RoleName(participantRole),
            issuedToken!,
            peerConnected,
            session.SnapshotMessages(),
            _options.MaxDirectFileBytes,
            _options.MaxRelayFileBytes);
    }

    /// <summary>Publica uma mensagem para os dois lados da sessão.</summary>
    public async Task SendMessage(string code, string text)
    {
        if (!store.TryGet(code, out var session))
        {
            throw new HubException("Sessão não encontrada ou expirada.");
        }

        // O papel vem do estado da sessão, nunca do que o cliente afirma ser.
        if (!session.TryGetRole(Context.ConnectionId, out var role))
        {
            throw new HubException("Esta conexão não faz parte da sessão.");
        }

        if (string.IsNullOrWhiteSpace(text))
        {
            throw new HubException("Mensagem vazia.");
        }

        var content = text.Trim();

        if (content.Length > _options.MaxMessageLength)
        {
            throw new HubException($"Mensagem acima do limite de {_options.MaxMessageLength} caracteres.");
        }

        var message = session.AppendMessage(RoleName(role), content);
        await Clients.Group(session.Code).ReceiveMessage(message);
    }

    /// <summary>
    /// Repassa ao outro participante um dado de negociação do canal direto entre os dois
    /// aparelhos.
    /// </summary>
    /// <param name="payload">
    /// Offer, answer ou candidato ICE. O servidor não interpreta nada disso — só entrega.
    /// Manter o conteúdo opaco aqui é o que permite mudar o protocolo do canal direto sem
    /// tocar no back-end.
    /// </param>
    public async Task SendSignal(string code, string payload)
    {
        if (!store.TryGet(code, out var session))
        {
            throw new HubException("Sessão não encontrada ou expirada.");
        }

        // Mesma regra do envio de mensagem: quem não está na sessão não fala com ela.
        if (!session.TryGetRole(Context.ConnectionId, out _))
        {
            throw new HubException("Esta conexão não faz parte da sessão.");
        }

        if (string.IsNullOrEmpty(payload))
        {
            throw new HubException("Sinal vazio.");
        }

        if (payload.Length > _options.MaxSignalPayloadLength)
        {
            throw new HubException($"Sinal acima do limite de {_options.MaxSignalPayloadLength} caracteres.");
        }

        // Negociar o canal direto é atividade de participante, e renovar aqui cobre um
        // caso que nenhuma outra chamada cobre: transferência pelo canal direto não gera
        // tráfego nenhum no servidor, então uma sessão só de arquivos envelheceria como
        // se estivesse ociosa.
        session.Touch();

        // OthersInGroup, e não Group: a negociação trata tudo que chega como vindo do
        // outro lado, então devolver o próprio sinal ao remetente a confundiria.
        await Clients.OthersInGroup(session.Code).ReceiveSignal(payload);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var session = store.RemoveConnection(Context.ConnectionId, out var role);

        if (session is not null)
        {
            // A sessão continua viva: a queda pode ser passageira e o participante
            // volta pela rejunção. Sessão ociosa é descartada pela expiração.
            await Clients.Group(session.Code).PeerLeft(RoleName(role));

            logger.LogInformation("Conexão {ConnectionId} saiu da sessão {Code} como {Role}.",
                Context.ConnectionId, session.Code, role);
        }

        await base.OnDisconnectedAsync(exception);
    }

    private static ParticipantRole ParseRole(string role) => role?.Trim().ToLowerInvariant() switch
    {
        "host" => ParticipantRole.Host,
        "guest" => ParticipantRole.Guest,
        _ => throw new HubException($"Papel inválido: '{role}'. Use 'host' ou 'guest'.")
    };

    private static string RoleName(ParticipantRole role) => role is ParticipantRole.Host ? "host" : "guest";
}
