// src/components/portal/AppointmentsView.jsx
import React from "react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

import UpcomingBookings from "@/components/portal/UpcomingBookings";
import PastBookings from "@/components/portal/PastBookings";

import logoPrimary from "@/assets/logo/logo-primary.png";

/* -------------------------------------------------------------------------- */
/*                                DATE HELPERS                                */
/* -------------------------------------------------------------------------- */

function toDate(tsLike) {
  if (!tsLike) return null;
  if (typeof tsLike.toDate === "function") return tsLike.toDate();
  return new Date(tsLike);
}

function formatDate(tsLike) {
  const d = toDate(tsLike);
  if (!d || Number.isNaN(d.getTime())) return "TBD";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatTime(tsLike) {
  const d = toDate(tsLike);
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function money(n) {
  return Number(n || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

/* -------------------------------------------------------------------------- */
/*                             PDF GENERATION HELPERS                          */
/* -------------------------------------------------------------------------- */

function generateAppointmentPrintView(booking) {
  const win = window.open("", "_blank");
  if (!win) return;

  const orderCode = (booking.invoiceNumber || booking.id || "");

  const start = toDate(booking.startAt || booking.date);
  const end = toDate(booking.endAt);
  const dateLine = start
    ? `${formatDate(start)}${
        formatTime(start) ? " · " + formatTime(start) : ""
      }${end ? " – " + formatTime(end) : ""}`
    : "TBD";

  const address =
    booking.address ||
    booking.fullAddress ||
    booking.street ||
    "On file";

  const bedrooms = booking.bedrooms ?? booking.numBedrooms ?? "—";
  const bathrooms = booking.bathrooms ?? booking.numBathrooms ?? "—";

  const addOnsRaw =
    booking.addOns ||
    booking.addons ||
    booking.selectedAddOns ||
    [];
  const addOns = Array.isArray(addOnsRaw)
    ? addOnsRaw.length > 0
      ? addOnsRaw.join(", ")
      : "None added"
    : "None added";

  const notes = booking.notes || booking.clientNotes || "";

  // --- Deposit normalization (match portal logic) ---
  const depositAmount = Number(
    booking.depositAmount ??
      booking.payment?.depositAmount ??
      booking.depositDue ??
      0
  );

  const depositPaid = Boolean(
    booking.depositPaid ??
      booking.depositReceived ??
      booking.payment?.depositPaid ??
      false
  );

  const depositStatusLabel =
    depositAmount === 0 ? "" : depositPaid ? " (Paid)" : " (Pending)";

  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Appointment ${orderCode}</title>
<style>
  body {
    font-family: system-ui, sans-serif;
    color: #4A154B;
    margin: 0;
    padding: 24px;
    background: #FDF6F9;
  }
  .page {
    max-width: 800px;
    margin: 0 auto;
    background: #ffffff;
    border-radius: 18px;
    padding: 24px 28px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.06);
  }
  h1 {
    font-size: 20px;
    margin-bottom: 12px;
  }
  h2 {
    margin-top: 22px;
    font-size: 14px;
    margin-bottom: 6px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 32px;
  }
  .label {
    font-size: 11px;
    color: #996399;
    text-transform: uppercase;
  }
  .notes {
    border: 1px solid rgba(148,74,148,0.15);
    background: #FCF4FF;
    padding: 10px;
    border-radius: 10px;
    min-height: 40px;
    white-space: pre-wrap;
  }
  hr {
    border: none;
    border-top: 1px solid rgba(148,74,148,0.12);
    margin: 20px 0;
  }
</style>
</head>
<body>
<div class="page">

  <div style="display:flex; justify-content:space-between; align-items:flex-start;">
    <div style="display:flex; align-items:center; gap:10px;">
      <img src="${logoPrimary}" style="height:40px;" />
      <div>
        <div style="font-weight:600;">Sanchez Services</div>
        <div style="font-size:12px; color:#996399;">Appointment Summary</div>
      </div>
    </div>

    <div style="text-align:right; font-size:12px; color:#996399;">
      <div>Order: <strong>${orderCode}</strong></div>
      <div>${dateLine}</div>
    </div>
  </div>

  <h1>Appointment details</h1>

  <div class="grid">
    <div>
      <div class="label">Service</div>
      <div>${booking.service || "Residential Cleaning"}</div>
    </div>
    <div>
      <div class="label">Total</div>
      <div>${money(booking.total)}</div>
    </div>
    <div>
      <div class="label">Frequency</div>
      <div>${booking.frequency || "one-time"}</div>
    </div>
    <div>
      <div class="label">Deposit</div>
      <div>${money(depositAmount)}${depositStatusLabel}</div>
    </div>
    <div style="grid-column:1/-1;">
      <div class="label">Address</div>
      <div>${address}</div>
    </div>
  </div>

  <hr />

  <h2>Home & cleaning details</h2>
  <div class="grid">
    <div>
      <div class="label">Bedrooms / Bathrooms</div>
      <div>${bedrooms} bed · ${bathrooms} bath</div>
    </div>
    <div>
      <div class="label">Condition level</div>
      <div>${booking.conditionLevel || "Standard"}</div>
    </div>
    <div>
      <div class="label">Pets on site</div>
      <div>${booking.petsOnSite ? "Yes" : "No"}</div>
    </div>
    <div>
      <div class="label">Fragrance preference</div>
      <div>${booking.fragrancePreference || "No preference"}</div>
    </div>
    <div style="grid-column:1/-1;">
      <div class="label">Add-ons</div>
      <div>${addOns}</div>
    </div>
  </div>

  <hr />

  <h2>Notes</h2>
  <div class="notes">
    ${notes || "No notes added."}
  </div>

</div>

<script>
  window.onload = () => { window.print(); };
</script>

</body>
</html>
`;

  win.document.open();
  win.document.write(html);
  win.document.close();
}

/* -------------------------------------------------------------------------- */
/*                               POLICY CARD UI                                */
/* -------------------------------------------------------------------------- */

function CancellationPolicyCard({ cancellationWindowHours = 48 }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 shadow-sm mb-4">
      <p className="text-xs font-semibold text-amber-900 flex items-center gap-2">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white border border-amber-200 text-amber-700 text-[11px]">
          i
        </span>
        Cancellation policy
      </p>
      <p className="mt-1 text-xs text-amber-900/80">
        You can cancel or reschedule your appointment up to{" "}
        <span className="font-semibold">{cancellationWindowHours} hours</span>{" "}
        before the scheduled start time. After this window, your deposit is
        forfeited.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                MAIN COMPONENT                               */
/* -------------------------------------------------------------------------- */

export default function AppointmentsView({
  upcomingBookings = [],
  completedBookings = [],
  loadingUpcoming = false,
  loadingCompleted = false,
  isRepeatClient = false,
  onUpcomingAction,
  onViewPayments,
  onReviewBooking,
  depositAmount = 50,
  cancellationWindowHours = 48,
}) {
  const defaultTab =
    upcomingBookings?.length > 0 ? "upcoming" : "completed";

  // Wrap PDF generation so children don't need to know implementation
  const handleAction = (payload) => {
    if (!payload) return;

    if (payload.type === "download-pdf") {
      generateAppointmentPrintView(payload.booking);
      return;
    }

    onUpcomingAction?.(payload);
  };

  return (
    <section className="space-y-4">
      <CancellationPolicyCard cancellationWindowHours={cancellationWindowHours} />

      <Tabs defaultValue={defaultTab} className="w-full">
      <TabsList className="bg-plum border border-plum/20 rounded-full p-1 mb-4">
        <TabsTrigger
          value="upcoming"
          className="
            rounded-full text-xs sm:text-sm px-4 py-1.5
            text-white/90
            data-[state=active]:bg-[#FDE7F3]
            data-[state=active]:!text-plum
            data-[state=active]:font-semibold
            data-[state=active]:shadow
          "
        >
          Upcoming Appointments
        </TabsTrigger>

        <TabsTrigger
          value="completed"
          className="
            rounded-full text-xs sm:text-sm px-4 py-1.5
            text-white/90
            data-[state=active]:bg-[#FDE7F3]
            data-[state=active]:!text-plum
            data-[state=active]:font-semibold
            data-[state=active]:shadow
          "
        >
          Completed Appointments
        </TabsTrigger>
      </TabsList>

        <TabsContent value="upcoming">
          <UpcomingBookings
            bookings={upcomingBookings}
            loading={loadingUpcoming}
            onAction={handleAction}
            onViewPayments={onViewPayments}
            depositAmount={depositAmount}
            isRepeatClient={isRepeatClient}
          />
        </TabsContent>

        <TabsContent value="completed">
          <PastBookings
            bookings={completedBookings}
            loading={loadingCompleted}
            onAction={handleAction}
            onReview={onReviewBooking}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
}
