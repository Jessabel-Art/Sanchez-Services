// src/pages/admin/ClientsView.jsx
import React, { useState, useMemo } from "react";
import { formatPhoneForDisplay } from "@/lib/contactModel";
import { apiGet } from "@/lib/api";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useAdminAuth } from "./hooks/useAdminAuth";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import ClientDetailsModal from "./components/ClientDetailsModal";
import { ChevronUp, ChevronDown } from "lucide-react";
import { useNavigate } from "react-router-dom";

const money = (n) =>
  Number(n || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });

/**
 * Try to get a reasonable display name:
 * - profile.name (preferred)
 * - profile.fullName (legacy fallback)
 * - email local-part ("jessieleonne")
 * - fallback "Unnamed client"
 */
function getDisplayName(profile) {
  // Prefer canonical `name`, fall back to legacy `fullName`, then email local-part.
  const candidate =
    (profile.name && profile.name.trim()) ||
    (profile.email && String(profile.email).split("@")[0]) ||
    "";

  if (candidate) return String(candidate).trim();
  return "Unnamed client";
}

function getPhone(profile) {
  return (
    profile?.phone ||
    profile?.phoneNormalized ||
    profile?.phoneRaw ||
    profile?.primaryPhone ||
    profile?.phoneNumber ||
    profile?.contact?.phone ||
    profile?.contact?.phoneRaw ||
    ""
  );
}

/**
 * Build a short address string from possible profile fields.
 * We expect that, as you wire up ContactDetails/ProfileSettings,
 * you’ll denormalize something like this onto the profile doc:
 *   addressLine1, city, state, zip, or addressSummary.
 */
function formatAddressSummary(profile) {
  if (profile.addressSummary && profile.addressSummary.trim()) {
    return profile.addressSummary.trim();
  }

  const parts = [
    profile.addressLine1,
    profile.city,
    profile.state,
    profile.zip,
  ]
    .map((p) => (typeof p === "string" ? p.trim() : p))
    .filter(Boolean);

  if (parts.length === 0) return "No address on file";

  return parts.join(", ");
}

export default function ClientsView() {
  const [search, setSearch] = useState("");
  const [selectedClient, setSelectedClient] = useState(null);
  const { isAdmin, authReady } = useAdminAuth();

  // sorting state
  const [sortField, setSortField] = useState("createdAt");
  const [sortDir, setSortDir] = useState("desc");

  const navigate = useNavigate();

  // Clients with stats computed on the server (paid totals from the payment ledger)
  const clientsQ = useApiQuery(
    async () =>
      (await apiGet("/admin/clients")).clients.map((c) => ({
        ...c,
        ltv: c.lifetimePaid,
        createdAt: c.createdAt ? new Date(c.createdAt) : null,
        lastBookingAt: c.lastBookingAt ? new Date(c.lastBookingAt) : null,
      })),
    [],
    { enabled: authReady && isAdmin }
  );
  const profiles = clientsQ.data || [];

  // Segment logic
  const getSegments = (profile) => {
    const segs = [];

    if ((profile.ltv || 0) >= 300)
      segs.push({ type: "high", label: "High value" });

    if (profile.lastBookingAt)
      segs.push({ type: "active", label: "Recently active" });

    const createdMs = profile.createdAt?.getTime?.() ?? 0;

    if (Date.now() - createdMs < 1000 * 60 * 60 * 24 * 14)
      segs.push({ type: "new", label: "New" });

    return segs;
  };

  // Sorting logic
  const toggleSort = (field) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const sorted = useMemo(() => {
    const arr = [...profiles];

    arr.sort((a, b) => {
      let A = a[sortField];
      let B = b[sortField];

      // Special case: sort by derived name or address
      if (sortField === "displayName") {
        A = getDisplayName(a);
        B = getDisplayName(b);
      } else if (sortField === "addressSummary") {
        A = formatAddressSummary(a);
        B = formatAddressSummary(b);
      }

      if (A == null) A = "";
      if (B == null) B = "";

      if (typeof A === "string") A = A.toLowerCase();
      if (typeof B === "string") B = B.toLowerCase();

      if (A < B) return sortDir === "asc" ? -1 : 1;
      if (A > B) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return arr;
  }, [profiles, sortField, sortDir]);

  const filtered = useMemo(() => {
    const s = search.toLowerCase().trim();
    if (!s) return sorted;

    return sorted.filter((p) => {
      const name = getDisplayName(p).toLowerCase();
      const email = (p.email || "").toLowerCase();
      const phone = (getPhone(p) || "").toLowerCase();
      const addr = formatAddressSummary(p).toLowerCase();
      return (
        name.includes(s) ||
        email.includes(s) ||
        phone.includes(s) ||
        addr.includes(s)
      );
    });
  }, [sorted, search]);

  // Summary metrics
  const metrics = useMemo(() => {
    const total = profiles.length;
    const highValue = profiles.filter((p) => (p.ltv || 0) >= 300).length;
    const active = profiles.filter((p) => p.lastBookingAt).length;

    return { total, highValue, active };
  }, [profiles]);

  return (
    <section className="w-full">
      <h1 className="text-2xl font-semibold text-plum mb-1">Clients</h1>
      <p className="text-plum/70 mb-6">
        View all customers who’ve created an account.
      </p>

      {/* SUMMARY METRICS */}
      <div className="flex gap-3 mb-6">
        <div className="bg-plum/5 px-4 py-2 rounded-lg text-plum text-sm font-medium">
          {metrics.total} total
        </div>
        <div className="bg-green-50 px-4 py-2 rounded-lg text-green-800 text-sm font-medium">
          {metrics.highValue} high-value
        </div>
        <div className="bg-amber-50 px-4 py-2 rounded-lg text-amber-700 text-sm font-medium">
          {metrics.active} active
        </div>
      </div>

      <div className="flex justify-between mb-4">
        <Input
          className="max-w-xs bg-white text-sm"
          placeholder="Search by name, email, phone, or address"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="bg-white rounded-xl border p-2 shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[980px]">
          <thead>
            <tr className="text-left text-plum/70 border-b">
              {[
                ["displayName", "Name"],
                ["email", "Email"],
                ["phone", "Phone"],
                ["addressSummary", "Address on file"],
                ["ltv", "LTV"],
                ["createdAt", "Member since"],
              ].map(([field, label]) => (
                <th
                  key={field}
                  className="py-2 px-3 cursor-pointer select-none hover:text-plum transition-colors"
                  onClick={() => toggleSort(field)}
                >
                  <div className="flex items-center gap-1">
                    {label}
                    {sortField === field &&
                      (sortDir === "asc" ? (
                        <ChevronUp size={14} />
                      ) : (
                        <ChevronDown size={14} />
                      ))}
                  </div>
                </th>
              ))}
              <th className="py-2 px-3 text-right">Actions</th>
            </tr>
          </thead>

          <tbody>
            {filtered.map((p) => {
              const created =
                p.createdAt?.toLocaleDateString?.() ?? "—";
              const segs = getSegments(p);
              const displayName = getDisplayName(p);
              const addressText = formatAddressSummary(p);

              return (
                <tr
                  key={p.id}
                  className="border-b hover:bg-plum/5 transition"
                >
                  <td className="py-3 px-3">
                    <div className="font-medium">{displayName}</div>

                    {/* Segments */}
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {segs.map((s) => (
                        <span
                          key={s.label}
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            s.type === "high"
                              ? "bg-green-100 text-green-800"
                              : s.type === "active"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-purple-100 text-purple-700"
                          }`}
                        >
                          {s.label}
                        </span>
                      ))}
                    </div>
                  </td>

                  <td className="py-3 px-3">{p.email || "—"}</td>
                  <td className="py-3 px-3">
                    {formatPhoneForDisplay(getPhone(p)) || "—"}
                  </td>

                  <td className="py-3 px-3">
                    {addressText}
                  </td>

                  {/* COLOR-CODED LTV */}
                  <td
                    className={`py-3 px-3 font-medium ${
                      (p.ltv || 0) >= 300
                        ? "text-green-700"
                        : (p.ltv || 0) === 0
                        ? "text-plum/40"
                        : "text-plum"
                    }`}
                  >
                    {money(p.ltv || 0)}
                  </td>

                  <td className="py-3 px-3">{created}</td>

                  <td className="py-3 px-3 text-right">
                    <div className="flex justify-end gap-2">
                      {/* View */}
                      <Button
                        variant="outline"
                        size="sm"
                        className="cursor-pointer hover:bg-plum/10 hover:border-plum/30 transition-colors"
                        onClick={() => setSelectedClient(p)}
                      >
                        View
                      </Button>

                      {/* Bookings */}
                      <Button
                        size="sm"
                        className="bg-plum text-white cursor-pointer hover:bg-plum/80 hover:shadow-md transition-all"
                        onClick={() =>
                          navigate(
                            `/admin/client-bookings?clientId=${p.id}&email=${encodeURIComponent(
                              p.email || ""
                            )}&name=${encodeURIComponent(displayName || "")}`
                          )
                        }
                      >
                        Bookings
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}

            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-plum/50">
                  No clients match this search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* DETAILS MODAL */}
      <ClientDetailsModal
        client={selectedClient}
        onClose={() => setSelectedClient(null)}
      />
    </section>
  );
}
