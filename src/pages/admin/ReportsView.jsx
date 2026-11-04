// src/pages/admin/ReportsView.jsx
import React from "react";
import { apiGet, qs } from "@/lib/api";
import { useApiQuery } from "@/hooks/useApiQuery";
import { normalizeBooking, dateKey as tzDateKey, formatMoney, statusLabel } from "@/lib/model";
import { csvDownload, money, rangePreset } from "./utils";

// Recharts
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
} from "recharts";

/* ---------- local helpers ---------- */

const STATUS_COLORS = {
  confirmed: "#22c55e",
  pending: "#eab308",
  declined: "#ef4444",
  completed: "#8b5cf6",
  cancelled: "#f97316",
  pending_payment: "#fbbf24",
  expired: "#cbd5e1",
  unknown: "#6b7280",
};

const FALLBACK_COLORS = [
  "#6366f1",
  "#ec4899",
  "#22c55e",
  "#eab308",
  "#06b6d4",
  "#f97316",
];

function getWhenDate(r) {
  // unified with BookingsView + CalendarView
  return r?.startAt?.toDate?.() ?? r?.scheduledAt?.toDate?.() ?? null;
}

function sortByWhen(arr) {
  return arr.slice().sort((a, b) => {
    const ad = getWhenDate(a)?.getTime?.() ?? 0;
    const bd = getWhenDate(b)?.getTime?.() ?? 0;
    return ad - bd;
  });
}

/* ---------- KPI card ---------- */

function Kpi({ label, value }) {
  return (
    <div className="rounded-xl border bg-white p-4">
      <div className="text-sm opacity-60">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}

/* ================================================================== */

export default function ReportsView() {
  const bookingsQ = useApiQuery(
    async () =>
      sortByWhen(
        (await apiGet(`/admin/bookings${qs({ all: 1 })}`)).bookings
          .map(normalizeBooking)
          .filter((b) => b.status !== "expired")
          .map((b) => ({ ...b, amount: b.totalPrice, rescheduled: (b.history || []).length > 0 }))
      ),
    []
  );
  const rows = React.useMemo(() => bookingsQ.data || [], [bookingsQ.data]);

  // Default to current month view
  const [range, setRange] = React.useState("month");

  // toggles
  const [includePending, setIncludePending] = React.useState(false);
  const [futureMode, setFutureMode] = React.useState(false);



  // ---- Date window (past / current / future) ----
  const windowBounds = React.useMemo(() => {
    // Special handling for month so we don't depend on utils for that
    if (range === "month") {
      const today = new Date();

      // "this month" when futureMode is off, "next month" when it's on
      if (!futureMode) {
        const from = new Date(today.getFullYear(), today.getMonth(), 1);
        const to = new Date(
          today.getFullYear(),
          today.getMonth() + 1,
          0,
          23,
          59,
          59,
          999
        );
        return { from, to };
      }

      // Next month
      const nextMonthIndex = today.getMonth() + 1;
      const yearOffset = Math.floor(nextMonthIndex / 12);
      const monthIndex = nextMonthIndex % 12;
      const year = today.getFullYear() + yearOffset;

      const from = new Date(year, monthIndex, 1);
      const to = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
      return { from, to };
    }

    // Other ranges use shared presets (7d, 30d, qtr, year)
    const base = rangePreset(range); // { from, to } for "past" window
    if (!base?.from || !base?.to) return { from: null, to: null };

    if (!futureMode) return base;

    // mirror the same window length but push into the future
    const span = base.to.getTime() - base.from.getTime();
    const from = new Date();
    const to = new Date(from.getTime() + span);
    return { from, to };
  }, [range, futureMode]);

  // Money actually collected in the window, from the payment ledger (not booking totals).
  const ledgerFrom = windowBounds.from ? tzDateKey(windowBounds.from) : null;
  const ledgerTo = windowBounds.to ? tzDateKey(windowBounds.to) : null;
  const ledgerQ = useApiQuery(() => apiGet(`/admin/reports${qs({ from: ledgerFrom, to: ledgerTo })}`), [ledgerFrom, ledgerTo], {
    enabled: !!ledgerFrom,
    poll: false,
  });

  // ---- Filtered view for current range ----
  const view = React.useMemo(() => {
    const { from, to } = windowBounds;
    if (!from || !to) return [];

    return rows.filter((r) => {
      const d = getWhenDate(r);
      return d && d >= from && d <= to;
    });
  }, [rows, windowBounds]);

  // ---- Analytics + chart data ----
  const analytics = React.useMemo(() => {
    if (!view.length) {
      return {
        revenue: 0,
        bookings: 0,
        confirmedCount: 0,
        pendingCount: 0,
        declinedCount: 0,
        cancelledCount: 0,
        rescheduledCount: 0,
        statusData: [],
        topServices: [],
        revenueByDay: [],
        revenueServices: [],
      };
    }

    const byStatus = new Map();
    const byServiceCount = new Map();

    let rescheduledCount = 0;

    // base stats: ALL bookings in range
    for (const r of view) {
      const st = String(r.status ?? "unknown").toLowerCase();
      byStatus.set(st, (byStatus.get(st) || 0) + 1);

      const svc = (r.serviceName ?? r.service ?? "Unknown service").toLowerCase();
      byServiceCount.set(svc, (byServiceCount.get(svc) || 0) + 1);

      // Rescheduling heuristic: we count bookings that clearly carry
      // a reschedule flag / history. If fields don't exist, this stays 0.
      const hasRescheduleFlag =
        !!r.rescheduledAt ||
        !!r.wasRescheduled ||
        !!r.originalBookingId ||
        (Array.isArray(r.rescheduleHistory) && r.rescheduleHistory.length > 0);

      if (hasRescheduleFlag) {
        rescheduledCount += 1;
      }
    }

    const bookings = view.length;
    const confirmedCount = byStatus.get("confirmed") || 0;
    const pendingCount = byStatus.get("pending") || 0;
    const declinedCount = byStatus.get("declined") || 0;
    const cancelledCount = byStatus.get("cancelled") || 0;

    const statusData = Array.from(byStatus.entries()).map(([name, count]) => ({
      name: statusLabel(name),
      key: name,
      value: count,
    }));

    const topServices = Array.from(byServiceCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    // ---- revenue & stacked-by-service chart (confirmed/completed +/- pending) ----
    const revenueEligible = view.filter((r) => {
      const st = String(r.status ?? "pending").toLowerCase();

      // Always count confirmed + completed as real revenue
      if (st === "confirmed" || st === "completed") return true;

      // Optionally include pending as projected revenue
      if (includePending && st === "pending") return true;

      return false;
    });

    let revenue = 0;

    // dateKey -> { date, label, services: Map<service, amount> }
    const byDayMap = new Map();
    const revenueByService = new Map();

    for (const r of revenueEligible) {
      const when = getWhenDate(r);
      if (!when) continue;

      const key = tzDateKey(when);
      const label = when.toLocaleDateString(undefined, {
        month: "short",
        day: "2-digit",
      });

      const amt = Number(r.amount ?? r.cost ?? 0) || 0;
      revenue += amt;

      const svcRaw = (r.serviceName ?? r.service ?? "Other").toLowerCase();
      const svcKey = svcRaw || "other";

      // total per service for "which colors get their own bar"
      revenueByService.set(svcKey, (revenueByService.get(svcKey) || 0) + amt);

      if (!byDayMap.has(key)) {
        byDayMap.set(key, {
          date: when,
          label,
          services: new Map(),
        });
      }
      const day = byDayMap.get(key);
      day.services.set(svcKey, (day.services.get(svcKey) || 0) + amt);
    }

    // which services get their own stack (top 4 by revenue)
    const topRevenueServices = Array.from(revenueByService.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([svc]) => svc);

    const revenueServices =
      topRevenueServices.length > 0 ? [...topRevenueServices, "other"] : [];

    // build final stacked-bar data
    const revenueByDay = Array.from(byDayMap.values())
      .sort((a, b) => a.date - b.date)
      .map((day) => {
        const row = {
          label: day.label,
        };
        for (const [svc, amt] of day.services.entries()) {
          const bucket = topRevenueServices.includes(svc) ? svc : "other";
          row[bucket] = (row[bucket] || 0) + amt;
        }
        return row;
      });

    return {
      revenue,
      bookings,
      confirmedCount,
      pendingCount,
      declinedCount,
      cancelledCount,
      rescheduledCount,
      statusData,
      topServices,
      revenueByDay,
      revenueServices,
    };
  }, [view, includePending]);

  const exportCsv = () => {
    if (!view.length) return;

    const header = [
      "date",
      "status",
      "service",
      "amount",
      "name",
      "email",
      "phone",
      "address",
      "id",
    ];

    const mapped = view.map((r) => {
      const d = getWhenDate(r);
      return {
        date: d ? d.toISOString() : "",
        status: r.status ?? "",
        service: r.serviceName ?? r.service ?? "",
        amount: String(r.amount ?? r.cost ?? 0),
        name: r.contact?.name ?? r.name ?? "",
        email: r.contact?.email ?? "",
        phone: r.contact?.phone ?? "",
        address: r.address?.line1 ?? "",
        id: r.id,
      };
    });

    csvDownload(`report_${range}.csv`, mapped, header);
  };

  const revenueSubtitle = includePending
    ? "Confirmed + pending bookings in this range."
    : "Confirmed bookings only.";

  // Dynamic labels so the dropdown reads right
  const labelForRange = (value) => {
    if (value === "month") return futureMode ? "Next month" : "This month";

    const prefix = futureMode ? "Next" : "Last";
    if (value === "7d") return `${prefix} 7 days`;
    if (value === "30d") return `${prefix} 30 days`;
    if (value === "qtr") return futureMode ? "Next quarter" : "This quarter";
    if (value === "year") return futureMode ? "Next year" : "This year";
    return value;
  };

  /* ---------------------------- render ---------------------------- */

  return (
    <section>
      {bookingsQ.error && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 p-3 text-sm" role="alert">
          {bookingsQ.error.message}
        </div>
      )}

      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <label className="text-sm text-plum font-medium">Range</label>
        <select
          value={range}
          onChange={(e) => setRange(e.target.value)}
          className="px-3 py-2 rounded-lg border bg-white text-sm"
        >
          <option value="month">{labelForRange("month")}</option>
          <option value="7d">{labelForRange("7d")}</option>
          <option value="30d">{labelForRange("30d")}</option>
          <option value="qtr">{labelForRange("qtr")}</option>
          <option value="year">{labelForRange("year")}</option>
        </select>

        <label className="flex items-center gap-1 text-xs text-plum/80">
          <input
            type="checkbox"
            checked={futureMode}
            onChange={(e) => setFutureMode(e.target.checked)}
          />
          Future bookings mode
        </label>

        <label className="flex items-center gap-1 text-xs text-plum/80">
          <input
            type="checkbox"
            checked={includePending}
            onChange={(e) => setIncludePending(e.target.checked)}
          />
          Include pending in revenue
        </label>

        <button
          onClick={exportCsv}
          className="ml-auto rounded-full bg-[#E2A82B] text-[#431039] px-4 py-2 text-xs font-medium hover:bg-[#F0BA3E] transition-colors"
        >
          Download CSV
        </button>
      </div>

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <Kpi label="Revenue" value={money(analytics.revenue)} />
        <Kpi label="Bookings" value={String(analytics.bookings)} />
        <Kpi label="Confirmed" value={String(analytics.confirmedCount)} />
        <Kpi label="Pending" value={String(analytics.pendingCount)} />
        <Kpi label="Cancelled" value={String(analytics.cancelledCount)} />
        <Kpi label="Declined" value={String(analytics.declinedCount)} />
        <Kpi label="Collected (ledger)" value={ledgerQ.data ? formatMoney(ledgerQ.data.net) : "—"} />
      </div>

      {/* Charts */}
      <div className="grid gap-6 md:grid-cols-2 mb-6">
        {/* Revenue over time stacked bar */}
        <div className="rounded-xl border bg-white p-4 flex flex-col">
          <div className="flex items-baseline justify-between mb-2">
            <h4 className="font-semibold text-plum">Revenue over time</h4>
            <span className="text-[11px] text-plum/60">
              Confirmed bookings only by default
            </span>
          </div>
          <p className="text-xs text-plum/60 mb-3">{revenueSubtitle}</p>

          {analytics.revenueByDay.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-sm text-plum/60">
              No revenue data in this range.
            </div>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={analytics.revenueByDay}>
                  <XAxis dataKey="label" fontSize={11} />
                  <YAxis fontSize={11} tickFormatter={(v) => `$${v}`} />
                  <RechartsTooltip
                    formatter={(val) => money(val)}
                    labelFormatter={(l) => `Date: ${l}`}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {analytics.revenueServices.map((svc, idx) => (
                    <Bar
                      key={svc}
                      dataKey={svc}
                      stackId="rev"
                      name={svc === "other" ? "Other services" : svc}
                      fill={FALLBACK_COLORS[idx % FALLBACK_COLORS.length]}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Status breakdown donut */}
        <div className="rounded-xl border bg-white p-4 flex flex-col">
          <div className="flex items-baseline justify-between mb-2">
            <h4 className="font-semibold text-plum">Status breakdown</h4>
            <span className="text-[11px] text-plum/60">
              All bookings in selected range
            </span>
          </div>
          <p className="text-xs text-plum/60 mb-3">
            Quick view of how many bookings are pending, confirmed, completed,
            declined, cancelled, etc.
          </p>

          {analytics.statusData.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-sm text-plum/60">
              No data for this range.
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="w-40 h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={analytics.statusData}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={45}
                      outerRadius={70}
                      paddingAngle={3}
                    >
                      {analytics.statusData.map((entry, index) => {
                        const key = entry.key;
                        const color =
                          STATUS_COLORS[key] ||
                          FALLBACK_COLORS[index % FALLBACK_COLORS.length];
                        return <Cell key={key} fill={color} />;
                      })}
                    </Pie>
                    <RechartsTooltip
                      formatter={(val, name) => [`${val}`, String(name)]}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              <ul className="ml-4 space-y-1 text-xs">
                {analytics.statusData.map((s, idx) => {
                  const color =
                    STATUS_COLORS[s.key] ||
                    FALLBACK_COLORS[idx % FALLBACK_COLORS.length];
                  return (
                    <li key={s.name} className="flex items-center gap-2">
                      <span
                        className="inline-block w-3 h-3 rounded-full"
                        style={{ backgroundColor: color }}
                      />
                      <span className="capitalize">{s.name}</span>
                      <span className="ml-1 text-[11px] text-plum/60">
                        ({s.value})
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Top services list */}
      <div className="rounded-xl border bg-white p-4">
        <div className="flex items-baseline justify-between mb-2">
          <h4 className="font-semibold text-plum">Top services</h4>
          <span className="text-[11px] text-plum/60">
            Based on bookings in the selected range
          </span>
        </div>
        <p className="text-xs text-plum/60 mb-3">
          Helps you see which services are requested most often.
        </p>

        {analytics.topServices.length === 0 ? (
          <div className="py-6 text-sm text-plum/60 text-center">
            No services to show yet.
          </div>
        ) : (
          <ul className="space-y-2 text-sm">
            {analytics.topServices.map(([svc, n], idx) => (
              <li
                key={svc}
                className="flex items-center justify-between border-b last:border-b-0 border-plum/5 pb-1"
              >
                <span className="flex items-center gap-1">
                  {idx === 0 && (
                    <span
                      className="text-[#E2A82B]"
                      title="Most booked service this period"
                    >
                      ★
                    </span>
                  )}
                  <span className="capitalize">{svc}</span>
                </span>
                <span className="font-semibold text-plum">{n}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
