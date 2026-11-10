/* Number, date and duration formatting shared across the app. */

export const fmt = {
  int: (n) => (n == null ? "-" : Math.round(n).toLocaleString()),
  compact: (n) => {
    if (n == null) return "-";
    const abs = Math.abs(n);
    if (abs >= 1e6) return (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (abs >= 10000) return (n / 1000).toFixed(abs >= 1e5 ? 0 : 1).replace(/\.0$/, "") + "K";
    return Math.round(n).toLocaleString();
  },
  dec: (n, places = 1) => (n == null ? "-" : n.toFixed(places)),
  pct: (n, places = 1) => (n == null ? "-" : (n * 100).toFixed(places) + "%"),
  duration: (ms) => {
    if (!ms) return "-";
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    return `${m}m ${String(total % 60).padStart(2, "0")}s`;
  },
  clock: (ms) => {
    const total = Math.round(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  },
  hours: (h) => (h == null ? "-" : h >= 10 ? `${Math.round(h)}h` : `${h.toFixed(1)}h`),
  date: (iso) => {
    if (!iso) return "-";
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  },
  dateTime: (iso) => {
    if (!iso) return "-";
    const d = new Date(iso);
    return (
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      ", " +
      d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    );
  },
  time: (iso) =>
    iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "-",
  /** "Today" / "Yesterday" / "Sat 9 Aug": the thing you actually scan for. */
  dayLabel: (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((midnight(new Date()) - midnight(d)) / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
    return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  },
};
