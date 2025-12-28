// src/pages/admin/DashboardHome.jsx
import React from "react";
import { db } from "@/lib/firebase";
import {
  collection,
  onSnapshot,
  query,
  where,
  orderBy,
  Timestamp,
  limit,
} from "firebase/firestore";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useToast } from "@/components/ui/use-toast";
import { useAdminAuth } from "./hooks/useAdminAuth";
import { money } from "./utils";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  PieChart,
  Pie,
  Cell,
} from "recharts";

// Simple color set re-using brand vibes
const COLORS = ["#6366f1", "#ec4899", "#22c55e", "#eab308", "#06b6d4", "#f97316"];

const STATUS_COLORS = {
  pending: "#eab308",
  confirmed: "#22c55e",
  completed: "#8b5cf6",
  cancelled: "#f97316",
  declined: "#ef4444",
};

function getWhenDate(b) {
  return (
    b?.scheduledAt?.toDate?.() ??
    b?.startAt?.toDate?.() ??
    null
  );
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export default function DashboardHome({ onChangeView }) {
  const { toast } = useToast();
  const { isAdmin, authReady } = useAdminAuth();
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [pendingApprovalsCount, setPendingApprovalsCount] = React.useState(0);

  // ---- Firestore subscription: this month + next 7 days (auth-gated) ----
  React.useEffect(() => {
    // Only subscribe when auth is ready and user is confirmed admin
    if (!authReady || !isAdmin) {
      setLoading(false);
      return;
    }

    const today = new Date();
    const from = new Date(today.getFullYear(), today.getMonth(), 1); // start of month
    const to = new Date(today.getFullYear(), today.getMonth() + 1, 7); // a week into next month

    const qRef = query(
      collection(db, "bookings"),
      where("scheduledAt", ">=", Timestamp.fromDate(from)),
      where("scheduledAt", "<=", Timestamp.fromDate(to)),
      orderBy("scheduledAt", "asc")
    );

    const unsub = onSnapshot(
      qRef,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setRows(list);
        setLoading(false);
      },
      (err) => {
        console.error("dashboard bookings error", err);
        toast({
          title: "Could not load dashboard data",
          description: String(err?.message || err),
          variant: "destructive",
        });
        setLoading(false);
      }
    );

    return () => unsub();
  }, [authReady, isAdmin, toast]);

  // ---- Pending approvals: all future pending bookings (status == pending, startAt >= now) ----
  React.useEffect(() => {
    if (!authReady || !isAdmin) return;

    const now = new Date();
    const qRef = query(
      collection(db, "bookings"),
      where("status", "==", "pending"),
      where("startAt", ">=", Timestamp.fromDate(now)),
      orderBy("startAt", "asc"),
      limit(200)
    );

    const unsub = onSnapshot(
      qRef,
      (snap) => {
        setPendingApprovalsCount(snap.size);
        if (process.env.NODE_ENV !== "production") {
          console.log("[dashboard pending] pending count", snap.size);
        }
      },
      (err) => {
        console.error("dashboard pending error", err);
      }
    );

    return () => unsub();
  }, [authReady, isAdmin]);

  // ---- Analytics / derived views ----
  const analytics = React.useMemo(() => {
    if (!rows.length) {
      return {
        todayRevenue: 0,
        next7Revenue: 0,
        monthRevenue: 0,
        avgTicket: 0,
        todaySeries: [],
        next7Series: [],
        monthSeries: [],
        statusBreakdown: [],
        serviceMix: [],
        todayJobs: [],
        pipeline: {
          pending: 0,
          confirmed: 0,
          completed: 0,
          upcomingFromToday: 0,
        },
      };
    }

    const today = new Date();
    const todayStart = startOfDay(today);
    const todayEnd = endOfDay(today);

    const sevenDaysAhead = new Date(today);
    sevenDaysAhead.setDate(today.getDate() + 7);
    const sevenEnd = endOfDay(sevenDaysAhead);

    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);

    let todayRevenue = 0;
    let next7Revenue = 0;
    let monthRevenue = 0;

    const statusCounts = new Map();
    const serviceCounts = new Map();

    const todayJobs = [];

    // For charts
    const dayBucketsMonth = new Map(); // yyyy-mm-dd -> { label, revenue }
    const dayBucketsNext7 = new Map();
    const dayBucketsToday = new Map();

    // For avg ticket this month
    let monthBookingsCount = 0;

    const isRevenueStatus = (st) => {
      const s = String(st || "").toLowerCase();
      return s === "confirmed" || s === "completed";
    };

    for (const b of rows) {
      const when = getWhenDate(b);
      if (!when) continue;

      const status = String(b.status || "unknown").toLowerCase();
      const amt = Number(b.amount ?? b.cost ?? 0) || 0;

      // pipeline counts (today forward)
      if (when >= todayStart) {
        if (status === "pending") statusCounts.set("pending", (statusCounts.get("pending") || 0) + 1);
        if (status === "confirmed") statusCounts.set("confirmed", (statusCounts.get("confirmed") || 0) + 1);
        if (status === "completed") statusCounts.set("completed", (statusCounts.get("completed") || 0) + 1);
        if (status === "cancelled" || status === "cancelled")
          statusCounts.set("cancelled", (statusCounts.get("cancelled") || 0) + 1);
        if (status === "declined")
          statusCounts.set("declined", (statusCounts.get("declined") || 0) + 1);
      }

      const dateKey = when.toISOString().slice(0, 10);
      const label = when.toLocaleDateString(undefined, {
        month: "short",
        day: "2-digit",
      });

      // today metrics + jobs
      if (when >= todayStart && when <= todayEnd) {
        if (isRevenueStatus(status)) {
          todayRevenue += amt;
        }

        const bucketToday = dayBucketsToday.get(dateKey) || { label, value: 0 };
        bucketToday.value += amt;
        dayBucketsToday.set(dateKey, bucketToday);

        // jobs list (regardless of revenue status)
        todayJobs.push(b);
      }

      // next 7 days revenue (starting tomorrow)
      if (when > todayEnd && when <= sevenEnd && isRevenueStatus(status)) {
        next7Revenue += amt;

        const bucket = dayBucketsNext7.get(dateKey) || { label, value: 0 };
        bucket.value += amt;
        dayBucketsNext7.set(dateKey, bucket);
      }

      // this month totals + service mix
      if (when >= monthStart && when <= monthEnd) {
        if (isRevenueStatus(status)) {
          monthRevenue += amt;
          monthBookingsCount += 1;

          const bucketMonth = dayBucketsMonth.get(dateKey) || { label, value: 0 };
          bucketMonth.value += amt;
          dayBucketsMonth.set(dateKey, bucketMonth);
        }

        const svc =
          (b.serviceName || b.service || "Other").toString().toLowerCase();
        serviceCounts.set(svc, (serviceCounts.get(svc) || 0) + 1);
      }
    }

    // derived chart arrays
    const todaySeries = Array.from(dayBucketsToday.values()).sort(
      (a, b) => a.label.localeCompare(b.label)
    );
    const next7Series = Array.from(dayBucketsNext7.values()).sort(
      (a, b) => a.label.localeCompare(b.label)
    );
    const monthSeries = Array.from(dayBucketsMonth.values()).sort(
      (a, b) => a.label.localeCompare(b.label)
    );

    const statusBreakdown = Array.from(statusCounts.entries()).map(
      ([name, value]) => ({
        name,
        value,
      })
    );

    const serviceMix = Array.from(serviceCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const pipeline = {
      pending: statusCounts.get("pending") || 0,
      confirmed: statusCounts.get("confirmed") || 0,
      completed: statusCounts.get("completed") || 0,
      upcomingFromToday:
        (statusCounts.get("pending") || 0) +
        (statusCounts.get("confirmed") || 0),
    };

    const avgTicket = monthBookingsCount
      ? monthRevenue / monthBookingsCount
      : 0;

    // sort today jobs by time
    todayJobs.sort((a, b) => {
      const ad = getWhenDate(a)?.getTime() ?? 0;
      const bd = getWhenDate(b)?.getTime() ?? 0;
      return ad - bd;
    });

    return {
      todayRevenue,
      next7Revenue,
      monthRevenue,
      avgTicket,
      todaySeries,
      next7Series,
      monthSeries,
      statusBreakdown,
      serviceMix,
      todayJobs,
      pipeline,
    };
  }, [rows]);

  const {
    todayRevenue,
    next7Revenue,
    monthRevenue,
    avgTicket,
    todaySeries,
    next7Series,
    monthSeries,
    statusBreakdown,
    serviceMix,
    todayJobs,
    pipeline,
  } = analytics;

  const goToBookings = () => onChangeView && onChangeView("bookings");
  const goToCalendar = () => onChangeView && onChangeView("calendar");
  const goToReports = () => onChangeView && onChangeView("reports");

  return (
    <section className="space-y-6">
      {/* Quick actions */}
      <div className="flex flex-wrap items-center gap-3 mb-1">
        <Button
          className="rounded-full bg-plum text-white text-xs sm:text-sm"
          onClick={goToBookings}
        >
          Bookings
        </Button>
        <Button
          variant="outline"
          className="rounded-full text-xs sm:text-sm"
          onClick={goToCalendar}
        >
          Open calendar
        </Button>
        <Button
          variant="outline"
          className="rounded-full text-xs sm:text-sm"
          onClick={goToReports}
        >
          View detailed reports
        </Button>
      </div>

      {/* At a glance header */}
      <div>
        <h2 className="text-xl font-semibold text-[#431039] mb-1">
          At a glance
        </h2>
        <p className="text-sm text-[#431039]/70">
          Today&apos;s revenue, upcoming work, and booking pipeline in one view.
        </p>
      </div>

      {/* KPI row with mini charts */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {/* Today */}
        <Card className="rounded-2xl border-[#F1D8E8] bg-[#FFF7FB]">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-[#431039]/70 flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[#F97316]" />
              Today&apos;s revenue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-[#431039] mb-1">
              {money(todayRevenue)}
            </div>
            <p className="text-[11px] text-[#431039]/60 mb-2">
              Confirmed + completed scheduled for today.
            </p>
            <div className="h-16">
              {todaySeries.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={todaySeries}>
                    <XAxis dataKey="label" hide />
                    <YAxis hide />
                    <RechartsTooltip
                      formatter={(v) => money(v)}
                      labelFormatter={(l) => `Date: ${l}`}
                    />
                    <Bar dataKey="value" fill={COLORS[0]} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="text-[11px] text-[#431039]/40 flex items-center h-full">
                  No bookings today yet.
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Next 7 days */}
        <Card className="rounded-2xl border-[#D7EAFE] bg-[#F8FBFF]">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-[#1E293B]/80 flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[#0EA5E9]" />
              Next 7 days
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-[#0F172A] mb-1">
              {money(next7Revenue)}
            </div>
            <p className="text-[11px] text-[#1E293B]/60 mb-2">
              Revenue scheduled in the next week.
            </p>
            <div className="h-16">
              {next7Series.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={next7Series}>
                    <XAxis dataKey="label" hide />
                    <YAxis hide />
                    <RechartsTooltip
                      formatter={(v) => money(v)}
                      labelFormatter={(l) => `Date: ${l}`}
                    />
                    <Line
                      type="monotone"
                      dataKey="value"
                      stroke={COLORS[2]}
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="text-[11px] text-[#1E293B]/40 flex items-center h-full">
                  No upcoming revenue in the next week yet.
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* This month */}
        <Card className="rounded-2xl border-[#CDEFD6] bg-[#F4FFF7]">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-[#064E3B]/80 flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[#22C55E]" />
              This month
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-[#064E3B] mb-1">
              {money(monthRevenue)}
            </div>
            <p className="text-[11px] text-[#065F46]/60 mb-2">
              Booked in the current calendar month.
            </p>
            <div className="h-16">
              {monthSeries.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthSeries}>
                    <XAxis dataKey="label" hide />
                    <YAxis hide />
                    <RechartsTooltip
                      formatter={(v) => money(v)}
                      labelFormatter={(l) => `Date: ${l}`}
                    />
                    <Bar
                      dataKey="value"
                      fill={COLORS[3]}
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="text-[11px] text-[#047857]/40 flex items-center h-full">
                  No revenue recorded yet this month.
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Avg ticket */}
        <Card className="rounded-2xl border-[#F9E3C7] bg-[#FFF9F2]">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-[#78350F]/80 flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[#F97316]" />
              Avg. ticket
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-[#78350F] mb-1">
              {money(avgTicket)}
            </div>
            <p className="text-[11px] text-[#92400E]/60 mb-2">
              Average per booking this month.
            </p>
            <div className="h-16 flex items-center text-[11px] text-[#92400E]/40">
              Based on confirmed + completed bookings in the current month.
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Pipeline status row (clickable cards) */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card
          className="rounded-2xl border-[#F9E3C7] bg-[#FFF7E6] cursor-pointer hover:shadow-md transition"
          onClick={goToBookings}
        >
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2 text-sm text-[#92400E]">
                <span className="w-2 h-2 rounded-full bg-[#FACC15]" />
                Pending approvals
              </div>
              {pendingApprovalsCount > 0 && (
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[#F97316] text-white text-[10px]">
                  !
                </span>
              )}
            </div>
            <div className="text-2xl font-semibold text-[#92400E]">
              {pendingApprovalsCount}
            </div>
            <p className="text-[11px] text-[#92400E]/60 mt-1">
              Requests waiting on your decision.
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-[#CDEFD6] bg-[#F4FFF7]">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-sm text-[#065F46] mb-1">
              <span className="w-2 h-2 rounded-full bg-[#22C55E]" />
              Confirmed
            </div>
            <div className="text-2xl font-semibold text-[#065F46]">
              {pipeline.confirmed}
            </div>
            <p className="text-[11px] text-[#065F46]/60 mt-1">
              Booked and ready to go.
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-[#D8E3FF] bg-[#F5F7FF]">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-sm text-[#1E3A8A] mb-1">
              <span className="w-2 h-2 rounded-full bg-[#6366F1]" />
              Completed
            </div>
            <div className="text-2xl font-semibold text-[#1E3A8A]">
              {pipeline.completed}
            </div>
            <p className="text-[11px] text-[#1D4ED8]/60 mt-1">
              Finished jobs in this range.
            </p>
          </CardContent>
        </Card>

        <Card
          className="rounded-2xl border-[#F1D8E8] bg-[#FFF7FB] cursor-pointer hover:shadow-md transition"
          onClick={goToCalendar}
        >
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-sm text-[#431039] mb-1">
              <span className="w-2 h-2 rounded-full bg-[#EC4899]" />
              Upcoming jobs
            </div>
            <div className="text-2xl font-semibold text-[#431039]">
              {pipeline.upcomingFromToday}
            </div>
            <p className="text-[11px] text-[#431039]/60 mt-1">
              Pending + confirmed from today forward.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Lower section: charts + today list */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr),minmax(0,1.4fr)]">
        {/* Left column: status + service mix */}
        <div className="space-y-4">
          {/* Status breakdown donut */}
          <Card className="rounded-2xl border-[#F1D8E8] bg-white">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-[#431039]">
                Status breakdown
              </CardTitle>
              <p className="text-[11px] text-[#431039]/60">
                Quick view of how many bookings are pending, confirmed,
                completed, etc.
              </p>
            </CardHeader>
            <CardContent className="flex items-center gap-4">
              {statusBreakdown.length === 0 ? (
                <div className="text-sm text-[#431039]/60">
                  No bookings in the loaded range yet.
                </div>
              ) : (
                <>
                  <div className="w-40 h-40">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={statusBreakdown}
                          dataKey="value"
                          nameKey="name"
                          innerRadius={45}
                          outerRadius={70}
                          paddingAngle={3}
                        >
                          {statusBreakdown.map((entry, index) => {
                            const key = entry.name;
                            const color =
                              STATUS_COLORS[key] ||
                              COLORS[index % COLORS.length];
                            return <Cell key={key} fill={color} />;
                          })}
                        </Pie>
                        <RechartsTooltip
                          formatter={(val, name) => [`${val}`, String(name)]}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="space-y-1 text-xs">
                    {statusBreakdown.map((s, idx) => {
                      const color =
                        STATUS_COLORS[s.name] ||
                        COLORS[idx % COLORS.length];
                      return (
                        <li
                          key={s.name}
                          className="flex items-center gap-2 text-[#431039]"
                        >
                          <span
                            className="inline-block w-3 h-3 rounded-full"
                            style={{ backgroundColor: color }}
                          />
                          <span className="capitalize">{s.name}</span>
                          <span className="ml-1 text-[11px] text-[#431039]/60">
                            ({s.value})
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>

          {/* Service mix bar chart */}
          <Card className="rounded-2xl border-[#F1D8E8] bg-white">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-[#431039]">
                Top services this month
              </CardTitle>
              <p className="text-[11px] text-[#431039]/60">
                Based on confirmed + completed bookings in the current month.
              </p>
            </CardHeader>
            <CardContent className="h-56">
              {serviceMix.length === 0 ? (
                <div className="text-sm text-[#431039]/60 flex items-center h-full">
                  No services to show yet.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={serviceMix}
                    layout="vertical"
                    margin={{ left: 60 }}
                  >
                    <XAxis type="number" hide />
                    <YAxis
                      dataKey="name"
                      type="category"
                      tickFormatter={(v) =>
                        v
                          .split(" ")
                          .map(
                            (w) => w.charAt(0).toUpperCase() + w.slice(1)
                          )
                          .join(" ")
                      }
                      fontSize={11}
                    />
                    <RechartsTooltip />
                    <Bar
                      dataKey="count"
                      radius={[0, 4, 4, 0]}
                      fill={COLORS[0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right column: today's schedule */}
        <div>
          <Card className="rounded-2xl border-[#F1D8E8] bg-white h-full">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-[#431039]">
                Today&apos;s jobs
              </CardTitle>
              <p className="text-[11px] text-[#431039]/60">
                Jobs scheduled for today. Open the calendar for more detail.
              </p>
            </CardHeader>
            <CardContent>
              {todayJobs.length === 0 ? (
                <div className="text-sm text-[#431039]/60">
                  No jobs scheduled today yet.
                </div>
              ) : (
                <ul className="space-y-2 text-sm">
                  {todayJobs.map((b) => {
                    const when = getWhenDate(b);
                    const timeLabel = when
                      ? when.toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "—";
                    const svc =
                      b.serviceName || b.service || "Cleaning service";
                    const name =
                      b.contact?.name || b.name || "Client";

                    const st = String(b.status || "").toLowerCase();
                    const color =
                      STATUS_COLORS[st] || "#6B7280";

                    return (
                      <li
                        key={b.id}
                        className="flex items-center justify-between gap-3 border-b border-[#F1D8E8]/60 last:border-b-0 pb-2"
                      >
                        <div className="flex flex-col">
                          <span className="text-xs text-[#6B7280]">
                            {timeLabel}
                          </span>
                          <span className="font-medium text-[#431039]">
                            {name}
                          </span>
                          <span className="text-xs text-[#6B7280]">
                            {svc}
                          </span>
                        </div>
                        <span
                          className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] capitalize"
                          style={{
                            backgroundColor: `${color}1A`,
                            color,
                          }}
                        >
                          {st || "unknown"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="mt-4">
                <Button
                  variant="outline"
                  className="rounded-full text-xs"
                  onClick={goToCalendar}
                >
                  Open full calendar
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {loading && (
        <div className="text-[11px] text-[#431039]/50">
          Loading live dashboard data…
        </div>
      )}
    </section>
  );
}
