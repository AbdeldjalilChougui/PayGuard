//! Fast local tests of every rule and escrow path, with a controllable clock.
//! Run after `anchor build`: `cargo test -p payguard --test escrow`.

use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::{instruction::Instruction, program_pack::Pack},
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use anchor_spl::{associated_token::get_associated_token_address, token::spl_token};
use litesvm::LiteSVM;
use payguard::{AgentPolicy, Escrow, EscrowStatus, Vault, Vendor, VendorRuleInput};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

const PRICE: u64 = 50_000; // 0.05 with 6 decimals
const CAP: u64 = 500_000;
const DAILY: u64 = 2_000_000;
const RECEIPT_TIMEOUT: i64 = 20;
const DISPUTE_WINDOW: i64 = 10;

struct Env {
    svm: LiteSVM,
    owner: Keypair,
    agent: Keypair,
    vendor_auth: Keypair,
    lookalike_auth: Keypair,
    mint: Pubkey,
    vault: Pubkey,
    vault_token: Pubkey,
    owner_token: Pubkey,
    agent_policy: Pubkey,
    vendor: Pubkey,
    vendor_token: Pubkey,
    lookalike: Pubkey,
    nonce_counter: u8,
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &payguard::ID).0
}

fn put_mint(svm: &mut LiteSVM, mint: Pubkey, authority: Pubkey) {
    let mut data = vec![0u8; spl_token::state::Mint::LEN];
    spl_token::state::Mint {
        mint_authority: Some(authority).into(),
        supply: 1_000_000_000_000,
        decimals: 6,
        is_initialized: true,
        freeze_authority: None.into(),
    }
    .pack_into_slice(&mut data);
    svm.set_account(
        mint,
        solana_account::Account { lamports: 1_000_000_000, data, owner: spl_token::ID, executable: false, rent_epoch: 0 },
    )
    .unwrap();
}

fn put_token(svm: &mut LiteSVM, address: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
    let mut data = vec![0u8; spl_token::state::Account::LEN];
    spl_token::state::Account {
        mint,
        owner,
        amount,
        delegate: None.into(),
        state: spl_token::state::AccountState::Initialized,
        is_native: None.into(),
        delegated_amount: 0,
        close_authority: None.into(),
    }
    .pack_into_slice(&mut data);
    svm.set_account(
        address,
        solana_account::Account { lamports: 1_000_000_000, data, owner: spl_token::ID, executable: false, rent_epoch: 0 },
    )
    .unwrap();
}

fn token_amount(svm: &LiteSVM, address: Pubkey) -> u64 {
    spl_token::state::Account::unpack(&svm.get_account(&address).unwrap().data).unwrap().amount
}

fn fetch<T: AccountDeserialize>(svm: &LiteSVM, address: Pubkey) -> T {
    T::try_deserialize(&mut svm.get_account(&address).unwrap().data.as_slice()).unwrap()
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/test-sbf/payguard.so");
        svm.add_program_from_file(payguard::ID, so).expect("run `pnpm test:program` (builds target/test-sbf)");

        let owner = Keypair::new();
        let agent = Keypair::new();
        let vendor_auth = Keypair::new();
        let lookalike_auth = Keypair::new();
        for k in [&owner, &agent, &vendor_auth, &lookalike_auth] {
            svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }

        let mint = Pubkey::new_unique();
        put_mint(&mut svm, mint, owner.pubkey());
        let owner_token = get_associated_token_address(&owner.pubkey(), &mint);
        put_token(&mut svm, owner_token, mint, owner.pubkey(), 100_000_000);
        let vendor_token = get_associated_token_address(&vendor_auth.pubkey(), &mint);
        put_token(&mut svm, vendor_token, mint, vendor_auth.pubkey(), 0);

        let vault = pda(&[b"vault", owner.pubkey().as_ref(), mint.as_ref()]);
        let vault_token = get_associated_token_address(&vault, &mint);
        let agent_policy = pda(&[b"agent", vault.as_ref(), agent.pubkey().as_ref()]);
        let vendor = pda(&[b"vendor", vendor_auth.pubkey().as_ref()]);
        let lookalike = pda(&[b"vendor", lookalike_auth.pubkey().as_ref()]);

        let mut env = Env {
            svm,
            owner,
            agent,
            vendor_auth,
            lookalike_auth,
            mint,
            vault,
            vault_token,
            owner_token,
            agent_policy,
            vendor,
            vendor_token,
            lookalike,
            nonce_counter: 0,
        };

        env.ok(
            payguard::accounts::CreateVault {
                owner: env.owner.pubkey(),
                mint,
                vault,
                vault_token,
                token_program: spl_token::ID,
                associated_token_program: anchor_spl::associated_token::ID,
                system_program: anchor_lang::system_program::ID,
            },
            payguard::instruction::CreateVault { receipt_timeout: RECEIPT_TIMEOUT, dispute_window: DISPUTE_WINDOW },
            &[&env.owner.insecure_clone()],
        );
        env.ok(env.funds_accounts(), payguard::instruction::Deposit { amount: 10_000_000 }, &[&env.owner.insecure_clone()]);

        for (auth, name) in [(env.vendor_auth.insecure_clone(), "CoinData Pro"), (env.lookalike_auth.insecure_clone(), "CoinDatas Pro")] {
            let vendor = pda(&[b"vendor", auth.pubkey().as_ref()]);
            env.ok(
                payguard::accounts::RegisterVendor {
                    authority: auth.pubkey(),
                    mint,
                    vendor,
                    system_program: anchor_lang::system_program::ID,
                },
                payguard::instruction::RegisterVendor {
                    name: name.into(),
                    url: "https://example.com/prices".into(),
                    price: PRICE,
                    pay_to: auth.pubkey(),
                },
                &[&auth],
            );
        }

        env.ok(
            payguard::accounts::AddAgent {
                owner: env.owner.pubkey(),
                vault,
                agent: env.agent.pubkey(),
                agent_policy,
                system_program: anchor_lang::system_program::ID,
            },
            payguard::instruction::AddAgent {
                per_tx_cap: CAP,
                daily_limit: DAILY,
                rules: vec![VendorRuleInput { vendor: env.vendor, daily_cap: 4 * PRICE }],
            },
            &[&env.owner.insecure_clone()],
        );
        env
    }

    fn funds_accounts(&self) -> payguard::accounts::OwnerFunds {
        payguard::accounts::OwnerFunds {
            owner: self.owner.pubkey(),
            vault: self.vault,
            mint: self.mint,
            vault_token: self.vault_token,
            owner_token: self.owner_token,
            token_program: spl_token::ID,
        }
    }

    fn send(&mut self, accounts: impl ToAccountMetas, data: impl InstructionData, signers: &[&Keypair]) -> Result<(), String> {
        let ix = Instruction { program_id: payguard::ID, accounts: accounts.to_account_metas(None), data: data.data() };
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(&[ix], Some(&signers[0].pubkey()), signers, self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.meta.logs))
    }

    fn ok(&mut self, accounts: impl ToAccountMetas, data: impl InstructionData, signers: &[&Keypair]) {
        if let Err(logs) = self.send(accounts, data, signers) {
            panic!("transaction failed: {logs}");
        }
    }

    fn fails_with(&mut self, code: &str, accounts: impl ToAccountMetas, data: impl InstructionData, signers: &[&Keypair]) {
        match self.send(accounts, data, signers) {
            Ok(()) => panic!("expected {code}, transaction succeeded"),
            Err(logs) => assert!(logs.contains(code), "expected {code}, got {logs}"),
        }
    }

    fn warp(&mut self, seconds: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp += seconds;
        self.svm.set_sysvar(&clock);
    }

    fn next_nonce(&mut self) -> [u8; 16] {
        self.nonce_counter += 1;
        [self.nonce_counter; 16]
    }

    fn escrow_pda(&self, nonce: &[u8; 16]) -> Pubkey {
        pda(&[b"escrow", self.agent_policy.as_ref(), nonce])
    }

    fn open_accounts(&self, vendor: Pubkey, nonce: &[u8; 16]) -> payguard::accounts::OpenEscrow {
        payguard::accounts::OpenEscrow {
            agent: self.agent.pubkey(),
            vault: self.vault,
            vault_token: self.vault_token,
            agent_policy: self.agent_policy,
            vendor,
            escrow: self.escrow_pda(nonce),
            system_program: anchor_lang::system_program::ID,
        }
    }

    /// Opens an escrow to the approved vendor and returns its address.
    fn open(&mut self, amount: u64) -> ([u8; 16], Pubkey) {
        let nonce = self.next_nonce();
        let accounts = self.open_accounts(self.vendor, &nonce);
        self.ok(accounts, payguard::instruction::OpenEscrow { amount, nonce }, &[&self.agent.insecure_clone()]);
        (nonce, self.escrow_pda(&nonce))
    }

    fn open_fails(&mut self, code: &str, vendor: Pubkey, amount: u64) {
        let nonce = self.next_nonce();
        let accounts = self.open_accounts(vendor, &nonce);
        self.fails_with(code, accounts, payguard::instruction::OpenEscrow { amount, nonce }, &[&self.agent.insecure_clone()]);
    }

    fn receipt(&mut self, escrow: Pubkey) -> Result<(), String> {
        let accounts = payguard::accounts::PostReceipt {
            authority: self.vendor_auth.pubkey(),
            vendor: self.vendor,
            vault: self.vault,
            escrow,
        };
        let auth = self.vendor_auth.insecure_clone();
        self.send(accounts, payguard::instruction::PostReceipt { receipt_hash: [7; 32] }, &[&auth])
    }

    fn release_accounts(&self, escrow: Pubkey) -> payguard::accounts::Release {
        payguard::accounts::Release {
            escrow,
            payer: self.agent.pubkey(),
            vault: self.vault,
            vault_token: self.vault_token,
            mint: self.mint,
            vendor: self.vendor,
            vendor_token: self.vendor_token,
            token_program: spl_token::ID,
        }
    }

    fn dispute_accounts(&self, escrow: Pubkey) -> payguard::accounts::Dispute {
        payguard::accounts::Dispute {
            agent: self.agent.pubkey(),
            agent_policy: self.agent_policy,
            escrow,
            payer: self.agent.pubkey(),
            vault: self.vault,
            vendor: self.vendor,
        }
    }

    fn refund_accounts(&self, escrow: Pubkey) -> payguard::accounts::RefundExpired {
        payguard::accounts::RefundExpired {
            escrow,
            payer: self.agent.pubkey(),
            agent_policy: self.agent_policy,
            vault: self.vault,
            vendor: self.vendor,
        }
    }

    fn policy(&self) -> AgentPolicy {
        fetch(&self.svm, self.agent_policy)
    }
    fn vault_state(&self) -> Vault {
        fetch(&self.svm, self.vault)
    }
    fn vendor_state(&self) -> Vendor {
        fetch(&self.svm, self.vendor)
    }
}

#[test]
fn happy_path_accept_pays_vendor() {
    let mut env = Env::new();
    let (_, escrow) = env.open(PRICE);
    assert_eq!(env.vault_state().locked, PRICE);
    assert_eq!(fetch::<Escrow>(&env.svm, escrow).status, EscrowStatus::Locked);

    env.receipt(escrow).unwrap();
    assert_eq!(fetch::<Escrow>(&env.svm, escrow).status, EscrowStatus::Delivered);

    let accounts = payguard::accounts::Accept {
        agent: env.agent.pubkey(),
        agent_policy: env.agent_policy,
        escrow,
        payer: env.agent.pubkey(),
        vault: env.vault,
        vault_token: env.vault_token,
        mint: env.mint,
        vendor: env.vendor,
        vendor_token: env.vendor_token,
        token_program: spl_token::ID,
    };
    let agent = env.agent.insecure_clone();
    env.ok(accounts, payguard::instruction::Accept {}, &[&agent]);

    assert_eq!(token_amount(&env.svm, env.vendor_token), PRICE);
    assert_eq!(env.vault_state().locked, 0);
    assert!(env.svm.get_account(&escrow).map_or(true, |a| a.lamports == 0), "escrow closed");
    let v = env.vendor_state();
    assert_eq!((v.sales, v.delivered, v.revenue), (1, 1, PRICE));
    assert_eq!(env.policy().spent_today, PRICE);
}

#[test]
fn firewall_rules_block_bad_payments() {
    let mut env = Env::new();
    let lookalike = env.lookalike;
    let vendor = env.vendor;
    env.open_fails("VendorNotAllowed", lookalike, PRICE);
    env.open_fails("OverListedPrice", vendor, 4_000_000);
    env.open_fails("ZeroAmount", vendor, 0);

    // Per-vendor budget is 4 x price.
    for _ in 0..4 {
        env.open(PRICE);
    }
    env.open_fails("OverVendorBudget", vendor, PRICE);
    assert_eq!(env.policy().rules[0].spent_today, 4 * PRICE);

    // Pause switches.
    let owner = env.owner.insecure_clone();
    let accounts = payguard::accounts::OwnerAgent { owner: owner.pubkey(), vault: env.vault, agent_policy: env.agent_policy };
    env.ok(accounts, payguard::instruction::SetAgentPaused { paused: true }, &[&owner]);
    env.open_fails("AgentPaused", vendor, 1);
    let accounts = payguard::accounts::OwnerAgent { owner: owner.pubkey(), vault: env.vault, agent_policy: env.agent_policy };
    env.ok(accounts, payguard::instruction::SetAgentPaused { paused: false }, &[&owner]);
    let accounts = payguard::accounts::OwnerVault { owner: owner.pubkey(), vault: env.vault };
    env.ok(accounts, payguard::instruction::SetVaultPaused { paused: true }, &[&owner]);
    env.open_fails("VaultPaused", vendor, 1);
}

#[test]
fn cap_and_daily_limit() {
    let mut env = Env::new();
    // Raise the listed price and remove the vendor budget to reach the agent limits.
    let auth = env.vendor_auth.insecure_clone();
    let accounts = payguard::accounts::UpdateVendor { authority: auth.pubkey(), vendor: env.vendor };
    env.ok(accounts, payguard::instruction::UpdateVendor { url: "https://x".into(), price: 1_000_000, active: true }, &[&auth]);
    let owner = env.owner.insecure_clone();
    let accounts = payguard::accounts::OwnerAgent { owner: owner.pubkey(), vault: env.vault, agent_policy: env.agent_policy };
    let rules = vec![VendorRuleInput { vendor: env.vendor, daily_cap: 0 }];
    env.ok(accounts, payguard::instruction::UpdateAgent { per_tx_cap: CAP, daily_limit: DAILY, rules }, &[&owner]);

    let vendor = env.vendor;
    env.open_fails("OverPerTxCap", vendor, CAP + 1);
    for _ in 0..4 {
        env.open(CAP);
    }
    env.open_fails("OverDailyLimit", vendor, 1);

    // A new day resets the budget.
    env.warp(86_400);
    env.open(CAP);
    assert_eq!(env.policy().spent_today, CAP);
}

#[test]
fn receipt_is_single_use_and_has_a_deadline() {
    let mut env = Env::new();
    let (_, escrow) = env.open(PRICE);
    env.receipt(escrow).unwrap();
    let again = env.receipt(escrow).unwrap_err();
    assert!(again.contains("WrongEscrowState"), "{again}");

    let (_, late) = env.open(PRICE);
    env.warp(RECEIPT_TIMEOUT + 1);
    let err = env.receipt(late).unwrap_err();
    assert!(err.contains("ReceiptTooLate"), "{err}");
}

#[test]
fn ghost_vendor_is_refunded_after_deadline() {
    let mut env = Env::new();
    let (_, escrow) = env.open(PRICE);
    let agent = env.agent.insecure_clone();

    let accounts = env.refund_accounts(escrow);
    env.fails_with("NotExpired", accounts, payguard::instruction::RefundExpired {}, &[&agent]);

    env.warp(RECEIPT_TIMEOUT + 1);
    // Anyone can crank the refund: here the owner pays the fee.
    let owner = env.owner.insecure_clone();
    let accounts = env.refund_accounts(escrow);
    env.ok(accounts, payguard::instruction::RefundExpired {}, &[&owner]);

    assert_eq!(env.vault_state().locked, 0);
    let p = env.policy();
    assert_eq!((p.spent_today, p.rules[0].spent_today, p.total_refunded), (0, 0, PRICE));
    assert_eq!(env.vendor_state().refunded, 1);
    assert_eq!(token_amount(&env.svm, env.vendor_token), 0);
}

#[test]
fn junk_is_disputed_within_window_only() {
    let mut env = Env::new();
    let agent = env.agent.insecure_clone();

    let (_, junk) = env.open(PRICE);
    env.receipt(junk).unwrap();
    let accounts = env.dispute_accounts(junk);
    env.ok(accounts, payguard::instruction::Dispute {}, &[&agent]);
    assert_eq!(env.vendor_state().disputed, 1);
    assert_eq!(env.policy().spent_today, 0);

    let (_, late) = env.open(PRICE);
    env.receipt(late).unwrap();
    let accounts = env.release_accounts(late);
    let owner = env.owner.insecure_clone();
    env.fails_with("DisputeWindowOpen", accounts, payguard::instruction::Release {}, &[&owner]);

    env.warp(DISPUTE_WINDOW + 1);
    let accounts = env.dispute_accounts(late);
    env.fails_with("DisputeWindowClosed", accounts, payguard::instruction::Dispute {}, &[&agent]);
    let accounts = env.release_accounts(late);
    env.ok(accounts, payguard::instruction::Release {}, &[&owner]);
    assert_eq!(token_amount(&env.svm, env.vendor_token), PRICE);
    assert_eq!(env.vendor_state().delivered, 1);
}

#[test]
fn owner_cannot_withdraw_locked_funds() {
    let mut env = Env::new();
    env.open(PRICE);
    let owner = env.owner.insecure_clone();
    let balance = token_amount(&env.svm, env.vault_token);
    let accounts = env.funds_accounts();
    env.fails_with("FundsLocked", accounts, payguard::instruction::Withdraw { amount: balance }, &[&owner]);
    let accounts = env.funds_accounts();
    env.ok(accounts, payguard::instruction::Withdraw { amount: balance - PRICE }, &[&owner]);
}

#[test]
fn stolen_or_wrong_keys_are_rejected() {
    let mut env = Env::new();
    let thief = Keypair::new();
    env.svm.airdrop(&thief.pubkey(), 1_000_000_000).unwrap();

    // A key that is not the agent cannot open an escrow on its policy.
    let nonce = env.next_nonce();
    let mut accounts = env.open_accounts(env.vendor, &nonce);
    accounts.agent = thief.pubkey();
    env.fails_with("ConstraintHasOne", accounts, payguard::instruction::OpenEscrow { amount: PRICE, nonce }, &[&thief]);

    // Only the vendor's authority can post a receipt.
    let (_, escrow) = env.open(PRICE);
    let accounts = payguard::accounts::PostReceipt { authority: thief.pubkey(), vendor: env.vendor, vault: env.vault, escrow };
    env.fails_with("ConstraintHasOne", accounts, payguard::instruction::PostReceipt { receipt_hash: [1; 32] }, &[&thief]);

    // Only the owner can pause or withdraw.
    let accounts = payguard::accounts::OwnerVault { owner: thief.pubkey(), vault: env.vault };
    env.fails_with("ConstraintHasOne", accounts, payguard::instruction::SetVaultPaused { paused: false }, &[&thief]);

    // Registering is open to anyone, but approval is the owner's choice.
    let lookalike_auth = env.lookalike_auth.insecure_clone();
    assert_eq!(fetch::<Vendor>(&env.svm, env.lookalike).authority, lookalike_auth.pubkey());
}
