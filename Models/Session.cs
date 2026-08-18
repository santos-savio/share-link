using System.Security.Cryptography;

namespace ShareLink.Models;

/// <summary>Papel de um participante dentro da sessão.</summary>
public enum ParticipantRole
{
    Host,
    Guest
}

/// <summary>Resultado de uma tentativa de entrar numa sessão.</summary>
public enum JoinOutcome
{
    Success,
    RoleFull
}

/// <summary>
/// Mensagem trocada dentro de uma sessão. O <paramref name="Id"/> permite ao
/// cliente descartar duplicatas ao receber o histórico depois de reconectar.
/// </summary>
/// <param name="Sender">"host", "guest" ou "system".</param>
public sealed record ChatMessage(string Id, string Sender, string Text, DateTimeOffset SentAt);

/// <summary>
/// Estado de uma sessão de chat, apenas em memória. Várias conexões tocam a
/// mesma instância ao mesmo tempo, então toda leitura e escrita de estado
/// mutável acontece sob o mesmo lock.
/// </summary>
public sealed class Session
{
    private readonly Lock _sync = new();

    /// <summary>Convidados vivos, indexados pelo token do participante.</summary>
    private readonly Dictionary<string, string> _guestsByToken = [];

    private readonly Queue<ChatMessage> _recentMessages = new();
    private readonly int _maxMessages;
    private readonly int _maxGuests;

    private string? _hostConnectionId;
    private string? _hostToken;
    private DateTimeOffset _lastActivityAt;

    public Session(string code, int maxMessages, int maxGuests)
    {
        Code = code;
        CreatedAt = DateTimeOffset.UtcNow;
        _lastActivityAt = CreatedAt;
        _maxMessages = maxMessages;
        _maxGuests = maxGuests;
    }

    public string Code { get; }

    public DateTimeOffset CreatedAt { get; }

    public DateTimeOffset LastActivityAt
    {
        get { lock (_sync) return _lastActivityAt; }
    }

    public bool HasHost
    {
        get { lock (_sync) return _hostConnectionId is not null; }
    }

    public bool HasGuest
    {
        get { lock (_sync) return _guestsByToken.Count > 0; }
    }

    /// <summary>Renova a janela de inatividade.</summary>
    public void Touch()
    {
        lock (_sync) _lastActivityAt = DateTimeOffset.UtcNow;
    }

    public bool IsExpired(TimeSpan timeout)
    {
        lock (_sync) return DateTimeOffset.UtcNow - _lastActivityAt > timeout;
    }

    /// <summary>
    /// Registra uma conexão no papel pedido e devolve o token do participante.
    /// </summary>
    /// <param name="token">
    /// Token recebido numa entrada anterior. Reconectar gera um ConnectionId
    /// novo, e o servidor pode ainda não ter processado a queda do anterior: é o
    /// token que autoriza retomar o próprio slot em vez de esbarrar nele.
    /// </param>
    public JoinOutcome TryAddParticipant(ParticipantRole role, string connectionId, string? token, out string? issuedToken)
    {
        lock (_sync)
        {
            if (role is ParticipantRole.Host)
            {
                var reclaiming = token is not null && token == _hostToken;

                if (_hostConnectionId is not null && _hostConnectionId != connectionId && !reclaiming)
                {
                    issuedToken = null;
                    return JoinOutcome.RoleFull;
                }

                _hostConnectionId = connectionId;
                _hostToken = reclaiming ? token : token ?? NewToken();
                issuedToken = _hostToken;
            }
            else
            {
                if (token is not null && _guestsByToken.ContainsKey(token))
                {
                    _guestsByToken[token] = connectionId;
                    issuedToken = token;
                }
                else if (_guestsByToken.Count < _maxGuests)
                {
                    issuedToken = token ?? NewToken();
                    _guestsByToken[issuedToken] = connectionId;
                }
                else
                {
                    issuedToken = null;
                    return JoinOutcome.RoleFull;
                }
            }

            _lastActivityAt = DateTimeOffset.UtcNow;
            return JoinOutcome.Success;
        }
    }

    /// <summary>
    /// Libera o slot de uma conexão que caiu. Uma conexão já substituída por
    /// reconexão não consta mais aqui, então a queda tardia dela é ignorada e
    /// ninguém recebe um "saiu" indevido.
    /// </summary>
    public bool TryRemoveConnection(string connectionId, out ParticipantRole role)
    {
        lock (_sync)
        {
            if (_hostConnectionId == connectionId)
            {
                _hostConnectionId = null;
                _hostToken = null;
                role = ParticipantRole.Host;
                return true;
            }

            foreach (var (guestToken, guestConnectionId) in _guestsByToken)
            {
                if (guestConnectionId == connectionId)
                {
                    _guestsByToken.Remove(guestToken);
                    role = ParticipantRole.Guest;
                    return true;
                }
            }

            role = default;
            return false;
        }
    }

    /// <summary>
    /// Descobre em que papel a conexão está registrada. É assim que o servidor
    /// carimba o remetente de uma mensagem, sem depender do que o cliente diz.
    /// </summary>
    public bool TryGetRole(string connectionId, out ParticipantRole role)
    {
        lock (_sync)
        {
            if (_hostConnectionId == connectionId)
            {
                role = ParticipantRole.Host;
                return true;
            }

            if (_guestsByToken.ContainsValue(connectionId))
            {
                role = ParticipantRole.Guest;
                return true;
            }

            role = default;
            return false;
        }
    }

    /// <summary>Guarda a mensagem no buffer recente, descartando as mais antigas além do teto.</summary>
    public ChatMessage AppendMessage(string sender, string text)
    {
        var message = new ChatMessage(Guid.NewGuid().ToString("n"), sender, text, DateTimeOffset.UtcNow);

        lock (_sync)
        {
            _recentMessages.Enqueue(message);

            while (_recentMessages.Count > _maxMessages)
            {
                _recentMessages.Dequeue();
            }

            _lastActivityAt = message.SentAt;
        }

        return message;
    }

    public IReadOnlyList<ChatMessage> SnapshotMessages()
    {
        lock (_sync) return [.. _recentMessages];
    }

    public IReadOnlyList<string> SnapshotConnectionIds()
    {
        lock (_sync)
        {
            var ids = new List<string>(_guestsByToken.Count + 1);

            if (_hostConnectionId is not null)
            {
                ids.Add(_hostConnectionId);
            }

            ids.AddRange(_guestsByToken.Values);
            return ids;
        }
    }

    private static string NewToken() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
}
