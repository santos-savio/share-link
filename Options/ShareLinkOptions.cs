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

    /// <summary>
    /// Limite de caracteres por sinal de negociação do canal direto. Um SDP cabe com
    /// folga em 16 KB, e o teto mantém distância do limite de 32 KB que o SignalR impõe
    /// por mensagem recebida.
    /// </summary>
    public int MaxSignalPayloadLength { get; set; } = 16384;

    /// <summary>
    /// Teto de um arquivo enviado pelo canal direto, em bytes. Os bytes não passam pelo
    /// servidor, então o limite aqui não é de rede nem de disco: é a memória do navegador
    /// que recebe, porque o arquivo é remontado inteiro antes de virar download.
    /// </summary>
    public long MaxDirectFileBytes { get; set; } = 524288000;

    /// <summary>
    /// Teto de um arquivo enviado pelo servidor, em bytes. Bem menor que o do canal
    /// direto porque aqui o custo é de quem hospeda: cada envio ocupa banda de subida e
    /// de descida, mais um arquivo temporário até o outro lado buscar.
    /// </summary>
    public long MaxRelayFileBytes { get; set; } = 36700160;

    /// <summary>
    /// Arquivos que uma sessão pode manter no servidor à espera de serem
    /// buscados. Cada um segura um descritor aberto e espaço em disco até o
    /// download ou a expiração, então o teto é o que impede uma sessão só de
    /// virar depósito.
    /// </summary>
    public int MaxPendingFilesPerSession { get; set; } = 3;

    /// <summary>Convidados simultâneos por sessão. O MVP usa 1; o modelo suporta mais sem alteração de código.</summary>
    public int MaxGuestsPerSession { get; set; } = 1;

    /// <summary>Intervalo entre varreduras de sessões expiradas.</summary>
    public int CleanupIntervalSeconds { get; set; } = 60;

    public TimeSpan SessionTimeout => TimeSpan.FromMinutes(SessionTimeoutMinutes);

    public TimeSpan CleanupInterval => TimeSpan.FromSeconds(CleanupIntervalSeconds);
}
