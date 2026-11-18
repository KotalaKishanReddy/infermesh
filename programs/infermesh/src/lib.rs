use anchor_lang::prelude::*;

declare_id!("FMesh11111111111111111111111111111111111111");

/// Slots after submission during which only the requester can confirm.
/// Afterwards anyone may finalize (optimistic auto-release), so getting
/// paid is never optional for the buyer. ~5.5h at 400ms/slot.
pub const CONFIRM_WINDOW_SLOTS: u64 = 50_000;
/// Slots after a dispute is raised during which the arbiter must resolve.
/// Afterwards anyone may trigger the stale-dispute refund. ~11h.
pub const ARBITER_TIMEOUT_SLOTS: u64 = 100_000;
/// Dispute bond = 10% of budget, floored so spam is never free.
pub const MIN_DISPUTE_BOND: u64 = 50_000;
/// Stake slashed on timeouts and lost disputes: 5%.
pub const SLASH_BPS: u64 = 500;

/// InferMesh: open marketplace for AI inference on Solana.
///
/// Trust model (no buyer-is-judge problem):
/// - Requesters escrow lamports per job into a vault PDA.
/// - Providers stake real lamports + reputation, and are slashed on
///   timeouts and lost disputes — not just downvoted.
/// - Confirmation is a dispute window, not a veto: after
///   CONFIRM_WINDOW_SLOTS anyone may finalize payout.
/// - Disputes require the requester to post a bond and are resolved by a
///   named arbiter key (rotatable), never by locked funds.
#[program]
pub mod infermesh {
    use super::*;

    pub fn initialize_marketplace(
        ctx: Context<InitializeMarketplace>,
        admin: Pubkey,
        arbiter: Pubkey,
        fee_bps: u16,
    ) -> Result<()> {
        require!(fee_bps <= 1_000, ErrorCode::FeeTooHigh);
        let m = &mut ctx.accounts.marketplace;
        m.admin = admin;
        m.arbiter = arbiter;
        m.fee_bps = fee_bps;
        m.total_jobs = 0;
        m.total_providers = 0;
        m.bump = ctx.bumps.marketplace;
        Ok(())
    }

    /// Rotate the admin (treasury + fee governance).
    pub fn set_admin(ctx: Context<SetAdmin>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.marketplace.admin = new_admin;
        Ok(())
    }

    /// Rotate the dispute arbiter. Public rotation plan, enforced onchain.
    pub fn set_arbiter(ctx: Context<SetAdmin>, new_arbiter: Pubkey) -> Result<()> {
        ctx.accounts.marketplace.arbiter = new_arbiter;
        Ok(())
    }

    /// Update the protocol fee (max 1000 bps). Treasury accounting stays
    /// per-job, so fee changes never touch in-flight escrow math.
    pub fn set_fee_bps(ctx: Context<SetAdmin>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= 1_000, ErrorCode::FeeTooHigh);
        ctx.accounts.marketplace.fee_bps = fee_bps;
        Ok(())
    }

    pub fn register_provider(
        ctx: Context<RegisterProvider>,
        endpoint_hash: [u8; 32],
        min_stake: u64,
    ) -> Result<()> {
        // Stake is collected for real and is slashable (see timeout_refund,
        // resolve_dispute). It leaves only via unstake.
        if min_stake > 0 {
            let cpi = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.provider.to_account_info(),
                },
            );
            anchor_lang::system_program::transfer(cpi, min_stake)?;
        }
        let p = &mut ctx.accounts.provider;
        p.owner = ctx.accounts.owner.key();
        p.marketplace = ctx.accounts.marketplace.key();
        p.endpoint_hash = endpoint_hash;
        p.stake = min_stake;
        p.completed_jobs = 0;
        p.failed_jobs = 0;
        p.score_x100 = 1_000; // neutral 10.00 until jobs complete
        p.active = true;
        p.bump = ctx.bumps.provider;
        let m = &mut ctx.accounts.marketplace;
        m.total_providers = m.total_providers.saturating_add(1);
        Ok(())
    }

    /// Owner closes out: deactivates the provider and returns remaining stake.
    /// No operator is asked to lock SOL one-way.
    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        let p = &mut ctx.accounts.provider;
        require!(p.active, ErrorCode::BadJobState);
        require!(p.stake > 0, ErrorCode::NoStake);
        let stake = p.stake;
        p.stake = 0;
        p.active = false;
        move_lamports(
            &ctx.accounts.provider.to_account_info(),
            &ctx.accounts.owner.to_account_info(),
            stake,
        )?;
        Ok(())
    }

    pub fn list_model(
        ctx: Context<ListModel>,
        model_id_hash: [u8; 32],
        price_per_1k_tokens_lamports: u64,
        max_tokens: u32,
    ) -> Result<()> {
        require!(max_tokens > 0, ErrorCode::BadModelParams);
        require!(
            price_per_1k_tokens_lamports > 0,
            ErrorCode::BadModelParams
        );
        // Only the provider's owner can advertise models under its identity.
        require!(
            ctx.accounts.owner.key() == ctx.accounts.provider.owner,
            ErrorCode::NotProviderOwner
        );
        let listing = &mut ctx.accounts.listing;
        listing.provider = ctx.accounts.provider.key();
        listing.model_id_hash = model_id_hash;
        listing.price_per_1k_tokens_lamports = price_per_1k_tokens_lamports;
        listing.max_tokens = max_tokens;
        listing.active = true;
        listing.bump = ctx.bumps.listing;
        Ok(())
    }

    /// Requester opens a job. `budget` lamports move requester -> vault PDA
    /// inside this instruction, so escrow is atomic with job creation.
    pub fn create_job(
        ctx: Context<CreateJob>,
        input_hash: [u8; 32],
        model_id_hash: [u8; 32],
        budget: u64,
        max_tokens: u32,
        deadline_slots: u64,
    ) -> Result<()> {
        require!(budget > 0, ErrorCode::BadJobParams);
        require!(max_tokens > 0, ErrorCode::BadJobParams);
        let cpi = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.requester.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi, budget)?;
        let clock = Clock::get()?;
        let job = &mut ctx.accounts.job;
        job.marketplace = ctx.accounts.marketplace.key();
        job.requester = ctx.accounts.requester.key();
        job.provider = Pubkey::default(); // unassigned: any active provider may claim
        job.model_id_hash = model_id_hash;
        job.input_hash = input_hash;
        job.result_hash = [0u8; 32];
        job.budget = budget;
        job.max_tokens = max_tokens;
        job.input_tokens = 0;
        job.output_tokens = 0;
        job.dispute_bond = 0;
        job.state = JobState::Open as u8;
        job.created_slot = clock.slot;
        job.submitted_slot = 0;
        job.dispute_slot = 0;
        job.deadline_slot = clock.slot.saturating_add(deadline_slots.max(1));
        job.bump = ctx.bumps.job;
        let m = &mut ctx.accounts.marketplace;
        m.total_jobs = m.total_jobs.saturating_add(1);
        job.job_id = m.total_jobs;
        Ok(())
    }

    /// Claim a job for a provider. The listing PDA is re-derived from the
    /// job's own model hash, so the chain enforces: this provider serves
    /// this model, the listing is active, and the job fits its token cap.
    /// Marketplace membership is checked in the handler.
    pub fn claim_job(ctx: Context<ClaimJob>) -> Result<()> {
        // Only the provider's owner can claim work for it; otherwise anyone
        // could attribute jobs to someone else's identity.
        require!(
            ctx.accounts.claimer.key() == ctx.accounts.provider.owner,
            ErrorCode::NotJobProvider
        );
        let clock = Clock::get()?;
        let job = &mut ctx.accounts.job;
        require!(job.state == JobState::Open as u8, ErrorCode::BadJobState);
        require!(
            (clock.slot as i64) < (job.deadline_slot as i64),
            ErrorCode::JobExpired
        );
        require!(ctx.accounts.provider.active, ErrorCode::ProviderInactive);
        require!(
            ctx.accounts.provider.marketplace == job.marketplace,
            ErrorCode::MarketplaceMismatch
        );
        require!(
            job.max_tokens <= ctx.accounts.listing.max_tokens,
            ErrorCode::BadJobParams
        );
        job.provider = ctx.accounts.provider.key();
        job.state = JobState::Claimed as u8;
        Ok(())
    }

    /// Submit a result commitment plus self-reported token counts for
    /// per-token metering records. The signer must be the provider OWNER —
    /// the provider PDA itself can never sign.
    pub fn submit_result(
        ctx: Context<SubmitResult>,
        result_hash: [u8; 32],
        input_tokens: u32,
        output_tokens: u32,
    ) -> Result<()> {
        let job = &mut ctx.accounts.job;
        require!(job.state == JobState::Claimed as u8, ErrorCode::BadJobState);
        require!(input_tokens > 0, ErrorCode::BadJobParams);
        require!(output_tokens > 0, ErrorCode::BadJobParams);
        require!(
            input_tokens <= job.max_tokens && output_tokens <= job.max_tokens,
            ErrorCode::BadJobParams
        );
        job.result_hash = result_hash;
        job.input_tokens = input_tokens;
        job.output_tokens = output_tokens;
        job.submitted_slot = Clock::get()?.slot;
        job.state = JobState::Submitted as u8;
        Ok(())
    }

    /// Requester confirms within the dispute window. Fee math is pure (see
    /// `settle_amounts`) so offchain clients show identical numbers.
    pub fn confirm_result(ctx: Context<ConfirmResult>) -> Result<()> {
        let clock = Clock::get()?;
        {
            let job = &ctx.accounts.job;
            require!(job.state == JobState::Submitted as u8, ErrorCode::BadJobState);
            require!(
                ctx.accounts.requester.key() == job.requester,
                ErrorCode::NotRequester
            );
            require!(
                (clock.slot as i64) < (job.submitted_slot as i64) + (CONFIRM_WINDOW_SLOTS as i64),
                ErrorCode::ConfirmWindowPassed
            );
        }
        let fee_bps = ctx.accounts.marketplace.fee_bps;
        let job = &mut ctx.accounts.job;
        let provider = &mut ctx.accounts.provider;
        crate::pay_out(
            job,
            provider,
            &ctx.accounts.vault,
            &ctx.accounts.provider_recipient.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            fee_bps,
            JobState::Confirmed,
        )
    }

    /// Permissionless optimistic auto-release: once the confirm window passes
    /// with no dispute, anyone can finalize payout. Getting paid is never
    /// optional for the buyer.
    pub fn finalize_job(ctx: Context<FinalizeJob>) -> Result<()> {
        let clock = Clock::get()?;
        {
            let job = &ctx.accounts.job;
            require!(job.state == JobState::Submitted as u8, ErrorCode::BadJobState);
            require!(
                (clock.slot as i64) >= (job.submitted_slot as i64) + (CONFIRM_WINDOW_SLOTS as i64),
                ErrorCode::NotExpired
            );
        }
        let fee_bps = ctx.accounts.marketplace.fee_bps;
        let job = &mut ctx.accounts.job;
        let provider = &mut ctx.accounts.provider;
        crate::pay_out(
            job,
            provider,
            &ctx.accounts.vault,
            &ctx.accounts.provider_recipient.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            fee_bps,
            JobState::Finalized,
        )
    }

    /// Anyone can finalize a refund once the deadline passes with no
    /// submission. Works for claimed AND unclaimed jobs: the provider
    /// account is optional so escrow can never get stuck. A slashed slice
    /// of stake compensates the requester when a provider claimed and
    /// then ghosted.
    pub fn timeout_refund(ctx: Context<TimeoutRefund>) -> Result<()> {
        let clock = Clock::get()?;
        let refund_stale_dispute = {
            let job = &ctx.accounts.job;
            job.state == JobState::Disputed as u8
                && (clock.slot as i64)
                    >= (job.dispute_slot as i64) + (ARBITER_TIMEOUT_SLOTS as i64)
        };
        {
            let job = &ctx.accounts.job;
            require!(
                job.state == JobState::Open as u8
                    || job.state == JobState::Claimed as u8
                    || refund_stale_dispute,
                ErrorCode::BadJobState
            );
            if !refund_stale_dispute {
                require!(
                    (clock.slot as i64) >= (job.deadline_slot as i64),
                    ErrorCode::NotExpired
                );
            }
        }
        let vault_balance = ctx.accounts.vault.to_account_info().lamports();
        let job = &mut ctx.accounts.job;
        // Refund budget (+ bond on stale disputes; the arbiter never showed).
        let mut refund = job.budget;
        if refund_stale_dispute {
            refund = refund.saturating_add(job.dispute_bond);
        }
        require!(vault_balance >= refund, ErrorCode::InsufficientVault);
        move_lamports(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.requester.to_account_info(),
            refund,
        )?;
        job.state = JobState::Refunded as u8;
        if let Some(provider) = ctx.accounts.provider.as_mut() {
            if provider.key() == job.provider && job.provider != Pubkey::default() {
                let slash = slash_amount(provider.stake).min(provider.stake);
                if slash > 0 {
                    move_lamports(
                        &provider.to_account_info(),
                        &ctx.accounts.requester.to_account_info(),
                        slash,
                    )?;
                    provider.stake = provider.stake.saturating_sub(slash);
                }
                provider.failed_jobs = provider.failed_jobs.saturating_add(1);
                let points = score_points(job.budget, false);
                provider.score_x100 = bump_score(provider.score_x100, false, points);
            }
        }
        // Rent returns via the `close = requester` constraints.
        Ok(())
    }

    /// Requester opens a dispute by posting a bond into the vault. Frivolous
    /// disputes cost money; the bond goes to the winner at resolution.
    pub fn raise_dispute(ctx: Context<RaiseDispute>) -> Result<()> {
        let job = &mut ctx.accounts.job;
        require!(job.state == JobState::Submitted as u8, ErrorCode::BadJobState);
        require!(
            ctx.accounts.requester.key() == job.requester,
            ErrorCode::NotRequester
        );
        let bond = dispute_bond(job.budget);
        let cpi = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.requester.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi, bond)?;
        job.dispute_bond = bond;
        job.dispute_slot = Clock::get()?.slot;
        job.state = JobState::Disputed as u8;
        Ok(())
    }

    /// Requester withdraws their own dispute: bond returns, job goes back to
    /// Submitted where confirm/finalize apply.
    pub fn cancel_dispute(ctx: Context<CancelDispute>) -> Result<()> {
        let job = &mut ctx.accounts.job;
        require!(
            job.state == JobState::Disputed as u8,
            ErrorCode::BadJobState
        );
        require!(
            ctx.accounts.requester.key() == job.requester,
            ErrorCode::NotRequester
        );
        let bond = job.dispute_bond;
        job.dispute_bond = 0;
        job.state = JobState::Submitted as u8;
        if bond > 0 {
            move_lamports(
                &ctx.accounts.vault.to_account_info(),
                &ctx.accounts.requester.to_account_info(),
                bond,
            )?;
        }
        Ok(())
    }

    /// Named arbiter resolves a bonded dispute. Loser economics, enforced:
    /// provider wins -> payout + bond to provider, score up; requester wins
    /// -> budget + bond back, provider stake slashed to requester, score down.
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        provider_wins: bool,
    ) -> Result<()> {
        let job = &mut ctx.accounts.job;
        require!(
            job.state == JobState::Disputed as u8,
            ErrorCode::BadJobState
        );
        let fee_bps = ctx.accounts.marketplace.fee_bps;
        if provider_wins {
            // Bond moves vault -> provider BEFORE pay_out: pay_out leaves
            // only budget-sized funds in the vault, and the `close`
            // constraint sweeps the remainder (rent) to the requester.
            let bond = job.dispute_bond;
            job.dispute_bond = 0;
            if bond > 0 {
                move_lamports(
                    &ctx.accounts.vault.to_account_info(),
                    &ctx.accounts.provider_recipient.to_account_info(),
                    bond,
                )?;
            }
            let provider = &mut ctx.accounts.provider;
            crate::pay_out(
                job,
                provider,
                &ctx.accounts.vault,
                &ctx.accounts.provider_recipient.to_account_info(),
                &ctx.accounts.treasury.to_account_info(),
                fee_bps,
                JobState::Confirmed,
            )?;
        } else {
            let refund = job.budget.saturating_add(job.dispute_bond);
            job.dispute_bond = 0;
            require!(
                ctx.accounts.vault.to_account_info().lamports() >= refund,
                ErrorCode::InsufficientVault
            );
            move_lamports(
                &ctx.accounts.vault.to_account_info(),
                &ctx.accounts.requester.to_account_info(),
                refund,
            )?;
            let provider = &mut ctx.accounts.provider;
            let slash = slash_amount(provider.stake).min(provider.stake);
            if slash > 0 {
                move_lamports(
                    &provider.to_account_info(),
                    &ctx.accounts.requester.to_account_info(),
                    slash,
                )?;
                provider.stake = provider.stake.saturating_sub(slash);
            }
            provider.failed_jobs = provider.failed_jobs.saturating_add(1);
            let points = score_points(job.budget, false);
            provider.score_x100 = bump_score(provider.score_x100, false, points);
            job.state = JobState::Refunded as u8;
            // Rent returns via the `close = requester` constraints.
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- accounts

#[account]
pub struct Marketplace {
    pub admin: Pubkey,
    pub arbiter: Pubkey,
    pub fee_bps: u16,
    pub total_jobs: u64,
    pub total_providers: u64,
    pub bump: u8,
}

#[account]
pub struct Provider {
    pub owner: Pubkey,
    pub marketplace: Pubkey,
    pub endpoint_hash: [u8; 32],
    pub stake: u64,
    pub completed_jobs: u64,
    pub failed_jobs: u64,
    /// Rolling reputation score, 0..=10000 (100x). Starts at 1000 (10.00).
    /// Deltas scale with job value (see score_points).
    pub score_x100: u16,
    pub active: bool,
    pub bump: u8,
}

/// Rent-holding vault PDA per job: seeds `[b"vault", job.key()]`.
/// Holds `budget` (+ dispute bond while disputed) on top of rent, and is
/// closed back to the requester on every terminal path — no rent leaks.
#[account]
pub struct Vault {}

#[account]
pub struct ModelListing {
    pub provider: Pubkey,
    pub model_id_hash: [u8; 32],
    pub price_per_1k_tokens_lamports: u64,
    pub max_tokens: u32,
    pub active: bool,
    pub bump: u8,
}

#[account]
pub struct Job {
    pub job_id: u64,
    pub marketplace: Pubkey,
    pub requester: Pubkey,
    pub provider: Pubkey,
    pub model_id_hash: [u8; 32],
    pub input_hash: [u8; 32],
    pub result_hash: [u8; 32],
    pub budget: u64,
    /// Self-reported token counts for per-token metering records.
    pub input_tokens: u32,
    pub output_tokens: u32,
    /// Bond posted by a disputing requester; goes to the winner.
    pub dispute_bond: u64,
    pub max_tokens: u32,
    pub state: u8,
    pub created_slot: u64,
    pub submitted_slot: u64,
    pub dispute_slot: u64,
    pub deadline_slot: u64,
    pub bump: u8,
}

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum JobState {
    Open = 0,
    Claimed = 1,
    Submitted = 2,
    Confirmed = 3,
    Refunded = 4,
    Disputed = 5,
    /// Paid out via permissionless finalize after the confirm window.
    Finalized = 6,
}

// ---------------------------------------------------------------- contexts

#[derive(Accounts)]
pub struct InitializeMarketplace<'info> {
    #[account(
        init, payer = admin, space = 8 + 32 + 32 + 2 + 8 + 8 + 1,
        seeds = [b"marketplace"], bump
    )]
    pub marketplace: Account<'info, Marketplace>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Admin-gated governance (admin/arbiter rotation, fee updates).
#[derive(Accounts)]
pub struct SetAdmin<'info> {
    #[account(mut, has_one = admin)]
    pub marketplace: Account<'info, Marketplace>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct RegisterProvider<'info> {
    #[account(mut)]
    pub marketplace: Account<'info, Marketplace>,
    #[account(
        init, payer = owner, space = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 2 + 1 + 1,
        seeds = [b"provider", marketplace.key().as_ref(), owner.key().as_ref()], bump
    )]
    pub provider: Account<'info, Provider>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut, has_one = owner)]
    pub provider: Account<'info, Provider>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(model_id_hash: [u8; 32])]
pub struct ListModel<'info> {
    pub provider: Account<'info, Provider>,
    #[account(
        init, payer = owner, space = 8 + 32 + 32 + 8 + 4 + 1 + 1,
        seeds = [b"listing", provider.key().as_ref(), model_id_hash.as_ref()], bump
    )]
    pub listing: Account<'info, ModelListing>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateJob<'info> {
    #[account(mut)]
    pub marketplace: Account<'info, Marketplace>,
    #[account(
        init, payer = requester, space = 8 + 8 + 32 + 32 + 32 + 32 + 32 + 32 + 8 + 4 + 4 + 8 + 8 + 4 + 1 + 8 + 8 + 8 + 8 + 1,
        seeds = [b"job", marketplace.key().as_ref(), &marketplace.total_jobs.saturating_add(1).to_le_bytes()], bump
    )]
    pub job: Account<'info, Job>,
    #[account(
        init, payer = requester, space = 8,
        seeds = [b"vault", job.key().as_ref()], bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub requester: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimJob<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    pub provider: Account<'info, Provider>,
    /// Re-derived from the job's own model hash: proves this provider
    /// serves this model, the listing is live, and the token cap fits.
    #[account(
        seeds = [b"listing", provider.key().as_ref(), job.model_id_hash.as_ref()], bump,
        constraint = listing.active @ ErrorCode::ProviderInactive,
    )]
    pub listing: Account<'info, ModelListing>,
    pub claimer: Signer<'info>,
}

#[derive(Accounts)]
pub struct SubmitResult<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    /// The provider PDA (cannot sign) — pins which identity this is for.
    #[account(address = job.provider)]
    pub provider: Account<'info, Provider>,
    /// The provider OWNER — the actual signer. PDAs can never sign.
    #[account(address = provider.owner)]
    pub submitter: Signer<'info>,
}

#[derive(Accounts)]
pub struct ConfirmResult<'info> {
    pub marketplace: Account<'info, Marketplace>,
    #[account(mut, close = requester)]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub provider: Account<'info, Provider>,
    #[account(mut)]
    pub requester: Signer<'info>,
    /// CHECK: constrained to the provider owner; receives the payout.
    #[account(mut, address = provider.owner)]
    pub provider_recipient: AccountInfo<'info>,
    /// CHECK: constrained to the marketplace admin; receives the fee.
    #[account(mut, address = marketplace.admin)]
    pub treasury: AccountInfo<'info>,
    #[account(mut, seeds = [b"vault", job.key().as_ref()], bump, close = requester)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct FinalizeJob<'info> {
    pub marketplace: Account<'info, Marketplace>,
    #[account(mut, close = requester)]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub provider: Account<'info, Provider>,
    /// CHECK: constrained to the original requester; receives rent back.
    #[account(mut, address = job.requester)]
    pub requester: AccountInfo<'info>,
    /// CHECK: constrained to the provider owner; receives the payout.
    #[account(mut, address = provider.owner)]
    pub provider_recipient: AccountInfo<'info>,
    /// CHECK: constrained to the marketplace admin; receives the fee.
    #[account(mut, address = marketplace.admin)]
    pub treasury: AccountInfo<'info>,
    #[account(mut, seeds = [b"vault", job.key().as_ref()], bump, close = requester)]
    pub vault: Account<'info, Vault>,
    /// Pays only the transaction fee. Anyone may finalize.
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct TimeoutRefund<'info> {
    #[account(mut, close = requester)]
    pub job: Account<'info, Job>,
    /// Optional so never-claimed jobs can still refund.
    #[account(mut)]
    pub provider: Option<Account<'info, Provider>>,
    /// CHECK: constrained to the original requester; receives refund + rent.
    #[account(mut, address = job.requester)]
    pub requester: AccountInfo<'info>,
    #[account(mut, seeds = [b"vault", job.key().as_ref()], bump, close = requester)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    #[account(mut, seeds = [b"vault", job.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub requester: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelDispute<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    #[account(mut, seeds = [b"vault", job.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub requester: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    pub marketplace: Account<'info, Marketplace>,
    /// The named arbiter — the only signer that can resolve.
    #[account(address = marketplace.arbiter)]
    pub arbiter: Signer<'info>,
    #[account(mut, close = requester)]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub provider: Account<'info, Provider>,
    /// CHECK: constrained to the original requester; receives rent back.
    #[account(mut, address = job.requester)]
    pub requester: AccountInfo<'info>,
    /// CHECK: constrained to the provider owner; receives payout/bond on win.
    #[account(mut, address = provider.owner)]
    pub provider_recipient: AccountInfo<'info>,
    /// CHECK: constrained to the marketplace admin; receives the fee on win.
    #[account(mut, address = marketplace.admin)]
    pub treasury: AccountInfo<'info>,
    #[account(mut, seeds = [b"vault", job.key().as_ref()], bump, close = requester)]
    pub vault: Account<'info, Vault>,
}

// ---------------------------------------------------------------- helpers

/// Move lamports between program-controlled accounts without a CPI.
/// Caller must have validated both endpoints and sufficiency first.
fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    let mut from_lamports = from.try_borrow_mut_lamports()?;
    let mut to_lamports = to.try_borrow_mut_lamports()?;
    **from_lamports = from_lamports
        .checked_sub(amount)
        .ok_or(ErrorCode::InsufficientVault)?;
    **to_lamports = to_lamports
        .checked_add(amount)
        .ok_or(ErrorCode::InsufficientVault)?;
    Ok(())
}

/// Shared payout path: vault -> provider + treasury, weighted score bump.
/// Rent returns to the requester via the `close` constraints on the calling
/// context — this function never closes accounts itself.
pub fn pay_out(
    job: &mut Account<Job>,
    provider: &mut Account<Provider>,
    vault: &Account<Vault>,
    provider_recipient: &AccountInfo,
    treasury: &AccountInfo,
    fee_bps: u16,
    terminal: JobState,
) -> Result<()> {
    let (payout, fee) = settle_amounts(job.budget, fee_bps);
    require!(
        vault.to_account_info().lamports() >= job.budget,
        ErrorCode::InsufficientVault
    );
    let points = score_points(job.budget, true);
    move_lamports(&vault.to_account_info(), provider_recipient, payout)?;
    move_lamports(&vault.to_account_info(), treasury, fee)?;
    job.state = terminal as u8;
    provider.completed_jobs = provider.completed_jobs.saturating_add(1);
    provider.score_x100 = bump_score(provider.score_x100, true, points);
    Ok(())
}

/// Close a program-owned account, returning its rent to `dest`.
fn close_account(account: &AccountInfo, dest: &AccountInfo) -> Result<()> {
    let dest_start = dest.lamports();
    let account_lamports = account.lamports();
    **dest.try_borrow_mut_lamports()? = dest_start
        .checked_add(account_lamports)
        .ok_or(ErrorCode::InsufficientVault)?;
    **account.try_borrow_mut_lamports()? = 0;
    let mut data = account.try_borrow_mut_data()?;
    data.fill(0);
    Ok(())
}

// ---------------------------------------------------------------- pure logic

/// Split a job budget into (provider_payout, protocol_fee).
pub fn settle_amounts(budget: u64, fee_bps: u16) -> (u64, u64) {
    let fee = ((budget as u128) * (fee_bps as u128) / 10_000u128) as u64;
    (budget.saturating_sub(fee), fee)
}

/// Dispute bond: 10% of budget floored so spam is never free.
pub fn dispute_bond(budget: u64) -> u64 {
    (budget / 10).max(MIN_DISPUTE_BOND)
}

/// Stake slashed on timeouts and lost disputes: 5%.
pub fn slash_amount(stake: u64) -> u64 {
    stake / 20
}

/// Value-weighted reputation points: ~1pt per 5k lamports at stake,
/// clamped so micro-jobs cannot farm score and whales cannot one-shot it.
/// Failure stings ~4x more than success pays.
pub fn score_points(budget: u64, success: bool) -> u16 {
    if success {
        (budget / 5_000).clamp(5, 100) as u16
    } else {
        (budget / 2_500).clamp(25, 400) as u16
    }
}

/// Nudge a 0..=10000 reputation score up/down with saturation.
pub fn bump_score(score_x100: u16, success: bool, points: u16) -> u16 {
    if success {
        score_x100.saturating_add(points).min(10_000)
    } else {
        score_x100.saturating_sub(points)
    }
}

#[error_code]
pub enum ErrorCode {
    #[msg("Protocol fee too high (max 1000 bps).")]
    FeeTooHigh,
    #[msg("Invalid model parameters.")]
    BadModelParams,
    #[msg("Invalid job parameters.")]
    BadJobParams,
    #[msg("Job is not in the expected state.")]
    BadJobState,
    #[msg("Job deadline has passed.")]
    JobExpired,
    #[msg("Job deadline has not passed yet.")]
    NotExpired,
    #[msg("Confirm window has passed; use finalize instead.")]
    ConfirmWindowPassed,
    #[msg("Provider is not active.")]
    ProviderInactive,
    #[msg("Only the assigned provider can do this.")]
    NotJobProvider,
    #[msg("Only the requester can do this.")]
    NotRequester,
    #[msg("Only the arbiter can do this.")]
    NotArbiter,
    #[msg("Provider and job are on different marketplaces.")]
    MarketplaceMismatch,
    #[msg("Vault holds less than required.")]
    InsufficientVault,
    #[msg("Only the provider owner can do this.")]
    NotProviderOwner,
    #[msg("Provider has no stake to withdraw.")]
    NoStake,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_math_splits_budget() {
        let (payout, fee) = settle_amounts(1_000_000, 250);
        assert_eq!(fee, 25_000);
        assert_eq!(payout, 975_000);
    }

    #[test]
    fn fee_zero_and_full_range() {
        assert_eq!(settle_amounts(500, 0), (500, 0));
        assert_eq!(settle_amounts(10_000, 1_000), (9_000, 1_000));
    }

    #[test]
    fn score_is_value_weighted_and_saturates() {
        // micro job: floor applies
        assert_eq!(score_points(1_000, true), 5);
        assert_eq!(score_points(1_000, false), 25);
        // mid job: proportional
        assert_eq!(score_points(250_000, true), 50);
        assert_eq!(score_points(250_000, false), 100);
        // whale: capped
        assert_eq!(score_points(1_000_000_000_000, true), 100);
        assert_eq!(score_points(1_000_000_000_000, false), 400);
        // saturation both ends
        assert_eq!(bump_score(9_990, true, 100), 10_000);
        assert_eq!(bump_score(100, false, 400), 0);
    }

    #[test]
    fn dispute_bond_and_slash_math() {
        assert_eq!(dispute_bond(1_000_000), 100_000);
        assert_eq!(dispute_bond(100_000), MIN_DISPUTE_BOND); // floor, not 10k
        assert_eq!(slash_amount(500_000), 25_000); // 5%
        assert_eq!(slash_amount(19), 0); // dust: no slash, score still hit
    }

    #[test]
    fn job_state_discriminants_stable_for_clients() {
        assert_eq!(JobState::Open as u8, 0);
        assert_eq!(JobState::Claimed as u8, 1);
        assert_eq!(JobState::Submitted as u8, 2);
        assert_eq!(JobState::Confirmed as u8, 3);
        assert_eq!(JobState::Refunded as u8, 4);
        assert_eq!(JobState::Disputed as u8, 5);
        assert_eq!(JobState::Finalized as u8, 6);
    }
}
