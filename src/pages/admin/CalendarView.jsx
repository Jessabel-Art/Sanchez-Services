// src/pages/admin/CalendarView.jsx — calendar of bookings + blackouts.
// Drag/resize and blackout changes go to the server, which runs the same conflict check as every other path.
import React from "react";
import { Calendar, dateFnsLocalizer } from "react-big-calendar";
import withDragAndDrop from "react-big-calendar/lib/addons/dragAndDrop";
import "react-big-calendar/lib/css/react-big-calendar.css";
import "react-big-calendar/lib/addons/dragAndDrop/styles.css";
import format from "date-fns/format";
import parse from "date-fns/parse";
import startOfWeek from "date-fns/startOfWeek";
import getDay from "date-fns/getDay";
import addDays from "date-fns/addDays";
import addMonths from "date-fns/addMonths";
import { enUS } from "date-fns/locale";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import BlackoutModal from "./components/BlackoutModal";
import BookingDetailModal from "./components/BookingDetailModal";
import { BookingModal } from "./components/BookingModal";
import { RescheduleModal } from "./components/RescheduleModal";
import { apiDelete, apiGet, apiPost, qs } from "@/lib/api";
import { useApiQuery } from "@/hooks/useApiQuery";
import { normalizeBooking, dateKey as tzDateKey, timeKey, fmtDate, fmtTime, toDate, statusLabel } from "@/lib/model";

const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales: { "en-US": enUS } });
const DnDCalendar = withDragAndDrop(Calendar);

const STATUS_ORDER = ["pending_payment", "pending", "confirmed", "completed", "cancelled", "declined"];
const STATUS_COLORS = {
  pending_payment: "#fef3c7",
  pending: "#fde68a",
  confirmed: "#bbf7d0",
  completed: "#F3E8FF",
  declined: "#fecaca",
  cancelled: "#e5e7eb",
};
const DEFAULT_VISIBLE = new Set(["pending_payment", "pending", "confirmed", "completed"]);
const BLACKOUT_BG = "#431039";
const BLACKOUT_TEXT = "#FFFFFF";
const SELECT_BG = "#FFF7CC";
const CAL_HEIGHT = 560;
const MOVABLE = ["pending_payment", "pending", "confirmed"];

/** Local (browser) calendar-day key, used for grid cells. */
const cellKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addKeyDays = (key, n) => {
  const [y, m, d] = key.split("-").map(Number);
  return cellKey(new Date(y, m - 1, d + n));
};

function rangeFor(view, date) {
  const d = new Date(date);
  if (view === "month") {
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    return { from: cellKey(addDays(first, -7)), to: cellKey(addDays(new Date(d.getFullYear(), d.getMonth() + 1, 0), 7)) };
  }
  if (view === "week") {
    const s = startOfWeek(d);
    return { from: cellKey(s), to: cellKey(addDays(s, 6)) };
  }
  return { from: cellKey(d), to: cellKey(d) };
}

function icsFor(b) {
  const f = (x) => toDate(x).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const esc = (s) => String(s || "").replace(/[\\,;]/g, (m) => `\\${m}`).replace(/\r?\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sanchez Services//Booking//EN",
    "BEGIN:VEVENT",
    `UID:${b.id}@sanchezservices`,
    `DTSTAMP:${f(new Date())}`,
    `DTSTART:${f(b.startAt)}`,
    `DTEND:${f(b.endAt)}`,
    `SUMMARY:${esc(`${b.serviceName} — ${b.clientName}`)}`,
    `LOCATION:${esc(b.addressText)}`,
    `DESCRIPTION:${esc(`Invoice ${b.invoiceNumber}\nPhone: ${b.contact?.phone || ""}\n${b.cleanerNotes || ""}`)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

function downloadIcs(b) {
  const url = URL.createObjectURL(new Blob([icsFor(b)], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `booking-${b.invoiceNumber}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function CalendarView() {
  const { toast } = useToast();
  const [view, setView] = React.useState("month");
  const [anchorDate, setAnchorDate] = React.useState(new Date());
  const [selectedRange, setSelectedRange] = React.useState(null);
  const [visible, setVisible] = React.useState(DEFAULT_VISIBLE);
  const [openId, setOpenId] = React.useState(null);
  const [blackoutOpen, setBlackoutOpen] = React.useState(false);
  const [newBooking, setNewBooking] = React.useState(null);
  const [pendingMove, setPendingMove] = React.useState(null);

  const range = rangeFor(view, anchorDate);
  const q = useApiQuery(
    async () => {
      const r = await apiGet(`/admin/calendar${qs(range)}`);
      return { bookings: r.bookings.map(normalizeBooking), blackouts: r.blackouts };
    },
    [range.from, range.to]
  );
  const bookings = q.data?.bookings || [];
  const blackouts = q.data?.blackouts || [];

  const events = React.useMemo(
    () =>
      bookings
        .filter((b) => visible.has(b.status))
        .map((b) => ({
          id: b.id,
          title: `${fmtTime(b.startAt)} ${b.clientName} · ${b.serviceName}`,
          start: toDate(b.startAt),
          end: toDate(b.endAt) || new Date(toDate(b.startAt).getTime() + b.durationMinutes * 60000),
          resource: b,
          draggable: MOVABLE.includes(b.status),
        })),
    [bookings, visible]
  );

  const eventsByDay = React.useMemo(() => {
    const m = new Map();
    events.forEach((e) => {
      const k = cellKey(e.start);
      m.set(k, [...(m.get(k) || []), e]);
    });
    return m;
  }, [events]);

  const blackoutDays = React.useMemo(() => {
    const set = new Set();
    blackouts.forEach((x) => {
      if (x.allDay) {
        for (let k = x.startDate; k < x.endDateExclusive; k = addKeyDays(k, 1)) set.add(k);
      } else if (x.startAt) {
        set.add(tzDateKey(x.startAt));
      }
    });
    return set;
  }, [blackouts]);

  const selectedKeys = React.useMemo(() => {
    const set = new Set();
    if (!selectedRange) return set;
    const last = cellKey(new Date(selectedRange.end.getTime() - 1));
    for (let k = cellKey(selectedRange.start); k <= last; k = addKeyDays(k, 1)) set.add(k);
    return set;
  }, [selectedRange]);

  const sidebarEvents = selectedRange
    ? events.filter((e) => selectedKeys.has(cellKey(e.start))).sort((a, b) => a.start - b.start)
    : events.filter((e) => e.start >= new Date(Date.now() - 3 * 3600e3)).sort((a, b) => a.start - b.start).slice(0, 8);
  const sidebarBlackouts = blackouts.filter((x) =>
    x.allDay ? [...selectedKeys].some((k) => k >= x.startDate && k < x.endDateExclusive) : selectedKeys.has(tzDateKey(x.startAt))
  );

  // Drag/resize: confirm via the reschedule dialog (prefilled), so the admin can choose whether to email the client.
  const onEventDrop = ({ event, start, end }) => {
    const b = event.resource;
    if (!MOVABLE.includes(b.status)) return;
    const minutes = Math.round((end - start) / 60000);
    setPendingMove({ booking: { ...b, durationMinutes: minutes || b.durationMinutes }, date: tzDateKey(start), time: timeKey(start) });
  };

  const saveBlackout = async (v) => {
    try {
      const res = await apiPost("/admin/blackouts", v);
      if (res.affectedBookings?.length) {
        toast({
          title: "Blackout saved — existing bookings overlap",
          description: res.affectedBookings.map((b) => `${b.contact?.name} (${fmtDate(b.startAt)})`).join(", ") + ". Reschedule or cancel them if needed.",
        });
      } else {
        toast({ title: "Time blocked" });
      }
    } catch (e) {
      toast({ title: "Could not block time", description: e.message, variant: "destructive" });
    }
  };

  const removeBlackout = async (x) => {
    if (!window.confirm("Remove this blackout? Those times become bookable again.")) return;
    try {
      await apiDelete(`/admin/blackouts/${x.id}`);
      toast({ title: "Blackout removed" });
    } catch (e) {
      toast({ title: "Could not remove blackout", description: e.message, variant: "destructive" });
    }
  };

  const DateCellWrapper = ({ value, children }) => {
    const k = cellKey(value);
    const child = React.Children.only(children);
    let className = child.props.className || "";
    if (blackoutDays.has(k)) className += " ss-blackout-datecell";
    if (selectedKeys.has(k)) className += " ss-selected-datecell";
    return React.cloneElement(child, { className: className.trim() });
  };

  const MonthDateHeader = ({ label, date }) => {
    const k = cellKey(date);
    const count = (eventsByDay.get(k) || []).length;
    return (
      <div className="flex items-center justify-between w-full">
        <span className={blackoutDays.has(k) ? "ss-blackout-dateheader" : selectedKeys.has(k) ? "font-semibold text-[#431039]" : ""}>{label}</span>
        {count > 0 && (
          <span className="ml-1 inline-flex items-center justify-center rounded-full text-[9px] leading-none px-1.5 py-0.5 font-semibold" style={{ backgroundColor: "#E2A82B", color: "#431039" }}>
            {count}
          </span>
        )}
      </div>
    );
  };

  const dayPropGetter = (date) => {
    const k = cellKey(date);
    const style = {};
    let className = "";
    if (blackoutDays.has(k)) {
      className = "ss-blackout-day";
      style.backgroundColor = BLACKOUT_BG;
      style.color = BLACKOUT_TEXT;
    }
    if (selectedKeys.has(k)) {
      if (!blackoutDays.has(k)) style.backgroundColor = SELECT_BG;
      style.boxShadow = "inset 0 0 0 2px #E2A82B";
    }
    return { className, style };
  };

  const eventStyleGetter = (event) => ({
    style: {
      backgroundColor: STATUS_COLORS[event.resource.status] || "#e9d5ff",
      borderRadius: 8,
      padding: "2px 6px",
      color: "#111",
      border: event.resource.needsAttention ? "2px solid #d97706" : "1px solid rgba(0,0,0,0.05)",
      fontSize: "11px",
      lineHeight: 1.2,
      opacity: ["cancelled", "declined"].includes(event.resource.status) ? 0.6 : 1,
    },
  });

  const toggleStatus = (st) =>
    setVisible((prev) => {
      const next = new Set(prev);
      next.has(st) ? next.delete(st) : next.add(st);
      return next;
    });

  const isShowingToday = cellKey(anchorDate) === cellKey(new Date());
  const pill = (active) =>
    `text-[10px] sm:text-xs px-2 sm:px-3 py-1 rounded-full border ${active ? "bg-[#431039] text-white border-[#431039] shadow-sm" : "bg-transparent text-[#431039] border-transparent hover:bg-white/70"}`;
  const selectedDay = selectedRange ? cellKey(selectedRange.start) : null;

  return (
    <section>
      <style>{`
        .rbc-overlay { z-index: 60; }
        .rbc-event { padding: 2px 6px; }
        .rbc-time-view .rbc-time-slot { min-height: 18px; }
        .rbc-calendar, .rbc-month-view, .rbc-time-view, .rbc-day-view { touch-action: manipulation; pointer-events: auto; }
        .ss-blackout-day, .ss-blackout-day.rbc-day-bg { background-color: ${BLACKOUT_BG} !important; }
        .ss-blackout-datecell, .ss-blackout-datecell .rbc-button-link, .ss-blackout-datecell span, .ss-blackout-datecell * { color: ${BLACKOUT_TEXT} !important; }
        .ss-selected-datecell .rbc-button-link { background-color: ${SELECT_BG} !important; border-radius: 4px; color: #431039 !important; }
        .rbc-slot-selection { background-color: rgba(226, 168, 43, 0.22) !important; border: 1px solid #E2A82B !important; }
        .rbc-selected-cell { background-color: ${SELECT_BG} !important; }
        .ss-blackout-dateheader { color: ${BLACKOUT_TEXT} !important; }
        .rbc-month-view .rbc-row-content { position: relative; z-index: 2; }
        .rbc-month-view .rbc-day-bg { z-index: 1; }
        .rbc-month-view .rbc-event { position: relative; z-index: 5; }
      `}</style>

      <div className="mx-auto w-full px-2 sm:px-3 md:px-4 lg:px-6" style={{ maxWidth: 1360 }}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3 mb-3 sm:mb-4">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <Button variant="ghost" size="sm" onClick={() => setAnchorDate(view === "month" ? addMonths(anchorDate, -1) : addDays(anchorDate, view === "week" ? -7 : -1))} aria-label="Previous">
              ‹
            </Button>
            <span className="text-sm font-semibold text-plum min-w-[140px] text-center">
              {view === "month" ? format(anchorDate, "MMMM yyyy") : view === "week" ? `Week of ${format(startOfWeek(anchorDate), "MMM d")}` : format(anchorDate, "EEE, MMM d")}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setAnchorDate(view === "month" ? addMonths(anchorDate, 1) : addDays(anchorDate, view === "week" ? 7 : 1))} aria-label="Next">
              ›
            </Button>
            <input
              type="date"
              value={cellKey(anchorDate)}
              onChange={(e) => e.target.value && setAnchorDate(new Date(`${e.target.value}T12:00:00`))}
              className="px-2 py-1.5 rounded-lg border bg-white text-xs sm:text-sm"
              aria-label="Go to date"
            />
            <Button size="sm" className="px-2 sm:px-3 py-1.5 bg-[#E2A82B] text-[#431039] hover:bg-[#F0BA3E] text-[10px] sm:text-xs" onClick={() => setBlackoutOpen(true)}>
              Block time
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs"
              onClick={() => setNewBooking({ date: selectedDay || cellKey(anchorDate), time: "09:00" })}
            >
              + Booking
            </Button>
          </div>
          <div className="flex items-center gap-1 sm:gap-2">
            <Button variant="ghost" className={pill(isShowingToday)} onClick={() => setAnchorDate(new Date())}>
              Today
            </Button>
            {["month", "week", "day"].map((v) => (
              <Button key={v} variant="ghost" className={pill(view === v)} onClick={() => setView(v)}>
                {v[0].toUpperCase() + v.slice(1)}
              </Button>
            ))}
          </div>
        </div>

        <div className="mb-2 sm:mb-3 text-[10px] sm:text-xs text-plum/70 flex flex-wrap gap-2 sm:gap-4">
          {STATUS_ORDER.map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => toggleStatus(st)}
              aria-pressed={visible.has(st)}
              className={`inline-flex items-center gap-1 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-full border transition ${
                visible.has(st) ? "bg-white border-[#E5C2E5] text-plum" : "bg-transparent border-transparent text-plum/50 hover:bg-white/60"
              }`}
            >
              <span className="inline-block w-2 h-2 rounded-full" style={{ background: STATUS_COLORS[st] }} />
              {statusLabel(st)}
            </button>
          ))}
          <span className="inline-flex items-center gap-1 ml-2 sm:ml-4">
            <span className="inline-block w-3 h-3 rounded" style={{ background: BLACKOUT_BG }} />
            Blacked-out day
          </span>
          {q.error && <span className="text-rose-700" role="alert">{q.error.message}</span>}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(600px,1fr),360px] gap-2 sm:gap-3 lg:gap-4" style={{ alignItems: "start" }}>
          <div className="bg-white border rounded-lg sm:rounded-xl shadow-sm p-1.5 sm:p-2 w-full overflow-x-auto" style={{ height: CAL_HEIGHT }}>
            <DnDCalendar
              localizer={localizer}
              events={events}
              startAccessor="start"
              endAccessor="end"
              style={{ height: "100%", minWidth: 560 }}
              view={view}
              date={anchorDate}
              onView={setView}
              onNavigate={(d) => {
                setAnchorDate(d);
                setSelectedRange(null);
              }}
              selectable
              resizable
              draggableAccessor="draggable"
              onSelectEvent={(ev) => setOpenId(ev.id)}
              onSelectSlot={(slot) => setSelectedRange({ start: slot.start, end: slot.end })}
              eventPropGetter={eventStyleGetter}
              onEventDrop={onEventDrop}
              onEventResize={onEventDrop}
              popup
              step={30}
              timeslots={2}
              min={new Date(1970, 0, 1, 7, 0)}
              max={new Date(1970, 0, 1, 20, 0)}
              toolbar={false}
              dayPropGetter={dayPropGetter}
              components={{ dateCellWrapper: DateCellWrapper, month: { dateHeader: MonthDateHeader } }}
            />
          </div>

          <aside className="bg-white border rounded-lg p-2 sm:p-3 w-full lg:w-[360px]">
            <h3 className="font-semibold text-sm text-plum mb-2">{selectedRange ? "Appointments in selection" : "Next appointments"}</h3>
            {sidebarEvents.length === 0 && <p className="text-xs sm:text-sm text-plum/70 mb-2">No appointments.</p>}
            <ul className="space-y-1.5 sm:space-y-2 mb-3">
              {sidebarEvents.map((ev) => {
                const b = ev.resource;
                return (
                  <li key={ev.id} className="p-1.5 sm:p-2 border rounded hover:bg-neutral-50">
                    <div className="flex justify-between items-start gap-2 sm:gap-3">
                      <div className="min-w-0">
                        <div className="font-medium text-xs sm:text-sm truncate">{b.serviceName}</div>
                        <div className="text-[10px] sm:text-xs text-plum/70">
                          {fmtDate(b.startAt)} · {fmtTime(b.startAt)} – {fmtTime(b.endAt)}
                        </div>
                        <div className="text-[10px] sm:text-xs text-plum/70">{b.clientName}</div>
                      </div>
                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] sm:text-[11px] font-medium shadow-sm whitespace-nowrap" style={{ backgroundColor: STATUS_COLORS[b.status], color: "#431039" }}>
                          {statusLabel(b.status)}
                        </span>
                        <div className="flex gap-1">
                          <Button size="sm" variant="outline" className="h-6 sm:h-7 px-2 text-[9px] sm:text-[11px] rounded-full border-[#E5C2E5] text-[#431039] bg-white" onClick={() => setOpenId(b.id)}>
                            Details
                          </Button>
                          <Button size="sm" variant="ghost" className="h-6 sm:h-7 px-2 text-[9px] sm:text-[11px]" onClick={() => downloadIcs(b)} aria-label={`Download calendar file for ${b.clientName}`}>
                            .ics
                          </Button>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            {selectedRange && (
              <>
                <h4 className="font-semibold text-plum mb-1 text-xs sm:text-sm">Blackouts in selection</h4>
                {sidebarBlackouts.length === 0 ? (
                  <p className="text-xs text-plum/70">None.</p>
                ) : (
                  <ul className="space-y-1">
                    {sidebarBlackouts.map((x) => (
                      <li key={x.id} className="flex items-center justify-between gap-2 text-xs border rounded p-1.5">
                        <span>
                          {x.allDay
                            ? `${x.startDate}${addKeyDays(x.startDate, 1) !== x.endDateExclusive ? ` → ${addKeyDays(x.endDateExclusive, -1)}` : ""} (all day)`
                            : `${fmtDate(x.startAt)} ${fmtTime(x.startAt)}–${fmtTime(x.endAt)}`}
                          {x.reason ? ` · ${x.reason}` : ""}
                        </span>
                        <Button size="sm" variant="ghost" className="h-6 text-rose-700" onClick={() => removeBlackout(x)}>
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </aside>
        </div>
      </div>

      <BlackoutModal
        open={blackoutOpen}
        onOpenChange={setBlackoutOpen}
        onSave={saveBlackout}
        initialValue={selectedRange ? { startDate: cellKey(selectedRange.start), endDate: cellKey(new Date(selectedRange.end.getTime() - 1)), allDay: true } : null}
      />
      <BookingDetailModal bookingId={openId} onClose={() => setOpenId(null)} />
      <BookingModal open={!!newBooking} initial={null} defaults={newBooking} onClose={() => setNewBooking(null)} onSave={(b) => b && setOpenId(b.id)} />
      <RescheduleModal
        open={!!pendingMove}
        booking={pendingMove?.booking}
        initialDate={pendingMove?.date}
        initialTime={pendingMove?.time}
        onClose={() => setPendingMove(null)}
      />
    </section>
  );
}
