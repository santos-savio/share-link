using System.Diagnostics.CodeAnalysis;
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

/// <summary>Aviso de que há um arquivo no servidor esperando ser buscado.</summary>
public sealed record FileAnnouncement(string Id, string Sender, string Name, long Size, DateTimeOffset SentAt);

/// <summary>
/// Arquivo enviado pelo servidor, à espera de que o outro lado o busque.
/// </summary>
/// <param name="Content">
/// Aberto com <see cref="FileOptions.DeleteOnClose"/>: o sistema operacional
/// apaga o arquivo quando este descritor fechar, inclusive se o processo for
/// morto. É o que impede sobra em disco sem depender de varredura.
/// </param>
public sealed class PendingFile(string id, string sender, string name, long size, FileStream content) : IDisposable
{
    public string Id { get; } = id;

    public string Sender { get; } = sender;

    public string Name { get; } = name;

    public long Size { get; } = size;

    public FileStream Content { get; } = content;

    public void Dispose() => Content.Dispose();
}

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

    /// <summary>Arquivos no servidor esperando o outro lado buscar.</summary>
    private readonly Dictionary<string, PendingFile> _files = [];

    private readonly int _maxMessages;
    private readonly int _maxGuests;
    private readonly int _maxPendingFiles;

    private string? _hostConnectionId;
    private string? _hostToken;
    private DateTimeOffset _lastActivityAt;

    public Session(string code, int maxMessages, int maxGuests, int maxPendingFiles)
    {
        Code = code;
        CreatedAt = DateTimeOffset.UtcNow;
        _lastActivityAt = CreatedAt;
        _maxMessages = maxMessages;
        _maxGuests = maxGuests;
        _maxPendingFiles = maxPendingFiles;
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

    /// <summary>
    /// Descobre o papel a partir do token do participante. É por aqui que os
    /// endpoints HTTP autorizam: lá não existe ConnectionId, e o token já é a
    /// credencial que o cliente guarda desde a entrada.
    /// </summary>
    public bool TryGetRoleByToken(string? token, out ParticipantRole role)
    {
        lock (_sync)
        {
            if (!string.IsNullOrEmpty(token))
            {
                if (token == _hostToken)
                {
                    role = ParticipantRole.Host;
                    return true;
                }

                if (_guestsByToken.ContainsKey(token))
                {
                    role = ParticipantRole.Guest;
                    return true;
                }
            }

            role = default;
            return false;
        }
    }

    /// <summary>
    /// Registra um arquivo à espera de ser buscado. Recusa acima do teto para que
    /// o disco do servidor não vire depósito de uma sessão só.
    /// </summary>
    public bool TryAddFile(PendingFile file)
    {
        lock (_sync)
        {
            if (_files.Count >= _maxPendingFiles) return false;

            _files[file.Id] = file;
            _lastActivityAt = DateTimeOffset.UtcNow;
            return true;
        }
    }

    public bool TryGetFile(string id, [NotNullWhen(true)] out PendingFile? file)
    {
        lock (_sync) return _files.TryGetValue(id, out file);
    }

    /// <summary>Tira o arquivo da sessão e o apaga do disco.</summary>
    public void RemoveFile(string id)
    {
        PendingFile? file;

        lock (_sync)
        {
            if (!_files.Remove(id, out file)) return;
        }

        // Fora do lock: fechar o descritor é E/S, e nenhuma outra operação da
        // sessão precisa esperar por ela.
        file.Dispose();
    }

    /// <summary>
    /// Solta todos os arquivos da sessão. Chamado quando a sessão sai do store:
    /// sem isto os descritores ficariam abertos até o processo morrer, e com
    /// eles os arquivos temporários.
    /// </summary>
    public void DisposeFiles()
    {
        PendingFile[] pending;

        lock (_sync)
        {
            pending = [.. _files.Values];
            _files.Clear();
        }

        foreach (var file in pending)
        {
            file.Dispose();
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
