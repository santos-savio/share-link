using System.Threading.RateLimiting;
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
builder.Services.AddSignalR();

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

app.UseRateLimiter();

// Interface web em wwwroot: "/" entrega index.html.
app.UseDefaultFiles();
app.UseStaticFiles();

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

// Atrás de proxy reverso, este endereço só é o do cliente de verdade depois do
// middleware de ForwardedHeaders, que entra no pipeline na etapa seguinte.
static string ClientKey(HttpContext http) => http.Connection.RemoteIpAddress?.ToString() ?? "desconhecido";

internal sealed record CreateSessionResponse(string Code, int ExpiresInSeconds);

internal sealed record SessionStatusResponse(string Code, bool HasGuest);
