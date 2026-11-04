// src/pages/PaymentConfirmationPage.jsx — Stripe return page for balance payments.
import React from "react";
import ConfirmationPage from "@/pages/ConfirmationPage";

export default function PaymentConfirmationPage() {
  return <ConfirmationPage purpose="balance" />;
}
