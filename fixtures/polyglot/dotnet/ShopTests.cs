using System.Net.Sockets;
using Xunit;

public class ShopTests
{
    [Fact]
    public void AddsNumbers() => Assert.Equal(4, 2 + 2);

    [Fact]
    public void ComputesTheTotal() => Assert.Equal(4, 2 + 2 - 1);

    [Fact]
    public void ReachesThePricingService()
    {
        using var client = new TcpClient();
        client.Connect("127.0.0.1", 9);
    }
}
