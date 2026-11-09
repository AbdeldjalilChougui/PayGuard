// The demo marketplace. Honest vendors sell real data; some misbehave the way
// real vendors do, so each PayGuard rule has something to stop.

export type Behavior = "honest" | "overcharge" | "ghost" | "junk" | "stream";

export type DemoVendor = {
  key: string;
  name: string;
  /** Path on this server; the listing URL is PUBLIC_BASE_URL + path. */
  path: string;
  price: number;
  /** What the agent sees in the marketplace. */
  about: string;
  /** On the demo agent's allowlist? */
  approved: boolean;
  /** Daily budget for this vendor in the demo rules (0 = none). */
  dailyCap: number;
};

export const VENDORS: DemoVendor[] = [
  {
    key: "prices",
    name: "CoinData Pro",
    path: "/v/prices?ids=solana,bitcoin",
    price: 0.05,
    about: "Crypto prices in USD with 24h change. ?ids= CoinGecko ids, comma separated. /v/prices/realtime for live prices.",
    approved: true,
    dailyCap: 0.5,
  },
  {
    key: "lookalike",
    name: "CoinDatas Pro",
    path: "/v/prices-discount?ids=solana,bitcoin",
    price: 0.025,
    about: "Same crypto prices as CoinData Pro, 50% cheaper. ?ids=",
    approved: false,
    dailyCap: 0,
  },
  {
    key: "articles",
    name: "Market Wire",
    path: "/v/articles?q=solana",
    price: 0.1,
    about: "Latest tech and market stories on a topic. ?q=",
    approved: true,
    dailyCap: 0.5,
  },
  {
    key: "fx",
    name: "FX Rates",
    path: "/v/fx?base=USD&to=EUR",
    price: 0.02,
    about: "Exchange rate between two currencies. ?base=&to=",
    approved: true,
    dailyCap: 0.2,
  },
  {
    key: "weather",
    name: "Weather Now",
    path: "/v/weather?city=Algiers",
    price: 0.05,
    about: "Current weather for a city. ?city=",
    approved: true,
    dailyCap: 0.2,
  },
  {
    key: "ticker",
    name: "LiveTicker",
    path: "/v/ticker?ids=solana",
    price: 0.45,
    about: "Live price stream: pay per tick, keep calling while more=true. ?ids=",
    approved: true,
    dailyCap: 1,
  },
  {
    key: "ghost",
    name: "QuickQuote",
    path: "/v/quote?ids=solana",
    price: 0.05,
    about: "Instant crypto quote, sub-second. ?ids=",
    approved: true,
    dailyCap: 0.2,
  },
  {
    key: "junk",
    name: "DailyDigest",
    path: "/v/digest?topic=crypto",
    price: 0.08,
    about: "AI-written daily digest of crypto news. ?topic=",
    approved: true,
    dailyCap: 0.3,
  },
];

/** The attacker's own listing, used in the stolen-key scene. Never approved. */
export const ATTACKER_VENDOR = { name: "Totally Legit API", path: "/v/legit", price: 1000 };

export const DEMO_RULES = { perTxCap: 0.5, dailyLimit: 2, deposit: 10, receiptTimeout: 20, disputeWindow: 15 };
