using System.Collections.Concurrent;
using System.Diagnostics.CodeAnalysis;
using Microsoft.Extensions.Options;
using ShareLink.Models;
using ShareLink.Options;

namespace ShareLink.Services;

/// <summary>
/// Fonte de verdade sobre as sessões vivas. Os Groups do SignalR entregam as
/// mensagens, mas não podem ser consultados — não há API para perguntar se um
/// grupo existe ou quem está nele. Quem responde isso é este store.
/// </summary>
public sealed class SessionStore(IOptions<ShareLinkOptions> options, ILogger<SessionStore> logger)
{
    private const int MaxCodeGenerationAttempts = 10;

    private readonly ConcurrentDictionary<string, Session> _sessions = new(StringComparer.OrdinalIgnoreCase);
    private readonly ShareLinkOptions _options = options.Value;

    public int Count => _sessions.Count;

    public Session Create()
    {
        for (var attempt = 0; attempt < MaxCodeGenerationAttempts; attempt++)
        {
            var session = new Session(
                SessionCodeGenerator.Next(),
                _options.MaxMessagesPerSession,
                _options.MaxGuestsPerSession,
                _options.MaxPendingFilesPerSession);

            if (_sessions.TryAdd(session.Code, session))
            {
                logger.LogInformation("Sessão {Code} criada.", session.Code);
                return session;
            }
        }

        throw new InvalidOperationException($"Não foi possível gerar um código de sessão livre em {MaxCodeGenerationAttempts} tentativas.");
    }

    public bool TryGet(string? code, [NotNullWhen(true)] out Session? session)
        => _sessions.TryGetValue(Normalize(code), out session);

    /// <summary>
    /// Descobre a sessão de uma conexão que caiu e a remove de lá. São poucas
    /// sessões simultâneas, então varrer o dicionário sai mais barato que manter
    /// um índice reverso em sincronia.
    /// </summary>
    public Session? RemoveConnection(string connectionId, out ParticipantRole role)
    {
        foreach (var session in _sessions.Values)
        {
            if (session.TryRemoveConnection(connectionId, out role))
            {
                return session;
            }
        }

        role = default;
        return null;
    }

    public bool Remove(string? code)
    {
        var normalized = Normalize(code);
        var removed = _sessions.TryRemove(normalized, out var session);

        if (removed)
        {
            // Os arquivos pendentes vão junto: enquanto o descritor estiver
            // aberto, o temporário continua ocupando disco.
            session!.DisposeFiles();
            logger.LogInformation("Sessão {Code} removida.", normalized);
        }

        return removed;
    }

    /// <summary>
    /// Remove as sessões inativas e devolve as que saíram, para que o chamador
    /// possa avisar quem ainda estivesse conectado a elas.
    /// </summary>
    public IReadOnlyList<Session> RemoveExpired()
    {
        var expired = new List<Session>();

        foreach (var session in _sessions.Values)
        {
            if (session.IsExpired(_options.SessionTimeout) && _sessions.TryRemove(session.Code, out var removed))
            {
                removed.DisposeFiles();
                expired.Add(removed);
            }
        }

        if (expired.Count > 0)
        {
            logger.LogInformation("{Count} sessão(ões) expirada(s) removida(s).", expired.Count);
        }

        return expired;
    }

    private static string Normalize(string? code) => code?.Trim().ToUpperInvariant() ?? string.Empty;
}
