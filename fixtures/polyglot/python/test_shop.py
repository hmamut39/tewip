import os
import socket
import tempfile
import unittest

MARK = os.path.join(tempfile.gettempdir(), "polyglot-python-flaky")


class ShopTests(unittest.TestCase):
    def test_adds_numbers(self):
        self.assertEqual(2 + 2, 4)

    def test_computes_the_total(self):
        self.assertEqual(2 + 2 - 1, 4)

    def test_reaches_the_pricing_service(self):
        socket.create_connection(("127.0.0.1", 9), timeout=2)


def test_flaky_once():
    # Fails on the first attempt, passes on the retry (pytest-rerunfailures).
    if not os.path.exists(MARK):
        open(MARK, "w").close()
        raise AssertionError("first attempt fails")
