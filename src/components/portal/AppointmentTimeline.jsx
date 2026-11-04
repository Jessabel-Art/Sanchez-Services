import React from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Clock, CheckCircle2, Star } from "lucide-react";

function toDate(tsLike) {
  if (!tsLike) return null;
  if (tsLike instanceof Date) return tsLike;
  if (typeof tsLike === "string" || typeof tsLike === "number") {
    const d = new Date(tsLike);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof tsLike === "object" && typeof tsLike.toDate === "function") {
    try {
      return tsLike.toDate();
    } catch {
      return null;
    }
  }
  // Firestore plain timestamp object { seconds, nanoseconds }
  if (tsLike && typeof tsLike.seconds === "number") {
    return new Date(tsLike.seconds * 1000);
  }
  return null;
}

function formatDateTime(tsLike) {
  const d = toDate(tsLike);
  if (!d) return "Pending";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Derive per-stage status from booking.
 *
 * Status values:
 *  - "done"     -> completed in the past
 *  - "current"  -> active / in progress
 *  - "upcoming" -> not reached yet
 *  - "skipped"  -> will not happen (e.g. cancelled before that stage)
 */
function computeStageStates(booking) {
  const now = new Date();
  const rawStatus = String(booking.status || booking.rawStatus || "")
    .toLowerCase()
    .trim();

  const createdAt = booking.createdAt || booking.created_at;
  const confirmedAt = booking.confirmedAt || booking.confirmed_at;
  const startAt = booking.startAt || booking.start_at || booking.date;
  const endAt = booking.endAt || booking.end_at;
  const completedAt = booking.completedAt || booking.completed_at;
  const paidAt = booking.paidAt || booking.paid_at;
  const reviewedAt = booking.reviewedAt || booking.reviewed_at;

  const paid = Number(booking.paid ?? booking.paidAmount ?? 0);
  const total = Number(
    booking.cost ??
      booking.total ??
      (booking.estimate && booking.estimate.total) ??
      0
  );

  // Deposit signals
  const depositAmount = Number(
    booking.depositAmount ?? booking.depositDue ?? 0
  );
  const requiresDeposit = depositAmount > 0;
  const depositPaid =
    !!booking.depositPaid ||
    String(booking.depositStatus || "")
      .toLowerCase()
      .includes("paid") ||
    !!booking.depositPaymentIntentId;
  const depositPaidAt =
    booking.depositPaidAt ||
    booking.deposit_paid_at ||
    booking.firstDepositPaidAt ||
    null;

  const isCancelled = [
    "cancelled",
    "declined",
    "expired",
    "refunded",
  ].includes(rawStatus);

  // REQUEST
  const request = {
    key: "request",
    label: "Request submitted",
    description: "You submitted your cleaning request.",
    status: "done",
    at: createdAt || startAt,
  };

  // DEPOSIT (only for new clients / bookings that actually require one)
  let depositStage = null;
  if (requiresDeposit) {
    let depositStatus = "upcoming";

    if (isCancelled && !depositPaid) {
      depositStatus = "skipped";
    } else if (depositPaid) {
      depositStatus = "done";
    } else {
      // deposit required but not paid yet
      depositStatus = "current";
    }

    const amountLabel =
      depositAmount > 0 ? `$${depositAmount.toFixed(2)} booking deposit` : "booking deposit";

    depositStage = {
      key: "deposit",
      label: "Deposit received",
      description: `Your ${amountLabel} to hold this appointment.`,
      status: depositStatus,
      at: depositPaidAt,
    };
  }

  // CONFIRMATION
  let confirmationStatus = "upcoming";
  if (isCancelled && !confirmedAt) {
    confirmationStatus = "skipped";
  } else if (confirmedAt || ["confirmed", "completed"].includes(rawStatus)) {
    confirmationStatus = "done";
  } else if (rawStatus === "pending") {
    confirmationStatus = "current";
  }

  const confirmation = {
    key: "confirmation",
    label: "Appointment confirmed",
    description: "Sterling reviews and confirms your appointment.",
    status: confirmationStatus,
    at: confirmedAt,
  };

  // SERVICE
  const startDate = toDate(startAt);
  const endDate = toDate(endAt);

  let serviceStatus = "upcoming";
  if (isCancelled && !completedAt) {
    serviceStatus = "skipped";
  } else if (completedAt || rawStatus === "completed") {
    serviceStatus = "done";
  } else if (startDate && endDate && now >= startDate && now <= endDate) {
    serviceStatus = "current";
  } else if (startDate && endDate && now > endDate && !completedAt && !isCancelled) {
    // should have happened; treat as done-ish
    serviceStatus = "done";
  }

  const service = {
    key: "service",
    label: "Cleaning completed",
    description: "Your home is cleaned on the scheduled date.",
    status: serviceStatus,
    at: completedAt || endAt || startAt,
  };

  // PAYMENT (remaining balance / full payment)
  let paymentStatus = "upcoming";
  const fullyPaid = total > 0 && paid >= total;
  const partiallyPaid = paid > 0 && paid < total;

  if (isCancelled && !paidAt && !paid) {
    paymentStatus = "skipped";
  } else if (fullyPaid || paidAt) {
    paymentStatus = "done";
  } else if (partiallyPaid) {
    paymentStatus = "current";
  } else if (serviceStatus === "done" && total > 0 && !paid) {
    paymentStatus = "current";
  }

  const payment = {
    key: "payment",
    label: "Payment received",
    description: requiresDeposit
      ? "Remaining balance after your deposit."
      : "Payment for this cleaning.",
    status: paymentStatus,
    at: paidAt,
  };

  // REVIEW
  let reviewStatus = "upcoming";
  if (reviewedAt || booking.reviewStatus === "submitted") {
    reviewStatus = "done";
  } else if (serviceStatus === "done" && !isCancelled) {
    reviewStatus = "current";
  } else if (isCancelled && !reviewedAt) {
    reviewStatus = "skipped";
  }

  const review = {
    key: "review",
    label: "Review",
    description: "Share feedback about your cleaning experience.",
    status: reviewStatus,
    at: reviewedAt,
  };

  const stages = [request];

  // New-client timeline: insert deposit stage
  if (depositStage) stages.push(depositStage);

  stages.push(confirmation, service, payment, review);
  return stages;
}

function stageClasses(stage) {
  switch (stage.status) {
    case "done":
      return {
        dot: "bg-emerald-500 border-emerald-500 text-white",
        line: "bg-emerald-200",
        badge:
          "bg-emerald-50 text-emerald-800 border border-emerald-100",
      };
    case "current":
      return {
        dot: "bg-gold border-gold text-white",
        line: "bg-gold/40",
        badge: "bg-gold/10 text-plum border border-gold/40",
      };
    case "skipped":
      return {
        dot: "bg-rose-100 border-rose-200 text-rose-500",
        line: "bg-rose-100",
        badge: "bg-rose-50 text-rose-700 border border-rose-100",
      };
    default:
      // upcoming
      return {
        dot: "bg-white border-plum/30 text-plum/50",
        line: "bg-plum/10",
        badge: "bg-plum/5 text-plum/70 border border-plum/10",
      };
  }
}

/**
 * AppointmentTimeline
 *
 * Props:
 *  - booking: Firestore booking doc (or mapped row) with status + timestamps
 *  - title? (optional) override card title
 */
export default function AppointmentTimeline({ booking, title }) {
  if (!booking) return null;

  const stages = computeStageStates(booking);
  const serviceName =
    booking.serviceName || booking.service || booking.serviceSlug;

  return (
    <Card className="bg-white border-plum/10">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-plum/80" />
          <CardTitle className="text-plum text-base md:text-lg">
            {title || "Appointment timeline"}
          </CardTitle>
        </div>
        {serviceName && (
          <p className="text-xs text-plum/70 mt-1">
            {serviceName} ·{" "}
            {booking.invoiceNumber ? `Booking #${booking.invoiceNumber}` : null}
          </p>
        )}
      </CardHeader>

      <CardContent className="pt-0">
        <ol className="relative border-l border-plum/10 ml-3 space-y-4">
          {stages.map((stage, idx) => {
            const cls = stageClasses(stage);
            const isLast = idx === stages.length - 1;

            return (
              <li key={stage.key} className="pl-4 relative">
                {/* Dot */}
                <div
                  className={[
                    "absolute -left-[9px] mt-1 w-4 h-4 rounded-full border flex items-center justify-center text-[10px]",
                    cls.dot,
                  ].join(" ")}
                >
                  {stage.key === "request" && (
                    <Clock className="w-3 h-3" />
                  )}
                  {stage.key === "deposit" && (
                    <span className="font-bold">$</span>
                  )}
                  {stage.key === "confirmation" && (
                    <CheckCircle2 className="w-3 h-3" />
                  )}
                  {stage.key === "service" && (
                    <CheckCircle2 className="w-3 h-3" />
                  )}
                  {stage.key === "payment" && (
                    <span className="font-bold">$</span>
                  )}
                  {stage.key === "review" && (
                    <Star className="w-3 h-3" />
                  )}
                </div>

                {/* Vertical connector line */}
                {!isLast && (
                  <div
                    className={[
                      "absolute left-[-1px] top-5 w-[2px] h-full",
                      cls.line,
                    ].join(" ")}
                  />
                )}

                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-plum">
                      {stage.label}
                    </span>
                    <span
                      className={[
                        "inline-flex items-center px-2 py-0.5 rounded-full text-[11px]",
                        cls.badge,
                      ].join(" ")}
                    >
                      {stage.status === "done" && "Completed"}
                      {stage.status === "current" && "In progress"}
                      {stage.status === "upcoming" && "Upcoming"}
                      {stage.status === "skipped" && "Skipped"}
                    </span>
                  </div>
                  <p className="text-xs text-plum/70">
                    {stage.description}
                  </p>
                  <p className="text-[11px] text-plum/60">
                    {formatDateTime(stage.at)}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
