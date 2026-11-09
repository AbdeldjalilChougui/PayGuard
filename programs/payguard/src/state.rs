use anchor_lang::prelude::*;

pub const VAULT_SEED: &[u8] = b"vault";
pub const AGENT_SEED: &[u8] = b"agent";
pub const VENDOR_SEED: &[u8] = b"vendor";
pub const ESCROW_SEED: &[u8] = b"escrow";

pub const MAX_RULES: usize = 8;
pub const MAX_NAME_LEN: usize = 32;
pub const MAX_URL_LEN: usize = 96;
pub const DAY_SECONDS: i64 = 86_400;
pub const MIN_WINDOW: i64 = 5;
pub const MAX_WINDOW: i64 = 7 * DAY_SECONDS;

/// The owner's money. Its associated token account holds the funds; `locked`
/// is the part promised to vendors through open escrows.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub paused: bool,
    pub locked: u64,
    pub agent_count: u32,
    /// Seconds a vendor has to post a receipt after an escrow opens.
    pub receipt_timeout: i64,
    /// Seconds an agent has to dispute after a receipt.
    pub dispute_window: i64,
    pub bump: u8,
}

/// One budget line: an approved vendor and its own daily cap (0 = no cap).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub struct VendorRule {
    pub vendor: Pubkey,
    pub daily_cap: u64,
    pub spent_today: u64,
}

/// Input form of a rule: the counter is kept by the program.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct VendorRuleInput {
    pub vendor: Pubkey,
    pub daily_cap: u64,
}

/// What one agent key may spend from a vault.
#[account]
#[derive(InitSpace)]
pub struct AgentPolicy {
    pub vault: Pubkey,
    pub agent: Pubkey,
    pub per_tx_cap: u64,
    pub daily_limit: u64,
    pub spent_today: u64,
    pub day_start: i64,
    pub total_spent: u64,
    pub total_refunded: u64,
    pub pay_count: u64,
    pub paused: bool,
    #[max_len(MAX_RULES)]
    pub rules: Vec<VendorRule>,
    pub bump: u8,
}

impl AgentPolicy {
    /// Starts a new 24h window once the current one has elapsed.
    pub fn roll_day(&mut self, now: i64) {
        if now - self.day_start >= DAY_SECONDS {
            self.day_start = now;
            self.spent_today = 0;
            for rule in self.rules.iter_mut() {
                rule.spent_today = 0;
            }
        }
    }

    pub fn rule_index(&self, vendor: &Pubkey) -> Option<usize> {
        self.rules.iter().position(|r| &r.vendor == vendor)
    }
}

/// A marketplace listing. The counters are the vendor's on-chain reputation.
#[account]
#[derive(InitSpace)]
pub struct Vendor {
    pub authority: Pubkey,
    pub pay_to: Pubkey,
    pub mint: Pubkey,
    #[max_len(MAX_NAME_LEN)]
    pub name: String,
    #[max_len(MAX_URL_LEN)]
    pub url: String,
    pub price: u64,
    pub active: bool,
    pub sales: u64,
    pub delivered: u64,
    pub refunded: u64,
    pub disputed: u64,
    pub revenue: u64,
    pub created_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub enum EscrowStatus {
    Locked,
    Delivered,
}

/// Money promised to a vendor for one request. Closed on release or refund.
#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub vault: Pubkey,
    pub agent_policy: Pubkey,
    pub vendor: Pubkey,
    /// Pays the rent and gets it back when the escrow closes.
    pub payer: Pubkey,
    pub amount: u64,
    pub nonce: [u8; 16],
    pub created_at: i64,
    pub deadline: i64,
    pub dispute_end: i64,
    pub status: EscrowStatus,
    pub receipt_hash: [u8; 32],
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum RefundReason {
    Expired,
    Disputed,
}

#[event]
pub struct VaultUpdated {
    pub vault: Pubkey,
    pub paused: bool,
    pub receipt_timeout: i64,
    pub dispute_window: i64,
}

#[event]
pub struct AgentUpdated {
    pub vault: Pubkey,
    pub agent_policy: Pubkey,
    pub agent: Pubkey,
    pub per_tx_cap: u64,
    pub daily_limit: u64,
    pub paused: bool,
}

#[event]
pub struct VendorUpdated {
    pub vendor: Pubkey,
    pub price: u64,
    pub active: bool,
}

#[event]
pub struct EscrowOpened {
    pub escrow: Pubkey,
    pub vault: Pubkey,
    pub agent_policy: Pubkey,
    pub vendor: Pubkey,
    pub amount: u64,
    pub nonce: [u8; 16],
    pub deadline: i64,
}

#[event]
pub struct ReceiptPosted {
    pub escrow: Pubkey,
    pub vault: Pubkey,
    pub vendor: Pubkey,
    pub receipt_hash: [u8; 32],
    pub dispute_end: i64,
}

#[event]
pub struct EscrowReleased {
    pub escrow: Pubkey,
    pub vault: Pubkey,
    pub vendor: Pubkey,
    pub amount: u64,
    pub early: bool,
}

#[event]
pub struct EscrowRefunded {
    pub escrow: Pubkey,
    pub vault: Pubkey,
    pub vendor: Pubkey,
    pub amount: u64,
    pub reason: RefundReason,
}
