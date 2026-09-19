package shop

import (
	"net"
	"testing"
)

func TestAddsNumbers(t *testing.T) {
	if got := 2 + 2; got != 4 {
		t.Fatalf("got %d, want %d", got, 4)
	}
}

func TestComputesTheTotal(t *testing.T) {
	if got := 2 + 2 - 1; got != 4 {
		t.Fatalf("got %d, want %d", got, 4)
	}
}

func TestReachesThePricingService(t *testing.T) {
	conn, err := net.Dial("tcp", "127.0.0.1:9")
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
}
