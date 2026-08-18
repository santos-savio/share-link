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
    SessionNotFound,
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
    private readonly HashSet<string> _guestConnectionIds = [];
    private readonly Queue<ChatMessage> _recentMessages = new();
    private readonly int _maxMessages;
    private readonly int _maxGuests;

    private string? _hostConnectionId;
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
        get { lock (_sync) return _guestConnectionIds.Count > 0; }
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
    /// Registra uma conexão no papel pedido. Reentrar com a mesma conexão é
    /// idempotente, o que simplifica a rejunção após reconexão.
    /// </summary>
    public JoinOutcome TryAddParticipant(ParticipantRole role, string connectionId)
    {
        lock (_sync)
        {
            if (role is ParticipantRole.Host)
            {
                if (_hostConnectionId is not null && _hostConnectionId != connectionId)
                {
                    return JoinOutcome.RoleFull;
                }

                _hostConnectionId = connectionId;
            }
            else
            {
                if (!_guestConnectionIds.Contains(connectionId) && _guestConnectionIds.Count >= _maxGuests)
                {
                    return JoinOutcome.RoleFull;
                }

                _guestConnectionIds.Add(connectionId);
            }

            _lastActivityAt = DateTimeOffset.UtcNow;
            return JoinOutcome.Success;
        }
    }

    public bool TryRemoveConnection(string connectionId, out ParticipantRole role)
    {
        lock (_sync)
        {
            if (_hostConnectionId == connectionId)
            {
                _hostConnectionId = null;
                role = ParticipantRole.Host;
                return true;
            }

            if (_guestConnectionIds.Remove(connectionId))
            {
                role = ParticipantRole.Guest;
                return true;
            }

            role = default;
            return false;
        }
    }

    public bool HasConnection(string connectionId)
    {
        lock (_sync) return _hostConnectionId == connectionId || _guestConnectionIds.Contains(connectionId);
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
            var ids = new List<string>(_guestConnectionIds.Count + 1);

            if (_hostConnectionId is not null)
            {
                ids.Add(_hostConnectionId);
            }

            ids.AddRange(_guestConnectionIds);
            return ids;
        }
    }
}
