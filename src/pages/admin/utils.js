import { useMemo, useState } from "react";

export const MONEY0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function money(n) {
  return MONEY0.format(Number(n || 0));
}

export function rangePreset(preset) {
  const now = new Date();
  const from = new Date();
  const to = new Date();
  to.setHours(23,59,59,999);

  if (preset === "7d") from.setDate(now.getDate() - 6);
  else if (preset === "30d") from.setDate(now.getDate() - 29);
  else if (preset === "qtr") { // calendar quarter
    const qStartMonth = Math.floor(now.getMonth()/3)*3;
    from.setMonth(qStartMonth, 1); from.setHours(0,0,0,0);
  }
  else if (preset === "year") { from.setFullYear(now.getFullYear(), 0, 1); from.setHours(0,0,0,0); }
  else { from.setHours(0,0,0,0); } // today as default

  return { from, to };
}

export function csvDownload(filename, rows, header) {
  const headerLine = header.join(",");
  const lines = rows.map((r) => header.map((h) => {
    let v = String(r[h] ?? "").replaceAll('"','""').replaceAll("\n"," ");
    if (/^[=+\-@\t\r]/.test(v) && !/^-?\d/.test(v)) v = `'${v}`; // spreadsheet formula injection guard
    return `"${v}"`;
  }).join(","));
  const csv = [headerLine, ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function toSortableDate(value) {
  if (!value) return 0;
  if (typeof value?.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 0 : value.getTime();
  if (typeof value === "object" && typeof value.seconds === "number") {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function normalizeSortValue(value) {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value instanceof Date || typeof value?.toDate === "function" || typeof value?.seconds === "number") {
    return toSortableDate(value);
  }
  return String(value).toLowerCase();
}

export function sortRows(rows, sortConfig, columns) {
  if (!sortConfig?.key) return rows;
  const column = columns.find((col) => col.key === sortConfig.key);
  if (!column) return rows;

  const direction = sortConfig.direction === "asc" ? 1 : -1;
  const accessor = column.accessor || ((row) => row[column.key]);

  return [...rows].sort((a, b) => {
    const av = normalizeSortValue(accessor(a));
    const bv = normalizeSortValue(accessor(b));
    if (av < bv) return -1 * direction;
    if (av > bv) return 1 * direction;
    return 0;
  });
}

export function useSortableRows(rows, columns, initialSort = null) {
  const [sortConfig, setSortConfig] = useState(initialSort);

  const requestSort = (key) => {
    setSortConfig((current) => {
      if (current?.key === key) {
        return {
          key,
          direction: current.direction === "asc" ? "desc" : "asc",
        };
      }
      const column = columns.find((col) => col.key === key);
      return {
        key,
        direction: column?.defaultDirection || "asc",
      };
    });
  };

  const sortedRows = useMemo(
    () => sortRows(rows, sortConfig, columns),
    [rows, sortConfig, columns]
  );

  return { sortedRows, sortConfig, requestSort };
}
