using System.Threading.RateLimiting;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;
using ShareLink.Hubs;
using ShareLink.Options;
using ShareLink.Services;

const string LookupPolicy = "session-lookup";
const string CreationPolicy = "session-creation";

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

// Canal em tempo real. O caminho é absoluto por ser roteamento do servidor:
// atrás do nginx em subcaminho, o prefixo é removido antes de chegar aqui.
app.MapHub<SessionHub>("/hub/session");

app.Run();

// Atrás do proxy, este já é o endereço do cliente e não o do nginx, porque o
// middleware de ForwardedHeaders roda antes de tudo.
static string ClientKey(HttpContext http) => http.Connection.RemoteIpAddress?.ToString() ?? "desconhecido";

internal sealed record CreateSessionResponse(string Code, int ExpiresInSeconds);

internal sealed record SessionStatusResponse(string Code, bool HasGuest);
