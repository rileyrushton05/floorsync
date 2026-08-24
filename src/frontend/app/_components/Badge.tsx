import styles from "./Badge.module.css";

export type BadgeTone = "red" | "amber" | "blue" | "green" | "gray";

const toneClass: Record<BadgeTone, string> = {
  red: styles.red,
  amber: styles.amber,
  blue: styles.blue,
  green: styles.green,
  gray: styles.gray,
};

export function Badge({
  children,
  tone,
  outline = false,
}: {
  children: React.ReactNode;
  tone: BadgeTone;
  outline?: boolean;
}) {
  return (
    <span className={`${styles.badge} ${toneClass[tone]} ${outline ? styles.outline : ""}`}>
      {children}
    </span>
  );
}

export function priorityTone(priority: string): BadgeTone {
  const p = priority.toLowerCase();
  if (p === "high") return "red";
  if (p === "medium" || p === "med") return "amber";
  if (p === "normal" || p === "norm") return "blue";
  return "green";
}

export function statusTone(status: string): BadgeTone {
  const s = status.toLowerCase();
  if (s.includes("delay")) return "red";
  if (s.includes("wait") || s.includes("warn")) return "amber";
  if (s.includes("run") || s.includes("active") || s.includes("progress")) return "blue";
  if (s.includes("complet") || s.includes("done")) return "green";
  return "gray";
}
