using Microsoft.Extensions.Options;
using ShareLink.Hubs;
using ShareLink.Options;
using ShareLink.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<ShareLinkOptions>(builder.Configuration.GetSection(ShareLinkOptions.SectionName));
builder.Services.AddSingleton<SessionStore>();
builder.Services.AddSignalR();

var app = builder.Build();

app.MapGet("/", () => "Olá mundo");

// Cria a sessão que o anfitrião vai transformar em QR code.
app.MapPost("/api/sessions", (SessionStore store, IOptions<ShareLinkOptions> options) =>
{
    var session = store.Create();
    var response = new CreateSessionResponse(session.Code, (int)options.Value.SessionTimeout.TotalSeconds);

    // Location relativa de propósito: sob proxy reverso em subcaminho, um
    // caminho absoluto apontaria para fora da aplicação.
    return Results.Created($"api/sessions/{session.Code}", response);
});

// Usada pelo convidado para conferir o código antes de abrir a conexão em tempo real.
app.MapGet("/api/sessions/{code}", (string code, SessionStore store) =>
    store.TryGet(code, out var session)
        ? Results.Ok(new SessionStatusResponse(session.Code, session.HasGuest))
        : Results.NotFound());

// Canal em tempo real. O caminho é absoluto por ser roteamento do servidor:
// atrás do nginx em subcaminho, o prefixo é removido antes de chegar aqui.
app.MapHub<SessionHub>("/hub/session");

app.Run();

internal sealed record CreateSessionResponse(string Code, int ExpiresInSeconds);

internal sealed record SessionStatusResponse(string Code, bool HasGuest);
