// src/components/portal/PaymentInstructions.jsx
import React from "react";
import { useBusinessRules, depositPolicyPhrase, depositPolicySentence } from "@/hooks/useBusinessRules";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  BadgeDollarSign,
  DollarSign,
  Mail,
  Info,
  CreditCard,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const PaymentInstructions = ({ paymentInfo, onStripePay }) => {
  const rules = useBusinessRules();
  const P = paymentInfo || {};

  const isRepeatClient = !!P.isRepeatClient;

  const rawDeposit =
    P.depositAmount != null ? Number(P.depositAmount) : 50;

  const depositAmount = Number.isFinite(rawDeposit) ? rawDeposit : 50;
  const stripeEnabled = !!P.stripeEnabled;
  // Card fee estimate comes from the server (same math as checkout).
  const depositCardCharge = P.depositCardCharge || { estimatedFee: 0, grossAmount: depositAmount };

  const hasDeposit = depositAmount > 0 && !isRepeatClient;

  return (
    <Card
      id="payment-instructions"
      className="mt-6 shadow-sm border-plum/10 bg-white"
    >
      <CardHeader className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BadgeDollarSign className="h-5 w-5 text-gold" />
          <div>
            <CardTitle className="text-plum">
              Payment &amp; deposit details
            </CardTitle>
            <p className="text-xs text-plum/70 mt-0.5">
              How deposits work and ways to pay for your cleaning.
            </p>
          </div>
        </div>

        <div className="hidden sm:inline-flex items-center gap-2 rounded-full bg-plum/5 px-3 py-1 text-[11px] text-plum/80">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
          Secure, direct payment to Sanchez Services
        </div>
      </CardHeader>

      <CardContent className="space-y-6 text-sm text-plum/80">
        {/* Deposit policy / highlight */}
        <div className="rounded-xl bg-plum/5 border border-plum/10 p-4 space-y-2">
          {hasDeposit ? (
            <>
              <p className="text-sm text-plum">
                New clients are booked with a{" "}
                <strong>
                  ${depositAmount.toFixed(2)} {depositPolicyPhrase(rules)}
                </strong>{" "}
                to secure the appointment. The deposit is applied to your
                final balance at the time of service.
              </p>
              <p className="text-xs text-plum/75">
                Please pay your deposit within{" "}
                <span className="font-medium">24 hours of booking</span>.
                Always include your{" "}
                <span className="font-medium">full name</span> in the
                payment note so it can be matched to your appointment.
              </p>
              <p className="text-xs text-plum/75">
                Returning clients usually{" "}
                <span className="font-medium">do not need a deposit</span>;
                payment is due at the time of service unless Sterling lets
                you know otherwise.
              </p>
              <p className="text-xs text-plum/75">
                If you pay that deposit by card, Stripe adds a processing fee of{" "}
                <span className="font-medium">
                  ${depositCardCharge.estimatedFee.toFixed(2)}
                </span>{" "}
                so the total card charge is{" "}
                <span className="font-medium">
                  ${depositCardCharge.grossAmount.toFixed(2)}
                </span>
                . Cash App and Zelle stay at the flat deposit amount.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-plum">
                As a returning client,{" "}
                <strong>no deposit is required</strong> for this
                appointment. Payment is due at the time of service unless
                you and Sterling arrange something different.
              </p>
            </>
          )}
        </div>

        {/* How payments work */}
        <div className="space-y-1">
          <p className="text-sm font-semibold text-plum">
            How payments work for your cleanings
          </p>
          <p className="text-sm text-plum/75">
            • The online total is an{" "}
            <span className="font-semibold">estimate</span>. Your final
            invoice is confirmed on the day of your appointment after a
            quick walkthrough.
          </p>
          <p className="text-sm text-plum/75">
            • The{" "}
            <span className="font-semibold">remaining balance</span> is due
            at the time of your appointment.
          </p>
          <p className="text-sm text-plum/75">
            • Balances can be paid by{" "}
            <span className="font-semibold">
              card (Stripe), Cash App, or Zelle
            </span>
            . Card payments include a Stripe processing fee that is shown
            before checkout confirmation. Cash may be accepted if you arrange it directly with
            Sterling.
          </p>
        </div>

        {/* Payment methods */}
        {stripeEnabled && (
          <Row
            icon={CreditCard}
            title="Card (Stripe)"
            badge="Secure checkout"
            text={
              <>
                Pay with debit or credit card through a secure{" "}
                <span className="font-semibold">Stripe checkout</span>.
                Deposits and remaining balances are linked directly to your
                booking, and you&apos;ll receive an email receipt. The checkout
                page breaks out the service or deposit amount, processing fee,
                and total charged.
              </>
            }
            extra={
              onStripePay && (
                <Button
                  type="button"
                  className="mt-2 bg-gold hover:bg-gold/90 text-white text-xs rounded-full"
                  onClick={onStripePay}
                >
                  Pay online
                </Button>
              )
            }
          />
        )}

        {P.cashApp !== false && (
          <Row
            icon={DollarSign}
            title="Cash App"
            text={
              <>
                Send payments to{" "}
                <span className="font-semibold">
                  {P.cashApp || "$Sterlingsterls"}
                </span>
                . Always include your{" "}
                <span className="font-semibold">full name</span> in the
                note so it can be matched to your booking.
              </>
            }
          />
        )}

        {P.zelle !== false && (
          <Row
            icon={Mail}
            title="Zelle"
            text={
              <>
                Send payments via Zelle to{" "}
                <span className="font-semibold">
                  {P.zelle ||
                    "401-658-6708 (recipient: Sterling Sanchez)"}
                </span>
                . Include your{" "}
                <span className="font-semibold">full name</span> in the
                memo line.
              </>
            }
          />
        )}

        {P.cash && (
          <Row
            icon={DollarSign}
            title="Cash at time of service"
            text={
              <>
                Cash can be accepted at your appointment if you coordinate
                this directly with Sterling. For new clients, the initial
                deposit should still be paid ahead of time using Cash App,
                Zelle, or card.
              </>
            }
          />
        )}

        {/* Notes / cancellation policy */}
        <div className="rounded-lg bg-rose-50 border border-gold/20 p-3 text-sm text-plum/80 flex items-start gap-2">
          <Info className="w-4 h-4 text-gold mt-0.5 shrink-0" />
          <div>
            <p>
              {P.notes ||
                depositPolicySentence(rules)}
            </p>
            {P.extraNotice && (
              <p className="mt-1 text-xs text-plum/65">{P.extraNotice}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

const Row = ({ icon: Icon, title, text, badge, extra }) => (
  <div className="rounded-xl border border-gold/20 bg-white p-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
    <div className="flex gap-3">
      <Icon className="w-5 h-5 text-gold mt-0.5 shrink-0" />
      <div>
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-plum">{title}</p>
          {badge && (
            <span className="inline-flex items-center rounded-full bg-gold/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gold">
              {badge}
            </span>
          )}
        </div>
        <p className="text-sm text-plum/70 mt-0.5">{text}</p>
      </div>
    </div>
    {extra && <div className="sm:ml-8">{extra}</div>}
  </div>
);

export default PaymentInstructions;
