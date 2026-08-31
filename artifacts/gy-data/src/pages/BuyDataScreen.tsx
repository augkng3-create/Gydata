import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
} from 'react';

import { motion } from 'framer-motion';

import {
  ChevronLeft,
  RefreshCw,
  AlertCircle,
  Gift,
} from 'lucide-react';

import { useLocation } from 'wouter';

import { Button } from '@/components/ui/button';

import { useAppContext } from '../context/AppContext';

import SuccessModal from '@/components/SuccessModal';

import type { ReceiptData } from '@/components/TransactionReceipt';

import { toast } from 'sonner';

import {
  fetchDataPlans,
  buyData,
  type DataPlan,
} from '@/lib/api';

import PhoneInputWithContacts, {
  isValidNigerianNumber,
} from '@/components/PhoneInputWithContacts';

const networks = [
  {
    id: 'mtn',
    name: 'MTN',
    color: 'bg-[#FFCC00]',
    text: 'text-black',
  },
  {
    id: 'airtel',
    name: 'Airtel',
    color: 'bg-[#FF0000]',
    text: 'text-white',
  },
  {
    id: 'glo',
    name: 'Glo',
    color: 'bg-[#009900]',
    text: 'text-white',
  },
  {
    id: '9mobile',
    name: '9mobile',
    color: 'bg-[#006600]',
    text: 'text-white',
  },
];

export default function BuyDataScreen() {
  const [, setLocation] =
    useLocation();

  const {
    purchaseData,
    balance,
  } = useAppContext();

  const [step, setStep] =
    useState(1);

  const [network, setNetwork] =
    useState('');

  const [phone, setPhone] =
    useState('');

  const [plan, setPlan] =
    useState<DataPlan | null>(null);

  // Live plan state
  const [plans, setPlans] =
    useState<DataPlan[]>([]);

  const [plansLoading, setPlansLoading] =
    useState(false);

  const [plansError, setPlansError] =
    useState('');

  // Purchase state
  const [isLoading, setIsLoading] =
    useState(false);

  const [showSuccess, setShowSuccess] =
    useState(false);

  const [successData, setSuccessData] =
    useState<ReceiptData | null>(null);

  // ── Idempotency key ───────────────────────────────────────────────────────
  const idempotencyKey =
    useRef<string | null>(null);

  useEffect(() => {
    idempotencyKey.current = null;
  }, [network, phone, plan]);

  const selectedNetwork =
    networks.find(
      (n) => n.id === network,
    );

  // ── LOAD DATA PLANS ───────────────────────────────────────────────────────
  //
  // IMPORTANT FIX:
  //
  // Previously:
  //   loadPlans(network)
  //
  // which resulted in:
  //   GET /data-plans?network=mtn
  //
  // and ClubKonnect received no MobileNumber.
  //
  // Now:
  //   loadPlans(network, phone)
  //
  // which results in:
  //   GET /data-plans?network=mtn&phone=080...
  //
  const loadPlans = useCallback(
    async (
      net: string,
      targetPhone: string,
    ) => {
      const normalizedPhone =
        targetPhone.trim();

      if (
        !isValidNigerianNumber(
          normalizedPhone,
        )
      ) {
        setPlans([]);
        setPlansError(
          'Enter a valid Nigerian phone number first.',
        );
        return;
      }

      setPlansLoading(true);
      setPlansError('');
      setPlans([]);
      setPlan(null);

      try {
        const fetched =
          await fetchDataPlans(
            net,
            normalizedPhone,
          );

        if (fetched.length === 0) {
          setPlansError(
            'No plans available for this network right now.',
          );
        } else {
          setPlans(fetched);
        }
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Failed to load plans';

        setPlansError(
          msg
            .toLowerCase()
            .includes('credentials') ||
          msg.includes('503')
            ? 'Service temporarily unavailable. Check back shortly.'
            : 'Could not load data plans. Please try again.',
        );
      } finally {
        setPlansLoading(false);
      }
    },
    [],
  );

  // ── NETWORK SELECT ───────────────────────────────────────────────────────
  //
  // DO NOT load plans here.
  //
  // User has not entered a phone number yet.
  //
  const handleNetworkSelect = (
    netId: string,
  ) => {
    setNetwork(netId);

    setPlans([]);
    setPlan(null);
    setPlansError('');

    if (step === 1) {
      setStep(2);
    }
  };

  // ── PURCHASE ──────────────────────────────────────────────────────────[...]

  const handlePurchase =
    async () => {
      if (
        !plan ||
        !selectedNetwork
      ) {
        return;
      }

      const planPrice =
        parseFloat(plan.Price);

      if (
        isNaN(planPrice) ||
        balance < planPrice
      ) {
        toast.error(
          'Insufficient wallet balance. Please fund your wallet.',
        );
        return;
      }

      // Normalize phone by trimming whitespace
      const normalizedPhone =
        phone.trim();

      if (
        !isValidNigerianNumber(normalizedPhone)
      ) {
        toast.error(
          'Please enter a valid Nigerian phone number.',
        );
        return;
      }

      // Generate a key the first time;
      // reuse it on retries.
      if (
        !idempotencyKey.current
      ) {
        idempotencyKey.current =
          `GY-DAT-${Date.now()
            .toString(36)
            .toUpperCase()}-${Math.random()
            .toString(36)
            .slice(2, 8)
            .toUpperCase()}`;
      }

      setIsLoading(true);

      try {
        const result =
          await purchaseData({
            network:
              selectedNetwork.id,
            phone:
              normalizedPhone,
            planCode:
              plan.DataPlan,
            planName:
              plan.DataPlanName,
            planPrice:
              plan.Price,
            idempotencyKey:
              idempotencyKey.current,
          });

        if (result.pending) {
          toast.info(
            'Transaction is being processed. Check your transaction history shortly.',
          );
          return;
        }

        if (!result.success) {
          if (
            result.error ===
            'previous_attempt_failed'
          ) {
            idempotencyKey.current =
              null;

            toast.error(
              'Previous attempt failed. Tap "Pay" again to retry.',
            );
          } else {
            toast.error(
              result.error ??
                'Transaction failed. Please try again.',
            );
          }

          return;
        }

        idempotencyKey.current =
          null;

        const now =
          new Date();

        setSuccessData({
          type: 'data',
          provider:
            selectedNetwork.name,
          service: 'Data',
          description: `${
            selectedNetwork.name
          } ${
            result.planName ??
            plan.DataPlanName
          }`,
          amount: planPrice,
          date:
            now.toLocaleDateString(
              'en-GB',
              {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              },
            ),
          time:
            now.toLocaleTimeString(
              'en-US',
              {
                hour: '2-digit',
                minute: '2-digit',
              },
            ),
          status: 'success',
          txnId:
            result.requestId,
          paymentMethod:
            'Wallet',
          cashbackAmount:
            result.cashbackAmount,
        });

        setShowSuccess(true);
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Purchase failed';

        toast.error(
          msg
            .toLowerCase()
            .includes('503')
            ? 'Service temporarily unavailable.'
            : msg,
        );
      } finally {
        setIsLoading(false);
      }
    };

  return (
    <motion.div
      initial={{
        opacity: 0,
        x: 20,
      }}
      animate={{
        opacity: 1,
        x: 0,
      }}
      exit={{
        opacity: 0,
        x: -20,
      }}
      className="p-4 sm:p-6 max-w-md mx-auto min-h-screen bg-background relative"
    >
      {/* Header */}

      <div className="flex items-center gap-3 mb-8 pt-2">
        <button
          onClick={() => {
            if (step > 1) {
              setStep(
                step - 1,
              );
            } else {
              setLocation('/');
            }
          }}
          className="w-10 h-10 bg-card rounded-full flex items-center justify-center border border-border active:scale-95 transition-transform"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>

        <h1 className="text-xl font-bold">
          Buy Data
        </h1>
      </div>

      {/* Progress */}

      <div className="flex gap-1.5 mb-8">
        {[1, 2, 3, 4].map(
          (s) => (
            <div
              key={s}
              className={`h-1 rounded-full flex-1 transition-colors ${
                s <= step
                  ? 'bg-primary'
                  : 'bg-border'
              }`}
            />
          ),
        )}
      </div>

      <div className="space-y-8 pb-48">

        {/* Step 1 — Network */}

        <div>
          <h2 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wider">
            1. Select Network
          </h2>

          <div className="grid grid-cols-4 gap-3">
            {networks.map(
              (n) => (
                <button
                  key={n.id}
                  onClick={() =>
                    handleNetworkSelect(
                      n.id,
                    )
                  }
                  className={`flex flex-col items-center gap-2 p-3 rounded-2xl border-2 transition-all active:scale-95 ${
                    network === n.id
                      ? 'border-primary bg-primary/10'
                      : 'border-border bg-card hover:border-border/80'
                  }`}
                >
                  <div
                    className={`w-12 h-12 rounded-full flex items-center justify-center font-bold text-sm ${n.color} ${n.text}`}
                  >
                    {n.name[0]}
                  </div>

                  <span className="text-xs font-medium">
                    {n.name}
                  </span>
                </button>
              ),
            )}
          </div>
        </div>

        {/* Step 2 — Phone */}

        {step >= 2 && (
          <motion.div
            initial={{
              opacity: 0,
              y: 10,
            }}
            animate={{
              opacity: 1,
              y: 0,
            }}
          >
            <PhoneInputWithContacts
              value={phone}
              onChange={setPhone}
              label="2. Phone Number"
            />

            {isValidNigerianNumber(
              phone,
            ) &&
              step === 2 && (
                <Button
                  className="w-full mt-4 h-12 rounded-xl"
                  onClick={() => {
                    if (
                      !isValidNigerianNumber(
                        phone,
                      )
                    ) {
                      toast.error(
                        'Please enter a valid Nigerian phone number.',
                      );
                      return;
                    }

                    setStep(3);

                    void loadPlans(
                      network,
                      phone,
                    );
                  }}
                  disabled={
                    plansLoading
                  }
                >
                  {plansLoading
                    ? 'Loading Plans...'
                    : 'Continue'}
                </Button>
              )}
          </motion.div>
        )}

        {/* Step 3 — Plans */}

        {step >= 3 &&
          isValidNigerianNumber(
            phone,
          ) && (
            <motion.div
              initial={{
                opacity: 0,
                y: 10,
              }}
              animate={{
                opacity: 1,
                y: 0,
              }}
            >
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  3. Select Plan
                </h2>

                {!plansLoading && (
                  <button
                    onClick={() =>
                      loadPlans(
                        network,
                        phone,
                      )
                    }
                    className="text-xs text-primary flex items-center gap-1 hover:underline"
                  >
                    <RefreshCw className="w-3 h-3" />

                    Refresh
                  </button>
                )}
              </div>

              {/* Loading skeletons */}

              {plansLoading && (
                <div className="space-y-3">
                  {[1, 2, 3, 4].map(
                    (i) => (
                      <div
                        key={i}
                        className="h-16 bg-card border border-border rounded-xl animate-pulse"
                      />
                    ),
                  )}
                </div>
              )}

              {/* Error state */}

              {!plansLoading &&
                plansError && (
                  <div className="flex flex-col items-center gap-3 py-8 px-4 bg-card border border-border rounded-xl text-center">
                    <AlertCircle className="w-8 h-8 text-muted-foreground" />

                    <p className="text-sm text-muted-foreground">
                      {plansError}
                    </p>

                    <button
                      onClick={() =>
                        loadPlans(
                          network,
                          phone,
                        )
                      }
                      className="text-sm text-primary font-semibold hover:underline"
                    >
                      Try again
                    </button>
                  </div>
                )}

              {/* Plans list */}

              {!plansLoading &&
                !plansError &&
                plans.length >
                  0 && (
                  <div className="space-y-3">
                    {plans.map(
                      (p) => (
                        <button
                          key={
                            p.DataPlan
                          }
                          onClick={() => {
                            setPlan(
                              p,
                            );
                            setStep(4);
                          }}
                          className={`w-full flex items-center justify-between p-4 rounded-xl border-2 transition-all active:scale-[0.98] ${
                            plan?.DataPlan ===
                            p.DataPlan
                              ? 'border-primary bg-primary/10'
                              : 'border-border bg-card hover:border-border/80'
                          }`}
                        >
                          <div className="text-left">
                            <p className="font-bold text-base">
                              {
                                p.DataPlanName
                              }
                            </p>

                            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                              <p className="text-xs text-muted-foreground">
                                {
                                  p.DataPlanType
                                }
                              </p>

                              {p.cashback_enabled &&
                                p.cashback_amount &&
                                parseFloat(
                                  p.cashback_amount,
                                ) >
                                  0 && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-green-500/15 border border-green-500/25 text-green-600 text-[10px] font-bold leading-tight">
                                    <Gift className="w-2.5 h-2.5" />

                                    ₦
                                    {parseFloat(
                                      p.cashback_amount,
                                    ).toLocaleString()}{' '}
                                    Cashback
                                  </span>
                                )}
                            </div>
                          </div>

                          <p className="font-bold text-primary text-lg">
                            ₦
                            {parseFloat(
                              p.Price,
                            ).toLocaleString()}
                          </p>
                        </button>
                      ),
                    )}
                  </div>
                )}
            </motion.div>
          )}
      </div>

      {/* Step 4 — Confirm panel above BottomNav */}
      {/* FIXED: Add phone validation check to prevent Step 4 from showing with invalid/empty phone */}

      {step >= 4 &&
        plan &&
        isValidNigerianNumber(
          phone,
        ) && (
          <motion.div
            initial={{
              y: 100,
              opacity: 0,
            }}
            animate={{
              y: 0,
              opacity: 1,
            }}
            className="fixed bottom-16 left-0 right-0 bg-white/95 backdrop-blur-md border-t border-border shadow-[0_-4px_24px_rgba(14,29,70,0.08)] p-4 z-50 max-w-md mx-auto"
          >
            <div className="bg-card border border-border rounded-xl p-4 mb-3 text-sm">

              <div className="flex justify-between mb-2">
                <span className="text-muted-foreground">
                  Network
                </span>

                <span className="font-semibold">
                  {selectedNetwork?.name}
                </span>
              </div>

              <div className="flex justify-between mb-2">
                <span className="text-muted-foreground">
                  Plan
                </span>

                <span className="font-semibold">
                  {plan.DataPlanName}
                </span>
              </div>

              <div className="flex justify-between mb-2">
                <span className="text-muted-foreground">
                  Number
                </span>

                <span className="font-semibold">
                  {phone}
                </span>
              </div>

              {plan.cashback_enabled &&
                plan.cashback_amount &&
                parseFloat(
                  plan.cashback_amount,
                ) > 0 && (
                  <div className="flex justify-between mb-2">
                    <span className="text-green-600 flex items-center gap-1 font-medium">
                      <Gift className="w-3.5 h-3.5" />

                      Cashback
                    </span>

                    <span className="font-bold text-green-600">
                      +₦
                      {parseFloat(
                        plan.cashback_amount,
                      ).toLocaleString()}
                    </span>
                  </div>
                )}

              <div className="flex justify-between pt-2 border-t border-border mt-1">
                <span className="text-muted-foreground">
                  Total
                </span>

                <span className="font-bold text-primary text-base">
                  ₦
                  {parseFloat(
                    plan.Price,
                  ).toLocaleString()}
                </span>
              </div>
            </div>

            <Button
              className="w-full h-12 text-base rounded-xl font-bold"
              onClick={
                handlePurchase
              }
              disabled={
                isLoading
              }
            >
              {isLoading
                ? 'Processing…'
                : `Pay ₦${parseFloat(
                    plan.Price,
                  ).toLocaleString()}`}
            </Button>
          </motion.div>
        )}

      {successData && (
        <SuccessModal
          open={showSuccess}
          onOpenChange={
            setShowSuccess
          }
          receipt={
            successData
          }
          onDone={() =>
            setLocation('/')
          }
        />
      )}
    </motion.div>
  );
}
