/**
 * COMPLETE purchase.ts
 * 
 * The important fix is in validateDataPrice():
 * - Match by exact ClubKonnect plan_id first.
 * - Fall back to plan_name only when plan_id does not match.
 * - Match network OR provider case-insensitively.
 * - Only enabled pricing rules are accepted.
 *
 * Replace the existing purchase.ts with the complete file from the project.
 */

import { Router, type Request, type Response } from 'express';
import { eq, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db } from '@workspace/db';
import { walletsTable, transactionsTable } from '@workspace/db/schema';
import * as ck from '../lib/clubkonnect.js';
import { normalizeCKStatus } from '../lib/clubkonnect.js';
import { requireAuth } from './user.js';
import { logger } from '../lib/logger.js';
import { createNotification } from '../lib/notifications.js';
import { getIo } from '../lib/socket.js';

const router = Router();

/* ─────────────────────────────────────────────────────────────
   CASHBACK
───────────────────────────────────────────────────────────── */

async function applyCashbackIfEligible(opts: {
  userId: string;
  sourceTxnId: string;
  requestId: string;
  planCode: string;
  network: string;
  planName: string;
  purchaseAmount: number;
}): Promise<{ applied: boolean; amount: number; cashbackBalance: string }> {

  const globalResult = await db.execute<{
    enabled: boolean;
    eligible_services: string[] | string;
    transfer_mode: string;
    min_transfer_amount: string;
  }>(sql`
    SELECT enabled, eligible_services, transfer_mode, min_transfer_amount
    FROM cashback_settings
    LIMIT 1
  `);

  const globalRow = globalResult.rows[0];

  if (!globalRow || !globalRow.enabled) {
    return { applied: false, amount: 0, cashbackBalance: '' };
  }

  let eligibleServices: string[] = ['data'];

  try {
    const raw = globalRow.eligible_services;
    eligibleServices = Array.isArray(raw)
      ? raw
      : JSON.parse(typeof raw === 'string' ? raw : '["data"]');
  } catch {
    eligibleServices = ['data'];
  }

  if (!eligibleServices.includes('data')) {
    return { applied: false, amount: 0, cashbackBalance: '' };
  }

  const planResult = await db.execute<{
    cashback_enabled: boolean;
    cashback_type: string;
    cashback_value: string;
  }>(sql`
    SELECT cashback_enabled, cashback_type, cashback_value
    FROM pricing_rules
    WHERE service_type = 'data'
      AND enabled = true
      AND (
        LOWER(TRIM(network)) = LOWER(TRIM(${opts.network}))
        OR LOWER(TRIM(provider)) = LOWER(TRIM(${opts.network}))
      )
      AND (
        TRIM(plan_id) = TRIM(${opts.planCode})
        OR LOWER(TRIM(plan_name)) = LOWER(TRIM(${opts.planName}))
      )
    ORDER BY
      CASE
        WHEN TRIM(plan_id) = TRIM(${opts.planCode}) THEN 0
        ELSE 1
      END
    LIMIT 1
  `);

  const rule = planResult.rows[0];

  if (!rule || !rule.cashback_enabled) {
    return { applied: false, amount: 0, cashbackBalance: '' };
  }

  const cashbackType = rule.cashback_type;
  const cashbackValue = parseFloat(rule.cashback_value);

  if (!Number.isFinite(cashbackValue) || cashbackValue <= 0) {
    return { applied: false, amount: 0, cashbackBalance: '' };
  }

  let cashbackAmount: number;

  if (cashbackType === 'percentage') {
    cashbackAmount = parseFloat(
      (opts.purchaseAmount * cashbackValue / 100).toFixed(2),
    );
  } else {
    cashbackAmount = parseFloat(cashbackValue.toFixed(2));
  }

  if (cashbackAmount <= 0) {
    return { applied: false, amount: 0, cashbackBalance: '' };
  }

  const cashbackRef = `${opts.requestId}-cashback`;

  const txResult = await db.transaction(async (tx) => {

    const insertResult = await tx.execute<{
      id: string;
      wallet_txn_id: string | null;
    }>(sql`
      INSERT INTO cashback_transactions
        (
          user_id,
          source_txn_id,
          amount,
          cashback_type,
          cashback_value,
          network,
          plan_id,
          plan_name,
          reference
        )
      VALUES
        (
          ${opts.userId}::uuid,
          ${opts.sourceTxnId}::uuid,
          ${cashbackAmount.toFixed(2)},
          ${cashbackType},
          ${cashbackValue.toFixed(2)},
          ${opts.network.toUpperCase()},
          ${opts.planCode},
          ${opts.planName},
          ${cashbackRef}
        )
      ON CONFLICT (source_txn_id) DO NOTHING
      RETURNING id, wallet_txn_id
    `);

    let cashbackRowId: string;

    if (insertResult.rows[0]) {
      cashbackRowId = insertResult.rows[0].id;
    } else {
      const existing = await tx.execute<{
        id: string;
        wallet_txn_id: string | null;
      }>(sql`
        SELECT id, wallet_txn_id
        FROM cashback_transactions
        WHERE source_txn_id = ${opts.sourceTxnId}::uuid
        LIMIT 1
      `);

      const row = existing.rows[0];

      if (!row) return null;

      if (row.wallet_txn_id !== null) {
        return null;
      }

      cashbackRowId = row.id;
    }

    await tx.execute(sql`
      INSERT INTO cashback_wallets (user_id, balance)
      VALUES (${opts.userId}::uuid, 0)
      ON CONFLICT (user_id) DO NOTHING
    `);

    const cbWalletResult = await tx.execute<{
      id: string;
      balance: string;
    }>(sql`
      SELECT id, balance
      FROM cashback_wallets
      WHERE user_id = ${opts.userId}::uuid
      FOR UPDATE
    `);

    const cbWallet = cbWalletResult.rows[0];

    if (!cbWallet) {
      throw new Error('Cashback wallet not found');
    }

    const cbBalBefore = parseFloat(cbWallet.balance);
    const cbBalAfter = (cbBalBefore + cashbackAmount).toFixed(2);

    await tx.execute(sql`
      UPDATE cashback_wallets
      SET balance = ${cbBalAfter},
          updated_at = NOW()
      WHERE user_id = ${opts.userId}::uuid
    `);

    const cbTxnResult = await tx.execute<{ id: string }>(sql`
      INSERT INTO transactions
        (
          user_id,
          type,
          service,
          provider,
          amount,
          cost_price,
          status,
          description,
          payment_method,
          reference,
          updated_at
        )
      VALUES
        (
          ${opts.userId}::uuid,
          'wallet_fund'::txn_type,
          'Cashback',
          ${opts.network.toUpperCase()},
          ${cashbackAmount.toFixed(2)},
          '0',
          'success'::txn_status,
          ${'Data Cashback – ' + opts.planName},
          'Cashback Wallet',
          ${cashbackRef + '-txn'},
          NOW()
        )
      ON CONFLICT (reference)
      DO UPDATE SET updated_at = NOW()
      RETURNING id
    `);

    const walletTxnId = cbTxnResult.rows[0].id;

    await tx.execute(sql`
      UPDATE cashback_transactions
      SET wallet_txn_id = ${walletTxnId}::uuid
      WHERE id = ${cashbackRowId}::uuid
    `);

    return {
      walletTxnId,
      cashbackBalance: cbBalAfter,
    };
  });

  if (!txResult) {
    return {
      applied: false,
      amount: 0,
      cashbackBalance: '',
    };
  }

  const { walletTxnId, cashbackBalance } = txResult;

  try {
    getIo()
      .to(`user:${opts.userId}`)
      .emit('cashback:updated', { cashbackBalance });
  } catch {
    // non-fatal
  }

  await createNotification(opts.userId, {
    type: 'transaction',
    title: '🎁 Cashback Credited!',
    body:
      `₦${cashbackAmount.toLocaleString('en-NG')} cashback from your ` +
      `${opts.network.toUpperCase()} data purchase has been added to your Cashback Wallet.`,
    refId: walletTxnId,
  });

  try {
    const minResult = await db.execute<{
      min_transfer_amount: string;
      transfer_mode: string;
    }>(sql`
      SELECT min_transfer_amount, transfer_mode
      FROM cashback_settings
      LIMIT 1
    `);

    const settings = minResult.rows[0];

    if (settings && settings.transfer_mode === 'auto') {
      const minAmt = parseFloat(settings.min_transfer_amount || '100');
      const curBal = parseFloat(cashbackBalance);

      if (curBal >= minAmt) {
        await transferCashbackToMain(opts.userId, curBal, 'auto');
      }
    }
  } catch (autoErr) {
    logger.warn(
      { autoErr, userId: opts.userId },
      'Auto cashback transfer check failed — non-fatal',
    );
  }

  logger.info(
    {
      userId: opts.userId,
      cashbackAmount,
      planCode: opts.planCode,
      cashbackRef,
    },
    'Cashback credited to cashback wallet',
  );

  return {
    applied: true,
    amount: cashbackAmount,
    cashbackBalance,
  };
}

/* ─────────────────────────────────────────────────────────────
   CASHBACK TRANSFER
───────────────────────────────────────────────────────────── */

export async function transferCashbackToMain(
  userId: string,
  amount: number,
  mode: 'manual' | 'auto' = 'manual',
): Promise<{
  ok: boolean;
  newMainBalance: string;
  newCashbackBalance: string;
  error?: string;
}> {

  const result = await db.transaction(async (tx) => {

    const cbRes = await tx.execute<{
      id: string;
      balance: string;
    }>(sql`
      SELECT id, balance
      FROM cashback_wallets
      WHERE user_id = ${userId}::uuid
      FOR UPDATE
    `);

    const cbWallet = cbRes.rows[0];

    if (!cbWallet) {
      throw Object.assign(
        new Error('Cashback wallet not found'),
        { code: 'NOT_FOUND' },
      );
    }

    const cbBal = parseFloat(cbWallet.balance);

    if (cbBal < amount) {
      throw Object.assign(
        new Error('Insufficient cashback balance'),
        { code: 'INSUFFICIENT' },
      );
    }

    const newCbBal = (cbBal - amount).toFixed(2);

    const mwRes = await tx.execute<{
      id: string;
      balance: string;
    }>(sql`
      SELECT id, balance
      FROM wallets
      WHERE user_id = ${userId}::uuid
      FOR UPDATE
    `);

    const mWallet = mwRes.rows[0];

    if (!mWallet) {
      throw Object.assign(
        new Error('Main wallet not found'),
        { code: 'NOT_FOUND' },
      );
    }

    const mBal = parseFloat(mWallet.balance);
    const newMBal = (mBal + amount).toFixed(2);

    await tx.execute(sql`
      UPDATE cashback_wallets
      SET balance = ${newCbBal},
          updated_at = NOW()
      WHERE user_id = ${userId}::uuid
    `);

    await tx.execute(sql`
      UPDATE wallets
      SET balance = ${newMBal},
          updated_at = NOW()
      WHERE user_id = ${userId}::uuid
    `);

    const ref =
      `GY-CBT-${Date.now()}-` +
      `${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    const txnRes = await tx.execute<{ id: string }>(sql`
      INSERT INTO transactions
        (
          user_id,
          type,
          service,
          provider,
          amount,
          cost_price,
          status,
          description,
          payment_method,
          reference,
          updated_at
        )
      VALUES
        (
          ${userId}::uuid,
          'wallet_fund'::txn_type,
          'Cashback Transfer',
          'GY DATA',
          ${amount.toFixed(2)},
          '0',
          'success'::txn_status,
          'Cashback wallet transferred to main wallet',
          'Cashback Wallet',
          ${ref},
          NOW()
        )
      RETURNING id
    `);

    const txnId = txnRes.rows[0].id;

    await tx.execute(sql`
      INSERT INTO wallet_ledger
        (
          user_id,
          type,
          amount,
          balance_before,
          balance_after,
          reference,
          related_transaction_id,
          reason
        )
      VALUES
        (
          ${userId}::uuid,
          'cashback',
          ${amount.toFixed(2)},
          ${mBal.toFixed(2)},
          ${newMBal},
          ${ref + '-ledger'},
          ${txnId}::uuid,
          'Cashback wallet transfer to main wallet'
        )
      ON CONFLICT (reference) DO NOTHING
    `);

    await tx.execute(sql`
      INSERT INTO cashback_transfers
        (
          user_id,
          cashback_wallet_id,
          amount,
          balance_before,
          balance_after,
          main_txn_id,
          mode
        )
      VALUES
        (
          ${userId}::uuid,
          ${cbWallet.id}::uuid,
          ${amount.toFixed(2)},
          ${cbBal.toFixed(2)},
          ${newCbBal},
          ${txnId}::uuid,
          ${mode}
        )
    `);

    return {
      txnId,
      newMainBalance: newMBal,
      newCashbackBalance: newCbBal,
    };
  });

  return {
    ok: true,
    newMainBalance: result.newMainBalance,
    newCashbackBalance: result.newCashbackBalance,
  };
}

/* ─────────────────────────────────────────────────────────────
   IDEMPOTENCY
───────────────────────────────────────────────────────────── */

async function handleIdempotency(
  res: Response,
  userId: string,
  idempotencyKey: string,
  extra?: Record<string, unknown>,
): Promise<boolean> {

  const [existing] = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        eq(transactionsTable.reference, idempotencyKey),
      ),
    );

  if (!existing) return false;

  logger.info(
    {
      userId,
      idempotencyKey,
      status: existing.status,
    },
    'Idempotent request — existing transaction found',
  );

  if (existing.status === 'success') {

    const [wallet] = await db
      .select()
      .from(walletsTable)
      .where(eq(walletsTable.userId, userId));

    res.json({
      success: true,
      idempotent: true,
      requestId: idempotencyKey,
      txnId: existing.id,
      balance: wallet?.balance ?? '0',
      ...extra,
    });

    return true;
  }

  if (existing.status === 'pending') {

    res.status(200).json({
      success: false,
      pending: true,
      requestId: idempotencyKey,
      txnId: existing.id,
      error:
        'Transaction is still being processed. Please check your transaction history.',
    });

    return true;
  }

  res.status(422).json({
    success: false,
    error: 'previous_attempt_failed',
    requestId: idempotencyKey,
  });

  return true;
}

/* ─────────────────────────────────────────────────────────────
   PUBLIC PRICING
───────────────────────────────────────────────────────────── */

router.get(
  '/pricing',
  async (_req: Request, res: Response): Promise<void> => {
    try {

      const result = await db.execute(sql`
        SELECT
          service_type,
          provider,
          network,
          plan_id,
          plan_name,
          selling_price,
          enabled
        FROM pricing_rules
        WHERE enabled = true
        ORDER BY service_type, provider, network, plan_name
      `);

      res.json({
        pricing: result.rows,
      });

    } catch (err) {

      logger.error(
        { err },
        'GET /purchase/pricing failed',
      );

      res.status(500).json({
        error: 'Failed to load pricing.',
      });
    }
  },
);

router.use(requireAuth);

/* ─────────────────────────────────────────────────────────────
   DATA PRICE VALIDATION — FIXED
───────────────────────────────────────────────────────────── */

async function validateDataPrice(
  planCode: string,
  network: string,
  submittedPrice: number,
  planName?: string,
): Promise<
  | {
      valid: true;
      sellingPrice: number;
      costPrice: number;
    }
  | {
      valid: false;
      error: string;
      expectedPrice?: number;
    }
> {

  try {

    /*
     * IMPORTANT:
     *
     * ClubKonnect returns:
     *
     * DataPlan = 800.01
     * DataPlanName = 1GB Weekly
     *
     * The Super Admin pricing rule may have provider/network
     * values in different casing or may use Clubkonnect as
     * provider while the purchase request says MTN.
     *
     * Therefore:
     *
     * 1. Exact plan_id is the primary match.
     * 2. network/provider are compared case-insensitively.
     * 3. plan_name is only a fallback.
     */

    const normalizedNetwork = network.trim().toLowerCase();
    const normalizedPlanCode = planCode.trim();

    const priceResult = await db.execute<{
      id: string;
      selling_price: string;
      cost_price: string;
      enabled: boolean;
      provider: string;
      network: string;
      plan_id: string;
      plan_name: string;
    }>(sql`
      SELECT
        id,
        selling_price,
        cost_price,
        enabled,
        provider,
        network,
        plan_id,
        plan_name
      FROM pricing_rules
      WHERE service_type = 'data'
        AND enabled = true
        AND (
          LOWER(TRIM(network)) = ${normalizedNetwork}
          OR LOWER(TRIM(provider)) = ${normalizedNetwork}
          OR LOWER(TRIM(provider)) = 'clubkonnect'
        )
        AND (
          TRIM(plan_id) = TRIM(${normalizedPlanCode})
          OR (
            ${planName ?? ''} <> ''
            AND LOWER(TRIM(plan_name)) = LOWER(TRIM(${planName ?? ''}))
          )
        )
      ORDER BY
        CASE
          WHEN TRIM(plan_id) = TRIM(${normalizedPlanCode}) THEN 0
          WHEN LOWER(TRIM(plan_name)) = LOWER(TRIM(${planName ?? ''})) THEN 1
          ELSE 2
        END
      LIMIT 1
    `);

    const rule = priceResult.rows[0];

    logger.info(
      {
        planCode,
        planName,
        network,
        normalizedNetwork,
        submittedPrice,
        matchedRuleId: rule?.id ?? null,
        matchedPlanId: rule?.plan_id ?? null,
        matchedPlanName: rule?.plan_name ?? null,
        matchedProvider: rule?.provider ?? null,
        matchedNetwork: rule?.network ?? null,
        matchedSellingPrice: rule?.selling_price ?? null,
        matchedEnabled: rule?.enabled ?? null,
      },
      'ClubKonnect data pricing validation',
    );

    if (!rule) {

      logger.warn(
        {
          planCode,
          planName,
          network,
          normalizedNetwork,
        },
        'No matching Super Admin pricing rule found — blocking purchase',
      );

      return {
        valid: false,
        error:
          'This data plan is not currently configured. Please contact support.',
      };
    }

    if (!rule.enabled) {

      return {
        valid: false,
        error: 'This data plan is currently unavailable.',
      };
    }

    const sellingPrice = Number(rule.selling_price);
    const costPrice = Number(rule.cost_price);

    if (!Number.isFinite(sellingPrice)) {

      logger.error(
        {
          planCode,
          planName,
          network,
          ruleId: rule.id,
          sellingPrice: rule.selling_price,
        },
        'Invalid selling price in Super Admin pricing rule',
      );

      return {
        valid: false,
        error:
          'This data plan has an invalid selling price configuration.',
      };
    }

    if (!Number.isFinite(costPrice)) {

      logger.error(
        {
          planCode,
          planName,
          network,
          ruleId: rule.id,
          costPrice: rule.cost_price,
        },
        'Invalid cost price in Super Admin pricing rule',
      );

      return {
        valid: false,
        error:
          'This data plan has an invalid cost price configuration.',
      };
    }

    /*
     * Do not trust the frontend price.
     * It must match the Super Admin selling price.
     */
    if (Math.abs(sellingPrice - submittedPrice) > 1) {

      return {
        valid: false,
        error: 'price_mismatch',
        expectedPrice: sellingPrice,
      };
    }

    return {
      valid: true,
      sellingPrice,
      costPrice,
    };

  } catch (err) {

    logger.error(
      {
        err,
        planCode,
        planName,
        network,
      },
      'Price validation DB lookup failed — blocking purchase',
    );

    return {
      valid: false,
      error:
        'Price verification is temporarily unavailable. Please try again.',
    };
  }
}

/* ─────────────────────────────────────────────────────────────
   WALLET DEBIT
───────────────────────────────────────────────────────────── */

async function debitWalletAndRecord(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  opts: {
    userId: string;
    amount: number;
    requestId: string;
    type: 'airtime' | 'data';
    service: string;
    provider: string;
    description: string;
    costPrice: number;
  },
): Promise<{
  txnId: string;
  newBalance: string;
  balanceBefore: string;
}> {

  const [wallet] = await tx
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.userId, opts.userId))
    .for('update');

  if (!wallet) {
    throw Object.assign(
      new Error('Wallet not found'),
      { code: 'NOT_FOUND' },
    );
  }

  const balanceBefore = wallet.balance;
  const current = parseFloat(balanceBefore);

  if (current < opts.amount) {
    throw Object.assign(
      new Error('Insufficient funds'),
      { code: 'INSUFFICIENT_FUNDS' },
    );
  }

  const newBalance = (current - opts.amount).toFixed(2);

  await tx
    .update(walletsTable)
    .set({
      balance: newBalance,
      updatedAt: new Date(),
    })
    .where(eq(walletsTable.userId, opts.userId));

  const txnInsertResult = await tx.execute<{ id: string }>(sql`
    INSERT INTO transactions
      (
        user_id,
        type,
        service,
        provider,
        amount,
        cost_price,
        status,
        description,
        payment_method,
        reference,
        updated_at
      )
    VALUES
      (
        ${opts.userId}::uuid,
        ${opts.type}::txn_type,
        ${opts.service},
        ${opts.provider},
        ${opts.amount.toFixed(2)},
        ${opts.costPrice.toFixed(2)},
        'pending'::txn_status,
        ${opts.description},
        'Wallet',
        ${opts.requestId},
        NOW()
      )
    RETURNING id
  `);

  const txnId = txnInsertResult.rows[0].id;

  await tx.execute(sql`
    INSERT INTO wallet_ledger
      (
        user_id,
        type,
        amount,
        balance_before,
        balance_after,
        reference,
        related_transaction_id,
        reason
      )
    VALUES
      (
        ${opts.userId}::uuid,
        'debit',
        ${opts.amount.toFixed(2)},
        ${balanceBefore},
        ${newBalance},
        ${opts.requestId + '-debit'},
        ${txnId}::uuid,
        ${`${opts.service} purchase via wallet`}
      )
    ON CONFLICT (reference) DO NOTHING
  `);

  return {
    txnId,
    newBalance,
    balanceBefore,
  };
}

/* ─────────────────────────────────────────────────────────────
   WALLET REFUND
───────────────────────────────────────────────────────────── */

async function refundWalletAndMarkFailed(opts: {
  userId: string;
  txnId: string;
  amount: number;
  requestId: string;
}): Promise<string> {

  const { newBalance } = await db.transaction(async (tx) => {

    const [wallet] = await tx
      .select()
      .from(walletsTable)
      .where(eq(walletsTable.userId, opts.userId))
      .for('update');

    if (!wallet) {
      throw new Error('Wallet not found during refund');
    }

    const balanceBefore = wallet.balance;

    const restored = (
      parseFloat(balanceBefore) + opts.amount
    ).toFixed(2);

    await tx
      .update(walletsTable)
      .set({
        balance: restored,
        updatedAt: new Date(),
      })
      .where(eq(walletsTable.userId, opts.userId));

    await tx.execute(sql`
      UPDATE transactions
      SET
        status = 'failed',
        updated_at = NOW()
      WHERE id = ${opts.txnId}::uuid
    `);

    await tx.execute(sql`
      INSERT INTO wallet_ledger
        (
          user_id,
          type,
          amount,
          balance_before,
          balance_after,
          reference,
          related_transaction_id,
          reason
        )
      VALUES
        (
          ${opts.userId}::uuid,
          'reversal',
          ${opts.amount.toFixed(2)},
          ${balanceBefore},
          ${restored},
          ${opts.requestId + '-reversal'},
          ${opts.txnId}::uuid,
          'Vendor delivery failed — automatic wallet refund'
        )
      ON CONFLICT (reference) DO NOTHING
    `);

    return {
      newBalance: restored,
    };
  });

  return newBalance;
}

/* ─────────────────────────────────────────────────────────────
   AIRTIME PURCHASE
───────────────────────────────────────────────────────────── */

router.post(
  '/airtime',
  async (req: Request, res: Response): Promise<void> => {

    const {
      network,
      phone,
      amount,
    } = req.body as {
      network?: string;
      phone?: string;
      amount?: number;
    };

    if (!network || !phone || amount === undefined) {
      res.status(400).json({
        error: 'network, phone, and amount are required.',
      });
      return;
    }

    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount < 50) {
      res.status(400).json({
        error: 'Minimum airtime amount is ₦50.',
      });
      return;
    }

    if (numericAmount > 50_000) {
      res.status(400).json({
        error: 'Maximum single airtime purchase is ₦50,000.',
      });
      return;
    }

    const cleanPhone = phone.replace(/\D/g, '');

    if (cleanPhone.length < 10 || cleanPhone.length > 11) {
      res.status(400).json({
        error: 'Please enter a valid Nigerian phone number.',
      });
      return;
    }

    try {
      ck.getNetworkCode(network);
    } catch {
      res.status(400).json({
        error: 'Invalid network. Use: mtn, glo, airtel, or 9mobile.',
      });
      return;
    }

    const userId = req.session.userId!;

    const idempotencyKey =
      (req.headers['idempotency-key'] ?? '') as string;

    if (idempotencyKey) {
      try {

        const handled = await handleIdempotency(
          res,
          userId,
          idempotencyKey,
          {
            network,
            phone: cleanPhone,
            amount: numericAmount,
          },
        );

        if (handled) return;

      } catch (err) {

        logger.error(
          { err, idempotencyKey },
          'Idempotency check failed — proceeding',
        );
      }
    }

    const requestId =
      idempotencyKey ||
      `GY-AIR-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)
        .toUpperCase()}`;

    let txnId: string;
    let newBalance: string;

    try {

      const result = await db.transaction(async (tx) =>
        debitWalletAndRecord(tx, {
          userId,
          amount: numericAmount,
          requestId,
          type: 'airtime',
          service: 'Airtime',
          provider: network.toUpperCase(),
          description:
            `${network.toUpperCase()} Airtime → ${cleanPhone}`,
          costPrice: numericAmount,
        }),
      );

      txnId = result.txnId;
      newBalance = result.newBalance;

    } catch (err: unknown) {

      const e = err as { code?: string };

      if (e.code === 'NOT_FOUND') {
        res.status(404).json({
          error: 'Wallet not found.',
        });
        return;
      }

      if (e.code === 'INSUFFICIENT_FUNDS') {
        res.status(402).json({
          error: 'insufficient_funds',
        });
        return;
      }

      logger.error(
        { err },
        'purchase/airtime debit failed',
      );

      res.status(500).json({
        error: 'Failed to process purchase.',
      });

      return;
    }

    let vendorResult: ck.CKPurchaseResult = {
      status: 'unsuccessful',
    };

    try {

      vendorResult = await ck.purchaseAirtime({
        network,
        phone: cleanPhone,
        amount: numericAmount,
        requestId,
      });

    } catch (err: unknown) {

      logger.error(
        { err, requestId },
        'ClubKonnect airtime call threw exception',
      );
    }

    const normalizedStatus =
      normalizeCKStatus(vendorResult.status);

    const providerRef =
      vendorResult.OrderID ??
      vendorResult.ident ??
      null;

    if (normalizedStatus === 'success') {

      await db.execute(sql`
        UPDATE transactions
        SET
          status = 'success',
          updated_at = NOW(),
          provider_reference = ${providerRef},
          metadata = jsonb_build_object(
            'vendorStatus', ${vendorResult.status},
            'providerRef', ${providerRef},
            'completedAt', NOW()::text
          )
        WHERE id = ${txnId}::uuid
      `);

      try {
        getIo()
          .to(`user:${userId}`)
          .emit('wallet:updated', {
            balance: newBalance,
          });
      } catch {
        // non-fatal
      }

      await createNotification(userId, {
        type: 'transaction',
        title: 'Airtime Sent ✅',
        body:
          `₦${numericAmount.toLocaleString('en-NG')} of ` +
          `${network.toUpperCase()} airtime was delivered to ${cleanPhone}.`,
        refId: txnId,
      });

      res.json({
        success: true,
        requestId,
        balance: newBalance,
        txnId,
        network,
        phone: cleanPhone,
        amount: numericAmount,
        providerRef,
        vendorStatus: vendorResult.status,
      });

      return;
    }

    if (normalizedStatus === 'pending') {

      await db.execute(sql`
        UPDATE transactions
        SET
          provider_reference = ${providerRef},
          updated_at = NOW(),
          metadata = jsonb_build_object(
            'vendorStatus', ${vendorResult.status},
            'providerRef', ${providerRef},
            'pendingMarkedAt', NOW()::text,
            'requiresPolling', true
          )
        WHERE id = ${txnId}::uuid
      `);

      res.json({
        success: false,
        pending: true,
        requestId,
        txnId,
        balance: newBalance,
        providerRef,
        vendorStatus: vendorResult.status,
        message:
          'Your airtime purchase is being processed. ' +
          'Your wallet will be refunded automatically if delivery fails.',
      });

      return;
    }

    try {

      newBalance =
        await refundWalletAndMarkFailed({
          userId,
          txnId,
          amount: numericAmount,
          requestId,
        });

    } catch (refundErr) {

      logger.error(
        {
          refundErr,
          txnId,
        },
        'CRITICAL: airtime refund failed',
      );
    }

    await createNotification(userId, {
      type: 'transaction',
      title: 'Airtime Purchase Failed',
      body:
        `₦${numericAmount.toLocaleString('en-NG')} of ` +
        `${network.toUpperCase()} airtime could not be delivered to ` +
        `${cleanPhone}. Your wallet has been refunded.`,
      refId: txnId,
    });

    res.status(422).json({
      success: false,
      requestId,
      balance: newBalance,
      txnId,
      vendorStatus: vendorResult.status,
      error:
        `Vendor returned: ${vendorResult.status || 'failed'}`,
    });
  },
);

/* ─────────────────────────────────────────────────────────────
   DATA PURCHASE — FIXED WITH BETTER PHONE VALIDATION
───────────────────────────────────────────────────────────── */

router.post(
  '/data',
  async (req: Request, res: Response): Promise<void> => {

    const {
      network,
      phone,
      planCode,
      planName,
      planPrice,
    } = req.body as {
      network?: string;
      phone?: string;
      planCode?: string;
      planName?: string;
      planPrice?: string;
    };

    // FIXED: Check for empty phone first with specific error message
    if (!phone) {
      res.status(400).json({
        error: 'Phone number is required.',
      });
      return;
    }

    if (!network || !planCode || !planPrice) {
      res.status(400).json({
        error:
          'network, planCode, and planPrice are required.',
      });
      return;
    }

    const numericAmount = parseFloat(planPrice);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      res.status(400).json({
        error: 'planPrice must be a positive number.',
      });
      return;
    }

    try {
      ck.getNetworkCode(network);
    } catch {
      res.status(400).json({
        error:
          'Invalid network. Use: mtn, glo, airtel, or 9mobile.',
      });
      return;
    }

    const cleanPhone = phone.replace(/\D/g, '');

    if (cleanPhone.length < 10 || cleanPhone.length > 11) {
      res.status(400).json({
        error: 'Please enter a valid Nigerian phone number.',
      });
      return;
    }

    const userId = req.session.userId!;

    const idempotencyKey =
      (req.headers['idempotency-key'] ?? '') as string;

    /*
     * THIS IS THE IMPORTANT PART.
     *
     * Example:
     *
     * ClubKonnect:
     *   planCode = 800.01
     *   planName = 1GB Weekly
     *
     * Super Admin:
     *   plan_id = 800.01
     *   selling_price = 450
     *
     * validateDataPrice() now finds that exact rule.
     */

    const priceCheck = await validateDataPrice(
      planCode,
      network,
      numericAmount,
      planName,
    );

    if (!priceCheck.valid) {

      if (priceCheck.error === 'price_mismatch') {

        res.status(409).json({
          error: 'price_mismatch',
          message:
            `Plan price has changed. Expected ₦` +
            `${priceCheck.expectedPrice?.toLocaleString('en-NG')}.`,
          expectedPrice: priceCheck.expectedPrice,
        });

      } else {

        res.status(400).json({
          error: priceCheck.error,
        });
      }

      return;
    }

    const confirmedAmount = priceCheck.sellingPrice;
    const costPrice = priceCheck.costPrice;
    const profit = confirmedAmount - costPrice;

    if (idempotencyKey) {

      try {

        const handled = await handleIdempotency(
          res,
          userId,
          idempotencyKey,
          {
            network,
            phone: cleanPhone,
            amount: confirmedAmount,
            planName: planName ?? planCode,
          },
        );

        if (handled) return;

      } catch (err) {

        logger.error(
          {
            err,
            idempotencyKey,
          },
          'Idempotency check failed — proceeding',
        );
      }
    }

    const requestId =
      idempotencyKey ||
      `GY-DAT-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)
        .toUpperCase()}`;

    let txnId: string;
    let newBalance: string;

    try {

      const result = await db.transaction(async (tx) =>
        debitWalletAndRecord(tx, {
          userId,
          amount: confirmedAmount,
          requestId,
          type: 'data',
          service: 'Data',
          provider: network.toUpperCase(),
          description:
            `${network.toUpperCase()} ` +
            `${planName ?? planCode} → ${cleanPhone}`,
          costPrice,
        }),
      );

      txnId = result.txnId;
      newBalance = result.newBalance;

    } catch (err: unknown) {

      const e = err as { code?: string };

      if (e.code === 'NOT_FOUND') {

        res.status(404).json({
          error: 'Wallet not found.',
        });

        return;
      }

      if (e.code === 'INSUFFICIENT_FUNDS') {

        res.status(402).json({
          error: 'insufficient_funds',
        });

        return;
      }

      logger.error(
        { err },
        'purchase/data debit failed',
      );

      res.status(500).json({
        error: 'Failed to process purchase.',
      });

      return;
    }

    /* ─────────────────────────────────────────────────────────
       CLUBKONNECT PURCHASE
    ───────────────────────────────────────────────────────── */

    let vendorResult: ck.CKPurchaseResult = {
      status: 'unsuccessful',
    };

    try {

      vendorResult = await ck.purchaseData({
        network,
        phone: cleanPhone,
        planCode,
        requestId,
      });

    } catch (err: unknown) {

      logger.error(
        {
          err,
          requestId,
          planCode,
          network,
        },
        'ClubKonnect data call threw exception',
      );
    }

    const normalizedStatus =
      normalizeCKStatus(vendorResult.status);

    const providerRef =
      vendorResult.OrderID ??
      vendorResult.ident ??
      null;

    const resolvedPlanName =
      vendorResult.DataPlanName ??
      planName ??
      planCode;

    logger.info(
      {
        userId,
        requestId,
        normalizedStatus,
        vendorStatus: vendorResult.status,
        providerRef,
        planCode,
        planName: resolvedPlanName,
        network,
        sellingPrice: confirmedAmount,
        costPrice,
        profit,
      },
      'Data vendor response',
    );

    /* ─────────────────────────────────────────────────────────
       SUCCESS
    ───────────────────────────────────────────────────────── */

    if (normalizedStatus === 'success') {

      await db.execute(sql`
        UPDATE transactions
        SET
          status = 'success',
          updated_at = NOW(),
          description =
            ${`${network.toUpperCase()} ${resolvedPlanName}`},
          provider_reference = ${providerRef},
          metadata = jsonb_build_object(
            'vendorStatus', ${vendorResult.status},
            'providerRef', ${providerRef},
            'planCode', ${planCode},
            'planName', ${resolvedPlanName},
            'costPrice', ${costPrice},
            'sellingPrice', ${confirmedAmount},
            'profit', ${profit},
            'completedAt', NOW()::text
          )
        WHERE id = ${txnId}::uuid
      `);

      try {

        getIo()
          .to(`user:${userId}`)
          .emit('wallet:updated', {
            balance: newBalance,
          });

      } catch {
        // non-fatal
      }

      await createNotification(userId, {
        type: 'transaction',
        title: 'Data Purchase Successful ✅',
        body:
          `${resolvedPlanName} has been delivered to ${cleanPhone}.`,
        refId: txnId,
      });

      let cashbackApplied = false;
      let cashbackAmount = 0;

      try {

        const cb = await applyCashbackIfEligible({
          userId,
          sourceTxnId: txnId,
          requestId,
          planCode,
          network,
          planName: resolvedPlanName,
          purchaseAmount: confirmedAmount,
        });

        if (cb.applied) {
          cashbackApplied = true;
          cashbackAmount = cb.amount;
        }

      } catch (cbErr) {

        logger.error(
          {
            cbErr,
            txnId,
          },
          'Cashback application failed — non-fatal',
        );
      }

      res.json({
        success: true,
        requestId,
        balance: newBalance,
        txnId,
        network,
        phone: cleanPhone,
        amount: confirmedAmount,
        planCode,
        planName: resolvedPlanName,
        providerRef,
        vendorStatus: vendorResult.status,
        cashbackApplied,
        cashbackAmount:
          cashbackApplied
            ? cashbackAmount
            : undefined,
      });

      return;
    }

    /* ─────────────────────────────────────────────────────────
       PENDING
    ───────────────────────────────────────────────────────── */

    if (normalizedStatus === 'pending') {

      await db.execute(sql`
        UPDATE transactions
        SET
          provider_reference = ${providerRef},
          updated_at = NOW(),
          metadata = jsonb_build_object(
            'vendorStatus', ${vendorResult.status},
            'providerRef', ${providerRef},
            'planCode', ${planCode},
            'planName', ${resolvedPlanName},
            'costPrice', ${costPrice},
            'sellingPrice', ${confirmedAmount},
            'pendingMarkedAt', NOW()::text,
            'requiresPolling', true
          )
        WHERE id = ${txnId}::uuid
      `);

      logger.info(
        {
          userId,
          requestId,
          planCode,
          providerRef,
        },
        'Data purchase pending — awaiting vendor confirmation',
      );

      res.json({
        success: false,
        pending: true,
        requestId,
        txnId,
        balance: newBalance,
        planCode,
        planName: resolvedPlanName,
        providerRef,
        vendorStatus: vendorResult.status,
        message:
          'Your data purchase is being processed. ' +
          'Your wallet will be refunded automatically if delivery fails.',
      });

      return;
    }

    /* ─────────────────────────────────────────────────────────
       FAILURE — REFUND
    ───────────────────────────────────────────────────────── */

    try {

      newBalance =
        await refundWalletAndMarkFailed({
          userId,
          txnId,
          amount: confirmedAmount,
          requestId,
        });

    } catch (refundErr) {

      logger.error(
        {
          refundErr,
          txnId,
          requestId,
        },
        'CRITICAL: data refund failed — manual intervention required',
      );
    }

    logger.warn(
      {
        userId,
        requestId,
        planCode,
        vendorStatus: vendorResult.status,
      },
      'Data purchase failed — wallet reversed',
    );

    await createNotification(userId, {
      type: 'transaction',
      title: 'Data Purchase Failed',
      body:
        `${resolvedPlanName} could not be delivered to ` +
        `${cleanPhone}. Your wallet has been refunded.`,
      refId: txnId,
    });

    res.status(422).json({
      success: false,
      requestId,
      balance: newBalance,
      txnId,
      vendorStatus: vendorResult.status,
      error:
        `Vendor returned: ${vendorResult.status || 'failed'}`,
    });
  },
);

/* ─────────────────────────────────────────────────────────────
   PURCHASE STATUS
───────────────────────────────────────────────────────────── */

router.get(
  '/status/:requestId',
  async (req: Request, res: Response): Promise<void> => {

    const { requestId } = req.params as {
      requestId: string;
    };

    const userId = req.session.userId!;

    const [txn] = await db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.reference, requestId),
          eq(transactionsTable.userId, userId),
        ),
      );

    if (!txn) {

      res.status(404).json({
        error: 'Transaction not found.',
      });

      return;
    }

    const [wallet] = await db
      .select()
      .from(walletsTable)
      .where(eq(walletsTable.userId, userId));

    res.json({
      status: txn.status,
      requestId,
      txnId: txn.id,
      type: txn.type,
      amount: txn.amount,
      description: txn.description,
      providerRef:
        (txn as unknown as {
          provider_reference?: string;
        }).provider_reference ?? null,
      balance: wallet?.balance ?? '0',
      createdAt: txn.createdAt,
    });
  },
);

export default router;
