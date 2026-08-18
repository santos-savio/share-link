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
            session.SnapshotMessages());
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
