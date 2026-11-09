use anchor_lang::prelude::*;

#[error_code]
pub enum GuardError {
    #[msg("Vault is paused by its owner")]
    VaultPaused,
    #[msg("Agent is paused by its owner")]
    AgentPaused,
    #[msg("Vendor is not approved for this agent")]
    VendorNotAllowed,
    #[msg("Vendor listing is inactive")]
    VendorInactive,
    #[msg("Amount is above the vendor's listed price")]
    OverListedPrice,
    #[msg("Amount exceeds the per-payment cap")]
    OverPerTxCap,
    #[msg("Amount would exceed the agent's daily limit")]
    OverDailyLimit,
    #[msg("Amount would exceed this vendor's daily budget")]
    OverVendorBudget,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("At most 8 vendor rules")]
    TooManyRules,
    #[msg("A vendor appears twice in the rules")]
    DuplicateRule,
    #[msg("Per-payment cap cannot exceed the daily limit")]
    CapAboveDailyLimit,
    #[msg("Window must be between 5 seconds and 7 days")]
    BadWindow,
    #[msg("Name or URL is too long")]
    TextTooLong,
    #[msg("Vendor accepts a different token")]
    WrongMint,
    #[msg("Withdrawal would touch funds locked in escrow")]
    FundsLocked,
    #[msg("Escrow is not in the right state for this action")]
    WrongEscrowState,
    #[msg("Receipt deadline has passed")]
    ReceiptTooLate,
    #[msg("Receipt deadline has not passed yet")]
    NotExpired,
    #[msg("Dispute window has closed")]
    DisputeWindowClosed,
    #[msg("Dispute window is still open")]
    DisputeWindowOpen,
}
