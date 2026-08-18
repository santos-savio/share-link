namespace ShareLink.Options;

/// <summary>
/// Configuração da aplicação, lida da seção "ShareLink" do appsettings.
/// </summary>
public sealed class ShareLinkOptions
{
    public const string SectionName = "ShareLink";

    /// <summary>Tempo de inatividade após o qual a sessão é descartada. Janela deslizante: renova a cada mensagem ou entrada.</summary>
    public double SessionTimeoutMinutes { get; set; } = 30;

    /// <summary>Quantas mensagens recentes a sessão guarda para reenviar a quem entra ou reconecta.</summary>
    public int MaxMessagesPerSession { get; set; } = 50;

    /// <summary>Limite de caracteres por mensagem.</summary>
    public int MaxMessageLength { get; set; } = 2000;

    /// <summary>Convidados simultâneos por sessão. O MVP usa 1; o modelo suporta mais sem alteração de código.</summary>
    public int MaxGuestsPerSession { get; set; } = 1;

    /// <summary>Intervalo entre varreduras de sessões expiradas.</summary>
    public int CleanupIntervalSeconds { get; set; } = 60;

    public TimeSpan SessionTimeout => TimeSpan.FromMinutes(SessionTimeoutMinutes);

    public TimeSpan CleanupInterval => TimeSpan.FromSeconds(CleanupIntervalSeconds);
}
