// src/hooks/useBusinessRules.js — business rules from /api/catalog (cached once per page load).
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";

let cache = null;
let inflight = null;

export function useBusinessRules() {
  const [rules, setRules] = useState(cache);
  useEffect(() => {
    if (cache) return undefined;
    let alive = true;
    inflight = inflight || apiGet("/catalog").then((c) => (cache = c.rules)).catch(() => null);
    inflight.then((r) => alive && r && setRules(r));
    return () => {
      alive = false;
    };
  }, []);
  return rules;
}

/** Deposit wording driven by business.deposit_refund_policy (owner decision; refunds remain an admin action). */
export function depositPolicyPhrase(rules) {
  const hours = rules?.changeCutoffHours ?? 24;
  return rules?.depositRefundPolicy === "refundable_before_cutoff"
    ? `deposit (refundable if you cancel at least ${hours} hours ahead)`
    : "non-refundable deposit";
}

export function depositPolicySentence(rules) {
  const hours = rules?.changeCutoffHours ?? 24;
  return rules?.depositRefundPolicy === "refundable_before_cutoff"
    ? `Deposits are refunded if you cancel at least ${hours} hours before your appointment, or can be moved to a new date when you reschedule.`
    : `Deposits are non-refundable but can usually be transferred once to a new date if you reschedule with at least ${hours} hours’ notice.`;
}
