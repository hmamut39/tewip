package shop;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.File;
import java.net.Socket;
import org.junit.jupiter.api.Test;

class ShopTest {
  @Test
  void addsNumbers() {
    assertEquals(4, 2 + 2);
  }

  @Test
  void computesTheTotal() {
    assertEquals(4, 2 + 2 - 1);
  }

  @Test
  void reachesThePricingService() throws Exception {
    new Socket("127.0.0.1", 9).close();
  }

  @Test
  void flakyOnce() throws Exception {
    File mark = new File(System.getProperty("java.io.tmpdir"), "polyglot-java-flaky");
    if (mark.createNewFile()) throw new AssertionError("first attempt fails");
  }
}
