// src/lib/payments.js — presentation helpers for server-computed money (no pricing math here).
import { formatMoney, fmtDate, fmtTime, statusLabel, paymentStatusLabel, methodLabel, formatAddress } from "@/lib/model";

export { formatMoney };

export const isCancelled = (b) => ["cancelled", "declined", "expired"].includes(typeof b === "string" ? b : b?.status);
export const isNonBillable = isCancelled;

/** Summary of a normalized booking's money for tables/cards (values come from the API). */
export function derivePaymentInfo(b) {
  const card = (b?.payments || []).filter((p) => p.type === "payment" && p.status === "succeeded");
  const methods = Array.from(new Set(card.map((p) => methodLabel(p.method))));
  return {
    totalPrice: Number(b?.totalPrice || 0),
    totalAmount: Number(b?.totalPrice || 0),
    depositAmount: Number(b?.depositAmount || 0),
    depositPaid: !!b?.depositPaid,
    depositDue: Number(b?.depositDue || 0),
    amountPaid: Number(b?.amountPaid || 0),
    paidAmount: Number(b?.amountPaid || 0),
    totalPaid: Number(b?.amountPaid || 0),
    remainingBalance: Number(b?.balanceDue || 0),
    remainingDue: Number(b?.balanceDue || 0),
    balanceDue: Number(b?.balanceDue || 0),
    refundedAmount: Number(b?.amountRefunded || 0),
    refunded: Number(b?.amountRefunded || 0) > 0,
    paymentStatus: b?.paymentStatus,
    paymentStatusLabel: paymentStatusLabel(b?.paymentStatus),
    statusLabel: statusLabel(b?.status),
    methodLabel: methods.length ? methods.join(", ") : "Not recorded",
    dateTimeRange: b?.startAt ? `${fmtDate(b.startAt)} · ${fmtTime(b.startAt)} – ${fmtTime(b.endAt)}` : "TBD",
  };
}

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** CSV rows from a server invoice (GET /api/bookings/{id}/invoice). */
export function buildInvoiceCsvRows(inv) {
  const rows = [
    ["Invoice #", inv.invoiceNumber],
    ["Client", inv.billTo.name],
    ["Service", inv.service.name],
    ["Date", inv.service.date],
    ["Time", inv.service.time],
    ["Status", statusLabel(inv.service.bookingStatus)],
    ["Payment status", paymentStatusLabel(inv.status)],
    ...inv.lineItems.map((li) => [li.label + (li.detail ? ` (${li.detail})` : ""), li.amount.toFixed(2)]),
    ["Total", inv.total.toFixed(2)],
    ["Paid", inv.amountPaid.toFixed(2)],
    ["Refunded", inv.amountRefunded.toFixed(2)],
    ["Balance due", inv.balanceDue.toFixed(2)],
  ];
  return rows;
}

export function downloadCsv(rows, fileName) {
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Printable invoice HTML from the server invoice (same design as before; numbers from the API). */
export function buildInvoiceHtml(inv, { logoSrc = "", autoPrint = false } = {}) {
  const rowsHtml = inv.lineItems
    .map(
      (item) => `
        <tr>
          <td style="padding:10px 8px; border-bottom:1px solid #f1e3ff; font-size:12px;">
            <div>${escapeHtml(item.label)}</div>
            ${item.detail ? `<div style="margin-top:2px; font-size:11px; color:#9b74a6;">${escapeHtml(item.detail)}</div>` : ""}
          </td>
          <td style="padding:10px 8px; border-bottom:1px solid #f1e3ff; font-size:12px; text-align:right; ${item.amount < 0 ? "color:#b4234b;" : ""}">${formatMoney(item.amount)}</td>
        </tr>`
    )
    .join("");
  const paymentsHtml = inv.payments.length
    ? inv.payments
        .map(
          (p) => `<div style="display:flex; justify-content:space-between; padding:2px 0; ${p.status === "voided" ? "text-decoration:line-through; color:#b39bbc;" : ""}">
            <span>${escapeHtml(fmtDate(p.paidAt))} · ${escapeHtml(p.type === "refund" ? "Refund" : methodLabel(p.method))}</span>
            <span>${p.type === "refund" ? "−" : ""}${formatMoney(p.amount)}</span></div>`
        )
        .join("")
    : "<div style='color:#b39bbc;'>No payments recorded yet.</div>";
  const logoHtml = logoSrc ? `<img src="${escapeHtml(logoSrc)}" alt="Sanchez Services" style="max-width:100%; max-height:100%; object-fit:contain;" />` : "";
  const printScript = autoPrint
    ? `<script>(function(){function p(){try{window.focus();setTimeout(function(){try{window.print()}catch(e){}},350)}catch(e){}}if(document.readyState==='complete'){p()}else{window.addEventListener('load',p);setTimeout(p,1200)}})()</` + `script>`
    : "";
  const addr = formatAddress(inv.billTo.address);
  const biz = inv.business || {};
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Invoice - ${escapeHtml(inv.invoiceNumber)}</title>
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <style>
          html,body{margin:0;padding:0;background:#f7f2fb;-webkit-print-color-adjust:exact;color-adjust:exact}
          @page{size:auto;margin:10mm}
          @media print{body,html{background:#ffffff} *{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
        </style>
      </head>
      <body style="margin:0; background:#f7f2fb; font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#2c0735;">
        <div style="max-width:840px; margin:32px auto; background:#ffffff; border-radius:8px; padding:32px 36px; box-sizing:border-box; box-shadow:0 18px 40px rgba(31, 4, 43, 0.09);">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:28px;">
            <div style="display:flex; align-items:center; gap:12px;">
              <div style="width:40px; height:40px; border-radius:999px; overflow:hidden; display:flex; align-items:center; justify-content:center; border:1px solid #f1d7ff;">${logoHtml}</div>
              <div>
                <div style="font-size:14px; font-weight:600; letter-spacing:0.14em; text-transform:uppercase; color:#7e4b8e;">${escapeHtml(biz.name || "Sanchez Services")}</div>
                <div style="margin-top:4px; font-size:12px; color:#9b74a6;">Residential &amp; commercial cleaning<br/>Rhode Island &amp; Massachusetts${biz.email ? `<br/>${escapeHtml(biz.email)}` : ""}${biz.phone ? ` · ${escapeHtml(biz.phone)}` : ""}</div>
              </div>
            </div>
            <div style="text-align:right; font-size:11px; color:#9b74a6;">
              <div style="margin-bottom:4px;">Invoice # <span style="font-weight:600; letter-spacing:0.12em;">${escapeHtml(inv.invoiceNumber)}</span></div>
              <div>Invoice date: <span style="font-weight:500;">${escapeHtml(fmtDate(inv.issuedAt))}</span></div>
              <div>Status: <span style="font-weight:500;">${escapeHtml(paymentStatusLabel(inv.status))}</span></div>
            </div>
          </div>
          <h1 style="margin:0 0 28px; text-align:center; font-size:18px; letter-spacing:0.28em; text-transform:uppercase; color:#1a0430;">Cleaning services invoice</h1>
          <div style="display:flex; flex-wrap:wrap; gap:32px; margin-bottom:28px; font-size:13px;">
            <div style="flex:1 1 260px;">
              <div style="font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:0.12em; color:#9b74a6; margin-bottom:6px;">Bill to</div>
              <div style="font-size:14px; font-weight:500; color:#2c0735;">${escapeHtml(inv.billTo.name)}</div>
              <div style="margin-top:4px; color:#5b4461;">${escapeHtml(addr)}</div>
              <div style="margin-top:2px; color:#5b4461;">${escapeHtml(inv.billTo.email || "")}</div>
            </div>
            <div style="flex:1 1 220px;">
              <div style="font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:0.12em; color:#9b74a6; margin-bottom:6px;">Appointment</div>
              <div><strong>Service:</strong> ${escapeHtml(inv.service.name)}</div>
              <div style="margin-top:4px;"><strong>Date / time:</strong> ${escapeHtml(inv.service.date)} · ${escapeHtml(inv.service.time)}</div>
              <div style="margin-top:4px;"><strong>Frequency:</strong> ${escapeHtml(inv.service.frequency)}</div>
              <div style="margin-top:4px;"><strong>Status:</strong> ${escapeHtml(statusLabel(inv.service.bookingStatus))}</div>
            </div>
          </div>
          <table style="width:100%; border-collapse:collapse; font-size:13px; margin-bottom:20px;">
            <thead><tr>
              <th style="text-align:left; padding:10px 8px; background:#5b0b73; font-size:11px; text-transform:uppercase; letter-spacing:0.12em; color:#ffffff;">Description</th>
              <th style="text-align:right; padding:10px 8px; background:#5b0b73; font-size:11px; text-transform:uppercase; letter-spacing:0.12em; color:#ffffff;">Amount</th>
            </tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <div style="display:flex; justify-content:flex-end; margin-bottom:24px; font-size:13px;">
            <div style="width:280px;">
              <div style="display:flex; justify-content:space-between; padding:4px 0;"><span>Subtotal</span><span>${formatMoney(inv.subtotal)}</span></div>
              ${inv.discounts > 0 ? `<div style="display:flex; justify-content:space-between; padding:4px 0; color:#b4234b;"><span>Discounts</span><span>${formatMoney(-inv.discounts)}</span></div>` : ""}
              <div style="display:flex; justify-content:space-between; padding:4px 0; font-weight:600;"><span>Service total</span><span>${formatMoney(inv.total)}</span></div>
              <div style="display:flex; justify-content:space-between; padding:4px 0; border-top:1px solid #edd8ff; margin-top:6px;"><span>Paid</span><span>${formatMoney(inv.amountPaid)}</span></div>
              ${inv.amountRefunded > 0 ? `<div style="display:flex; justify-content:space-between; padding:4px 0; color:#b4234b;"><span>Refunded</span><span>${formatMoney(inv.amountRefunded)}</span></div>` : ""}
              <div style="display:flex; justify-content:space-between; padding:6px 0; border-top:1px solid #edd8ff; margin-top:6px; font-weight:600;"><span>Amount due</span><span>${formatMoney(inv.balanceDue)}</span></div>
            </div>
          </div>
          <div style="font-size:12px; margin-bottom:16px;">
            <div style="font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:0.12em; color:#9b74a6; margin-bottom:6px;">Payments</div>
            ${paymentsHtml}
          </div>
          <div style="margin-top:10px; padding-top:10px; border-top:1px dashed #e5d1ff; font-size:11px; color:#9b74a6;"><strong>Terms &amp; conditions</strong><br/>Deposits are non-refundable and are applied to your balance. Card payments include a processing fee shown at checkout. See sanchezproservices.com/terms-of-service.</div>
        </div>
        ${printScript}
      </body>
    </html>`;
}

/** Opens a printable invoice for a booking (fetched from the server). */
export async function openInvoiceWindow(fetchInvoice, logoSrc) {
  const w = window.open("", "_blank");
  try {
    const inv = await fetchInvoice();
    if (w) {
      w.document.open();
      w.document.write(buildInvoiceHtml(inv, { logoSrc, autoPrint: true }));
      w.document.close();
    }
  } catch (e) {
    w?.close();
    throw e;
  }
}
