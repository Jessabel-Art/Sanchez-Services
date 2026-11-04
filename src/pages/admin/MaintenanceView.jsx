// src/pages/admin/MaintenanceView.jsx — system status: scheduled jobs, email delivery, bookings needing attention.
// Replaces the old browser-side "repair" tools: data consistency is now enforced by the server.
import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { AlertTriangle, Mail, Timer, CreditCard } from "lucide-react";
import BookingDetailModal from "./components/BookingDetailModal";
import { apiGet, apiPost } from "@/lib/api";
import { useApiQuery } from "@/hooks/useApiQuery";
import { fmtDateTime } from "@/lib/model";

const JOB_LABELS = {
  "expire-holds": "Release unpaid booking holds",
  "reconcile-payments": "Reconcile Stripe payments",
  reminders: "Send appointment reminders",
  "auto-complete": "Mark finished appointments completed",
  "send-email": "Send queued email",
  purge: "Purge expired sessions & tokens",
};

export default function MaintenanceView() {
  const { toast } = useToast();
  const [busy, setBusy] = useState(null);
  const [openId, setOpenId] = useState(null);
  const q = useApiQuery(() => apiGet("/admin/system"), []);
  const s = q.data;

  const runJob = async (job) => {
    setBusy(job);
    try {
      const { result } = await apiPost(`/admin/system/jobs/${job}`, {});
      toast({ title: JOB_LABELS[job] || job, description: result?.skipped ? "Already running" : JSON.stringify(result?.result ?? result) });
      await q.refresh();
    } catch (e) {
      toast({ title: "Job failed", description: e.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const retry = async (id) => {
    setBusy(`email-${id}`);
    try {
      q.setData(await apiPost(`/admin/system/email/${id}/retry`, {}));
      toast({ title: "Email queued for retry" });
    } catch (e) {
      toast({ title: "Could not retry", description: e.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const jobs = Object.keys(JOB_LABELS).map((job) => ({ job, ...(s?.jobs || []).find((j) => j.job === job) }));

  return (
    <section className="space-y-5">
      <div>
        <p className="text-xs uppercase tracking-[0.14em] text-plum/60 font-semibold">Admin</p>
        <h1 className="text-2xl md:text-3xl font-bold text-plum">System status</h1>
        <p className="text-xs md:text-sm text-plum/70">Background jobs, email delivery and anything that needs a person to look at it.</p>
      </div>
      {q.error && <p className="text-sm text-rose-700" role="alert">{q.error.message}</p>}

      <Card className="border-[#F1D8E8] rounded-2xl">
        <CardHeader>
          <CardTitle className="text-base text-[#431039] flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" aria-hidden="true" /> Bookings needing attention
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!s ? (
            <p className="text-xs text-plum/60">Loading…</p>
          ) : s.attention.length === 0 ? (
            <p className="text-sm text-plum/70">Nothing needs attention.</p>
          ) : (
            <ul className="divide-y divide-[#F1D8E8] text-sm">
              {s.attention.map((b) => (
                <li key={b.id} className="py-2 flex items-center justify-between gap-3">
                  <span>
                    <strong>{b.contact?.name}</strong> · #{b.invoiceNumber} · {fmtDateTime(b.startAt)}
                    <span className="block text-xs text-amber-900">{b.needsAttention}</span>
                  </span>
                  <Button size="sm" variant="outline" onClick={() => setOpenId(b.id)}>
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="border-[#F1D8E8] rounded-2xl">
          <CardHeader>
            <CardTitle className="text-base text-[#431039] flex items-center gap-2">
              <Timer className="w-4 h-4 text-gold" aria-hidden="true" /> Scheduled jobs
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-[#F1D8E8] text-sm">
              {jobs.map((j) => (
                <li key={j.job} className="py-2 flex items-center justify-between gap-3">
                  <span>
                    {JOB_LABELS[j.job]}
                    <span className={`block text-xs ${j.status === "error" ? "text-rose-700" : "text-plum/60"}`}>
                      {j.lastFinishedAt ? `Last run ${fmtDateTime(j.lastFinishedAt)} · ${j.status}` : "Never run"}
                      {j.status === "error" && j.result?.error ? ` · ${j.result.error}` : ""}
                    </span>
                  </span>
                  <Button size="sm" variant="outline" disabled={busy === j.job} onClick={() => runJob(j.job)}>
                    {busy === j.job ? "Running…" : "Run now"}
                  </Button>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-plum/60">Jobs run automatically from the server cron every 5 minutes.</p>
          </CardContent>
        </Card>

        <Card className="border-[#F1D8E8] rounded-2xl">
          <CardHeader>
            <CardTitle className="text-base text-[#431039] flex items-center gap-2">
              <Mail className="w-4 h-4 text-gold" aria-hidden="true" /> Email delivery
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            <p>
              Sent in the last 7 days: <strong>{s?.email?.sentLast7Days ?? "—"}</strong> · Queued: <strong>{s?.email?.queued ?? "—"}</strong>
            </p>
            {s?.email?.failed?.length ? (
              <ul className="divide-y divide-[#F1D8E8]">
                {s.email.failed.map((e) => (
                  <li key={e.id} className="py-2 flex items-center justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate">{e.subject}</span>
                      <span className="block text-xs text-plum/60 truncate">
                        To {e.to} · {fmtDateTime(e.createdAt)} · {e.attempts} attempt(s)
                      </span>
                      {e.error && <span className="block text-xs text-rose-700 truncate">{e.error}</span>}
                    </span>
                    <Button size="sm" variant="outline" disabled={busy === `email-${e.id}`} onClick={() => retry(e.id)}>
                      Retry
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-plum/70">No failed emails.</p>
            )}
            <p className="flex items-center gap-2 pt-2 border-t border-[#F1D8E8]">
              <CreditCard className="w-4 h-4 text-plum/60" aria-hidden="true" />
              Stripe: {s ? (s.stripe.configured ? "configured" : "not configured") : "—"}
              {s?.stripe?.failedEvents ? <span className="text-rose-700"> · {s.stripe.failedEvents} webhook event(s) failed</span> : null}
            </p>
          </CardContent>
        </Card>
      </div>
      <BookingDetailModal bookingId={openId} onClose={() => setOpenId(null)} />
    </section>
  );
}
