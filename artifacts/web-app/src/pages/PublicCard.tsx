import { useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  Mail,
  Phone,
  Globe,
  MapPin,
  Linkedin,
  Facebook,
  Instagram,
  Twitter,
  Youtube,
} from "lucide-react";
import { useGetPublicCard } from "@workspace/api-client-react";

const NAVY = "#0B1A33";
const ORANGE = "#FF6B00";

// Load the display fonts used by the card design once, lazily, so the public
// page renders with the intended typography without bloating the main app.
function useCardFonts() {
  useEffect(() => {
    const id = "public-card-fonts";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Serif+Display:ital@0;1&display=swap";
    document.head.appendChild(link);
  }, []);
}

const SANS = "'DM Sans', system-ui, sans-serif";
const SERIF = "'DM Serif Display', Georgia, serif";

function normalizeUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function displayUrl(raw: string): string {
  return raw.replace(/^https?:\/\//i, "").replace(/\/$/, "");
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
  const text = (
    <span
      style={{
        fontSize: 13,
        color: "#C8DDEF",
        fontWeight: 400,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        textDecoration: "none",
        display: "block",
      }}
    >
      {value}
    </span>
  );
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background: "rgba(255, 107, 0, 0.13)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          color: "#FF8A3D",
        }}
      >
        {icon}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span
          style={{
            fontSize: 10,
            color: "#3A5E82",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            fontWeight: 500,
          }}
        >
          {label}
        </span>
        {href ? (
          <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer" style={{ textDecoration: "none" }}>
            {text}
          </a>
        ) : (
          text
        )}
      </div>
    </div>
  );
}

export default function PublicCard({ token }: { token: string }) {
  useCardFonts();
  const { data: card, isLoading, isError } = useGetPublicCard(token);

  const shareUrl = typeof window !== "undefined" ? window.location.href : "";

  const wrap = (children: React.ReactNode) => (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        background: "#f0f4f8",
        fontFamily: SANS,
        padding: "2rem 1rem",
      }}
    >
      {children}
    </div>
  );

  if (isLoading) {
    return wrap(
      <div style={{ color: "#4A6E94", fontFamily: SANS, fontSize: 15 }}>Loading card…</div>,
    );
  }

  if (isError || !card) {
    return wrap(
      <div
        style={{
          textAlign: "center",
          maxWidth: 320,
          color: NAVY,
        }}
      >
        <h1 style={{ fontFamily: SERIF, fontSize: 26, marginBottom: 8 }}>Card not found</h1>
        <p style={{ color: "#4A6E94", fontSize: 14, lineHeight: 1.6 }}>
          This digital business card link is invalid or is no longer published.
        </p>
      </div>,
    );
  }

  const socials: { key: string; href: string; icon: React.ReactNode }[] = [];
  if (card.linkedin) socials.push({ key: "linkedin", href: normalizeUrl(card.linkedin), icon: <Linkedin size={18} /> });
  if (card.twitter) socials.push({ key: "twitter", href: normalizeUrl(card.twitter), icon: <Twitter size={18} /> });
  if (card.facebook) socials.push({ key: "facebook", href: normalizeUrl(card.facebook), icon: <Facebook size={18} /> });
  if (card.instagram) socials.push({ key: "instagram", href: normalizeUrl(card.instagram), icon: <Instagram size={18} /> });
  if (card.youtube) socials.push({ key: "youtube", href: normalizeUrl(card.youtube), icon: <Youtube size={18} /> });

  return wrap(
    <div
      role="main"
      aria-label={`Digital business card for ${card.fullName ?? "contact"}`}
      style={{
        width: 340,
        maxWidth: "100%",
        borderRadius: 24,
        overflow: "hidden",
        background: NAVY,
        boxShadow:
          "0 32px 64px rgba(11, 26, 51, 0.35), 0 8px 16px rgba(11, 26, 51, 0.2)",
      }}
    >
      <div style={{ height: 6, background: ORANGE, width: "100%" }} />

      {/* Header */}
      <div style={{ padding: "30px 26px 22px", textAlign: "center" }}>
        <div
          style={{
            width: 96,
            height: 96,
            borderRadius: "50%",
            margin: "0 auto 16px",
            padding: 3,
            background: ORANGE,
          }}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              borderRadius: "50%",
              overflow: "hidden",
              background: "#1A3055",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {card.avatarUrl ? (
              <img
                src={card.avatarUrl}
                alt={card.fullName ?? "Profile photo"}
                style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
              />
            ) : (
              <svg width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="#FF8A3D" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="14" r="7" />
                <path d="M4 34c0-7.732 6.268-14 14-14s14 6.268 14 14" />
              </svg>
            )}
          </div>
        </div>
        {card.designation ? (
          <p
            style={{
              fontSize: 11,
              fontWeight: 500,
              color: ORANGE,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              marginBottom: 5,
            }}
          >
            {card.designation}
          </p>
        ) : null}
        <h1
          style={{
            fontFamily: SERIF,
            fontSize: 24,
            color: "#FFF7F0",
            lineHeight: 1.2,
            letterSpacing: "0.01em",
            marginBottom: 5,
          }}
        >
          {card.fullName ?? "—"}
        </h1>
        {card.companyName ? (
          <p style={{ fontSize: 13, color: "#7A9CC4", fontWeight: 400 }}>{card.companyName}</p>
        ) : null}
      </div>

      <div style={{ height: 0.5, background: "rgba(255,255,255,0.08)", margin: "0 26px" }} />

      {/* Contact rows */}
      <div
        style={{
          padding: "18px 26px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 13,
        }}
      >
        {card.email ? (
          <ContactRow icon={<Mail size={17} />} label="Email" value={card.email} href={`mailto:${card.email}`} />
        ) : null}
        {card.primaryPhone ? (
          <ContactRow icon={<Phone size={17} />} label="Phone" value={card.primaryPhone} href={`tel:${card.primaryPhone}`} />
        ) : null}
        {card.altPhone ? (
          <ContactRow icon={<Phone size={17} />} label="Alt. Phone" value={card.altPhone} href={`tel:${card.altPhone}`} />
        ) : null}
        {card.website ? (
          <ContactRow
            icon={<Globe size={17} />}
            label="Website"
            value={displayUrl(card.website)}
            href={normalizeUrl(card.website)}
          />
        ) : null}
        {card.officeAddress ? (
          <ContactRow icon={<MapPin size={17} />} label="Office" value={card.officeAddress} />
        ) : null}
      </div>

      {/* Socials */}
      {socials.length > 0 ? (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 12,
            padding: "2px 26px 6px",
          }}
        >
          {socials.map((s) => (
            <a
              key={s.key}
              href={s.href}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                width: 40,
                height: 40,
                borderRadius: 12,
                background: "rgba(255, 107, 0, 0.13)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#FF8A3D",
                textDecoration: "none",
              }}
            >
              {s.icon}
            </a>
          ))}
        </div>
      ) : null}

      {/* QR */}
      <div
        style={{
          margin: "8px 26px 22px",
          background: "#0F2244",
          borderRadius: 18,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 14,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 500,
            color: ORANGE,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          Scan to connect
        </span>
        <div
          style={{
            background: "#ffffff",
            borderRadius: 12,
            padding: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <QRCodeSVG value={shareUrl} size={132} fgColor={NAVY} bgColor="#ffffff" level="M" />
        </div>
        <p style={{ fontSize: 11.5, color: "#4A6E94", textAlign: "center", lineHeight: 1.6 }}>
          Point your camera here to open
          <br />
          this card on your phone
        </p>
      </div>

      <div style={{ height: 6, background: ORANGE, width: "100%" }} />

      <div style={{ padding: "12px 26px 16px", textAlign: "center" }}>
        <span style={{ fontSize: 11, color: "#3A5E82", letterSpacing: "0.04em" }}>
          Powered by Elite Marcom
        </span>
      </div>
    </div>,
  );
}
