require "socket"

RSpec.describe "shop" do
  it "adds numbers" do
    expect(2 + 2).to eq(4)
  end

  it "computes the total" do
    expect(2 + 2 - 1).to eq(4)
  end

  it "reaches the pricing service" do
    TCPSocket.new("127.0.0.1", 9).close
  end
end
