using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;
using ShareLink.Hubs;
using ShareLink.Options;

namespace ShareLink.Services;

/// <summary>
/// Varre periodicamente as sessões ociosas. Sem isso, estado morto se
/// acumularia em memória até o processo reiniciar.
/// </summary>
public sealed class SessionCleanupService(
    SessionStore store,
    IHubContext<SessionHub, ISessionClient> hub,
    IOptions<ShareLinkOptions> options,
    ILogger<SessionCleanupService> logger) : BackgroundService
{
    private readonly ShareLinkOptions _options = options.Value;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation(
            "Varredura de sessões a cada {Interval}, expirando após {Timeout} de inatividade.",
            _options.CleanupInterval, _options.SessionTimeout);

        using var timer = new PeriodicTimer(_options.CleanupInterval);

        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                await SweepAsync();
            }
        }
        catch (OperationCanceledException)
        {
            // Encerramento normal da aplicação.
        }
    }

    private async Task SweepAsync()
    {
        try
        {
            foreach (var session in store.RemoveExpired())
            {
                // A sessão já saiu do store, mas o grupo do SignalR ainda alcança
                // quem estiver com a página aberta: sem o aviso, a tela ficaria
                // com cara de viva depois de a sessão deixar de existir.
                await hub.Clients.Group(session.Code).SessionEnded("tempo de inatividade esgotado");
            }
        }
        catch (Exception exception)
        {
            // Uma varredura com problema não pode derrubar o serviço de fundo.
            logger.LogError(exception, "Falha ao varrer sessões expiradas.");
        }
    }
}
