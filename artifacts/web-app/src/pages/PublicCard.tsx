import { useEffect } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { useRoute } from "wouter";

import {
  getGetPublicCardQueryKey,
  useGetPublicCard,
  type PublicBusinessCard,
} from "@workspace/api-client-react";

const NAVY = "#0B1A33";
const PANEL = "#0F2244";
const ORANGE = "#F97316";
const ORANGE_LIGHT = "#FB923C";

function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join("") || "?";
}

function ContactRow({
  icon,
  label,
  value,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  href?: string;
}) {
  const valueEl = href ? (
    <a
      href={href}
      style={{ ...rowStyles.value, color: "#C8DDEF", textDecoration: "none" }}
    >
      {value}
    </a>
  ) : (
    <span style={rowStyles.value}>{value}</span>
  );
  return (
    <div style={rowStyles.row}>
      <div style={rowStyles.iconTile} aria-hidden>
        {icon}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span style={rowStyles.label}>{label}</span>
        {valueEl}
      </div>
    </div>
  );
}

const iconProps = {
  width: 17,
  height: 17,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: ORANGE_LIGHT,
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const MailIcon = () => (
  <svg {...iconProps}>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <polyline points="2,4 12,13 22,4" />
  </svg>
);
const PhoneIcon = () => (
  <svg {...iconProps}>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.27h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 5.94 5.94l1.98-1.98a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);
const PinIcon = () => (
  <svg {...iconProps}>
    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
    <circle cx="12" cy="10" r="3" />
  </svg>
);

function CardBody({ card, url }: { card: PublicBusinessCard; url: string }) {
  const name = card.fullName ?? "";
  const subtitle = card.companyName ?? "";

  return (
    <div style={styles.card} role="main" aria-label={`Digital business card for ${name}`}>
      <div style={styles.band} />

      <div style={styles.header}>
        <div style={styles.ring}>
          <div style={styles.ringInner}>
            {card.avatarUrl ? (
              <img src={card.avatarUrl} alt={name} style={styles.avatarImg} />
            ) : (
              <span style={styles.avatarInitials}>{initials(name)}</span>
            )}
          </div>
        </div>
        {card.designation ? (
          <p style={styles.job}>{card.designation}</p>
        ) : null}
        <h1 style={styles.name}>{name}</h1>
        {subtitle ? <p style={styles.company}>{subtitle}</p> : null}
      </div>

      {(card.email || card.primaryPhone || card.alternatePhone || card.officeAddress) ? (
        <>
          <div style={styles.divider} />
          <div style={styles.contactSection}>
            {card.email ? (
              <ContactRow icon={<MailIcon />} label="EMAIL" value={card.email} href={`mailto:${card.email}`} />
            ) : null}
            {card.primaryPhone ? (
              <ContactRow icon={<PhoneIcon />} label="PHONE" value={card.primaryPhone} href={`tel:${card.primaryPhone}`} />
            ) : null}
            {card.alternatePhone ? (
              <ContactRow icon={<PhoneIcon />} label="ALT. PHONE" value={card.alternatePhone} href={`tel:${card.alternatePhone}`} />
            ) : null}
            {card.officeAddress ? (
              <ContactRow icon={<PinIcon />} label="OFFICE" value={card.officeAddress} />
            ) : null}
          </div>
        </>
      ) : null}

      <div style={styles.qrSection}>
        <span style={styles.qrHeading}>SCAN TO CONNECT</span>
        <div style={styles.qrWrap}>
          <QRCodeCanvas
            value={url}
            size={132}
            bgColor="#ffffff"
            fgColor={NAVY}
            level="H"
            marginSize={2}
            imageSettings={{
              src: "/favicon.svg",
              height: 28,
              width: 28,
              excavate: true,
            }}
          />
        </div>
        <p style={styles.qrSub}>
          Point your camera to open
          <br />
          this card instantly
        </p>
      </div>

      <div style={styles.band} />
    </div>
  );
}

export default function PublicCard() {
  const [, params] = useRoute("/c/:token");
  const token = params?.token ?? "";
  const url = typeof window !== "undefined" ? window.location.href : "";

  const { data, isLoading, isError } = useGetPublicCard(token, {
    query: { enabled: !!token, retry: false, queryKey: getGetPublicCardQueryKey(token) },
  });

  useEffect(() => {
    const prev = document.title;
    if (data?.fullName) document.title = `${data.fullName} — Digital Card`;
    return () => {
      document.title = prev;
    };
  }, [data?.fullName]);

  return (
    <div style={styles.page}>
      {isLoading ? (
        <p style={styles.stateText}>Loading…</p>
      ) : isError || !data ? (
        <div style={styles.stateBox}>
          <h1 style={styles.stateTitle}>Card not found</h1>
          <p style={styles.stateText}>
            This card link is invalid or is no longer available.
          </p>
        </div>
      ) : (
        <CardBody card={data} url={url} />
      )}
      <p style={styles.footer}>Powered by Elite Marcom</p>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    gap: 20,
    background: "#f0f4f8",
    fontFamily: "'DM Sans', sans-serif",
    padding: "2.5rem 1rem",
  },
  card: {
    width: 320,
    maxWidth: "100%",
    borderRadius: 24,
    overflow: "hidden",
    background: NAVY,
    boxShadow:
      "0 32px 64px rgba(11, 26, 51, 0.35), 0 8px 16px rgba(11, 26, 51, 0.2)",
  },
  band: { height: 6, background: ORANGE, width: "100%" },
  header: { padding: "30px 26px 22px", textAlign: "center" },
  ring: {
    width: 96,
    height: 96,
    borderRadius: "50%",
    margin: "0 auto 16px",
    padding: 3,
    background: ORANGE,
  },
  ringInner: {
    width: "100%",
    height: "100%",
    borderRadius: "50%",
    overflow: "hidden",
    background: "#1A3055",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarImg: { width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" },
  avatarInitials: {
    fontFamily: "'DM Serif Display', serif",
    fontSize: 32,
    color: "#FFF7F0",
  },
  job: {
    fontSize: 11,
    fontWeight: 500,
    color: ORANGE,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    marginBottom: 5,
  },
  name: {
    fontFamily: "'DM Serif Display', serif",
    fontSize: 24,
    fontWeight: 400,
    color: "#FFF7F0",
    lineHeight: 1.2,
    marginBottom: 5,
  },
  company: { fontSize: 13, color: "#7A9CC4", fontWeight: 400 },
  divider: { height: 0.5, background: "rgba(255,255,255,0.08)", margin: "0 26px" },
  contactSection: {
    padding: "18px 26px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 13,
  },
  qrSection: {
    margin: "8px 26px 24px",
    background: PANEL,
    borderRadius: 18,
    padding: 20,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 14,
  },
  qrHeading: {
    fontSize: 10,
    fontWeight: 500,
    color: ORANGE,
    letterSpacing: "0.14em",
  },
  qrWrap: {
    background: "#fff",
    borderRadius: 12,
    padding: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  qrSub: { fontSize: 11.5, color: "#4A6E94", textAlign: "center", lineHeight: 1.6 },
  stateBox: { textAlign: "center", maxWidth: 320 },
  stateTitle: {
    fontFamily: "'DM Serif Display', serif",
    fontSize: 26,
    color: NAVY,
    marginBottom: 8,
  },
  stateText: { fontSize: 14, color: "#4A6E94" },
  footer: { fontSize: 12, color: "#90A4BC", fontFamily: "'DM Sans', sans-serif" },
};

const rowStyles: Record<string, React.CSSProperties> = {
  row: { display: "flex", alignItems: "center", gap: 13 },
  iconTile: {
    width: 36,
    height: 36,
    borderRadius: 10,
    background: "rgba(249,115,22,0.13)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  label: {
    fontSize: 10,
    color: "#3A5E82",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    fontWeight: 500,
  },
  value: {
    fontSize: 13,
    color: "#C8DDEF",
    fontWeight: 400,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
};
