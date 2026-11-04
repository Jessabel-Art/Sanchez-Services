// src/pages/admin/ReviewsView.jsx
import React from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useApiQuery } from "@/hooks/useApiQuery";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import EmptyState from "./components/EmptyState";
import { Star } from "lucide-react";
import { useAdminAuth } from "./hooks/useAdminAuth";

function formatDate(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d) return "";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function Stars({ rating }) {
  const r = Number(rating || 0);
  if (!r) return null;
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className={`w-3 h-3 ${
            i < r ? "fill-yellow-400 text-yellow-400" : "text-gray-300"
          }`}
        />
      ))}
    </span>
  );
}

export default function ReviewsView() {
  const { toast } = useToast();
  const { user, isAdmin, authReady } = useAdminAuth();

  const q = useApiQuery(async () => (await apiGet("/admin/reviews")).reviews, [], { enabled: authReady && isAdmin });
  const all = q.data || [];
  const pending = all.filter((r) => r.status === "pending").sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const approved = all.filter((r) => r.status === "approved").sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));

  const moderate = async (r, action) => {
    try {
      await apiPost(`/admin/reviews/${r.id}/${action}`, {});
      toast({
        title: action === "approve" ? "Review approved" : "Review declined",
        description: action === "approve" ? `${r.displayName || "Client"}'s review is now live.` : `${r.displayName || "Client"}'s review was declined.`,
      });
    } catch (err) {
      toast({ title: "Could not update review", description: err?.message || String(err), variant: "destructive" });
    }
  };
  const approve = (r) => moderate(r, "approve");
  const decline = (r) => moderate(r, "decline");


  const renderPendingList = () => {
    if (pending.length === 0) {
      return (
        <EmptyState
          icon={Star}
          title="No pending reviews"
          description="When clients leave reviews, they’ll appear here for approval."
        />
      );
    }

    return (
      <ul className="space-y-3">
        {pending.map((r) => {
          const service =
            r.serviceName || r.service || r.bookingService || "Cleaning service";
          return (
            <li
              key={r.id}
              className="rounded-2xl border border-plum/10 bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <div className="font-medium text-plum">
                      {r.displayName || r.name || "Anonymous"}
                    </div>
                    {r.rating ? <Stars rating={r.rating} /> : null}
                    {r.displayMode && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-plum/10 text-plum/70">
                        {r.displayMode}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-plum/60">
                    Client: {r.clientName || "unknown"} · booking {r.bookingId || "—"}
                    {service ? ` • ${service}` : ""}
                  </div>
                </div>

                <div className="flex flex-col items-end gap-1">
                  <span className="text-xs text-plum/60">
                    {formatDate(r.createdAt)}
                  </span>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      className="bg-green-600 text-white rounded-full px-3 py-1 text-xs"
                      onClick={() => approve(r)}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="rounded-full px-3 py-1 text-xs"
                      onClick={() => decline(r)}
                    >
                      Decline
                    </Button>
                  </div>
                </div>
              </div>

              {(r.comment || r.body) && (
                <p className="text-sm text-plum/80 mt-3 whitespace-pre-wrap">
                  {r.comment || r.body}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    );
  };

  const renderApprovedList = () => {
    if (approved.length === 0) {
      return (
        <EmptyState
          icon={Star}
          title="No published reviews yet"
          description="Once you approve reviews, the most recent ones will appear here."
        />
      );
    }

    return (
      <ul className="space-y-3">
        {approved.slice(0, 10).map((r) => {
          const service =
            r.serviceName || r.service || r.bookingService || "Cleaning service";
          return (
            <li
              key={r.id}
              className="rounded-2xl border border-plum/10 bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <div className="font-medium text-plum">
                      {r.displayName || r.name || "Anonymous"}
                    </div>
                    {r.rating ? <Stars rating={r.rating} /> : null}
                    <span className="inline-flex items-center rounded-full bg-[#FDF2FF] px-2 py-0.5 text-[10px] font-medium text-plum border border-plum/10">
                      Published
                    </span>
                  </div>
                  <div className="text-xs text-plum/60">
                    {service}
                    {r.city ? ` • ${r.city}` : ""}
                  </div>
                </div>

                <span className="text-xs text-plum/60">
                  {formatDate(r.publishedAt || r.createdAt)}
                </span>
              </div>

              {(r.comment || r.body) && (
                <p className="text-sm text-plum/80 mt-2 whitespace-pre-wrap">
                  {r.comment || r.body}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <section className="space-y-8">
      <div>
        <h3 className="text-lg font-semibold text-plum mb-3">
          Pending reviews ({pending.length})
        </h3>
        {renderPendingList()}
      </div>

      <div>
        <h3 className="text-lg font-semibold text-plum mb-3">
          Recent approved
        </h3>
        {renderApprovedList()}
      </div>
    </section>
  );
}
