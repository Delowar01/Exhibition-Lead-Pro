const base = import.meta.env.BASE_URL;

export default function Cover() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-ink font-body">
      <img
        src={`${base}hero-scan.png`}
        crossOrigin="anonymous"
        alt="Abstract scan line digitizing a business card into data"
        className="absolute inset-0 w-full h-full object-cover opacity-70"
      />
      <div className="absolute inset-0 bg-gradient-to-r from-ink via-ink/85 to-ink/10" />

      <div className="absolute top-[7vh] left-[6vw] right-[6vw] flex items-center justify-between">
        <div className="flex items-center gap-[1.2vw]">
          <div className="w-[2.6vw] h-[2.6vw] rounded-[0.7vw] bg-primary" />
          <span className="text-white/90 text-[1.5vw] font-display font-medium tracking-tight">
            Card Scanner Pro
          </span>
        </div>
        <span className="text-white/55 text-[1.15vw] font-medium tracking-[0.25em] uppercase">
          Pitch
        </span>
      </div>

      <div className="absolute left-[6vw] bottom-[16vh] max-w-[68vw]">
        <p className="text-primary text-[1.5vw] font-semibold tracking-[0.3em] uppercase mb-[2.5vh]">
          Enterprise lead capture
        </p>
        <h1 className="text-white font-display font-bold text-[8vw] leading-[0.95] tracking-tighter text-balance">
          Turn cards into
          <span className="block text-primary">qualified pipeline.</span>
        </h1>
        <p className="text-white/70 text-[1.9vw] font-normal mt-[4vh] max-w-[46vw] leading-snug text-pretty">
          The lead-capture platform that scans business cards, scores every lead,
          and files it — structured and ready to work.
        </p>
      </div>

      <div className="absolute left-[6vw] bottom-[6vh] flex items-center gap-[1vw]">
        <div className="w-[3vw] h-[1px] bg-primary" />
        <span className="text-white/45 text-[1.15vw] font-medium tracking-wide">
          Powered by Elite Marcom
        </span>
      </div>
    </div>
  );
}
