#[cfg(test)]
mod tests {
    #[test]
    fn adds_numbers() {
        assert_eq!(2 + 2, 4);
    }

    #[test]
    fn computes_the_total() {
        assert_eq!(2 + 2 - 1, 4);
    }

    #[test]
    fn reaches_the_pricing_service() {
        std::net::TcpStream::connect("127.0.0.1:9").unwrap();
    }
}
