#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
};
use anchor_spl::associated_token::AssociatedToken;

#[derive(Accounts)]
pub struct CreateUserAccount<'info> {
    #[account(
        init,
        payer = signer,
        associated_token::mint = mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program,
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn handler(ctx: Context<CreateUserAccount>) -> Result<()> {
    msg!("Token account created: {}", ctx.accounts.token_account.key());
    Ok(())
}