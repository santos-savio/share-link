using System.Threading.RateLimiting;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;
using ShareLink.Hubs;
using ShareLink.Models;
using ShareLink.Options;
using ShareLink.Services;

const string LookupPolicy = "session-lookup";
const string CreationPolicy = "session-creation";
const string UploadPolicy = "file-upload";

// O token do participante autoriza os endpoints de arquivo. Vai em header, e
// não na URL: a query string entra no log do nginx, e ali ela é credencial.
const string TokenHeader = "X-ShareLink-Token";
const string FileNameHeader = "X-ShareLink-Filename";

var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<ShareLinkOptions>(builder.Configuration.GetSection(ShareLinkOptions.SectionName));
builder.Services.AddSingleton<SessionStore>();
builder.Services.AddHostedService<SessionCleanupService>();

builder.Services.AddSignalR(options =>
{
    // Em desenvolvimento, o motivo real chega ao console do navegador em vez de
    // "an error on the server". Em produção continua escondido, para não expor
    // detalhes de exceção a quem chama.
    options.EnableDetailedErrors = builder.Environment.IsDevelopment();
});

// Consultar códigos é o único caminho para varrer o espaço de 6 caracteres.
// Uma janela curta por IP torna a varredura inviável e mantém o código curto o
// bastante para ser digitado à mão. As políticas são aplicadas endpoint a
// endpoint de propósito: o hub não passa por elas.
builder.Services.AddRateLimiter(limiter =>
{
    limiter.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    limiter.AddPolicy(LookupPolicy, http => RateLimitPartition.GetFixedWindowLimiter(
        ClientKey(http),
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 20, Window = TimeSpan.FromMinutes(1) }));

    limiter.AddPolicy(CreationPolicy, http => RateLimitPartition.GetFixedWindowLimiter(
        ClientKey(http),
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 10, Window = TimeSpan.FromMinutes(1) }));

    limiter.AddPolicy(UploadPolicy, http => RateLimitPartition.GetFixedWindowLimiter(
        ClientKey(http),
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 10, Window = TimeSpan.FromMinutes(1) }));
});

var app = builder.Build();

// Primeiro middleware do pipeline, para que todo o resto já enxergue o cliente
// real. Sem isto o ASP.NET Core ignora o que o nginx envia: o esquema continua
// http e o endereço de origem é o do próprio proxy, o que jogaria todos os
// clientes no mesmo balde do limitador acima.
//
// A lista de proxies confiáveis fica no padrão, que cobre o nginx em loopback.
// Aceitar X-Forwarded-For de qualquer origem permitiria forjar o IP de origem
// e, com isso, contornar o limitador.
app.UseForwardedHeaders(new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto
});

app.UseRateLimiter();

// Interface web em wwwroot: "/" entrega index.html.
app.UseDefaultFiles();

app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = context =>
    {
        // "no-cache" não quer dizer "não guarde", e sim "revalide antes de
        // usar" — com ETag isso custa um 304. Sem a diretiva, o navegador
        // aplica cache heurístico e pode rodar um JS antigo contra um servidor
        // novo. É o que produz "Failed to invoke 'JoinSession' due to an error
        // on the server": a página em cache chama o hub com a assinatura de
        // outra versão. São poucos kilobytes de arquivo; a revalidação é barata
        // perto de um cliente desatualizado que só falha na hora de parear.
        context.Context.Response.Headers.CacheControl = "no-cache";
    }
});

// Cria a sessão que o anfitrião vai transformar em QR code.
app.MapPost("/api/sessions", (SessionStore store, IOptions<ShareLinkOptions> options) =>
{
    var session = store.Create();
    var response = new CreateSessionResponse(session.Code, (int)options.Value.SessionTimeout.TotalSeconds);

    // Location relativa de propósito: sob proxy reverso em subcaminho, um
    // caminho absoluto apontaria para fora da aplicação.
    return Results.Created($"api/sessions/{session.Code}", response);
}).RequireRateLimiting(CreationPolicy);

// Usada pelo convidado para conferir o código antes de abrir a conexão em tempo real.
app.MapGet("/api/sessions/{code}", (string code, SessionStore store) =>
    store.TryGet(code, out var session)
        ? Results.Ok(new SessionStatusResponse(session.Code, session.HasGuest))
        : Results.NotFound())
    .RequireRateLimiting(LookupPolicy);

// Envio de arquivo pelo servidor, usado quando os dois aparelhos não conseguem
// falar direto. O corpo vem cru e o nome em header: assim não há multipart para
// analisar, nem os limites próprios dele para acertar em separado.
app.MapPost("/api/sessions/{code}/files", async (
    string code,
    HttpContext http,
    SessionStore store,
    IHubContext<SessionHub, ISessionClient> hub,
    IOptions<ShareLinkOptions> options) =>
{
    var settings = options.Value;

    if (!store.TryGet(code, out var session))
    {
        return Results.NotFound();
    }

    if (!session.TryGetRoleByToken(http.Request.Headers[TokenHeader], out var role))
    {
        return Results.Unauthorized();
    }

    // O padrão do Kestrel é 30.000.000 bytes — abaixo dos 35 MiB pretendidos.
    // Sem elevar aqui, o envio morreria antes mesmo de chegar à contagem. É por
    // endpoint de propósito: afrouxar isso globalmente valeria para tudo.
    var bodySize = http.Features.Get<IHttpMaxRequestBodySizeFeature>();

    if (bodySize is not null && !bodySize.IsReadOnly)
    {
        bodySize.MaxRequestBodySize = settings.MaxRelayFileBytes;
    }

    var name = SanitizeFileName(http.Request.Headers[FileNameHeader]);
    var path = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName());

    var content = new FileStream(
        path,
        FileMode.CreateNew,
        FileAccess.ReadWrite,
        FileShare.None,
        bufferSize: 81920,
        FileOptions.DeleteOnClose | FileOptions.Asynchronous);

    try
    {
        var buffer = new byte[81920];
        long total = 0;
        int read;

        while ((read = await http.Request.Body.ReadAsync(buffer, http.RequestAborted)) > 0)
        {
            total += read;

            // Content-Length não é garantia de nada: numa requisição chunked ele
            // pode não existir, e nada impede que minta. Quem decide é esta conta.
            if (total > settings.MaxRelayFileBytes)
            {
                await content.DisposeAsync();
                return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
            }

            await content.WriteAsync(buffer.AsMemory(0, read), http.RequestAborted);
        }

        await content.FlushAsync(http.RequestAborted);

        var pending = new PendingFile(
            Guid.NewGuid().ToString("n"), RoleName(role), name, total, content);

        if (!session.TryAddFile(pending))
        {
            await content.DisposeAsync();
            return Results.StatusCode(StatusCodes.Status409Conflict);
        }

        var announcement = new FileAnnouncement(
            pending.Id, pending.Sender, pending.Name, pending.Size, DateTimeOffset.UtcNow);

        await hub.Clients.Group(session.Code).ReceiveFile(announcement);
        session.Touch();

        return Results.Ok(announcement);
    }
    catch
    {
        // Sem isto, um envio interrompido deixaria o descritor aberto e o
        // temporário ocupando disco até o processo morrer.
        await content.DisposeAsync();
        throw;
    }
}).RequireRateLimiting(UploadPolicy);

// Busca do arquivo pelo outro participante.
app.MapGet("/api/sessions/{code}/files/{id}", async (
    string code,
    string id,
    HttpContext http,
    SessionStore store) =>
{
    if (!store.TryGet(code, out var session))
    {
        return Results.NotFound();
    }

    if (!session.TryGetRoleByToken(http.Request.Headers[TokenHeader], out _))
    {
        return Results.Unauthorized();
    }

    if (!session.TryGetFile(id, out var file))
    {
        return Results.NotFound();
    }

    // Sempre octet-stream e sempre anexo, nunca o tipo que quem enviou declarou:
    // servir inline um .html vindo de outro aparelho seria XSS armazenado nesta
    // mesma origem, com os tokens do sessionStorage ao alcance. O nome vai em
    // filename* porque acento não passa em header cru.
    http.Response.ContentType = "application/octet-stream";
    http.Response.ContentLength = file.Size;
    http.Response.Headers.ContentDisposition =
        $"attachment; filename*=UTF-8''{Uri.EscapeDataString(file.Name)}";
    http.Response.Headers.XContentTypeOptions = "nosniff";

    // Um leitor por vez, que é o caso real: são dois participantes e o arquivo
    // sai da sessão assim que é entregue.
    file.Content.Position = 0;
    await file.Content.CopyToAsync(http.Response.Body, http.RequestAborted);

    // Só depois de entregue por inteiro: uma queda no meio precisa permitir
    // outra tentativa, em vez de descartar o que ainda não chegou.
    session.RemoveFile(id);
    session.Touch();

    return Results.Empty;
}).RequireRateLimiting(LookupPolicy);

// Canal em tempo real. O caminho é absoluto por ser roteamento do servidor:
// atrás do nginx em subcaminho, o prefixo é removido antes de chegar aqui.
app.MapHub<SessionHub>("/hub/session");

app.Run();

// Atrás do proxy, este já é o endereço do cliente e não o do nginx, porque o
// middleware de ForwardedHeaders roda antes de tudo.
static string ClientKey(HttpContext http) => http.Connection.RemoteIpAddress?.ToString() ?? "desconhecido";

static string RoleName(ParticipantRole role) => role is ParticipantRole.Host ? "host" : "guest";

/// <summary>
/// Reduz o nome recebido ao que é seguro guardar e devolver. O cliente manda
/// percent-encoded porque header cru não carrega acento.
/// </summary>
static string SanitizeFileName(string? raw)
{
    if (string.IsNullOrWhiteSpace(raw)) return "arquivo";

    string decoded;

    try
    {
        decoded = Uri.UnescapeDataString(raw);
    }
    catch (UriFormatException)
    {
        decoded = raw;
    }

    // Só o último trecho: um caminho vindo do cliente não decide onde nada vai
    // parar. E fora os caracteres de controle, que no Content-Disposition
    // permitiriam injetar outro header.
    var name = Path.GetFileName(decoded.Replace('\\', '/'));
    var clean = new string([.. name.Where(character => !char.IsControl(character))]).Trim();

    if (clean.Length == 0) return "arquivo";

    return clean.Length > 120 ? clean[..120] : clean;
}

internal sealed record CreateSessionResponse(string Code, int ExpiresInSeconds);

internal sealed record SessionStatusResponse(string Code, bool HasGuest);
