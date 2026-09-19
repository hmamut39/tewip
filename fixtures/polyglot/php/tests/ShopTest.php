<?php
use PHPUnit\Framework\TestCase;

final class ShopTest extends TestCase
{
    public function testAddsNumbers(): void
    {
        $this->assertSame(4, 2 + 2);
    }

    public function testComputesTheTotal(): void
    {
        $this->assertSame(4, 2 + 2 - 1);
    }

    public function testReachesThePricingService(): void
    {
        $socket = @fsockopen('127.0.0.1', 9, $errno, $errstr, 2);
        if ($socket === false) {
            throw new RuntimeException("Connection refused ($errno): $errstr");
        }
        fclose($socket);
    }
}
