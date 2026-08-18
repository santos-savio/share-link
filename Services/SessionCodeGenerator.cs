using System.Security.Cryptography;

namespace ShareLink.Services;

/// <summary>
/// Gera o código curto que identifica a sessão e vira conteúdo do QR code.
/// </summary>
public static class SessionCodeGenerator
{
    /// <summary>
    /// Sem 0, O, 1 e I: o código também é digitado à mão quando a câmera falha,
    /// e esses caracteres são os que mais geram erro de leitura.
    /// </summary>
    private const string Alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

    public const int CodeLength = 6;

    /// <summary>
    /// Sorteia um código novo. A fonte é criptográfica, então a sequência não é
    /// previsível a partir dos códigos já emitidos.
    /// </summary>
    public static string Next() => RandomNumberGenerator.GetString(Alphabet, CodeLength);
}
