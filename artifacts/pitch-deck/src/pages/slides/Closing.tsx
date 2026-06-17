const base = import.meta.env.BASE_URL;

export default function Closing() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-ink font-body">
      <img
        src={`${base}hero-scan.png`}
        crossOrigin="anonymous"
        alt="Abstract scan line digitizing a business card into data"
        className="absolute inset-0 w-full h-full object-cover opacity-25"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-ink via-ink/90 to-ink/60" />

      <div className="absolute top-[7vh] left-[6vw] flex items-center gap-[1.2vw]">
        <div className="w-[2.6vw] h-[2.6vw] rounded-[0.7vw] bg-primary" />
        <span className="text-white/90 text-[1.5vw] font-display font-medium tracking-tight">
          Card Scanner Pro
        </span>
      </div>

      <div className="relative h-full flex flex-col justify-center px-[6vw]">
        <p className="text-primary text-[1.4vw] font-semibold tracking-[0.3em] uppercase mb-[3vh]">
          Capture. Score. Follow up.
        </p>
        <h2 className="text-white font-display font-bold text-[6.8vw] leading-[0.95] tracking-tighter max-w-[72vw] text-balance">
          Turn every booth conversation into pipeline.
        </h2>
        <p className="text-white/65 text-[1.9vw] mt-[4vh] max-w-[52vw] leading-snug text-pretty">
          Structured, scored, and follow-up ready — from the first scan to the
          signed deal.
        </p>
      </div>

      <div className="absolute left-[6vw] bottom-[6vh] flex items-center gap-[1vw]">
        <div className="w-[3vw] h-[1px] bg-primary" />
        <span className="text-white/50 text-[1.15vw] font-medium tracking-wide">
          Powered by Elite Marcom
        </span>
      </div>
    </div>
  );
}
