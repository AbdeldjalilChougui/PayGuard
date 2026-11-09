pub mod error;
pub mod state;

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

pub use error::GuardError;
pub use state::*;

declare_id!("8xUaJB1cqfbZhBC2x5yEdChQkLGy7XrNzqDAFnqUtR2e");

#[program]
pub mod payguard {
    use super::*;

    // ── Owner: vault ────────────────────────────────────────────────────────

    /// Creates the owner's vault for one token, with its escrow timings.
    pub fn create_vault(ctx: Context<CreateVault>, receipt_timeout: i64, dispute_window: i64) -> Result<()> {
        check_window(receipt_timeout)?;
        check_window(dispute_window)?;
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.mint = ctx.accounts.mint.key();
        vault.token_account = ctx.accounts.vault_token.key();
        vault.paused = false;
        vault.locked = 0;
        vault.agent_count = 0;
        vault.receipt_timeout = receipt_timeout;
        vault.dispute_window = dispute_window;
        vault.bump = ctx.bumps.vault;
        emit_vault(vault);
        Ok(())
    }

    pub fn deposit(ctx: Context<OwnerFunds>, amount: u64) -> Result<()> {
        require!(amount > 0, GuardError::ZeroAmount);
        let accounts = TransferChecked {
            from: ctx.accounts.owner_token.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault_token.to_account_info(),
            authority: ctx.accounts.owner.to_account_info(),
        };
        token::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.key(), accounts),
            amount,
            ctx.accounts.mint.decimals,
        )
    }

    /// The owner can take back anything not promised to a vendor.
    pub fn withdraw(ctx: Context<OwnerFunds>, amount: u64) -> Result<()> {
        require!(amount > 0, GuardError::ZeroAmount);
        let available = ctx.accounts.vault_token.amount.saturating_sub(ctx.accounts.vault.locked);
        require!(amount <= available, GuardError::FundsLocked);
        transfer_from_vault(
            &ctx.accounts.vault,
            &ctx.accounts.vault_token,
            &ctx.accounts.mint,
            &ctx.accounts.owner_token,
            &ctx.accounts.token_program,
            amount,
        )
    }

    /// Kill switch for every agent of the vault.
    pub fn set_vault_paused(ctx: Context<OwnerVault>, paused: bool) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.paused = paused;
        emit_vault(vault);
        Ok(())
    }

    pub fn update_vault_timing(ctx: Context<OwnerVault>, receipt_timeout: i64, dispute_window: i64) -> Result<()> {
        check_window(receipt_timeout)?;
        check_window(dispute_window)?;
        let vault = &mut ctx.accounts.vault;
        vault.receipt_timeout = receipt_timeout;
        vault.dispute_window = dispute_window;
        emit_vault(vault);
        Ok(())
    }

    // ── Owner: agents ───────────────────────────────────────────────────────

    pub fn add_agent(
        ctx: Context<AddAgent>,
        per_tx_cap: u64,
        daily_limit: u64,
        rules: Vec<VendorRuleInput>,
    ) -> Result<()> {
        validate_agent(per_tx_cap, daily_limit, &rules)?;
        let policy = &mut ctx.accounts.agent_policy;
        policy.vault = ctx.accounts.vault.key();
        policy.agent = ctx.accounts.agent.key();
        policy.per_tx_cap = per_tx_cap;
        policy.daily_limit = daily_limit;
        policy.spent_today = 0;
        policy.day_start = Clock::get()?.unix_timestamp;
        policy.total_spent = 0;
        policy.total_refunded = 0;
        policy.pay_count = 0;
        policy.paused = false;
        policy.rules = rules
            .iter()
            .map(|r| VendorRule { vendor: r.vendor, daily_cap: r.daily_cap, spent_today: 0 })
            .collect();
        policy.bump = ctx.bumps.agent_policy;
        let vault = &mut ctx.accounts.vault;
        vault.agent_count = vault.agent_count.saturating_add(1);
        emit_agent(policy);
        Ok(())
    }

    /// Replaces caps and rules; today's spend is kept for vendors that stay.
    pub fn update_agent(
        ctx: Context<OwnerAgent>,
        per_tx_cap: u64,
        daily_limit: u64,
        rules: Vec<VendorRuleInput>,
    ) -> Result<()> {
        validate_agent(per_tx_cap, daily_limit, &rules)?;
        let policy = &mut ctx.accounts.agent_policy;
        let old = policy.rules.clone();
        policy.per_tx_cap = per_tx_cap;
        policy.daily_limit = daily_limit;
        policy.rules = rules
            .iter()
            .map(|r| VendorRule {
                vendor: r.vendor,
                daily_cap: r.daily_cap,
                spent_today: old.iter().find(|o| o.vendor == r.vendor).map_or(0, |o| o.spent_today),
            })
            .collect();
        emit_agent(policy);
        Ok(())
    }

    pub fn set_agent_paused(ctx: Context<OwnerAgent>, paused: bool) -> Result<()> {
        let policy = &mut ctx.accounts.agent_policy;
        policy.paused = paused;
        emit_agent(policy);
        Ok(())
    }

    // ── Vendors: marketplace ────────────────────────────────────────────────

    /// Anyone can list a service. Approval is each owner's decision.
    pub fn register_vendor(
        ctx: Context<RegisterVendor>,
        name: String,
        url: String,
        price: u64,
        pay_to: Pubkey,
    ) -> Result<()> {
        require!(name.len() <= MAX_NAME_LEN && url.len() <= MAX_URL_LEN, GuardError::TextTooLong);
        require!(price > 0, GuardError::ZeroAmount);
        let vendor = &mut ctx.accounts.vendor;
        vendor.authority = ctx.accounts.authority.key();
        vendor.pay_to = pay_to;
        vendor.mint = ctx.accounts.mint.key();
        vendor.name = name;
        vendor.url = url;
        vendor.price = price;
        vendor.active = true;
        vendor.sales = 0;
        vendor.delivered = 0;
        vendor.refunded = 0;
        vendor.disputed = 0;
        vendor.revenue = 0;
        vendor.created_at = Clock::get()?.unix_timestamp;
        vendor.bump = ctx.bumps.vendor;
        emit!(VendorUpdated { vendor: vendor.key(), price, active: true });
        Ok(())
    }

    pub fn update_vendor(ctx: Context<UpdateVendor>, url: String, price: u64, active: bool) -> Result<()> {
        require!(url.len() <= MAX_URL_LEN, GuardError::TextTooLong);
        require!(price > 0, GuardError::ZeroAmount);
        let vendor = &mut ctx.accounts.vendor;
        vendor.url = url;
        vendor.price = price;
        vendor.active = active;
        emit!(VendorUpdated { vendor: vendor.key(), price, active });
        Ok(())
    }

    // ── Agent: escrow ───────────────────────────────────────────────────────

    /// The agent's only way to spend. Every rule is checked here, then the
    /// amount is locked in the vault until the vendor delivers.
    pub fn open_escrow(ctx: Context<OpenEscrow>, amount: u64, nonce: [u8; 16]) -> Result<()> {
        require!(amount > 0, GuardError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let vault = &mut ctx.accounts.vault;
        let policy = &mut ctx.accounts.agent_policy;
        let vendor = &mut ctx.accounts.vendor;
        let vendor_key = vendor.key();

        require!(!vault.paused, GuardError::VaultPaused);
        require!(!policy.paused, GuardError::AgentPaused);
        let rule = policy.rule_index(&vendor_key).ok_or(GuardError::VendorNotAllowed)?;
        require!(vendor.active, GuardError::VendorInactive);
        require!(vendor.mint == vault.mint, GuardError::WrongMint);
        require!(amount <= vendor.price, GuardError::OverListedPrice);
        require!(amount <= policy.per_tx_cap, GuardError::OverPerTxCap);

        policy.roll_day(now);
        let spent = policy.spent_today.checked_add(amount).ok_or(GuardError::OverDailyLimit)?;
        require!(spent <= policy.daily_limit, GuardError::OverDailyLimit);
        let line = &mut policy.rules[rule];
        let vendor_spent = line.spent_today.checked_add(amount).ok_or(GuardError::OverVendorBudget)?;
        require!(line.daily_cap == 0 || vendor_spent <= line.daily_cap, GuardError::OverVendorBudget);

        let available = ctx.accounts.vault_token.amount.saturating_sub(vault.locked);
        require!(amount <= available, GuardError::FundsLocked);

        line.spent_today = vendor_spent;
        policy.spent_today = spent;
        policy.total_spent = policy.total_spent.saturating_add(amount);
        policy.pay_count = policy.pay_count.saturating_add(1);
        vault.locked = vault.locked.saturating_add(amount);
        vendor.sales = vendor.sales.saturating_add(1);

        let escrow = &mut ctx.accounts.escrow;
        escrow.vault = vault.key();
        escrow.agent_policy = policy.key();
        escrow.vendor = vendor_key;
        escrow.payer = ctx.accounts.agent.key();
        escrow.amount = amount;
        escrow.nonce = nonce;
        escrow.created_at = now;
        escrow.deadline = now.saturating_add(vault.receipt_timeout);
        escrow.dispute_end = 0;
        escrow.status = EscrowStatus::Locked;
        escrow.receipt_hash = [0; 32];
        escrow.bump = ctx.bumps.escrow;

        msg!("payguard:escrow:{}", hex(&nonce));
        emit!(EscrowOpened {
            escrow: escrow.key(),
            vault: escrow.vault,
            agent_policy: escrow.agent_policy,
            vendor: vendor_key,
            amount,
            nonce,
            deadline: escrow.deadline,
        });
        Ok(())
    }

    /// The vendor commits to what it delivered. Only works once per escrow,
    /// which makes every payment single-use.
    pub fn post_receipt(ctx: Context<PostReceipt>, receipt_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Locked, GuardError::WrongEscrowState);
        require!(now <= escrow.deadline, GuardError::ReceiptTooLate);
        escrow.status = EscrowStatus::Delivered;
        escrow.receipt_hash = receipt_hash;
        escrow.dispute_end = now.saturating_add(ctx.accounts.vault.dispute_window);
        emit!(ReceiptPosted {
            escrow: escrow.key(),
            vault: escrow.vault,
            vendor: escrow.vendor,
            receipt_hash,
            dispute_end: escrow.dispute_end,
        });
        Ok(())
    }

    /// The agent is happy with the response: pay the vendor now.
    pub fn accept(ctx: Context<Accept>) -> Result<()> {
        require!(ctx.accounts.escrow.status == EscrowStatus::Delivered, GuardError::WrongEscrowState);
        pay_vendor(
            &mut ctx.accounts.vault,
            &ctx.accounts.vault_token,
            &ctx.accounts.mint,
            &mut ctx.accounts.vendor,
            &ctx.accounts.vendor_token,
            &ctx.accounts.token_program,
            &ctx.accounts.escrow,
            true,
        )
    }

    /// Anyone can pay the vendor once the dispute window has closed.
    pub fn release(ctx: Context<Release>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Delivered, GuardError::WrongEscrowState);
        require!(Clock::get()?.unix_timestamp >= escrow.dispute_end, GuardError::DisputeWindowOpen);
        pay_vendor(
            &mut ctx.accounts.vault,
            &ctx.accounts.vault_token,
            &ctx.accounts.mint,
            &mut ctx.accounts.vendor,
            &ctx.accounts.vendor_token,
            &ctx.accounts.token_program,
            &ctx.accounts.escrow,
            false,
        )
    }

    /// The agent rejects what it got: the money goes back to the vault.
    pub fn dispute(ctx: Context<Dispute>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Delivered, GuardError::WrongEscrowState);
        require!(Clock::get()?.unix_timestamp < escrow.dispute_end, GuardError::DisputeWindowClosed);
        refund(
            &mut ctx.accounts.vault,
            &mut ctx.accounts.agent_policy,
            &mut ctx.accounts.vendor,
            escrow,
            RefundReason::Disputed,
        )
    }

    /// Anyone can refund an escrow the vendor never answered.
    pub fn refund_expired(ctx: Context<RefundExpired>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Locked, GuardError::WrongEscrowState);
        require!(Clock::get()?.unix_timestamp > escrow.deadline, GuardError::NotExpired);
        refund(
            &mut ctx.accounts.vault,
            &mut ctx.accounts.agent_policy,
            &mut ctx.accounts.vendor,
            escrow,
            RefundReason::Expired,
        )
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn check_window(seconds: i64) -> Result<()> {
    require!((MIN_WINDOW..=MAX_WINDOW).contains(&seconds), GuardError::BadWindow);
    Ok(())
}

fn validate_agent(per_tx_cap: u64, daily_limit: u64, rules: &[VendorRuleInput]) -> Result<()> {
    require!(per_tx_cap <= daily_limit, GuardError::CapAboveDailyLimit);
    require!(rules.len() <= MAX_RULES, GuardError::TooManyRules);
    for (i, r) in rules.iter().enumerate() {
        require!(rules[..i].iter().all(|o| o.vendor != r.vendor), GuardError::DuplicateRule);
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn emit_vault(vault: &Account<Vault>) {
    emit!(VaultUpdated {
        vault: vault.key(),
        paused: vault.paused,
        receipt_timeout: vault.receipt_timeout,
        dispute_window: vault.dispute_window,
    });
}

fn emit_agent(policy: &Account<AgentPolicy>) {
    emit!(AgentUpdated {
        vault: policy.vault,
        agent_policy: policy.key(),
        agent: policy.agent,
        per_tx_cap: policy.per_tx_cap,
        daily_limit: policy.daily_limit,
        paused: policy.paused,
    });
}

fn transfer_from_vault<'info>(
    vault: &Account<'info, Vault>,
    vault_token: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    to: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[VAULT_SEED, vault.owner.as_ref(), vault.mint.as_ref(), &[vault.bump]];
    let signer = &[seeds];
    let accounts = TransferChecked {
        from: vault_token.to_account_info(),
        mint: mint.to_account_info(),
        to: to.to_account_info(),
        authority: vault.to_account_info(),
    };
    token::transfer_checked(
        CpiContext::new_with_signer(token_program.key(), accounts, signer),
        amount,
        mint.decimals,
    )
}

#[allow(clippy::too_many_arguments)]
fn pay_vendor<'info>(
    vault: &mut Account<'info, Vault>,
    vault_token: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    vendor: &mut Account<'info, Vendor>,
    vendor_token: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    escrow: &Account<'info, Escrow>,
    early: bool,
) -> Result<()> {
    transfer_from_vault(vault, vault_token, mint, vendor_token, token_program, escrow.amount)?;
    vault.locked = vault.locked.saturating_sub(escrow.amount);
    vendor.delivered = vendor.delivered.saturating_add(1);
    vendor.revenue = vendor.revenue.saturating_add(escrow.amount);
    emit!(EscrowReleased {
        escrow: escrow.key(),
        vault: vault.key(),
        vendor: vendor.key(),
        amount: escrow.amount,
        early,
    });
    Ok(())
}

/// Unlocks the money and gives the agent its budget back if the escrow was
/// opened in the current day window.
fn refund(
    vault: &mut Account<Vault>,
    policy: &mut Account<AgentPolicy>,
    vendor: &mut Account<Vendor>,
    escrow: &Account<Escrow>,
    reason: RefundReason,
) -> Result<()> {
    let amount = escrow.amount;
    vault.locked = vault.locked.saturating_sub(amount);
    policy.total_spent = policy.total_spent.saturating_sub(amount);
    policy.total_refunded = policy.total_refunded.saturating_add(amount);
    if escrow.created_at >= policy.day_start {
        policy.spent_today = policy.spent_today.saturating_sub(amount);
        if let Some(i) = policy.rule_index(&escrow.vendor) {
            policy.rules[i].spent_today = policy.rules[i].spent_today.saturating_sub(amount);
        }
    }
    match reason {
        RefundReason::Expired => vendor.refunded = vendor.refunded.saturating_add(1),
        RefundReason::Disputed => vendor.disputed = vendor.disputed.saturating_add(1),
    }
    emit!(EscrowRefunded { escrow: escrow.key(), vault: vault.key(), vendor: vendor.key(), amount, reason });
    Ok(())
}

// ── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct CreateVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = owner,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, owner.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = vault
    )]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerFunds<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = owner, has_one = mint)]
    pub vault: Account<'info, Vault>,
    pub mint: Account<'info, Mint>,
    #[account(mut, address = vault.token_account)]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OwnerVault<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct AddAgent<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub vault: Account<'info, Vault>,
    /// CHECK: only its public key is stored; the agent signs later.
    pub agent: UncheckedAccount<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + AgentPolicy::INIT_SPACE,
        seeds = [AGENT_SEED, vault.key().as_ref(), agent.key().as_ref()],
        bump
    )]
    pub agent_policy: Account<'info, AgentPolicy>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerAgent<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = owner)]
    pub vault: Account<'info, Vault>,
    #[account(mut, has_one = vault)]
    pub agent_policy: Account<'info, AgentPolicy>,
}

#[derive(Accounts)]
pub struct RegisterVendor<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        space = 8 + Vendor::INIT_SPACE,
        seeds = [VENDOR_SEED, authority.key().as_ref()],
        bump
    )]
    pub vendor: Account<'info, Vendor>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateVendor<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority)]
    pub vendor: Account<'info, Vendor>,
}

#[derive(Accounts)]
#[instruction(amount: u64, nonce: [u8; 16])]
pub struct OpenEscrow<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    #[account(address = vault.token_account)]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut, has_one = vault, has_one = agent)]
    pub agent_policy: Account<'info, AgentPolicy>,
    #[account(mut)]
    pub vendor: Account<'info, Vendor>,
    #[account(
        init,
        payer = agent,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, agent_policy.key().as_ref(), nonce.as_ref()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PostReceipt<'info> {
    pub authority: Signer<'info>,
    #[account(has_one = authority)]
    pub vendor: Account<'info, Vendor>,
    #[account(address = escrow.vault)]
    pub vault: Account<'info, Vault>,
    #[account(mut, has_one = vendor)]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct Accept<'info> {
    pub agent: Signer<'info>,
    #[account(has_one = agent)]
    pub agent_policy: Account<'info, AgentPolicy>,
    #[account(mut, close = payer, has_one = agent_policy, has_one = vault, has_one = vendor, has_one = payer)]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: receives the escrow rent; checked by `has_one = payer`.
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
    #[account(mut, has_one = mint)]
    pub vault: Account<'info, Vault>,
    #[account(mut, address = vault.token_account)]
    pub vault_token: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub vendor: Account<'info, Vendor>,
    #[account(mut, token::mint = mint, token::authority = vendor.pay_to)]
    pub vendor_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    #[account(mut, close = payer, has_one = vault, has_one = vendor, has_one = payer)]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: receives the escrow rent; checked by `has_one = payer`.
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
    #[account(mut, has_one = mint)]
    pub vault: Account<'info, Vault>,
    #[account(mut, address = vault.token_account)]
    pub vault_token: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub vendor: Account<'info, Vendor>,
    #[account(mut, token::mint = mint, token::authority = vendor.pay_to)]
    pub vendor_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Dispute<'info> {
    pub agent: Signer<'info>,
    #[account(mut, has_one = agent)]
    pub agent_policy: Account<'info, AgentPolicy>,
    #[account(mut, close = payer, has_one = agent_policy, has_one = vault, has_one = vendor, has_one = payer)]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: receives the escrow rent; checked by `has_one = payer`.
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub vendor: Account<'info, Vendor>,
}

#[derive(Accounts)]
pub struct RefundExpired<'info> {
    #[account(mut, close = payer, has_one = agent_policy, has_one = vault, has_one = vendor, has_one = payer)]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: receives the escrow rent; checked by `has_one = payer`.
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
    #[account(mut)]
    pub agent_policy: Account<'info, AgentPolicy>,
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub vendor: Account<'info, Vendor>,
}
