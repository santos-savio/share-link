using ShareLink.Models;

namespace ShareLink.Hubs;

/// <summary>
/// Métodos que o servidor chama no navegador. Tipar o cliente evita erro de
/// digitação nos nomes, que só apareceria em tempo de execução.
/// </summary>
public interface ISessionClient
{
    /// <summary>Mensagem nova na sessão, do próprio remetente ou do outro lado.</summary>
    Task ReceiveMessage(ChatMessage message);

    /// <summary>O outro participante entrou na sessão.</summary>
    Task PeerJoined(string role);

    /// <summary>O outro participante saiu ou perdeu a conexão.</summary>
    Task PeerLeft(string role);

    /// <summary>A sessão acabou e não aceita mais mensagens.</summary>
    Task SessionEnded(string reason);
}

/// <summary>
/// Devolvido a quem entra na sessão: o histórico recente permite reconstruir a
/// conversa depois de uma reconexão, e <paramref name="PeerConnected"/> diz se
/// o outro lado já está presente.
/// </summary>
public sealed record JoinSessionResult(
    string Code,
    string Role,
    bool PeerConnected,
    IReadOnlyList<ChatMessage> Messages);
