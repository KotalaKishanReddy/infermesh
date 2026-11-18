use anchor_lang::prelude::*;

declare_id!("FMesh11111111111111111111111111111111111111");

/// InferMesh: open marketplace for AI inference on Solana.
/// Requesters escrow lamports per job into a vault PDA; providers stake
/// real lamports plus reputation, submit a result commitment (hash), and
/// get paid on confirmation. Timeouts refund the requester; disputes are
/// flag-based in v1 so a grant milestone can add a multisig arbiter later.
#[program]
pub mod infermesh {
    use super::*;

    pub fn initialize_marketplace(ctx: Context<InitializeMarketplace>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= 1_000, ErrorCode::FeeTooHigh);
        let m = &mut ctx.accounts.marketplace;
        m.admin = ctx.accounts.admin.key();
        m.fee_bps = fee_bps;
        m.total_jobs = 0;
        m.total_providers = 0;
        m.bump = ctx.bumps.marketplace;
        Ok(())
    }

    pub fn register_provider(
        ctx: Context<RegisterProvider>,
        endpoint_hash: [u8; 32],
        min_stake: u64,
    ) -> Result<()> {
        // Stake is collected for real: locked in the provider PDA until an
        // unstake instruction ships (grant milestone 2).
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
        job.state = JobState::Open as u8;
        job.created_slot = clock.slot;
        job.deadline_slot = clock.slot.saturating_add(deadline_slots.max(1));
        job.bump = ctx.bumps.job;
        let m = &mut ctx.accounts.marketplace;
        m.total_jobs = m.total_jobs.saturating_add(1);
        job.job_id = m.total_jobs;
        Ok(())
    }

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
        job.provider = ctx.accounts.provider.key();
        job.state = JobState::Claimed as u8;
        Ok(())
    }

    pub fn submit_result(ctx: Context<SubmitResult>, result_hash: [u8; 32]) -> Result<()> {
        let job = &mut ctx.accounts.job;
        require!(job.state == JobState::Claimed as u8, ErrorCode::BadJobState);
        require!(
            ctx.accounts.provider.key() == job.provider,
            ErrorCode::NotJobProvider
        );
        job.result_hash = result_hash;
        job.state = JobState::Submitted as u8;
        Ok(())
    }

    /// Requester confirms the result. Fee math is pure (see `settle_amounts`)
    /// so offchain clients and the frontend show identical numbers.
    /// Vault pays out provider + protocol fee atomically with confirmation.
    pub fn confirm_result(ctx: Context<ConfirmResult>) -> Result<()> {
        let job = &mut ctx.accounts.job;
        require!(job.state == JobState::Submitted as u8, ErrorCode::BadJobState);
        require!(
            ctx.accounts.requester.key() == job.requester,
            ErrorCode::NotRequester
        );
        let (payout, fee) = settle_amounts(job.budget, ctx.accounts.marketplace.fee_bps);
        require!(
            ctx.accounts.vault.to_account_info().lamports() >= job.budget,
            ErrorCode::InsufficientVault
        );
        move_lamports(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.provider_recipient.to_account_info(),
            payout,
        )?;
        move_lamports(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            fee,
        )?;
        job.state = JobState::Confirmed as u8;
        let provider = &mut ctx.accounts.provider;
        provider.completed_jobs = provider.completed_jobs.saturating_add(1);
        provider.score_x100 = bump_score(provider.score_x100, true);
        Ok(())
    }

    /// Anyone can finalize a refund once the deadline passes with no submission.
    /// Works for claimed AND unclaimed jobs: the provider account is optional
    /// so escrow from a never-claimed job can never get stuck.
    pub fn timeout_refund(ctx: Context<TimeoutRefund>) -> Result<()> {
        let clock = Clock::get()?;
        let job = &mut ctx.accounts.job;
        require!(
            job.state == JobState::Open as u8 || job.state == JobState::Claimed as u8,
            ErrorCode::BadJobState
        );
        require!(
            (clock.slot as i64) >= (job.deadline_slot as i64),
            ErrorCode::NotExpired
        );
        require!(
            ctx.accounts.vault.to_account_info().lamports() >= job.budget,
            ErrorCode::InsufficientVault
        );
        let budget = job.budget;
        move_lamports(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.requester.to_account_info(),
            budget,
        )?;
        job.state = JobState::Refunded as u8;
        if let Some(provider) = ctx.accounts.provider.as_mut() {
            require!(
                provider.key() == job.provider,
                ErrorCode::NotJobProvider
            );
            provider.failed_jobs = provider.failed_jobs.saturating_add(1);
            provider.score_x100 = bump_score(provider.score_x100, false);
        }
        Ok(())
    }

    /// Requester withdraws a dispute, returning the job to Submitted so it can
    /// be confirmed or re-examined. Disputes never freeze funds permanently.
    pub fn cancel_dispute(ctx: Context<FlagDispute>) -> Result<()> {
        let job = &mut ctx.accounts.job;
        require!(
            job.state == JobState::Disputed as u8,
            ErrorCode::BadJobState
        );
        require!(
            ctx.accounts.requester.key() == job.requester,
            ErrorCode::NotRequester
        );
        job.state = JobState::Submitted as u8;
        Ok(())
    }

    pub fn flag_dispute(ctx: Context<FlagDispute>) -> Result<()> {
        let job = &mut ctx.accounts.job;
        require!(
            job.state == JobState::Submitted as u8,
            ErrorCode::BadJobState
        );
        require!(
            ctx.accounts.requester.key() == job.requester,
            ErrorCode::NotRequester
        );
        job.state = JobState::Disputed as u8;
        Ok(())
    }
}

// ---------------------------------------------------------------- accounts

#[account]
pub struct Marketplace {
    pub admin: Pubkey,
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
    pub score_x100: u16,
    pub active: bool,
    pub bump: u8,
}

/// Rent-holding vault PDA per job: seeds `[b"vault", job.key()]`.
/// Holds exactly `budget` lamports of escrow on top of rent.
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
    pub max_tokens: u32,
    pub state: u8,
    pub created_slot: u64,
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
}

// ---------------------------------------------------------------- contexts

#[derive(Accounts)]
pub struct InitializeMarketplace<'info> {
    #[account(
        init, payer = admin, space = 8 + 32 + 2 + 8 + 8 + 1,
        seeds = [b"marketplace"], bump
    )]
    pub marketplace: Account<'info, Marketplace>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
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
        init, payer = requester, space = 8 + 8 + 32 + 32 + 32 + 32 + 32 + 32 + 8 + 4 + 1 + 8 + 8 + 1,
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
    pub claimer: Signer<'info>,
}

#[derive(Accounts)]
pub struct SubmitResult<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    pub provider: Signer<'info>,
}

#[derive(Accounts)]
pub struct ConfirmResult<'info> {
    pub marketplace: Account<'info, Marketplace>,
    #[account(mut)]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub provider: Account<'info, Provider>,
    pub requester: Signer<'info>,
    /// CHECK: constrained to the provider owner; receives the payout.
    #[account(mut, address = provider.owner)]
    pub provider_recipient: AccountInfo<'info>,
    /// CHECK: constrained to the marketplace admin; receives the fee.
    #[account(mut, address = marketplace.admin)]
    pub treasury: AccountInfo<'info>,
    #[account(mut, seeds = [b"vault", job.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct TimeoutRefund<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    /// Optional so never-claimed jobs can still refund.
    #[account(mut)]
    pub provider: Option<Account<'info, Provider>>,
    /// CHECK: constrained to the original requester; receives the refund.
    #[account(mut, address = job.requester)]
    pub requester: AccountInfo<'info>,
    #[account(mut, seeds = [b"vault", job.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct FlagDispute<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    pub requester: Signer<'info>,
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

// ---------------------------------------------------------------- pure logic

/// Split a job budget into (provider_payout, protocol_fee).
pub fn settle_amounts(budget: u64, fee_bps: u16) -> (u64, u64) {
    let fee = ((budget as u128) * (fee_bps as u128) / 10_000u128) as u64;
    (budget.saturating_sub(fee), fee)
}

/// Nudge a 0..=10000 reputation score up/down with saturation.
pub fn bump_score(score_x100: u16, success: bool) -> u16 {
    if success {
        score_x100.saturating_add(25).min(10_000)
    } else {
        score_x100.saturating_sub(150)
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
    #[msg("Provider is not active.")]
    ProviderInactive,
    #[msg("Only the assigned provider can do this.")]
    NotJobProvider,
    #[msg("Only the requester can do this.")]
    NotRequester,
    #[msg("Vault holds less than the job budget.")]
    InsufficientVault,
    #[msg("Only the provider owner can do this.")]
    NotProviderOwner,
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
    fn score_moves_and_saturates() {
        assert_eq!(bump_score(1_000, true), 1_025);
        assert_eq!(bump_score(100, false), 0);
        assert_eq!(bump_score(9_990, true), 10_000);
    }

    #[test]
    fn job_state_discriminants_stable_for_clients() {
        assert_eq!(JobState::Open as u8, 0);
        assert_eq!(JobState::Claimed as u8, 1);
        assert_eq!(JobState::Submitted as u8, 2);
        assert_eq!(JobState::Confirmed as u8, 3);
        assert_eq!(JobState::Refunded as u8, 4);
        assert_eq!(JobState::Disputed as u8, 5);
    }
}
