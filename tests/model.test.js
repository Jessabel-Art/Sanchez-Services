import { describe, it, expect } from "vitest";
import { normalizeBooking, dateKey, fmtTime, statusLabel, formatAddress, isUpcoming } from "../src/lib/model";
import { derivePaymentInfo, buildInvoiceCsvRows, buildInvoiceHtml } from "../src/lib/payments";

const apiBooking = {
  id: "abc", invoiceNumber: "SS-2026-000001", status: "confirmed", serviceName: "Deep Clean",
  startAt: "2026-12-15T14:00:00.000Z", endAt: "2026-12-15T16:30:00.000Z", createdAt: "2026-11-01T12:00:00.000Z",
  contact: { name: "Casey Client", email: "c@example.test" }, address: { line1: "12 Elm St", city: "Providence", state: "RI", zip: "02903" },
  totalPrice: 145, depositAmount: 50, amountPaid: 50, balanceDue: 95, depositDue: 0, depositPaid: true, paymentStatus: "deposit_paid",
  payments: [{ id: 1, type: "payment", method: "card", amount: 50, fee: 1.8, gross: 51.8, status: "succeeded", paidAt: "2026-11-01T12:05:00.000Z" }],
  permissions: { canCancel: true },
};

describe("model", () => {
  it("normalizes API dates and derived fields", () => {
    const b = normalizeBooking(apiBooking);
    expect(b.startAt).toBeInstanceOf(Date);
    expect(b.payments[0].paidAt).toBeInstanceOf(Date);
    expect(b.clientName).toBe("Casey Client");
    expect(b.addressText).toBe("12 Elm St, Providence, RI 02903");
  });

  it("formats in the business timezone regardless of the browser timezone", () => {
    expect(dateKey("2026-12-16T03:30:00.000Z")).toBe("2026-12-15"); // 10:30 PM Eastern
    expect(fmtTime("2026-12-15T14:00:00.000Z")).toBe("9:00 AM");
    expect(fmtTime("2026-07-15T13:00:00.000Z")).toBe("9:00 AM"); // DST
  });

  it("labels and upcoming checks", () => {
    expect(statusLabel("pending_payment")).toBe("Awaiting deposit");
    expect(formatAddress({ line1: "1 A", city: "B", state: "RI", zip: "02903" })).toBe("1 A, B, RI 02903");
    expect(isUpcoming({ status: "confirmed", startAt: new Date(Date.now() + 86400000) })).toBe(true);
    expect(isUpcoming({ status: "cancelled", startAt: new Date(Date.now() + 86400000) })).toBe(false);
  });
});

describe("payments presentation", () => {
  it("reads server amounts without recomputing", () => {
    const info = derivePaymentInfo(normalizeBooking(apiBooking));
    expect(info.totalPrice).toBe(145);
    expect(info.remainingDue).toBe(95);
    expect(info.paymentStatusLabel).toBe("Deposit paid");
    expect(info.methodLabel).toBe("Card");
  });

  it("renders server invoices (escaped) and CSV", () => {
    const inv = {
      invoiceNumber: "SS-2026-000001", issuedAt: "2026-11-01T12:00:00.000Z", status: "deposit_paid",
      business: { name: "Sanchez Services" }, billTo: { name: "<b>Casey</b>", email: "c@example.test", address: apiBooking.address },
      service: { name: "Deep Clean", date: "2026-12-15", time: "9:00 AM", frequency: "one-time", bookingStatus: "confirmed" },
      lineItems: [{ label: "Deep Clean", detail: "Base service", amount: 120 }, { label: "Promo code", detail: "CLEAN10", amount: -12 }],
      subtotal: 120, discounts: 12, total: 108, payments: [], amountPaid: 50, amountRefunded: 0, balanceDue: 58,
    };
    const html = buildInvoiceHtml(inv);
    expect(html).toContain("&lt;b&gt;Casey&lt;/b&gt;");
    expect(html).toContain("$108.00");
    expect(buildInvoiceCsvRows(inv).find((r) => r[0] === "Balance due")[1]).toBe("58.00");
  });
});
